# Sersaprosa

Copyright (c) 2026 SERSAPROSA. Este proyecto se distribuye bajo la licencia
[ISC](LICENSE). Los componentes y servicios de terceros conservan sus propios
titulares de copyright y licencias; consulta
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

SERSAPROSA es una **aplicación web** de operaciones con tres secciones:
asignación y planificación de rutas, monitoreo de eventos y alertas, y
disponibilidad de empleados y vehículos. Combina un frontend web con una API
FastAPI.

## Estructura

```text
public/
  pages/                 Página principal de la aplicación
  assets/
    css/                 Hojas de estilo
    js/                  Scripts del navegador
backend/
  app/                   API FastAPI, acceso a Supabase y lógica
  database/               Scripts SQL
  tests/                  Pruebas Python
server.js                 Servidor estático Node.js
```

## Configuración de Supabase

Define estas variables de entorno en el proceso del backend (por ejemplo, en
la sección **Environment** de Render). El proyecto no carga automáticamente
archivos `.env`.

- `SUPABASE_URL`: URL del proyecto.
- `SUPABASE_ANON_KEY`: clave anon/public del proyecto.
- `SUPABASE_SERVICE_ROLE_KEY`: clave de servicio, solo en el backend; nunca la
  publiques en el navegador ni en el repositorio.
- `GOOGLE_ROUTES_API_KEY`: opcional; habilita los tramos de tráfico en los mapas
  del agente y las propuestas de ruta. Guárdala como variable de entorno del
  backend, no en JavaScript. Requiere Routes API y facturación habilitadas en
  Google Cloud; Google puede cobrar cada consulta.

Para conservar el acceso con código de empleado, aplica
[`backend/database/empleados_auth.sql`](backend/database/empleados_auth.sql).
Después, completa `empleados.email` con el email de una cuenta existente y
confirmada en Supabase Auth para cada empleado activo. La contraseña ingresada
se valida contra esa cuenta de Auth; no se consulta `empleados.password`.
El servicio usa la clave service role en el backend para resolver el código de
empleado a su email, devolver el access token real de Supabase y, cuando se
requiere, realizar operaciones administrativas de rutas, viajes y datos de
seguridad. Nunca expone esa clave al navegador.

Configura `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` como secretos de
entorno del servicio FastAPI. No copies la service role key a `.env.example`,
al código del navegador ni al repositorio.

Las rutas protegidas validan localmente los access tokens de Supabase contra
el JWKS del proyecto (ES256), con una caché de claves de cinco minutos. Si no
se puede consultar JWKS y no hay una clave válida en caché, la API responde
`503`; un token inválido o expirado responde `401`. Como el rol forma parte de
los claims del token, el usuario debe iniciar sesión de nuevo después de
cambiar `app_metadata.role`. El cliente de service role se reutiliza solo en
el backend; los clientes con token de usuario se crean por petición para no
compartir encabezados de autorización entre usuarios.

### Migraciones del flujo de rutas

Prueba primero en un proyecto de staging. Estos archivos son SQL independientes:
ejecuta su contenido, en este orden, desde el SQL Editor de Supabase:

1. [`empleados.sql`](backend/database/empleados.sql)
2. [`operaciones_rutas.sql`](backend/database/operaciones_rutas.sql)
3. [`entregas.sql`](backend/database/entregas.sql)
4. [`viajes_ruta.sql`](backend/database/viajes_ruta.sql)
5. [`metricas_operativas.sql`](backend/database/metricas_operativas.sql) (requiere `eventos_especiales`)
6. [`viajes.sql`](backend/database/viajes.sql)
7. [`rechazos_ruta.sql`](backend/database/rechazos_ruta.sql)
8. [`edicion_orden_rutas.sql`](backend/database/edicion_orden_rutas.sql)
9. [`rutas_operativas_seguras.sql`](backend/database/rutas_operativas_seguras.sql)

Antes de ejecutar `rutas_operativas_seguras.sql`, revisa sus avisos de rutas
duplicadas por fecha y nombre. Si detecta duplicados, detente y resuélvelos
manualmente; no borres ni combines registros automáticamente. Aplica
[`rol_coordinador_rutas.sql`](backend/database/rol_coordinador_rutas.sql)
por separado, sustituyendo el correo de marcador solo por el de la cuenta
autorizada que hayas confirmado. No ejecutes estas migraciones en producción
sin probarlas y aprobar su resultado en staging.

El navegador envía el login y las demás peticiones al mismo origen usando el
token que Supabase Auth devuelve. En Render, FastAPI sirve también las páginas;
en local, Node sirve los archivos y proxifica las llamadas API a FastAPI.
`POST /entregas/listar` filtra en Supabase por el día solicitado (hoy si se
omite) y recorre páginas de hasta 1000 filas, conservando el contrato actual
del navegador.

