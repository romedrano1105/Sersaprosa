# Sersaprosa

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

Para conservar el acceso con código de empleado, aplica
[`backend/database/empleados_auth.sql`](backend/database/empleados_auth.sql).
Después, completa `empleados.email` con el email de una cuenta existente y
confirmada en Supabase Auth para cada empleado activo. La contraseña ingresada
se valida contra esa cuenta de Auth; no se consulta `empleados.password`.
El servicio usa la clave service role exclusivamente para resolver el código
de empleado a su email, y devuelve a la web el access token real de Supabase.

Configura `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` como secretos de
entorno del servicio FastAPI. No copies la service role key a `.env.example`,
al código del navegador ni al repositorio.

El navegador envía el login y las demás peticiones al mismo origen usando el
token que Supabase Auth devuelve. En Render, FastAPI sirve también las páginas;
en local, Node sirve los archivos y proxifica las llamadas API a FastAPI.

## Navegación y mapa

El menú compartido está en `public/assets/js/appNavigation.js` y sigue el
flujo de trabajo del día:

1. **Pedidos en curso**: pedidos que faltan por entregar; se eligen los que van en la ruta
   (`pedidosEnCurso.js`).
2. **Planificar rutas** (centro de control, `centroRutas.js`): rutas de hoy con su estado
   (borrador, sin asignar, asignada, en curso, completada); acciones editar, asignar,
   desasignar, invertir orden, optimizar y ver historial; tarjetas de asignación, alertas
   (riesgo, retrasos, notificaciones), resumen y completados; lista de pedidos con ETA y
   mapa. Una ruta nueva se **guarda** con `POST /rutas/guardar`; también existen
   `POST /rutas/listar`, `POST /rutas/actualizar` y `POST /disponibilidad/desasignar`
   (funciones SQL `guardar_ruta_operativa`, `actualizar_ruta_operativa` y
   `desasignar_ruta_operativa`; si Supabase aún no las tiene, el backend escribe con
   `SUPABASE_SERVICE_ROLE_KEY`, ver `backend/app/rutas_admin.py`).
3. **Empleados y Vehículos**: asigna conductor, guardias y vehículo a las rutas guardadas.
4. **Riesgo de rutas**: monto, tipo de carga y nivel de riesgo (solo coordinador).
5. **Monitoreo en Vivo**: eventos especiales, alertas de seguridad y notificaciones (con modo demostración).

Estructura del front: `public/assets/js/core/api.js` (sesión y llamadas al backend,
`window.Api`), un archivo por módulo (`pedidosEnCurso.js`, `routePlanner.js`,
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

Para habilitar la asignación y disponibilidad reales, aplica
[`backend/database/operaciones_rutas.sql`](backend/database/operaciones_rutas.sql)
en Supabase. El esquema usa empleados activos de `empleados` (con su fecha de
licencia), vehículos activos de `vehiculos` y rutas del día de
`rutas_planificadas`; ingresa los vehículos y las rutas planificadas antes de
usar la asignación. La API valida nuevamente en el servidor el rol, los
documentos vigentes y que conductor, vehículo y ruta no estén ya asignados.
En Supabase Auth asigna `app_metadata.role = coordinador_rutas` únicamente a
las cuentas autorizadas para consultar y asignar rutas.

Para mostrar y recorrer las entregas del día, ejecuta
[`backend/database/entregas_coordenadas.sql`](backend/database/entregas_coordenadas.sql)
en Supabase y guarda coordenadas verificadas en `entregas.lat` y
`entregas.lng`. Si faltan coordenadas, la página lo indica y no envía las
direcciones a un geocodificador externo. El número y disponibilidad de rutas
alternativas depende de las opciones devueltas por OSRM.

Las funciones `listar_disponibilidad_operativa` y `asignar_ruta_operativa`
validan el rol del usuario dentro de PostgreSQL y se ejecutan con el token
autenticado; la consulta de empleados devuelve solo los campos necesarios. No se
expone la clave `service_role` al navegador ni se concede acceso a `anon`.
Los mapas, las teselas y el cálculo de rutas dependen de servicios públicos
externos (OpenStreetMap y OSRM), que pueden limitar solicitudes o dejar de
responder. El repositorio no tiene una fuente conectada de CCTV o GPS de
vehículos; por eso el monitoreo muestra eventos/incidentes reales disponibles
en la API y no simula cámaras ni posiciones de unidades.

## Despliegue en Render

1. En Render configura el servicio web con directorio raíz del repositorio.
2. Usa `pip install -r requirements.txt` como comando de compilación.
3. Usa `uvicorn backend.app.main:app --host 0.0.0.0 --port $PORT` como comando
   de inicio.
4. Define en la sección **Environment** las variables `SUPABASE_URL`,
   `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`.
5. Aplica `backend/database/entregas_coordenadas.sql` en Supabase y completa
   coordenadas verificadas en las entregas que deban incluirse en el mapa.

No agregues secretos a Git ni al código del navegador. No se requiere
`service_role` para OSRM ni para el mapa; la usa el backend en el flujo actual
de login.

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
