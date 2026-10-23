"""Agente: orquesta las herramientas con un LLM (Tool Calling) o, sin API key, de forma determinista.

Reparto de responsabilidades:
  - Las herramientas calculan (geometría, ponderación, vetos). Son la fuente de verdad.
  - El LLM decide qué consultar, interpreta los resultados y redacta la justificación.
  - `elegir_ruta` valida: el modelo no puede escoger una ruta vetada si existe una segura.
  - El JSON final se arma desde los datos calculados; la prosa del modelo va en `justificacion`.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

from . import herramientas as h
from . import puntuacion
from .enrutador import Enrutador
from .fuentes import FuenteIncidentes, FuenteTrafico, FuenteZonas
from .modelos import Punto
from .puntuacion import Pesos

MODELO_POR_DEFECTO = os.getenv("AGENTE_MODELO", "claude-sonnet-5-5")
MAX_ITERACIONES = 10

INSTRUCCIONES = """Eres un agente de seguridad vial para logística. Debes elegir la ruta más segura y razonable entre dos puntos.
Proceso: 1) obtener_rutas_candidatas; 2) consultar_zonas_peligrosas, consultar_incidentes y consultar_trafico;
3) si hay zonas críticas (nivel 4-5), vuelve a llamar obtener_rutas_candidatas con rodear_zonas_criticas=true;
4) evaluar_rutas; 5) elegir_ruta con una justificación en español.
Reglas: nunca inventes datos (solo lo que devuelvan las herramientas); prioriza evitar rutas con veto aunque sean más largas;
cita zonas, reportes (con su antigüedad) y tráfico concretos; indica cuánto cuesta el desvío en km y minutos."""


class AgenteRutaSegura:
    def __init__(self, incidentes: FuenteIncidentes, trafico: FuenteTrafico, zonas: FuenteZonas,
                 enrutador: Enrutador, pesos: Pesos | None = None, cliente=None, modelo: str = MODELO_POR_DEFECTO):
        self.fuentes = (incidentes, trafico, zonas)
        self.enrutador, self.pesos, self.cliente, self.modelo = enrutador, pesos or Pesos(), cliente, modelo

    def _sesion(self, origen: Punto, destino: Punto, ahora: datetime | None) -> h.Sesion:
        return h.Sesion(origen=origen, destino=destino, ahora=ahora or datetime.now(timezone.utc),
                        incidentes_src=self.fuentes[0], trafico_src=self.fuentes[1], zonas_src=self.fuentes[2],
                        enrutador=self.enrutador, pesos=self.pesos)

    def decidir(self, origen: Punto, destino: Punto, ahora: datetime | None = None, usar_llm: bool | None = None) -> dict:
        """Devuelve el reporte estructurado. `usar_llm=None` usa el LLM solo si hay cliente o ANTHROPIC_API_KEY."""
        s = self._sesion(origen, destino, ahora)
        if usar_llm is None:
            usar_llm = self.cliente is not None or bool(os.getenv("ANTHROPIC_API_KEY"))
        modo, advertencias = "determinista", []
        if usar_llm:
            try:
                self._ciclo_llm(s)
                modo = "llm"
            except Exception as e:  # sin red, sin SDK, cuota... el sistema sigue funcionando
                advertencias.append(f"El modelo no estuvo disponible ({type(e).__name__}); se usó el modo determinista.")
                s = self._sesion(origen, destino, ahora)
        if s.eleccion is None:
            self._ciclo_determinista(s)
        return self._reporte(s, modo, advertencias)

    # ------------------------------------------------------------ modo determinista
    def _ciclo_determinista(self, s: h.Sesion) -> None:
        h.obtener_rutas_candidatas(s, rodear_zonas_criticas=False)
        h.consultar_zonas_peligrosas(s)
        h.consultar_incidentes(s)
        h.consultar_trafico(s)
        if any(z.nivel >= s.pesos.veto_zona_nivel for z in s.zonas):
            h.obtener_rutas_candidatas(s, rodear_zonas_criticas=True)
        h.evaluar_rutas(s)
        if not s.evaluaciones:
            raise RuntimeError("No se obtuvieron rutas candidatas del motor de rutas.")
        s.eleccion = {"ruta_id": puntuacion.mejor(s.evaluaciones).ruta.id, "justificacion_modelo": "",
                      "corregida_por_validacion": False}

    # ------------------------------------------------------------ modo LLM (tool calling)
    def _ciclo_llm(self, s: h.Sesion) -> None:
        cliente = self.cliente
        if cliente is None:
            import anthropic  # import tardío: dependencia opcional
            cliente = anthropic.Anthropic()
        mensajes = [{"role": "user", "content": f"Origen (lat,lng): {s.origen}. Destino: {s.destino}. "
                     f"Hora actual UTC: {s.ahora.isoformat()}. Elige la ruta más segura."}]
        for _ in range(MAX_ITERACIONES):
            r = cliente.messages.create(model=self.modelo, max_tokens=1500, system=INSTRUCCIONES,
                                        tools=h.ESQUEMAS, messages=mensajes)
            mensajes.append({"role": "assistant", "content": r.content})
            usos = [b for b in r.content if getattr(b, "type", "") == "tool_use"]
            if not usos:
                break
            resultados = [{"type": "tool_result", "tool_use_id": u.id,
                           "content": json.dumps(h.ejecutar(s, u.name, u.input), ensure_ascii=False)} for u in usos]
            mensajes.append({"role": "user", "content": resultados})
            if s.eleccion is not None:
                break
        if s.eleccion is None or not s.evaluaciones:
            raise RuntimeError("El modelo no completó la decisión.")

    # ------------------------------------------------------------ reporte
    def _reporte(self, s: h.Sesion, modo: str, advertencias: list[str]) -> dict:
        ev = {e.ruta.id: e for e in s.evaluaciones}
        elegida = ev[s.eleccion["ruta_id"]]
        descartadas = [e for e in s.evaluaciones if e is not elegida]
        texto = s.eleccion.get("justificacion_modelo") or ""
        if s.eleccion.get("corregida_por_validacion"):
            advertencias.append("El modelo propuso una ruta con veto de seguridad; el sistema la sustituyó por la mejor sin veto.")
        if not texto or s.eleccion.get("corregida_por_validacion"):
            texto = justificar(elegida, descartadas)
        return {
            "modo": modo,
            "ruta_elegida": {**elegida.a_dict(con_geometria=True), "desvio": elegida.ruta.via is not None},
            "rutas_descartadas": [d.a_dict() for d in sorted(descartadas, key=lambda e: e.score)],
            "justificacion": texto,
            "riesgos_residuales": [x["descripcion"] for x in elegida.a_dict()["hallazgos"]],
            "advertencias": advertencias + (["Todas las rutas tienen veto de seguridad: se recomienda no operar o escoltar."]
                                            if elegida.vetada else []),
            "fuentes_consultadas": {"incidentes": len(s.incidentes), "tramos_trafico": len(s.trafico), "zonas": len(s.zonas)},
            "generado_en": s.ahora.isoformat(),
        }


def justificar(elegida, descartadas) -> str:
    """Justificación basada en plantilla, usando solo datos calculados (modo sin LLM)."""
    partes = []
    for d in sorted(descartadas, key=lambda e: e.score):
        motivos = [x.descripcion for x in d.hallazgos if x.veto] or \
                  [x.descripcion for x in sorted(d.hallazgos, key=lambda x: -x.penalizacion)[:2]]
        if motivos:
            partes.append(f"Se descartó {d.ruta.id} ({d.ruta.distancia_m / 1000:.1f} km): " + "; ".join(motivos) + ".")
    extra = ""
    if descartadas:
        base = min(descartadas, key=lambda e: e.ruta.duracion_s)
        dk = (elegida.ruta.distancia_m - base.ruta.distancia_m) / 1000
        dm = (elegida.duracion_ajustada_s - base.duracion_ajustada_s) / 60
        tiempo = f"{abs(dm):.1f} min {'más' if dm >= 0 else 'menos'}"
        extra = f" Frente a {base.ruta.id} recorre {abs(dk):.1f} km {'más' if dk >= 0 else 'menos'} y tarda {tiempo} (con tráfico)."
    residual = f" Riesgo residual: {len(elegida.hallazgos)} hallazgo(s) menores." if elegida.hallazgos else " Sin hallazgos de riesgo."
    return f"Se eligió {elegida.ruta.id} ({elegida.ruta.distancia_m / 1000:.1f} km, {elegida.duracion_ajustada_s / 60:.0f} min). " \
           + " ".join(partes) + extra + residual
