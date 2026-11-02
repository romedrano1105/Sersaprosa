import os
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException
from jwt.exceptions import PyJWKClientConnectionError

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")

from backend.app import autenticacion, database


class JWKSFalso:
    def __init__(self, key):
        self.key = key

    def get_signing_key_from_jwt(self, _token):
        if isinstance(self.key, Exception):
            raise self.key
        return SimpleNamespace(key=self.key)


class VerificacionJWTTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.private_key = ec.generate_private_key(ec.SECP256R1())
        cls.payload = {
            "iss": f"{database.SUPABASE_URL}/auth/v1",
            "aud": "authenticated",
            "sub": "user-1",
            "email": "ana@example.com",
            "app_metadata": {"role": "coordinador_rutas"},
            "user_metadata": {"name": "Ana"},
        }

    def token(self, **cambios):
        claims = {**self.payload, "exp": int(time.time()) + 300, **cambios}
        return jwt.encode(claims, self.private_key, algorithm="ES256", headers={"kid": "test-key"})

    def test_jwt_vigente_verifica_issuer_audience_y_metadatos(self):
        token = self.token()
        with patch.object(database, "_jwks_client", JWKSFalso(self.private_key.public_key())):
            claims = database.verificar_token(token)

        self.assertEqual(claims["sub"], "user-1")
        self.assertEqual(claims["app_metadata"]["role"], "coordinador_rutas")

    def test_jwt_expirado_o_con_audience_incorrecta_se_rechaza(self):
        expirado = self.token(exp=int(time.time()) - 1)
        audiencia_incorrecta = self.token(aud="anon")
        with patch.object(database, "_jwks_client", JWKSFalso(self.private_key.public_key())):
            for token in (expirado, audiencia_incorrecta):
                with self.subTest(token=token[:12]):
                    with self.assertRaises(database.TokenInvalido):
                        database.verificar_token(token)

    def test_jwks_caido_responde_como_no_disponible(self):
        token = self.token()
        fallo = PyJWKClientConnectionError("red no disponible")
        with patch.object(database, "_jwks_client", JWKSFalso(fallo)):
            with self.assertRaises(database.VerificacionTokenNoDisponible):
                database.verificar_token(token)

    def test_cabecera_bearer_crea_usuario_desde_claims_locales(self):
        token = self.token()
        with patch.object(database, "_jwks_client", JWKSFalso(self.private_key.public_key())):
            recibido, usuario = autenticacion.usuario_desde_autorizacion(f"Bearer {token}")

        self.assertEqual(recibido, token)
        self.assertEqual((usuario.id, usuario.email), ("user-1", "ana@example.com"))
        self.assertEqual(usuario.user_metadata["name"], "Ana")

    def test_cabecera_ausente_se_rechaza_sin_consultar_jwks(self):
        with self.assertRaises(HTTPException) as error:
            autenticacion.usuario_desde_autorizacion(None)
        self.assertEqual(error.exception.status_code, 401)

    def test_cliente_de_servicio_se_reutiliza(self):
        anterior_key = database.SUPABASE_SERVICE_ROLE_KEY
        anterior_cliente = database._service_client
        try:
            database.SUPABASE_SERVICE_ROLE_KEY = "clave-de-prueba"
            database._service_client = None
            with patch.object(database, "create_client", return_value=object()) as crear:
                primero = database.cliente_servicio()
                segundo = database.cliente_servicio()
            self.assertIs(primero, segundo)
            crear.assert_called_once_with(database.SUPABASE_URL, "clave-de-prueba")
        finally:
            database.SUPABASE_SERVICE_ROLE_KEY = anterior_key
            database._service_client = anterior_cliente


if __name__ == "__main__":
    unittest.main()
