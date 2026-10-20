# ADR 0002: Backend FastAPI + Supabase con RLS y funciones SQL `security definer`

- Estado: Aceptada
- Fecha: 2026-10-20

## Contexto
Las operaciones (asignar, guardar rutas) deben ser atómicas, validar rol y documentos vigentes, y no exponer la clave `service_role`.

## Decisión
FastAPI valida el token de Supabase Auth y exige `app_metadata.role = coordinador_rutas`. Las escrituras críticas se hacen con funciones SQL (`asignar_ruta_operativa`, `guardar_ruta_operativa`, `actualizar_ruta_operativa`, `desasignar_ruta_operativa`) que revalidan el rol dentro de PostgreSQL y se ejecutan con el token del usuario. RLS activa en las tablas. El navegador nunca recibe la clave de servicio.

## Alternativas consideradas
- Escribir tablas directamente desde FastAPI con service role: más simple, pero salta RLS y pierde atomicidad (ver ADR 0003 para el único uso aceptado).
- Llamar a Supabase desde el navegador: expone reglas de negocio.

## Consecuencias
- Reglas en un solo lugar y atómicas.
- Cada cambio exige aplicar SQL en Supabase además de desplegar código.
