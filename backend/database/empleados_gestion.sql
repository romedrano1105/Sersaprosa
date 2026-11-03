-- Gestión de empleados reales (conductores y guardias/custodios) desde la aplicación.
-- Requiere empleados.sql, operaciones_rutas.sql y rutas_operativas_seguras.sql. Se puede ejecutar varias veces.
--
-- Todas las funciones validan el rol coordinador_rutas dentro de PostgreSQL y se llaman con el token del
-- usuario (sin clave de servicio). No se borra a nadie: la baja es lógica (activo = false) para conservar
-- el historial de asignaciones.
--
--   listar_empleados_operativos()                         → empleados con su asignación de hoy
--   guardar_empleado_operativo(codigo, nombre, categoria, licencia, activo) → alta o edición
--   cambiar_estado_empleado(codigo, activo)               → dar de baja / reactivar

create or replace function public.listar_empleados_operativos()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hoy date := timezone('America/El_Salvador', now())::date;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'No tiene permiso para consultar el personal.' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'codigo', e.codigo,
      'nombre', e.nombre,
      'categoria', coalesce(e.categoria, 'conductor'),
      'activo', e.activo,
      'licencia', e.licencia,
      'asignacion', coalesce(
        (select jsonb_build_object('ruta_id', r.id, 'ruta', r.nombre, 'rol', 'conductor')
           from public.asignaciones_ruta a
           join public.rutas_planificadas r on r.id = a.ruta_id
          where a.fecha_operativa = v_hoy and a.conductor_id = e.codigo
          limit 1),
        (select jsonb_build_object('ruta_id', r.id, 'ruta', r.nombre, 'rol', 'guardia')
           from public.asignaciones_guardias g
           join public.asignaciones_ruta a on a.id = g.asignacion_id
           join public.rutas_planificadas r on r.id = a.ruta_id
          where g.fecha_operativa = v_hoy and g.guardia_id = e.codigo
          limit 1))
    ) order by e.activo desc, e.nombre)
    from public.empleados e
  ), '[]'::jsonb);
end;
$$;

