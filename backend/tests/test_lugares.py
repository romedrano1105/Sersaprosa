import unittest

from backend.app import lugares

LOCALES = [
    {"texto": "Metrocentro, San Salvador", "lat": 13.7, "lng": -89.2, "fuente": "ruta"},
    {"texto": "Colonia Metropolitana", "lat": None, "lng": None, "fuente": "pedido"},
    {"texto": "Mercado Sur", "lat": 13.68, "lng": -89.19, "fuente": "pedido"},
    {"texto": "metrocentro, san salvador", "lat": 13.7, "lng": -89.2, "fuente": "pedido"},   # repetido
    {"texto": "Bodega Central", "lat": 13.69, "lng": -89.22, "fuente": "ruta"},
]


class LugaresTest(unittest.TestCase):
    def test_normalizar_ignora_tildes_y_mayusculas(self):
        self.assertEqual(lugares.normalizar("  Metrocéntro   SUR "), "metrocentro sur")

    def test_empiezan_con_lo_escrito_y_sin_repetidos(self):
        r = lugares.filtrar("metro", LOCALES)
        self.assertEqual([c["texto"] for c in r], ["Metrocentro, San Salvador", "Colonia Metropolitana"])

    def test_primero_los_que_empiezan_igual_luego_los_de_una_palabra(self):
        r = lugares.filtrar("metro", LOCALES)
        self.assertTrue(r[0]["texto"].lower().startswith("metro"))   # empieza igual
        self.assertTrue(r[1]["texto"].lower().startswith("colonia"))  # solo una palabra empieza así

    def test_menos_de_dos_caracteres_no_sugiere(self):
        self.assertEqual(lugares.filtrar("m", LOCALES), [])

    def test_sin_coincidencias(self):
        self.assertEqual(lugares.filtrar("zzz", LOCALES), [])

    def test_combinar_pone_primero_lo_del_sistema_y_no_repite(self):
        externos = [{"texto": "Metrocentro, San Salvador", "lat": 1, "lng": 2, "fuente": "mapa"},
                    {"texto": "Metrocentro Santa Ana", "lat": 3, "lng": 4, "fuente": "mapa"}]
        r = lugares.combinar("metro", LOCALES, externos)
        self.assertEqual([c["texto"] for c in r], ["Metrocentro, San Salvador", "Colonia Metropolitana", "Metrocentro Santa Ana"])
        self.assertEqual(r[0]["fuente"], "ruta")

    def test_limite(self):
        muchos = [{"texto": f"Calle {n}", "fuente": "pedido"} for n in range(30)]
        self.assertEqual(len(lugares.filtrar("calle", muchos)), lugares.MAX_SUGERENCIAS)

    def test_candidatos_de_filas(self):
        c = lugares.candidatos_de_filas(
            [{"origen_texto": "Bodega", "origen_lat": 1, "origen_lng": 2, "destino_texto": "Metro", "destino_lat": 3, "destino_lng": 4}],
            [{"direccion": "Soyapango", "cliente": "Cliente D", "lat": 5, "lng": 6}])
        self.assertEqual([x["texto"] for x in c], ["Bodega", "Metro", "Soyapango", "Cliente D"])


if __name__ == "__main__":
    unittest.main()
