"""POST /agente/ruta-segura: el agente de IA evalúa una ruta origen→destino con datos reales de Supabase.

Solo coordinador. Lee con el token del usuario (RLS). Motor de rutas: OSRM desde el servidor.
Por defecto usa el modo determinista (sin costo de IA); con `usar_llm=true` y ANTHROPIC_API_KEY
el modelo orquesta las herramientas, y si falla se vuelve al modo determinista.
"""
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from ..agente_rutas import geo
from ..agente_rutas.agente import AgenteRutaSegura
from ..agente_rutas.enrutador import OSRM
from ..agente_rutas.fuentes_supabase import IncidentesSupabase, TraficoSinDatos, ZonasSupabase
from .eventos_router import usuario_coordinador

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/agente", tags=["agente de rutas seguras"])
DISTANCIA_MAXIMA_KM = 300


class Coordenada(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class SolicitudRuta(BaseModel):
    origen: Coordenada
    destino: Coordenada
    usar_llm: bool = False


def _agente(cliente, ahora: datetime, enrutador=None) -> AgenteRutaSegura:
    return AgenteRutaSegura(IncidentesSupabase(cliente), TraficoSinDatos(), ZonasSupabase(cliente, ahora), enrutador or OSRM())


@router.post("/ruta-segura")
def ruta_segura(req: SolicitudRuta, authorization: str | None = Header(default=None)):
    cliente, _ = usuario_coordinador(authorization)
    o, d = (req.origen.lat, req.origen.lng), (req.destino.lat, req.destino.lng)
    if geo.haversine_m(o, d) / 1000 > DISTANCIA_MAXIMA_KM:
        raise HTTPException(422, f"El origen y el destino deben estar a menos de {DISTANCIA_MAXIMA_KM} km.")
    ahora = datetime.now(timezone.utc)
    try:
        return _agente(cliente, ahora).decidir(o, d, ahora=ahora, usar_llm=req.usar_llm)
    except Exception as error:
        logger.exception("Falló el agente de rutas seguras.")
        raise HTTPException(502, "No se pudo evaluar la ruta. Revisa la conexión con el motor de rutas y Supabase.") from error
