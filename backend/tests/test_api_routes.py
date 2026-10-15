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
        )
        for path, payload in protected_requests:
            with self.subTest(path=path):
                response = self.client.post(path, json=payload)
                self.assertEqual(response.status_code, 401)
