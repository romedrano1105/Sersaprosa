import unittest
from unittest.mock import patch

from backend.app import viajes_router


class Respuesta:
    def __init__(self, data):
        self.data = data


class ConsultaViajes:
    def __init__(self, cliente):
        self.cliente = cliente

    def select(self, columnas):
        self.cliente.columnas = columnas
        return self

    def in_(self, campo, valores):
        self.cliente.filtro = (campo, valores)
        return self

    def execute(self):
        self.cliente.consultas += 1
        return Respuesta(self.cliente.viajes)


class Cliente:
    def __init__(self):
        self.consultas = 0
        self.columnas = ""
        self.filtro = None
        self.viajes = [{
            "id": "V-1",
            "ruta_id": "R-1",
            "estado": "en_curso",
            "vehiculos": {"placa": "P-123", "tipo": "Camión"},
            "empleados": {"nombre": "Ana"},
            "entregas": [
                {"id": "P-2", "orden": 2, "direccion": "Destino", "lat": 13.7, "lng": -89.2},
                {"id": "P-1", "orden": 1, "direccion": "Inicio", "lat": 13.6, "lng": -89.1},
                {"id": "P-3", "orden": 3, "direccion": "Sin coordenadas", "lat": None, "lng": None},
            ],
        }]

    def table(self, nombre):
        self.tabla = nombre
        return ConsultaViajes(self)


class MonitoreoViajesTest(unittest.TestCase):
    def test_monitoreo_usa_un_query_y_solo_datos_reales(self):
        cliente = Cliente()
        with (
            patch.object(viajes_router, "usuario_coordinador", return_value=(None, "Ana")),
            patch.object(viajes_router.database, "cliente_servicio", return_value=cliente),
        ):
            resultado = viajes_router.obtener_viajes_monitoreo_en_vivo("Bearer token")

        self.assertEqual(cliente.consultas, 1)
        self.assertEqual(cliente.tabla, "viajes")
        self.assertIn("entregas(", cliente.columnas)
        self.assertEqual(cliente.filtro, ("estado", ["en_curso", "asignado", "en_transito"]))
        self.assertEqual(resultado[0]["unidad"], "P-123")
        self.assertEqual(resultado[0]["ruta_id"], "R-1")
        self.assertEqual(resultado[0]["modelo"], "Camión")
        self.assertEqual(resultado[0]["conductor"], "Ana")
        self.assertIsNone(resultado[0]["posicion_actual"])
        self.assertEqual([p["direccion"] for p in resultado[0]["tramos"]], ["Inicio", "Destino"])
        self.assertNotIn("Base", str(resultado))
        self.assertNotIn("Blindado Pesado", str(resultado))


if __name__ == "__main__":
    unittest.main()
