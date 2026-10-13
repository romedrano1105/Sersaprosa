-- Tablas complementarias de alertas de seguridad.
-- Risk_report se conserva sin cambios; un proceso de viajes debe insertar
-- los viajes finalizados y las alertas individuales en estas tablas.
create table if not exists public.viajes_finalizados (
  id text primary key,
  fecha_finalizacion timestamptz not null,
  ruta text not null,
  conductor text not null,
  alertas_count integer not null default 0 check (alertas_count >= 0)
);

create table if not exists public.alertas_seguridad (
  id uuid primary key default gen_random_uuid(),
  viaje_id text not null references public.viajes_finalizados(id) on delete cascade,
  fecha timestamptz not null,
  tipo text not null,
  severidad text not null check (severidad in ('baja', 'media', 'alta')),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'revisada')),
  descripcion text,
  lat double precision,
  lng double precision,
  comentario text,
  revisado_por uuid,
  revisado_en timestamptz,
  check ((lat is null and lng is null) or (lat between -90 and 90 and lng between -180 and 180)),
  check (
    (estado = 'pendiente' and revisado_por is null and revisado_en is null and comentario is null)
    or (
      estado = 'revisada' and revisado_por is not null and revisado_en is not null
      and comentario is not null and length(btrim(comentario)) between 3 and 500
    )
  )
);

create table if not exists public.alertas_seguridad_auditoria (
  id bigint generated always as identity primary key,
  alerta_id uuid not null references public.alertas_seguridad(id) on delete cascade,
  revisor uuid not null,
  revisor_nombre text not null,
  fecha timestamptz not null default now(),
  comentario text not null
);

create index if not exists ix_viajes_finalizados_fecha
  on public.viajes_finalizados(fecha_finalizacion desc);
create index if not exists ix_alertas_seguridad_viaje_fecha
  on public.alertas_seguridad(viaje_id, fecha desc);
create index if not exists ix_alertas_seguridad_estado_fecha
  on public.alertas_seguridad(estado, fecha desc);
create index if not exists ix_alertas_seguridad_auditoria_alerta_fecha
  on public.alertas_seguridad_auditoria(alerta_id, fecha desc);

create or replace function public.actualizar_conteo_alertas_viaje()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  viaje text;
begin
  viaje := case when tg_op = 'DELETE' then old.viaje_id else new.viaje_id end;
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  update public.viajes_finalizados
  set alertas_count = (
    select count(*)::integer from public.alertas_seguridad where viaje_id = viaje
  )
  where id = viaje;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_actualizar_conteo_alertas_viaje on public.alertas_seguridad;
create trigger trg_actualizar_conteo_alertas_viaje
after insert or delete on public.alertas_seguridad
for each row execute function public.actualizar_conteo_alertas_viaje();

create or replace function public.registrar_revision_alerta()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  metadata jsonb;
  nombre text;
begin
  if old.estado is distinct from new.estado and new.estado = 'revisada' then
    metadata := auth.jwt();
    nombre := coalesce(metadata -> 'user_metadata' ->> 'name', metadata ->> 'email', 'Usuario');
    insert into public.alertas_seguridad_auditoria(alerta_id, revisor, revisor_nombre, fecha, comentario)
    values (new.id, auth.uid(), nombre, new.revisado_en, new.comentario);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_registrar_revision_alerta on public.alertas_seguridad;
create trigger trg_registrar_revision_alerta
after update of estado on public.alertas_seguridad
for each row execute function public.registrar_revision_alerta();

