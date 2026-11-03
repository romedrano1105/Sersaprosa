-- «Editar viaje» (Tracking): consulta y guarda el viaje con el JWT del coordinador, sin la clave service_role.
-- Requiere viajes_ruta.sql, riesgo_rutas.sql y rutas_operativas_seguras.sql. Se puede ejecutar varias veces.

-- Datos actuales del viaje y si ya salió (conductor guardado o asignación de hoy).
create or replace function public.consultar_viaje_editable(p_ruta text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hoy date := timezone('America/El_Salvador', now())::date;
  v_ruta public.rutas_planificadas%rowtype;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'Solo el coordinador de rutas puede editar viajes.' using errcode = '42501';
  end if;
  select * into v_ruta from public.rutas_planificadas where id = p_ruta;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'id', v_ruta.id, 'nombre', v_ruta.nombre, 'fecha', v_ruta.fecha, 'entregas', v_ruta.entregas,
    'conductor', v_ruta.conductor,
    'origen_texto', v_ruta.origen_texto, 'origen_lat', v_ruta.origen_lat, 'origen_lng', v_ruta.origen_lng,
    'destino_texto', v_ruta.destino_texto, 'destino_lat', v_ruta.destino_lat, 'destino_lng', v_ruta.destino_lng,
    'asignada', exists (
      select 1 from public.asignaciones_ruta where ruta_id = p_ruta and fecha_operativa = v_hoy
    )
  );
end;
$$;

-- Guarda origen, destino, horario, monto y tipo de carga; recalcula el riesgo y deja la propuesta para revisar.
create or replace function public.actualizar_viaje_operativo(
  p_ruta text,
  p_origen text,
  p_origen_lat double precision,
  p_origen_lng double precision,
  p_destino text,
  p_destino_lat double precision,
  p_destino_lng double precision,
  p_hora_salida time,
  p_monto numeric,
  p_tipo_carga_id smallint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hoy date := timezone('America/El_Salvador', now())::date;
  v_email text := auth.jwt() ->> 'email';
  v_ruta public.rutas_planificadas%rowtype;
  v_sensibilidad smallint;
  v_nivel text;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'Solo el coordinador de rutas puede editar viajes.' using errcode = '42501';
  end if;
  if nullif(btrim(p_origen), '') is null
      or nullif(btrim(p_destino), '') is null
      or p_hora_salida is null
      or p_monto is null or p_monto <= 0
      or p_tipo_carga_id is null
      or p_origen_lat is null or p_origen_lat not between -90 and 90
      or p_origen_lng is null or p_origen_lng not between -180 and 180
      or p_destino_lat is null or p_destino_lat not between -90 and 90
      or p_destino_lng is null or p_destino_lng not between -180 and 180 then
    raise exception 'Los datos del viaje no son válidos.' using errcode = '22023';
  end if;

  select * into v_ruta from public.rutas_planificadas where id = p_ruta for update;
  if not found or v_ruta.fecha <> v_hoy then
    raise exception 'La ruta no existe o no es de hoy.' using errcode = 'P0001';
  end if;
  if coalesce(btrim(v_ruta.conductor), '') <> '' or exists (
    select 1 from public.asignaciones_ruta where ruta_id = p_ruta and fecha_operativa = v_hoy
  ) then
    raise exception 'La ruta ya salió (tiene conductor asignado). Desasígnala antes de editar el viaje.' using errcode = 'P0001';
  end if;

  select sensibilidad into v_sensibilidad from public.tipos_carga where id = p_tipo_carga_id and activo;
  if not found then
    raise exception 'El tipo de carga no está disponible.' using errcode = '22023';
  end if;
  v_nivel := public.nivel_riesgo_por_monto(p_monto, v_sensibilidad);

  update public.rutas_planificadas
  set origen_texto = btrim(p_origen), origen_lat = p_origen_lat, origen_lng = p_origen_lng,
      destino_texto = btrim(p_destino), destino_lat = p_destino_lat, destino_lng = p_destino_lng,
      hora_salida = p_hora_salida, monto = p_monto, tipo_carga_id = p_tipo_carga_id, nivel_riesgo = v_nivel,
      riesgo_especificado_por = coalesce(v_email, auth.uid()::text), riesgo_especificado_en = now(),
      estado_propuesta = 'propuesta', version = coalesce(version, 1) + 1
  where id = p_ruta
  returning * into v_ruta;

  insert into public.auditoria_riesgo_ruta (ruta_id, monto, tipo_carga_id, nivel_riesgo, usuario_id, usuario_email)
  values (p_ruta, p_monto, p_tipo_carga_id, v_nivel, auth.uid(), v_email);

  return jsonb_build_object(
    'id', v_ruta.id, 'nombre', v_ruta.nombre, 'fecha', v_ruta.fecha,
    'entregas', v_ruta.entregas, 'nivel_riesgo', v_nivel, 'version', v_ruta.version
  );
end;
$$;

revoke all on function public.consultar_viaje_editable(text) from public, anon;
grant execute on function public.consultar_viaje_editable(text) to authenticated;
revoke all on function public.actualizar_viaje_operativo(text, text, double precision, double precision, text, double precision, double precision, time, numeric, smallint) from public, anon;
grant execute on function public.actualizar_viaje_operativo(text, text, double precision, double precision, text, double precision, double precision, time, numeric, smallint) to authenticated;

notify pgrst, 'reload schema';
