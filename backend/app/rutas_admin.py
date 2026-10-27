"""Respaldo de escritura para rutas cuando faltan las funciones SQL `*_ruta_operativa`.

El camino normal son las funciones SQL (atómicas, con el token del usuario). Si Supabase
responde que la función no existe (PGRST202 / 42883), el router llama a estas funciones con
el cliente de servicio. El rol de coordinador ya se validó antes de llegar aquí. Cada función
recibe el cliente por parámetro para probarse sin Supabase, y deshace lo ya escrito si un
paso intermedio falla.
"""
import uuid

from . import rutas_logica

FUNCION_AUSENTE = {"PGRST202", "42883"}


def funcion_ausente(error) -> bool:
    return str(getattr(error, "code", "") or "") in FUNCION_AUSENTE


class ReglaDeNegocio(Exception):
    """Regla incumplida: el router la responde como 409 con este mensaje."""


def _fila(cliente, tabla, **filtros):
    consulta = cliente.table(tabla).select("*")
    for campo, valor in filtros.items():
        consulta = consulta.eq(campo, valor)
    filas = consulta.limit(1).execute().data or []
    return filas[0] if filas else None


def _marcar_pedidos(cliente, ids, nombre):
    for pid in ids:
        cliente.table("entregas").update({"ruta": nombre}).eq("id", pid).execute()


def _validar_pedidos(cliente, ids, ruta_actual=None):
    filas = cliente.table("entregas").select("id, ruta, estado").in_("id", ids).execute().data or []
    encontrados = {str(f["id"]): f for f in filas}
    faltan = [pid for pid in ids if pid not in encontrados]
    if faltan:
        raise ReglaDeNegocio("Algunos pedidos ya no existen: " + ", ".join(faltan[:3]) + ".")
    ocupados = [pid for pid, f in encontrados.items() if (f.get("ruta") or "") not in ("", ruta_actual)]
    if ocupados:
        raise ReglaDeNegocio("Hay pedidos que ya están en otra ruta: " + ", ".join(ocupados[:3]) + ".")


def guardar_ruta(cliente, nombre, pedidos, usuario, hoy=None):
    hoy = hoy or rutas_logica.hoy_el_salvador()
    _validar_pedidos(cliente, pedidos)
    ruta_id = "RT-" + uuid.uuid4().hex[:8].upper()
    cliente.table("rutas_planificadas").insert({
        "id": ruta_id, "nombre": nombre, "fecha": hoy.isoformat(), "entregas": len(pedidos),
    }).execute()
    try:
        _marcar_pedidos(cliente, pedidos, nombre)
    except Exception:
        cliente.table("rutas_planificadas").delete().eq("id", ruta_id).execute()
        raise
    return {"id": ruta_id, "nombre": nombre, "entregas": len(pedidos), "fecha": hoy.isoformat(), "usuario": usuario}


def actualizar_ruta(cliente, ruta_id, nombre, pedidos, usuario, hoy=None):
    hoy = hoy or rutas_logica.hoy_el_salvador()
    ruta = _fila(cliente, "rutas_planificadas", id=ruta_id)
    if not ruta or str(ruta.get("fecha") or "")[:10] != hoy.isoformat():
        raise ReglaDeNegocio("La ruta ya no existe o no es de hoy.")
    _validar_pedidos(cliente, pedidos, ruta_actual=ruta.get("nombre") or "")
    nombre_anterior = ruta.get("nombre") or ""
    cliente.table("entregas").update({"ruta": None}).eq("ruta", nombre_anterior).execute()
    try:
        _marcar_pedidos(cliente, pedidos, nombre)
        cliente.table("rutas_planificadas").update(
            {"nombre": nombre, "entregas": len(pedidos)}
        ).eq("id", ruta_id).execute()
    except Exception:
        # Devuelve los pedidos a su estado anterior para no dejar la ruta a medias.
        cliente.table("entregas").update({"ruta": None}).in_("id", pedidos).execute()
        raise
    return {"id": ruta_id, "nombre": nombre, "entregas": len(pedidos), "fecha": hoy.isoformat(), "usuario": usuario}


def desasignar_ruta(cliente, ruta_id, hoy=None):
    hoy = hoy or rutas_logica.hoy_el_salvador()
    asignacion = _fila(cliente, "asignaciones_ruta", ruta_id=ruta_id, fecha_operativa=hoy.isoformat())
    if not asignacion:
        raise ReglaDeNegocio("La ruta no tiene una asignación para hoy.")
    try:  # la tabla de guardias es opcional (asignaciones_guardias.sql)
        cliente.table("asignaciones_guardias").delete().eq("ruta_id", ruta_id).eq(
            "fecha_operativa", hoy.isoformat()
        ).execute()
    except Exception:
        pass
    cliente.table("asignaciones_ruta").delete().eq("ruta_id", ruta_id).eq(
        "fecha_operativa", hoy.isoformat()
    ).execute()
    cliente.table("rutas_planificadas").update({"conductor": None}).eq("id", ruta_id).execute()
    return {"ruta": ruta_id}
