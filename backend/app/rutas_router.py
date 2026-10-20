"""Guardado de rutas planificadas (paso 2 del flujo: Pedidos → Rutas → Asignación → Monitoreo).

POST /rutas/guardar {"nombre": "...", "pedidos": ["id", ...]}
  Crea la ruta de hoy y marca esos pedidos con su nombre. La escritura la hace la función
  SQL `guardar_ruta_operativa` (security definer), igual que la asignación de personal.
"""
import logging

from fastapi import APIRouter, Header, HTTPException
from postgrest.exceptions import APIError
from pydantic import BaseModel, Field

from . import rutas_logica
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
