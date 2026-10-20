# ADR 0006: Despliegue en Render con FastAPI sirviendo el front

- Estado: Aceptada
- Fecha: 2026-10-20

## Contexto
Hace falta publicar API y páginas con poca operación y sin problemas de CORS.

## Decisión
Un solo servicio web en Render: `uvicorn backend.app.main:app --host 0.0.0.0 --port $PORT`, que sirve también `public/`. Variables `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` como secretos del servicio. En local, Node sirve estáticos y proxifica la API.

## Consecuencias
- Mismo origen, sin CORS y un único despliegue.
- Escalar front y API por separado exigiría revisar esta decisión.
