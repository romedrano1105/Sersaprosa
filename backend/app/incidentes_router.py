"""Alertas de incidentes de viajes en curso para el administrador de rutas (FCJ1-10 / FCJ1-30).

Endpoints (todos POST, con el token de Supabase en Authorization: Bearer):
  /incidentes/listar   Alertas activas (pendientes), nuevas primero, con el contador de no atendidas.
                       El panel lo consulta cada pocos segundos: así recibe las alertas nuevas y,
                       tras una caída de conexión, recupera todo lo que llegó mientras estuvo desconectado.
  /incidentes/detalle  Detalle con ubicación y auditoría; marca la alerta como vista.
  /incidentes/atender  Marca como atendida con comentario y registra la auditoría.

Tablas y función: backend/database/incidentes_viaje.sql.
Seguridad: el rol se valida AQUÍ con el token (app_metadata.role) y otra vez en PostgreSQL (ADR 0002).
"""
import logging
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, field_validator

from . import incidentes_logica as logica
from .notificaciones_router import usuario_administrador

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/incidentes", tags=["incidentes de viajes en curso"])

LIMITE_LISTADO = 200
MSG_CARGA = "No se pueden recibir alertas en tiempo real"


def _fallo(mensaje: str = MSG_CARGA):
    return HTTPException(503, detail={"message": mensaje, "retryable": True})


def _rutas_de(cliente, incidentes: list[dict]) -> list[dict]:
    ids = sorted({str(i["ruta_id"]) for i in incidentes if i.get("ruta_id")})
    if not ids:
        return []
    return cliente.table("rutas_planificadas").select("id,nombre,conductor").in_("id", ids).execute().data or []


class IncidenteId(BaseModel):
    id: UUID


class Atencion(BaseModel):
    id: UUID
    comentario: str

    @field_validator("comentario")
    @classmethod
    def validar_comentario(cls, valor):
        return logica.validar_comentario(valor)


@router.post("/listar")
def listar(authorization: str | None = Header(default=None)):
    cliente, _, _ = usuario_administrador(authorization)
    try:
        incidentes = (
            cliente.table("incidentes_viaje").select("*")
            .eq("estado", "pendiente").order("fecha", desc=True).limit(LIMITE_LISTADO)
            .execute().data or []
        )
        return logica.construir_listado(incidentes, _rutas_de(cliente, incidentes))
    except HTTPException:
        raise
    except Exception:
        logger.exception("No se pudieron cargar las alertas de incidentes.")
        raise _fallo()


@router.post("/detalle")
def detalle(req: IncidenteId, authorization: str | None = Header(default=None)):
    cliente, _, _ = usuario_administrador(authorization)
    try:
        filas = cliente.table("incidentes_viaje").select("*").eq("id", str(req.id)).limit(1).execute().data or []
        if not filas:
            raise HTTPException(404, "La alerta ya no existe.")
        incidente = filas[0]
        if not incidente.get("vista"):
            try:
                cliente.table("incidentes_viaje").update({"vista": True}).eq("id", str(req.id)).execute()
                incidente["vista"] = True
            except Exception:  # no impide ver el detalle
                logger.warning("No se pudo marcar la alerta %s como vista.", req.id, exc_info=True)
        auditoria = (
            cliente.table("incidentes_viaje_auditoria").select("usuario_nombre,fecha,comentario")
            .eq("incidente_id", str(req.id)).order("fecha", desc=True).execute().data or []
        )
        return {"alerta": logica.armar_item(incidente, (_rutas_de(cliente, [incidente]) or [None])[0]), "auditoria": auditoria}
    except HTTPException:
        raise
    except Exception:
        logger.exception("No se pudo cargar el detalle de la alerta.")
        raise HTTPException(503, "No se pudo cargar el detalle de la alerta. Intente de nuevo.")


@router.post("/atender")
def atender(req: Atencion, authorization: str | None = Header(default=None)):
    cliente, _, _ = usuario_administrador(authorization)
    try:
        respuesta = cliente.rpc("atender_incidente_viaje", {"p_id": str(req.id), "p_comentario": req.comentario}).execute().data
    except Exception:
        logger.exception("No se pudo guardar la atención de la alerta.")
        raise HTTPException(503, "No se pudo guardar la atención. Intente de nuevo.")
    if not isinstance(respuesta, dict) or not respuesta.get("ok"):
        motivo = respuesta.get("reason") if isinstance(respuesta, dict) else None
        if motivo == "not_found":
            raise HTTPException(404, "La alerta ya no existe.")
        if motivo == "already_attended":
            raise HTTPException(409, "Otro administrador ya atendió esta alerta.")
        raise HTTPException(409, "No se pudo completar la atención. Actualice el panel e inténtelo de nuevo.")
    return {"id": str(req.id), "atendido_en": respuesta.get("atendido_en"), "atendido_nombre": respuesta.get("atendido_nombre")}