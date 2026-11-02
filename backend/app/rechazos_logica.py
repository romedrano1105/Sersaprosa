"""Reglas puras del rechazo de rutas (sin FastAPI ni Supabase, se prueban solas)."""
from __future__ import annotations

MOTIVO_MIN, MOTIVO_MAX = 3, 200
COMENTARIO_MAX = 500
MAX_PUNTOS = 5000

SIN_RUTA = "sin_ruta"
MOTOR_NO_RESPONDE = "motor_no_responde"
TODAS_VETADAS = "todas_vetadas"

MENSAJES_SIN_ALTERNATIVA = {
    SIN_RUTA: "No hay otra ruta disponible entre el origen y el destino.",
    MOTOR_NO_RESPONDE: "El motor de rutas no respondió.",
    TODAS_VETADAS: "Todas las alternativas tienen veto de seguridad por riesgo.",
}


def validar_rechazo(motivo, comentario) -> tuple[str, str | None]:
    motivo = " ".join(str(motivo or "").split())
    if not motivo:
        raise ValueError("El motivo del rechazo es obligatorio.")
    if not MOTIVO_MIN <= len(motivo) <= MOTIVO_MAX:
        raise ValueError(f"El motivo debe tener entre {MOTIVO_MIN} y {MOTIVO_MAX} caracteres.")
    comentario = " ".join(str(comentario or "").split())
    if len(comentario) > COMENTARIO_MAX:
        raise ValueError(f"El comentario admite como máximo {COMENTARIO_MAX} caracteres.")
    return motivo, (comentario or None)


def limpiar_trazado(geometria) -> list[tuple[float, float]]:
    if not isinstance(geometria, (list, tuple)) or len(geometria) < 2:
        raise ValueError("Falta el trazado de la ruta que se rechaza.")
    if len(geometria) > MAX_PUNTOS:
        raise ValueError("El trazado de la ruta es demasiado largo.")
    puntos = []
    for p in geometria:
        try:
            lat, lng = float(p[0]), float(p[1])
        except (TypeError, ValueError, IndexError, KeyError):
            raise ValueError("El trazado de la ruta no es válido.") from None
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise ValueError("El trazado de la ruta tiene coordenadas fuera de rango.")
        puntos.append((round(lat, 6), round(lng, 6)))
    return puntos


def propuesta_para_guardar(ruta_elegida: dict, trazado: list[tuple[float, float]]) -> dict:
    def numero(clave):
        try:
            return round(float(ruta_elegida.get(clave)), 2)
        except (TypeError, ValueError):
            return None
    return {
        "ruta_id": str(ruta_elegida.get("ruta_id") or "")[:20] or None,
        "distancia_km": numero("distancia_km"),
        "duracion_min": numero("duracion_min_ajustada"),
        "geometria": [list(p) for p in trazado],
    }


def trazados_rechazados(filas) -> list[list[tuple[float, float]]]:
    trazados = []
    for fila in filas or []:
        geometria = ((fila or {}).get("propuesta") or {}).get("geometria")
        try:
            trazados.append(limpiar_trazado(geometria))
        except ValueError:
            continue
    return trazados


def nivel_trayecto(evaluada: dict) -> str:
    if (evaluada or {}).get("vetada"):
        return "Alto"
    return "Medio" if (evaluada or {}).get("hallazgos") else "Bajo"


def error_sin_alternativa(codigo: str) -> dict:
    return {"codigo": codigo, "mensaje": MENSAJES_SIN_ALTERNATIVA[codigo]}


def fila_historial(fila: dict) -> dict:
    return {
        "id": fila.get("id"),
        "motivo": fila.get("motivo") or "",
        "comentario": fila.get("comentario") or "",
        "usuario": fila.get("usuario") or "",
        "fecha": fila.get("fecha"),
        "resultado": fila.get("resultado") or "pendiente",
        "error": fila.get("error") or "",
        "distancia_km": ((fila.get("propuesta") or {}).get("distancia_km")),
    }