import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import main


class LoginRateLimitTest(unittest.TestCase):
    def setUp(self):
        main._login_limpiar_fallos("testclient")
        self.client = TestClient(main.app)

    def tearDown(self):
        main._login_limpiar_fallos("testclient")

    def test_login_bloquea_despues_de_cinco_credenciales_invalidas(self):
        with patch.object(main.database, "buscar_empleado_por_codigo", return_value=None):
            respuestas = [
                self.client.post("/login", json={"code": "X-1", "password": "incorrecta"})
                for _ in range(main.LOGIN_MAX_INTENTOS)
            ]
            bloqueada = self.client.post("/login", json={"code": "X-1", "password": "incorrecta"})

        self.assertTrue(all(respuesta.status_code == 401 for respuesta in respuestas))
        self.assertEqual(bloqueada.status_code, 429)
        self.assertEqual(bloqueada.headers.get("retry-after"), str(main.LOGIN_VENTANA_SEGUNDOS))


class ErrorHandlerTest(unittest.TestCase):
    def test_error_no_controlado_devuelve_referencia_sin_detalle_interno(self):
        request = SimpleNamespace(url=SimpleNamespace(path="/interno"))
        try:
            raise RuntimeError("detalle confidencial")
        except RuntimeError as error:
            respuesta = asyncio.run(main.error_inesperado(request, error))

        cuerpo = json.loads(respuesta.body)
        self.assertEqual(respuesta.status_code, 500)
        self.assertIn("error_id", cuerpo)
        self.assertNotIn("RuntimeError", cuerpo["detail"])
        self.assertNotIn("detalle confidencial", cuerpo["detail"])


if __name__ == "__main__":
    unittest.main()
