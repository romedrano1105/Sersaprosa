-- Cambia únicamente el rol del usuario indicado. Sustituye el correo antes de ejecutar.
do $$
declare
  v_email text := 'REEMPLAZAR_POR_EL_CORREO_EXACTO';
  v_usuarios integer;
begin
  if v_email = 'REEMPLAZAR_POR_EL_CORREO_EXACTO' then
    raise exception 'Sustituye el correo por el del usuario correcto antes de ejecutar.';
  end if;

  select count(*) into v_usuarios
  from auth.users
  where lower(email) = lower(v_email);

  if v_usuarios <> 1 then
    raise exception 'Se esperaba un usuario Auth con ese correo; encontrados: %.', v_usuarios;
  end if;

  update auth.users
  set raw_app_meta_data =
    coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', 'coordinador_rutas')
  where lower(email) = lower(v_email);
end
$$;
