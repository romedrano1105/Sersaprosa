-- Alertas de incidentes de viajes en curso para el administrador de rutas (FCJ1-10 / FCJ1-30).
-- Ejecutar DESPUÉS de operaciones_rutas.sql (usa rutas_planificadas).
--
-- Quién inserta los incidentes: el conductor o el sistema (con la clave service_role o un proceso
-- aparte). Esta historia solo los MUESTRA y permite atenderlos. Ver ejemplo de INSERT al final.

create table if not exists public.incidentes_viaje (
  id uuid primary key default gen_random_uuid(),
  ruta_id text not null references public.rutas_planificadas(id),
  fecha timestamptz not null default now(),
  tipo text not null check (tipo in ('robo', 'accidente', 'desvio_ruta', 'falla_mecanica', 'boton_panico')),
  severidad text not null check (severidad in ('baja', 'media', 'alta')),
  origen text not null default 'sistema' check (origen in ('conductor', 'sistema')),
  descripcion text,
  lat double precision not null,
  lng double precision not null,
  vista boolean not null default false,            -- el administrador ya abrió el detalle
  estado text not null default 'pendiente' check (estado in ('pendiente', 'atendida')),
  comentario text,
  atendido_por uuid,
  atendido_en timestamptz,
  check (lat between -90 and 90 and lng between -180 and 180),
  check (
    (estado = 'pendiente' and comentario is null and atendido_por is null and atendido_en is null)
    or (
      estado = 'atendida' and atendido_por is not null and atendido_en is not null
      and comentario is not null and length(btrim(comentario)) between 3 and 500
    )
  )
);

create table if not exists public.incidentes_viaje_auditoria (
  id bigint generated always as identity primary key,
  incidente_id uuid not null references public.incidentes_viaje(id) on delete cascade,
  usuario uuid not null,
  usuario_nombre text not null,
  fecha timestamptz not null default now(),
  comentario text not null
);

create index if not exists ix_incidentes_viaje_estado_fecha
  on public.incidentes_viaje(estado, fecha desc);
create index if not exists ix_incidentes_viaje_auditoria_incidente
  on public.incidentes_viaje_auditoria(incidente_id, fecha desc);

alter table public.incidentes_viaje enable row level security;
alter table public.incidentes_viaje_auditoria enable row level security;

drop policy if exists incidentes_viaje_coordinador_lee on public.incidentes_viaje;
create policy incidentes_viaje_coordinador_lee on public.incidentes_viaje
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas');

-- Lo único que el usuario puede cambiar directamente es "vista". Atender se hace con la función de abajo.
drop policy if exists incidentes_viaje_coordinador_marca_vista on public.incidentes_viaje;
create policy incidentes_viaje_coordinador_marca_vista on public.incidentes_viaje
  for update to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas');

drop policy if exists incidentes_viaje_auditoria_coordinador_lee on public.incidentes_viaje_auditoria;
create policy incidentes_viaje_auditoria_coordinador_lee on public.incidentes_viaje_auditoria
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas');

revoke all on public.incidentes_viaje from authenticated;
revoke all on public.incidentes_viaje_auditoria from authenticated;
grant select on public.incidentes_viaje to authenticated;
grant update (vista) on public.incidentes_viaje to authenticated;
grant select on public.incidentes_viaje_auditoria to authenticated;

-- Marca la alerta como atendida y registra la auditoría (quién, cuándo y comentario) en una sola
-- transacción. Revalida el rol en PostgreSQL (ADR 0002).
create or replace function public.atender_incidente_viaje(p_id uuid, p_comentario text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ahora timestamptz := now();
  v_nombre text;
  v_estado text;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'Esta sección es solo para el administrador de rutas.' using errcode = '42501';
  end if;
  if p_comentario is null or length(btrim(p_comentario)) not between 3 and 500 then
    raise exception 'El comentario debe tener entre 3 y 500 caracteres.' using errcode = '22023';
  end if;

  v_nombre := coalesce(auth.jwt() -> 'user_metadata' ->> 'name', auth.jwt() ->> 'email', 'Usuario');

  update public.incidentes_viaje
  set estado = 'atendida', vista = true, comentario = btrim(p_comentario),
      atendido_por = auth.uid(), atendido_en = v_ahora
  where id = p_id and estado = 'pendiente';

  if not found then
    select estado into v_estado from public.incidentes_viaje where id = p_id;
    if v_estado is null then
      return jsonb_build_object('ok', false, 'reason', 'not_found');
    end if;
    return jsonb_build_object('ok', false, 'reason', 'already_attended');
  end if;

  insert into public.incidentes_viaje_auditoria (incidente_id, usuario, usuario_nombre, fecha, comentario)
  values (p_id, auth.uid(), v_nombre, v_ahora, btrim(p_comentario));

  return jsonb_build_object('ok', true, 'atendido_en', v_ahora, 'atendido_nombre', v_nombre);
end;
$$;

revoke all on function public.atender_incidente_viaje(uuid, text) from public, anon;
grant execute on function public.atender_incidente_viaje(uuid, text) to authenticated;

-- EJEMPLO para probar (cambia 'RT-XXXXXXXX' por un id real de public.rutas_planificadas):
-- insert into public.incidentes_viaje (ruta_id, tipo, severidad, origen, descripcion, lat, lng)
-- values ('RT-XXXXXXXX', 'boton_panico', 'alta', 'conductor', 'El conductor presionó el botón de pánico', 13.6989, -89.1914);