# ADR 0004: Mapa con OpenStreetMap y rutas con OSRM público

- Estado: Aceptada
- Fecha: 2026-10-20

## Contexto
Las teselas de CARTO mostraban «API KEY REQUIRED» en producción. No hay proveedor de mapas de pago contratado.

## Decisión
Leaflet con teselas de OpenStreetMap; rutas por calles con OSRM (`router.project-osrm.org`) llamado desde el navegador; geocodificación en el backend (`POST /rutas/geocodificar`). El modo oscuro es un filtro CSS sobre las teselas. Las direcciones solo se envían a un geocodificador al pedirlo el usuario.

## Alternativas consideradas
- Mapbox/Google/CARTO con clave: mejor SLA, costo y gestión de claves.

## Consecuencias
- Sin costo ni claves; los servicios públicos limitan solicitudes y pueden caer. Para uso intensivo, migrar a OSRM propio o proveedor con SLA.
