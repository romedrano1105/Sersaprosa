-- Pedidos/entregas y sus relaciones operativas.
create table if not exists public.entregas (
  id text primary key,
  cliente text,
  direccion text,
  hora_programada timestamptz,
  estado text not null default 'pendiente',
  zona text,
  ruta text,
  contacto text,
  productos text,
  notas text,
  lat double precision,
  lng double precision,
  fecha_inicio_proceso timestamptz,
  fecha_completada_en timestamptz
);

alter table public.entregas
  add column if not exists ruta_id text,
  add column if not exists viaje_id text,
  add column if not exists orden integer,
  add column if not exists nivel_riesgo text,
  add column if not exists lat double precision,
  add column if not exists lng double precision,
  add column if not exists fecha_inicio_proceso timestamptz,
  add column if not exists fecha_completada_en timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'entregas_ruta_id_fkey'
      and conrelid = 'public.entregas'::regclass
  ) then
    alter table public.entregas
      add constraint entregas_ruta_id_fkey
      foreign key (ruta_id) references public.rutas_planificadas(id) on delete set null;
  end if;
end
$$;

do $$
declare
  v_ambiguous integer;
  v_unlinked integer;
begin
  select count(*) into v_ambiguous
  from (
    select e.id
    from public.entregas e
    join public.rutas_planificadas r
      on r.nombre = e.ruta
     and r.fecha = (e.hora_programada at time zone 'America/El_Salvador')::date
    where e.ruta_id is null
      and nullif(btrim(e.ruta), '') is not null
    group by e.id
    having count(*) > 1
  ) duplicadas;

  if v_ambiguous > 0 then
    raise exception 'Hay % entregas cuyo nombre de ruta coincide con varias rutas; no se migraron.', v_ambiguous;
  end if;

  update public.entregas e
  set ruta_id = r.id
  from public.rutas_planificadas r
  where e.ruta_id is null
    and nullif(btrim(e.ruta), '') is not null
    and r.nombre = e.ruta
    and r.fecha = (e.hora_programada at time zone 'America/El_Salvador')::date;

  select count(*) into v_unlinked
  from public.entregas
  where ruta_id is null and nullif(btrim(ruta), '') is not null;

  raise notice 'Entregas con ruta histórica sin vínculo automático: %.', v_unlinked;
end
$$;

create index if not exists entregas_ruta_id_idx
  on public.entregas (ruta_id);

create index if not exists entregas_estado_hora_programada_idx
  on public.entregas (estado, hora_programada);

alter table public.entregas enable row level security;

drop policy if exists entregas_lectura_operativa on public.entregas;
create policy entregas_lectura_operativa on public.entregas
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') in ('ejecutivo_comercial', 'coordinador_rutas'));

grant select on public.entregas to authenticated;
