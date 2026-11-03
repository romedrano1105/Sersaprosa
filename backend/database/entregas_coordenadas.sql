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

-- Guardar coordenadas encontradas por «Ubicar pedidos» (POST /entregas/ubicar). Escritura con el token del
-- coordinador, sin clave de servicio. Solo completa coordenadas faltantes o inválidas: nunca pisa una buena.
create or replace function public.guardar_coordenadas_entrega(
  p_id text,
  p_lat double precision,
  p_lng double precision
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'Solo el coordinador de rutas puede guardar coordenadas.' using errcode = '42501';
  end if;
  if p_lat is null or p_lng is null
      or not (p_lat between 12.9 and 14.6 and p_lng between -90.3 and -87.5) then
    raise exception 'Las coordenadas deben estar dentro de El Salvador.' using errcode = '22023';
  end if;

  update public.entregas
  set lat = p_lat, lng = p_lng
  where id::text = p_id
    and (lat is null or lng is null or not (lat between 12.9 and 14.6 and lng between -90.3 and -87.5));

  return jsonb_build_object('id', p_id, 'guardada', found);
end;
$$;

revoke all on function public.guardar_coordenadas_entrega(text, double precision, double precision) from public, anon;
grant execute on function public.guardar_coordenadas_entrega(text, double precision, double precision) to authenticated;

notify pgrst, 'reload schema';
