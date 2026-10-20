"""Lógica pura de pedidos y entregas del día (FCJ1-54 a FCJ1-61). No depende de Supabase ni de FastAPI,
así se puede probar con `python -m unittest tests_entregas.py -v`.

Estados en la base de datos: pendiente · en_proceso · completada.
La página (pedidosEnCurso.js) usa: pendiente · proceso · completada.
"""
import unicodedata
from datetime import date, datetime

ROLES_PERMITIDOS = ("ejecutivo_comercial", "coordinador_rutas")
ESTADOS = ("pendiente", "proceso", "completada")
SIN_RUTA = "sin_ruta"   # valor especial del filtro de ruta

_EQUIVALENCIAS = {
    "pendiente": "pendiente",
    "en_proceso": "proceso", "en proceso": "proceso", "proceso": "proceso",
    "completada": "completada", "completado": "completada", "entregada": "completada",
}


def norm(texto) -> str:
    """Minúsculas, sin tildes y sin espacios repetidos (para comparar zonas y rutas)."""
    s = unicodedata.normalize("NFD", str(texto or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return " ".join(s.lower().split())


def normalizar_estado(valor) -> str:
    return _EQUIVALENCIAS.get(str(valor or "").strip().lower(), "pendiente")


def a_datetime(valor):
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


def es_de_la_fecha(entrega: dict, fecha: date | None = None) -> bool:
    """FCJ1-55: ¿el pedido está programado para esa fecha? (por defecto, hoy)"""
    fecha = fecha or date.today()
    f = a_datetime(entrega.get("hora_programada"))
    return bool(f) and f.date() == fecha


def formatear(entrega: dict) -> dict:
    """FCJ1-56 y FCJ1-59: deja el pedido con el formato que espera la página."""
    f = a_datetime(entrega.get("hora_programada"))
    ruta = str(entrega.get("ruta") or "").strip()
    return {
        "id": entrega.get("id"),
        "cliente": entrega.get("cliente") or "Sin cliente",
        "direccion": entrega.get("direccion") or "Sin dirección",
        "hora": f.strftime("%H:%M") if f else "--:--",
        "estado": normalizar_estado(entrega.get("estado")),
        "zona": str(entrega.get("zona") or "").strip() or "Sin zona",
        "ruta": ruta,
        "sin_ruta": not ruta,            # FCJ1-58: se resalta en la página
        "contacto": entrega.get("contacto") or "",
        "productos": entrega.get("productos") or "",
        "notas": entrega.get("notas") or "",
        "lat": entrega.get("lat"),
        "lng": entrega.get("lng"),
    }


def filtrar(entregas: list[dict], estado=None, zona=None, ruta=None) -> list[dict]:
    """FCJ1-57: filtros por estado, zona y ruta. Vacío o 'todos' = sin filtro.
    ruta='sin_ruta' deja solo los pedidos sin ruta asignada."""
    salida = entregas
    if estado and estado != "todos":
        salida = [e for e in salida if e["estado"] == estado]
    if zona and zona != "todos":
        salida = [e for e in salida if norm(e["zona"]) == norm(zona)]
    if ruta and ruta != "todos":
        if ruta == SIN_RUTA:
            salida = [e for e in salida if e["sin_ruta"]]
        else:
            salida = [e for e in salida if norm(e["ruta"]) == norm(ruta)]
    return salida


def construir_respuesta(entregas: list[dict], fecha: date | None = None,
                        estado=None, zona=None, ruta=None) -> dict:
    """Pedidos de la fecha ordenados por hora, con totales y opciones para los filtros.
    Si no hay ninguno, 'entregas' viene vacío y la página muestra el mensaje (FCJ1-60)."""
    fecha = fecha or date.today()
    del_dia = [formatear(e) for e in entregas if es_de_la_fecha(e, fecha)]
    del_dia.sort(key=lambda e: e["hora"])
    totales = {"todos": len(del_dia), "sin_ruta": sum(1 for e in del_dia if e["sin_ruta"])}
    for est in ESTADOS:
        totales[est] = sum(1 for e in del_dia if e["estado"] == est)
    return {
        "fecha": fecha.isoformat(),
        "entregas": filtrar(del_dia, estado, zona, ruta),
        "totals": totales,
        "zonas": sorted({e["zona"] for e in del_dia}),
        "rutas": sorted({e["ruta"] for e in del_dia if e["ruta"]}),
    }