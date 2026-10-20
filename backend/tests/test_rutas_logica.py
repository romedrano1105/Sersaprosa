"""Pruebas de la validación al guardar una ruta planificada."""
import unittest

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


if __name__ == "__main__":
    unittest.main()
