"""API de revisión del historial de alertas de viajes finalizados."""
import logging
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator
from supabase import create_client

import database
import alertas_seguridad_logica as logica

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/alertas", tags=["alertas de seguridad"])
PAGE_BATCH = 500


def _cliente_coordinador(authorization: str | None):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Sesión vencida. Inicie sesión de nuevo.")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(401, "Sesión vencida. Inicie sesión de nuevo.")
    try:
        usuario = database.supabase.auth.get_user(token).user
    except Exception:
        raise HTTPException(401, "Sesión vencida. Inicie sesión de nuevo.")
    if not usuario:
        raise HTTPException(401, "Sesión vencida. Inicie sesión de nuevo.")
    if (usuario.app_metadata or {}).get("role") != "coordinador_rutas":
        raise HTTPException(403, "Esta sección es solo para el coordinador de rutas.")
    cliente = create_client(database.SUPABASE_URL, database.SUPABASE_KEY)
    cliente.postgrest.auth(token)
    nombre = (usuario.user_metadata or {}).get("name") or usuario.email or "Usuario"
    return cliente, usuario, nombre


def _leer_todas(fabrica):
    filas = []
    inicio = 0
    while True:
        lote = fabrica().range(inicio, inicio + PAGE_BATCH - 1).execute().data or []
        filas.extend(lote)
        if len(lote) < PAGE_BATCH:
            return filas
        inicio += PAGE_BATCH


class Filtros(BaseModel):
    fecha_desde: str | None = None
    fecha_hasta: str | None = None
    tipo: str | None = Field(default=None, max_length=80)
    severidad: Literal["baja", "media", "alta"] | None = None
    conductor: str | None = Field(default=None, max_length=160)
    ruta: str | None = Field(default=None, max_length=200)
    estado: Literal["pendiente", "revisada"] | None = None

    @model_validator(mode="after")
    def validar_fechas(self):
        for nombre in ("fecha_desde", "fecha_hasta"):
            valor = getattr(self, nombre)
            if valor:
                try:
                    datetime.strptime(valor, "%Y-%m-%d")
                except ValueError as error:
                    raise ValueError(f"{nombre} debe usar el formato YYYY-MM-DD.") from error
        if self.fecha_desde and self.fecha_hasta and self.fecha_desde > self.fecha_hasta:
            raise ValueError("La fecha inicial no puede ser posterior a la fecha final.")
        return self


class SolicitudListado(Filtros):
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=25, ge=1, le=100)


class Revision(BaseModel):
    id: UUID
    comentario: str = Field(min_length=3, max_length=500)

    @field_validator("comentario")
    @classmethod
    def validar_comentario(cls, valor):
        valor = valor.strip()
        if len(valor) < 3:
            raise ValueError("El comentario debe tener entre 3 y 500 caracteres.")
        return valor


class RevisionMasiva(BaseModel):
    ids: list[UUID] = Field(min_length=1, max_length=100)
    comentario: str = Field(min_length=3, max_length=500)

    @field_validator("comentario")
    @classmethod
    def validar_comentario(cls, valor):
        valor = valor.strip()
        if len(valor) < 3:
            raise ValueError("El comentario debe tener entre 3 y 500 caracteres.")
        return valor

    @model_validator(mode="after")
    def ids_unicos(self):
        if len(set(self.ids)) != len(self.ids):
            raise ValueError("La solicitud contiene alertas duplicadas.")
        return self


class Detalle(BaseModel):
    id: UUID


def _fallo_carga(error):
    logger.exception("No se pudo cargar el historial de alertas de seguridad.", exc_info=error)
    raise HTTPException(
        503,
        detail={"message": "Algunas alertas no pudieron cargarse", "retryable": True},
    )


def _cargar_listado(cliente, filtros):
    ahora = datetime.now(timezone.utc)
    corte = (ahora - timedelta(days=logica.RETENCION_DIAS)).isoformat()
    try:
        viajes = _leer_todas(lambda: cliente.table("viajes_finalizados")
            .select("id,fecha_finalizacion,ruta,conductor,alertas_count")
            .gte("fecha_finalizacion", corte)
            .lte("fecha_finalizacion", ahora.isoformat()))
        grupos = []
        ids = [str(viaje["id"]) for viaje in viajes]
        for inicio in range(0, len(ids), 100):
            lote_ids = ids[inicio:inicio + 100]
            if lote_ids:
                grupos.extend(_leer_todas(lambda lote_ids=lote_ids: cliente.table("alertas_seguridad")
                    .select("id,viaje_id,fecha,tipo,severidad,estado,descripcion,lat,lng,comentario,revisado_por,revisado_en")
                    .in_("viaje_id", lote_ids)))
        respuesta = logica.construir_respuesta(viajes, grupos, filtros, filtros["page"], filtros["page_size"], ahora)
        return respuesta
    except logica.InconsistenciaAlertas as error:
        logger.error("Inconsistencia entre contador de viaje y alertas: %s", error)
        raise HTTPException(
            503,
            detail={"message": "Algunas alertas no pudieron cargarse", "retryable": True},
        )
    except HTTPException:
        raise
    except Exception as error:
        _fallo_carga(error)


