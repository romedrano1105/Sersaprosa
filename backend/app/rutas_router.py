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

from . import database, rutas_admin, rutas_logica
from .eventos_router import usuario_coordinador
from .rutas_calculo_router import _normalizar_riesgos

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/rutas", tags=["rutas planificadas"])


def _respaldo(funcion, *args):
    """Escribe con el cliente de servicio cuando la función SQL no está creada."""
    try:
        return funcion(database.cliente_servicio(), *args)
    except rutas_admin.ReglaDeNegocio as error:
        raise HTTPException(409, str(error)) from error
    except Exception as error:
        logger.exception("Falló el respaldo de escritura de rutas.")
        raise HTTPException(503, "No se pudo guardar la ruta. Revise SUPABASE_SERVICE_ROLE_KEY y las tablas.") from error


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
        if rutas_admin.funcion_ausente(error):
            resultado = _respaldo(rutas_admin.guardar_ruta, nombre, pedidos, usuario)
            return resultado
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
        if rutas_admin.funcion_ausente(error):
            return _respaldo(rutas_admin.actualizar_ruta, req.id, nombre, pedidos, usuario)
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
