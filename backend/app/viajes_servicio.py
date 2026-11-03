"""Orquestación de «Generar ruta»: valida, geocodifica, evalúa con el agente de IA y guarda.

Todo se recibe por parámetro (clientes y funciones) para probarlo sin Supabase ni red. Orden pensado
para que, si algo falla, NO quede una ruta a medias: primero se valida, geocodifica y evalúa (sin
escribir nada) y solo después se escribe, deshaciendo lo escrito si un paso posterior falla.
"""
import logging
from datetime import date

from . import rpc_utils, rutas_logica, viajes_logica

logger = logging.getLogger(__name__)
DISTANCIA_MAXIMA_KM = 300


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


def _lugar_elegido(datos: dict, campo: str):
    """Coordenadas que el usuario eligió de la lista de sugerencias (si vienen y son válidas)."""
    try:
        lat, lng = float(datos.get(f"{campo}_lat")), float(datos.get(f"{campo}_lng"))
    except (TypeError, ValueError):
        return None
    return {"lat": lat, "lng": lng} if abs(lat) <= 90 and abs(lng) <= 180 else None


def _coordenada(punto) -> tuple[float, float] | None:
    """(lat, lng) numéricos y en rango, o None (evita mandar null/undefined al motor de rutas)."""
    try:
        lat, lng = float((punto or {}).get("lat")), float((punto or {}).get("lng"))
    except (TypeError, ValueError):
        return None
    if lat != lat or lng != lng or abs(lat) > 90 or abs(lng) > 180 or (lat == 0 and lng == 0):
        return None
    return lat, lng


def _distancia_km(a, b) -> float:
    from math import asin, cos, radians, sin, sqrt
    dlat, dlng = radians(b[0] - a[0]), radians(b[1] - a[1])
    h = sin(dlat / 2) ** 2 + cos(radians(a[0])) * cos(radians(b[0])) * sin(dlng / 2) ** 2
    return 6371 * 2 * asin(min(1.0, sqrt(h)))


def mensaje_error_ruta(error: BaseException) -> tuple[int, str]:
    """Traduce el fallo del agente o del motor de rutas a un estado HTTP y un mensaje que se pueda accionar."""
    nombre, texto = type(error).__name__, str(error)
    modulo = type(error).__module__ or ""
    if nombre == "SinAlternativa":
        return 409, "No hay otra ruta disponible además de las rechazadas."
    if "No se obtuvieron rutas candidatas" in texto or "NoRoute" in texto:
        return 422, ("No existe una ruta por calles entre el origen y el destino. "
                     "Revisa que ambos lugares estén en El Salvador y sean accesibles en vehículo.")
    if modulo.startswith("httpx") or "OSRM" in texto or isinstance(error, (ConnectionError, TimeoutError)):
        return 502, ("El motor de rutas (OSRM) no respondió. Revisa la conexión del servidor "
                     "e inténtalo de nuevo en unos minutos.")
    return 502, f"No se pudo calcular la ruta óptima ({nombre}). Revisa la conexión e inténtalo de nuevo."


def _evaluar(evaluar, origen: dict, destino: dict) -> dict:
    o, d = _coordenada(origen), _coordenada(destino)
    if o is None or d is None:
        campo = "origen" if o is None else "destino"
        mensaje = f"{viajes_logica.ETIQUETAS[campo]}: no tiene coordenadas válidas. Elige el lugar de la lista o escribe una dirección más completa."
        raise ErrorViaje(422, mensaje, {campo: mensaje})
    if _distancia_km(o, d) < 0.05:
        raise ErrorViaje(422, "El origen y el destino son el mismo lugar.", {"destino": "Debe ser distinto del origen."})
    if _distancia_km(o, d) > DISTANCIA_MAXIMA_KM:
        raise ErrorViaje(422, f"El origen y el destino deben estar a menos de {DISTANCIA_MAXIMA_KM} km.")
    try:
        return evaluar(o, d)
    except Exception as error:
        logger.exception("Falló el cálculo de la ruta óptima %s → %s.", o, d)
        estado, mensaje = mensaje_error_ruta(error)
        raise ErrorViaje(estado, mensaje) from error


def _falta_sql(error) -> bool:
    return str(getattr(error, "code", "")) in {"PGRST204", "42703"} or "column" in str(error).lower()


