-- Coordenadas para los pedidos (tabla entregas) que no las tienen. Se puede ejecutar varias veces.
-- Ejecutar en Supabase → SQL Editor, DESPUÉS de entregas_coordenadas.sql.
--
-- Qué hace:
--   1) Asegura las columnas lat/lng (double precision) — igual que entregas_coordenadas.sql.
--   2) Limpia coordenadas malas: invierte lat/lng cuando vienen al revés y borra 0,0 o puntos fuera de El Salvador.
--   3) A los pedidos SIN coordenadas les pone el centro APROXIMADO de su municipio o colonia, buscando el nombre
--      en la zona o en la dirección. Cada pedido se separa unos metros (según su id) para que no queden encimados.
--   4) Lista al final los pedidos que siguen sin coordenadas.
--
-- IMPORTANTE: son ubicaciones aproximadas para datos DEMO o para poder trazar mientras se corrigen las
-- direcciones. Para operar con pedidos reales, usa «Ubicar pedidos» en la página (geocodifica la dirección
-- exacta y la guarda) o escribe las coordenadas verificadas del cliente.

-- 1) Columnas
alter table public.entregas
  add column if not exists lat double precision,
  add column if not exists lng double precision;

-- 2) Limpieza (la caja de El Salvador con margen: lat 12.9–14.6, lng -90.3 – -87.5)
update public.entregas
set lat = lng, lng = lat
where lat between -90.3 and -87.5 and lng between 12.9 and 14.6;            -- venían invertidas

update public.entregas
set lat = null, lng = null
where (lat is null) <> (lng is null)                                         -- solo una de las dos
   or (lat = 0 and lng = 0)
   or not (lat between 12.9 and 14.6 and lng between -90.3 and -87.5);       -- fuera del país

-- 3) Centro aproximado por municipio o colonia
with lugares(clave, lat, lng, prioridad) as (
  values
    -- prioridad 1 = colonia/sector (más precisa), 2 = municipio, 3 = zona genérica
    -- Colonias y sectores de San Salvador y alrededores
    ('escalon',            13.7050, -89.2420, 1),
    ('san benito',         13.6950, -89.2380, 1),
    ('merliot',            13.6780, -89.2620, 1),
    ('metrocentro',        13.7058, -89.2125, 1),
    ('centro historico',   13.6979, -89.1912, 1),
    ('multiplaza',         13.6780, -89.2510, 1),
    ('la gran via',        13.6790, -89.2550, 1),
    -- Municipios
    ('antiguo cuscatlan',  13.6730, -89.2400, 2),
    ('nuevo cuscatlan',    13.6480, -89.2650, 2),
    ('santa tecla',        13.6769, -89.2797, 2),
    ('soyapango',          13.7347, -89.1514, 2),
    ('mejicanos',          13.7403, -89.2131, 2),
    ('apopa',              13.8072, -89.1792, 2),
    ('ilopango',           13.7017, -89.1092, 2),
    ('san marcos',         13.6589, -89.1831, 2),
    ('ciudad delgado',     13.7244, -89.1703, 2),
    ('cuscatancingo',      13.7300, -89.1830, 2),
    ('ayutuxtepeque',      13.7450, -89.2060, 2),
    ('san martin',         13.7370, -89.0550, 2),
    ('tonacatepeque',      13.7790, -89.1150, 2),
    ('santo tomas',        13.6430, -89.1330, 2),
    ('lourdes',            13.7210, -89.3640, 2),
    ('colon',              13.7210, -89.3640, 2),
    ('la libertad',        13.4880, -89.3220, 2),
    ('santa ana',          13.9942, -89.5597, 2),
    ('san miguel',         13.4833, -88.1833, 2),
    ('sonsonate',          13.7189, -89.7242, 2),
    ('san salvador',       13.6989, -89.1914, 2),
    -- Zonas genéricas que usa el sistema
    ('centro',             13.6989, -89.1914, 3),
    ('norte',              13.7600, -89.1950, 3),
    ('sur',                13.6600, -89.1850, 3),
    ('oriente',            13.7200, -89.1400, 3),
    ('poniente',           13.6800, -89.2700, 3),
    ('occidente',          13.6800, -89.2700, 3)
),
pedidos as (
  select e.id,
         translate(lower(coalesce(e.zona, '') || ' | ' || coalesce(e.direccion, '')),
                   'áéíóúüñ', 'aeiouun') as texto
  from public.entregas e
  where e.lat is null or e.lng is null
),
elegido as (
  -- Para cada pedido, el lugar más preciso (colonia > municipio > zona) que aparezca en su zona o dirección
  select distinct on (p.id) p.id, l.lat, l.lng
  from pedidos p
  join lugares l on p.texto like '%' || l.clave || '%'
  order by p.id, l.prioridad, length(l.clave) desc
)
update public.entregas e
set lat = round((el.lat + ((abs(hashtext(e.id::text)) % 81) - 40) * 0.0001)::numeric, 6),       -- ±~450 m
    lng = round((el.lng + ((abs(hashtext(e.id::text || 'x')) % 81) - 40) * 0.0001)::numeric, 6)
from elegido el
where e.id = el.id;

-- 4) Lo que sigue sin coordenadas (corrige su zona/dirección o escribe lat/lng a mano)
select id, cliente, direccion, zona
from public.entregas
where lat is null or lng is null
order by id;
