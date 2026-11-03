-- Escrituras transaccionales de rutas, pedidos y asignaciones.
-- Requiere operaciones_rutas.sql, entregas.sql, viajes_ruta.sql,
-- metricas_operativas.sql, viajes.sql, rechazos_ruta.sql y edicion_orden_rutas.sql.
alter table public.rutas_planificadas
  add column if not exists estado_propuesta text not null default 'propuesta',
  add column if not exists orden_pedidos text[] not null default array[]::text[],
  add column if not exists version bigint not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'rutas_estado_propuesta_check'
      and conrelid = 'public.rutas_planificadas'::regclass
  ) then
    alter table public.rutas_planificadas
      add constraint rutas_estado_propuesta_check
      check (estado_propuesta in ('propuesta', 'rechazada', 'aceptada'));
  end if;

  if exists (
    select 1
    from public.rutas_planificadas
    group by fecha, nombre
    having count(*) > 1
  ) then
    raise exception 'Hay rutas duplicadas por fecha y nombre; resuélvelas antes de crear el índice único.';
  end if;
end
$$;

create unique index if not exists rutas_planificadas_fecha_nombre_uq
  on public.rutas_planificadas (fecha, nombre);

-- Solo las rutas generadas por la IA tienen una propuesta que revisar. Las demás (manuales o anteriores a
-- esta migración) quedaban como 'propuesta' y no se podían asignar nunca: se marcan aceptadas.
update public.rutas_planificadas
set estado_propuesta = 'aceptada'
where coalesce(metodo_creacion, '') <> 'ia' and estado_propuesta = 'propuesta';

create table if not exists public.asignaciones_guardias (
  id uuid primary key default gen_random_uuid(),
  asignacion_id uuid not null references public.asignaciones_ruta(id) on delete cascade,
  guardia_id text not null references public.empleados(codigo),
  fecha_operativa date not null
);

create unique index if not exists asignaciones_guardia_unica_por_dia
  on public.asignaciones_guardias (guardia_id, fecha_operativa);

alter table public.asignaciones_guardias enable row level security;

drop policy if exists asignaciones_guardias_coordinador_lee on public.asignaciones_guardias;
create policy asignaciones_guardias_coordinador_lee on public.asignaciones_guardias
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas');

grant select on public.asignaciones_guardias to authenticated;

create table if not exists public.rutas_ediciones_auditoria (
  id bigint generated always as identity primary key,
  ruta_id text not null references public.rutas_planificadas(id),
  usuario text not null,
  fecha timestamptz not null default now(),
  antes jsonb not null,
  despues jsonb not null
);

alter table public.rutas_ediciones_auditoria enable row level security;

drop policy if exists rutas_ediciones_auditoria_coordinador_lee on public.rutas_ediciones_auditoria;
create policy rutas_ediciones_auditoria_coordinador_lee on public.rutas_ediciones_auditoria
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas');

grant select on public.rutas_ediciones_auditoria to authenticated;

create or replace function public.guardar_ruta_operativa(
  p_nombre text,
  p_pedidos text[],
  p_usuario text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hoy date := timezone('America/El_Salvador', now())::date;
  v_id text := 'RT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  v_usuario text := coalesce(auth.jwt() ->> 'email', auth.uid()::text, 'Usuario');
  v_afectados integer;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'Solo el coordinador de rutas puede guardar rutas.' using errcode = '42501';
  end if;
  if nullif(btrim(p_nombre), '') is null
      or p_pedidos is null
      or cardinality(p_pedidos) = 0
      or cardinality(p_pedidos) > 50
      or cardinality(p_pedidos) <> (select count(distinct pedido) from unnest(p_pedidos) as x(pedido)) then
    raise exception 'El nombre o la lista de pedidos no es válida.' using errcode = '22023';
  end if;

  -- Una ruta armada a mano no tiene propuesta de la IA que revisar: nace aceptada para poder asignarla.
  insert into public.rutas_planificadas (
    id, nombre, fecha, entregas, creado_por, orden_pedidos, metodo_creacion, estado_propuesta
  ) values (
    v_id, btrim(p_nombre), v_hoy, cardinality(p_pedidos), v_usuario, p_pedidos, 'manual', 'aceptada'
  );

  update public.entregas
  set ruta_id = v_id, ruta = btrim(p_nombre)
  where id = any(p_pedidos)
    and ruta_id is null
    and coalesce(estado, 'pendiente') = 'pendiente'
    and (hora_programada at time zone 'America/El_Salvador')::date = v_hoy;
  get diagnostics v_afectados = row_count;

  if v_afectados <> cardinality(p_pedidos) then
    raise exception 'Hay pedidos que ya no están disponibles o no son de hoy.' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'id', v_id, 'nombre', btrim(p_nombre), 'fecha', v_hoy,
    'entregas', cardinality(p_pedidos), 'usuario', v_usuario
  );
