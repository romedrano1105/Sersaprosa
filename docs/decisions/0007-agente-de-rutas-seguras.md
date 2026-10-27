# ADR 0007: Agente de rutas seguras con ponderación determinista y LLM opcional

- Estado: Aceptada
- Fecha: 2026-10-23

## Contexto
Se necesita evaluar rutas con incidentes, tráfico y zonas de riesgo y justificar la elección. Un LLM redacta bien pero no debe decidir seguridad solo, y el proyecto no tiene fuente de tráfico ni tabla de zonas peligrosas.

## Decisión
Paquete `backend/agente_rutas/` con herramientas (tools) que calculan y un agente que las orquesta. Las reglas de ponderación y los vetos viven en código (`puntuacion.py`); el LLM (Anthropic, Tool Calling) decide qué consultar y redacta la justificación, y `elegir_ruta` rechaza una ruta vetada si existe una segura. Sin API key o si el modelo falla, el agente funciona en modo determinista. Se expone como `POST /agente/ruta-segura` (solo coordinador, lectura con su token, ADR 0002); el LLM es opt-in (`usar_llm`).
Fuentes reales: incidentes desde `alertas_seguridad` y `eventos_especiales` (marchas y cierres con coordenadas); zonas como hotspots calculados con las alertas de 30 días; tráfico sin fuente (`TraficoSinDatos`), y el reporte lo advierte.

## Alternativas consideradas
- Dejar que el LLM puntúe rutas: no reproducible ni auditable.
- Shapely/PostGIS desde el inicio: más potencia espacial, pero más dependencias; `geo.py` conserva las firmas para sustituirlo.
- Inventar datos de tráfico: descartado; sin dato verificado no se calcula.

## Consecuencias
- Decisiones reproducibles y auditables; el modelo no puede degradar la seguridad.
- Los umbrales de hotspot, pesos y vetos son valores de partida que deben validarse con análisis de seguridad.
- Hasta integrar una API de tráfico, la evaluación ignora congestión. OSRM público tiene límites de uso.
