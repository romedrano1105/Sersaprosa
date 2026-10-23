"""Ejemplo ejecutable: python -m backend.agente_rutas.ejemplo

Escenario simulado (San Salvador): la ruta directa cruza un hotspot nivel 5, pasa junto a un
asalto reportado hace 15 min y atraviesa congestión severa. El agente debe rodearlo por el sur.
Usa un motor de rutas simulado (sin red). Con ANTHROPIC_API_KEY el razonamiento lo hace el LLM.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from . import geo
from .agente import AgenteRutaSegura
from .enrutador import EnrutadorSimulado
from .fuentes import cargar_escenario
from .modelos import Ruta, Zona

ORIGEN, DESTINO = (13.700, -89.220), (13.700, -89.170)


def ruta(id_: str, puntos, kmh: float, via=None) -> Ruta:
    d = sum(geo.haversine_m(a, b) for a, b in zip(puntos, puntos[1:]))
    return Ruta(id=id_, puntos=list(puntos), distancia_m=d, duracion_s=d / (kmh / 3.6), via=via)


def construir_agente(ahora: datetime, usar_osrm: bool = False, cliente=None) -> AgenteRutaSegura:
    inc, tra, zon = cargar_escenario(Path(__file__).parent / "datos" / "escenario_demo.json", ahora)
    if usar_osrm:
        from .enrutador import OSRM
        motor = OSRM()
    else:
        directa = ruta("", [ORIGEN, (13.700, -89.195), DESTINO], 40)
        zona_critica: Zona = next(z for z in zon.zonas(((-90, -90, 90, 90))) if z.nivel == 5)
        via = geo.puntos_de_desvio(zona_critica.poligono)[0]  # esquina suroeste, fuera del hotspot
        sur = ruta("", [ORIGEN, (13.688, -89.215), via, (13.688, -89.175), DESTINO], 40, via=via)
        motor = EnrutadorSimulado([directa], {via: sur})
    return AgenteRutaSegura(inc, tra, zon, motor, cliente=cliente)


if __name__ == "__main__":
    ahora = datetime.now(timezone.utc)
    reporte = construir_agente(ahora).decidir(ORIGEN, DESTINO, ahora=ahora)
    reporte["ruta_elegida"].pop("geometria")  # para que la salida sea legible
    print(json.dumps(reporte, ensure_ascii=False, indent=2))
