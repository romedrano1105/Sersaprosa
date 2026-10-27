# ADR 0005: «Planificar rutas» como centro de control de rutas

- Estado: Aceptada
- Fecha: 2026-10-20

## Contexto
La pantalla mezclaba selector de pedidos, planificador y mapa sin orden claro. Se tomó como referencia un centro de mando de reparto (rutas con estado, acciones, tarjetas, lista con ETA y mapa).

## Decisión
`centroRutas.js` pinta cabecera (selector de rutas, estado, métricas, acciones), cuatro tarjetas (asignado a, alertas, resumen, completados) y la lista de pedidos con ETA; `dashboard.js` conserva mapa y cálculo. En borrador, los pedidos se eligen con casillas en la misma lista (`Pedidos.store`). El orden de visita se guarda por ruta en `sessionStorage`; «optimizar» usa vecino más cercano. El estado de la ruta se deriva de pedidos y asignación, no se almacena.

## Consecuencias
- Un flujo único: Pedidos → Planificar → Asignar → Monitoreo.
- El orden de visita no persiste entre dispositivos; guardarlo en base de datos queda como mejora.
