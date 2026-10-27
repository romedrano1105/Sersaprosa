"""Geometría plana local en Python puro (sin dependencias).

Para distancias de ciudad (decenas de km) una proyección equirectangular local da errores
de metros, suficiente para penalizar rutas. Si el volumen crece, sustituir por Shapely/PostGIS
manteniendo estas mismas firmas.
"""
from __future__ import annotations

from math import asin, cos, radians, sin, sqrt

from .modelos import Punto

RADIO_TIERRA_M = 6371008.8


def haversine_m(a: Punto, b: Punto) -> float:
    la1, lo1, la2, lo2 = map(radians, (a[0], a[1], b[0], b[1]))
    h = sin((la2 - la1) / 2) ** 2 + cos(la1) * cos(la2) * sin((lo2 - lo1) / 2) ** 2
    return 2 * RADIO_TIERRA_M * asin(min(1.0, sqrt(h)))


def _xy(p: Punto, ref: Punto) -> tuple[float, float]:
    return (RADIO_TIERRA_M * radians(p[1] - ref[1]) * cos(radians(ref[0])),
            RADIO_TIERRA_M * radians(p[0] - ref[0]))


def punto_en_poligono(p: Punto, poligono) -> bool:
    """Ray casting. Los puntos del borde pueden caer a cualquiera de los dos lados."""
    x, y, dentro = p[1], p[0], False
    n = len(poligono)
    for i in range(n):
        y1, x1 = poligono[i]
        y2, x2 = poligono[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            dentro = not dentro
    return dentro


def distancia_punto_segmento_m(p: Punto, a: Punto, b: Punto) -> float:
    px, py = _xy(p, a)
    bx, by = _xy(b, a)
    largo2 = bx * bx + by * by
    t = 0.0 if largo2 == 0 else max(0.0, min(1.0, (px * bx + py * by) / largo2))
    return sqrt((px - t * bx) ** 2 + (py - t * by) ** 2)


def distancia_a_linea_m(p: Punto, linea: list[Punto]) -> float:
    if len(linea) == 1:
        return haversine_m(p, linea[0])
    return min(distancia_punto_segmento_m(p, linea[i], linea[i + 1]) for i in range(len(linea) - 1))


def densificar(linea: list[Punto], paso_m: float = 40.0) -> list[tuple[Punto, float]]:
    """Muestrea la línea cada ~paso_m. Devuelve [(punto, metros que representa)]."""
    if len(linea) < 2:
        return [(linea[0], 0.0)] if linea else []
    muestras: list[tuple[Punto, float]] = []
    for a, b in zip(linea, linea[1:]):
        largo = haversine_m(a, b)
        n = max(1, int(largo // paso_m) + (1 if largo % paso_m else 0))
        for k in range(n):
            f = (k + 0.5) / n
            muestras.append(((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f), largo / n))
    return muestras


def bbox(puntos: list[Punto], margen_m: float = 0.0) -> tuple[float, float, float, float]:
    """(lat_min, lng_min, lat_max, lng_max) ampliado por un margen en metros."""
    lats = [p[0] for p in puntos]
    lngs = [p[1] for p in puntos]
    dlat = margen_m / 111_320.0
    dlng = margen_m / (111_320.0 * max(0.01, cos(radians(sum(lats) / len(lats)))))
    return (min(lats) - dlat, min(lngs) - dlng, max(lats) + dlat, max(lngs) + dlng)


def en_bbox(p: Punto, caja) -> bool:
    return caja[0] <= p[0] <= caja[2] and caja[1] <= p[1] <= caja[3]


def poligono_toca_bbox(poligono, caja) -> bool:
    lats = [p[0] for p in poligono]
    lngs = [p[1] for p in poligono]
    return not (max(lats) < caja[0] or min(lats) > caja[2] or max(lngs) < caja[1] or min(lngs) > caja[3])


def centroide(poligono) -> Punto:
    return (sum(p[0] for p in poligono) / len(poligono), sum(p[1] for p in poligono) / len(poligono))


def puntos_de_desvio(poligono, holgura_m: float = 350.0) -> list[Punto]:
    """Cuatro puntos fuera del polígono (esquinas de su caja ampliada) para forzar rodearlo."""
    la0, lo0, la1, lo1 = bbox(list(poligono), holgura_m)
    return [(la0, lo0), (la0, lo1), (la1, lo0), (la1, lo1)]
