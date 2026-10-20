"""Lógica pura para guardar una ruta planificada (sin FastAPI ni Supabase, se prueba sola).

Una ruta guardada une los pasos del flujo: toma pedidos en curso (Pedidos), crea la fila
en `rutas_planificadas` y marca cada pedido con el nombre de la ruta. Después aparece en
Empleados y Vehículos para asignarle conductor, guardias y vehículo.
"""

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
