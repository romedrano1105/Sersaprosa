-- Métricas operativas. Ejecutar después de crear rutas_planificadas,
-- entregas y eventos_especiales.

-- Las rutas anteriores quedan sin clasificar: no se presume que fueran manuales
-- ni generadas por IA. Las nuevas rutas guardadas manualmente usan el default.
alter table public.rutas_planificadas
  add column if not exists metodo_creacion text;

update public.rutas_planificadas
set metodo_creacion = 'sin_clasificar'
where metodo_creacion is null;

alter table public.rutas_planificadas
  alter column metodo_creacion set default 'manual',
  alter column metodo_creacion set not null;

alter table public.rutas_planificadas
  drop constraint if exists rutas_planificadas_metodo_creacion_check;
alter table public.rutas_planificadas
  add constraint rutas_planificadas_metodo_creacion_check
  check (metodo_creacion in ('ia', 'manual', 'sin_clasificar'));

create index if not exists rutas_planificadas_metricas_fecha_idx
  on public.rutas_planificadas (fecha, metodo_creacion);

-- Tiempos reales por entrega: desde su primer cambio a en_proceso hasta completada.
alter table public.entregas
  add column if not exists fecha_inicio_proceso timestamptz,
  add column if not exists fecha_completada_en timestamptz;

create or replace function public.registrar_tiempos_entrega()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.estado is distinct from old.estado then
    if new.estado = 'pendiente' then
      new.fecha_inicio_proceso := null;
      new.fecha_completada_en := null;
    elsif new.estado = 'en_proceso' then
      if old.estado is distinct from 'en_proceso' then
        new.fecha_inicio_proceso := now();
      end if;
      new.fecha_completada_en := null;
    elsif new.estado = 'completada' then
      new.fecha_completada_en := now();
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists entregas_registrar_tiempos_metricas on public.entregas;
create trigger entregas_registrar_tiempos_metricas
before update of estado on public.entregas
for each row execute function public.registrar_tiempos_entrega();
revoke all on function public.registrar_tiempos_entrega() from public, anon, authenticated;

-- "Revisado" no equivale a "mitigado". Solo una confirmación explícita cuenta.
do $$
begin
  if to_regclass('public.eventos_especiales') is null then
    raise exception 'Cree primero la tabla public.eventos_especiales antes de aplicar esta migración.';
  end if;
end;
$$;

alter table public.eventos_especiales
  add column if not exists estado_metrica text not null default 'sin_confirmar',
  add column if not exists metrica_actualizada_en timestamptz,
  add column if not exists metrica_actualizada_por text;

alter table public.eventos_especiales
  drop constraint if exists eventos_especiales_estado_metrica_check;
alter table public.eventos_especiales
  add constraint eventos_especiales_estado_metrica_check
  check (estado_metrica in ('sin_confirmar', 'mitigado', 'ocurrido'));

create index if not exists eventos_especiales_metricas_inicio_idx
  on public.eventos_especiales (inicio, estado_metrica);

create table if not exists public.metricas_eventos_auditoria (
  id bigint generated always as identity primary key,
  evento_id text not null,
  estado_anterior text not null,
  estado_nuevo text not null check (estado_nuevo in ('mitigado', 'ocurrido')),
  usuario_id uuid not null,
  usuario_nombre text not null,
  fecha timestamptz not null default now()
);

alter table public.metricas_eventos_auditoria enable row level security;
revoke all on public.metricas_eventos_auditoria from public, anon, authenticated;

create or replace function public.actualizar_estado_metrica_evento(
  p_evento_id text,
  p_estado text,
  p_usuario_id uuid,
  p_usuario_nombre text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_anterior text;
  v_fecha timestamptz := now();
begin
  if p_estado not in ('mitigado', 'ocurrido') then
    raise exception 'Estado de métrica no válido.' using errcode = '22023';
  end if;

  select estado_metrica into v_anterior
  from public.eventos_especiales
  where id = p_evento_id
  for update;

  if not found then
    return jsonb_build_object('ok', false);
  end if;

  update public.eventos_especiales
  set estado_metrica = p_estado,
      metrica_actualizada_en = v_fecha,
      metrica_actualizada_por = p_usuario_id::text
  where id = p_evento_id;

  insert into public.metricas_eventos_auditoria (
    evento_id, estado_anterior, estado_nuevo, usuario_id, usuario_nombre, fecha
  ) values (
    p_evento_id, coalesce(v_anterior, 'sin_confirmar'), p_estado,
    p_usuario_id, coalesce(nullif(btrim(p_usuario_nombre), ''), 'Usuario'), v_fecha
  );

  return jsonb_build_object('ok', true, 'estado_metrica', p_estado, 'actualizado_en', v_fecha);
end;
$$;

revoke all on function public.actualizar_estado_metrica_evento(text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.actualizar_estado_metrica_evento(text, text, uuid, text)
  to service_role;

notify pgrst, 'reload schema';
