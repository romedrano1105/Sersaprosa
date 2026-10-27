"""Historial de incidentes para análisis posterior (FCJ1-22).

Endpoints (todos POST, con el token de Supabase en Authorization: Bearer; solo coordinador_rutas):
  /incidentes/registrar          Guarda un incidente con sus datos completos. Si ya estaba registrado
                                 (misma `referencia` o mismos datos), devuelve el mismo, sin duplicarlo.
  /incidentes/historial          Todos los incidentes (pendientes y atendidos), con filtros y páginas.
  /incidentes/historial/detalle  Un incidente con su auditoría. Solo lee: no cambia nada.

Comparte la tabla `incidentes_viaje` con las alertas en curso (incidentes_router.py, FCJ1-10 / FCJ1-30);
sus rutas (/incidentes/listar, /detalle, /atender) no se tocan. SQL: backend/database/historial_incidentes.sql.
"""
import logging
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from . import historial_incidentes_logica as logica
from .notificaciones_router import usuario_administrador

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/incidentes", tags=["historial de incidentes"])

MSG_REGISTRO = "No se pudo registrar el incidente"
MSG_HISTORIAL = "No se pudo cargar el historial de incidentes"
MSG_DETALLE = "No se pudo cargar el detalle del incidente"
MSG_FALTA_SQL = "Falta ejecutar incidentes_viaje.sql y historial_incidentes.sql en Supabase."
_HUELLAS_FALTA_SQL = ("PGRST202", "42703", "42883", "registrar_incidente_viaje", "does not exist", "schema cache")


def _fallo(mensaje: str, error: BaseException | None = None):
    """503 que el panel muestra con «Reintentar». Si la causa es que no se ejecutó el SQL, lo dice."""
    if error is not None and any(huella in str(error) for huella in _HUELLAS_FALTA_SQL):
        mensaje = f"{mensaje}. {MSG_FALTA_SQL}"
    return HTTPException(503, detail={"message": mensaje, "retryable": True})


def _invalido(error: logica.DatoInvalido):
    return HTTPException(422, str(error))


class Registro(BaseModel):
    """Todos los campos son opcionales a propósito: quien falte se reporta con un mensaje claro
    («Falta la ruta, la ubicación…») en vez del error genérico de validación."""
    ruta_id: Any = None
    tipo: Any = None
    severidad: Any = None
    origen: Any = None
    descripcion: Any = None
    lat: Any = None
    lng: Any = None
    fecha: Any = None
    referencia: Any = None


class Filtros(BaseModel):
    desde: Any = None
    hasta: Any = None
    tipo: Any = None
    severidad: Any = None
    estado: Any = None
    ruta: Any = None
    pagina: Any = None
    limite: Any = None


class IncidenteId(BaseModel):
    id: UUID


def _rutas_de(cliente, incidentes: list[dict]) -> list[dict]:
    ids = sorted({str(i["ruta_id"]) for i in incidentes if i.get("ruta_id")})
    if not ids:
        return []
    return cliente.table("rutas_planificadas").select("id,nombre,conductor").in_("id", ids).execute().data or []


def _ids_de_rutas(cliente, texto: str) -> list[str]:
    """Rutas cuyo nombre contiene el texto, o cuyo id es exactamente ese texto."""
    por_nombre = cliente.table("rutas_planificadas").select("id").ilike("nombre", f"%{texto}%").execute().data or []
    por_id = cliente.table("rutas_planificadas").select("id").eq("id", texto).execute().data or []
    return sorted({str(r["id"]) for r in por_nombre + por_id})


@router.post("/registrar")
def registrar(req: Registro, authorization: str | None = Header(default=None)):
    cliente, _, _ = usuario_administrador(authorization)
    try:
        registro = logica.validar_registro(req.model_dump())
    except logica.DatoInvalido as error:
        raise _invalido(error)
    try:
        respuesta = cliente.rpc("registrar_incidente_viaje", {
            "p_ruta_id": registro["ruta_id"], "p_tipo": registro["tipo"], "p_severidad": registro["severidad"],
            "p_origen": registro["origen"], "p_descripcion": registro["descripcion"],
            "p_lat": registro["lat"], "p_lng": registro["lng"], "p_fecha": registro["fecha"], "p_clave": registro["clave"],
        }).execute().data
    except Exception as error:
        logger.exception("No se pudo registrar el incidente.")
        raise _fallo(MSG_REGISTRO, error)
    if isinstance(respuesta, dict) and respuesta.get("reason") == "ruta_no_existe":
        raise HTTPException(422, "La ruta indicada no existe.")
    if not isinstance(respuesta, dict) or not respuesta.get("ok"):
        logger.error("Respuesta inesperada al registrar el incidente: %r", respuesta)
        raise _fallo(MSG_REGISTRO)
    return {"id": respuesta.get("id"), "creado": bool(respuesta.get("creado")),
            "mensaje": "Incidente registrado." if respuesta.get("creado") else "Ese incidente ya estaba registrado."}


@router.post("/historial")
def historial(req: Filtros, authorization: str | None = Header(default=None)):
    cliente, _, _ = usuario_administrador(authorization)
    try:
        filtros = logica.validar_filtros(req.model_dump())
    except logica.DatoInvalido as error:
        raise _invalido(error)
    try:
        consulta = cliente.table("incidentes_viaje").select("*", count="exact")
        if filtros["ruta"]:
            ids = _ids_de_rutas(cliente, filtros["ruta"])
            if not ids:  # ninguna ruta coincide: no hay incidentes que mostrar (no es un error)
                return logica.construir_historial([], [], 0, filtros)
            consulta = consulta.in_("ruta_id", ids)
        for campo in ("tipo", "severidad", "estado"):
            if filtros[campo]:
                consulta = consulta.eq(campo, filtros[campo])
        ini, fin = logica.limites_fecha(filtros)
        if ini:
            consulta = consulta.gte("fecha", ini)
        if fin:
            consulta = consulta.lt("fecha", fin)
        desde, hasta = logica.rango(filtros)
        resultado = consulta.order("fecha", desc=True).range(desde, hasta).execute()
        incidentes = resultado.data or []
        return logica.construir_historial(incidentes, _rutas_de(cliente, incidentes), resultado.count, filtros)
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("No se pudo cargar el historial de incidentes.")
        raise _fallo(MSG_HISTORIAL, error)


@router.post("/historial/detalle")
def historial_detalle(req: IncidenteId, authorization: str | None = Header(default=None)):
    cliente, _, _ = usuario_administrador(authorization)
    try:
        filas = cliente.table("incidentes_viaje").select("*").eq("id", str(req.id)).limit(1).execute().data or []
        if not filas:
            raise HTTPException(404, "El incidente ya no existe.")
        auditoria = (
            cliente.table("incidentes_viaje_auditoria").select("accion,usuario_nombre,fecha,comentario")
            .eq("incidente_id", str(req.id)).execute().data or []
        )
        ruta = (_rutas_de(cliente, filas) or [None])[0]
        return {"incidente": logica.armar_item(filas[0], ruta), "auditoria": logica.armar_auditoria(auditoria)}
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("No se pudo cargar el detalle del incidente.")
        raise _fallo(MSG_DETALLE, error)
