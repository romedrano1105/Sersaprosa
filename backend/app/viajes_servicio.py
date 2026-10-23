"""Orquestación de «Generar ruta»: valida, geocodifica, evalúa con el agente de IA y guarda.

Todo se recibe por parámetro (clientes y funciones) para probarlo sin Supabase ni red. Orden pensado
para que, si algo falla, NO quede una ruta a medias: primero se valida, geocodifica y evalúa (sin
escribir nada) y solo después se escribe, deshaciendo lo escrito si un paso posterior falla.
"""
import uuid
from datetime import date

from . import rutas_admin, rutas_logica, viajes_logica


class ErrorViaje(Exception):
    def __init__(self, estado: int, mensaje: str, errores: dict | None = None):
        super().__init__(mensaje)
        self.estado, self.mensaje, self.errores = estado, mensaje, errores or {}


def _validar(datos) -> dict:
    limpio, errores = viajes_logica.validar_viaje(datos)
    if errores:
        raise ErrorViaje(422, viajes_logica.mensaje_de_errores(errores), errores)
    return limpio


def _geocodificar(geocodificar, campo: str, texto: str) -> dict:
    try:
        return geocodificar(texto)
    except ValueError as error:                      # dirección no encontrada
        raise ErrorViaje(422, f"{viajes_logica.ETIQUETAS[campo]}: {error}", {campo: str(error)}) from error
    except Exception as error:                       # proveedor caído
        raise ErrorViaje(502, "No fue posible ubicar las direcciones. Inténtalo de nuevo.") from error


def _evaluar(evaluar, origen: dict, destino: dict) -> dict:
    try:
        return evaluar((origen["lat"], origen["lng"]), (destino["lat"], destino["lng"]))
    except Exception as error:
        raise ErrorViaje(502, "No se pudo calcular la ruta óptima. Revisa la conexión e inténtalo de nuevo.") from error


def _falta_sql(error) -> bool:
    return str(getattr(error, "code", "")) in {"PGRST204", "42703"} or "column" in str(error).lower()


def _registrar_riesgo(cliente_usuario, ruta_id: str, limpio: dict):
    return cliente_usuario.rpc("especificar_riesgo_ruta", {
        "p_ruta_id": ruta_id, "p_monto": limpio["monto"], "p_tipo_carga_id": limpio["tipo_carga_id"],
    }).execute().data


def _resumen(ruta_id, nombre, hoy, entregas, limpio, o, d, riesgo, evaluacion):
    return {
        "ruta": {"id": ruta_id, "nombre": nombre, "fecha": hoy.isoformat(), "entregas": entregas},
        "viaje": {
            "origen": {"texto": limpio["origen"], "lat": o["lat"], "lng": o["lng"]},
            "destino": {"texto": limpio["destino"], "lat": d["lat"], "lng": d["lng"]},
            "horario": limpio["horario"], "tipo_carga_id": limpio["tipo_carga_id"], "monto": limpio["monto"],
            "nivel_riesgo": (riesgo or {}).get("nivel_riesgo") if isinstance(riesgo, dict) else None,
        },
        "evaluacion": evaluacion,
    }


