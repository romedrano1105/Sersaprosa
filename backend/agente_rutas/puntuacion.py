"""Lógica de ponderación: costo = distancia + tiempo (con tráfico) + penalización de riesgo.

Todo se expresa en "puntos de costo" para poder compararlo. Un veto marca una ruta como
no recomendable mientras exista una alternativa sin veto.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from . import geo
from .modelos import Evaluacion, Hallazgo, Incidente, Ruta, TramoTrafico, Zona


@dataclass
class Pesos:
    por_km: float = 1.0
    por_min: float = 0.6
    # Costo por km recorrido DENTRO de una zona, según su nivel (1..5).
    zona_por_km: dict[int, float] = field(default_factory=lambda: {1: 4, 2: 8, 3: 18, 4: 45, 5: 90})
    # Costo base de pasar cerca de un incidente, por gravedad (1..5); luego se escala por cercanía y antigüedad.
    incidente_base: dict[int, float] = field(default_factory=lambda: {1: 4, 2: 10, 3: 25, 4: 60, 5: 120})
    veto_zona_nivel: int = 4          # zona de este nivel o más (con tramo dentro) veta la ruta
    veto_zona_min_m: float = 100.0    # metros mínimos dentro de la zona para vetar
    veto_incidente_gravedad: int = 4  # incidente de esta gravedad o más (vigente y en su radio) veta
    margen_incidente_m: float = 50.0  # tolerancia extra sobre el radio del reporte
    penalizacion_accidente_vial: float = 30.0
    congestion_severa_ratio: float = 0.35  # velocidad/flujo libre por debajo de esto = severa


def evaluar_ruta(ruta: Ruta, zonas: list[Zona], incidentes: list[Incidente],
                 trafico: list[TramoTrafico], ahora: datetime, pesos: Pesos | None = None) -> Evaluacion:
    p = pesos or Pesos()
    ev = Evaluacion(ruta=ruta)
    ev.costo_distancia = p.por_km * ruta.distancia_m / 1000
    muestras = geo.densificar(ruta.puntos)

    # 1) Zonas peligrosas: metros del trayecto dentro de cada polígono.
    for z in zonas:
        dentro = sum(m for pt, m in muestras if geo.punto_en_poligono(pt, z.poligono))
        if dentro <= 0:
            continue
        pen = p.zona_por_km.get(z.nivel, p.zona_por_km[5]) * dentro / 1000
        veto = z.nivel >= p.veto_zona_nivel and dentro >= p.veto_zona_min_m
        ev.hallazgos.append(Hallazgo("zona", z.id, f"cruza la zona «{z.nombre}» (nivel {z.nivel}) por {dentro:.0f} m"
                                     + (f": {z.motivo}" if z.motivo else ""), pen, veto))

    # 2) Incidentes vigentes: se pesan por gravedad, cercanía a la ruta y frescura del reporte.
    for i in incidentes:
        edad_min = max(0.0, (ahora - i.reportado_en).total_seconds() / 60)
        if edad_min > i.vigencia_min:
            continue
        distancia = geo.distancia_a_linea_m(i.ubicacion, ruta.puntos)
        alcance = i.radio_m + p.margen_incidente_m
        if distancia > alcance:
            continue
        cercania = 1 - 0.5 * (distancia / alcance)            # 1.0 encima, 0.5 en el borde del radio
        frescura = 1 - 0.7 * (edad_min / i.vigencia_min)      # 1.0 recién reportado, 0.3 al vencer
        pen = p.incidente_base.get(i.gravedad, p.incidente_base[5]) * cercania * frescura
        veto = i.gravedad >= p.veto_incidente_gravedad
        ev.hallazgos.append(Hallazgo("incidente", i.id, f"pasa a {distancia:.0f} m de un reporte de {i.tipo} "
                                     f"(gravedad {i.gravedad}) hecho hace {edad_min:.0f} min", pen, veto))

    # 3) Tráfico: tiempo extra por lentitud en cada tramo que atraviesa y penalización si es severo.
    extra_s: dict[str, float] = {}
    for t in trafico:
        metros = sum(m for pt, m in muestras if geo.haversine_m(pt, t.centro) <= t.radio_m)
        if metros <= 0:
            continue
        v = max(5.0, t.velocidad_kmh)
        extra_s[t.id] = max(0.0, metros / 1000 * (1 / v - 1 / t.flujo_libre_kmh) * 3600)
        severa = t.velocidad_kmh / t.flujo_libre_kmh <= p.congestion_severa_ratio
        pen = 0.0
        if t.tipo == "accidente":
            pen += p.penalizacion_accidente_vial
        if severa:
            pen += p.por_min * extra_s[t.id] / 60  # la demora severa pesa doble
        if extra_s[t.id] >= 30 or pen:
            etiqueta = {"accidente": "accidente vial", "obra": "obra"}.get(t.tipo, "congestión severa" if severa else "congestión")
            ev.hallazgos.append(Hallazgo("trafico", t.id, f"{etiqueta} en {t.nombre}: {t.velocidad_kmh:.0f} km/h "
                                         f"(normal {t.flujo_libre_kmh:.0f}), +{extra_s[t.id] / 60:.1f} min", pen))

    ev.duracion_ajustada_s = ruta.duracion_s + sum(extra_s.values())
    ev.costo_tiempo = p.por_min * ev.duracion_ajustada_s / 60
    ev.penalizacion_riesgo = sum(h.penalizacion for h in ev.hallazgos)
    return ev


def mejor(evaluaciones: list[Evaluacion]) -> Evaluacion:
    """Prefiere rutas sin veto; entre ellas, la de menor score. Si todas vetan, la de menor score."""
    libres = [e for e in evaluaciones if not e.vetada]
    return min(libres or evaluaciones, key=lambda e: e.score)
