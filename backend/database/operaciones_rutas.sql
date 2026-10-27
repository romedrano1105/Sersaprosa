-- Datos operativos para la sección de asignación y disponibilidad.
alter table public.empleados
  add column if not exists licencia date;

create table if not exists public.rutas_planificadas (
  id text primary key,
  nombre text not null,
  zona text not null default '',
  fecha date not null default timezone('America/El_Salvador', now())::date,
  entregas integer not null default 0,
  conductor text
);

alter table public.rutas_planificadas
  add column if not exists zona text not null default '',
  add column if not exists fecha date not null default timezone('America/El_Salvador', now())::date,
  add column if not exists entregas integer not null default 0,
  add column if not exists conductor text;

alter table public.rutas_planificadas
  alter column fecha set default timezone('America/El_Salvador', now())::date;

create table if not exists public.vehiculos (
  id text primary key default gen_random_uuid()::text,
  placa text not null unique,
  tipo text not null,
  seguro date,
  revision date,
  activo boolean not null default true
);

create table if not exists public.asignaciones_ruta (
  id uuid primary key default gen_random_uuid(),
  ruta_id text not null references public.rutas_planificadas(id),
  conductor_id text not null,
  vehiculo_id text not null references public.vehiculos(id),
  fecha_operativa date not null,
  fecha_asignacion timestamptz not null default now(),
  usuario text not null
);

create unique index if not exists asignaciones_ruta_unica_por_dia
  on public.asignaciones_ruta (ruta_id, fecha_operativa);

create unique index if not exists asignaciones_conductor_unica_por_dia
  on public.asignaciones_ruta (conductor_id, fecha_operativa);

create unique index if not exists asignaciones_vehiculo_unica_por_dia
  on public.asignaciones_ruta (vehiculo_id, fecha_operativa);

alter table public.empleados enable row level security;
alter table public.vehiculos enable row level security;
alter table public.rutas_planificadas enable row level security;
alter table public.asignaciones_ruta enable row level security;

drop policy if exists vehiculos_coordinador_disponibilidad on public.vehiculos;
create policy vehiculos_coordinador_disponibilidad on public.vehiculos
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas');

drop policy if exists rutas_coordinador_disponibilidad on public.rutas_planificadas;
create policy rutas_coordinador_disponibilidad on public.rutas_planificadas
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas');

drop policy if exists asignaciones_coordinador_disponibilidad on public.asignaciones_ruta;
create policy asignaciones_coordinador_disponibilidad on public.asignaciones_ruta
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas');

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
      select jsonb_agg(jsonb_build_object(
        'id', codigo,
        'nombre', nombre,
        'licencia', licencia
      ) order by nombre)
      from public.empleados
      where activo = true
    ), '[]'::jsonb),
    'vehicles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'placa', placa,
        'tipo', tipo,
        'seguro', seguro,
        'revision', revision
      ) order by placa)
      from public.vehiculos
      where activo = true
    ), '[]'::jsonb),
    'routes', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'nombre', nombre) order by nombre)
      from public.rutas_planificadas
      where fecha = v_hoy and coalesce(conductor, '') = ''
    ), '[]'::jsonb),
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ruta', ruta_id,
        'conductor', conductor_id,
        'vehiculo', vehiculo_id,
        'fecha', fecha_asignacion,
        'usuario', usuario
      ) order by fecha_asignacion)
      from public.asignaciones_ruta
      where fecha_operativa = v_hoy
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.asignar_ruta_operativa(
  p_conductor text,
  p_vehiculo text,
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
  v_empleado record;
  v_vehiculo record;
  v_ruta record;
  v_asignacion public.asignaciones_ruta%rowtype;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'No tiene permiso para asignar rutas.' using errcode = '42501';
  end if;

  select codigo, nombre, activo, licencia into v_empleado
  from public.empleados where codigo = p_conductor;
  if not found or not v_empleado.activo or v_empleado.licencia is null or v_empleado.licencia < v_hoy then
    raise exception 'El conductor no está disponible o su licencia está vencida.' using errcode = 'P0001';
  end if;

  select id, placa, tipo, activo, seguro, revision into v_vehiculo
  from public.vehiculos where id = p_vehiculo;
  if not found or not v_vehiculo.activo or v_vehiculo.seguro is null or v_vehiculo.seguro < v_hoy
      or v_vehiculo.revision is null or v_vehiculo.revision < v_hoy then
    raise exception 'El vehículo no está disponible o sus documentos están vencidos.' using errcode = 'P0001';
  end if;

  select id, nombre, fecha, conductor into v_ruta
  from public.rutas_planificadas where id = p_ruta;
  if not found or v_ruta.fecha <> v_hoy or coalesce(v_ruta.conductor, '') <> '' then
    raise exception 'La ruta ya no está disponible para hoy.' using errcode = 'P0001';
  end if;

  insert into public.asignaciones_ruta (ruta_id, conductor_id, vehiculo_id, fecha_operativa, usuario)
  values (p_ruta, p_conductor, p_vehiculo, v_hoy, p_usuario)
  returning * into v_asignacion;

  update public.rutas_planificadas
  set conductor = v_empleado.nombre
  where id = p_ruta;

  return jsonb_build_object(
    'ruta', v_asignacion.ruta_id,
    'conductor', v_asignacion.conductor_id,
    'vehiculo', v_asignacion.vehiculo_id,
    'fecha', v_asignacion.fecha_asignacion,
    'usuario', v_asignacion.usuario
  );
end;
$$;

revoke all on function public.listar_disponibilidad_operativa() from public, anon;
grant execute on function public.listar_disponibilidad_operativa() to authenticated;

revoke all on function public.asignar_ruta_operativa(text, text, text, text) from public, anon;
grant execute on function public.asignar_ruta_operativa(text, text, text, text) to authenticated;
