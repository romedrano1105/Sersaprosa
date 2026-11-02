"""Consulta de métricas operativas y corrección auditada de mitigaciones."""
import logging
from datetime import datetime, time, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from . import database, metricas_logica
from .autenticacion import usuario_desde_autorizacion

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/metricas", tags=["métricas operativas"])
ROLES_EDICION = {"coordinador_rutas", "supervisor", "administrador"}
TAMANO_PAGINA = 1000


def _usuario(authorization: str | None):
    _, user = usuario_desde_autorizacion(authorization)
    return user, (user.app_metadata or {}).get("role", "")


def _paginar(tabla, seleccion, columna, desde, hasta, exclusivo=False):
    consulta_base = tabla.select(seleccion).gte(columna, desde)
    consulta_base = consulta_base.lt(columna, hasta) if exclusivo else consulta_base.lte(columna, hasta)
    filas = []
    inicio = 0
    while True:
        pagina = consulta_base.range(inicio, inicio + TAMANO_PAGINA - 1).execute().data or []
        filas.extend(pagina)
        if len(pagina) < TAMANO_PAGINA:
            return filas
        inicio += TAMANO_PAGINA


class ConsultaMetricas(BaseModel):
    inicio: str = Field(min_length=1, max_length=10)
    fin: str = Field(min_length=1, max_length=10)


class EstadoEvento(BaseModel):
    evento_id: str = Field(min_length=1, max_length=100)
    estado: Literal["mitigado", "ocurrido"]


@router.post("/consultar")
def consultar(req: ConsultaMetricas, authorization: str | None = Header(default=None)):
    _usuario(authorization)
    try:
        desde, hasta = metricas_logica.validar_rango(req.inicio, req.fin)
    except ValueError as error:
        mensaje = str(error)
        raise HTTPException(422, mensaje) from error

    desde_iso = datetime.combine(desde, time.min, tzinfo=timezone.utc).isoformat()
    hasta_exclusivo = datetime.combine(hasta + timedelta(days=1), time.min, tzinfo=timezone.utc).isoformat()
    try:
        cliente = database.cliente_servicio()
        rutas = _paginar(
            cliente.table("rutas_planificadas"), "id,metodo_creacion,fecha",
            "fecha", desde.isoformat(), hasta.isoformat(),
        )
        eventos = _paginar(
            cliente.table("eventos_especiales"),
            "id,nombre,inicio,estado_metrica,metrica_actualizada_en",
            "inicio", desde_iso, hasta_exclusivo, exclusivo=True,
        )
        entregas = _paginar(
            cliente.table("entregas"),
            "fecha_inicio_proceso,fecha_completada_en",
            "fecha_completada_en", desde_iso, hasta_exclusivo, exclusivo=True,
        )
    except Exception as error:
        logger.exception("No se pudieron consultar las métricas operativas.")
        raise HTTPException(
            503,
            "No se pudieron cargar las métricas. Verifique que backend/database/metricas_operativas.sql esté aplicado.",
        ) from error
    return metricas_logica.construir_respuesta(rutas, eventos, entregas)


@router.post("/estado-incidente")
def actualizar_estado_evento(req: EstadoEvento, authorization: str | None = Header(default=None)):
    usuario, rol = _usuario(authorization)
    if str(rol).lower() not in ROLES_EDICION:
        raise HTTPException(403, "Permisos insuficientes")
    try:
        cliente = database.cliente_servicio()
        resultado = cliente.rpc("actualizar_estado_metrica_evento", {
            "p_evento_id": req.evento_id,
            "p_estado": req.estado,
            "p_usuario_id": str(usuario.id),
            "p_usuario_nombre": (
                (usuario.user_metadata or {}).get("name") or usuario.email or "Usuario"
            ),
        }).execute().data
    except Exception as error:
        logger.exception("No se pudo actualizar el estado de mitigación del evento %s.", req.evento_id)
        raise HTTPException(
            503,
            "No se pudo guardar el cambio. Verifique que backend/database/metricas_operativas.sql esté aplicado.",
        ) from error
    if not isinstance(resultado, dict) or not resultado.get("ok"):
        raise HTTPException(404, "El evento ya no existe.")
    return resultado
