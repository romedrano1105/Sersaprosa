import unittest
from datetime import date
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


class ConsultaTabla:
    def __init__(self, filas):
        self.filas = filas

    def select(self, _columnas):
        return self

    def eq(self, columna, valor):
        self.filas = [fila for fila in self.filas if fila.get(columna) == valor]
        return self

    def execute(self):
        return type("Respuesta", (), {"data": self.filas})()


class Cliente:
    def __init__(self, resultado=None, error=None, rutas=None):
        self.resultado, self.error, self.llamadas = resultado, error, []
        self.rutas = rutas or []

    def rpc(self, nombre, parametros):
        self.llamadas.append((nombre, parametros))
        return ConsultaRPC(self.resultado, self.error)

    def table(self, nombre):
        if nombre != "rutas_planificadas":
            raise AssertionError(f"Tabla inesperada: {nombre}")
        return ConsultaTabla(self.rutas[:])


class EscriturasRutaTest(unittest.TestCase):
    def test_listar_devuelve_rutas_aceptadas_sin_asignacion_y_avisa_propuestas(self):
        hoy = date(2026, 11, 2)
        cliente = Cliente(
            resultado={
                "drivers": [{"id": "C1"}],
                "guards": [],
                "vehicles": [{"id": "V1"}],
                "routes": [],
                "pending": [],
                "assignments": [{"ruta": "ASIGNADA", "conductor": "C1", "vehiculo": "V1", "guardias": []}],
            },
            rutas=[
                {"id": "IA-ACEPTADA", "nombre": "Ruta IA", "fecha": hoy.isoformat(), "metodo_creacion": "ia",
                 "estado_propuesta": "aceptada", "conductor": None},
                {"id": "IA-PENDIENTE", "nombre": "Pendiente", "fecha": hoy.isoformat(), "metodo_creacion": "ia",
                 "estado_propuesta": "propuesta", "conductor": None},
                {"id": "MANUAL", "nombre": "Ruta manual", "fecha": hoy.isoformat(), "metodo_creacion": "manual",
                 "estado_propuesta": "aceptada", "conductor": None},
                {"id": "RECHAZADA", "nombre": "Rechazada", "fecha": hoy.isoformat(), "metodo_creacion": "ia",
                 "estado_propuesta": "rechazada", "conductor": None},
                {"id": "ASIGNADA", "nombre": "Ya asignada", "fecha": hoy.isoformat(), "metodo_creacion": "ia",
                 "estado_propuesta": "aceptada", "conductor": "C1"},
            ],
        )
        with (
            patch.object(disponibilidad_router, "_coordinador", return_value=(cliente, "Ana")),
            patch.object(disponibilidad_router.rutas_logica, "hoy_el_salvador", return_value=hoy),
        ):
            resultado = disponibilidad_router.listar("******")

        self.assertEqual([ruta["id"] for ruta in resultado["routes"]], ["IA-ACEPTADA", "MANUAL"])
        self.assertEqual([ruta["id"] for ruta in resultado["pendientes_aceptar"]], ["IA-PENDIENTE"])
        self.assertEqual(resultado["inconsistencias"], [])
        self.assertEqual(resultado["totals"], {"drivers": 1, "guards": 0, "vehicles": 1})

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
