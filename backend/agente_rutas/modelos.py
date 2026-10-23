"""Modelos de datos. Todas las coordenadas son tuplas (lat, lng) en grados WGS84."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

Punto = tuple[float, float]  # (lat, lng)


@dataclass(frozen=True)
class Incidente:
    """Reporte policial o bloqueo puntual. `gravedad` va de 1 (leve) a 5 (crítica)."""
    id: str
    tipo: str                    # asalto, robo, bloqueo, balacera, ...
    gravedad: int
    ubicacion: Punto
    radio_m: float               # radio de influencia del reporte
    reportado_en: datetime       # con zona horaria
    vigencia_min: int = 120      # tras este tiempo el reporte ya no pesa
    descripcion: str = ""


@dataclass(frozen=True)
class TramoTrafico:
    """Condición de tráfico en un área circular (simplificación de un tramo vial)."""
    id: str
    nombre: str
    centro: Punto
    radio_m: float
    velocidad_kmh: float         # velocidad promedio actual
    flujo_libre_kmh: float       # velocidad sin congestión
    tipo: str = "congestion"     # congestion | accidente | obra


@dataclass(frozen=True)
class Zona:
    """Geocerca de riesgo (hotspot). `nivel` va de 1 (bajo) a 5 (crítico)."""
    id: str
    nombre: str
    nivel: int
    poligono: tuple[Punto, ...]
    motivo: str = ""


@dataclass
class Ruta:
    """Ruta candidata (geometría ya trazada por el motor de rutas)."""
    id: str
    puntos: list[Punto]
    distancia_m: float
    duracion_s: float
    origen_motor: str = "osrm"
    via: Optional[Punto] = None  # punto intermedio usado para forzar un desvío


@dataclass
class Hallazgo:
    """Un riesgo concreto encontrado sobre una ruta."""
    fuente: str                  # zona | incidente | trafico
    id: str
    descripcion: str
    penalizacion: float
    veto: bool = False


@dataclass
class Evaluacion:
    ruta: Ruta
    costo_distancia: float = 0.0
    costo_tiempo: float = 0.0
    penalizacion_riesgo: float = 0.0
    duracion_ajustada_s: float = 0.0
    hallazgos: list[Hallazgo] = field(default_factory=list)

    @property
    def score(self) -> float:
        return self.costo_distancia + self.costo_tiempo + self.penalizacion_riesgo

    @property
    def vetada(self) -> bool:
        return any(h.veto for h in self.hallazgos)

    def a_dict(self, con_geometria: bool = False) -> dict:
        d = {
            "ruta_id": self.ruta.id,
            "distancia_km": round(self.ruta.distancia_m / 1000, 2),
            "duracion_min_sin_trafico": round(self.ruta.duracion_s / 60, 1),
            "duracion_min_ajustada": round(self.duracion_ajustada_s / 60, 1),
            "score": round(self.score, 2),
            "penalizacion_riesgo": round(self.penalizacion_riesgo, 2),
            "vetada": self.vetada,
            "hallazgos": [
                {"fuente": h.fuente, "id": h.id, "descripcion": h.descripcion,
                 "penalizacion": round(h.penalizacion, 2), "veto": h.veto}
                for h in self.hallazgos
            ],
        }
        if con_geometria:
            d["geometria"] = [[round(la, 6), round(ln, 6)] for la, ln in self.ruta.puntos]
        return d
