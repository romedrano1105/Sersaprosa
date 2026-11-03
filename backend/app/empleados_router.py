"""Gestión de empleados reales: conductores y guardias (custodios).

  POST /empleados/listar   → empleados con su categoría, licencia, estado y ruta asignada hoy
  POST /empleados/guardar  → alta (código automático CON-/GUA- si no se envía) o edición
  POST /empleados/estado   → dar de baja / reactivar (baja lógica: se conserva el historial)

Solo coordinador de rutas. Lee y escribe con su token mediante funciones SQL de empleados_gestion.sql
(validan el rol dentro de PostgreSQL); nunca usa la clave de servicio. La asignación a rutas sigue en
/disponibilidad/asignar.
"""
import logging
from datetime import date
from typing import Literal

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from . import database, empleados_logica, rpc_utils
from .autenticacion import usuario_desde_autorizacion

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/empleados", tags=["empleados"])
MSG_FALTA_SQL = "Falta aplicar backend/database/empleados_gestion.sql en Supabase."


def _coordinador(authorization: str | None):
    token, usuario = usuario_desde_autorizacion(authorization)
    if (usuario.app_metadata or {}).get("role") != "coordinador_rutas":
        raise HTTPException(403, "Esta sección es solo para el coordinador de rutas.")
    return database.cliente_autenticado(token)


def _error_rpc(error, accion: str) -> HTTPException:
    """Traduce el error de la función SQL a un estado HTTP con un mensaje que la página pueda mostrar."""
    if rpc_utils.funcion_ausente(error):
        return HTTPException(503, MSG_FALTA_SQL)
    code = str(getattr(error, "code", "") or "")
    mensaje = str(getattr(error, "message", "") or "").strip()
    if code == "42501":
        return HTTPException(403, mensaje or "No tiene permiso para gestionar el personal.")
    if code == "23505":
        return HTTPException(409, mensaje or "Ya existe un empleado con ese código.")
    if code in {"22023", "P0001"}:
        return HTTPException(409 if code == "P0001" else 422, mensaje or "Los datos del empleado no son válidos.")
    logger.exception("No se pudo %s.", accion)
    return HTTPException(503, f"No se pudo {accion}. Revise Supabase.")


class Empleado(BaseModel):
    codigo: str | None = Field(default=None, max_length=40)
    nombre: str = Field(min_length=1, max_length=160)
    categoria: Literal["conductor", "guardia"]
    licencia: date | None = None
    activo: bool = True


class CambioEstado(BaseModel):
    codigo: str = Field(min_length=1, max_length=40)
    activo: bool


@router.post("/listar")
def listar(authorization: str | None = Header(default=None)):
    cliente = _coordinador(authorization)
    try:
        filas = cliente.rpc("listar_empleados_operativos", {}).execute().data
    except Exception as error:
        raise _error_rpc(error, "cargar el personal") from error
    empleados = [empleados_logica.con_estado(f) for f in (filas if isinstance(filas, list) else [])]
    return {"empleados": empleados, "resumen": empleados_logica.resumen(empleados)}


@router.post("/guardar")
def guardar(req: Empleado, authorization: str | None = Header(default=None)):
    cliente = _coordinador(authorization)
    datos, errores = empleados_logica.validar(req.model_dump())
    if errores:
        raise HTTPException(422, {"message": " ".join(errores.values()), "errores": errores})
    try:
        resultado = cliente.rpc("guardar_empleado_operativo", {
            "p_codigo": datos["codigo"],
            "p_nombre": datos["nombre"],
            "p_categoria": datos["categoria"],
            "p_licencia": datos["licencia"],
            "p_activo": datos["activo"],
        }).execute().data
    except Exception as error:
        raise _error_rpc(error, "guardar el empleado") from error
    if not isinstance(resultado, dict) or not resultado.get("codigo"):
        raise HTTPException(502, "Supabase no confirmó el guardado del empleado.")
    return resultado


@router.post("/estado")
def cambiar_estado(req: CambioEstado, authorization: str | None = Header(default=None)):
    cliente = _coordinador(authorization)
    try:
        resultado = cliente.rpc("cambiar_estado_empleado", {"p_codigo": req.codigo.strip(), "p_activo": req.activo}).execute().data
    except Exception as error:
        raise _error_rpc(error, "cambiar el estado del empleado") from error
    if not isinstance(resultado, dict) or not resultado.get("codigo"):
        raise HTTPException(502, "Supabase no confirmó el cambio de estado.")
    return resultado
