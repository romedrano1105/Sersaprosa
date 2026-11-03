"""Lógica pura de pedidos y entregas del día (FCJ1-54 a FCJ1-61). No depende de Supabase ni de FastAPI,
así se puede probar con `python -m unittest tests_entregas.py -v`.

Estados en la base de datos: pendiente · en_proceso · completada.
La página (pedidosEnCurso.js) usa: pendiente · proceso · completada.
"""
import unicodedata
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

ZONA_HORARIA = ZoneInfo("America/El_Salvador")

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


def hoy_el_salvador() -> date:
    return datetime.now(ZONA_HORARIA).date()


def limites_utc(fecha: date) -> tuple[str, str]:
    inicio_local = datetime.combine(fecha, time.min, tzinfo=ZONA_HORARIA)
    fin_local = inicio_local + timedelta(days=1)
    return (
        inicio_local.astimezone(timezone.utc).isoformat(),
        fin_local.astimezone(timezone.utc).isoformat(),
    )


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
    fecha = fecha or hoy_el_salvador()
    f = a_datetime(entrega.get("hora_programada"))
    if not f:
        return False
    fecha_local = f.astimezone(ZONA_HORARIA).date() if f.tzinfo else f.date()
    return fecha_local == fecha


# Caja de El Salvador (con margen). Una coordenada fuera de aquí casi siempre es lat/lng invertidos o un 0,0.
CAJA_EL_SALVADOR = (12.9, -90.3, 14.6, -87.5)   # lat_min, lng_min, lat_max, lng_max
TEXTOS_VACIOS = {"", "sin direccion", "sin zona", "sin cliente", "n/a", "na", "-", "--"}


def coordenadas(lat, lng) -> tuple[float, float] | None:
    """(lat, lng) como números válidos dentro de El Salvador, o None.

    Acepta texto ("13.69"), corrige lat/lng invertidos y descarta null, NaN, 0,0 y puntos fuera del país,
    para que la página nunca reciba undefined/null ni mande un destino absurdo al motor de rutas.
    """
    try:
        la, lo = float(str(lat).strip().replace(",", ".")), float(str(lng).strip().replace(",", "."))
    except (TypeError, ValueError):
        return None
    if la != la or lo != lo:                      # NaN
        return None
    la0, lo0, la1, lo1 = CAJA_EL_SALVADOR
    if la0 <= la <= la1 and lo0 <= lo <= lo1:
        return la, lo
    if la0 <= lo <= la1 and lo0 <= la <= lo1:     # vienen invertidas
        return lo, la
    return None


def _util(texto) -> str:
    t = " ".join(str(texto or "").split())
    return "" if norm(t) in TEXTOS_VACIOS else t


def consultas_ubicacion(entrega: dict) -> list[tuple[str, str]]:
    """Textos para geocodificar un pedido sin coordenadas, del más preciso al menos: [(texto, precision)].

    precision = "direccion" (la dirección del pedido) o "zona" (centro aproximado del municipio/colonia).
    """
    direccion, zona = _util(entrega.get("direccion")), _util(entrega.get("zona"))
    candidatos = []
    if direccion and zona and norm(zona) not in norm(direccion):
        candidatos.append((f"{direccion}, {zona}, El Salvador", "direccion"))
    if direccion:
        candidatos.append((f"{direccion}, El Salvador", "direccion"))
    if zona:
        candidatos.append((f"{zona}, El Salvador", "zona"))
    vistos, salida = set(), []
    for texto, precision in candidatos:
        if len(texto) >= 3 and norm(texto) not in vistos:
            vistos.add(norm(texto))
            salida.append((texto, precision))
    return salida


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
        **_lat_lng(entrega),
    }


