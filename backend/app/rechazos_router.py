"""Rechazo de rutas propuestas por el sistema (solo coordinador de rutas)."""
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from . import database, rechazos_servicio
from .agente_router import _agente
from .eventos_router import usuario_coordinador

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/rutas", tags=["rechazo de rutas"])


class RutaId(BaseModel):
    ruta_id: str = Field(min_length=1, max_length=100)


class Rechazo(RutaId):
    motivo: str | None = Field(default=None, max_length=300)
    comentario: str | None = Field(default=None, max_length=1000)
    ruta_propuesta: dict = Field(default_factory=dict)


def _servicio_y_evaluador(authorization):
    cliente, usuario = usuario_coordinador(authorization)
    try:
        servicio = database.cliente_servicio()
    except database.AuthConfigurationError as error:
        raise HTTPException(503, "Falta configurar SUPABASE_SERVICE_ROLE_KEY en el servidor.") from error
    ahora = datetime.now(timezone.utc)
    agente = _agente(cliente, ahora)
    return usuario, servicio, lambda o, d, excluir: agente.decidir(o, d, ahora=ahora, usar_llm=False, excluir=excluir)


def _responder(error: rechazos_servicio.ErrorRechazo):
    return HTTPException(error.estado, error.mensaje)


@router.post("/rechazar")
def rechazar(req: Rechazo, authorization: str | None = Header(default=None)):
    usuario, servicio, evaluar = _servicio_y_evaluador(authorization)
    try:
        return rechazos_servicio.rechazar_ruta(
            req.ruta_id, req.motivo, req.comentario, req.ruta_propuesta, req.ruta_propuesta.get("geometria"),
            usuario=usuario, cliente_servicio=servicio, evaluar=evaluar)
    except rechazos_servicio.ErrorRechazo as error:
        raise _responder(error) from error


@router.post("/propuesta")
def propuesta(req: RutaId, authorization: str | None = Header(default=None)):
    _, servicio, evaluar = _servicio_y_evaluador(authorization)
    try:
        return rechazos_servicio.propuesta_vigente(req.ruta_id, cliente_servicio=servicio, evaluar=evaluar)
    except rechazos_servicio.ErrorRechazo as error:
        raise _responder(error) from error


@router.post("/alternativa")
def alternativa(req: RutaId, authorization: str | None = Header(default=None)):
    _, servicio, evaluar = _servicio_y_evaluador(authorization)
    try:
        return rechazos_servicio.reintentar_alternativa(req.ruta_id, cliente_servicio=servicio, evaluar=evaluar)
    except rechazos_servicio.ErrorRechazo as error:
        raise _responder(error) from error


@router.post("/aceptar-propuesta")
def aceptar_propuesta(req: RutaId, authorization: str | None = Header(default=None)):
    _, servicio, _ = _servicio_y_evaluador(authorization)
    try:
        return rechazos_servicio.aceptar_propuesta(req.ruta_id, cliente_servicio=servicio)
    except rechazos_servicio.ErrorRechazo as error:
        raise _responder(error) from error


@router.post("/rechazos")
def historial(req: RutaId, authorization: str | None = Header(default=None)):
    _, servicio, _ = _servicio_y_evaluador(authorization)
    try:
        return rechazos_servicio.historial(req.ruta_id, cliente_servicio=servicio)
    except rechazos_servicio.ErrorRechazo as error:
        raise _responder(error) from error