"""Lógica pura de eventos especiales (FCJ1-15). No depende de Supabase ni de FastAPI,
así se puede probar con `python -m unittest tests_eventos.py`.

Misma regla de negocio que eventosEspecialesJS.js: el servidor es quien manda y
repite todas las validaciones del formulario (campos obligatorios y duplicados).
"""
import unicodedata
from datetime import date, datetime, timedelta

TIPOS = ("feriado", "marcha", "cierre_vial", "otro")
IMPACTOS = ("bajo", "medio", "alto")
VENTANA_DIAS = 30
ROL_PERMITIDO = "coordinador_rutas"


def norm(texto) -> str:
    """Minúsculas, sin tildes y sin espacios repetidos (para comparar zonas y nombres)."""
    s = unicodedata.normalize("NFD", str(texto or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return " ".join(s.lower().split())


def a_datetime(valor):
    """Acepta datetime, date o texto ISO ('YYYY-MM-DD', 'YYYY-MM-DDTHH:mm', con 'Z')."""
    if valor is None or valor == "":
        return None
    if isinstance(valor, datetime):
        return valor
    if isinstance(valor, date):
        return datetime(valor.year, valor.month, valor.day)
    try:
        return datetime.fromisoformat(str(valor).replace("Z", "+00:00"))
    except ValueError:
        return None


def solo_dia(valor) -> date | None:
    d = a_datetime(valor)
    return d.date() if d else None


def rango_ventana(hoy: date | None = None) -> tuple[date, date]:
    hoy = hoy or date.today()
    return hoy, hoy + timedelta(days=VENTANA_DIAS)


def en_ventana(evento: dict, hoy: date | None = None) -> bool:
    """¿El evento cae (aunque sea en parte) dentro de los próximos 30 días, contando hoy?"""
    d0, d1 = rango_ventana(hoy)
    ini = solo_dia(evento.get("inicio"))
    fin = solo_dia(evento.get("fin")) or ini
    return bool(ini) and ini <= d1 and fin >= d0


def rutas_afectadas(evento: dict, rutas: list[dict]) -> list[dict]:
    """Rutas planificadas que afecta un evento: misma zona y fecha dentro de su rango.
    Un evento de zona 'Nacional' (p. ej. un feriado) afecta a todas las rutas de esos días."""
    ini = solo_dia(evento.get("inicio"))
    fin = solo_dia(evento.get("fin")) or ini
    if not ini:
        return []
    nacional = norm(evento.get("zona")) == "nacional"
    salida = []
    for r in rutas:
        f = solo_dia(r.get("fecha"))
        if f and ini <= f <= fin and (nacional or norm(r.get("zona")) == norm(evento.get("zona"))):
            salida.append(r)
    return salida


def buscar_duplicado(datos: dict, existentes: list[dict]) -> dict | None:
    """Mismo nombre + fecha + zona, o mismo tipo + fecha + hora + zona."""
    ini = a_datetime(datos.get("inicio"))
    if not ini:
        return None
    for e in existentes:
        ei = a_datetime(e.get("inicio"))
        if not ei or ei.date() != ini.date() or norm(e.get("zona")) != norm(datos.get("zona")):
            continue
        if norm(e.get("nombre")) == norm(datos.get("nombre")):
            return e
        if e.get("tipo") == datos.get("tipo") and (ei.hour, ei.minute) == (ini.hour, ini.minute):
            return e
    return None


def validar_evento(datos: dict, existentes: list[dict], hoy: date | None = None) -> list[str]:
    """Devuelve la lista de errores del registro manual; vacía = válido."""
    errs = []
    nombre = (datos.get("nombre") or "").strip()
    if not nombre:
        errs.append("El nombre del evento es obligatorio.")
    elif len(nombre) > 120:
        errs.append("El nombre no puede pasar de 120 caracteres.")
    if datos.get("tipo") not in TIPOS:
        errs.append("Elija el tipo de evento.")
    if datos.get("impacto") not in IMPACTOS:
        errs.append("Elija el nivel de impacto.")
    if not (datos.get("zona") or "").strip():
        errs.append("La zona afectada es obligatoria.")
    ini = a_datetime(datos.get("inicio"))
    if not ini:
        errs.append("La fecha y hora son obligatorias.")
    else:
        d0, d1 = rango_ventana(hoy)
        if not (d0 <= ini.date() <= d1):
            errs.append(f"La fecha debe estar entre hoy y los próximos {VENTANA_DIAS} días.")
    lat, lng = datos.get("lat"), datos.get("lng")
    if (lat is None) != (lng is None):
        errs.append("Para ubicar el evento en el mapa indique latitud y longitud, o deje ambas vacías.")
    elif lat is not None and not (abs(float(lat)) <= 90 and abs(float(lng)) <= 180):
        errs.append("Latitud o longitud fuera de rango.")
    if errs:
        return errs
    dup = buscar_duplicado(datos, existentes)
    if dup:
        errs.append(f"Ya existe un evento parecido: «{dup.get('nombre')}» ({dup.get('tipo')}) en {dup.get('zona')}.")
    return errs


def construir_respuesta(eventos: list[dict], rutas: list[dict], auditoria: list[dict], hoy: date | None = None) -> dict:
    """Arma la respuesta del endpoint de listado. 'rutas_afectadas' sale SIEMPRE de la
    planificación real (misma zona y fecha), nunca de un campo guardado que pueda quedar viejo."""
    visibles = sorted((e for e in eventos if en_ventana(e, hoy)), key=lambda e: a_datetime(e["inicio"]))
    salida = []
    for e in visibles:
        item = dict(e)
        item["rutas_afectadas"] = [r["id"] for r in rutas_afectadas(e, rutas)]
        salida.append(item)
    return {"events": salida, "routes": rutas, "audit": auditoria, "totals": {"events": len(salida)}}