end;
$$;

create or replace function public.guardar_viaje_operativo(
  p_nombre text,
  p_pedidos text[],
  p_origen text,
  p_origen_lat double precision,
  p_origen_lng double precision,
  p_destino text,
  p_destino_lat double precision,
  p_destino_lng double precision,
  p_hora_salida time,
  p_monto numeric,
  p_tipo_carga_id smallint,
  p_usuario text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hoy date := timezone('America/El_Salvador', now())::date;
  v_id text := 'RT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  v_usuario text := coalesce(auth.jwt() ->> 'email', auth.uid()::text, 'Usuario');
  v_sensibilidad smallint;
  v_nivel text;
  v_afectados integer;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'Solo el coordinador de rutas puede guardar viajes.' using errcode = '42501';
  end if;
  if nullif(btrim(p_nombre), '') is null
      or p_pedidos is null
      or cardinality(p_pedidos) > 50
      or cardinality(p_pedidos) <> (select count(distinct pedido) from unnest(p_pedidos) as x(pedido))
      or nullif(btrim(p_origen), '') is null
      or nullif(btrim(p_destino), '') is null
      or p_hora_salida is null
      or p_monto is null or p_monto <= 0
      or p_tipo_carga_id is null
      or p_origen_lat is null or p_origen_lat not between -90 and 90
      or p_origen_lng is null or p_origen_lng not between -180 and 180
      or p_destino_lat is null or p_destino_lat not between -90 and 90
      or p_destino_lng is null or p_destino_lng not between -180 and 180 then
    raise exception 'Los datos del viaje no son válidos.' using errcode = '22023';
  end if;

  select sensibilidad into v_sensibilidad
  from public.tipos_carga
  where id = p_tipo_carga_id and activo;
  if not found then
    raise exception 'El tipo de carga no está disponible.' using errcode = '22023';
  end if;

  v_nivel := public.nivel_riesgo_por_monto(p_monto, v_sensibilidad);

  insert into public.rutas_planificadas (
    id, nombre, fecha, entregas, creado_por, orden_pedidos, metodo_creacion,
    origen_texto, origen_lat, origen_lng, destino_texto, destino_lat, destino_lng,
    hora_salida, monto, tipo_carga_id, nivel_riesgo
  ) values (
    v_id, btrim(p_nombre), v_hoy, cardinality(p_pedidos), v_usuario, p_pedidos, 'ia',
    btrim(p_origen), p_origen_lat, p_origen_lng, btrim(p_destino), p_destino_lat, p_destino_lng,
    p_hora_salida, p_monto, p_tipo_carga_id, v_nivel
  );

  update public.entregas
  set ruta_id = v_id, ruta = btrim(p_nombre)
  where id = any(p_pedidos)
    and ruta_id is null
    and coalesce(nullif(btrim(ruta), ''), '') = ''
    and coalesce(estado, 'pendiente') = 'pendiente'
    and (hora_programada at time zone 'America/El_Salvador')::date = v_hoy;
  get diagnostics v_afectados = row_count;

  if v_afectados <> cardinality(p_pedidos) then
    raise exception 'Hay pedidos que ya no están disponibles o no son de hoy.' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'id', v_id, 'nombre', btrim(p_nombre), 'fecha', v_hoy,
    'entregas', cardinality(p_pedidos), 'nivel_riesgo', v_nivel, 'usuario', v_usuario
  );
end;
$$;

