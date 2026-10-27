"""Reglas puras del historial de incidentes para análisis posterior (FCJ1-22).

No depende de Supabase ni de FastAPI: se prueba con
`python -m pytest backend/tests/test_historial_incidentes.py`.

El historial usa la misma tabla que las alertas en curso (`incidentes_viaje`, FCJ1-10 / FCJ1-30):
aquí solo se agrega registrar sin duplicados, consultar con filtros y ver el detalle.
"""
import re
from datetime import date, datetime, time, timedelta, timezone

from . import incidentes_logica as alertas

ROL_PERMITIDO = alertas.ROL_PERMITIDO  # "coordinador_rutas"

# Los 5 tipos de las alertas en curso + los 2 que suma historial_incidentes.sql.
TIPOS = {**alertas.TIPOS, **alertas.TIPOS_ADICIONALES}
SEVERIDADES = alertas.SEVERIDADES
ESTADOS = {"pendiente": "Pendiente", "atendida": "Atendida"}
ORIGENES = {"conductor": "Conductor", "sistema": "Sistema"}

ZONA_HORARIA = timezone(timedelta(hours=-6))  # El Salvador no usa horario de verano
DESCRIPCION_MAX = 500
REFERENCIA_MAX = 100
RUTA_FILTRO_MAX = 80
LIMITE_POR_DEFECTO, LIMITE_MAXIMO = 25, 100
TOLERANCIA_FUTURO = timedelta(minutes=5)  # relojes un poco adelantados no deben rechazar el aviso

_CAMPOS_OBLIGATORIOS = (
    ("ruta_id", "la ruta"), ("tipo", "el tipo de incidente"), ("severidad", "la severidad"),
    ("lat", "la ubicación (latitud)"), ("lng", "la ubicación (longitud)"),
)


class DatoInvalido(ValueError):
    """Un dato del incidente o de los filtros no es válido. El mensaje se muestra tal cual."""


def _texto(valor) -> str:
    return str(valor).strip() if valor is not None else ""


def _numero(valor, nombre: str) -> float:
    try:
        if isinstance(valor, bool):
            raise ValueError
        return float(valor)
    except (TypeError, ValueError):
        raise DatoInvalido(f"{nombre} no es un número válido.") from None


def _fecha_hora(valor) -> datetime | None:
    texto = _texto(valor)
    if not texto:
        return None
    try:
        resultado = datetime.fromisoformat(texto.replace("Z", "+00:00"))
    except ValueError:
        raise DatoInvalido("La fecha del incidente no tiene un formato válido.") from None
    if resultado.tzinfo is None:
        resultado = resultado.replace(tzinfo=ZONA_HORARIA)
    return resultado.astimezone(timezone.utc)


# ---------- Registrar ----------

def validar_registro(datos: dict, ahora: datetime | None = None) -> dict:
    """Devuelve el incidente listo para guardar o lanza DatoInvalido con un mensaje claro.
    No inventa valores: si falta tipo, ruta, severidad o ubicación, se rechaza."""
    ahora = ahora or datetime.now(timezone.utc)
    faltan = [etiqueta for campo, etiqueta in _CAMPOS_OBLIGATORIOS if _texto(datos.get(campo)) == ""]
    if faltan:
        raise DatoInvalido("Falta " + ", ".join(faltan) + ".")

    tipo, severidad = _texto(datos["tipo"]).lower(), _texto(datos["severidad"]).lower()
    origen = _texto(datos.get("origen")).lower() or "sistema"
    if tipo not in TIPOS:
        raise DatoInvalido("El tipo de incidente no es válido. Use: " + ", ".join(TIPOS) + ".")
    if severidad not in SEVERIDADES:
        raise DatoInvalido("La severidad no es válida. Use: " + ", ".join(SEVERIDADES) + ".")
    if origen not in ORIGENES:
        raise DatoInvalido("El origen no es válido. Use: " + ", ".join(ORIGENES) + ".")

    lat, lng = _numero(datos["lat"], "La latitud"), _numero(datos["lng"], "La longitud")
    if not -90 <= lat <= 90 or not -180 <= lng <= 180:
        raise DatoInvalido("La ubicación está fuera de rango (latitud -90 a 90, longitud -180 a 180).")

    descripcion = _texto(datos.get("descripcion"))
    if len(descripcion) > DESCRIPCION_MAX:
        raise DatoInvalido(f"La descripción no puede pasar de {DESCRIPCION_MAX} caracteres.")
    referencia = _texto(datos.get("referencia"))
    if len(referencia) > REFERENCIA_MAX:
        raise DatoInvalido(f"La referencia no puede pasar de {REFERENCIA_MAX} caracteres.")

    fecha = _fecha_hora(datos.get("fecha")) or ahora.astimezone(timezone.utc)
    if fecha > ahora + TOLERANCIA_FUTURO:
        raise DatoInvalido("La fecha del incidente no puede estar en el futuro.")

    registro = {
        "ruta_id": _texto(datos["ruta_id"]), "tipo": tipo, "severidad": severidad, "origen": origen,
        "descripcion": descripcion, "lat": lat, "lng": lng, "fecha": fecha.isoformat(),
    }
    registro["clave"] = clave_de(registro, referencia)
    return registro


