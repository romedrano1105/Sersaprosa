"""Cálculo de rutas por calles para usuarios autenticados."""
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from . import database, entregas_logica, eventos_logica, motor_rutas
from .autenticacion import usuario_desde_autorizacion

logger = logging.getLogger(__name__)
router = APIRouter(tags=["rutas seguras"])


class SolicitudRuta(BaseModel):
    # Se acepta cualquier lista: los puntos sin coordenadas (null, texto vacío) se descartan con un mensaje claro
    # en vez de responder el 422 genérico de validación, que la página no sabe mostrar.
    coordinates: list = Field(default_factory=list, max_length=50)


def puntos_validos(coordenadas) -> tuple[list[tuple[float, float]], int]:
    """Puntos [lat, lng] numéricos y en rango, en orden, sin repetidos seguidos. Devuelve (válidos, descartados)."""
    validos = []
    for punto in coordenadas or []:
        try:
            lat, lng = float(punto[0]), float(punto[1])
        except (TypeError, ValueError, IndexError, KeyError):
            continue
        if lat != lat or lng != lng or not (-90 <= lat <= 90 and -180 <= lng <= 180) or (lat == 0 and lng == 0):
            continue
        if not validos or validos[-1] != (lat, lng):
            validos.append((lat, lng))
    return validos, len(coordenadas or []) - len(validos)


def _usuario_autorizado(authorization):
    _, usuario = usuario_desde_autorizacion(authorization)
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
    try:
        return database.cliente_servicio()
    except database.AuthConfigurationError as error:
        raise HTTPException(503, "Falta configurar SUPABASE_SERVICE_ROLE_KEY para cargar los eventos de seguridad.") from error


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
        raise ErrorRiesgos(type(error).__name__) from error

    return _normalizar_riesgos(eventos, alertas)


class ErrorRiesgos(RuntimeError):
    """No se pudieron leer eventos_especiales / alertas_seguridad (tabla ausente, RLS o red)."""


@router.post("/rutas/calcular")
@router.post("/generar-ruta", include_in_schema=False)
def calcular(req: SolicitudRuta, authorization: str | None = Header(default=None)):
    _usuario_autorizado(authorization)
    puntos, descartados = puntos_validos(req.coordinates)
    if len(puntos) < 2:
        raise HTTPException(422, (
            f"Se necesitan al menos 2 puntos con coordenadas válidas para calcular la ruta "
            f"(llegaron {len(puntos)} válidos y {descartados} sin coordenadas). "
            "Agrega lat/lng a los pedidos o usa «Ubicar pedidos»."))
    advertencias = []
    if descartados:
        advertencias.append(f"{descartados} punto(s) sin coordenadas válidas no se incluyeron en la ruta.")
    try:
        eventos = _cargar_riesgos()
    except ErrorRiesgos as error:
        eventos = []
        advertencias.append(
            f"No se pudieron verificar los eventos de seguridad ({error}): la ruta NO evita zonas de riesgo. "
            "Revisa las tablas eventos_especiales y alertas_seguridad en Supabase.")
    try:
        resultado = motor_rutas.calcular_rutas(puntos, eventos)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    except motor_rutas.ErrorProveedorRutas as error:
        raise HTTPException(502, str(error)) from error
    resultado["riesgos_verificados"] = not any("eventos de seguridad" in a for a in advertencias)
    resultado["advertencias"] = advertencias
    return resultado
