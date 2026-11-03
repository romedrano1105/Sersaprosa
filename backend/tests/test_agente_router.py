import os
import unittest
from unittest.mock import patch

import httpx

from backend.app.agente_router import _agregar_trafico_google


class AgenteRouterGoogleTrafficTest(unittest.TestCase):
    def test_adjunta_trafico_a_la_evaluacion(self):
        reporte = {"ruta_elegida": {"geometria": [[13.7, -89.2], [13.8, -89.1]]}, "advertencias": []}
        trafico = {"disponible": True, "segmentos": [{"velocidad": "SLOW", "geometria": [[13.7, -89.2], [13.8, -89.1]]}]}
        with patch.dict(os.environ, {"GOOGLE_ROUTES_API_KEY": "clave-de-prueba"}), \
                patch("backend.app.agente_router.consultar_trafico_google", return_value=trafico) as consultar:
            resultado = _agregar_trafico_google(reporte)

        consultar.assert_called_once_with("clave-de-prueba", reporte["ruta_elegida"]["geometria"])
        self.assertIs(resultado, reporte)
        self.assertEqual(resultado["trafico_google"], trafico)
        self.assertEqual(resultado["advertencias"], [])

    def test_fallo_de_google_no_interrumpe_la_evaluacion(self):
        reporte = {"ruta_elegida": {"geometria": [[13.7, -89.2], [13.8, -89.1]]}, "advertencias": []}
        with patch.dict(os.environ, {"GOOGLE_ROUTES_API_KEY": "clave-de-prueba"}), \
                patch("backend.app.agente_router.consultar_trafico_google",
                      side_effect=httpx.ConnectError("sin conexión")), \
                self.assertLogs("backend.app.agente_router", level="WARNING"):
            resultado = _agregar_trafico_google(reporte)

        self.assertEqual(resultado["trafico_google"], {"disponible": False, "segmentos": []})
        self.assertTrue(any("Tráfico de Google no disponible" in texto for texto in resultado["advertencias"]))

    def test_sin_clave_avisa_y_conserva_la_ruta(self):
        reporte = {"ruta_elegida": {"geometria": [[13.7, -89.2], [13.8, -89.1]]}, "advertencias": []}
        with patch.dict(os.environ, {}, clear=True), \
                patch("backend.app.agente_router.consultar_trafico_google",
                      return_value={"disponible": False, "segmentos": []}) as consultar:
            resultado = _agregar_trafico_google(reporte)

        consultar.assert_called_once_with(None, reporte["ruta_elegida"]["geometria"])
        self.assertTrue(resultado["ruta_elegida"])
        self.assertTrue(resultado["advertencias"])


if __name__ == "__main__":
    unittest.main()