def generar_viaje(datos, pedidos, *, usuario, cliente_usuario, cliente_servicio, geocodificar, evaluar, hoy: date | None = None):
    hoy = hoy or rutas_logica.hoy_el_salvador()
    limpio = _validar(datos)
    ids = []
    for p in pedidos or []:
        pid = str(p or "").strip()
        if pid and pid not in ids:
            ids.append(pid)
    if len(ids) > rutas_logica.MAX_PEDIDOS:
        raise ErrorViaje(422, f"Una ruta admite como máximo {rutas_logica.MAX_PEDIDOS} pedidos.")

    o = _geocodificar(geocodificar, "origen", limpio["origen"])
    d = _geocodificar(geocodificar, "destino", limpio["destino"])
    evaluacion = _evaluar(evaluar, o, d)      # hasta aquí no se escribió nada

    try:
        if ids:
            rutas_admin._validar_pedidos(cliente_servicio, ids)
        existentes = [f["nombre"] for f in (cliente_servicio.table("rutas_planificadas").select("nombre")
                                            .eq("fecha", hoy.isoformat()).execute().data or [])]
    except rutas_admin.ReglaDeNegocio as error:
        raise ErrorViaje(409, str(error)) from error
    except Exception as error:
        raise ErrorViaje(503, "No se pudo consultar las rutas de hoy. Revisa Supabase.") from error

    nombre = viajes_logica.nombre_de_viaje(limpio["destino"], limpio["horario"], existentes)
    ruta_id = "RT-" + uuid.uuid4().hex[:8].upper()
    try:
        cliente_servicio.table("rutas_planificadas").insert({
            "id": ruta_id, "nombre": nombre, "fecha": hoy.isoformat(), "entregas": len(ids),
            "origen_texto": limpio["origen"], "origen_lat": o["lat"], "origen_lng": o["lng"],
            "destino_texto": limpio["destino"], "destino_lat": d["lat"], "destino_lng": d["lng"],
            "hora_salida": limpio["horario"], "creado_por": usuario,
            "monto": limpio["monto"], "tipo_carga_id": limpio["tipo_carga_id"],
        }).execute()
    except Exception as error:
        if _falta_sql(error):
            raise ErrorViaje(503, "Falta aplicar backend/database/viajes_ruta.sql (y riesgo_rutas.sql) en Supabase.") from error
        raise ErrorViaje(503, "No se pudo guardar la ruta. Revisa Supabase.") from error

    def deshacer():
        try:
            cliente_servicio.table("entregas").update({"ruta": None}).eq("ruta", nombre).execute()
            cliente_servicio.table("rutas_planificadas").delete().eq("id", ruta_id).execute()
        except Exception:
            pass

    try:
        rutas_admin._marcar_pedidos(cliente_servicio, ids, nombre)
        riesgo = _registrar_riesgo(cliente_usuario, ruta_id, limpio)
    except Exception as error:
        deshacer()
        raise ErrorViaje(503, "No se pudo completar el guardado de la ruta (pedidos o nivel de riesgo). No se creó la ruta.") from error
    return _resumen(ruta_id, nombre, hoy, len(ids), limpio, o, d, riesgo, evaluacion)


def actualizar_viaje(ruta_id, datos, *, usuario, cliente_usuario, cliente_servicio, geocodificar, evaluar, hoy: date | None = None):
    """Edita origen, destino, horario, tipo de carga y monto mientras la ruta no haya salido."""
    hoy = hoy or rutas_logica.hoy_el_salvador()
    try:
        filas = cliente_servicio.table("rutas_planificadas").select("*").eq("id", ruta_id).limit(1).execute().data or []
        fila = filas[0] if filas else None
        asignada = bool(fila) and bool(cliente_servicio.table("asignaciones_ruta").select("ruta_id")
                                       .eq("ruta_id", ruta_id).eq("fecha_operativa", hoy.isoformat()).limit(1).execute().data)
    except Exception as error:
        raise ErrorViaje(503, "No se pudo consultar la ruta. Revisa Supabase.") from error
    if not fila or str(fila.get("fecha") or "")[:10] != hoy.isoformat():
        raise ErrorViaje(404, "La ruta no existe o no es de hoy.")
    if viajes_logica.ruta_ya_salio(fila, asignada):
        raise ErrorViaje(409, "La ruta ya salió (tiene conductor asignado). Desasígnala antes de editar el viaje.")
    limpio = _validar(datos)

    def lugar(campo, texto_guardado, lat, lng):
        if lat is not None and lng is not None and (texto_guardado or "").strip().lower() == limpio[campo].lower():
            return {"lat": lat, "lng": lng}               # no cambió: se reutilizan las coordenadas
        return _geocodificar(geocodificar, campo, limpio[campo])

    o = lugar("origen", fila.get("origen_texto"), fila.get("origen_lat"), fila.get("origen_lng"))
    d = lugar("destino", fila.get("destino_texto"), fila.get("destino_lat"), fila.get("destino_lng"))
    evaluacion = _evaluar(evaluar, o, d)
    try:
        cliente_servicio.table("rutas_planificadas").update({
            "origen_texto": limpio["origen"], "origen_lat": o["lat"], "origen_lng": o["lng"],
            "destino_texto": limpio["destino"], "destino_lat": d["lat"], "destino_lng": d["lng"],
            "hora_salida": limpio["horario"],
        }).eq("id", ruta_id).execute()
        riesgo = _registrar_riesgo(cliente_usuario, ruta_id, limpio)
    except Exception as error:
        if _falta_sql(error):
            raise ErrorViaje(503, "Falta aplicar backend/database/viajes_ruta.sql en Supabase.") from error
        raise ErrorViaje(503, "No se pudo guardar el cambio. Revisa Supabase.") from error
    return _resumen(ruta_id, fila["nombre"], hoy, int(fila.get("entregas") or 0), limpio, o, d, riesgo, evaluacion)
