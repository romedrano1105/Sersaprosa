"""Cálculo y caché de rutas seguras con OpenRouteService y respaldo OSRM."""
import copy
import hashlib
import json
import logging
import math
import os
import threading
import time

import httpx

logger = logging.getLogger(__name__)

ORS_URL = "https://api.openrouteservice.org/v2/directions/driving-car/geojson"
OSRM_URL = "https://router.project-osrm.org/route/v1/driving/"
CACHE_TTL_SECONDS = 6 * 60 * 60
CACHE_MAX_ENTRIES = 256
MAX_HAZARDS = 500
MAX_ORS_HAZARDS = 100
_cache = {}
_cache_lock = threading.Lock()


class ErrorProveedorRutas(RuntimeError):
    """El proveedor no pudo calcular una ruta válida."""


def filtrar_zonas_de_riesgo(eventos):
    """Conserva eventos geolocalizados de severidad alta o media."""
    zonas = []
    for evento in eventos:
        if not isinstance(evento, dict) or evento.get("severidad", evento.get("severity")) not in ("alta", "media"):
            continue
        try:
            lat = float(evento.get("lat"))
            lng = float(evento.get("lng"))
            radio = float(evento.get("radius_m") or 350)
        except (TypeError, ValueError):
            continue
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            continue
        if not (50 <= radio <= 10000):
            radio = 350
        zonas.append({"lat": lat, "lng": lng, "radius_m": radio})
    if len(zonas) > MAX_HAZARDS:
        raise ValueError(f"Se admiten como máximo {MAX_HAZARDS} zonas de riesgo geolocalizadas.")
    return zonas


def _poligono_circular(zona, lados=16):
    latitud, longitud = zona["lat"], zona["lng"]
    radio = zona["radius_m"]
    anillo = []
    for indice in range(lados):
        angulo = 2 * math.pi * indice / lados
        lat = latitud + (radio * math.cos(angulo)) / 111320
        escala_longitud = max(0.01, math.cos(math.radians(latitud)))
        lng = longitud + (radio * math.sin(angulo)) / (111320 * escala_longitud)
        anillo.append([lng, lat])
    anillo.append(anillo[0])
    return [anillo]


def _poligonos_a_evitar(zonas):
    return {"type": "MultiPolygon", "coordinates": [_poligono_circular(zona) for zona in zonas]}


def _distancia_segmento_metros(punto, inicio, fin):
    latitud, longitud = punto
    escala_lon = max(0.01, math.cos(math.radians(latitud))) * 111320
    escala_lat = 111320
    px, py = (longitud - inicio[0]) * escala_lon, (latitud - inicio[1]) * escala_lat
    dx, dy = (fin[0] - inicio[0]) * escala_lon, (fin[1] - inicio[1]) * escala_lat
    longitud2 = dx * dx + dy * dy
    fraccion = max(0, min(1, (px * dx + py * dy) / longitud2)) if longitud2 else 0
    return math.hypot(px - fraccion * dx, py - fraccion * dy)


def ruta_intersecta_zonas(coordenadas, zonas):
    """Las coordenadas de la geometría usan el orden GeoJSON [lng, lat]."""
    for zona in zonas:
        punto = (zona["lat"], zona["lng"])
        for inicio, fin in zip(coordenadas, coordenadas[1:]):
            if _distancia_segmento_metros(punto, inicio, fin) <= zona["radius_m"]:
                return True
    return False


def _pasos_ors(feature):
    pasos = []
    propiedades = feature.get("properties") or {}
    geometria = feature.get("geometry") or {}
    coordenadas = geometria.get("coordinates") or []
    for tramo in propiedades.get("segments") or []:
        for paso in tramo.get("steps") or []:
            indices = paso.get("way_points") or []
            indice = indices[0] if indices else 0
            ubicacion = coordenadas[indice] if 0 <= indice < len(coordenadas) else None
            pasos.append({
                "instruction": paso.get("instruction") or paso.get("name") or "Continúa por la ruta",
                "distance": float(paso.get("distance") or 0),
                "duration": float(paso.get("duration") or 0),
                "location": ubicacion,
            })
    return pasos


