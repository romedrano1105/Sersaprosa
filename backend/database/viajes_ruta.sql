-- Datos del viaje (origen, destino y horario) en la ruta planificada del día.
-- Monto, tipo de carga y nivel de riesgo ya viven en rutas_planificadas (riesgo_rutas.sql).
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
