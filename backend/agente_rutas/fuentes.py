"""Fuentes de datos del agente. Cada fuente es un objeto con un solo método de consulta.

Las implementaciones de este archivo son SIMULADAS (listas en memoria o JSON). Para producción
se sustituyen por adaptadores con la misma firma, por ejemplo:
  - incidentes: tabla de reportes policiales / API de 911 / tabla `eventos` de Supabase
  - tráfico:    API de tráfico (Google Routes, TomTom, HERE) convertida a `TramoTrafico`
  - zonas:      tabla PostGIS (`ST_AsGeoJSON(geom)`) o archivo GeoJSON mantenido por análisis
El agente solo conoce los tres protocolos, no de dónde vienen los datos.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from . import geo
from .modelos import Incidente, TramoTrafico, Zona

CAJA = tuple[float, float, float, float]


class FuenteIncidentes(Protocol):
    def activos(self, caja: CAJA, ahora: datetime) -> list[Incidente]: ...


class FuenteTrafico(Protocol):
    def tramos(self, caja: CAJA) -> list[TramoTrafico]: ...


class FuenteZonas(Protocol):
    def zonas(self, caja: CAJA) -> list[Zona]: ...


def _utc(valor: str) -> datetime:
    f = datetime.fromisoformat(valor.replace("Z", "+00:00"))
    return f if f.tzinfo else f.replace(tzinfo=timezone.utc)


class IncidentesEnMemoria:
    def __init__(self, incidentes: list[Incidente]):
        self._items = list(incidentes)

    def activos(self, caja, ahora):
        out = []
        for i in self._items:
            edad_min = (ahora - i.reportado_en).total_seconds() / 60
            if 0 <= edad_min <= i.vigencia_min and geo.en_bbox(i.ubicacion, caja):
                out.append(i)
        return out


class TraficoEnMemoria:
    def __init__(self, tramos: list[TramoTrafico]):
        self._items = list(tramos)

    def tramos(self, caja):
        return [t for t in self._items if geo.en_bbox(t.centro, caja)]


class ZonasEnMemoria:
    def __init__(self, zonas: list[Zona]):
        self._items = list(zonas)

    def zonas(self, caja):
        return [z for z in self._items if geo.poligono_toca_bbox(z.poligono, caja)]


def cargar_escenario(ruta_json: str | Path, ahora: datetime):
    """Lee un escenario simulado. Los incidentes llevan `hace_min` (antigüedad relativa a `ahora`)."""
    from datetime import timedelta
    d = json.loads(Path(ruta_json).read_text(encoding="utf-8"))
    incidentes = [Incidente(
        id=i["id"], tipo=i["tipo"], gravedad=int(i["gravedad"]), ubicacion=tuple(i["ubicacion"]),
        radio_m=float(i["radio_m"]), reportado_en=ahora - timedelta(minutes=float(i["hace_min"])),
        vigencia_min=int(i.get("vigencia_min", 120)), descripcion=i.get("descripcion", ""),
    ) for i in d["incidentes"]]
    trafico = [TramoTrafico(
        id=t["id"], nombre=t["nombre"], centro=tuple(t["centro"]), radio_m=float(t["radio_m"]),
        velocidad_kmh=float(t["velocidad_kmh"]), flujo_libre_kmh=float(t["flujo_libre_kmh"]),
        tipo=t.get("tipo", "congestion"),
    ) for t in d["trafico"]]
    zonas = [Zona(
        id=z["id"], nombre=z["nombre"], nivel=int(z["nivel"]),
        poligono=tuple(tuple(p) for p in z["poligono"]), motivo=z.get("motivo", ""),
    ) for z in d["zonas"]]
    return IncidentesEnMemoria(incidentes), TraficoEnMemoria(trafico), ZonasEnMemoria(zonas)
