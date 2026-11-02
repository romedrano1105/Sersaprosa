alter table public.rutas_planificadas
  add column if not exists estado_propuesta text not null default 'propuesta';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rutas_estado_propuesta_check') then
    alter table public.rutas_planificadas add constraint rutas_estado_propuesta_check
      check (estado_propuesta in ('propuesta', 'rechazada', 'aceptada'));
  end if;
end $$;

create table if not exists public.rechazos_ruta (
  id bigint generated always as identity primary key,
  ruta_id text not null references public.rutas_planificadas(id) on delete cascade,
  motivo text not null check (char_length(btrim(motivo)) between 3 and 200),
  comentario text check (comentario is null or char_length(comentario) <= 500),
  usuario text not null,
  fecha timestamptz not null default now(),
  propuesta jsonb not null default '{}'::jsonb,
  resultado text not null default 'pendiente' check (resultado in ('pendiente', 'generada', 'sin_alternativa')),
  error text
);

create index if not exists rechazos_ruta_por_ruta on public.rechazos_ruta (ruta_id, fecha desc);

alter table public.rechazos_ruta enable row level security;

drop policy if exists rechazos_coordinador_lectura on public.rechazos_ruta;
create policy rechazos_coordinador_lectura on public.rechazos_ruta
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'coordinador_rutas');