def _registrar_riesgo(cliente_usuario, ruta_id: str, limpio: dict, cliente_servicio=None):
    """Nivel de riesgo con la función SQL (con su auditoría). Si no existe en Supabase, se calcula aquí."""
    try:
        return cliente_usuario.rpc("especificar_riesgo_ruta", {
            "p_ruta_id": ruta_id, "p_monto": limpio["monto"], "p_tipo_carga_id": limpio["tipo_carga_id"],
        }).execute().data
    except Exception as error:
        if cliente_servicio is None or not rpc_utils.funcion_ausente(error):
            raise
    tipos = cliente_servicio.table("tipos_carga").select("id,sensibilidad").eq("id", limpio["tipo_carga_id"]).limit(1).execute().data or []
    if not tipos:
        raise ErrorViaje(422, "El tipo de carga no es válido.", {"tipo_carga_id": "El tipo de carga no es válido."})
    nivel = viajes_logica.nivel_de_riesgo(limpio["monto"], tipos[0]["sensibilidad"])
    cliente_servicio.table("rutas_planificadas").update({
        "monto": limpio["monto"], "tipo_carga_id": limpio["tipo_carga_id"], "nivel_riesgo": nivel,
    }).eq("id", ruta_id).execute()
    return {"ruta_id": ruta_id, "nivel_riesgo": nivel}


def listar_tipos_carga(cliente_usuario, cliente_servicio) -> list[dict]:
    """Tipos de carga activos. Orden: función SQL → tabla → (si está vacía) se siembran los 6 de arranque."""
    try:
        lista = cliente_usuario.rpc("listar_tipos_carga", {}).execute().data
        if isinstance(lista, list) and lista:
            return [{"id": t["id"], "nombre": t["nombre"]} for t in lista]
    except Exception:
        pass
    try:
        tabla = cliente_servicio.table("tipos_carga")
        filas = tabla.select("id,nombre").eq("activo", True).execute().data or []
        if not filas:
            tabla.insert([{"nombre": n, "sensibilidad": s} for n, s in viajes_logica.TIPOS_CARGA_BASE]).execute()
            filas = cliente_servicio.table("tipos_carga").select("id,nombre").eq("activo", True).execute().data or []
    except Exception as error:
        raise ErrorViaje(503, "No se pudieron cargar los tipos de carga: falta la tabla tipos_carga. "
                              "Ejecuta backend/database/viajes_ruta.sql en Supabase.") from error
    return sorted(({"id": t["id"], "nombre": t["nombre"]} for t in filas), key=lambda t: t["nombre"])


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

    o = _lugar_elegido(datos, "origen") or _geocodificar(geocodificar, "origen", limpio["origen"])
    d = _lugar_elegido(datos, "destino") or _geocodificar(geocodificar, "destino", limpio["destino"])
    evaluacion = _evaluar(evaluar, o, d)      # hasta aquí no se escribió nada

    try:
        existentes = [f["nombre"] for f in (cliente_usuario.table("rutas_planificadas").select("nombre")
                                            .eq("fecha", hoy.isoformat()).execute().data or [])]
    except Exception as error:
        logger.exception("No se pudieron consultar las rutas existentes para generar un viaje.")
        raise ErrorViaje(503, "No se pudo consultar las rutas de hoy. Revisa Supabase.") from error

    nombre = viajes_logica.nombre_de_viaje(limpio["destino"], limpio["horario"], existentes)
    try:
        resultado = cliente_usuario.rpc("guardar_viaje_operativo", {
            "p_nombre": nombre,
            "p_pedidos": ids,
            "p_origen": limpio["origen"],
            "p_origen_lat": o["lat"],
            "p_origen_lng": o["lng"],
            "p_destino": limpio["destino"],
            "p_destino_lat": d["lat"],
            "p_destino_lng": d["lng"],
            "p_hora_salida": limpio["horario"],
            "p_monto": limpio["monto"],
            "p_tipo_carga_id": limpio["tipo_carga_id"],
            "p_usuario": usuario,
        }).execute().data
    except Exception as error:
        code = str(getattr(error, "code", "") or "")
        if rpc_utils.funcion_ausente(error) or _falta_sql(error):
            raise ErrorViaje(
                503, "Falta aplicar las migraciones de viajes y escrituras operativas en Supabase."
            ) from error
        if code == "42501":
            raise ErrorViaje(403, "Solo el coordinador de rutas puede guardar viajes.") from error
        if code in {"22023", "P0001", "23505"}:
            raise ErrorViaje(409, str(getattr(error, "message", "Los pedidos o el nombre de ruta ya no están disponibles."))) from error
        logger.exception("No se pudo crear el viaje mediante la función SQL.")
        raise ErrorViaje(503, "No se pudo guardar la ruta. Revisa Supabase.") from error

    if not isinstance(resultado, dict) or not resultado.get("id"):
        raise ErrorViaje(502, "Supabase no devolvió una ruta válida.")
    return _resumen(
        resultado["id"], resultado.get("nombre", nombre), hoy,
        int(resultado.get("entregas", len(ids))), limpio, o, d, resultado, evaluacion,
    )


