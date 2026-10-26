-- Viajes (Tracking de rutas): todo lo que necesita «Nuevo viaje». Se puede ejecutar varias veces.
-- Incluye los tipos de carga y las columnas de monto/riesgo, así no hace falta otro script para empezar.

-- 1) Tipos de carga (los mismos de riesgo_rutas.sql)
create table if not exists public.tipos_carga (
  id smallint generated always as identity primary key,
  nombre text not null unique,
  sensibilidad smallint not null check (sensibilidad between 0 and 2),
  activo boolean not null default true
);

insert into public.tipos_carga (nombre, sensibilidad) values
  ('Efectivo / valores', 2),
  ('Joyería y metales preciosos', 2),
  ('Medicamentos', 1),
  ('Electrónicos', 1),
  ('Documentos', 0),
  ('Mercancía general', 0)
on conflict (nombre) do nothing;

alter table public.tipos_carga enable row level security;

-- 2) Monto, tipo de carga y nivel de riesgo de la ruta
alter table public.rutas_planificadas
  add column if not exists monto numeric(14,2) check (monto > 0),
  add column if not exists tipo_carga_id smallint references public.tipos_carga(id),
  add column if not exists nivel_riesgo text check (nivel_riesgo in ('Bajo','Medio','Alto')),
  add column if not exists riesgo_especificado_por text,
  add column if not exists riesgo_especificado_en timestamptz;

-- 3) Origen, destino y horario del viaje
alter table public.rutas_planificadas
  add column if not exists origen_texto text,
  add column if not exists origen_lat double precision,
  add column if not exists origen_lng double precision,
  add column if not exists destino_texto text,
  add column if not exists destino_lat double precision,
  add column if not exists destino_lng double precision,
  add column if not exists hora_salida time,
  add column if not exists creado_por text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rutas_viaje_coordenadas_check') then
    alter table public.rutas_planificadas add constraint rutas_viaje_coordenadas_check check (
      (origen_lat is null or origen_lat between -90 and 90) and (origen_lng is null or origen_lng between -180 and 180)
      and (destino_lat is null or destino_lat between -90 and 90) and (destino_lng is null or destino_lng between -180 and 180));
  end if;
end $$;