create or replace function public.actualizar_ruta_operativa(
  p_ruta text,
  p_nombre text,
  p_pedidos text[],
  p_usuario text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hoy date := timezone('America/El_Salvador', now())::date;
  v_ruta public.rutas_planificadas%rowtype;
  v_usuario text := coalesce(auth.jwt() ->> 'email', auth.uid()::text, 'Usuario');
  v_validos integer;
  v_afectados integer;
  v_completados text[];
  v_antes jsonb;
  v_despues jsonb;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'Solo el coordinador de rutas puede editar rutas.' using errcode = '42501';
  end if;
  if nullif(btrim(p_nombre), '') is null
      or p_pedidos is null
      or cardinality(p_pedidos) = 0
      or cardinality(p_pedidos) > 50
      or cardinality(p_pedidos) <> (select count(distinct pedido) from unnest(p_pedidos) as x(pedido)) then
    raise exception 'El nombre o la lista de pedidos no es válida.' using errcode = '22023';
  end if;

  select * into v_ruta
  from public.rutas_planificadas
  where id = p_ruta
  for update;
  if not found or v_ruta.fecha <> v_hoy then
    raise exception 'La ruta ya no existe o no es de hoy.' using errcode = 'P0001';
  end if;
  if coalesce(v_ruta.conductor, '') <> '' or exists (
    select 1 from public.asignaciones_ruta
    where ruta_id = p_ruta and fecha_operativa = v_hoy
  ) then
    raise exception 'La ruta ya salió; desasígnala antes de editar.' using errcode = 'P0001';
  end if;

  perform 1
  from public.entregas
  where id = any(p_pedidos) or ruta_id = p_ruta
  for update;

  select count(*) into v_validos
  from public.entregas e
  where e.id = any(p_pedidos)
    and (e.ruta_id is null or e.ruta_id = p_ruta)
    and coalesce(e.estado, 'pendiente') = 'pendiente'
    and (e.hora_programada at time zone 'America/El_Salvador')::date = v_hoy;
  if v_validos <> cardinality(p_pedidos) then
    raise exception 'Hay pedidos que ya no existen, no están pendientes o pertenecen a otra ruta.' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(id order by orden, hora_programada, id), array[]::text[])
  into v_completados
  from public.entregas
  where ruta_id = p_ruta and estado = 'completada';

  v_antes := jsonb_build_object(
    'pedidos', v_ruta.orden_pedidos,
    'nombre', v_ruta.nombre
  );

  update public.entregas
  set ruta_id = null, ruta = null
  where ruta_id = p_ruta and coalesce(estado, 'pendiente') = 'pendiente';

  update public.entregas
  set ruta_id = p_ruta, ruta = btrim(p_nombre)
  where id = any(p_pedidos) and ruta_id is null
    and coalesce(estado, 'pendiente') = 'pendiente'
    and (hora_programada at time zone 'America/El_Salvador')::date = v_hoy;
  get diagnostics v_afectados = row_count;

  if v_afectados <> cardinality(p_pedidos) then
    raise exception 'Algunos pedidos se asignaron a otra ruta al mismo tiempo.' using errcode = 'P0001';
  end if;

  update public.rutas_planificadas
  set nombre = btrim(p_nombre),
      orden_pedidos = p_pedidos || coalesce(v_completados, array[]::text[]),
      entregas = cardinality(p_pedidos) + coalesce(cardinality(v_completados), 0),
      estado_propuesta = 'propuesta',
      version = coalesce(version, 1) + 1
  where id = p_ruta
  returning * into v_ruta;

  v_despues := jsonb_build_object('pedidos', v_ruta.orden_pedidos, 'nombre', v_ruta.nombre);
  insert into public.rutas_ediciones_auditoria (ruta_id, usuario, antes, despues)
  values (p_ruta, v_usuario, v_antes, v_despues);

  return jsonb_build_object(
    'id', v_ruta.id, 'nombre', v_ruta.nombre, 'fecha', v_ruta.fecha,
    'entregas', v_ruta.entregas, 'version', v_ruta.version, 'usuario', v_usuario
  );
end;
$$;

