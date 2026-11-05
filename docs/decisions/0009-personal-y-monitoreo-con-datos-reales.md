# ADR 0009: Personal real y Monitoreo en Vivo a partir de las asignaciones

- Estado: Aceptada
- Fecha: 2026-11-02

## Contexto
La pantalla de vehículos y empleados tenía datos fijos de un diseño en Figma y el Monitoreo en Vivo mostraba unidades y rutas inventadas. No había forma de registrar conductores ni guardias desde la aplicación, y el mapa no dejaba ver el recorrido completo de una unidad.

## Decisión
- **Personal:** el panel «Personal» (`gestionEmpleados.js`) agrega, edita y da de baja conductores y guardias con `POST /empleados/listar|guardar|estado`, que llaman a funciones `security definer` de `empleados_gestion.sql` con el token del coordinador (ADR 0002).
  - La baja es lógica (`activo = false`): no se borran registros con historial.
  - El código se genera en SQL (`CON-###`, `GUA-###`). Un conductor exige licencia.
  - No se cambia la categoría ni se da de baja a quien tiene asignación hoy.
- **Monitoreo:** las «Unidades en ruta» se arman con las asignaciones vigentes (`listar_disponibilidad_operativa`): conductor, custodios, vehículo, monto y riesgo reales. Al elegir una unidad se dibuja su ruta completa (origen → pedidos en orden → destino) por calles con OSRM, coloreada por incidente o por nivel de riesgo.
- Se borró la página `vehiculos_empleados.html` con sus datos fijos.

## Alternativas consideradas
- Mantener datos de ejemplo en el front: más rápido, pero confunde al operar.
- Borrado físico de empleados: rompería asignaciones e historial.

## Consecuencias
- Lo que se ve en Monitoreo coincide con lo asignado en Empleados y Vehículos.
- Hay que aplicar `empleados_gestion.sql` después de `rutas_operativas_seguras.sql`.
- Sin GPS real, las posiciones se estiman con el horario y se marcan como `MODO DEMOSTRACIÓN`; no sirven para operar. Integrar telemetría queda pendiente.
