"""Guardado de rutas planificadas (paso 2 del flujo: Pedidos → Rutas → Asignación → Monitoreo).

POST /rutas/listar     → rutas planificadas de hoy (para el centro de control de rutas)
POST /rutas/guardar    {"nombre": "...", "pedidos": ["id", ...]}
  Crea la ruta de hoy y marca esos pedidos con su nombre. La escritura la hace la función
  SQL `guardar_ruta_operativa` (security definer), igual que la asignación de personal.
POST /rutas/actualizar {"id": "...", "nombre": "...", "pedidos": [...]}
  Cambia el nombre y los pedidos de una ruta de hoy (función SQL `actualizar_ruta_operativa`).
"""
import logging

from fastapi import APIRouter, Header, HTTPException
from postgrest.exceptions import APIError
from pydantic import BaseModel, Field

from . import rpc_utils, rutas_logica
from .eventos_router import usuario_coordinador

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/rutas", tags=["rutas planificadas"])


class RutaNueva(BaseModel):
    nombre: str = Field(max_length=200)
    pedidos: list[str] = Field(max_length=rutas_logica.MAX_PEDIDOS * 2)


@router.post("/guardar")
def guardar(req: RutaNueva, authorization: str | None = Header(default=None)):
    cliente, usuario = usuario_coordinador(authorization)  # valida token y rol coordinador_rutas
    try:
        nombre, pedidos = rutas_logica.validar_ruta(req.nombre, req.pedidos)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    try:
        resultado = cliente.rpc("guardar_ruta_operativa", {
            "p_nombre": nombre,
            "p_pedidos": pedidos,
            "p_usuario": usuario,
        }).execute().data
    except APIError as error:
        if rpc_utils.funcion_ausente(error):
            raise HTTPException(503, "Falta instalar la migración de escrituras operativas de rutas en Supabase.") from error
        logger.exception("No se pudo guardar la ruta planificada.")
        code = getattr(error, "code", "")
        if code in {"22023", "P0001"}:
            raise HTTPException(409, str(getattr(error, "message", "No se pudo guardar la ruta."))) from error
        if code == "42501":
            raise HTTPException(403, "Solo el coordinador de rutas puede guardar rutas.") from error
        raise HTTPException(
            503, "No se pudo guardar la ruta. Revise el esquema y las políticas de Supabase."
        ) from error
    if not isinstance(resultado, dict) or not resultado.get("id"):
        logger.error("La función guardar_ruta_operativa devolvió una respuesta no válida.")
        raise HTTPException(502, "El servidor no devolvió una ruta válida.")
    return resultado


class RutaEditada(RutaNueva):
    id: str = Field(min_length=1, max_length=100)


class OrdenRutaEditada(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    pedidos: list[str] = Field(min_length=1, max_length=rutas_logica.MAX_PEDIDOS)
    version: int = Field(ge=1)
    distancia_km: float = Field(ge=0, le=10000)
    duracion_min: float = Field(ge=0, le=100000)
    riesgo_ruta: str = Field(pattern="^(bajo|medio|alto)$")


class HistorialRuta(BaseModel):
    id: str = Field(min_length=1, max_length=100)


@router.post("/listar")
def listar(authorization: str | None = Header(default=None)):
    cliente, _ = usuario_coordinador(authorization)
    hoy = rutas_logica.hoy_el_salvador()
    try:
        filas = cliente.table("rutas_planificadas").select("*").eq("fecha", hoy.isoformat()).execute().data or []
    except APIError as error:
        logger.exception("No se pudieron cargar las rutas planificadas.")
        raise HTTPException(
            503, "No se pudieron cargar las rutas. Revise el esquema y las políticas de Supabase."
        ) from error
    return {"fecha": hoy.isoformat(), "rutas": rutas_logica.rutas_de_hoy(filas, hoy)}


@router.post("/editar-orden")
def editar_orden(req: OrdenRutaEditada, authorization: str | None = Header(default=None)):
    cliente, usuario = usuario_coordinador(authorization)
    pedidos = [str(pid or "").strip() for pid in req.pedidos]
    if any(not pid for pid in pedidos) or len(set(pedidos)) != len(pedidos):
        raise HTTPException(422, "La ruta debe contener pedidos válidos sin repetir.")
    try:
        resultado = cliente.rpc("editar_orden_ruta_operativa", {
            "p_ruta": req.id,
            "p_pedidos": pedidos,
            "p_version": req.version,
            "p_distancia_km": req.distancia_km,
            "p_duracion_min": req.duracion_min,
            "p_riesgo_ruta": req.riesgo_ruta,
            "p_usuario": usuario,
        }).execute().data
    except APIError as error:
        code = getattr(error, "code", "")
        message = str(getattr(error, "message", "No se pudo guardar la edición de la ruta."))
        if code in {"22023", "P0001"}:
            raise HTTPException(409, message) from error
        if code == "42501":
            raise HTTPException(403, "Solo el coordinador de rutas puede editar el orden.") from error
        if rpc_utils.funcion_ausente(error):
            raise HTTPException(503, "Falta instalar la migración de edición manual de rutas en Supabase.") from error
        logger.exception("No se pudo guardar el orden de la ruta.")
        raise HTTPException(503, "No se pudo guardar la edición de la ruta. Inténtalo de nuevo.") from error
    if not isinstance(resultado, dict) or not resultado.get("id"):
        logger.error("La función editar_orden_ruta_operativa devolvió una respuesta no válida.")
        raise HTTPException(502, "El servidor no devolvió la ruta editada.")
    return resultado


@router.post("/historial-edicion")
def historial_edicion(req: HistorialRuta, authorization: str | None = Header(default=None)):
    cliente, _ = usuario_coordinador(authorization)
    try:
        filas = (
            cliente.table("rutas_ediciones_auditoria").select("*")
            .eq("ruta_id", req.id).order("fecha", desc=True).execute().data or []
        )
    except APIError as error:
        logger.exception("No se pudo cargar el historial de edición de la ruta.")
        raise HTTPException(503, "No se pudo cargar el historial de movimientos de la ruta.") from error
    return {"movimientos": filas}


@router.post("/actualizar")
def actualizar(req: RutaEditada, authorization: str | None = Header(default=None)):
    cliente, usuario = usuario_coordinador(authorization)
    try:
        nombre, pedidos = rutas_logica.validar_ruta(req.nombre, req.pedidos)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    try:
        resultado = cliente.rpc("actualizar_ruta_operativa", {
            "p_ruta": req.id,
            "p_nombre": nombre,
            "p_pedidos": pedidos,
            "p_usuario": usuario,
        }).execute().data
    except APIError as error:
        if rpc_utils.funcion_ausente(error):
            raise HTTPException(503, "Falta instalar la migración de escrituras operativas de rutas en Supabase.") from error
        logger.exception("No se pudo actualizar la ruta planificada.")
        code = getattr(error, "code", "")
        if code in {"22023", "P0001"}:
            raise HTTPException(409, str(getattr(error, "message", "No se pudo actualizar la ruta."))) from error
        if code == "42501":
            raise HTTPException(403, "Solo el coordinador de rutas puede editar rutas.") from error
        raise HTTPException(
            503, "No se pudo actualizar la ruta. Revise el esquema y las políticas de Supabase."
        ) from error
    if not isinstance(resultado, dict) or not resultado.get("id"):
        logger.error("La función actualizar_ruta_operativa devolvió una respuesta no válida.")
        raise HTTPException(502, "El servidor no devolvió una ruta válida.")
    return resultado
