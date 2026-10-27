"""Adaptadores de las fuentes del agente sobre datos reales del proyecto (Supabase).

  incidentes → `alertas_seguridad` (con lat/lng) y `eventos_especiales` (marchas y cierres con lat/lng)
  zonas      → hotspots calculados agrupando las alertas de los últimos 30 días en celdas de ~550 m
  tráfico    → NO existe fuente de tráfico en el proyecto: `TraficoSinDatos` devuelve vacío y el reporte lo advierte

Reciben el cliente Supabase del usuario (token del coordinador, RLS vigente). Las funciones `a_*` y
`hotspots` son puras y se prueban sin base de datos.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from . import geo
from .modelos import Incidente, TramoTrafico, Zona

GRAVEDAD_ALERTA = {"baja": 2, "media": 3, "alta": 5}
GRAVEDAD_EVENTO = {"bajo": 2, "medio": 3, "alto": 4}
TIPOS_EVENTO_CON_RIESGO = ("marcha", "cierre_vial")
VIGENCIA_ALERTA_MIN = 240
RADIO_ALERTA_M = 300.0
RADIO_EVENTO_M = 300.0
DURACION_EVENTO_POR_DEFECTO_H = 12
CELDA_GRADOS = 0.005          # ~550 m
VENTANA_HOTSPOT_DIAS = 30
PESO_ALERTA = {"alta": 2, "media": 1}
MAX_FILAS = 1000


def _fecha(valor) -> datetime | None:
    if not valor:
        return None
    try:
        f = datetime.fromisoformat(str(valor).replace("Z", "+00:00"))
    except ValueError:
        return None
    return f if f.tzinfo else f.replace(tzinfo=timezone.utc)


def _coord(fila) -> tuple[float, float] | None:
    try:
        lat, lng = float(fila.get("lat")), float(fila.get("lng"))
    except (TypeError, ValueError):
        return None
    return (lat, lng) if abs(lat) <= 90 and abs(lng) <= 180 else None


def a_incidente_alerta(fila: dict) -> Incidente | None:
    pos, cuando = _coord(fila), _fecha(fila.get("fecha"))
    if pos is None or cuando is None or fila.get("severidad") not in GRAVEDAD_ALERTA:
        return None
    return Incidente(id=str(fila.get("id")), tipo=str(fila.get("tipo") or "alerta"),
                     gravedad=GRAVEDAD_ALERTA[fila["severidad"]], ubicacion=pos, radio_m=RADIO_ALERTA_M,
                     reportado_en=cuando, vigencia_min=VIGENCIA_ALERTA_MIN, descripcion=str(fila.get("descripcion") or ""))


def a_incidente_evento(fila: dict, ahora: datetime) -> Incidente | None:
    """Marcha o cierre vial con ubicación, vigente entre su inicio y su fin (o 12 h si no hay fin)."""
    pos, ini = _coord(fila), _fecha(fila.get("inicio"))
    if pos is None or ini is None or fila.get("tipo") not in TIPOS_EVENTO_CON_RIESGO:
        return None
    fin = _fecha(fila.get("fin")) or ini + timedelta(hours=DURACION_EVENTO_POR_DEFECTO_H)
    if not ini <= ahora <= fin:
        return None
    return Incidente(id=str(fila.get("id")), tipo="bloqueo" if fila["tipo"] == "cierre_vial" else "marcha",
                     gravedad=GRAVEDAD_EVENTO.get(fila.get("impacto"), 3), ubicacion=pos,
                     radio_m=float(fila.get("radius_m") or RADIO_EVENTO_M), reportado_en=ini,
                     vigencia_min=max(1, int((fin - ini).total_seconds() // 60)), descripcion=str(fila.get("nombre") or ""))


def hotspots(alertas: list[dict], ahora: datetime) -> list[Zona]:
    """Zonas de riesgo dinámicas: celdas con suficientes alertas altas/medias en los últimos 30 días.

    Puntaje de la celda = 2 por alerta alta + 1 por media. ≥3 → nivel 3, ≥4 → nivel 4, ≥6 → nivel 5.
    Es una heurística de partida: conviene que análisis de seguridad valide o reemplace los umbrales.
    """
    desde = ahora - timedelta(days=VENTANA_HOTSPOT_DIAS)
    celdas: dict[tuple[int, int], dict] = {}
    for a in alertas:
        pos, cuando, sev = _coord(a), _fecha(a.get("fecha")), a.get("severidad")
        if pos is None or cuando is None or cuando < desde or sev not in PESO_ALERTA:
            continue
        clave = (int(pos[0] // CELDA_GRADOS), int(pos[1] // CELDA_GRADOS))
        c = celdas.setdefault(clave, {"puntos": 0, "n": 0, "tipos": {}})
        c["puntos"] += PESO_ALERTA[sev]
        c["n"] += 1
        c["tipos"][a.get("tipo") or "alerta"] = c["tipos"].get(a.get("tipo") or "alerta", 0) + 1
    zonas = []
    for (i, j), c in celdas.items():
        if c["puntos"] < 3:
            continue
        nivel = 5 if c["puntos"] >= 6 else 4 if c["puntos"] >= 4 else 3
        la0, lo0 = i * CELDA_GRADOS, j * CELDA_GRADOS
        tipo_top = max(c["tipos"], key=c["tipos"].get)
        zonas.append(Zona(id=f"HS-{i}_{j}", nombre=f"Hotspot {la0:.3f},{lo0:.3f}", nivel=nivel,
                          poligono=((la0, lo0), (la0, lo0 + CELDA_GRADOS), (la0 + CELDA_GRADOS, lo0 + CELDA_GRADOS),
                                    (la0 + CELDA_GRADOS, lo0)),
                          motivo=f"{c['n']} alertas en {VENTANA_HOTSPOT_DIAS} días (sobre todo {tipo_top})"))
    return zonas


class IncidentesSupabase:
    def __init__(self, cliente):
        self.cliente = cliente

    def activos(self, caja, ahora):
        desde = (ahora - timedelta(minutes=VIGENCIA_ALERTA_MIN)).isoformat()
        alertas = (self.cliente.table("alertas_seguridad").select("id,fecha,tipo,severidad,descripcion,lat,lng")
                   .gte("fecha", desde).gte("lat", caja[0]).lte("lat", caja[2]).gte("lng", caja[1]).lte("lng", caja[3])
                   .limit(MAX_FILAS).execute().data or [])
        eventos = (self.cliente.table("eventos_especiales").select("id,nombre,tipo,impacto,inicio,fin,lat,lng,radius_m")
                   .in_("tipo", list(TIPOS_EVENTO_CON_RIESGO)).gte("lat", caja[0]).lte("lat", caja[2])
                   .gte("lng", caja[1]).lte("lng", caja[3]).limit(MAX_FILAS).execute().data or [])
        salida = [i for i in map(a_incidente_alerta, alertas) if i and 0 <= (ahora - i.reportado_en).total_seconds() / 60 <= i.vigencia_min]
        salida += [i for i in (a_incidente_evento(e, ahora) for e in eventos) if i]
        return salida


class ZonasSupabase:
    def __init__(self, cliente, ahora: datetime | None = None):
        self.cliente, self.ahora = cliente, ahora

    def zonas(self, caja):
        ahora = self.ahora or datetime.now(timezone.utc)
        desde = (ahora - timedelta(days=VENTANA_HOTSPOT_DIAS)).isoformat()
        filas = (self.cliente.table("alertas_seguridad").select("id,fecha,tipo,severidad,lat,lng").gte("fecha", desde)
                 .in_("severidad", list(PESO_ALERTA)).gte("lat", caja[0]).lte("lat", caja[2])
                 .gte("lng", caja[1]).lte("lng", caja[3]).limit(MAX_FILAS).execute().data or [])
        return [z for z in hotspots(filas, ahora) if geo.poligono_toca_bbox(z.poligono, caja)]


class TraficoSinDatos:
    """No hay fuente de tráfico configurada: no se inventa nada. El reporte avisa de esta limitación."""
    sin_datos = True

    def tramos(self, caja) -> list[TramoTrafico]:
        return []
