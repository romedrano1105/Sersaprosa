import os
import unittest

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")

from fastapi.testclient import TestClient

from backend.app.main import app


class ExistingApiRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_pages_are_served_by_fastapi(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("/assets/js/dashboard.js", response.text)

    def test_existing_data_routes_require_a_bearer_token(self):
        protected_requests = (
            ("/entregas/listar", {}),
            ("/eventos/listar", {}),
            ("/alertas/listar", {}),
            ("/disponibilidad/listar", {}),
            ("/notificaciones/sincronizar", {}),
            ("/notificaciones/listar", {}),
            ("/rutas/geocodificar", {"query": "San Salvador"}),
            ("/viajes/generar", {}),
            ("/viajes/actualizar", {"id": "RT-1"}),
            ("/agente/ruta-segura", {"origen": {"lat": 13.7, "lng": -89.2}, "destino": {"lat": 13.71, "lng": -89.19}}),
            ("/rutas/guardar", {"nombre": "Ruta Centro", "pedidos": ["1"]}),
            ("/rutas/listar", {}),
            ("/rutas/actualizar", {"id": "R-1", "nombre": "Ruta Centro", "pedidos": ["1"]}),
            ("/disponibilidad/desasignar", {"ruta": "R-1"}),
            ("/notificaciones/leer", {"id": "6f9619ff-8b86-d011-b42d-00c04fc964ff"}),
            ("/disponibilidad/asignar", {"conductor": "E-1", "vehiculo": "V-1", "ruta": "R-1", "guardias": ["G-1"]}),
        )
        for path, payload in protected_requests:
            with self.subTest(path=path):
                response = self.client.post(path, json=payload)
                self.assertEqual(response.status_code, 401)
