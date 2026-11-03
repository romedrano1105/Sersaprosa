-- Datos de prueba de empleados con nombres de personas (FICTICIOS) y guardias para poder asignarlos.
-- Ejecutar en Supabase → SQL Editor, después de empleados.sql. Se puede ejecutar varias veces.
--
--  1) «Administrador de rutas» deja de aparecer como conductor (pasa a categoría administrador, si la tabla lo permite).
--  2) Los conductores de prueba («Conductor Demo …») reciben nombres de personas, conservando su código,
--     su licencia (el vencido sigue vencido) y sus asignaciones.
--     Lo mismo con los guardias de prueba («Guardia Demo …»).
--  3) Se agregan 4 guardias de ejemplo (GUA-001 a GUA-004) si todavía no existen.
--
-- Los nombres son inventados: no corresponden a personas reales. Cámbialos por los de tu personal.

-- 1) El administrador no es conductor. Si la tabla tiene una regla (empleados_categoria_check) que no admite
--    'administrador', no se cambia nada y solo se avisa: el resto del script sigue.
do $$
begin
  update public.empleados
  set categoria = 'administrador'
  where nombre = 'Administrador de rutas'
    and coalesce(categoria, '') <> 'administrador';
exception when check_violation then
  raise notice 'La categoría «administrador» no está permitida en empleados; «Administrador de rutas» se deja igual.';
end
$$;

-- 2) Conductores de prueba con nombres de personas
with nombres(n, nombre) as (
  values
    (1,  'José Antonio Martínez'),
    (2,  'María Elena Hernández'),
    (3,  'Carlos Alberto Rivas'),
    (4,  'Ana Gabriela López'),
    (5,  'Luis Ernesto Flores'),
    (6,  'Rosa Isabel Mejía'),
    (7,  'Jorge Mauricio Pineda'),
    (8,  'Karla Beatriz Ramírez'),
    (9,  'Víctor Manuel Orellana'),
    (10, 'Claudia Patricia Menjívar'),
    (11, 'Roberto Carlos Escobar'),
    (12, 'Silvia Marina Cruz')
),
demo as (
  select codigo, row_number() over (order by codigo) as n
  from public.empleados
  where nombre ilike '%demo%'
    and coalesce(categoria, 'conductor') = 'conductor'
)
update public.empleados e
set nombre = nm.nombre,
    categoria = 'conductor'
from demo d
join nombres nm on nm.n = d.n
where e.codigo = d.codigo;

-- 2b) Guardias de prueba («Guardia Demo …») con nombres de personas
with nombres(n, nombre) as (
  values
    (1, 'Ricardo Antonio Lemus'),
    (2, 'Doris Elizabeth Chávez'),
    (3, 'Wilfredo Enrique Serrano'),
    (4, 'Marta Alicia Quintanilla'),
    (5, 'Nelson Ovidio Henríquez'),
    (6, 'Brenda Yamileth Sorto'),
    (7, 'Edwin Geovanny Alfaro'),
    (8, 'Lorena Beatriz Arévalo')
),
demo as (
  select codigo, row_number() over (order by codigo) as n
  from public.empleados
  where nombre ilike '%demo%' and categoria = 'guardia'
)
update public.empleados e
set nombre = nm.nombre
from demo d
join nombres nm on nm.n = d.n
where e.codigo = d.codigo;

-- 3) Guardias de ejemplo (sin licencia de conducir: no la necesitan).
--    Si la tabla exige correo o contraseña, se rellenan: correo «gua-00X@guardias.sersaprosa.invalid»
--    (dominio reservado que nunca recibe mensajes) y la contraseña de marcador «sin-uso-demo», igual que
--    los demás empleados de prueba. El acceso real vive en Supabase Auth, no en esta tabla.
do $$
declare
  v_tiene_password boolean := exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'empleados' and column_name = 'password');
  g record;
begin
  for g in
    select * from (values
      ('GUA-001', 'Mario Ernesto Guzmán'),
      ('GUA-002', 'Fredy Alexander Portillo'),
      ('GUA-003', 'Sandra Marisol Aguilar'),
      ('GUA-004', 'Óscar Rolando Castillo')
    ) as t(codigo, nombre)
  loop
    continue when exists (select 1 from public.empleados where codigo = g.codigo);
    if v_tiene_password then
      execute 'insert into public.empleados (codigo, nombre, correo, activo, categoria, password)
               values ($1, $2, $3, true, ''guardia'', ''sin-uso-demo'')'
        using g.codigo, g.nombre, lower(g.codigo) || '@guardias.sersaprosa.invalid';
    else
      insert into public.empleados (codigo, nombre, correo, activo, categoria)
      values (g.codigo, g.nombre, lower(g.codigo) || '@guardias.sersaprosa.invalid', true, 'guardia');
    end if;
  end loop;
end
$$;

-- Resultado
select codigo, nombre, categoria, activo, licencia
from public.empleados
order by categoria nulls first, nombre;