MSG_FALTA_EDITAR = "Falta aplicar backend/database/editar_viaje.sql en Supabase."


def _error_edicion(error, accion: str) -> ErrorViaje:
    """Traduce el error de las funciones SQL de «Editar viaje» a un mensaje claro."""
    codigo = str(getattr(error, "code", "") or "")
    mensaje = str(getattr(error, "message", "") or "")
    if rpc_utils.funcion_ausente(error):
        return ErrorViaje(503, MSG_FALTA_EDITAR)
    if codigo == "42501":
        return ErrorViaje(403, "Solo el coordinador de rutas puede editar viajes.")
    if codigo == "P0001":
        return ErrorViaje(409, mensaje or "La ruta ya no se puede editar.")
    if codigo == "22023":
        return ErrorViaje(422, mensaje or "Los datos del viaje no son válidos.")
    if _falta_sql(error):
        return ErrorViaje(503, "Faltan columnas de viajes en Supabase: aplica viajes_ruta.sql y riesgo_rutas.sql.")
    logger.error("Fallo al %s: %s %s", accion, codigo, mensaje or error)
    return ErrorViaje(503, f"No se pudo {accion}. Revisa Supabase.")


def actualizar_viaje(ruta_id, datos, *, usuario, cliente_usuario, cliente_servicio=None, geocodificar, evaluar,
                     hoy: date | None = None):
    """Edita origen, destino, horario, tipo de carga y monto mientras la ruta no haya salido.

    Lee y escribe con funciones SQL (SECURITY DEFINER) usando el JWT del coordinador: no depende de la clave
    service_role, que puede no tener permisos sobre las tablas.
    """
    hoy = hoy or rutas_logica.hoy_el_salvador()
    try:
        fila = cliente_usuario.rpc("consultar_viaje_editable", {"p_ruta": ruta_id}).execute().data
    except Exception as error:
        raise _error_edicion(error, "consultar la ruta") from error
    if isinstance(fila, list):
        fila = fila[0] if fila else None
    if not isinstance(fila, dict) or str(fila.get("fecha") or "")[:10] != hoy.isoformat():
        raise ErrorViaje(404, "La ruta no existe o no es de hoy.")
    if viajes_logica.ruta_ya_salio(fila, bool(fila.get("asignada"))):
        raise ErrorViaje(409, "La ruta ya salió (tiene conductor asignado). Desasígnala antes de editar el viaje.")
    limpio = _validar(datos)

    def lugar(campo, texto_guardado, lat, lng):
        if lat is not None and lng is not None and (texto_guardado or "").strip().lower() == limpio[campo].lower():
            return {"lat": lat, "lng": lng}               # no cambió: se reutilizan las coordenadas
        return _geocodificar(geocodificar, campo, limpio[campo])

    o = _lugar_elegido(datos, "origen") or lugar("origen", fila.get("origen_texto"), fila.get("origen_lat"), fila.get("origen_lng"))
    d = _lugar_elegido(datos, "destino") or lugar("destino", fila.get("destino_texto"), fila.get("destino_lat"), fila.get("destino_lng"))
    evaluacion = _evaluar(evaluar, o, d)                  # hasta aquí no se escribió nada
    try:
        resultado = cliente_usuario.rpc("actualizar_viaje_operativo", {
            "p_ruta": ruta_id,
            "p_origen": limpio["origen"], "p_origen_lat": o["lat"], "p_origen_lng": o["lng"],
            "p_destino": limpio["destino"], "p_destino_lat": d["lat"], "p_destino_lng": d["lng"],
            "p_hora_salida": limpio["horario"], "p_monto": limpio["monto"], "p_tipo_carga_id": limpio["tipo_carga_id"],
        }).execute().data
    except Exception as error:
        raise _error_edicion(error, "guardar el cambio") from error
    if isinstance(resultado, list):
        resultado = resultado[0] if resultado else None
    if not isinstance(resultado, dict) or not resultado.get("id"):
        raise ErrorViaje(502, "Supabase no confirmó el cambio del viaje.")
    return _resumen(ruta_id, resultado.get("nombre") or fila.get("nombre"), hoy,
                    int(resultado.get("entregas") or fila.get("entregas") or 0), limpio, o, d, resultado, evaluacion)
