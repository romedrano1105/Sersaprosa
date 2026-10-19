"""Pruebas de monto, tipo de carga y riesgo de rutas (FCJ1-99 a FCJ1-103)."""
import os
import unittest
from decimal import Decimal

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")

from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.rutas_riesgo import validar_entrada


class ValidarEntrada(unittest.TestCase):
    def test_valido(self):
        monto, tipo, errores = validar_entrada({"monto": "1500.50", "tipo_carga_id": 2})
        self.assertEqual((monto, tipo, errores), (Decimal("1500.50"), 2, {}))

    def test_monto_invalido(self):
        for monto in (None, "", "  ", "abc", "-5", "0", 0, -1, "NaN", "Infinity", True, "1e20"):
            with self.subTest(monto=monto):
                _, _, errores = validar_entrada({"monto": monto, "tipo_carga_id": 1})
                self.assertIn("monto", errores)

    def test_tipo_invalido(self):
        for tipo in (None, "", "x", True):
            with self.subTest(tipo=tipo):
                _, _, errores = validar_entrada({"monto": 100, "tipo_carga_id": tipo})
                self.assertIn("tipo_carga_id", errores)

    def test_cuerpo_vacio_reporta_ambos(self):
        _, _, errores = validar_entrada({})
        self.assertEqual(set(errores), {"monto", "tipo_carga_id"})


class RutasProtegidas(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_requieren_token(self):
        for path, payload in (
            ("/rutas-riesgo/tipos-carga", {}),
            ("/rutas-riesgo/calcular", {"monto": 100, "tipo_carga_id": 1}),
            ("/rutas-riesgo/guardar", {"ruta_id": "R-1", "monto": 100, "tipo_carga_id": 1}),
            ("/rutas-riesgo/listar", {}),
            ("/rutas-riesgo/detalle", {"ruta_id": "R-1"}),
        ):
            with self.subTest(path=path):
                self.assertEqual(self.client.post(path, json=payload).status_code, 401)

    def test_pagina_se_sirve(self):
        r = self.client.get("/riesgo-rutas.html")
        self.assertEqual(r.status_code, 200)
        self.assertIn("/assets/js/riesgoRutas.js", r.text)


if __name__ == "__main__":
    unittest.main()