create or replace function public.revisar_alertas_seguridad(
  p_ids uuid[],
  p_comentario text,
  p_solo_baja boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = public, auth
as $$
declare
  ahora timestamptz := now();
  cantidad integer;
  cambiadas jsonb;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'Esta sección es solo para el coordinador de rutas.' using errcode = '42501';
  end if;
  if p_ids is null or cardinality(p_ids) < 1 or cardinality(p_ids) > 100
     or (select count(distinct item) from unnest(p_ids) as ids(item)) <> cardinality(p_ids) then
    raise exception 'La selección de alertas no es válida.' using errcode = '22023';
  end if;
  if p_comentario is null or length(btrim(p_comentario)) not between 3 and 500 then
    raise exception 'El comentario debe tener entre 3 y 500 caracteres.' using errcode = '22023';
  end if;

  select count(*) into cantidad
  from public.alertas_seguridad
  where id = any(p_ids);
  if cantidad <> cardinality(p_ids) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if exists (
    select 1 from public.alertas_seguridad
    where id = any(p_ids) and estado <> 'pendiente'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'already_reviewed');
  end if;
  if p_solo_baja and exists (
    select 1 from public.alertas_seguridad
    where id = any(p_ids) and severidad <> 'baja'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_low');
  end if;

  with actualizadas as (
    update public.alertas_seguridad
    set estado = 'revisada',
        comentario = btrim(p_comentario),
        revisado_por = auth.uid(),
        revisado_en = ahora
    where id = any(p_ids) and estado = 'pendiente'
    returning id
  )
  select jsonb_agg(id) into cambiadas from actualizadas;

  if coalesce(jsonb_array_length(cambiadas), 0) <> cardinality(p_ids) then
    raise exception 'Una o más alertas cambiaron de estado durante la revisión.' using errcode = '40001';
  end if;
  return jsonb_build_object('ok', true, 'ids', cambiadas, 'revisado_en', ahora);
end;
$$;

alter table public.viajes_finalizados enable row level security;
alter table public.alertas_seguridad enable row level security;
alter table public.alertas_seguridad_auditoria enable row level security;

drop policy if exists coordinador_lee_viajes_finalizados on public.viajes_finalizados;
create policy coordinador_lee_viajes_finalizados on public.viajes_finalizados
for select to authenticated
using (
  (auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas'
  and fecha_finalizacion >= now() - interval '90 days'
);

drop policy if exists coordinador_lee_alertas_seguridad on public.alertas_seguridad;
create policy coordinador_lee_alertas_seguridad on public.alertas_seguridad
for select to authenticated
using (
  (auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas'
  and fecha >= now() - interval '90 days'
);

drop policy if exists coordinador_revisa_alertas_seguridad on public.alertas_seguridad;
create policy coordinador_revisa_alertas_seguridad on public.alertas_seguridad
for update to authenticated
using (
  (auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas'
  and fecha >= now() - interval '90 days'
)
with check (
  (auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas'
  and fecha >= now() - interval '90 days'
);

drop policy if exists coordinador_lee_auditoria_alertas on public.alertas_seguridad_auditoria;
create policy coordinador_lee_auditoria_alertas on public.alertas_seguridad_auditoria
for select to authenticated
using (
  (auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas'
  and fecha >= now() - interval '90 days'
);

grant select on public.viajes_finalizados to authenticated;
grant select on public.alertas_seguridad to authenticated;
grant update (estado, comentario, revisado_por, revisado_en) on public.alertas_seguridad to authenticated;
grant select on public.alertas_seguridad_auditoria to authenticated;
grant execute on function public.revisar_alertas_seguridad(uuid[], text, boolean) to authenticated;

create or replace function public.purgar_alertas_seguridad_expiradas()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.alertas_seguridad where fecha < now() - interval '90 days';
  delete from public.viajes_finalizados where fecha_finalizacion < now() - interval '90 days';
end;
$$;

revoke all on function public.purgar_alertas_seguridad_expiradas() from public, anon, authenticated;

create extension if not exists pg_cron with schema extensions;
select cron.unschedule(jobid) from cron.job where jobname = 'purga-alertas-seguridad-90-dias';
select cron.schedule(
  'purga-alertas-seguridad-90-dias',
  '15 3 * * *',
  'select public.purgar_alertas_seguridad_expiradas();'
);
