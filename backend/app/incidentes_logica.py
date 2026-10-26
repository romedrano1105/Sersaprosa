"""Reglas puras de las alertas de incidentes de viajes en curso (FCJ1-10 / FCJ1-30).

No depende de Supabase ni de FastAPI: se prueba con
`python -m pytest backend/tests/test_incidentes.py`.

Decisiones (FCJ1-125):
- Tipos de incidente: robo, accidente, desvío de ruta, falla mecánica y botón de pánico.
- Severidades: las mismas del historial de alertas de seguridad (alta, media, baja).
- Tiempo máximo de entrega de una alerta: 10 s. El panel consulta cada 4 s (INTERVALO_SONDEO_SEG),
  así que una alerta nueva aparece en 4 s o menos más lo que tarde la red.
"""
from datetime import datetime, timezone

from . import eventos_logica as eventos

ROL_PERMITIDO = eventos.ROL_PERMITIDO  # "coordinador_rutas" (el "administrador de rutas" de la HU)

TIPOS = {
    "robo": "Robo",
    "accidente": "Accidente",
    "desvio_ruta": "Desvío de ruta",
    "falla_mecanica": "Falla mecánica",
    "boton_panico": "Botón de pánico",
}
SEVERIDADES = {"alta": "Alta", "media": "Media", "baja": "Baja"}

TIEMPO_MAX_ENTREGA_SEG = 10
INTERVALO_SONDEO_SEG = 4  # debe ser igual a POLL_MS / 1000 en incidentesViaje.js
COMENTARIO_MIN, COMENTARIO_MAX = 3, 500


def validar_comentario(texto) -> str:
    limpio = str(texto or "").strip()
    if not COMENTARIO_MIN <= len(limpio) <= COMENTARIO_MAX:
        raise ValueError(f"El comentario debe tener entre {COMENTARIO_MIN} y {COMENTARIO_MAX} caracteres.")
    return limpio


def _fecha(valor):
    texto = str(valor or "")
    if not texto:
        return datetime.min.replace(tzinfo=timezone.utc)
    try:
        resultado = datetime.fromisoformat(texto.replace("Z", "+00:00"))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    if resultado.tzinfo is None:
        resultado = resultado.replace(tzinfo=timezone.utc)
    return resultado.astimezone(timezone.utc)


def armar_item(incidente: dict, ruta: dict | None) -> dict:
    """Une el incidente con los datos de su ruta (nombre y conductor) y agrega las etiquetas."""
    ruta = ruta or {}
    return {
        "id": incidente["id"],
        "fecha": incidente.get("fecha"),
        "ruta_id": incidente.get("ruta_id"),
        "viaje": incidente.get("ruta_id"),
        "ruta": ruta.get("nombre") or "Ruta sin nombre",
        "conductor": ruta.get("conductor") or "Sin conductor asignado",
        "tipo": incidente.get("tipo"),
        "tipo_etiqueta": TIPOS.get(incidente.get("tipo"), str(incidente.get("tipo") or "Sin tipo")),
        "severidad": incidente.get("severidad"),
        "severidad_etiqueta": SEVERIDADES.get(incidente.get("severidad"), "Sin clasificar"),
        "origen": incidente.get("origen"),
        "descripcion": incidente.get("descripcion"),
        "lat": incidente.get("lat"),
        "lng": incidente.get("lng"),
        "vista": bool(incidente.get("vista")),
        "estado": incidente.get("estado"),
        "comentario": incidente.get("comentario"),
        "atendido_en": incidente.get("atendido_en"),
    }


def ordenar(items: list[dict]) -> list[dict]:
    """Las alertas nuevas (no vistas) primero; dentro de cada grupo, la más reciente arriba."""
    return sorted(items, key=lambda i: (i["vista"], -_fecha(i["fecha"]).timestamp()))


def construir_listado(incidentes: list[dict], rutas: list[dict]) -> dict:
    """Panel de alertas activas: solo las pendientes, con el contador de no atendidas."""
    por_ruta = {str(r["id"]): r for r in rutas}
    items = ordenar([
        armar_item(i, por_ruta.get(str(i.get("ruta_id"))))
        for i in incidentes if i.get("estado") == "pendiente"
    ])
    return {
        "items": items,
        "no_atendidas": len(items),
        "nuevas": sum(not i["vista"] for i in items),
        "intervalo_seg": INTERVALO_SONDEO_SEG,
    }