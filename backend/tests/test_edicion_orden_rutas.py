import unittest
import os
from unittest.mock import patch

from fastapi import HTTPException

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")

from backend.app import rutas_router


class Resultado:
    data = {"id": "R-1", "version": 2}


class ConsultaRPC:
    def __init__(self, nombre, parametros):
        self.nombre = nombre
        self.parametros = parametros

    def execute(self):
        return Resultado()


class Cliente:
    def __init__(self):
        self.llamada = None

    def rpc(self, nombre, parametros):
        self.llamada = ConsultaRPC(nombre, parametros)
        return self.llamada


class EdicionOrdenRutaTest(unittest.TestCase):
    def setUp(self):
        self.cliente = Cliente()

    def test_edita_orden_usando_el_rpc_atomico_y_usuario_autenticado(self):
        req = rutas_router.OrdenRutaEditada(
            id="R-1", pedidos=["P2", "P1"], version=4,
            distancia_km=12.4, duracion_min=31.5, riesgo_ruta="alto",
        )
        with patch.object(rutas_router, "usuario_coordinador", return_value=(self.cliente, "Ana")):
            respuesta = rutas_router.editar_orden(req, "Bearer token")
        self.assertEqual(respuesta["version"], 2)
        self.assertEqual(self.cliente.llamada.nombre, "editar_orden_ruta_operativa")
        self.assertEqual(self.cliente.llamada.parametros, {
            "p_ruta": "R-1", "p_pedidos": ["P2", "P1"], "p_version": 4,
            "p_distancia_km": 12.4, "p_duracion_min": 31.5,
            "p_riesgo_ruta": "alto", "p_usuario": "Ana",
        })

    def test_rechaza_pedidos_repetidos_antes_de_escribir(self):
        req = rutas_router.OrdenRutaEditada(
            id="R-1", pedidos=["P1", "P1"], version=1,
            distancia_km=1, duracion_min=1, riesgo_ruta="bajo",
        )
        with patch.object(rutas_router, "usuario_coordinador", return_value=(self.cliente, "Ana")):
            with self.assertRaises(HTTPException) as error:
                rutas_router.editar_orden(req, "Bearer token")
        self.assertEqual(error.exception.status_code, 422)
        self.assertIsNone(self.cliente.llamada)

    def test_valida_metricas_y_nivel_de_riesgo(self):
        with self.assertRaises(ValueError):
            rutas_router.OrdenRutaEditada(
                id="R-1", pedidos=["P1"], version=1,
                distancia_km=-1, duracion_min=1, riesgo_ruta="bajo",
            )
        with self.assertRaises(ValueError):
            rutas_router.OrdenRutaEditada(
                id="R-1", pedidos=["P1"], version=1,
                distancia_km=1, duracion_min=1, riesgo_ruta="moderado",
            )


if __name__ == "__main__":
    unittest.main()
