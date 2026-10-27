"""Viajes: «Generar ruta» (POST /viajes/generar) y edición antes de salir (POST /viajes/actualizar).

Solo coordinador de rutas (los demás roles reciben 403 y la pantalla no les muestra los botones).
Lógica en viajes_servicio.py / viajes_logica.py; el agente de IA es el mismo de /agente/ruta-segura.
"""
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from . import database, lugares, viajes_servicio
from .agente_router import _agente
from .eventos_router import usuario_coordinador
from .geocodificacion_router import buscar_lugares, geocodificar

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/viajes", tags=["viajes"])


class Viaje(BaseModel):
    # Todo opcional a propósito: la validación propia responde qué campos faltan.
    origen: str | None = Field(default=None, max_length=300)
    destino: str | None = Field(default=None, max_length=300)
    horario: str | None = Field(default=None, max_length=10)
    tipo_carga_id: int | str | None = None
    monto: float | int | str | None = None
    # Coordenadas del lugar elegido en la lista de sugerencias (opcionales; sin ellas se geocodifica el texto).
    origen_lat: float | None = Field(default=None, ge=-90, le=90)
    origen_lng: float | None = Field(default=None, ge=-180, le=180)
    destino_lat: float | None = Field(default=None, ge=-90, le=90)
    destino_lng: float | None = Field(default=None, ge=-180, le=180)


class ViajeNuevo(Viaje):
    pedidos: list[str] = Field(default_factory=list, max_length=100)


class ViajeEditado(Viaje):
    id: str = Field(min_length=1, max_length=100)


def _dependencias(authorization):
    cliente, usuario = usuario_coordinador(authorization)
    ahora = datetime.now(timezone.utc)
    agente = _agente(cliente, ahora)
    try:
        servicio = database.cliente_servicio()
    except database.AuthConfigurationError as error:
        raise HTTPException(503, {"message": "Falta configurar SUPABASE_SERVICE_ROLE_KEY en el servidor.", "errores": {}}) from error
    return dict(
        usuario=usuario, cliente_usuario=cliente,
        cliente_servicio=servicio, geocodificar=geocodificar,
        evaluar=lambda o, d: agente.decidir(o, d, ahora=ahora, usar_llm=False),
    )


def _responder(error: viajes_servicio.ErrorViaje):
    # Api.post muestra `detail.message`; `errores` va por campo por si el front lo necesita.
    return HTTPException(error.estado, {"message": error.mensaje, "errores": error.errores})


@router.post("/generar")
def generar(req: ViajeNuevo, authorization: str | None = Header(default=None)):
    try:
        return viajes_servicio.generar_viaje(req.model_dump(), req.pedidos, **_dependencias(authorization))
    except viajes_servicio.ErrorViaje as error:
        raise _responder(error) from error


@router.post("/actualizar")
def actualizar(req: ViajeEditado, authorization: str | None = Header(default=None)):
    try:
        return viajes_servicio.actualizar_viaje(req.id, req.model_dump(), **_dependencias(authorization))
    except viajes_servicio.ErrorViaje as error:
        raise _responder(error) from error


class ConsultaLugar(BaseModel):
    query: str = Field(min_length=1, max_length=120)


@router.post("/sugerencias")
def sugerencias(req: ConsultaLugar, authorization: str | None = Header(default=None)):
    """Lugares que empiezan con lo escrito: primero los ya usados en el sistema, luego los del mapa."""
    usuario_coordinador(authorization)
    if len(lugares.normalizar(req.query)) < lugares.MIN_CARACTERES:
        return {"sugerencias": []}
    locales = []
    try:
        servicio = database.cliente_servicio()
        rutas = servicio.table("rutas_planificadas").select("origen_texto,origen_lat,origen_lng,destino_texto,destino_lat,destino_lng") \
            .not_.is_("destino_texto", "null").limit(300).execute().data or []
        entregas = servicio.table("entregas").select("direccion,cliente,lat,lng").limit(500).execute().data or []
        locales = lugares.candidatos_de_filas(rutas, entregas)
    except Exception:  # sin tabla o sin clave: se sigue solo con el mapa
        logger.warning("No se pudieron leer los lugares guardados.", exc_info=True)
    propios = lugares.filtrar(req.query, locales)
    externos = buscar_lugares(req.query) if len(propios) < lugares.MAX_SUGERENCIAS and len(req.query.strip()) >= 3 else []
    return {"sugerencias": lugares.combinar(req.query, locales, externos)}


@router.get("/tipos-carga")
def tipos_carga(authorization: str | None = Header(default=None)):
    cliente, _ = usuario_coordinador(authorization)
    try:
        servicio = database.cliente_servicio()
    except database.AuthConfigurationError as error:
        raise HTTPException(503, {"message": "Falta configurar SUPABASE_SERVICE_ROLE_KEY en el servidor.", "errores": {}}) from error
    try:
        return viajes_servicio.listar_tipos_carga(cliente, servicio)
    except viajes_servicio.ErrorViaje as error:
        raise _responder(error) from error
    

from typing import List, Dict, Any
from app.database import get_supabase_client

@router.get("/monitoreo/en-vivo", response_model=list[dict[str, Any]])
def obtener_viajes_monitoreo_en_vivo():
    try:
        supabase = database.cliente_servicio()
    except Exception as error:
        raise HTTPException(status_code=500, detail="Error de conexión con Supabase") from error

    viajes_resp = (
        supabase.table("viajes")
        .select("id, estado, vehiculo_id, conductor_id, fecha_inicio, ruta_id, vehiculos(placa, modelo), empleados(nombre)")
        .in_("estado", ["en_curso", "asignado", "en_transito"])
        .execute()
    )
    
    viajes = viajes_resp.data or []
    resultado = []

    for v in viajes:
        viaje_id = v.get("id")
        
        entregas_resp = (
            supabase.table("entregas")
            .select("id, orden, direccion, lat, lng, estado, nivel_riesgo")
            .eq("viaje_id", viaje_id)
            .order("orden")
            .execute()
        )
        puntos = entregas_resp.data or []

        tramos = []
        for p in puntos:
            lat = p.get("lat") or p.get("latitud")
            lng = p.get("lng") or p.get("longitud")
            if lat is not None and lng is not None:
                tramos.append({
                    "lat": float(lat),
                    "lng": float(lng),
                    "riesgo": p.get("nivel_riesgo") or "low",
                    "direccion": p.get("direccion", "Punto de entrega"),
                    "estado": p.get("estado", "pendiente")
                })

        pos_actual = tramos[0] if tramos else {"lat": 13.6850, "lng": -89.2500, "riesgo": "low", "direccion": "Base"}
        vehiculo_info = v.get("vehiculos") or {}
        empleado_info = v.get("empleados") or {}

        resultado.append({
            "viaje_id": viaje_id,
            "estado": v.get("estado"),
            "unidad": vehiculo_info.get("placa", f"Blindado #{viaje_id}"),
            "modelo": vehiculo_info.get("modelo", "Blindado Pesado"),
            "conductor": empleado_info.get("nombre", "Conductor Asignado"),
            "posicion_actual": pos_actual,
            "tramos": tramos
        })

    return resultado