def _pasos_osrm(ruta):
    traducciones = {
        "left": "a la izquierda",
        "right": "a la derecha",
        "slight left": "ligeramente a la izquierda",
        "slight right": "ligeramente a la derecha",
        "sharp left": "cerrado a la izquierda",
        "sharp right": "cerrado a la derecha",
        "uturn": "en U",
        "straight": "recto",
    }
    nombres = {
        "turn": "Gira",
        "continue": "Continúa",
        "depart": "Inicia el recorrido",
        "arrive": "Has llegado",
        "merge": "Incorpórate",
        "roundabout": "Entra a la rotonda",
        "rotary": "Entra a la rotonda",
        "fork": "En la bifurcación",
        "new name": "Continúa",
        "on ramp": "Toma la rampa",
        "off ramp": "Toma la salida",
    }
    pasos = []
    for tramo in ruta.get("legs") or []:
        for paso in tramo.get("steps") or []:
            maniobra = paso.get("maneuver") or {}
            tipo = maniobra.get("type") or "continue"
            modificador = traducciones.get(maniobra.get("modifier"), "")
            calle = paso.get("name") or ""
            if tipo == "arrive":
                texto = "Has llegado a tu destino"
            elif tipo == "depart":
                texto = "Inicia el recorrido" + (f" por {calle}" if calle else "")
            else:
                verbo = nombres.get(tipo, "Continúa")
                texto = " ".join(part for part in (verbo, modificador, f"en {calle}" if calle else "") if part)
            pasos.append({
                "instruction": texto,
                "distance": float(paso.get("distance") or 0),
                "duration": float(paso.get("duration") or 0),
                "location": (maniobra.get("location") or None),
            })
    return pasos


def _normalizar_ors(respuesta):
    salida = []
    for feature in respuesta.get("features") or []:
        propiedades = feature.get("properties") or {}
        resumen = propiedades.get("summary") or {}
        geometria = feature.get("geometry") or {}
        coordenadas = geometria.get("coordinates") or []
        if len(coordenadas) < 2 or not resumen.get("distance") or not resumen.get("duration"):
            continue
        salida.append({
            "distance": float(resumen["distance"]),
            "duration": float(resumen["duration"]),
            "geometry": {"coordinates": coordenadas},
            "steps": _pasos_ors(feature),
        })
    return salida


def _normalizar_osrm(respuesta):
    salida = []
    for ruta in respuesta.get("routes") or []:
        coordenadas = (ruta.get("geometry") or {}).get("coordinates") or []
        if len(coordenadas) < 2:
            continue
        salida.append({
            "distance": float(ruta.get("distance") or 0),
            "duration": float(ruta.get("duration") or 0),
            "geometry": {"coordinates": coordenadas},
            "steps": _pasos_osrm(ruta),
        })
    return salida


