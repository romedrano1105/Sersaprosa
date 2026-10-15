-- Coordenadas verificadas de cada destino, necesarias para solicitar rutas por calles.
-- Las columnas son opcionales para conservar las entregas existentes.
alter table public.entregas
  add column if not exists lat double precision,
  add column if not exists lng double precision;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'entregas_coordenadas_rango_check'
      and conrelid = 'public.entregas'::regclass
  ) then
    alter table public.entregas
      add constraint entregas_coordenadas_rango_check
      check (
        (lat is null and lng is null)
        or (lat between -90 and 90 and lng between -180 and 180)
      );
  end if;
end
$$;