def _lat_lng(entrega: dict) -> dict:
    pos = coordenadas(entrega.get("lat"), entrega.get("lng"))
    return {"lat": pos[0], "lng": pos[1], "ubicada": True} if pos else {"lat": None, "lng": None, "ubicada": False}


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
    fecha = fecha or hoy_el_salvador()
    del_dia = [formatear(e) for e in entregas if es_de_la_fecha(e, fecha)]
    del_dia.sort(key=lambda e: e["hora"])
    totales = {"todos": len(del_dia), "sin_ruta": sum(1 for e in del_dia if e["sin_ruta"]),
               "sin_ubicacion": sum(1 for e in del_dia if not e["ubicada"])}
    for est in ESTADOS:
        totales[est] = sum(1 for e in del_dia if e["estado"] == est)
    return {
        "fecha": fecha.isoformat(),
        "entregas": filtrar(del_dia, estado, zona, ruta),
        "totals": totales,
        "zonas": sorted({e["zona"] for e in del_dia}),
        "rutas": sorted({e["ruta"] for e in del_dia if e["ruta"]}),
    }

MAX_UBICAR = 25   # pedidos por solicitud: el geocodificador público admite ~1 consulta por segundo


def ubicar_pedidos(filas: list[dict], geocodificar, guardar=None) -> dict:
    """Coordenadas para pedidos que no las tienen, a partir de su dirección (o, si no, de su zona).

    `geocodificar(texto)` → {lat, lng, label}; lanza ValueError si no encuentra el lugar y otra excepción si el
    servicio falla. `guardar(id, lat, lng)` persiste en Supabase para no volver a geocodificar.
    Nunca inventa coordenadas: lo que no se pudo ubicar vuelve en `sin_ubicar` con el motivo.
    """
    ubicadas, sin_ubicar, avisos = [], [], []
    servicio_caido = False
    for fila in filas or []:
        pid = fila.get("id")
        pos = coordenadas(fila.get("lat"), fila.get("lng"))
        if pos:
            ubicadas.append({"id": pid, "lat": pos[0], "lng": pos[1], "precision": "guardada", "guardada": True})
            continue
        consultas = consultas_ubicacion(fila)
        if not consultas:
            sin_ubicar.append({"id": pid, "motivo": "El pedido no tiene dirección ni zona para ubicarlo."})
            continue
        if servicio_caido:
            sin_ubicar.append({"id": pid, "motivo": "El servicio de direcciones no respondió."})
            continue
        encontrado = None
        for texto, precision in consultas:
            try:
                lugar = geocodificar(texto)
            except ValueError:
                continue
            except Exception:  # noqa: BLE001 — proveedor caído: no se insiste con los demás pedidos
                servicio_caido = True
                break
            pos = coordenadas((lugar or {}).get("lat"), (lugar or {}).get("lng"))
            if pos:
                encontrado = {"id": pid, "lat": pos[0], "lng": pos[1], "precision": precision,
                              "etiqueta": (lugar or {}).get("label") or texto}
                break
        if not encontrado:
            sin_ubicar.append({"id": pid, "motivo": "El servicio de direcciones no respondió." if servicio_caido
                               else "No se encontró la dirección en El Salvador. Corrígela o agrega lat/lng en Supabase."})
            continue
        encontrado["guardada"] = False
        if guardar:
            try:
                guardar(pid, encontrado["lat"], encontrado["lng"])
                encontrado["guardada"] = True
            except Exception:  # noqa: BLE001 — se usa igual para trazar, pero se avisa
                avisos.append("No se pudieron guardar algunas coordenadas en Supabase (revisa entregas_coordenadas.sql); "
                              "se usan solo para trazar esta vez.")
        ubicadas.append(encontrado)
    aproximadas = sum(1 for u in ubicadas if u["precision"] == "zona")
    if aproximadas:
        avisos.append(f"{aproximadas} pedido(s) se ubicaron solo por su zona (ubicación aproximada). Revisa su dirección.")
    return {"ubicadas": ubicadas, "sin_ubicar": sin_ubicar, "avisos": list(dict.fromkeys(avisos))}
