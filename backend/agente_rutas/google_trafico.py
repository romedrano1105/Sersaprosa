"""Consulta de tráfico de Google Routes y conversión a tramos dibujables en Leaflet."""
from __future__ import annotations

import httpx

URL_RUTAS = "https://routes.googleapis.com/directions/v2:computeRoutes"
MAX_INTERMEDIATES = 25
TIMEOUT_SEGUNDOS = 10.0
VELOCIDADES_VALIDAS = {"NORMAL", "SLOW", "TRAFFIC_JAM"}


def _lat_lng(punto: list[float] | tuple[float, float]) -> dict[str, float]:
    return {"latitude": float(punto[0]), "longitude": float(punto[1])}


def _intermedios(geometria: list[list[float] | tuple[float, float]]) -> list[dict]:
    candidatos = geometria[1:-1]
    cantidad = min(len(candidatos), MAX_INTERMEDIATES)
    if not cantidad:
        return []
    indices = sorted({
        round(indice * (len(candidatos) - 1) / (cantidad - 1))
        if cantidad > 1 else len(candidatos) // 2
        for indice in range(cantidad)
    })
    return [{"location": {"latLng": _lat_lng(candidatos[indice])}, "via": True} for indice in indices]


def decodificar_polilinea(codificada: str) -> list[list[float]]:
    """Convierte una polilínea codificada de Google a puntos [latitud, longitud]."""
    puntos: list[list[float]] = []
    latitud = longitud = indice = 0

    while indice < len(codificada):
        valores = []
        for _ in range(2):
            resultado = desplazamiento = 0
            while True:
                if indice >= len(codificada):
                    raise ValueError("Polilínea codificada incompleta.")
                byte = ord(codificada[indice]) - 63
                indice += 1
                resultado |= (byte & 0x1F) << desplazamiento
                desplazamiento += 5
                if byte < 0x20:
                    break
            valores.append(~(resultado >> 1) if resultado & 1 else resultado >> 1)

        latitud += valores[0]
        longitud += valores[1]
        puntos.append([latitud / 1e5, longitud / 1e5])
    return puntos


def segmentos_desde_respuesta(respuesta: dict) -> list[dict]:
    rutas = respuesta.get("routes") or []
    if not rutas:
        return []
    ruta = rutas[0]
    puntos = decodificar_polilinea(ruta.get("polyline", {}).get("encodedPolyline", ""))
    segmentos = []
    for intervalo in (ruta.get("travelAdvisory") or {}).get("speedReadingIntervals") or []:
        velocidad = intervalo.get("speed")
        inicio = intervalo.get("startPolylinePointIndex", 0)
        fin = intervalo.get("endPolylinePointIndex")
        if velocidad not in VELOCIDADES_VALIDAS or not isinstance(inicio, int) or not isinstance(fin, int):
            continue
        if inicio < 0 or fin <= inicio or fin >= len(puntos):
            continue
        segmentos.append({"velocidad": velocidad, "geometria": puntos[inicio:fin + 1]})
    return segmentos


def consultar_trafico_google(api_key: str | None, geometria: list[list[float]]) -> dict:
    """Solicita una ruta de Google que siga puntos de la geometría y devuelve sus intervalos."""
    if not api_key or len(geometria) < 2:
        return {"disponible": False, "segmentos": []}

    solicitud = {
        "origin": {"location": {"latLng": _lat_lng(geometria[0])}},
        "destination": {"location": {"latLng": _lat_lng(geometria[-1])}},
        "intermediates": _intermedios(geometria),
        "travelMode": "DRIVE",
        "routingPreference": "TRAFFIC_AWARE",
        "extraComputations": ["TRAFFIC_ON_POLYLINE"],
    }
    respuesta = httpx.post(
        URL_RUTAS,
        json=solicitud,
        headers={
            "X-Goog-Api-Key": api_key,
            "X-Goog-FieldMask": "routes.polyline.encodedPolyline,routes.travelAdvisory.speedReadingIntervals",
        },
        timeout=TIMEOUT_SEGUNDOS,
    )
    respuesta.raise_for_status()
    segmentos = segmentos_desde_respuesta(respuesta.json())
    return {"disponible": bool(segmentos), "segmentos": segmentos}
