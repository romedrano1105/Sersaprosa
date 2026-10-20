# Registro de decisiones de arquitectura (ADR)

Cada ADR documenta una decisión difícil de revertir, con su contexto y consecuencias. Formato: [plantilla](0000-plantilla.md). Estados: Propuesta · Aceptada · Reemplazada.

| Nº | Decisión | Estado |
|----|----------|--------|
| [0001](0001-front-vanilla-js-sin-framework.md) | Front en JavaScript puro, un módulo por pantalla | Aceptada |
| [0002](0002-fastapi-supabase-rls-y-funciones-sql.md) | Backend FastAPI + Supabase con RLS y funciones SQL `security definer` | Aceptada |
| [0003](0003-respaldo-service-role-para-rutas.md) | Respaldo de escritura con service role si faltan funciones SQL | Aceptada |
| [0004](0004-mapas-osm-y-osrm.md) | Mapa con OpenStreetMap y rutas con OSRM público | Aceptada |
| [0005](0005-centro-de-control-de-rutas.md) | «Planificar rutas» como centro de control de rutas | Aceptada |
| [0006](0006-despliegue-render-un-solo-servicio.md) | Despliegue en Render con FastAPI sirviendo el front | Aceptada |
