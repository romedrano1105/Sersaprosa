-- Edición manual del orden de pedidos en Tracking de rutas.
alter table public.rutas_planificadas
  add column if not exists orden_pedidos text[] not null default array[]::text[],
  add column if not exists version bigint not null default 1,
  add column if not exists distancia_km numeric(12, 3),
  add column if not exists duracion_min numeric(12, 2),
  add column if not exists riesgo_ruta text;

create or replace function public.incrementar_version_ruta()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.version = old.version
      and (to_jsonb(new) - 'version') is distinct from (to_jsonb(old) - 'version') then
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists rutas_planificadas_version on public.rutas_planificadas;
create trigger rutas_planificadas_version
before update on public.rutas_planificadas
for each row execute function public.incrementar_version_ruta();

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

create or replace function public.editar_orden_ruta_operativa(
  p_ruta text,
  p_pedidos text[],
  p_version bigint,
  p_distancia_km numeric,
  p_duracion_min numeric,
  p_riesgo_ruta text,
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
  v_actual text[];
  v_completados text[];
  v_orden_final text[];
  v_antes jsonb;
  v_despues jsonb;
  v_invalidos text[];
  v_encontrados integer;
  v_usuario text;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'Solo el coordinador de rutas puede editar el orden.' using errcode = '42501';
  end if;
  if coalesce(array_length(p_pedidos, 1), 0) = 0 or cardinality(p_pedidos) > 50
      or cardinality(p_pedidos) <> (
    select count(distinct pedidos.pedido) from unnest(p_pedidos) as pedidos(pedido)
  ) then
    raise exception 'La ruta debe contener pedidos válidos sin repetir.' using errcode = '22023';
  end if;
  if p_distancia_km is null or p_distancia_km < 0 or p_distancia_km > 10000
      or p_duracion_min is null or p_duracion_min < 0 or p_duracion_min > 100000
      or p_riesgo_ruta not in ('bajo', 'medio', 'alto') then
    raise exception 'Los datos calculados de la ruta no son válidos.' using errcode = '22023';
  end if;
  v_usuario := coalesce(
    auth.jwt() ->> 'email',
    auth.uid()::text,
    'Usuario'
  );

  select * into v_ruta from public.rutas_planificadas
  where id = p_ruta for update;
  if not found or v_ruta.fecha <> v_hoy then
    raise exception 'La ruta cambió, vuelve a abrirla.' using errcode = 'P0001';
  end if;
  if coalesce(v_ruta.conductor, '') <> '' or exists (
    select 1 from public.asignaciones_ruta
    where ruta_id = p_ruta and fecha_operativa = v_hoy
  ) then
    raise exception 'La ruta ya salió (tiene conductor asignado). Desasígnala antes de editar.' using errcode = 'P0001';
  end if;
  if v_ruta.version <> p_version then
    raise exception 'La ruta cambió, vuelve a abrirla.' using errcode = 'P0001';
  end if;

  perform 1 from public.entregas e
  where e.id = any(p_pedidos) or (
    e.ruta = v_ruta.nombre and (e.hora_programada at time zone 'America/El_Salvador')::date = v_hoy
  ) for update;

  select count(*) into v_encontrados
  from public.entregas e where e.id = any(p_pedidos);
  if v_encontrados <> cardinality(p_pedidos) then
    raise exception 'Uno o más pedidos ya no existen. Vuelve a abrir la ruta.' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(e.id order by array_position(v_ruta.orden_pedidos, e.id), e.hora_programada, e.id), array[]::text[])
  into v_actual
  from public.entregas e
  where e.ruta = v_ruta.nombre
    and (e.hora_programada at time zone 'America/El_Salvador')::date = v_hoy
    and coalesce(e.estado, 'pendiente') <> 'completada';

  if v_actual = p_pedidos then
    raise exception 'No hay cambios que guardar.' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(e.id order by array_position(v_ruta.orden_pedidos, e.id), e.hora_programada, e.id), array[]::text[])
  into v_completados
  from public.entregas e
  where e.ruta = v_ruta.nombre
    and (e.hora_programada at time zone 'America/El_Salvador')::date = v_hoy
    and coalesce(e.estado, 'pendiente') = 'completada';

  select array_agg(e.id) into v_invalidos
  from public.entregas e
  where e.id = any(p_pedidos)
    and (e.hora_programada at time zone 'America/El_Salvador')::date is distinct from v_hoy;
  if v_invalidos is not null then
    raise exception 'Solo se pueden editar pedidos programados para hoy: %.',
      array_to_string(v_invalidos[1:3], ', ') using errcode = 'P0001';
  end if;

  select array_agg(e.id) into v_invalidos
  from public.entregas e
  where e.id = any(p_pedidos)
    and not (
      (
        e.ruta = v_ruta.nombre
        and coalesce(e.estado, 'pendiente') <> 'completada'
      )
      or (
        coalesce(e.ruta, '') = ''
        and coalesce(e.estado, 'pendiente') = 'pendiente'
      )
    );
  if v_invalidos is not null then
    raise exception 'Hay pedidos que ya no están pendientes o pertenecen a otra ruta: %.',
      array_to_string(v_invalidos[1:3], ', ') using errcode = 'P0001';
  end if;

  select array_agg(e.id) into v_invalidos
  from public.entregas e
  where e.id = any(p_pedidos)
    and (e.lat is null or e.lng is null or e.lat not between -90 and 90 or e.lng not between -180 and 180);
  if v_invalidos is not null then
    raise exception 'Pedido sin ubicación: %.', array_to_string(v_invalidos[1:3], ', ') using errcode = 'P0001';
  end if;

  v_orden_final := p_pedidos || v_completados;

  v_antes := jsonb_build_object(
    'pedidos', v_actual || v_completados, 'distancia_km', v_ruta.distancia_km,
    'duracion_min', v_ruta.duracion_min, 'riesgo_ruta', v_ruta.riesgo_ruta
  );
  update public.entregas
  set ruta = null
  where ruta = v_ruta.nombre
    and (hora_programada at time zone 'America/El_Salvador')::date = v_hoy
    and coalesce(estado, 'pendiente') <> 'completada'
    and not (id = any(p_pedidos));
  update public.entregas
  set ruta = v_ruta.nombre
  where id = any(p_pedidos);

  update public.rutas_planificadas
  set orden_pedidos = v_orden_final,
      entregas = cardinality(v_orden_final),
      distancia_km = p_distancia_km,
      duracion_min = p_duracion_min,
      riesgo_ruta = p_riesgo_ruta,
      version = version + 1
  where id = p_ruta
  returning * into v_ruta;

  v_despues := jsonb_build_object(
    'pedidos', v_orden_final, 'distancia_km', v_ruta.distancia_km,
    'duracion_min', v_ruta.duracion_min, 'riesgo_ruta', v_ruta.riesgo_ruta
  );
  insert into public.rutas_ediciones_auditoria (ruta_id, usuario, antes, despues)
  values (p_ruta, v_usuario, v_antes, v_despues);

  return jsonb_build_object(
    'id', v_ruta.id, 'nombre', v_ruta.nombre, 'orden_pedidos', v_ruta.orden_pedidos,
    'version', v_ruta.version, 'distancia_km', v_ruta.distancia_km,
    'duracion_min', v_ruta.duracion_min, 'riesgo_ruta', v_ruta.riesgo_ruta
  );
end;
$$;

revoke all on function public.editar_orden_ruta_operativa(text, text[], bigint, numeric, numeric, text, text) from public, anon;
grant execute on function public.editar_orden_ruta_operativa(text, text[], bigint, numeric, numeric, text, text) to authenticated;
