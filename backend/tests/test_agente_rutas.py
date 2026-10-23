import unittest
from datetime import datetime, timezone
from types import SimpleNamespace

from backend.agente_rutas import geo
from backend.agente_rutas.ejemplo import DESTINO, ORIGEN, construir_agente

AHORA = datetime(2026, 10, 23, 15, 0, tzinfo=timezone.utc)


class GeoTest(unittest.TestCase):
    def test_punto_en_poligono(self):
        cuadro = [(0, 0), (0, 1), (1, 1), (1, 0)]
        self.assertTrue(geo.punto_en_poligono((0.5, 0.5), cuadro))
        self.assertFalse(geo.punto_en_poligono((1.5, 0.5), cuadro))

    def test_distancia_a_linea(self):
        d = geo.distancia_a_linea_m((13.701, -89.2), [(13.700, -89.21), (13.700, -89.19)])
        self.assertAlmostEqual(d, 111.3, delta=2)

    def test_densificar_conserva_longitud(self):
        linea = [(13.7, -89.22), (13.7, -89.17)]
        total = sum(m for _, m in geo.densificar(linea))
        self.assertAlmostEqual(total, geo.haversine_m(*linea), delta=1)


class AgenteDeterministaTest(unittest.TestCase):
    def setUp(self):
        self.reporte = construir_agente(AHORA).decidir(ORIGEN, DESTINO, ahora=AHORA, usar_llm=False)

    def test_evita_hotspot_y_reporte(self):
        r = self.reporte
        self.assertEqual(r["modo"], "determinista")
        self.assertTrue(r["ruta_elegida"]["desvio"])
        self.assertFalse(r["ruta_elegida"]["vetada"])
        directa = r["rutas_descartadas"][0]
        self.assertTrue(directa["vetada"])
        fuentes = {h["fuente"] for h in directa["hallazgos"]}
        self.assertEqual(fuentes, {"zona", "incidente", "trafico"})
        self.assertIn("Colonia Los Pinos", r["justificacion"])
        self.assertIn("hace 15 min", r["justificacion"])

    def test_reporte_vencido_no_cuenta(self):
        total = self.reporte["fuentes_consultadas"]["incidentes"]
        self.assertEqual(total, 2)  # INC-103 (hace 400 min, vigencia 120) queda fuera

    def test_json_serializable(self):
        import json
        json.dumps(self.reporte)


class FalsoLLM:
    """Cliente falso con la forma de anthropic.Anthropic().messages.create."""

    def __init__(self, pasos):
        self.pasos, self.messages = list(pasos), SimpleNamespace(create=self._crear)

    def _crear(self, **kw):
        nombre, args = self.pasos.pop(0)
        return SimpleNamespace(content=[SimpleNamespace(type="tool_use", id=f"t{len(self.pasos)}", name=nombre, input=args)])


class AgenteLLMTest(unittest.TestCase):
    PASOS = [("obtener_rutas_candidatas", {"rodear_zonas_criticas": False}), ("consultar_zonas_peligrosas", {}),
             ("consultar_incidentes", {}), ("consultar_trafico", {}),
             ("obtener_rutas_candidatas", {"rodear_zonas_criticas": True}), ("evaluar_rutas", {})]

    def test_el_modelo_no_puede_elegir_una_ruta_vetada(self):
        llm = FalsoLLM(self.PASOS + [("elegir_ruta", {"ruta_id": "R1", "justificacion": "Es la más corta."})])
        r = construir_agente(AHORA, cliente=llm).decidir(ORIGEN, DESTINO, ahora=AHORA)
        self.assertEqual(r["modo"], "llm")
        self.assertEqual(r["ruta_elegida"]["ruta_id"], "R2")
        self.assertTrue(any("sustituyó" in a for a in r["advertencias"]))
        self.assertNotIn("más corta", r["justificacion"])

    def test_usa_la_justificacion_del_modelo_si_es_valida(self):
        llm = FalsoLLM(self.PASOS + [("elegir_ruta", {"ruta_id": "R2", "justificacion": "Se evitó Z-01 por asalto reciente."})])
        r = construir_agente(AHORA, cliente=llm).decidir(ORIGEN, DESTINO, ahora=AHORA)
        self.assertEqual(r["justificacion"], "Se evitó Z-01 por asalto reciente.")

    def test_si_el_modelo_falla_cae_al_modo_determinista(self):
        class Roto:
            messages = SimpleNamespace(create=lambda **kw: (_ for _ in ()).throw(ConnectionError("sin red")))
        r = construir_agente(AHORA, cliente=Roto()).decidir(ORIGEN, DESTINO, ahora=AHORA)
        self.assertEqual(r["modo"], "determinista")
        self.assertTrue(r["advertencias"])


if __name__ == "__main__":
    unittest.main()