@router.post("/listar")
def listar(req: SolicitudListado, authorization: str | None = Header(default=None)):
    cliente, _, _ = _cliente_coordinador(authorization)
    filtros = req.model_dump()
    return _cargar_listado(cliente, filtros)


@router.post("/detalle")
def detalle(req: Detalle, authorization: str | None = Header(default=None)):
    cliente, _, _ = _cliente_coordinador(authorization)
    try:
        filas = cliente.table("alertas_seguridad").select("*").eq("id", str(req.id)).limit(1).execute().data or []
        if not filas:
            raise HTTPException(404, "La alerta no existe o está fuera del historial de 90 días.")
        alerta = filas[0]
        viajes = cliente.table("viajes_finalizados").select("id,fecha_finalizacion,ruta,conductor,alertas_count").eq("id", alerta["viaje_id"]).limit(1).execute().data or []
        if not viajes:
            raise HTTPException(404, "El viaje asociado ya no existe.")
        if datetime.fromisoformat(viajes[0]["fecha_finalizacion"].replace("Z", "+00:00")) < datetime.now(timezone.utc) - timedelta(days=logica.RETENCION_DIAS):
            raise HTTPException(404, "La alerta está fuera del historial de 90 días.")
        auditoria = cliente.table("alertas_seguridad_auditoria").select("revisor_nombre,fecha,comentario").eq("alerta_id", str(req.id)).order("fecha", desc=True).execute().data or []
        alerta.update({key: viajes[0].get(key) for key in ("ruta", "conductor", "fecha_finalizacion")})
        return {"alerta": alerta, "auditoria": auditoria}
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("No se pudo cargar el detalle de la alerta.", exc_info=error)
        raise HTTPException(503, detail="No se pudo cargar el detalle de la alerta. Intente de nuevo.")


def _actualizar_alertas(cliente, ids, comentario, severidad_baja=False):
    respuesta = cliente.rpc("revisar_alertas_seguridad", {
        "p_ids": ids,
        "p_comentario": comentario.strip(),
        "p_solo_baja": severidad_baja,
    }).execute().data
    if not isinstance(respuesta, dict) or not respuesta.get("ok"):
        motivo = respuesta.get("reason") if isinstance(respuesta, dict) else None
        if motivo == "not_found":
            raise HTTPException(404, "Una o más alertas ya no existen.")
        if motivo == "already_reviewed":
            raise HTTPException(409, "Una o más alertas ya fueron revisadas.")
        if motivo == "not_low":
            raise HTTPException(422, "La revisión masiva solo admite alertas de severidad baja.")
        raise HTTPException(409, "No se pudo completar la revisión. Actualice el listado e inténtelo de nuevo.")
    return {
        "revisadas": len(respuesta["ids"]),
        "ids": respuesta["ids"],
        "revisado_en": respuesta["revisado_en"],
    }


@router.post("/revisar")
def revisar(req: Revision, authorization: str | None = Header(default=None)):
    cliente, usuario, _ = _cliente_coordinador(authorization)
    try:
        return _actualizar_alertas(cliente, [str(req.id)], req.comentario)
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("No se pudo guardar la revisión de la alerta.", exc_info=error)
        raise HTTPException(503, "No se pudo guardar la revisión. Intente de nuevo.")


@router.post("/revisar-bajas")
def revisar_bajas(req: RevisionMasiva, authorization: str | None = Header(default=None)):
    cliente, usuario, _ = _cliente_coordinador(authorization)
    try:
        return _actualizar_alertas(cliente, [str(alerta_id) for alerta_id in req.ids], req.comentario, severidad_baja=True)
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("No se pudo guardar la revisión masiva de alertas.", exc_info=error)
        raise HTTPException(503, "No se pudieron revisar las alertas. Intente de nuevo.")