## Navegación y mapa

El menú compartido está en `public/assets/js/appNavigation.js` y sigue el
flujo de trabajo del día:

1. **Tracking de rutas** (centro de control, `centroRutas.js`; antes «Planificar rutas»): rutas de hoy con su estado
   (borrador, sin asignar, asignada, en curso, completada); acciones editar, asignar,
   desasignar (o «Liberar ruta» si conserva un conductor sin asignación vigente), invertir orden, optimizar y ver historial; tarjetas de asignación, alertas
   (riesgo, retrasos, notificaciones), resumen y completados; lista de pedidos con ETA y
   mapa. Una ruta nueva se **guarda** con `POST /rutas/guardar`; también existen
   `POST /rutas/listar`, `POST /rutas/actualizar` y `POST /disponibilidad/desasignar`
   (funciones SQL `guardar_ruta_operativa`, `actualizar_ruta_operativa` y
   `desasignar_ruta_operativa`; requieren la migración
   [`backend/database/rutas_operativas_seguras.sql`](backend/database/rutas_operativas_seguras.sql)
   y no hacen escrituras de respaldo con la clave de servicio).
   **«Editar orden»** permite mover, quitar y agregar pedidos pendientes desde esa misma lista
   y previsualizar el cálculo en el mapa. Para habilitarlo, aplica
   [`backend/database/edicion_orden_rutas.sql`](backend/database/edicion_orden_rutas.sql)
   en Supabase después de `operaciones_rutas.sql` y `entregas_coordenadas.sql`.
   El guardado es transaccional, controla versiones para evitar sobrescribir
   cambios simultáneos y registra el antes/después, usuario y fecha en el historial.
   El botón **«+»** abre **Nuevo viaje** (`viajeRutas.js`): origen, destino, horario, tipo de carga y monto.
   **GENERAR RUTA** (`POST /viajes/generar`) valida (si falta algo, dice qué; fuera del horario de
   entregas —por defecto 06:00–20:00, variables `ENTREGAS_HORA_INICIO` y `ENTREGAS_HORA_FIN`— no
   genera), ubica las direcciones, calcula la ruta óptima con el agente de IA y crea la ruta del día
   junto con el vínculo atómico de pedidos por `ruta_id`.
   El viaje se puede corregir con **Editar viaje** (`POST /viajes/actualizar`) solo mientras la ruta no
   haya salido, es decir, sin conductor asignado. El formulario sugiere lugares que empiezan con lo escrito (lugares ya usados y del mapa; con `OPENROUTESERVICE_API_KEY` usa su autocompletado). Requiere aplicar
   [`backend/database/viajes_ruta.sql`](backend/database/viajes_ruta.sql) en Supabase.
   **«Revisar propuesta»** permite aceptar una ruta o rechazarla con motivo; si hay una alternativa segura, se presenta para revisión. Para guardar el estado y el historial de rechazos, aplica
   [`backend/database/rechazos_ruta.sql`](backend/database/rechazos_ruta.sql) después de crear `rutas_planificadas`.
   Los pedidos de la ruta en borrador se eligen con las casillas de esa misma lista (`pedidosEnCurso.js`
   guarda la selección; ya no hay pantalla «Pedidos en curso»). Si un pedido no tiene coordenadas, el
   coordinador puede pulsar **«Ubicar pedidos por su dirección»** (`POST /entregas/ubicar`).
2. **Empleados y Vehículos**: panel **Personal** (`gestionEmpleados.js`) para agregar, editar y dar de baja
   conductores y guardias reales (`POST /empleados/listar|guardar|estado`, funciones de
   [`empleados_gestion.sql`](backend/database/empleados_gestion.sql); baja lógica, sin clave de servicio) y
   asignación de conductor, guardias y vehículo a las rutas guardadas. Las rutas
   rechazadas no se ofrecen para asignar; las de la IA se asignan después de aceptar su propuesta y las
   armadas a mano nacen aceptadas (`rutas_operativas_seguras.sql`). Una ruta con conductor guardado sin
   asignación vigente se libera con «Liberar ruta» (`desasignar_ruta_operativa`).
3. **Riesgo de rutas**: monto, tipo de carga y nivel de riesgo (solo coordinador).
4. **Monitoreo en Vivo**: el mapa **Unidades en ruta** (`mapaMonitoreo.js`) muestra cada ruta con asignación
   vigente: conductor y custodios reales, vehículo, monto y riesgo. Al elegir una unidad dibuja la ruta completa
   (origen → pedidos → destino, por calles con OSRM) con el color del incidente o del nivel de riesgo y encuadra
   la ruta con el vehículo. Conducción en vivo usa esas mismas unidades.
   Además: notificaciones, eventos especiales y **Alertas e incidentes**, un solo panel
   (`alertasIncidentes.js`) con los incidentes de viajes en curso (tiempo real) y las alertas de viajes
   finalizados, con filtros por estado, severidad y origen.
