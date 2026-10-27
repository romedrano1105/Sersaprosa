"""Reglas puras de las notificaciones del administrador de rutas (FCJ1-16).

No depende de Supabase ni de FastAPI: se prueba con
`python -m pytest backend/tests/test_notificaciones.py`.

Un "hecho" es cualquier cosa que puede avisarse: un evento especial, una alerta de
seguridad, un choque o una emergencia. Todos se normalizan al mismo formato y se
cruzan con las rutas planificadas (misma zona y fecha, o la misma ruta si el hecho ya
trae su ruta). Cada coincidencia genera UNA sola notificación por (origen, id, ruta).
"""
from datetime import date, datetime, timedelta

from . import eventos_logica as eventos

ORIGENES = ("evento", "alerta", "choque", "emergencia")
URGENCIAS = ("alta", "media", "baja")
COLORES = {"alta": "roja", "media": "naranja", "baja": "amarilla"}
SIN_CLASIFICAR = "sin_clasificar"
ROL_PERMITIDO = eventos.ROL_PERMITIDO
VENTANA_ALERTAS_DIAS = 7  # una alerta de un viaje ya hecho avisa durante una semana

_IMPACTO_A_URGENCIA = {"alto": "alta", "medio": "media", "bajo": "baja"}


def urgencia_valida(valor) -> str | None:
    """Devuelve 'alta' | 'media' | 'baja' o None si el hecho no trae una urgencia válida.
    Nunca inventa un valor por defecto: None se muestra como 'sin clasificar'."""
    texto = eventos.norm(valor)
    texto = _IMPACTO_A_URGENCIA.get(texto, texto)
    return texto if texto in URGENCIAS else None


def color_de(urgencia) -> str:
    return COLORES.get(urgencia, SIN_CLASIFICAR)


# ---------- Normalización de cada fuente ----------

def hecho_de_evento(evento: dict) -> dict:
    return {
        "origen": "evento", "origen_id": str(evento.get("id")),
        "titulo": str(evento.get("nombre") or "Evento especial"),
        "zona": evento.get("zona") or "",
        "inicio": evento.get("inicio"), "fin": evento.get("fin"),
        "urgencia": urgencia_valida(evento.get("impacto")),
        "ruta_nombre": None,
    }


def hecho_de_alerta(alerta: dict, viaje: dict | None) -> dict:
    viaje = viaje or {}
    return {
        "origen": "alerta", "origen_id": str(alerta.get("id")),
        "titulo": str(alerta.get("tipo") or "Alerta de seguridad"),
        "zona": "",
        "inicio": alerta.get("fecha"), "fin": None,
        "urgencia": urgencia_valida(alerta.get("severidad")),
        "ruta_nombre": viaje.get("ruta"),
    }


def hecho_de_incidente(incidente: dict) -> dict | None:
    """Choques y emergencias (tabla incidentes_ruta). Otro tipo no se notifica."""
    tipo = eventos.norm(incidente.get("tipo"))
    if tipo not in ("choque", "emergencia"):
        return None
    return {
        "origen": tipo, "origen_id": str(incidente.get("id")),
        "titulo": str(incidente.get("titulo") or tipo.capitalize()),
        "zona": incidente.get("zona") or "",
        "inicio": incidente.get("fecha"), "fin": None,
        "urgencia": urgencia_valida(incidente.get("urgencia")),
        "ruta_nombre": incidente.get("ruta"),
    }


# ---------- Coincidencia con rutas ----------

def rutas_que_coinciden(hecho: dict, rutas: list[dict], hoy: date | None = None) -> list[dict]:
    """Rutas planificadas afectadas por el hecho.
    - Si el hecho ya trae su ruta (alertas y algunos incidentes): la ruta con ese nombre.
      Las alertas solo avisan durante VENTANA_ALERTAS_DIAS desde su fecha.
    - Si no: misma zona y fecha, con la misma regla que eventos especiales
      (una zona 'Nacional' afecta a todas las rutas de esos días)."""
    if hecho.get("ruta_nombre"):
        ini = eventos.solo_dia(hecho.get("inicio"))
        if hecho["origen"] == "alerta" and ini:
            hoy = hoy or date.today()
            if not (ini <= hoy <= ini + timedelta(days=VENTANA_ALERTAS_DIAS)):
                return []
        nombre = eventos.norm(hecho["ruta_nombre"])
        return [r for r in rutas if eventos.norm(r.get("nombre")) == nombre]
    return eventos.rutas_afectadas(
        {"inicio": hecho.get("inicio"), "fin": hecho.get("fin"), "zona": hecho.get("zona")}, rutas)


# ---------- Generación sin duplicados ----------

def clave(origen, origen_id, ruta_id) -> tuple[str, str, str]:
    return (str(origen), str(origen_id), str(ruta_id))


def generar(hechos: list[dict], rutas: list[dict], existentes: set[tuple], hoy: date | None = None) -> list[dict]:
    """Notificaciones nuevas: una por (origen, id, ruta) que todavía no exista.
    También deduplica dentro de la misma tanda."""
    vistas = set(existentes)
    nuevas = []
    for hecho in hechos:
        if not hecho or hecho["origen"] not in ORIGENES or not hecho.get("origen_id"):
            continue
        for ruta in rutas_que_coinciden(hecho, rutas, hoy):
            k = clave(hecho["origen"], hecho["origen_id"], ruta["id"])
            if k in vistas:
                continue
            vistas.add(k)
            inicio = eventos.a_datetime(hecho.get("inicio"))
            nuevas.append({
                "origen": hecho["origen"], "origen_id": hecho["origen_id"],
                "ruta_id": str(ruta["id"]),
                "ruta": ruta.get("nombre") or str(ruta["id"]),
                "titulo": hecho["titulo"][:160],
                "zona": hecho.get("zona") or ruta.get("zona") or "",
                "fecha": inicio.isoformat() if inicio else None,
                "urgencia": hecho.get("urgencia"),  # None = sin clasificar, sin color inventado
            })
    return nuevas


# ---------- Presentación ----------

_ORDEN_URGENCIA = {"alta": 0, "media": 1, "baja": 2}


def ordenar(notificaciones: list[dict]) -> list[dict]:
    """Más urgentes primero y, dentro de cada nivel, la más reciente. Sin clasificar al final."""
    def fecha(n):
        d = eventos.a_datetime(n.get("fecha") or n.get("creada_en"))
        return d.timestamp() if d else 0
    return sorted(notificaciones, key=lambda n: (_ORDEN_URGENCIA.get(n.get("urgencia"), 3), -fecha(n)))


def con_color(notificacion: dict) -> dict:
    return {**notificacion, "color": color_de(notificacion.get("urgencia"))}


def resumen(notificaciones: list[dict]) -> dict:
    sin_leer = [n for n in notificaciones if not n.get("leida")]
    return {
        "total": len(notificaciones),
        "no_leidas": len(sin_leer),
        "roja": sum(1 for n in sin_leer if n.get("urgencia") == "alta"),
        "naranja": sum(1 for n in sin_leer if n.get("urgencia") == "media"),
        "amarilla": sum(1 for n in sin_leer if n.get("urgencia") == "baja"),
        "sin_clasificar": sum(1 for n in notificaciones if n.get("urgencia") not in URGENCIAS),
    }


def construir_respuesta(notificaciones: list[dict], auditoria: list[dict]) -> dict:
    ordenadas = [con_color(n) for n in ordenar(notificaciones)]
    return {"items": ordenadas, "resumen": resumen(notificaciones), "audit": auditoria}
