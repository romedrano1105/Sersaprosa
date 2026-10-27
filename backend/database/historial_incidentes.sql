-- Historial de incidentes para análisis posterior (FCJ1-22).
-- Ejecutar DESPUÉS de incidentes_viaje.sql. Solo AGREGA columnas, índices y una función:
-- no borra ni cambia ningún dato. Se puede ejecutar más de una vez sin problema.

-- 1) Tipos de incidente: se suman «choque» y «emergencia» a los 5 que ya existían.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.incidentes_viaje'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%boton_panico%'
  loop
    execute format('alter table public.incidentes_viaje drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.incidentes_viaje add constraint incidentes_viaje_tipo_check
  check (tipo in ('robo', 'accidente', 'desvio_ruta', 'falla_mecanica', 'boton_panico', 'choque', 'emergencia'));

-- 2) Datos del registro: cuándo y quién lo registró, y una clave para no duplicarlo.
alter table public.incidentes_viaje add column if not exists clave text;
alter table public.incidentes_viaje add column if not exists registrado_en timestamptz not null default now();
alter table public.incidentes_viaje add column if not exists registrado_por uuid;

-- Un mismo incidente (misma clave) queda una sola vez. Las filas anteriores no tienen clave y no se tocan.
create unique index if not exists incidentes_viaje_clave_unica
  on public.incidentes_viaje (clave) where clave is not null;

-- 3) Índices para filtrar el historial por fecha, tipo, severidad, estado y ruta.
create index if not exists ix_incidentes_viaje_fecha on public.incidentes_viaje (fecha desc);
create index if not exists ix_incidentes_viaje_tipo on public.incidentes_viaje (tipo);
create index if not exists ix_incidentes_viaje_severidad on public.incidentes_viaje (severidad);
create index if not exists ix_incidentes_viaje_ruta_fecha on public.incidentes_viaje (ruta_id, fecha desc);

-- 4) La auditoría ahora distingue «registrada» de «atendida». Las filas que ya había son «atendida».
alter table public.incidentes_viaje_auditoria add column if not exists accion text not null default 'atendida';
alter table public.incidentes_viaje_auditoria drop constraint if exists incidentes_viaje_auditoria_accion_check;
alter table public.incidentes_viaje_auditoria add constraint incidentes_viaje_auditoria_accion_check
  check (accion in ('registrada', 'atendida'));

-- 5) Registrar un incidente. Valida los datos, evita duplicados (misma clave = mismo incidente) y deja la
-- auditoría, todo en una sola transacción. Revalida el rol en PostgreSQL (ADR 0002).
create or replace function public.registrar_incidente_viaje(
  p_ruta_id text,
  p_tipo text,
  p_severidad text,
  p_origen text,
  p_descripcion text,
  p_lat double precision,
  p_lng double precision,
  p_fecha timestamptz,
  p_clave text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_nombre text;
  v_ahora timestamptz := now();
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'Esta sección es solo para el administrador de rutas.' using errcode = '42501';
  end if;
  if p_tipo is null or p_tipo not in ('robo', 'accidente', 'desvio_ruta', 'falla_mecanica', 'boton_panico', 'choque', 'emergencia') then
    raise exception 'El tipo de incidente no es válido.' using errcode = '22023';
  end if;
  if p_severidad is null or p_severidad not in ('alta', 'media', 'baja') then
    raise exception 'La severidad no es válida.' using errcode = '22023';
  end if;
  if p_origen is null or p_origen not in ('conductor', 'sistema') then
    raise exception 'El origen no es válido.' using errcode = '22023';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'La ubicación no es válida.' using errcode = '22023';
  end if;
  if p_clave is null or length(btrim(p_clave)) = 0 then
    raise exception 'Falta la clave del incidente.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.rutas_planificadas where id = p_ruta_id) then
    return jsonb_build_object('ok', false, 'reason', 'ruta_no_existe');
  end if;

  v_nombre := coalesce(auth.jwt() -> 'user_metadata' ->> 'name', auth.jwt() ->> 'email', 'Usuario');

  insert into public.incidentes_viaje
    (ruta_id, fecha, tipo, severidad, origen, descripcion, lat, lng, clave, registrado_en, registrado_por)
  values
    (p_ruta_id, coalesce(p_fecha, v_ahora), p_tipo, p_severidad, p_origen, nullif(btrim(p_descripcion), ''),
     p_lat, p_lng, btrim(p_clave), v_ahora, auth.uid())
  on conflict (clave) where clave is not null do nothing
  returning id into v_id;

  if v_id is null then
    -- Ya estaba registrado: se devuelve el mismo, sin crear otro.
    select id into v_id from public.incidentes_viaje where clave = btrim(p_clave);
    return jsonb_build_object('ok', true, 'creado', false, 'id', v_id);
  end if;

  insert into public.incidentes_viaje_auditoria (incidente_id, usuario, usuario_nombre, fecha, comentario, accion)
  values (v_id, auth.uid(), v_nombre, v_ahora, 'Incidente registrado', 'registrada');

  return jsonb_build_object('ok', true, 'creado', true, 'id', v_id);
end;
$$;

revoke all on function public.registrar_incidente_viaje(text, text, text, text, text, double precision, double precision, timestamptz, text) from public, anon;
grant execute on function public.registrar_incidente_viaje(text, text, text, text, text, double precision, double precision, timestamptz, text) to authenticated;

-- Los incidentes no se editan ni se borran desde la página: el rol authenticated solo puede leer
-- y marcar «vista» (ver incidentes_viaje.sql). Atender y registrar pasan por funciones que dejan auditoría.
