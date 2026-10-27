"""Pruebas de monto, tipo de carga y riesgo de rutas (FCJ1-99 a FCJ1-103)."""
import os
import unittest
from decimal import Decimal
from unittest.mock import AsyncMock, patch

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")

from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.rutas_riesgo import validar_entrada

AUTH = {"Authorization": "Bearer token-de-prueba"}


class ValidarEntrada(unittest.TestCase):
    def test_valido(self):
        monto, tipo, errores = validar_entrada({"monto": "1500.50", "tipo_carga_id": 2})
        self.assertEqual((monto, tipo, errores), (Decimal("1500.50"), 2, {}))

    def test_monto_invalido(self):
        for monto in (None, "", "  ", "abc", "-5", "0", 0, -1, "NaN", "Infinity", True,
                      "1e20", "0.001", "10.123"):
            with self.subTest(monto=monto):
                _, _, errores = validar_entrada({"monto": monto, "tipo_carga_id": 1})
                self.assertIn("monto", errores)

    def test_tipo_invalido(self):
        for tipo in (None, "", "x", True, 0, -1, 40000):
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
        cuerpo = {"monto": 100, "tipo_carga_id": 1}
        for metodo, path, payload in (
            ("get", "/rutas-riesgo/tipos-carga", None),
            ("post", "/rutas-riesgo/calcular", cuerpo),
            ("put", "/rutas-riesgo/R-1", cuerpo),
            ("get", "/rutas-riesgo", None),
            ("get", "/rutas-riesgo/R-1", None),
        ):
            with self.subTest(metodo=metodo, path=path):
                r = self.client.request(metodo, path, json=payload)
                self.assertEqual(r.status_code, 401)

    def test_token_mal_formado(self):
        r = self.client.get("/rutas-riesgo", headers={"Authorization": "Basic abc"})
        self.assertEqual(r.status_code, 401)

    def test_calcular_valida_antes_de_llamar_a_supabase(self):
        with patch("backend.app.rutas_riesgo._rpc", new=AsyncMock()) as rpc:
            r = self.client.post("/rutas-riesgo/calcular", json={}, headers=AUTH)
        self.assertEqual(r.status_code, 422)
        self.assertEqual(set(r.json()["detail"]["errores"]), {"monto", "tipo_carga_id"})
        rpc.assert_not_called()

    def test_calcular_ok(self):
        with patch("backend.app.rutas_riesgo._rpc", new=AsyncMock(return_value="Alto")) as rpc:
            r = self.client.post(
                "/rutas-riesgo/calcular",
                json={"monto": "150000", "tipo_carga_id": 1},
                headers=AUTH,
            )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"nivel_riesgo": "Alto"})
        rpc.assert_awaited_once_with(
            "calcular_nivel_riesgo",
            "token-de-prueba",
            {"p_monto": "150000", "p_tipo_carga_id": 1},
        )

    def test_detalle_inexistente_da_404(self):
        with patch("backend.app.rutas_riesgo._rpc", new=AsyncMock(return_value=[])):
            r = self.client.get("/rutas-riesgo/R-99", headers=AUTH)
        self.assertEqual(r.status_code, 404)
    def test_guardar_invalido_no_llama_a_supabase(self):
        with patch("backend.app.rutas_riesgo._rpc", new=AsyncMock()) as rpc:
            for cuerpo in ({}, {"monto": "-5", "tipo_carga_id": 1}, {"monto": 100}):
                with self.subTest(cuerpo=cuerpo):
                    r = self.client.put("/rutas-riesgo/R-1", json=cuerpo, headers=AUTH)
                    self.assertEqual(r.status_code, 422)
        rpc.assert_not_called()

    def test_guardar_ok_llama_a_la_funcion_que_audita(self):
        with patch("backend.app.rutas_riesgo._rpc",
                   new=AsyncMock(return_value={"ruta_id": "R-1", "nivel_riesgo": "Medio"})) as rpc:
            r = self.client.put("/rutas-riesgo/R-1",
                                json={"monto": "25000", "tipo_carga_id": 3}, headers=AUTH)
        self.assertEqual(r.status_code, 200)
        rpc.assert_awaited_once_with(
            "especificar_riesgo_ruta", "token-de-prueba",
            {"p_ruta_id": "R-1", "p_monto": "25000", "p_tipo_carga_id": 3},
        )

    def test_paginas_se_sirven(self):
        for url in ("/riesgo_rutas.html",):
            with self.subTest(url=url):
                r = self.client.get(url)
                self.assertEqual(r.status_code, 200)
                self.assertIn("/assets/js/riesgoRutas.js", r.text)


if __name__ == "__main__":
    unittest.main()