5. **Dashboard de métricas**: porcentaje de rutas IA frente a rutas manuales, eventos explícitamente mitigados y tiempo promedio real entre inicio y finalización de entregas.

El panel de métricas está disponible para usuarios autenticados. Para registrar
una mitigación, cambiar el estado de un evento o corregir una discrepancia se
requiere `app_metadata.role` igual a `coordinador_rutas`, `supervisor` o
`administrador`; el backend vuelve a validar el rol y audita cada cambio.
Eventos solo cuentan como evitados después de marcarlos explícitamente como
mitigados antes del despacho; los eventos antiguos quedan sin confirmar.
El porcentaje de rutas excluye los registros anteriores sin método conocido.
El tiempo promedio usa entregas cuyo estado pasó de `en_proceso` a `completada`
después de instalar la migración; no inventa tiempos para registros históricos.

Antes de usar el panel, ejecuta
[`backend/database/metricas_operativas.sql`](backend/database/metricas_operativas.sql)
en Supabase, después de crear las tablas `rutas_planificadas`, `entregas` y
`eventos_especiales`. El rango de consulta incluye como máximo 365 días.

Estructura del front: `public/assets/js/core/api.js` (sesión y llamadas al backend,
`window.Api`), un archivo por módulo (`centroRutas.js`, `alertasIncidentes.js`,
`VerificarConduJS.js`, …) y `dashboard.js` como arranque que cambia de pantalla.
`POST /rutas/guardar` usa la función SQL `guardar_ruta_operativa`. Las pruebas de
lógica del front corren con `npm test` (`tests/js`) y las del backend con `pytest`.

La página principal consulta destinos y eventos mediante `/entregas/listar` y
`/eventos/listar`. El mapa usa teselas de OpenStreetMap y los recorridos se
calculan con OSRM sobre la red vial. Los destinos y eventos se vuelven a
consultar cada dos minutos y el recorrido se recalcula cuando cambian sus
coordenadas, el origen o los eventos que afectan al riesgo. **Actualizar ahora**
permite forzar la consulta. El GPS del navegador es opcional, solo se solicita
tras pulsar el botón de ubicación y se usa como origen para el cálculo de ruta.
Si se configura `GOOGLE_ROUTES_API_KEY`, el backend añade al mapa los tramos
NORMAL, SLOW y TRAFFIC_JAM devueltos por Google Routes, tanto en la evaluación
como en las propuestas. Esta capa es visual: no cambia la puntuación de riesgo
ni la ruta elegida por el agente.

Para habilitar el ciclo de creación, aceptación y asignación, aplica las
migraciones SQL en Supabase **en este orden** (primero en staging):

1. [`backend/database/empleados.sql`](backend/database/empleados.sql)
2. [`backend/database/operaciones_rutas.sql`](backend/database/operaciones_rutas.sql)
3. [`backend/database/entregas.sql`](backend/database/entregas.sql)
4. [`backend/database/viajes.sql`](backend/database/viajes.sql)
5. [`backend/database/viajes_ruta.sql`](backend/database/viajes_ruta.sql)
6. [`backend/database/riesgo_rutas.sql`](backend/database/riesgo_rutas.sql)
7. [`backend/database/metricas_operativas.sql`](backend/database/metricas_operativas.sql)
   (requiere que ya exista `eventos_especiales`)
8. [`backend/database/rechazos_ruta.sql`](backend/database/rechazos_ruta.sql)
9. [`backend/database/edicion_orden_rutas.sql`](backend/database/edicion_orden_rutas.sql)
10. [`backend/database/rutas_operativas_seguras.sql`](backend/database/rutas_operativas_seguras.sql)
11. [`backend/database/empleados_gestion.sql`](backend/database/empleados_gestion.sql)

No ejecutes `empleados_gestion.sql` antes de `rutas_operativas_seguras.sql`:
sus funciones consultan las tablas de asignaciones que crea esa migración.
`rutas_operativas_seguras.sql` instala las RPC que usa FastAPI para guardar
rutas y asignaciones, incluyendo `p_guardias`, y la aceptación transaccional de
propuestas. No vuelvas a aplicar `operaciones_rutas.sql` después de esa
migración. Entra a Supabase SQL Editor y ejecuta el contenido de cada archivo
en el orden indicado; las migraciones no se ejecutan desde la aplicación.

El esquema usa empleados activos de `empleados` (con licencia vigente),
vehículos activos de `vehiculos` y rutas de `rutas_planificadas`; ingresa
vehículos válidos antes de asignar. La API y las RPC validan el rol, los
documentos y que conductor, vehículo y ruta no estén asignados. En Supabase Auth
asigna `app_metadata.role = coordinador_rutas` únicamente a cuentas autorizadas.