create or replace function public.guardar_empleado_operativo(
  p_codigo text,
  p_nombre text,
  p_categoria text,
  p_licencia date,
  p_activo boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hoy date := timezone('America/El_Salvador', now())::date;
  v_codigo text := upper(nullif(btrim(coalesce(p_codigo, '')), ''));
  v_nombre text := regexp_replace(btrim(coalesce(p_nombre, '')), '\s+', ' ', 'g');
  v_prefijo text;
  v_numero integer;
  v_actual public.empleados%rowtype;
  v_asignado boolean;
  v_tiene_password boolean;
  v_tiene_correo boolean;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'Solo el coordinador de rutas puede gestionar el personal.' using errcode = '42501';
  end if;
  if char_length(v_nombre) < 3 or char_length(v_nombre) > 120 then
    raise exception 'El nombre debe tener entre 3 y 120 caracteres.' using errcode = '22023';
  end if;
  if p_categoria not in ('conductor', 'guardia') then
    raise exception 'La categoría debe ser conductor o guardia.' using errcode = '22023';
  end if;
  if p_categoria = 'conductor' and p_licencia is null then
    raise exception 'Un conductor necesita la fecha de vencimiento de su licencia.' using errcode = '22023';
  end if;
  if v_codigo is not null and v_codigo !~ '^[A-Z0-9][A-Z0-9_-]{1,39}$' then
    raise exception 'El código solo admite letras, números, guiones y guiones bajos.' using errcode = '22023';
  end if;

  -- Edición (si el código ya existe)
  if v_codigo is not null then
    select * into v_actual from public.empleados where codigo = v_codigo for update;
  end if;
  if v_codigo is not null and v_actual.codigo is not null then
    v_asignado := exists (
      select 1 from public.asignaciones_ruta where fecha_operativa = v_hoy and conductor_id = v_codigo
    ) or exists (
      select 1 from public.asignaciones_guardias where fecha_operativa = v_hoy and guardia_id = v_codigo
    );
    if v_asignado and (coalesce(v_actual.categoria, 'conductor') <> p_categoria or coalesce(p_activo, true) = false) then
      raise exception 'El empleado tiene una ruta asignada hoy: desasígnala antes de cambiar su categoría o darlo de baja.'
        using errcode = 'P0001';
    end if;
    update public.empleados
    set nombre = v_nombre,
        categoria = p_categoria,
        licencia = case when p_categoria = 'conductor' then p_licencia else null end,
        activo = coalesce(p_activo, activo)
    where codigo = v_codigo;
    return jsonb_build_object('codigo', v_codigo, 'nombre', v_nombre, 'categoria', p_categoria,
      'licencia', case when p_categoria = 'conductor' then p_licencia end, 'activo', coalesce(p_activo, v_actual.activo),
      'creado', false);
  end if;

  -- Alta: código automático (CON-001, GUA-001, …) si no se indicó uno
  if v_codigo is null then
    v_prefijo := case p_categoria when 'conductor' then 'CON-' else 'GUA-' end;
    select coalesce(max(substring(codigo from '^' || v_prefijo || '([0-9]+)$')::integer), 0) + 1
      into v_numero
      from public.empleados
     where codigo ~ ('^' || v_prefijo || '[0-9]+$');
    v_codigo := v_prefijo || lpad(v_numero::text, 3, '0');
  end if;

  -- Algunas instalaciones exigen correo (y una contraseña de marcador). El acceso real vive en Supabase Auth.
  v_tiene_correo := exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'empleados' and column_name = 'correo');
  v_tiene_password := exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'empleados' and column_name = 'password');

  execute format(
    'insert into public.empleados (codigo, nombre, categoria, licencia, activo%s%s) values ($1, $2, $3, $4, $5%s%s)',
    case when v_tiene_correo then ', correo' else '' end,
    case when v_tiene_password then ', password' else '' end,
    case when v_tiene_correo then ', $6' else '' end,
    case when v_tiene_password then ', ''sin-uso-demo''' else '' end)
  using v_codigo, v_nombre, p_categoria,
        case when p_categoria = 'conductor' then p_licencia end,
        coalesce(p_activo, true),
        lower(v_codigo) || '@personal.sersaprosa.invalid';

  return jsonb_build_object('codigo', v_codigo, 'nombre', v_nombre, 'categoria', p_categoria,
    'licencia', case when p_categoria = 'conductor' then p_licencia end, 'activo', coalesce(p_activo, true),
    'creado', true);
exception
  when unique_violation then
    raise exception 'Ya existe un empleado con ese código.' using errcode = '23505';
end;
$$;

create or replace function public.cambiar_estado_empleado(p_codigo text, p_activo boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hoy date := timezone('America/El_Salvador', now())::date;
  v_codigo text := upper(btrim(coalesce(p_codigo, '')));
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'coordinador_rutas' then
    raise exception 'Solo el coordinador de rutas puede gestionar el personal.' using errcode = '42501';
  end if;
  if p_activo is null then
    raise exception 'Indica si el empleado queda activo o no.' using errcode = '22023';
  end if;
  if not p_activo and (
    exists (select 1 from public.asignaciones_ruta where fecha_operativa = v_hoy and conductor_id = v_codigo)
    or exists (select 1 from public.asignaciones_guardias where fecha_operativa = v_hoy and guardia_id = v_codigo)
  ) then
    raise exception 'El empleado tiene una ruta asignada hoy: desasígnala antes de darlo de baja.' using errcode = 'P0001';
  end if;

  update public.empleados set activo = p_activo where codigo = v_codigo;
  if not found then
    raise exception 'El empleado no existe.' using errcode = 'P0001';
  end if;
  return jsonb_build_object('codigo', v_codigo, 'activo', p_activo);
end;
$$;

revoke all on function public.listar_empleados_operativos() from public, anon;
grant execute on function public.listar_empleados_operativos() to authenticated;
revoke all on function public.guardar_empleado_operativo(text, text, text, date, boolean) from public, anon;
grant execute on function public.guardar_empleado_operativo(text, text, text, date, boolean) to authenticated;
revoke all on function public.cambiar_estado_empleado(text, boolean) from public, anon;
grant execute on function public.cambiar_estado_empleado(text, boolean) to authenticated;

notify pgrst, 'reload schema';
