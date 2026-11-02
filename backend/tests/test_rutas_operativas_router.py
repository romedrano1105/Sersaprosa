import unittest
from unittest.mock import patch

from fastapi import HTTPException
from postgrest.exceptions import APIError

from backend.app import disponibilidad_router, rutas_router


class ConsultaRPC:
    def __init__(self, resultado=None, error=None):
        self.resultado, self.error = resultado, error

    def execute(self):
        if self.error:
            raise self.error
        return type("Respuesta", (), {"data": self.resultado})()


class Cliente:
    def __init__(self, resultado=None, error=None):
        self.resultado, self.error, self.llamadas = resultado, error, []

    def rpc(self, nombre, parametros):
        self.llamadas.append((nombre, parametros))
        return ConsultaRPC(self.resultado, self.error)


class EscriturasRutaTest(unittest.TestCase):
    def test_asignar_envia_guardias_aunque_la_lista_este_vacia(self):
        cliente = Cliente({
            "ruta": "R1", "conductor": "C1", "vehiculo": "V1",
            "guardias": [], "fecha": "2026-10-23", "usuario": "Ana",
        })
        with patch.object(disponibilidad_router, "_coordinador", return_value=(cliente, "Ana")):
            disponibilidad_router.asignar(
                disponibilidad_router.Asignacion(conductor="C1", vehiculo="V1", ruta="R1"),
                "Bearer token",
            )

        self.assertEqual(cliente.llamadas[0][1]["p_guardias"], [])

    def test_ruta_sin_funcion_sql_devuelve_503_sin_service_role(self):
        cliente = Cliente(error=APIError({"code": "PGRST202", "message": "function not found"}))
        with (
            patch.object(rutas_router, "usuario_coordinador", return_value=(cliente, "Ana")),
            patch("backend.app.database.cliente_servicio", side_effect=AssertionError("service role no debe usarse")),
        ):
            with self.assertRaises(HTTPException) as error:
                rutas_router.guardar(
                    rutas_router.RutaNueva(nombre="Ruta Norte", pedidos=["P-1"]),
                    "Bearer token",
                )

        self.assertEqual(error.exception.status_code, 503)

    def test_desasignar_sin_funcion_sql_devuelve_503_sin_service_role(self):
        cliente = Cliente(error=APIError({"code": "PGRST202", "message": "function not found"}))
        with (
            patch.object(disponibilidad_router, "_coordinador", return_value=(cliente, "Ana")),
            patch.object(disponibilidad_router.database, "cliente_servicio", side_effect=AssertionError("service role no debe usarse")),
        ):
            with self.assertRaises(HTTPException) as error:
                disponibilidad_router.desasignar(
                    disponibilidad_router.Desasignacion(ruta="R1"),
                    "Bearer token",
                )

        self.assertEqual(error.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
