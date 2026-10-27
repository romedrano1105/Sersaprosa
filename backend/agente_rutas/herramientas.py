"""Herramientas (tools) del agente y sus esquemas de Tool Calling.

El estado de una consulta vive en `Sesion`; cada herramienta lee/escribe ahí y devuelve un dict
serializable a JSON (lo que el modelo "ve"). Los números los calcula el código, nunca el modelo.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from . import geo, puntuacion
from .enrutador import Enrutador, candidatas
from .fuentes import FuenteIncidentes, FuenteTrafico, FuenteZonas
from .modelos import Evaluacion, Incidente, Punto, Ruta, TramoTrafico, Zona
from .puntuacion import Pesos

MARGEN_POR_DEFECTO_M = 800.0


@dataclass
class Sesion:
    origen: Punto
    destino: Punto
    ahora: datetime
    incidentes_src: FuenteIncidentes
    trafico_src: FuenteTrafico
    zonas_src: FuenteZonas
    enrutador: Enrutador
    pesos: Pesos = field(default_factory=Pesos)
    incidentes: list[Incidente] = field(default_factory=list)
    trafico: list[TramoTrafico] = field(default_factory=list)
    zonas: list[Zona] = field(default_factory=list)
    rutas: list[Ruta] = field(default_factory=list)
    evaluaciones: list[Evaluacion] = field(default_factory=list)
    eleccion: dict | None = None
    consultadas: set = field(default_factory=set)  # fuentes ya consultadas (se refrescan si cambia el corredor)

    def caja(self, margen_m: float = MARGEN_POR_DEFECTO_M):
        pts = [self.origen, self.destino] + [p for r in self.rutas for p in r.puntos]
        return geo.bbox(pts, margen_m)


# ---------------------------------------------------------------- herramientas

def consultar_incidentes(s: Sesion, margen_m: float = MARGEN_POR_DEFECTO_M) -> dict:
    """Reportes policiales y bloqueos vigentes en el corredor origen-destino."""
    s.consultadas.add("incidentes")
    s.incidentes = s.incidentes_src.activos(s.caja(margen_m), s.ahora)
    return {"total": len(s.incidentes), "incidentes": [{
        "id": i.id, "tipo": i.tipo, "gravedad": i.gravedad, "radio_m": i.radio_m,
        "hace_min": round((s.ahora - i.reportado_en).total_seconds() / 60), "descripcion": i.descripcion,
    } for i in sorted(s.incidentes, key=lambda x: -x.gravedad)]}


def consultar_trafico(s: Sesion, margen_m: float = MARGEN_POR_DEFECTO_M) -> dict:
    """Congestión, accidentes viales y velocidad promedio en el corredor."""
    s.consultadas.add("trafico")
    s.trafico = s.trafico_src.tramos(s.caja(margen_m))
    return {"total": len(s.trafico), "tramos": [{
        "id": t.id, "nombre": t.nombre, "tipo": t.tipo, "velocidad_kmh": t.velocidad_kmh,
        "flujo_libre_kmh": t.flujo_libre_kmh} for t in s.trafico]}


def consultar_zonas_peligrosas(s: Sesion, margen_m: float = MARGEN_POR_DEFECTO_M) -> dict:
    """Geocercas de riesgo que tocan el corredor."""
    s.consultadas.add("zonas")
    s.zonas = s.zonas_src.zonas(s.caja(margen_m))
    return {"total": len(s.zonas), "zonas": [{"id": z.id, "nombre": z.nombre, "nivel": z.nivel, "motivo": z.motivo}
                                             for z in sorted(s.zonas, key=lambda x: -x.nivel)]}


def obtener_rutas_candidatas(s: Sesion, rodear_zonas_criticas: bool = True) -> dict:
    """Pide rutas al motor (OSRM). Con `rodear_zonas_criticas` agrega desvíos que esquivan zonas de nivel alto."""
    criticas = [z for z in s.zonas if z.nivel >= s.pesos.veto_zona_nivel] if rodear_zonas_criticas else []
    s.rutas = candidatas(s.enrutador, s.origen, s.destino, criticas)
    s.evaluaciones = []
    # Los desvíos amplían el corredor: se vuelven a consultar las fuentes que ya se habían usado,
    # para que las rutas nuevas se evalúen contra TODO lo que hay a su alrededor.
    for fuente, consulta in (("incidentes", consultar_incidentes), ("trafico", consultar_trafico),
                             ("zonas", consultar_zonas_peligrosas)):
        if fuente in s.consultadas:
            consulta(s)
    return {"total": len(s.rutas), "rutas": [{
        "ruta_id": r.id, "distancia_km": round(r.distancia_m / 1000, 2), "duracion_min": round(r.duracion_s / 60, 1),
        "desvio": r.via is not None} for r in s.rutas]}


def evaluar_rutas(s: Sesion) -> dict:
    """Evalúa todas las candidatas con zonas, incidentes y tráfico ya consultados."""
    if not s.rutas:
        return {"error": "Primero llama a obtener_rutas_candidatas."}
    s.evaluaciones = [puntuacion.evaluar_ruta(r, s.zonas, s.incidentes, s.trafico, s.ahora, s.pesos) for r in s.rutas]
    mejor = puntuacion.mejor(s.evaluaciones)
    return {"mejor_segun_score": mejor.ruta.id, "evaluaciones": [e.a_dict() for e in s.evaluaciones]}


def elegir_ruta(s: Sesion, ruta_id: str, justificacion: str) -> dict:
    """Decisión final. El código la valida: no se acepta una ruta vetada si hay una alternativa sin veto."""
    ev = next((e for e in s.evaluaciones if e.ruta.id == ruta_id), None)
    if ev is None:
        return {"error": f"La ruta {ruta_id} no existe o no se evaluó. Llama a evaluar_rutas."}
    segura = puntuacion.mejor(s.evaluaciones)
    corregida = ev.vetada and not segura.vetada
    s.eleccion = {"ruta_id": segura.ruta.id if corregida else ruta_id, "justificacion_modelo": justificacion,
                  "corregida_por_validacion": corregida}
    return {"aceptada": not corregida, "ruta_final": s.eleccion["ruta_id"],
            "nota": "La ruta pedida tiene veto de seguridad; se usó la mejor sin veto." if corregida else "ok"}


FUNCIONES: dict[str, Any] = {
    "consultar_incidentes": consultar_incidentes, "consultar_trafico": consultar_trafico,
    "consultar_zonas_peligrosas": consultar_zonas_peligrosas, "obtener_rutas_candidatas": obtener_rutas_candidatas,
    "evaluar_rutas": evaluar_rutas, "elegir_ruta": elegir_ruta,
}

_margen = {"margen_m": {"type": "number", "description": "Margen en metros alrededor del corredor (por defecto 800)."}}
ESQUEMAS: list[dict] = [
    {"name": "obtener_rutas_candidatas", "description": "Obtiene rutas origen-destino del motor de rutas. Llámala PRIMERO "
     "para conocer el corredor; si hay zonas críticas, llámala de nuevo con rodear_zonas_criticas=true tras consultarlas.",
     "input_schema": {"type": "object", "properties": {"rodear_zonas_criticas": {"type": "boolean"}}}},
    {"name": "consultar_incidentes", "description": "Reportes policiales y bloqueos vigentes cerca de las rutas.",
     "input_schema": {"type": "object", "properties": _margen}},
    {"name": "consultar_trafico", "description": "Congestión, accidentes viales y velocidad promedio cerca de las rutas.",
     "input_schema": {"type": "object", "properties": _margen}},
    {"name": "consultar_zonas_peligrosas", "description": "Geocercas/hotspots de riesgo que tocan el corredor.",
     "input_schema": {"type": "object", "properties": _margen}},
    {"name": "evaluar_rutas", "description": "Calcula costo, penalización de riesgo y vetos de todas las rutas candidatas. "
     "Requiere haber consultado las tres fuentes.", "input_schema": {"type": "object", "properties": {}}},
    {"name": "elegir_ruta", "description": "Decisión final con una justificación breve en español que cite zonas, reportes "
     "y tráfico evitados, usando solo datos devueltos por las herramientas.",
     "input_schema": {"type": "object", "properties": {"ruta_id": {"type": "string"}, "justificacion": {"type": "string"}},
                      "required": ["ruta_id", "justificacion"]}},
]


def ejecutar(s: Sesion, nombre: str, argumentos: dict | None) -> dict:
    """Despacha una llamada de herramienta; los errores vuelven al modelo como datos, no como excepción."""
    f = FUNCIONES.get(nombre)
    if f is None:
        return {"error": f"Herramienta desconocida: {nombre}"}
    try:
        return f(s, **(argumentos or {}))
    except TypeError as e:
        return {"error": f"Argumentos inválidos: {e}"}
    except Exception as e:  # fuente caída, OSRM sin respuesta, etc.
        return {"error": f"{type(e).__name__}: {e}"}
