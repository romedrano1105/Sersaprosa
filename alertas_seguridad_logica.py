"""Reglas puras para el historial paginado de alertas de seguridad."""
from datetime import date, datetime, time, timedelta, timezone

RETENCION_DIAS = 90


class InconsistenciaAlertas(Exception):
    """El contador materializado de un viaje no coincide con sus alertas."""


def _fecha(valor):
    if isinstance(valor, datetime):
        resultado = valor
    else:
        texto = str(valor or "")
        if not texto:
            return None
        try:
            resultado = datetime.fromisoformat(texto.replace("Z", "+00:00"))
        except ValueError:
            return None
    if resultado.tzinfo is None:
        resultado = resultado.replace(tzinfo=timezone.utc)
    return resultado.astimezone(timezone.utc)


def construir_respuesta(viajes, alertas, filtros, pagina, tamano, ahora=None):
    ahora = ahora or datetime.now(timezone.utc)
    if ahora.tzinfo is None:
        ahora = ahora.replace(tzinfo=timezone.utc)
    desde_retencion = ahora - timedelta(days=RETENCION_DIAS)
    viajes_por_id = {
        str(viaje["id"]): viaje for viaje in viajes
        if _fecha(viaje.get("fecha_finalizacion")) and desde_retencion <= _fecha(viaje["fecha_finalizacion"]) <= ahora
    }
    conteos = {viaje_id: 0 for viaje_id in viajes_por_id}
    por_viaje = {viaje_id: [] for viaje_id in viajes_por_id}
    for alerta in alertas:
        viaje_id = str(alerta.get("viaje_id"))
        if viaje_id not in viajes_por_id:
            continue
        por_viaje[viaje_id].append(alerta)
        conteos[viaje_id] += 1

    for viaje_id, viaje in viajes_por_id.items():
        registrado = viaje.get("alertas_count")
        if registrado is None or int(registrado) != conteos[viaje_id]:
            raise InconsistenciaAlertas(
                f"El viaje {viaje_id} registra {registrado} alerta(s), pero se encontraron {conteos[viaje_id]}."
            )

    todos = []
    for viaje_id, grupo in por_viaje.items():
        viaje = viajes_por_id[viaje_id]
        for alerta in grupo:
            todos.append({
                **alerta,
                "viaje_id": viaje_id,
                "viaje": viaje_id,
                "ruta": viaje.get("ruta"),
                "conductor": viaje.get("conductor"),
                "fecha_viaje": viaje.get("fecha_finalizacion"),
            })
    todos.sort(key=lambda alerta: _fecha(alerta.get("fecha")) or datetime.min.replace(tzinfo=timezone.utc), reverse=True)

    inicio = filtros.get("fecha_desde")
    fin = filtros.get("fecha_hasta")
    inicio_dt = datetime.combine(date.fromisoformat(inicio), time.min, timezone.utc) if inicio else None
    fin_dt = datetime.combine(date.fromisoformat(fin), time.max, timezone.utc) if fin else None

    def coincide(alerta):
        fecha_alerta = _fecha(alerta.get("fecha"))
        return (
            (inicio_dt is None or (fecha_alerta and fecha_alerta >= inicio_dt))
            and (fin_dt is None or (fecha_alerta and fecha_alerta <= fin_dt))
            and (not filtros.get("tipo") or alerta.get("tipo") == filtros["tipo"])
            and (not filtros.get("severidad") or alerta.get("severidad") == filtros["severidad"])
            and (not filtros.get("conductor") or alerta.get("conductor") == filtros["conductor"])
            and (not filtros.get("ruta") or alerta.get("ruta") == filtros["ruta"])
            and (not filtros.get("estado") or alerta.get("estado") == filtros["estado"])
        )

    filtrados = [alerta for alerta in todos if coincide(alerta)]
    pendientes = sum(alerta.get("estado") == "pendiente" for alerta in todos)
    pendientes_filtrados = sum(alerta.get("estado") == "pendiente" for alerta in filtrados)
    inicio_pagina = (pagina - 1) * tamano
    pagina_items = filtrados[inicio_pagina:inicio_pagina + tamano]
    return {
        "items": pagina_items,
        "total": len(filtrados),
        "page": pagina,
        "page_size": tamano,
        "pending_count": pendientes,
        "pending_filtered": pendientes_filtrados,
        "pending_outside_filters": pendientes - pendientes_filtrados,
        "integrity": {"ok": True, "checked_trips": len(viajes_por_id)},
        "options": {
            "tipos": sorted({str(alerta.get("tipo")) for alerta in todos if alerta.get("tipo")}),
            "conductores": sorted({str(alerta.get("conductor")) for alerta in todos if alerta.get("conductor")}),
            "rutas": sorted({str(alerta.get("ruta")) for alerta in todos if alerta.get("ruta")}),
        },
    }