Para mostrar y recorrer las entregas del día, ejecuta
[`backend/database/entregas_coordenadas.sql`](backend/database/entregas_coordenadas.sql)
en Supabase y guarda coordenadas verificadas en `entregas.lat` y
`entregas.lng`. El backend normaliza las coordenadas (texto, invertidas, 0,0 o fuera de El Salvador
cuentan como faltantes) para que la página nunca reciba `null` a medias. Si faltan, la página lo indica
y el coordinador puede usar «Ubicar pedidos por su dirección»: el servidor geocodifica la dirección
(OpenRouteService o Nominatim), guarda `lat`/`lng` con la función SQL `guardar_coordenadas_entrega`
(incluida en `entregas_coordenadas.sql`, con el token del coordinador) y nunca inventa coordenadas. Para datos demo,
[`backend/database/coordenadas_pedidos_demo.sql`](backend/database/coordenadas_pedidos_demo.sql)
asigna el centro aproximado del municipio o colonia a los pedidos sin coordenadas.

Para comprobar la conexión con Supabase abre `/salud`: indica qué variables están configuradas,
si la URL es válida y qué tablas responden, sin mostrar claves ni datos. En local las variables
se pueden poner en un archivo `.env` (ver `.env.example`; requiere `pip install python-dotenv`).

Si una fuente de riesgo (incidentes, eventos, zonas) no responde, el agente de rutas calcula igual
y lo indica en las advertencias; si el motor de rutas falla, el mensaje dice si fue OSRM, falta de
ruta por calles o coordenadas no válidas. El número y disponibilidad de rutas alternativas depende
de las opciones devueltas por OSRM.

Las funciones `listar_disponibilidad_operativa` y `asignar_ruta_operativa`
validan el rol del usuario dentro de PostgreSQL y se ejecutan con el token
autenticado; la consulta de empleados devuelve solo los campos necesarios. No se
expone la clave `service_role` al navegador ni se concede acceso a `anon`.
Los mapas, las teselas y el cálculo de rutas dependen de servicios externos
(OpenStreetMap, OSRM y, si se configura, Google Routes), que pueden limitar
solicitudes o dejar de responder. Los fallos de las fuentes de incidentes y
zonas se registran como advertencias y la evaluación sigue sin esos datos; los
fallos de tráfico dejan la ruta visible sin su capa de tráfico. El monitoreo usa
GPS si la API lo proporciona; si no hay telemetría, rutas asignadas trazables o
conexión con los servicios, activa automáticamente `MODO DEMOSTRACIÓN` con
posiciones simuladas claramente identificadas. No uses esos datos para operar.

## Despliegue en Render

1. En Render configura el servicio web con directorio raíz del repositorio.
2. Usa `pip install -r requirements.txt` como comando de compilación.
3. Usa `uvicorn backend.app.main:app --host 0.0.0.0 --port $PORT` como comando
   de inicio.
4. Define en la sección **Environment** las variables `SUPABASE_URL`,
   `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`. Para mostrar tráfico
   agrega `GOOGLE_ROUTES_API_KEY` (Routes API y facturación habilitadas en
   Google Cloud). Para activar la
   orquestación con OpenAI en la evaluación de rutas seguras, agrega también
   `OPENAI_API_KEY`; opcionalmente define `AGENTE_MODELO` (por defecto
   `gpt-6-luna`). El uso de la API de OpenAI se factura por separado de una
   suscripción de ChatGPT.
5. Aplica `backend/database/entregas_coordenadas.sql` en Supabase y completa
   coordenadas verificadas en las entregas que deban incluirse en el mapa.

No agregues secretos a Git ni al código del navegador. No se requiere
`service_role` para OSRM ni para las teselas del mapa; el backend la usa solo
en los flujos administrativos descritos arriba.

## Ejecutar localmente

Configura las variables de Supabase descritas arriba e instala dependencias
Python con `pip install -r requirements.txt`. Inicia la API:

```text
npm run start:api
```

En otra terminal, inicia el servidor web:

```text
npm start
```

Abre `http://localhost:3000`. El servidor de Node sirve la página principal y
envía las solicitudes de la API a `http://127.0.0.1:8000`; cambia ese destino
con la variable `API_ORIGIN` si ejecutas FastAPI en otro host o puerto. En
despliegues donde FastAPI sirve también los archivos estáticos, configura el
servicio como se indica en la sección de Render.

## Pruebas

```text
pytest
```

## Licencias y atribuciones de terceros

Las dependencias, bibliotecas y servicios externos, junto con sus licencias y
fuentes oficiales de copyright, se documentan en
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). Los mapas muestran la
atribución requerida a OpenStreetMap; sus datos están disponibles bajo ODbL.
