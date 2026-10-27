-- Notificaciones del administrador de rutas (FCJ1-16).
-- Ejecutar después de operaciones_rutas.sql y alertas_seguridad.sql.

-- Choques y emergencias. Esta historia NO crea su captura: otro proceso (o el
-- servicio con service_role) inserta aquí y el apartado de notificaciones los avisa.
create table if not exists public.incidentes_ruta (
  id text primary key default gen_random_uuid()::text,
  tipo text not null check (tipo in ('choque', 'emergencia')),
  titulo text not null,
  zona text not null default '',
  ruta text,                          -- nombre de la ruta, si ya se conoce
  fecha timestamptz not null default now(),
  urgencia text check (urgencia in ('alta', 'media', 'baja'))  -- null = sin clasificar
);

create table if not exists public.notificaciones (
  id uuid primary key default gen_random_uuid(),
  origen text not null check (origen in ('evento', 'alerta', 'choque', 'emergencia')),
  origen_id text not null,
  ruta_id text not null,
  ruta text not null,
  titulo text not null,
  zona text not null default '',
  fecha timestamptz,
  urgencia text check (urgencia in ('alta', 'media', 'baja')),  -- null = sin clasificar (gris)
  leida boolean not null default false,
  leida_por uuid,
  leida_nombre text,
  leida_en timestamptz,
  creada_en timestamptz not null default now(),
  check ((leida = false and leida_por is null and leida_en is null)
         or (leida = true and leida_por is not null and leida_en is not null))
);

-- Un mismo hecho en una misma ruta genera una sola notificación.
create unique index if not exists notificaciones_unica_por_hecho_y_ruta
  on public.notificaciones (origen, origen_id, ruta_id);
create index if not exists ix_notificaciones_creada on public.notificaciones (creada_en desc);

create table if not exists public.notificaciones_auditoria (
  id bigint generated always as identity primary key,
  notificacion_id uuid not null references public.notificaciones(id) on delete cascade,
  accion text not null check (accion in ('generada', 'leida')),
  usuario text not null,
  fecha timestamptz not null default now()
);
create index if not exists ix_notificaciones_auditoria_fecha
  on public.notificaciones_auditoria (fecha desc);

alter table public.incidentes_ruta enable row level security;
alter table public.notificaciones enable row level security;
alter table public.notificaciones_auditoria enable row level security;

-- Solo el coordinador/administrador de rutas lee y escribe (igual que alertas y eventos).
drop policy if exists incidentes_coordinador_lee on public.incidentes_ruta;
create policy incidentes_coordinador_lee on public.incidentes_ruta
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas');

drop policy if exists notificaciones_coordinador_lee on public.notificaciones;
create policy notificaciones_coordinador_lee on public.notificaciones
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas');

drop policy if exists notificaciones_coordinador_crea on public.notificaciones;
create policy notificaciones_coordinador_crea on public.notificaciones
  for insert to authenticated
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas');

drop policy if exists notificaciones_coordinador_marca on public.notificaciones;
create policy notificaciones_coordinador_marca on public.notificaciones
  for update to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas');

drop policy if exists notif_auditoria_coordinador_lee on public.notificaciones_auditoria;
create policy notif_auditoria_coordinador_lee on public.notificaciones_auditoria
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas');

drop policy if exists notif_auditoria_coordinador_crea on public.notificaciones_auditoria;
create policy notif_auditoria_coordinador_crea on public.notificaciones_auditoria
  for insert to authenticated
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas');

-- Lo único que se puede cambiar después de crear una notificación es marcarla como leída.
revoke update on public.notificaciones from authenticated;
grant select, insert on public.notificaciones to authenticated;
grant update (leida, leida_por, leida_nombre, leida_en) on public.notificaciones to authenticated;
grant select on public.incidentes_ruta to authenticated;
grant select, insert on public.notificaciones_auditoria to authenticated;
