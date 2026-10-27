# ADR 0008: «Nuevo viaje» y GENERAR RUTA guardan el viaje en la ruta del día

- Estado: Aceptada
- Fecha: 2026-10-23

## Contexto
Historia de usuario: el administrador de rutas ingresa origen, destino, horario y tipo de carga para ver la ruta óptima de la IA, con validaciones y edición antes de que la ruta salga.

## Decisión
- El viaje se guarda en `rutas_planificadas` (columnas nuevas en `viajes_ruta.sql`; monto, tipo de carga y nivel de riesgo ya existían por `riesgo_rutas.sql`). No hay tabla nueva: la ruta del día y su viaje son lo mismo.
- `POST /viajes/generar` valida primero (campos faltantes y horario permitido), luego ubica direcciones y evalúa con el agente (ADR 0007) **sin escribir nada**, y solo después guarda; si un paso posterior falla, deshace. Así nunca queda una ruta a medias.
- El nivel de riesgo se registra con `especificar_riesgo_ruta` (token del usuario, con su auditoría).
- «Edición antes de salir» = sin conductor ni asignación. Solo el coordinador de rutas crea y edita; los demás roles no ven los botones y el servidor responde 403.
- El horario de entregas es configurable (`ENTREGAS_HORA_INICIO`/`FIN`, por defecto 06:00–20:00) y debe confirmarse con operaciones.

## Consecuencias
- Un solo concepto (ruta) y sin migrar datos; las rutas viejas siguen funcionando.
- Las escrituras usan la clave de servicio tras validar rol (como en ADR 0003); no son atómicas, se compensan.
- Cambiar origen/destino no renombra la ruta, para no romper el enlace con los pedidos (que se hace por nombre).
