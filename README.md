# Sersaprosa

Aplicación web de rutas seguras con frontend estático y API en FastAPI.

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

La página principal obtiene destinos y eventos mediante `/entregas/listar` y
`/eventos/listar`. Las rutas reales se calculan en el navegador con el servicio
público OSRM; el backend no descarga mapas. Para mostrar y recorrer las
entregas del día, ejecuta
[`backend/database/entregas_coordenadas.sql`](backend/database/entregas_coordenadas.sql)
en Supabase y guarda coordenadas verificadas en `entregas.lat` y
`entregas.lng`. Si faltan coordenadas, la página lo indica y no envía las
direcciones a un geocodificador externo.

El acceso a las tablas continúa bajo RLS usando el token del usuario; no se
expone la clave `service_role` al navegador ni se concede acceso a `anon`.
OSRM es un servicio público externo y puede limitar solicitudes o dejar de
responder. La disponibilidad de rutas alternativas depende de las opciones
que encuentre para cada trayecto.

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
