"""Pruebas de la validación al guardar una ruta planificada."""
import unittest
from datetime import date, datetime, timezone

from backend.app import rutas_logica as logica


class ValidarRuta(unittest.TestCase):
    def test_normaliza_nombre_y_quita_pedidos_repetidos_conservando_el_orden(self):
        nombre, ids = logica.validar_ruta("  Ruta   Centro  ", ["b", "a", "b", " a ", ""])
        self.assertEqual(nombre, "Ruta Centro")
        self.assertEqual(ids, ["b", "a"])

    def test_acepta_ids_numericos(self):
        self.assertEqual(logica.validar_ruta("Ruta 1", [3, 4])[1], ["3", "4"])

    def test_rechaza_nombre_corto_o_largo(self):
        for nombre in ("", "  ab ", "x" * 81, None):
            with self.subTest(nombre=nombre), self.assertRaises(ValueError):
                logica.validar_ruta(nombre, ["1"])

    def test_rechaza_sin_pedidos(self):
        for pedidos in ([], ["", "  "], None, "1"):
            with self.subTest(pedidos=pedidos), self.assertRaises(ValueError):
                logica.validar_ruta("Ruta válida", pedidos)

    def test_rechaza_mas_pedidos_del_maximo(self):
        with self.assertRaises(ValueError):
            logica.validar_ruta("Ruta válida", [str(i) for i in range(logica.MAX_PEDIDOS + 1)])


class RutasDeHoy(unittest.TestCase):
    def test_hoy_usa_la_fecha_local_de_el_salvador_no_utc(self):
        # 02:30 UTC del 21 es todavía el 20 a las 20:30 en El Salvador (UTC-6).
        ahora = datetime(2026, 10, 21, 2, 30, tzinfo=timezone.utc)
        self.assertEqual(logica.hoy_el_salvador(ahora), date(2026, 10, 20))

    def test_filtra_por_fecha_ordena_por_nombre_y_normaliza_campos(self):
        filas = [
            {"id": "R-2", "nombre": "ruta oriente", "zona": "Soyapango", "fecha": "2026-10-20", "entregas": 2, "conductor": "Ana"},
            {"id": "R-1", "nombre": "Ruta Centro", "zona": None, "fecha": "2026-10-20", "entregas": None, "conductor": ""},
            {"id": "R-0", "nombre": "Ayer", "zona": "X", "fecha": "2026-10-19", "entregas": 1, "conductor": None},
        ]
        rutas = logica.rutas_de_hoy(filas, date(2026, 10, 20))
        self.assertEqual([r["id"] for r in rutas], ["R-1", "R-2"])
        self.assertEqual(rutas[0], {"id": "R-1", "nombre": "Ruta Centro", "zona": "", "fecha": "2026-10-20", "entregas": 0, "conductor": None})
        self.assertEqual(rutas[1]["conductor"], "Ana")

    def test_sin_filas_devuelve_lista_vacia(self):
        self.assertEqual(logica.rutas_de_hoy(None, date(2026, 10, 20)), [])


if __name__ == "__main__":
    unittest.main()
