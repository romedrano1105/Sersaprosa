-- FCJ1-99 a FCJ1-103: monto, tipo de carga, nivel de riesgo y auditoría de rutas.
-- Rol permitido: coordinador_rutas (el mismo que usa operaciones_rutas.sql).

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

alter table public.rutas_planificadas
  add column if not exists monto numeric(14,2) check (monto > 0),
  add column if not exists tipo_carga_id smallint references public.tipos_carga(id),
  add column if not exists nivel_riesgo text check (nivel_riesgo in ('Bajo','Medio','Alto')),
  add column if not exists riesgo_especificado_por text,
  add column if not exists riesgo_especificado_en timestamptz;

create table if not exists public.auditoria_riesgo_ruta (
  id bigint generated always as identity primary key,
  ruta_id text not null references public.rutas_planificadas(id),
  monto numeric(14,2) not null,
  tipo_carga_id smallint not null,
  nivel_riesgo text not null,
  usuario_id uuid,
  usuario_email text,
  creado_en timestamptz not null default now()
);

alter table public.tipos_carga enable row level security;
alter table public.auditoria_riesgo_ruta enable row level security;
-- Sin políticas: solo se accede mediante las funciones de abajo.

create or replace function public.es_coordinador_rutas()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'coordinador_rutas'
$$;

-- Umbrales provisionales (pendientes de aclarar en FCJ1-98).
-- Nivel de riesgo por monto según la sensibilidad del tipo de carga (umbrales en USD; ajústalos aquí).
--   sensibilidad 0 (documentos, mercancía general): Bajo < 10,000 · Medio < 100,000 · Alto ≥ 100,000
--   sensibilidad 1 (medicamentos, electrónicos):    Bajo <  5,000 · Medio <  50,000 · Alto ≥  50,000
--   sensibilidad 2 (efectivo, joyería):             Bajo <  1,000 · Medio <  10,000 · Alto ≥  10,000
-- La misma tabla está en backend/app/viajes_logica.py (nivel_de_riesgo).
create or replace function public.nivel_riesgo_por_monto(p_monto numeric, p_sensibilidad smallint)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_monto >= (case p_sensibilidad when 2 then 10000 when 1 then 50000 else 100000 end) then 'Alto'
    when p_monto >= (case p_sensibilidad when 2 then 1000 when 1 then 5000 else 10000 end) then 'Medio'
    else 'Bajo'
  end
$$;

create or replace function public.calcular_nivel_riesgo(p_monto numeric, p_tipo_carga_id smallint)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_sens smallint;
begin
  if not public.es_coordinador_rutas() then
    raise exception 'no_autorizado' using errcode = '42501';
  end if;
  if p_monto is null or p_monto <= 0 then
    raise exception 'monto_invalido' using errcode = 'P0001';
  end if;

  select sensibilidad into v_sens
  from public.tipos_carga where id = p_tipo_carga_id and activo;
  if not found then
    raise exception 'tipo_invalido' using errcode = 'P0001';
  end if;

  return public.nivel_riesgo_por_monto(p_monto, v_sens);
end $$;

create or replace function public.especificar_riesgo_ruta(
  p_ruta_id text, p_monto numeric, p_tipo_carga_id smallint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_nivel text;
  v_email text := auth.jwt() ->> 'email';
begin
  if not public.es_coordinador_rutas() then
    raise exception 'no_autorizado' using errcode = '42501';
  end if;
  v_nivel := public.calcular_nivel_riesgo(p_monto, p_tipo_carga_id);

  update public.rutas_planificadas
     set monto = p_monto,
         tipo_carga_id = p_tipo_carga_id,
         nivel_riesgo = v_nivel,
         riesgo_especificado_por = coalesce(v_email, auth.uid()::text),
         riesgo_especificado_en = now()
   where id = p_ruta_id;
  if not found then
    raise exception 'ruta_no_encontrada' using errcode = 'P0001';
  end if;

  insert into public.auditoria_riesgo_ruta
    (ruta_id, monto, tipo_carga_id, nivel_riesgo, usuario_id, usuario_email)
  values (p_ruta_id, p_monto, p_tipo_carga_id, v_nivel, auth.uid(), v_email);

  return jsonb_build_object('ruta_id', p_ruta_id, 'nivel_riesgo', v_nivel);
end $$;

create or replace function public.listar_rutas_riesgo(p_ruta_id text default null)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.es_coordinador_rutas() then
    raise exception 'no_autorizado' using errcode = '42501';
  end if;
  return query
    select to_jsonb(r) || jsonb_build_object('tipo_carga', t.nombre)
    from public.rutas_planificadas r
    left join public.tipos_carga t on t.id = r.tipo_carga_id
    where p_ruta_id is null or r.id = p_ruta_id
    order by r.nombre;
end $$;

create or replace function public.listar_tipos_carga()
returns setof public.tipos_carga language plpgsql security definer set search_path = '' as $$
begin
  if not public.es_coordinador_rutas() then
    raise exception 'no_autorizado' using errcode = '42501';
  end if;
  return query select * from public.tipos_carga where activo order by nombre;
end $$;

revoke all on function public.es_coordinador_rutas() from public, anon;
revoke all on function public.nivel_riesgo_por_monto(numeric, smallint) from public, anon;
grant execute on function public.nivel_riesgo_por_monto(numeric, smallint) to authenticated;
revoke all on function public.calcular_nivel_riesgo(numeric, smallint) from public, anon;
revoke all on function public.especificar_riesgo_ruta(text, numeric, smallint) from public, anon;
revoke all on function public.listar_rutas_riesgo(text) from public, anon;
revoke all on function public.listar_tipos_carga() from public, anon;
grant execute on function public.es_coordinador_rutas() to authenticated;
grant execute on function public.calcular_nivel_riesgo(numeric, smallint) to authenticated;
grant execute on function public.especificar_riesgo_ruta(text, numeric, smallint) to authenticated;
grant execute on function public.listar_rutas_riesgo(text) to authenticated;
grant execute on function public.listar_tipos_carga() to authenticated;

-- Recalcula con la tabla de umbrales actual el nivel de las rutas que ya tienen monto y tipo de carga.
update public.rutas_planificadas r
set nivel_riesgo = public.nivel_riesgo_por_monto(r.monto, t.sensibilidad)
from public.tipos_carga t
where t.id = r.tipo_carga_id
  and r.monto is not null
  and r.nivel_riesgo is distinct from public.nivel_riesgo_por_monto(r.monto, t.sensibilidad);

notify pgrst, 'reload schema';