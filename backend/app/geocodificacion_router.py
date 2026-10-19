"""Geocodificación de direcciones para el planificador de rutas multi-paradas.

POST /rutas/geocodificar {"query": "..."} -> {"lat", "lng", "label"} dentro de El Salvador.
Usa OpenRouteService si OPENROUTESERVICE_API_KEY está definida (la clave solo vive aquí,
nunca llega al navegador) y, si no hay clave o no responde, Nominatim de OpenStreetMap.
"""
import logging
import os

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from .entregas_router import usuario_autorizado

logger = logging.getLogger(__name__)
router = APIRouter(tags=["geocodificacion"])

ORS_GEOCODE_URL = "https://api.openrouteservice.org/geocode/search"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"


class ErrorGeocodificacion(RuntimeError):
    """El proveedor no respondió o devolvió datos no válidos."""


def _lugar_ors(datos):
    feature = (datos.get("features") or [None])[0]
    if not feature:
        return None
    lng, lat = feature["geometry"]["coordinates"][:2]
    return {"lat": float(lat), "lng": float(lng), "label": feature["properties"].get("label", "")}


def _lugar_nominatim(datos):
    if not datos:
        return None
    return {"lat": float(datos[0]["lat"]), "lng": float(datos[0]["lon"]), "label": datos[0].get("display_name", "")}


def geocodificar(texto):
    """Devuelve {lat, lng, label}. ValueError si no hay resultados; ErrorGeocodificacion si falla el proveedor."""
    texto = (texto or "").strip()
    if len(texto) < 3:
        raise ValueError("Escribe al menos 3 caracteres para buscar la ubicación.")
    api_key = os.getenv("OPENROUTESERVICE_API_KEY", "").strip()
    if api_key:
        try:
            respuesta = httpx.get(
                ORS_GEOCODE_URL,
                params={"api_key": api_key, "text": texto, "boundary.country": "SV", "size": 1},
                timeout=10,
            )
            respuesta.raise_for_status()
            lugar = _lugar_ors(respuesta.json())
            if lugar:
                return lugar
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as error:
            logger.warning("OpenRouteService no pudo geocodificar; se usará Nominatim: %s", error)
    try:
        respuesta = httpx.get(
            NOMINATIM_URL,
            params={"q": texto, "format": "jsonv2", "countrycodes": "sv", "limit": 1},
            headers={"User-Agent": "sersaprosa-rutas/1.0"},
            timeout=10,
        )
        respuesta.raise_for_status()
        lugar = _lugar_nominatim(respuesta.json())
    except httpx.HTTPError as error:
        logger.exception("No se pudo contactar el servicio de geocodificación.")
        raise ErrorGeocodificacion("No fue posible buscar la dirección. Inténtalo de nuevo.") from error
    except (ValueError, KeyError, TypeError) as error:
        raise ErrorGeocodificacion("El servicio de direcciones devolvió una respuesta no válida.") from error
    if not lugar:
        raise ValueError("No se encontró la dirección en El Salvador. Prueba con más detalle.")
    return lugar


class SolicitudGeocodificar(BaseModel):
    query: str = Field(min_length=3, max_length=200)


@router.post("/rutas/geocodificar")
def endpoint_geocodificar(req: SolicitudGeocodificar, authorization: str | None = Header(default=None)):
    usuario_autorizado(authorization)
    try:
        return geocodificar(req.query)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    except ErrorGeocodificacion as error:
        raise HTTPException(502, str(error)) from error
