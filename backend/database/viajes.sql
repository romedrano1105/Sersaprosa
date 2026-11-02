-- Viajes activos. Requiere empleados.sql, operaciones_rutas.sql y entregas.sql.
create table if not exists public.viajes (
  id text primary key default ('V-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))),
  ruta_id text not null references public.rutas_planificadas(id),
  conductor_id text not null references public.empleados(codigo),
  vehiculo_id text not null references public.vehiculos(id),
  estado text not null default 'asignado'
    check (estado in ('asignado', 'en_curso', 'en_transito', 'completado', 'cancelado')),
  fecha_inicio timestamptz,
  fecha_finalizacion timestamptz,
  created_at timestamptz not null default now()
);

alter table public.entregas
  add column if not exists viaje_id text,
  add column if not exists orden integer,
  add column if not exists nivel_riesgo text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'entregas_viaje_id_fkey'
      and conrelid = 'public.entregas'::regclass
  ) then
    alter table public.entregas
      add constraint entregas_viaje_id_fkey
      foreign key (viaje_id) references public.viajes(id) on delete set null;
  end if;
end
$$;

do $$
begin
  if exists (
    select ruta_id
    from public.viajes
    where estado in ('asignado', 'en_curso', 'en_transito')
    group by ruta_id
    having count(*) > 1
  ) then
    raise exception 'Hay rutas con más de un viaje activo; resuélvelas antes de crear el índice único.';
  end if;
end
$$;

create index if not exists viajes_ruta_id_idx
  on public.viajes (ruta_id);

create unique index if not exists viajes_ruta_activa_unica
  on public.viajes (ruta_id)
  where estado in ('asignado', 'en_curso', 'en_transito');

create index if not exists entregas_viaje_orden_idx
  on public.entregas (viaje_id, orden);

alter table public.viajes enable row level security;

drop policy if exists viajes_coordinador_lectura on public.viajes;
create policy viajes_coordinador_lectura on public.viajes
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas');

grant select on public.viajes to authenticated;
