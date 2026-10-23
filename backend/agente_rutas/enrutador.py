"""Motor de rutas: OSRM real y uno simulado para pruebas. Ambos devuelven `Ruta`."""
from __future__ import annotations

from typing import Protocol

from . import geo
from .modelos import Punto, Ruta, Zona

OSRM_URL = "https://router.project-osrm.org"


class Enrutador(Protocol):
    def rutas(self, origen: Punto, destino: Punto, via: Punto | None = None) -> list[Ruta]: ...


class OSRM:
    """Cliente de OSRM (`/route/v1/driving`). Pide alternativas cuando no hay punto intermedio."""

    def __init__(self, base_url: str = OSRM_URL, timeout: float = 15.0):
        self.base_url, self.timeout = base_url.rstrip("/"), timeout

    def rutas(self, origen, destino, via=None):
        import httpx  # import tardío: solo se necesita con el motor real
        puntos = [origen] + ([via] if via else []) + [destino]
        coords = ";".join(f"{lng:.6f},{lat:.6f}" for lat, lng in puntos)
        r = httpx.get(f"{self.base_url}/route/v1/driving/{coords}", timeout=self.timeout, params={
            "overview": "full", "geometries": "geojson", "alternatives": "true" if not via else "false"})
        r.raise_for_status()
        datos = r.json()
        if datos.get("code") != "Ok":
            raise RuntimeError(f"OSRM respondió {datos.get('code')}")
        return [Ruta(id="", puntos=[(la, lo) for lo, la in x["geometry"]["coordinates"]],
                     distancia_m=x["distance"], duracion_s=x["duration"], via=via) for x in datos["routes"]]


class EnrutadorSimulado:
    """Devuelve rutas fijas; si se pide un `via`, devuelve la ruta registrada para ese desvío."""

    def __init__(self, directas: list[Ruta], desvios: dict[Punto, Ruta] | None = None):
        self.directas, self.desvios = directas, desvios or {}

    def rutas(self, origen, destino, via=None):
        if via is None:
            return list(self.directas)
        return [self.desvios[via]] if via in self.desvios else []


def candidatas(enrutador: Enrutador, origen: Punto, destino: Punto, zonas_criticas: list[Zona] | None = None,
               max_desvios: int = 4) -> list[Ruta]:
    """Rutas base del motor + (si se piden) desvíos que rodean las zonas críticas.

    Cada desvío fuerza un punto intermedio fuera de la zona. Se numeran R1, R2, ... y se descartan
    duplicados de geometría casi idéntica.
    """
    todas = list(enrutador.rutas(origen, destino))
    vistos = 0
    for z in zonas_criticas or []:
        for via in geo.puntos_de_desvio(z.poligono):
            if vistos >= max_desvios:
                break
            try:
                todas.extend(enrutador.rutas(origen, destino, via=via))
            except Exception:  # un desvío fallido no debe tumbar la evaluación
                continue
            vistos += 1
    unicas: list[Ruta] = []
    for r in todas:
        if not any(abs(r.distancia_m - u.distancia_m) < 5 and abs(r.duracion_s - u.duracion_s) < 5 for u in unicas):
            unicas.append(r)
    for n, r in enumerate(unicas, 1):
        r.id = f"R{n}"
    return unicas
