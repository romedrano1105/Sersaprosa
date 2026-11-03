"""Gestión de empleados: validación, estado del día y traducción de errores de la función SQL."""
import os
import unittest
from datetime import date

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")

from backend.app import empleados_logica as logica

HOY = date(2026, 11, 2)


class Validacion(unittest.TestCase):
    def test_limpia_nombre_codigo_y_licencia(self):
        limpio, errores = logica.validar({"nombre": "  Pedro   Ruiz ", "categoria": "Conductor", "licencia": "2028-05-01", "codigo": " con-9 "})
        self.assertEqual(errores, {})
        self.assertEqual(limpio, {"codigo": "CON-9", "nombre": "Pedro Ruiz", "categoria": "conductor", "licencia": "2028-05-01", "activo": True})

    def test_conductor_necesita_licencia_y_guardia_no(self):
        _, errores = logica.validar({"nombre": "Pedro Ruiz", "categoria": "conductor"})
        self.assertIn("licencia", errores)
        limpio, errores = logica.validar({"nombre": "Laura Pérez", "categoria": "guardia", "licencia": "2028-01-01"})
        self.assertEqual(errores, {})
        self.assertIsNone(limpio["licencia"])          # un guardia no guarda licencia de conducir

    def test_rechaza_datos_invalidos(self):
        _, errores = logica.validar({"nombre": "X", "categoria": "jefe", "licencia": "31/12/2028", "codigo": "con 1"})
        self.assertEqual(set(errores), {"nombre", "categoria", "licencia", "codigo"})


class EstadoDelDia(unittest.TestCase):
    def test_estados(self):
        base = {"activo": True, "categoria": "conductor", "licencia": "2027-01-01", "asignacion": None}
        self.assertEqual(logica.estado_de(base, HOY), "disponible")
        self.assertEqual(logica.estado_de({**base, "activo": False}, HOY), "inactivo")
        self.assertEqual(logica.estado_de({**base, "asignacion": {"ruta": "Ruta Centro"}}, HOY), "asignado")
        self.assertEqual(logica.estado_de({**base, "licencia": "2026-09-19"}, HOY), "licencia_vencida")
        self.assertEqual(logica.estado_de({**base, "licencia": None}, HOY), "sin_licencia")
        self.assertEqual(logica.estado_de({"activo": True, "categoria": "guardia", "licencia": None}, HOY), "disponible")

    def test_resumen(self):
        filas = [logica.con_estado(f, HOY) for f in (
            {"codigo": "A", "activo": True, "categoria": "conductor", "licencia": "2027-01-01"},
            {"codigo": "B", "activo": True, "categoria": None, "licencia": "2027-01-01", "asignacion": {"ruta": "R"}},
            {"codigo": "C", "activo": True, "categoria": "guardia"},
            {"codigo": "D", "activo": False, "categoria": "guardia"},
        )]
        self.assertEqual(filas[1]["categoria"], "conductor")   # sin categoría = conductor, como antes
        self.assertEqual(logica.resumen(filas), {"total": 4, "conductores": 2, "guardias": 1, "disponibles": 2, "asignados": 1, "inactivos": 1})


try:
    from fastapi import HTTPException
    from postgrest.exceptions import APIError
    from unittest.mock import patch
    from backend.app import empleados_router
except ImportError:  # sin FastAPI instalado (el CI sí lo tiene)
    empleados_router = None


class _Consulta:
    def __init__(self, resultado=None, error=None):
        self.resultado, self.error = resultado, error

    def execute(self):
        if self.error:
            raise self.error
        return type("R", (), {"data": self.resultado})()


class _Cliente:
    def __init__(self, resultado=None, error=None):
        self.resultado, self.error, self.llamadas = resultado, error, []

    def rpc(self, nombre, parametros):
        self.llamadas.append((nombre, parametros))
        return _Consulta(self.resultado, self.error)


@unittest.skipIf(empleados_router is None, "requiere FastAPI")
class Router(unittest.TestCase):
    def test_guardar_usa_la_funcion_sql_con_el_token_del_coordinador(self):
        cliente = _Cliente({"codigo": "GUA-005", "nombre": "Laura Pérez", "categoria": "guardia", "creado": True})
        with patch.object(empleados_router, "_coordinador", return_value=cliente), \
             patch.object(empleados_router.database, "cliente_servicio", side_effect=AssertionError("sin service role")):
            r = empleados_router.guardar(empleados_router.Empleado(nombre="Laura Pérez", categoria="guardia"), "Bearer t")
        self.assertEqual(r["codigo"], "GUA-005")
        self.assertEqual(cliente.llamadas[0][0], "guardar_empleado_operativo")
        self.assertIsNone(cliente.llamadas[0][1]["p_codigo"])

    def test_sin_migracion_responde_503_con_el_archivo_que_falta(self):
        cliente = _Cliente(error=APIError({"code": "PGRST202", "message": "function not found"}))
        with patch.object(empleados_router, "_coordinador", return_value=cliente):
            with self.assertRaises(HTTPException) as cm:
                empleados_router.listar("Bearer t")
        self.assertEqual(cm.exception.status_code, 503)
        self.assertIn("empleados_gestion.sql", cm.exception.detail)

    def test_regla_de_negocio_responde_409_con_su_mensaje(self):
        cliente = _Cliente(error=APIError({"code": "P0001", "message": "El empleado tiene una ruta asignada hoy."}))
        with patch.object(empleados_router, "_coordinador", return_value=cliente):
            with self.assertRaises(HTTPException) as cm:
                empleados_router.cambiar_estado(empleados_router.CambioEstado(codigo="DEMO-001", activo=False), "Bearer t")
        self.assertEqual((cm.exception.status_code, cm.exception.detail), (409, "El empleado tiene una ruta asignada hoy."))

    def test_conductor_sin_licencia_no_llega_a_la_base(self):
        cliente = _Cliente({})
        with patch.object(empleados_router, "_coordinador", return_value=cliente):
            with self.assertRaises(HTTPException) as cm:
                empleados_router.guardar(empleados_router.Empleado(nombre="Pedro Ruiz", categoria="conductor"), "Bearer t")
        self.assertEqual(cm.exception.status_code, 422)
        self.assertEqual(cliente.llamadas, [])


if __name__ == "__main__":
    unittest.main()
