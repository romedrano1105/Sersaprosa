"""Validación y cálculos puros del panel de métricas operativas."""
from datetime import date, datetime, timezone

DIAS_MAXIMOS = 365
MSG_RANGO_INVALIDO = "Por favor, seleccione un rango de fechas válido"
MSG_RANGO_MAXIMO = (
    "El rango máximo para consulta en tiempo real es de 365 días. "
    "Por favor, ajuste el filtro o exporte el reporte histórico"
)


def validar_rango(inicio: str, fin: str) -> tuple[date, date]:
    try:
        desde, hasta = date.fromisoformat(inicio), date.fromisoformat(fin)
    except (TypeError, ValueError):
        raise ValueError(MSG_RANGO_INVALIDO) from None
    if desde.isoformat() != inicio or hasta.isoformat() != fin:
        raise ValueError(MSG_RANGO_INVALIDO)
    if hasta < desde:
        raise ValueError(MSG_RANGO_INVALIDO)
    if (hasta - desde).days + 1 > DIAS_MAXIMOS:
        raise ValueError(MSG_RANGO_MAXIMO)
    return desde, hasta


def _fecha(valor):
    if not valor:
        return None
    try:
        resultado = datetime.fromisoformat(str(valor).replace("Z", "+00:00"))
    except ValueError:
        return None
    return resultado.replace(tzinfo=timezone.utc) if resultado.tzinfo is None else resultado


def construir_respuesta(rutas: list[dict], eventos: list[dict], entregas: list[dict]) -> dict:
    conteo_ia = sum(r.get("metodo_creacion") == "ia" for r in rutas)
    conteo_manual = sum(r.get("metodo_creacion") == "manual" for r in rutas)
    rutas_conocidas = conteo_ia + conteo_manual

    duraciones = []
    for entrega in entregas:
        inicio = _fecha(entrega.get("fecha_inicio_proceso"))
        fin = _fecha(entrega.get("fecha_completada_en"))
        if inicio and fin:
            minutos = (fin - inicio).total_seconds() / 60
            if minutos >= 0:
                duraciones.append(minutos)

    return {
        "rutas": {
            "optimizadas_ia": conteo_ia,
            "manuales": conteo_manual,
            "total_clasificadas": rutas_conocidas,
            "porcentaje_ia": round(conteo_ia * 100 / rutas_conocidas, 1) if rutas_conocidas else None,
            "sin_clasificar": len(rutas) - rutas_conocidas,
        },
        "incidentes_evitados": sum(
            evento.get("estado_metrica") == "mitigado" for evento in eventos
        ),
        "eventos": [
            {
                "id": evento.get("id"),
                "nombre": evento.get("nombre") or "Evento sin nombre",
                "inicio": evento.get("inicio"),
                "estado_metrica": evento.get("estado_metrica") or "sin_confirmar",
                "actualizado_en": evento.get("metrica_actualizada_en"),
            }
            for evento in eventos
        ],
        "entregas": {
            "promedio_minutos": round(sum(duraciones) / len(duraciones), 1) if duraciones else None,
            "contabilizadas": len(duraciones),
        },
    }
