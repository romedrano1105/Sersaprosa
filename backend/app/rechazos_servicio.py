"""Rechazo de una ruta propuesta y solicitud de alternativa (flujo exitoso y fallido).

Todo se recibe por parámetro (clientes y funciones) para probarlo sin Supabase ni red. Orden pensado
para no dejar datos a medias: primero se valida y se lee, luego se registra el rechazo, y solo
después se pide la alternativa; si esa solicitud falla, el rechazo queda guardado con su error.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone

from ..agente_rutas.agente import SinAlternativa
from . import rechazos_logica as logica
from . import rutas_logica, viajes_logica

logger = logging.getLogger(__name__)


class ErrorRechazo(Exception):
    def __init__(self, estado: int, mensaje: str):
        super().__init__(mensaje)
        self.estado, self.mensaje = estado, mensaje


def _ruta_editable(cliente_servicio, ruta_id: str, hoy: date) -> dict:
    """Ruta de hoy, con viaje generado y que todavía no salió (sin conductor ni asignación)."""
    try:
        filas = cliente_servicio.table("rutas_planificadas").select("*").eq("id", ruta_id).limit(1).execute().data or []
        fila = filas[0] if filas else None
        asignada = bool(fila) and bool(cliente_servicio.table("asignaciones_ruta").select("ruta_id")
                                       .eq("ruta_id", ruta_id).eq("fecha_operativa", hoy.isoformat()).limit(1).execute().data)
    except Exception as error:
        raise ErrorRechazo(503, "No se pudo consultar la ruta. Revisa Supabase.") from error
    if not fila or str(fila.get("fecha") or "")[:10] != hoy.isoformat():
        raise ErrorRechazo(404, "La ruta no existe o no es de hoy.")
    if viajes_logica.ruta_ya_salio(fila, asignada):
        raise ErrorRechazo(409, "La ruta ya salió o tiene asignación: no se puede rechazar.")
    if fila.get("origen_lat") is None or fila.get("destino_lat") is None:
        raise ErrorRechazo(422, "Esta ruta no tiene un viaje generado por el sistema, no hay propuesta que rechazar.")
    return fila


def _rechazos_de(cliente_servicio, ruta_id: str) -> list[dict]:
    try:
        return cliente_servicio.table("rechazos_ruta").select("*").eq("ruta_id", ruta_id).execute().data or []
    except Exception as error:
        raise ErrorRechazo(503, "No se pudo leer el historial de rechazos. Aplica backend/database/rechazos_ruta.sql en Supabase.") from error


def _marcar_estado(cliente_servicio, ruta_id: str, estado: str) -> None:
    cliente_servicio.table("rutas_planificadas").update({"estado_propuesta": estado}).eq("id", ruta_id).execute()


def _buscar_alternativa(fila: dict, trazados: list, evaluar, permitir_vetada: bool = False) -> tuple[dict | None, dict | None]:
    """Pide al agente una ruta distinta de las rechazadas. Devuelve (evaluación, None) o (None, error).

    Una alternativa con veto de seguridad se descarta; la primera propuesta (sin rechazos) sí se muestra
    con su aviso, porque es lo único que el agente tiene para ofrecer.
    """
    origen, destino = (fila["origen_lat"], fila["origen_lng"]), (fila["destino_lat"], fila["destino_lng"])
    try:
        evaluacion = evaluar(origen, destino, trazados)
    except SinAlternativa:
        return None, logica.error_sin_alternativa(logica.SIN_RUTA)
    except Exception:
        logger.exception("El motor de rutas no pudo generar una alternativa para %s.", fila.get("id"))
        return None, logica.error_sin_alternativa(logica.MOTOR_NO_RESPONDE)
    if not permitir_vetada and (evaluacion.get("ruta_elegida") or {}).get("vetada"):
        return None, logica.error_sin_alternativa(logica.TODAS_VETADAS)
    return evaluacion, None


def _resultado(fila: dict, evaluacion: dict) -> dict:
    elegida = evaluacion["ruta_elegida"]
    return {
        "evaluacion": evaluacion,
        "nivel_riesgo": fila.get("nivel_riesgo"),                      # de la carga (monto y tipo)
        "nivel_riesgo_trayecto": logica.nivel_trayecto(elegida),       # del recorrido según el agente
        "justificacion": evaluacion.get("justificacion") or "",
    }


def _cerrar_rechazo(cliente_servicio, rechazo_id, ruta_id: str, evaluacion, error) -> None:
    """Guarda cómo terminó la solicitud de alternativa y deja la ruta en el estado que corresponde."""
    if rechazo_id is None:
        raise ErrorRechazo(503, "El rechazo quedó registrado, pero no se pudo confirmar su identificador. Reintenta la alternativa.")
    try:
        cliente_servicio.table("rechazos_ruta").update({
            "resultado": "generada" if evaluacion else "sin_alternativa",
            "error": None if evaluacion else f"{error['codigo']}: {error['mensaje']}",
        }).eq("id", rechazo_id).execute()
        _marcar_estado(cliente_servicio, ruta_id, "propuesta" if evaluacion else "rechazada")
    except Exception as cause:
        logger.exception("No se pudo guardar el resultado de la alternativa de %s.", ruta_id)
        raise ErrorRechazo(
            503, "El rechazo quedó registrado, pero no se pudo guardar el resultado de la alternativa. Reintenta."
        ) from cause
    if error:
        logger.error("Sin alternativa para la ruta %s: %s", ruta_id, error["mensaje"])


def rechazar_ruta(ruta_id, motivo, comentario, ruta_elegida, trazado, *, usuario, cliente_servicio, evaluar,
                  hoy: date | None = None) -> dict:
    hoy = hoy or rutas_logica.hoy_el_salvador()
    try:
        motivo, comentario = logica.validar_rechazo(motivo, comentario)
        puntos = logica.limpiar_trazado(trazado)
    except ValueError as error:
        raise ErrorRechazo(422, str(error)) from error
    fila = _ruta_editable(cliente_servicio, ruta_id, hoy)
    if fila.get("estado_propuesta") == "rechazada":
        raise ErrorRechazo(409, "La ruta ya fue rechazada y no tiene alternativa: usa «Reintentar».")
    if fila.get("estado_propuesta") == "aceptada":
        raise ErrorRechazo(409, "La propuesta ya fue aceptada. Edita el viaje para generar una nueva propuesta.")

    registro = {
        "ruta_id": ruta_id, "motivo": motivo, "comentario": comentario, "usuario": usuario,
        "fecha": datetime.now(timezone.utc).isoformat(),
        "propuesta": logica.propuesta_para_guardar(ruta_elegida or {}, puntos), "resultado": "pendiente",
    }
    try:
        guardado = cliente_servicio.table("rechazos_ruta").insert(registro).execute().data or []
        _marcar_estado(cliente_servicio, ruta_id, "rechazada")
    except Exception as error:
        raise ErrorRechazo(503, "No se pudo registrar el rechazo. Aplica backend/database/rechazos_ruta.sql en Supabase.") from error
    rechazo_id = (guardado[0] if guardado else {}).get("id")

    trazados = logica.trazados_rechazados(_rechazos_de(cliente_servicio, ruta_id)) or [puntos]
    evaluacion, error = _buscar_alternativa(fila, trazados, evaluar)
    _cerrar_rechazo(cliente_servicio, rechazo_id, ruta_id, evaluacion, error)
    base = {"ruta_id": ruta_id, "rechazo": logica.fila_historial({**registro, "id": rechazo_id,
                                                                  "resultado": "generada" if evaluacion else "sin_alternativa",
                                                                  "error": (error or {}).get("mensaje")})}
    if error:
        return {**base, "alternativa": None, "error": error, "puede_reintentar": True}
    return {**base, "alternativa": _resultado(fila, evaluacion), "error": None, "puede_reintentar": False}


def reintentar_alternativa(ruta_id, *, cliente_servicio, evaluar, hoy: date | None = None) -> dict:
    """Vuelve a pedir una alternativa para una ruta rechazada que quedó sin ella (flujo fallido, paso 5)."""
    hoy = hoy or rutas_logica.hoy_el_salvador()
    fila = _ruta_editable(cliente_servicio, ruta_id, hoy)
    if fila.get("estado_propuesta") != "rechazada":
        raise ErrorRechazo(409, "La ruta no está rechazada: no hay alternativa que reintentar.")
    rechazos = sorted(_rechazos_de(cliente_servicio, ruta_id), key=lambda r: str(r.get("fecha") or ""))
    if not rechazos:
        raise ErrorRechazo(409, "La ruta no tiene rechazos registrados.")
    evaluacion, error = _buscar_alternativa(fila, logica.trazados_rechazados(rechazos), evaluar)
    _cerrar_rechazo(cliente_servicio, rechazos[-1].get("id"), ruta_id, evaluacion, error)
    if error:
        return {"ruta_id": ruta_id, "alternativa": None, "error": error, "puede_reintentar": True}
    return {"ruta_id": ruta_id, "alternativa": _resultado(fila, evaluacion), "error": None, "puede_reintentar": False}


def propuesta_vigente(ruta_id, *, cliente_servicio, evaluar, hoy: date | None = None) -> dict:
    """La ruta que hoy corresponde proponer: la mejor que no esté entre las rechazadas. No cambia ningún dato."""
    hoy = hoy or rutas_logica.hoy_el_salvador()
    fila = _ruta_editable(cliente_servicio, ruta_id, hoy)
    if fila.get("estado_propuesta") == "rechazada":
        raise ErrorRechazo(409, "La ruta fue rechazada y no tiene alternativa: usa «Reintentar».")
    trazados = logica.trazados_rechazados(_rechazos_de(cliente_servicio, ruta_id))
    evaluacion, error = _buscar_alternativa(fila, trazados, evaluar, permitir_vetada=not trazados)
    if error:
        return {"ruta_id": ruta_id, "propuesta": None, "error": error}
    return {"ruta_id": ruta_id, "propuesta": _resultado(fila, evaluacion), "error": None,
            "estado_propuesta": fila.get("estado_propuesta") or "propuesta", "rechazos": len(trazados)}


def aceptar_propuesta(ruta_id, *, cliente_servicio, hoy: date | None = None) -> dict:
    hoy = hoy or rutas_logica.hoy_el_salvador()
    fila = _ruta_editable(cliente_servicio, ruta_id, hoy)
    if fila.get("estado_propuesta") == "rechazada":
        raise ErrorRechazo(409, "La ruta está rechazada y sin alternativa: no hay propuesta que aceptar.")
    if fila.get("estado_propuesta") == "aceptada":
        return {"ruta_id": ruta_id, "estado_propuesta": "aceptada"}
    try:
        _marcar_estado(cliente_servicio, ruta_id, "aceptada")
    except Exception as error:
        raise ErrorRechazo(503, "No se pudo aceptar la ruta. Revisa Supabase.") from error
    return {"ruta_id": ruta_id, "estado_propuesta": "aceptada"}


def historial(ruta_id, *, cliente_servicio) -> dict:
    filas = sorted(_rechazos_de(cliente_servicio, ruta_id), key=lambda r: str(r.get("fecha") or ""), reverse=True)
    return {"ruta_id": ruta_id, "rechazos": [logica.fila_historial(f) for f in filas]}
