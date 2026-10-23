"""Lógica pura para guardar una ruta planificada (sin FastAPI ni Supabase, se prueba sola).

Una ruta guardada une los pasos del flujo: toma pedidos en curso (Pedidos), crea la fila
en `rutas_planificadas` y marca cada pedido con el nombre de la ruta. Después aparece en
Empleados y Vehículos para asignarle conductor, guardias y vehículo.
"""

from datetime import date, datetime
from zoneinfo import ZoneInfo

ZONA_HORARIA = ZoneInfo("America/El_Salvador")
MAX_PEDIDOS = 50
NOMBRE_MIN, NOMBRE_MAX = 3, 80


def validar_ruta(nombre, pedidos) -> tuple[str, list[str]]:
    """Normaliza y valida la solicitud. Devuelve (nombre, ids únicos en el mismo orden).

    Lanza ValueError con un mensaje listo para mostrar al usuario.
    """
    nombre = " ".join(str(nombre or "").split())
    if not NOMBRE_MIN <= len(nombre) <= NOMBRE_MAX:
        raise ValueError(f"El nombre de la ruta debe tener entre {NOMBRE_MIN} y {NOMBRE_MAX} caracteres.")
    if not isinstance(pedidos, (list, tuple)):
        raise ValueError("Elige al menos un pedido para la ruta.")
    ids: list[str] = []
    for pedido in pedidos:
        pid = str(pedido or "").strip()
        if pid and pid not in ids:
            ids.append(pid)
    if not ids:
        raise ValueError("Elige al menos un pedido para la ruta.")
    if len(ids) > MAX_PEDIDOS:
        raise ValueError(f"Una ruta admite como máximo {MAX_PEDIDOS} pedidos.")
    return nombre, ids


def hoy_el_salvador(ahora: datetime | None = None) -> date:
    """Fecha de hoy en El Salvador (las rutas se planifican por día local, no por UTC)."""
    return (ahora or datetime.now(ZONA_HORARIA)).astimezone(ZONA_HORARIA).date()


def rutas_de_hoy(filas, hoy: date) -> list[dict]:
    """Rutas planificadas de la fecha, con solo los campos que usa la página, ordenadas por nombre."""
    iso = hoy.isoformat()
    rutas = []
    for fila in filas or []:
        if str(fila.get("fecha") or "")[:10] != iso:
            continue
        ruta = {
            "id": str(fila.get("id")),
            "nombre": str(fila.get("nombre") or ""),
            "zona": str(fila.get("zona") or ""),
            "fecha": iso,
            "entregas": int(fila.get("entregas") or 0),
            "conductor": fila.get("conductor") or None,
        }
        if fila.get("destino_lat") is not None and fila.get("origen_lat") is not None:
            # Rutas creadas con «Generar ruta» (viajes_logica): origen, destino, horario, carga y riesgo.
            ruta["viaje"] = {
                "origen": {"texto": fila.get("origen_texto") or "", "lat": fila["origen_lat"], "lng": fila["origen_lng"]},
                "destino": {"texto": fila.get("destino_texto") or "", "lat": fila["destino_lat"], "lng": fila["destino_lng"]},
                "horario": str(fila.get("hora_salida") or "")[:5],
                "tipo_carga_id": fila.get("tipo_carga_id"),
                "monto": fila.get("monto"),
                "nivel_riesgo": fila.get("nivel_riesgo"),
            }
        rutas.append(ruta)
    return sorted(rutas, key=lambda r: r["nombre"].lower())
