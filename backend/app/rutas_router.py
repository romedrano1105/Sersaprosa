"""Cálculo de rutas por calles para usuarios autenticados."""
import logging
import threading
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field, field_validator
from supabase import create_client

from . import database, entregas_logica, eventos_logica, motor_rutas

logger = logging.getLogger(__name__)
router = APIRouter(tags=["rutas seguras"])
_cliente_admin = None
_cliente_admin_lock = threading.Lock()


class SolicitudRuta(BaseModel):
    coordinates: list[tuple[float, float]] = Field(min_length=2, max_length=50)

    @field_validator("coordinates")
    @classmethod
    def validar_coordenadas(cls, coordinates):
        for lat, lng in coordinates:
            if not (-90 <= lat <= 90 and -180 <= lng <= 180):
                raise ValueError("Una coordenada está fuera de rango.")
        return coordinates


def _usuario_autorizado(authorization):
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
    if (usuario.app_metadata or {}).get("role") not in entregas_logica.ROLES_PERMITIDOS:
        raise HTTPException(403, "No tiene permiso para calcular rutas.")


def _leer_todas(fabrica):
    filas = []
    inicio = 0
    while True:
        lote = fabrica().range(inicio, inicio + 499).execute().data or []
        filas.extend(lote)
        if len(lote) < 500:
            return filas
        inicio += 500


def _obtener_cliente_admin():
    global _cliente_admin
    if not database.SUPABASE_SERVICE_ROLE_KEY:
        raise HTTPException(503, "Falta configurar SUPABASE_SERVICE_ROLE_KEY para cargar los eventos de seguridad.")
    if _cliente_admin is None:
        with _cliente_admin_lock:
            if _cliente_admin is None:
                _cliente_admin = create_client(database.SUPABASE_URL, database.SUPABASE_SERVICE_ROLE_KEY)
    return _cliente_admin


def _normalizar_riesgos(eventos, alertas, hoy=None):
    niveles = {"alto": "alta", "medio": "media", "alta": "alta", "media": "media"}
    riesgos = []
    for evento in eventos:
        severidad = niveles.get(evento.get("impacto"))
        if severidad and eventos_logica.en_ventana(evento, hoy):
            riesgos.append({
                "severidad": severidad,
                "lat": evento.get("lat"),
                "lng": evento.get("lng"),
                "radius_m": evento.get("radius_m"),
            })
    riesgos.extend(
        {
            "severidad": alerta.get("severidad"),
            "lat": alerta.get("lat"),
            "lng": alerta.get("lng"),
            "radius_m": 250,
        }
        for alerta in alertas
    )
    return riesgos


def _cargar_riesgos():
    try:
        cliente = _obtener_cliente_admin()
        eventos = _leer_todas(
            lambda: cliente.table("eventos_especiales").select("inicio,fin,lat,lng,radius_m,impacto")
        )
        alertas_desde = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
        alertas_hasta = datetime.now(timezone.utc).isoformat()
        alertas = _leer_todas(
            lambda: cliente.table("alertas_seguridad")
            .select("fecha,lat,lng,severidad")
            .gte("fecha", alertas_desde)
            .lte("fecha", alertas_hasta)
            .in_("severidad", ["alta", "media"])
        )
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("No fue posible cargar los eventos para evitar en el cálculo de rutas.")
        raise HTTPException(
            503,
            "No fue posible verificar los eventos de seguridad. La ruta no se calculó.",
        ) from error

    return _normalizar_riesgos(eventos, alertas)


@router.post("/rutas/calcular")
@router.post("/generar-ruta", include_in_schema=False)
def calcular(req: SolicitudRuta, authorization: str | None = Header(default=None)):
    _usuario_autorizado(authorization)
    eventos = _cargar_riesgos()
    try:
        return motor_rutas.calcular_rutas(req.coordinates, eventos)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    except motor_rutas.ErrorProveedorRutas as error:
        raise HTTPException(502, str(error)) from error


class SolicitudGeocodificar(BaseModel):
    query: str = Field(min_length=3, max_length=200)


@router.post("/rutas/geocodificar")
def geocodificar(req: SolicitudGeocodificar, authorization: str | None = Header(default=None)):
    """Devuelve {lat, lng, label} para una dirección escrita en el planificador multi-paradas."""
    _usuario_autorizado(authorization)
    try:
        return motor_rutas.geocodificar(req.query)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    except motor_rutas.ErrorProveedorRutas as error:
        raise HTTPException(502, str(error)) from error