def clave_de(registro: dict, referencia: str = "") -> str:
    """Identifica al incidente para no duplicarlo. Con `referencia` (el id que le dio quien lo envía)
    el mismo aviso reenviado siempre cae en el mismo registro; sin ella, se usan ruta, tipo, origen,
    lugar (a ~10 m) y minuto: un reintento del mismo aviso no crea otro."""
    if referencia:
        return "ref:" + referencia
    minuto = datetime.fromisoformat(registro["fecha"]).astimezone(timezone.utc).strftime("%Y%m%dT%H%M")
    return "auto:{ruta_id}|{tipo}|{origen}|{lat:.4f},{lng:.4f}|{minuto}".format(minuto=minuto, **registro)


# ---------- Consultar ----------

def _dia(valor, nombre: str) -> date | None:
    texto = _texto(valor)
    if not texto:
        return None
    try:
        return date.fromisoformat(texto[:10])
    except ValueError:
        raise DatoInvalido(f"La fecha «{nombre}» no es válida (use AAAA-MM-DD).") from None


def _valor_de(lista: dict, valor, nombre: str) -> str | None:
    texto = _texto(valor).lower()
    if not texto:
        return None
    if texto not in lista:
        raise DatoInvalido(f"El filtro de {nombre} no es válido.")
    return texto


def limpiar_ruta(texto) -> str:
    """El texto de la ruta va a una búsqueda parcial: se quitan los comodines y separadores."""
    return re.sub(r"[%_\\,()*]", " ", _texto(texto))[:RUTA_FILTRO_MAX].strip()


def validar_filtros(datos: dict) -> dict:
    desde, hasta = _dia(datos.get("desde"), "desde"), _dia(datos.get("hasta"), "hasta")
    if desde and hasta and desde > hasta:
        raise DatoInvalido("La fecha «desde» no puede ser posterior a «hasta».")
    try:
        pagina = max(1, int(datos.get("pagina") or 1))
        limite = int(datos.get("limite") or LIMITE_POR_DEFECTO)
    except (TypeError, ValueError):
        raise DatoInvalido("La página no es válida.") from None
    return {
        "desde": desde, "hasta": hasta,
        "tipo": _valor_de(TIPOS, datos.get("tipo"), "tipo"),
        "severidad": _valor_de(SEVERIDADES, datos.get("severidad"), "severidad"),
        "estado": _valor_de(ESTADOS, datos.get("estado"), "estado"),
        "ruta": limpiar_ruta(datos.get("ruta")),
        "pagina": pagina, "limite": min(max(1, limite), LIMITE_MAXIMO),
    }


def limites_fecha(filtros: dict) -> tuple[str | None, str | None]:
    """«Desde» incluye todo ese día y «hasta» también (hora de El Salvador). Devuelve (>=, <) en ISO."""
    ini = datetime.combine(filtros["desde"], time.min, ZONA_HORARIA).isoformat() if filtros["desde"] else None
    fin = datetime.combine(filtros["hasta"] + timedelta(days=1), time.min, ZONA_HORARIA).isoformat() if filtros["hasta"] else None
    return ini, fin


def rango(filtros: dict) -> tuple[int, int]:
    """Posiciones (desde, hasta) inclusivas de la página pedida, para `range()` de la base."""
    inicio = (filtros["pagina"] - 1) * filtros["limite"]
    return inicio, inicio + filtros["limite"] - 1


# ---------- Presentación ----------

def armar_item(incidente: dict, ruta: dict | None) -> dict:
    ruta = ruta or {}
    return {
        "id": incidente["id"],
        "fecha": incidente.get("fecha"),
        "registrado_en": incidente.get("registrado_en"),
        "viaje": incidente.get("ruta_id"),
        "ruta": ruta.get("nombre") or "Ruta sin nombre",
        "conductor": ruta.get("conductor") or "Sin conductor asignado",
        "tipo": incidente.get("tipo"),
        "tipo_etiqueta": TIPOS.get(incidente.get("tipo"), str(incidente.get("tipo") or "Sin tipo")),
        "severidad": incidente.get("severidad"),
        "severidad_etiqueta": SEVERIDADES.get(incidente.get("severidad"), "Sin clasificar"),
        "origen": incidente.get("origen"),
        "origen_etiqueta": ORIGENES.get(incidente.get("origen"), "—"),
        "descripcion": incidente.get("descripcion"),
        "lat": incidente.get("lat"),
        "lng": incidente.get("lng"),
        "estado": incidente.get("estado"),
        "estado_etiqueta": ESTADOS.get(incidente.get("estado"), "—"),
        "comentario": incidente.get("comentario"),
        "atendido_en": incidente.get("atendido_en"),
    }


def construir_historial(incidentes: list[dict], rutas: list[dict], total: int | None, filtros: dict) -> dict:
    por_ruta = {str(r["id"]): r for r in rutas}
    items = [armar_item(i, por_ruta.get(str(i.get("ruta_id")))) for i in incidentes]
    total = len(items) if total is None else total
    return {
        "items": items, "total": total, "pagina": filtros["pagina"], "limite": filtros["limite"],
        "paginas": max(1, -(-total // filtros["limite"])),
    }


ETIQUETA_ACCION = {"registrada": "Registrado", "atendida": "Atendido"}


def armar_auditoria(filas: list[dict]) -> list[dict]:
    """Quién hizo qué y cuándo, del más antiguo al más reciente."""
    ordenadas = sorted(filas, key=lambda f: str(f.get("fecha") or ""))
    return [{
        "accion": f.get("accion") or "atendida",
        "accion_etiqueta": ETIQUETA_ACCION.get(f.get("accion") or "atendida", "Atendido"),
        "usuario_nombre": f.get("usuario_nombre"), "fecha": f.get("fecha"), "comentario": f.get("comentario"),
    } for f in ordenadas]