def _cache_key(coordenadas, zonas, provider):
    serializado = json.dumps(
        {"coordenadas": coordenadas, "zonas": zonas, "provider": provider},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(serializado.encode("utf-8")).hexdigest()


def _desde_cache(clave):
    with _cache_lock:
        entrada = _cache.get(clave)
        if not entrada:
            return None
        vence, respuesta = entrada
        if vence <= time.monotonic():
            del _cache[clave]
            return None
        return copy.deepcopy(respuesta)


def _guardar_cache(clave, respuesta):
    with _cache_lock:
        ahora = time.monotonic()
        vencidos = [key for key, (vence, _) in _cache.items() if vence <= ahora]
        for key in vencidos:
            del _cache[key]
        while len(_cache) >= CACHE_MAX_ENTRIES:
            del _cache[next(iter(_cache))]
        _cache[clave] = (ahora + CACHE_TTL_SECONDS, copy.deepcopy(respuesta))


def _solicitar_ors(coordenadas, zonas, api_key):
    payload = {
        "coordinates": [[lng, lat] for lat, lng in coordenadas],
        "instructions": True,
        "language": "es",
        "units": "m",
    }
    if zonas:
        payload["options"] = {"avoid_polygons": _poligonos_a_evitar(zonas)}
    respuesta = httpx.post(
        ORS_URL,
        json=payload,
        headers={"Authorization": api_key, "Content-Type": "application/json"},
        timeout=15,
    )
    respuesta.raise_for_status()
    return _normalizar_ors(respuesta.json())


def _solicitar_osrm(coordenadas, zonas):
    puntos = ";".join(f"{lng},{lat}" for lat, lng in coordenadas)
    respuesta = httpx.get(
        OSRM_URL + puntos,
        params={"overview": "full", "geometries": "geojson", "alternatives": "true", "steps": "true"},
        timeout=15,
    )
    respuesta.raise_for_status()
    datos = respuesta.json()
    if datos.get("code") != "Ok":
        raise ErrorProveedorRutas(datos.get("message") or "OSRM no encontró una ruta.")
    return _normalizar_osrm(datos)


def calcular_rutas(coordenadas, eventos):
    """Calcula, cachea y devuelve alternativas que no atraviesan riesgos altos/medios."""
    eventos_riesgo = [
        evento for evento in eventos
        if isinstance(evento, dict) and evento.get("severidad", evento.get("severity")) in ("alta", "media")
    ]
    zonas = filtrar_zonas_de_riesgo(eventos)
    riesgos_sin_ubicacion = len(eventos_riesgo) - len(zonas)
    api_key = os.getenv("OPENROUTESERVICE_API_KEY", "").strip()
    provider = "ors" if api_key else "osrm"
    clave = _cache_key(coordenadas, zonas, provider)
    cacheada = _desde_cache(clave)
    if cacheada is not None:
        cacheada["cached"] = True
        cacheada["hazards_missing_location"] = riesgos_sin_ubicacion
        return cacheada

    rutas = []
    proveedor_usado = "OpenRouteService"
    if api_key and len(zonas) <= MAX_ORS_HAZARDS:
        try:
            rutas = _solicitar_ors(coordenadas, zonas, api_key)
            rutas = [
                ruta for ruta in rutas
                if not ruta_intersecta_zonas(ruta["geometry"]["coordinates"], zonas)
            ]
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as error:
            logger.warning("OpenRouteService no pudo calcular la ruta; se usará OSRM: %s", error)
        if not rutas:
            logger.warning("OpenRouteService no devolvió una ruta segura; se usará OSRM.")
    elif api_key:
        logger.warning(
            "La ruta incluye más de %s zonas de riesgo; se usará OSRM y se validarán todas las alternativas.",
            MAX_ORS_HAZARDS,
        )

    if not rutas:
        proveedor_usado = "OSRM"
        try:
            rutas = _solicitar_osrm(coordenadas, zonas)
            rutas = [
                ruta for ruta in rutas
                if not ruta_intersecta_zonas(ruta["geometry"]["coordinates"], zonas)
            ]
        except httpx.HTTPError as error:
            logger.exception("No se pudo contactar OSRM.")
            raise ErrorProveedorRutas("No fue posible contactar el servicio de respaldo OSRM.") from error
        except (ValueError, KeyError, TypeError) as error:
            logger.exception("OSRM devolvió una respuesta no válida.")
            raise ErrorProveedorRutas("El servicio de respaldo OSRM devolvió una respuesta no válida.") from error

    if not rutas:
        raise ErrorProveedorRutas(
            "No se encontró una ruta por calles que evite los eventos de severidad alta y media."
        )

    resultado = {
        "provider": proveedor_usado,
        "cached": False,
        "routes": rutas,
        "hazards_avoided": len(zonas),
        "hazards_missing_location": riesgos_sin_ubicacion,
    }
    _guardar_cache(clave, resultado)
    return copy.deepcopy(resultado)
