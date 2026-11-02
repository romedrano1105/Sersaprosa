-- Ejecutar después de operaciones_rutas.sql y riesgo_rutas.sql.
-- Las noticias se asocian a una ruta; el acceso de lectura se realiza mediante RPC.

create table if not exists public.noticias_riesgo (
  id uuid primary key default gen_random_uuid(),
  ruta_id text,
  riesgo_id text,
  titular text not null,
  fuente text not null,
  fecha timestamptz not null,
  zona text not null,
  enlace text not null,
  created_at timestamptz not null default now()
);

alter table public.noticias_riesgo
  add column if not exists ruta_id text;

-- Migra filas antiguas solo cuando riesgo_id coincide con una ruta existente.
update public.noticias_riesgo n
set ruta_id = n.riesgo_id
where n.ruta_id is null
  and n.riesgo_id is not null
  and exists (
    select 1
    from public.rutas_planificadas r
    where r.id = n.riesgo_id
  );

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'noticias_riesgo_ruta_id_fkey'
      and conrelid = 'public.noticias_riesgo'::regclass
  ) then
    alter table public.noticias_riesgo
      add constraint noticias_riesgo_ruta_id_fkey
      foreign key (ruta_id)
      references public.rutas_planificadas(id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'noticias_riesgo_ruta_id_required'
      and conrelid = 'public.noticias_riesgo'::regclass
  ) then
    alter table public.noticias_riesgo
      add constraint noticias_riesgo_ruta_id_required
      check (ruta_id is not null)
      not valid;
  end if;
end
$$;

create index if not exists noticias_riesgo_ruta_fecha_idx
  on public.noticias_riesgo (ruta_id, fecha desc);

alter table public.noticias_riesgo enable row level security;
revoke all on public.noticias_riesgo from public, anon, authenticated;
comment on column public.noticias_riesgo.riesgo_id is
  'Columna heredada; la relación vigente con la ruta usa ruta_id.';

create or replace function public.listar_noticias_riesgo(
  p_ruta_id text,
  p_pagina integer default 1,
  p_limite integer default 10,
  p_fuente text default null,
  p_fecha date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_riesgo text;
  v_total bigint;
  v_items jsonb;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'no_autorizado' using errcode = '42501';
  end if;

  if p_pagina is null or p_pagina < 1
    or p_limite is null or p_limite < 1 or p_limite > 100 then
    raise exception 'paginacion_invalida' using errcode = '22023';
  end if;

  select lower(r.nivel_riesgo)
    into v_riesgo
  from public.rutas_planificadas r
  where r.id = p_ruta_id;

  if not found then
    raise exception 'ruta_no_encontrada' using errcode = 'P0001';
  end if;

  select count(*)
    into v_total
  from public.noticias_riesgo n
  where n.ruta_id = p_ruta_id
    and (p_fuente is null or n.fuente ilike '%' || btrim(p_fuente) || '%')
    and (p_fecha is null or n.fecha::date = p_fecha);

  select coalesce(
    jsonb_agg(to_jsonb(pagina) order by pagina.fecha desc, pagina.id),
    '[]'::jsonb
  )
    into v_items
  from (
    select n.id, n.titular, n.fuente, n.fecha, n.zona, n.enlace
    from public.noticias_riesgo n
    where n.ruta_id = p_ruta_id
      and (p_fuente is null or n.fuente ilike '%' || btrim(p_fuente) || '%')
      and (p_fecha is null or n.fecha::date = p_fecha)
    order by n.fecha desc, n.id
    limit p_limite
    offset (p_pagina - 1) * p_limite
  ) as pagina;

  return jsonb_build_object(
    'riesgo', v_riesgo,
    'total', v_total,
    'items', v_items
  );
end
$$;

revoke all on function public.listar_noticias_riesgo(text, integer, integer, text, date)
  from public, anon;
grant execute on function public.listar_noticias_riesgo(text, integer, integer, text, date)
  to authenticated;

notify pgrst, 'reload schema';
