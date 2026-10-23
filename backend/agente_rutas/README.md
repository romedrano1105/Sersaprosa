# Agente de rutas seguras

Evalúa rutas origen→destino con tres fuentes (incidentes/reportes policiales, tráfico, zonas de riesgo),
penaliza o veta las que cruzan peligro y devuelve un JSON con la justificación.

```text
backend/agente_rutas/
  modelos.py       dataclasses: Incidente, TramoTrafico, Zona, Ruta, Hallazgo, Evaluacion
  geo.py           geometría local en Python puro (punto en polígono, distancia a línea, desvíos)
  fuentes.py       protocolos de las 3 fuentes + implementaciones simuladas (memoria / JSON)
  enrutador.py     OSRM real, enrutador simulado y generación de rutas candidatas y desvíos
  puntuacion.py    ponderación: costo = km + minutos (con tráfico) + penalización de riesgo; vetos
  herramientas.py  tools del agente + esquemas de Tool Calling + estado de la consulta (Sesion)
  agente.py        AgenteRutaSegura: ciclo con LLM (Anthropic tool use) o modo determinista
  ejemplo.py       escenario ejecutable      datos/escenario_demo.json
```

## Cómo piensa
1. `obtener_rutas_candidatas` → rutas del motor (OSRM trae alternativas).
2. `consultar_zonas_peligrosas`, `consultar_incidentes`, `consultar_trafico` sobre el corredor.
3. Si hay zonas nivel ≥4, vuelve a pedir rutas con **desvíos forzados** (puntos fuera del polígono) y refresca las fuentes.
4. `evaluar_rutas`: por ruta suma km, minutos ajustados por tráfico y penalizaciones:
   - zona: metros dentro × costo por nivel; incidente: gravedad × cercanía × frescura del reporte;
   - tráfico: demora por lentitud, + castigo por accidente o congestión severa.
5. **Veto**: zona nivel ≥4 con ≥100 m dentro, o incidente gravedad ≥4 vigente en su radio. Una ruta vetada nunca gana
   si existe una sin veto, aunque sea más larga. Esa regla la aplica el código, no el modelo.
6. `elegir_ruta` con la justificación; el reporte se arma con datos calculados.

Los pesos están en `puntuacion.Pesos` (se pueden ajustar por cliente o por tipo de carga).

## Usar
```text
pip install -r backend/agente_rutas/requirements.txt
python -m backend.agente_rutas.ejemplo                       # simulado, sin red ni API key
ANTHROPIC_API_KEY=... python -m backend.agente_rutas.ejemplo # el LLM orquesta las tools (modelo: AGENTE_MODELO)
python -m unittest backend.tests.test_agente_rutas
```
```python
from backend.agente_rutas.agente import AgenteRutaSegura
from backend.agente_rutas.enrutador import OSRM
agente = AgenteRutaSegura(mi_fuente_incidentes, mi_fuente_trafico, mi_fuente_zonas, OSRM())
reporte = agente.decidir((13.70, -89.22), (13.70, -89.17))
```

## En la aplicación (datos reales)
En la pantalla «Planificar rutas», el botón **🛡 Evaluar seguridad** (barra del mapa) llama a este endpoint con el inicio y la última parada y dibuja la ruta recomendada en verde con su justificación.
`POST /agente/ruta-segura` (solo coordinador): `{"origen":{"lat":..,"lng":..},"destino":{...},"usar_llm":false}`.
- Incidentes: `alertas_seguridad` + marchas/cierres de `eventos_especiales` con coordenadas (`fuentes_supabase.py`).
- Zonas: hotspots dinámicos = celdas de ~550 m con ≥3 puntos (alta=2, media=1) en 30 días; ≥3 nivel 3, ≥4 nivel 4, ≥6 nivel 5.
- Tráfico: sin fuente; el reporte lo indica en `advertencias`. Falta conectar una API de tráfico.
- `usar_llm=true` requiere `pip install anthropic` y `ANTHROPIC_API_KEY` en Render.

## Pasar a datos reales
Implementa `activos(caja, ahora)`, `tramos(caja)` y `zonas(caja)` (ver `fuentes.py`) sobre tu API de reportes,
la API de tráfico y PostGIS/GeoJSON. Sin cambios en el agente. Si el LLM falla o no hay API key, el sistema
sigue en modo determinista y lo indica en `advertencias`.

## Límites conocidos
- Los datos de `datos/escenario_demo.json` son inventados para la demo.
- El tráfico se modela como áreas circulares con velocidad promedio, no como tramos viales exactos.
- Los desvíos se generan con 4 puntos por zona crítica (máx. 4 en total); en ciudades densas conviene un
  enrutador con evitación de áreas (OSRM propio con `exclude`, Valhalla o GraphHopper `custom_model`).
- OSRM público tiene límite de uso: para producción, instancia propia.