create or replace function public.aceptar_propuesta_ruta_operativa(p_ruta text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hoy date := timezone('America/El_Salvador', now())::date;
  v_ruta public.rutas_planificadas%rowtype;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'Solo el coordinador de rutas puede aceptar propuestas.' using errcode = '42501';
  end if;

  select * into v_ruta
  from public.rutas_planificadas
  where id = p_ruta
  for update;
  if not found or v_ruta.fecha <> v_hoy then
    raise exception 'La ruta ya no existe o no es de hoy.' using errcode = 'P0001';
  end if;
  if v_ruta.estado_propuesta = 'rechazada' then
    raise exception 'La propuesta está rechazada y no se puede aceptar.' using errcode = 'P0001';
  end if;
  if v_ruta.estado_propuesta = 'aceptada' then
    return jsonb_build_object('id', p_ruta, 'estado_propuesta', 'aceptada');
  end if;
  if exists (
    select 1 from public.asignaciones_ruta
    where ruta_id = p_ruta and fecha_operativa = v_hoy
  ) then
    raise exception 'La ruta ya tiene una asignación vigente.' using errcode = 'P0001';
  end if;
  if v_ruta.origen_lat is null or v_ruta.destino_lat is null then
    raise exception 'La ruta no tiene una propuesta de viaje válida para aceptar.' using errcode = '22023';
  end if;

  update public.rutas_planificadas
  set estado_propuesta = 'aceptada'
  where id = p_ruta;

  return jsonb_build_object('id', p_ruta, 'estado_propuesta', 'aceptada');
end;
$$;

drop function if exists public.asignar_ruta_operativa(text, text, text, text);

create or replace function public.asignar_ruta_operativa(
  p_conductor text,
  p_vehiculo text,
  p_ruta text,
  p_usuario text,
  p_guardias text[] default array[]::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hoy date := timezone('America/El_Salvador', now())::date;
  v_guardias text[] := coalesce(p_guardias, array[]::text[]);
  v_guardia text;
  v_empleado record;
  v_guardia_empleado record;
  v_vehiculo record;
  v_ruta public.rutas_planificadas%rowtype;
  v_asignacion public.asignaciones_ruta%rowtype;
  v_viaje_id text;
  v_usuario text := coalesce(auth.jwt() ->> 'email', auth.uid()::text, 'Usuario');
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'No tiene permiso para asignar rutas.' using errcode = '42501';
  end if;

  if cardinality(v_guardias) > 10
      or cardinality(v_guardias) <> (select count(distinct item) from unnest(v_guardias) as g(item)) then
    raise exception 'La lista de guardias no es válida.' using errcode = '22023';
  end if;

  select codigo, nombre, activo, licencia, categoria into v_empleado
  from public.empleados where codigo = p_conductor;
  if not found or not v_empleado.activo or v_empleado.categoria <> 'conductor'
      or v_empleado.licencia is null or v_empleado.licencia < v_hoy then
    raise exception 'El conductor no está disponible o su licencia está vencida.' using errcode = 'P0001';
  end if;

  foreach v_guardia in array v_guardias loop
    select codigo, activo, categoria into v_guardia_empleado
    from public.empleados where codigo = v_guardia;
    if not found or not v_guardia_empleado.activo or v_guardia_empleado.categoria <> 'guardia' then
      raise exception 'El guardia % no está disponible.', v_guardia using errcode = 'P0001';
    end if;
  end loop;

  select id, placa, tipo, activo, seguro, revision into v_vehiculo
  from public.vehiculos where id = p_vehiculo;
  if not found or not v_vehiculo.activo or v_vehiculo.seguro is null or v_vehiculo.seguro < v_hoy
      or v_vehiculo.revision is null or v_vehiculo.revision < v_hoy then
    raise exception 'El vehículo no está disponible o sus documentos están vencidos.' using errcode = 'P0001';
  end if;

  select * into v_ruta
  from public.rutas_planificadas
  where id = p_ruta
  for update;
  -- La asignación vigente es la que manda: un conductor guardado sin asignación (estado fantasma) no bloquea.
  if not found or v_ruta.fecha <> v_hoy or exists (
    select 1 from public.asignaciones_ruta where ruta_id = p_ruta and fecha_operativa = v_hoy
  ) then
    raise exception 'La ruta ya no está disponible para hoy.' using errcode = 'P0001';
  end if;
  if v_ruta.estado_propuesta = 'rechazada' then
    raise exception 'La propuesta fue rechazada: genera una alternativa o acéptala antes de asignarla.' using errcode = 'P0001';
  end if;
  if v_ruta.metodo_creacion = 'ia' and v_ruta.estado_propuesta is distinct from 'aceptada' then
    raise exception 'La propuesta de ruta debe aceptarse antes de asignarla.' using errcode = 'P0001';
  end if;

  insert into public.asignaciones_ruta (ruta_id, conductor_id, vehiculo_id, fecha_operativa, usuario)
  values (p_ruta, p_conductor, p_vehiculo, v_hoy, v_usuario)
  returning * into v_asignacion;

  insert into public.asignaciones_guardias (asignacion_id, guardia_id, fecha_operativa)
  select v_asignacion.id, item, v_hoy from unnest(v_guardias) as g(item);

  insert into public.viajes (ruta_id, conductor_id, vehiculo_id, estado)
  values (p_ruta, p_conductor, p_vehiculo, 'asignado')
  returning id into v_viaje_id;

  with ordenados as (
    select e.id,
      coalesce(
        array_position(v_ruta.orden_pedidos, e.id),
        row_number() over (order by e.hora_programada, e.id)::integer
      ) as posicion
    from public.entregas e
    where e.ruta_id = p_ruta
  )
  update public.entregas e
  set viaje_id = v_viaje_id, orden = o.posicion, nivel_riesgo = v_ruta.nivel_riesgo
  from ordenados o
  where e.id = o.id;

  update public.rutas_planificadas
  set conductor = v_empleado.nombre
  where id = p_ruta;

  return jsonb_build_object(
    'ruta', v_asignacion.ruta_id,
    'conductor', v_asignacion.conductor_id,
    'vehiculo', v_asignacion.vehiculo_id,
    'guardias', to_jsonb(v_guardias),
    'fecha', v_asignacion.fecha_asignacion,
    'usuario', v_asignacion.usuario,
    'viaje_id', v_viaje_id
  );
end;
$$;

create or replace function public.desasignar_ruta_operativa(
  p_ruta text,
  p_usuario text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hoy date := timezone('America/El_Salvador', now())::date;
  v_asignacion public.asignaciones_ruta%rowtype;
  v_conductor text;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'No tiene permiso para desasignar rutas.' using errcode = '42501';
  end if;

  select conductor into v_conductor
  from public.rutas_planificadas
  where id = p_ruta and fecha = v_hoy
  for update;
  if not found then
    raise exception 'La ruta no es de hoy.' using errcode = 'P0001';
  end if;

  select * into v_asignacion
  from public.asignaciones_ruta
  where ruta_id = p_ruta and fecha_operativa = v_hoy
  for update;
  if not found then
    -- Estado fantasma: conserva el conductor sin asignación vigente. Se libera para poder asignarla.
    if coalesce(btrim(v_conductor), '') <> '' then
      update public.rutas_planificadas set conductor = null where id = p_ruta;
      return jsonb_build_object('ruta', p_ruta, 'desasignada', true, 'reparada', true);
    end if;
    raise exception 'La ruta no tiene una asignación para hoy.' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.viajes
    where ruta_id = p_ruta and estado in ('en_curso', 'en_transito')
  ) then
    raise exception 'No se puede desasignar un viaje que ya comenzó.' using errcode = 'P0001';
  end if;

  update public.entregas
  set viaje_id = null, orden = null
  where viaje_id in (
    select id from public.viajes where ruta_id = p_ruta and estado = 'asignado'
  );
  update public.viajes set estado = 'cancelado'
  where ruta_id = p_ruta and estado = 'asignado';

  delete from public.asignaciones_guardias where asignacion_id = v_asignacion.id;
  delete from public.asignaciones_ruta where id = v_asignacion.id;
  update public.rutas_planificadas set conductor = null where id = p_ruta;

  return jsonb_build_object('ruta', p_ruta, 'desasignada', true);
end;
$$;

-- Disponibilidad del día (reemplaza la de operaciones_rutas.sql):
--   drivers: empleados activos de categoría conductor (o sin categoría, como antes); ya no aparecen guardias
--            ni administradores como conductores.
--   guards:  empleados activos de categoría guardia (antes la función no los devolvía y la lista salía vacía).
--   routes:  rutas de hoy sin asignación vigente que ya se pueden asignar.
--   pending: rutas de la IA cuya propuesta aún no se acepta (se aceptan en Tracking → Revisar propuesta).
create or replace function public.listar_disponibilidad_operativa()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hoy date := timezone('America/El_Salvador', now())::date;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'No tiene permiso para consultar la disponibilidad.' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'drivers', coalesce((
      select jsonb_agg(jsonb_build_object('id', codigo, 'nombre', nombre, 'licencia', licencia) order by nombre)
      from public.empleados
      where activo = true and coalesce(categoria, 'conductor') = 'conductor'
    ), '[]'::jsonb),
    'guards', coalesce((
      select jsonb_agg(jsonb_build_object('id', codigo, 'nombre', nombre) order by nombre)
      from public.empleados
      where activo = true and categoria = 'guardia'
    ), '[]'::jsonb),
    'vehicles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'placa', placa, 'tipo', tipo, 'seguro', seguro, 'revision', revision
      ) order by placa)
      from public.vehiculos
      where activo = true
    ), '[]'::jsonb),
    'routes', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'nombre', r.nombre) order by r.nombre)
      from public.rutas_planificadas r
      where r.fecha = v_hoy
        and not exists (select 1 from public.asignaciones_ruta a where a.ruta_id = r.id and a.fecha_operativa = v_hoy)
        and r.estado_propuesta is distinct from 'rechazada'
        and not (r.metodo_creacion = 'ia' and r.estado_propuesta is distinct from 'aceptada')
    ), '[]'::jsonb),
    'pending', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'nombre', r.nombre) order by r.nombre)
      from public.rutas_planificadas r
      where r.fecha = v_hoy and r.metodo_creacion = 'ia' and r.estado_propuesta = 'propuesta'
        and not exists (select 1 from public.asignaciones_ruta a where a.ruta_id = r.id and a.fecha_operativa = v_hoy)
    ), '[]'::jsonb),
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ruta', a.ruta_id,
        'conductor', a.conductor_id,
        'vehiculo', a.vehiculo_id,
        'guardias', coalesce((
          select jsonb_agg(g.guardia_id) from public.asignaciones_guardias g where g.asignacion_id = a.id
        ), '[]'::jsonb),
        'fecha', a.fecha_asignacion,
        'usuario', a.usuario
      ) order by a.fecha_asignacion)
      from public.asignaciones_ruta a
      where a.fecha_operativa = v_hoy
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.listar_disponibilidad_operativa() from public, anon;
grant execute on function public.listar_disponibilidad_operativa() to authenticated;

revoke all on function public.guardar_ruta_operativa(text, text[], text) from public, anon;
grant execute on function public.guardar_ruta_operativa(text, text[], text) to authenticated;

revoke all on function public.guardar_viaje_operativo(text, text[], text, double precision, double precision, text, double precision, double precision, time, numeric, smallint, text) from public, anon;
grant execute on function public.guardar_viaje_operativo(text, text[], text, double precision, double precision, text, double precision, double precision, time, numeric, smallint, text) to authenticated;

revoke all on function public.actualizar_ruta_operativa(text, text, text[], text) from public, anon;
grant execute on function public.actualizar_ruta_operativa(text, text, text[], text) to authenticated;

revoke all on function public.aceptar_propuesta_ruta_operativa(text) from public, anon;
grant execute on function public.aceptar_propuesta_ruta_operativa(text) to authenticated;

revoke all on function public.asignar_ruta_operativa(text, text, text, text, text[]) from public, anon;
grant execute on function public.asignar_ruta_operativa(text, text, text, text, text[]) to authenticated;

revoke all on function public.desasignar_ruta_operativa(text, text) from public, anon;
grant execute on function public.desasignar_ruta_operativa(text, text) to authenticated;

notify pgrst, 'reload schema';
