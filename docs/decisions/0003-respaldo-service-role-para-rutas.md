# ADR 0003: Respaldo de escritura con service role si faltan funciones SQL

- Estado: Reemplazada
- Fecha: 2026-10-20

> Esta decisión quedó reemplazada por la migración atómica de rutas. Si falta
> una función SQL, la API responde `503`; no escribe con la clave `service_role`.

## Contexto
Varias funciones de rutas fallaban en entornos donde no se había ejecutado el SQL (error `PGRST202` / `42883`), dejando botones sin respuesta.

## Decisión original
Si Supabase indica que la función no existe, `rutas_router.py` y `disponibilidad_router.py` ejecutaban `rutas_admin.py` con el cliente de servicio, **después** de validar rol coordinador. El respaldo replicaba las comprobaciones de pedidos y asignaciones, pero no era atómico.

## Alternativas consideradas
- Devolver solo el error y exigir el SQL: seguro, pero deja la app inutilizable.
- Usar siempre service role: descartado por ADR 0002.

## Consecuencias de la decisión original
- Permitía funcionar sin el SQL, pero no era atómico.
- Duplicaba reglas en Python y SQL y dependía de `SUPABASE_SERVICE_ROLE_KEY`.
