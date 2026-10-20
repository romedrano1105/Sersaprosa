# ADR 0003: Respaldo de escritura con service role si faltan funciones SQL

- Estado: Aceptada
- Fecha: 2026-10-20

## Contexto
Varias funciones de rutas fallaban en entornos donde no se había ejecutado el SQL (error `PGRST202` / `42883`), dejando botones sin respuesta.

## Decisión
Si Supabase indica que la función no existe, `rutas_router.py` y `disponibilidad_router.py` ejecutan `rutas_admin.py` con el cliente de servicio, **después** de validar rol coordinador. Replica las comprobaciones (pedidos existentes y libres, ruta de hoy, asignación presente) y revierte lo escrito si un paso falla. El camino con funciones SQL sigue siendo el principal.

## Alternativas consideradas
- Devolver solo el error y exigir el SQL: seguro, pero deja la app inutilizable.
- Usar siempre service role: descartado por ADR 0002.

## Consecuencias
- La app funciona sin el SQL; el respaldo no es atómico (compensación manual).
- Duplica reglas en Python y SQL: mantenerlas alineadas. Depende de `SUPABASE_SERVICE_ROLE_KEY` en el backend. Los guardias solo se desasignan, no se asignan, por este camino.
