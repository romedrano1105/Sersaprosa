# Sersaprosa

SERSAPROSA es una **aplicación web** de operaciones para planificar recorridos
seguros, consultar entregas, revisar eventos y gestionar la disponibilidad de
personal y vehículos. Combina un frontend web con una API FastAPI.

## Estructura

```text
public/
  pages/                 Páginas HTML
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
- `OPENROUTESERVICE_API_KEY`: clave de OpenRouteService, solo en el backend.
  Si no está configurada o el servicio no responde, la API intenta usar OSRM.

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

El login envía las credenciales a `/login` en el mismo servicio FastAPI que
sirve las páginas. Las demás peticiones usan ese mismo origen y el token que
Supabase Auth devuelve al iniciar sesión.

## Navegación y mapa

El menú compartido está en `public/assets/js/appNavigation.js`; en teléfonos
se abre con el botón **Menú**. Alertas de seguridad solo aparece para el rol
`coordinador_rutas`.

La navegación sigue el flujo operativo de planificación de rutas, monitoreo de
eventos, entregas del día y disponibilidad de empleados y vehículos. La página
principal consulta destinos y eventos mediante `/entregas/listar` y
`/eventos/listar`. El endpoint autenticado `/rutas/calcular` solicita rutas a
OpenRouteService y usa OSRM como respaldo; el navegador nunca recibe la clave.
Antes de calcular, el backend carga de Supabase los eventos especiales vigentes
y las alertas altas/medias de los últimos 90 días usando su clave service role.
Las zonas con coordenadas se envían a OpenRouteService como áreas a evitar. Si
OSRM no encuentra una alternativa fuera de ellas, la API rechaza la ruta en vez
de mostrar una ruta insegura. Eventos sin coordenadas se notifican en el panel,
pero no se pueden excluir espacialmente. La caché del backend conserva por seis
horas las rutas válidas para las mismas coordenadas y zonas de riesgo; es local
al proceso de la API.

Las entregas y eventos se vuelven a consultar cada dos minutos y el recorrido
se recalcula cuando cambian sus coordenadas, el origen o los eventos que
afectan al riesgo. **Actualizar ahora** permite forzar la consulta. La ubicación
del navegador es opcional: **Iniciar seguimiento en vivo** solicita permiso
explícito, muestra la posición e inicia el recálculo si el vehículo se desvía
más de 60 metros de la ruta. El panel muestra las indicaciones paso a paso del
proveedor de rutas seleccionado.

Para mostrar y recorrer las entregas del día, ejecuta
[`backend/database/entregas_coordenadas.sql`](backend/database/entregas_coordenadas.sql)
en Supabase y guarda coordenadas verificadas en `entregas.lat` y
`entregas.lng`. Si faltan coordenadas, la página lo indica y no envía las
direcciones a un geocodificador externo. El número y disponibilidad de rutas
alternativas depende de las opciones devueltas por OpenRouteService o, como respaldo, OSRM.

El acceso a las tablas continúa bajo RLS usando el token del usuario; no se
expone la clave `service_role` al navegador ni se concede acceso a `anon`.
Los mapas, las teselas y el cálculo de rutas dependen de servicios públicos
externos (OpenStreetMap, CARTO y OSRM), que pueden limitar solicitudes o dejar
de responder. El repositorio no tiene una fuente conectada de CCTV o GPS de
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

No agregues secretos a Git ni al código del navegador. La clave de
OpenRouteService debe permanecer en el entorno del backend.

## Ejecutar

Instala dependencias Python con `pip install -r requirements.txt` y ejecuta la
API desde la raíz:

```text
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
```

El servidor estático se ejecuta con `npm start`. `/` y `/PaginaPrincipal.html`
abren la página principal; las páginas secundarias conservan sus URLs actuales.

## Pruebas

```text
pytest
```
