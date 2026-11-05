# Sersaprosa

Copyright (c) 2026 SERSAPROSA. Este proyecto se distribuye bajo la licencia [ISC](LICENSE). Los componentes y servicios de terceros conservan sus propios titulares de copyright y licencias; consulta [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

SERSAPROSA es una **aplicación web de logística y seguridad de rutas** para El Salvador, con cinco secciones: tracking de rutas, empleados y vehículos, riesgo de rutas, monitoreo en vivo y dashboard de métricas. Combina un frontend web con una API FastAPI.

## Estructura

```text
public/
  pages/              Página principal de la aplicación
  assets/
    css/              Hojas de estilo
    js/               Scripts del navegador
backend/
  app/                API FastAPI, acceso a Supabase y lógica
  agente_rutas/       Agente de rutas seguras
  database/           Scripts SQL
  tests/              Pruebas Python
tests/js/             Pruebas del frontend
server.js             Servidor estático Node.js
```

## Secciones de la aplicación

- **Tracking de rutas:** rutas del día con su estado, nuevo viaje, edición de viaje y de orden de pedidos, aceptación o rechazo de propuestas y reportes de viaje.
- **Empleados y vehículos:** alta, edición y baja lógica de conductores y guardias, y asignación de conductor, guardias y vehículo a cada ruta.
- **Riesgo de rutas:** nivel de riesgo según el monto y la sensibilidad de la carga (solo coordinador).
- **Monitoreo en vivo:** unidades en ruta sobre el mapa, conducción en vivo, alertas e incidentes, notificaciones y eventos especiales. Sin telemetría o sesión se muestra `MODO DEMOSTRACIÓN` con posiciones estimadas; no las uses para operar.
- **Dashboard de métricas:** porcentaje de rutas generadas por IA, eventos mitigados y tiempo promedio real de entrega (rango máximo de 365 días).

El mapa usa Leaflet con OpenStreetMap y recorridos de OSRM. El agente evalúa las rutas candidatas según zonas de riesgo, incidentes, eventos y tráfico; si una fuente falla, calcula igual y lo indica en las advertencias.

## Configuración de Supabase

Define estas variables de entorno en el proceso del backend (por ejemplo, en la sección **Environment** de Render). En local, cópialas de [`.env.example`](.env.example) a un archivo `.env` (requiere `pip install python-dotenv`). **Nunca subas el `.env` ni las claves a Git ni al código del navegador.**

- `SUPABASE_URL`: URL del proyecto (`https://<id>.supabase.co`).
- `SUPABASE_ANON_KEY`: clave anon/public.
- `SUPABASE_SERVICE_ROLE_KEY`: clave de servicio, solo en el backend; nunca la publiques en el navegador ni en el repositorio.
- `OPENROUTESERVICE_API_KEY`: opcional; geocodificación y autocompletado. Sin ella se usan Nominatim y OSRM públicos.
- `GOOGLE_ROUTES_API_KEY`: opcional; habilita la capa de tráfico del mapa. Requiere Routes API y facturación en Google Cloud; Google puede cobrar cada consulta. La capa es visual y no cambia el riesgo ni la ruta elegida.
- `OPENAI_API_KEY` y `AGENTE_MODELO`: opcionales; activan OpenAI en la evaluación de rutas seguras (modelo por defecto `gpt-6-luna`).
- `ENTREGAS_HORA_INICIO` y `ENTREGAS_HORA_FIN`: opcionales; horario de entregas (por defecto 06:00–20:00).
- `API_ORIGIN`: opcional, solo en local; destino de la API para `server.js` (por defecto `http://127.0.0.1:8000`).

Para conservar el acceso con código de empleado, aplica [`backend/database/empleados_auth.sql`](backend/database/empleados_auth.sql). Después, completa `empleados.email` con el email de una cuenta existente y confirmada en Supabase Auth para cada empleado activo. La contraseña ingresada se valida contra Supabase Auth; no se consulta `empleados.password`. El servicio usa la clave service role solo para resolver el código de empleado a su email; nunca la expone al navegador.

Las rutas protegidas validan localmente los access tokens de Supabase contra el JWKS del proyecto (ES256), con una caché de claves de cinco minutos. Un token inválido o vencido responde `401`; si no se puede consultar el JWKS, responde `503`. Las escrituras de rutas, asignaciones, viajes, empleados y propuestas usan funciones SQL `SECURITY DEFINER` llamadas con el token del coordinador, y cada una vuelve a validar el rol en PostgreSQL. Los clientes con token de usuario se crean en cada petición para no compartir encabezados entre usuarios.

Para comprobar la conexión abre **`/salud`** (variables configuradas y tablas que responden, sin mostrar claves) y **`/version`** (rama y commit desplegados).

## Migraciones

Las migraciones **no se ejecutan desde la aplicación**: copia cada archivo en **Supabase → SQL Editor → New query** y pulsa **Run**. Pruébalas primero en un proyecto de staging. Cada script corre como una sola transacción y la mayoría se puede ejecutar más de una vez.

Ejecútalas en este orden:

1. [`empleados.sql`](backend/database/empleados.sql)
2. [`empleados_auth.sql`](backend/database/empleados_auth.sql)
3. [`operaciones_rutas.sql`](backend/database/operaciones_rutas.sql)
4. [`entregas.sql`](backend/database/entregas.sql)
5. [`entregas_coordenadas.sql`](backend/database/entregas_coordenadas.sql)
6. [`viajes.sql`](backend/database/viajes.sql)
7. [`viajes_ruta.sql`](backend/database/viajes_ruta.sql)
8. [`riesgo_rutas.sql`](backend/database/riesgo_rutas.sql)
9. [`metricas_operativas.sql`](backend/database/metricas_operativas.sql) (requiere que ya exista `eventos_especiales`)
10. [`rechazos_ruta.sql`](backend/database/rechazos_ruta.sql)
11. [`edicion_orden_rutas.sql`](backend/database/edicion_orden_rutas.sql)
12. [`rutas_operativas_seguras.sql`](backend/database/rutas_operativas_seguras.sql)
13. [`empleados_gestion.sql`](backend/database/empleados_gestion.sql)
14. [`editar_viaje.sql`](backend/database/editar_viaje.sql)
15. [`alertas_seguridad.sql`](backend/database/alertas_seguridad.sql)
16. [`incidentes_viaje.sql`](backend/database/incidentes_viaje.sql)
17. [`historial_incidentes.sql`](backend/database/historial_incidentes.sql)
18. [`notificaciones.sql`](backend/database/notificaciones.sql)
19. [`noticias_riesgo.sql`](backend/database/noticias_riesgo.sql)

Antes de `rutas_operativas_seguras.sql`, revisa sus avisos de rutas duplicadas por fecha y nombre; si hay duplicados, resuélvelos a mano sin borrar ni combinar registros automáticamente. No vuelvas a aplicar `operaciones_rutas.sql` después de ese script.

Aplica [`rol_coordinador_rutas.sql`](backend/database/rol_coordinador_rutas.sql) por separado, después de cambiar el correo de ejemplo por el de la cuenta autorizada. Asigna `app_metadata.role = coordinador_rutas` únicamente a cuentas autorizadas; el usuario debe volver a iniciar sesión después del cambio.

Los datos de prueba ([`empleados_demo.sql`](backend/database/empleados_demo.sql) y [`coordenadas_pedidos_demo.sql`](backend/database/coordenadas_pedidos_demo.sql)) son opcionales. Para operar en producción, reemplázalos por tu personal y por coordenadas verificadas.

## Despliegue en Render

1. Crea un servicio web con el directorio raíz del repositorio.
2. **Build command:** `pip install -r requirements.txt`
3. **Start command:** `uvicorn backend.app.main:app --host 0.0.0.0 --port $PORT`
4. Define las variables de entorno y aplica las migraciones en Supabase.
5. Después de cada despliegue, recarga la página con **Ctrl + F5**.

En Render, FastAPI sirve también las páginas y los archivos estáticos.

## Ejecutar localmente

Requisitos: Python 3.12 y Node.js 18 o superior.

```bash
pip install -r requirements.txt
npm install
npm run start:api   # terminal 1: API en http://127.0.0.1:8000
npm start           # terminal 2: web en http://localhost:3000
```

## Pruebas

```bash
python -m unittest discover -s backend/tests -v   # backend
npm test                                          # lógica del frontend
```

El CI de GitHub Actions revisa la sintaxis de `server.js` y de los scripts del frontend, compila el backend y corre ambas suites en cada pull request.

## Servicios externos y licencias

Los mapas, la geocodificación y el cálculo de rutas dependen de servicios externos (OpenStreetMap, OSRM, Nominatim u OpenRouteService y, si se configuran, Google Routes y OpenAI) que pueden limitar solicitudes o dejar de responder. Si fallan, la evaluación continúa sin esos datos y lo indica en las advertencias.

Las dependencias y sus licencias están en [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). Los mapas muestran la atribución requerida a OpenStreetMap, cuyos datos están disponibles bajo la licencia ODbL.
