"""Endpoints protegidos para disponibilidad y asignación diaria de rutas."""
import logging

from fastapi import APIRouter, Header, HTTPException
from postgrest.exceptions import APIError
from pydantic import BaseModel, Field

from . import database, rpc_utils, rutas_logica
from .autenticacion import usuario_desde_autorizacion

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/disponibilidad", tags=["disponibilidad operativa"])


def _coordinador(authorization: str | None):
    token, usuario = usuario_desde_autorizacion(authorization)
    if (usuario.app_metadata or {}).get("role") != "coordinador_rutas":
        raise HTTPException(403, "Esta sección es solo para el coordinador de rutas.")
    nombre = (usuario.user_metadata or {}).get("name") or usuario.email or "Usuario"
    return database.cliente_autenticado(token), nombre


def _rutas_de_hoy(cliente) -> list[dict]:
    """id, nombre, conductor y estado de la propuesta de las rutas de hoy. Lee con el token del coordinador (RLS)."""
    hoy = rutas_logica.hoy_el_salvador().isoformat()
    return cliente.table("rutas_planificadas").select("id,nombre,conductor,estado_propuesta") \
        .eq("fecha", hoy).execute().data or []


class Asignacion(BaseModel):
    conductor: str = Field(min_length=1, max_length=100)
    vehiculo: str = Field(min_length=1, max_length=100)
    ruta: str = Field(min_length=1, max_length=100)
    guardias: list[str] = Field(default_factory=list, max_length=10)


@router.post("/listar")
def listar(authorization: str | None = Header(default=None)):
    cliente, _ = _coordinador(authorization)
    try:
        result = cliente.rpc("listar_disponibilidad_operativa", {}).execute().data
    except APIError as error:
        logger.exception("No se pudo cargar la disponibilidad operativa.")
        raise HTTPException(
            503,
            "No se pudo cargar la disponibilidad. Revise el esquema y las políticas de Supabase.",
        ) from error

    if not isinstance(result, dict) or not all(
        isinstance(result.get(key), list) for key in ("drivers", "vehicles", "routes", "assignments")
    ):
        logger.error("La función de disponibilidad devolvió una respuesta no válida.")
        raise HTTPException(502, "El servidor devolvió datos de disponibilidad no válidos.")
    # 'guards' llega solo con asignaciones_guardias.sql aplicado; sin él, no hay guardias.
    if not isinstance(result.get("guards"), list):
        result["guards"] = []
    result["totals"] = {
        "drivers": len(result["drivers"]),
        "guards": len(result["guards"]),
        "vehicles": len(result["vehicles"]),
    }
    # Coherencia con las rutas generadas: las rechazadas no se ofrecen y se avisa de los estados fantasma
    # (conductor guardado sin asignación vigente), que desasignar_ruta_operativa libera.
    # Rutas de la IA que esperan aceptación (las devuelve rutas_operativas_seguras.sql como 'pending').
    result["pendientes_aceptar"] = result.pop("pending", []) if isinstance(result.get("pending"), list) else []
    result["inconsistencias"] = []
    try:
        conciliado = rutas_logica.conciliar_asignaciones(
            _rutas_de_hoy(cliente), [a.get("ruta") for a in result["assignments"]])
        rechazadas = set(conciliado["rechazadas"])
        result["routes"] = [r for r in result["routes"] if str(r.get("id")) not in rechazadas]
        result["inconsistencias"] = conciliado["fantasmas"]
    except Exception:  # sin la columna o sin permiso de lectura: se devuelve lo de la función SQL tal cual
        logger.warning("No se pudo conciliar las rutas de hoy con las asignaciones.", exc_info=True)
    return result


@router.post("/asignar")
def asignar(req: Asignacion, authorization: str | None = Header(default=None)):
    cliente, usuario = _coordinador(authorization)
    params = {
        "p_conductor": req.conductor,
        "p_vehiculo": req.vehiculo,
        "p_ruta": req.ruta,
        "p_usuario": usuario,
        "p_guardias": req.guardias,
    }
    try:
        result = cliente.rpc("asignar_ruta_operativa", params).execute().data
    except APIError as error:
        logger.exception("No se pudo guardar la asignación operativa.")
        code = getattr(error, "code", "")
        if code == "23505":
            raise HTTPException(409, "La ruta, el conductor, un guardia o el vehículo ya tienen una asignación para hoy.") from error
        if code in {"22023", "P0001"}:
            raise HTTPException(409, str(getattr(error, "message", "La asignación ya no está disponible."))) from error
        if code == "42501":
            raise HTTPException(403, "No tiene permiso para asignar rutas.") from error
        raise HTTPException(
            503,
            "No se pudo guardar la asignación. Revise el esquema y las políticas de Supabase.",
        ) from error
    if not isinstance(result, dict) or not result.get("ruta"):
        logger.error("La función de asignación devolvió una respuesta no válida.")
        raise HTTPException(502, "El servidor no devolvió una asignación válida.")
    return {
        "ruta": result["ruta"],
        "conductor": result["conductor"],
        "vehiculo": result["vehiculo"],
        "guardias": result.get("guardias") or [],
        "fecha": result["fecha"],
        "usuario": result["usuario"],
    }


class Desasignacion(BaseModel):
    ruta: str = Field(min_length=1, max_length=100)


@router.post("/desasignar")
def desasignar(req: Desasignacion, authorization: str | None = Header(default=None)):
    """Quita conductor, guardias y vehículo de una ruta de hoy: vuelven a estar disponibles."""
    cliente, usuario = _coordinador(authorization)
    try:
        result = cliente.rpc("desasignar_ruta_operativa", {"p_ruta": req.ruta, "p_usuario": usuario}).execute().data
    except APIError as error:
        if rpc_utils.funcion_ausente(error):
            raise HTTPException(503, "Falta instalar la migración de escrituras operativas de rutas en Supabase.") from error
        logger.exception("No se pudo quitar la asignación operativa.")
        code = getattr(error, "code", "")
        if code in {"22023", "P0001"}:
            raise HTTPException(409, str(getattr(error, "message", "La ruta no tiene una asignación para hoy."))) from error
        if code == "42501":
            raise HTTPException(403, "No tiene permiso para desasignar rutas.") from error
        raise HTTPException(
            503, "No se pudo quitar la asignación. Revise el esquema y las políticas de Supabase."
        ) from error
    if not isinstance(result, dict) or not result.get("ruta"):
        raise HTTPException(502, "El servidor no confirmó la desasignación.")
    # reparada = la ruta tenía conductor guardado sin asignación vigente y solo se liberó.
    return {"ruta": result["ruta"], "desasignada": True, "reparada": bool(result.get("reparada"))}
