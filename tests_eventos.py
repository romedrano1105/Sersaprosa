"""Pruebas de la lógica de eventos especiales. Ejecutar: python -m unittest tests_eventos.py -v"""
import unittest
from datetime import date, timedelta

import eventos_logica as L

HOY = date(2026, 10, 11)


def dia(n, hora="09:00"):
    return (HOY + timedelta(days=n)).isoformat() + "T" + hora


RUTAS = [
    {"id": "R-100", "zona": "Centro Histórico", "fecha": (HOY + timedelta(days=1)).isoformat(), "entregas": 14, "conductor": "Carlos"},
    {"id": "R-102", "zona": "Santa Tecla", "fecha": (HOY + timedelta(days=3)).isoformat(), "entregas": 11, "conductor": "Luis"},
]
EVENTOS = [
    {"id": "E-1", "nombre": "Marcha", "tipo": "marcha", "inicio": dia(1), "fin": dia(1, "13:00"), "zona": "centro historico", "impacto": "alto"},
    {"id": "E-2", "nombre": "Feriado", "tipo": "feriado", "inicio": dia(3, "00:00"), "zona": "Nacional", "impacto": "medio"},
    {"id": "E-3", "nombre": "Fuera de rango", "tipo": "marcha", "inicio": dia(45), "zona": "Centro Histórico", "impacto": "alto"},
]


class Ventana(unittest.TestCase):
    def test_limites(self):
        self.assertTrue(L.en_ventana({"inicio": dia(0)}, HOY))
        self.assertTrue(L.en_ventana({"inicio": dia(30)}, HOY))
        self.assertFalse(L.en_ventana({"inicio": dia(31)}, HOY))
        self.assertFalse(L.en_ventana({"inicio": dia(-1)}, HOY))
        self.assertTrue(L.en_ventana({"inicio": dia(-1), "fin": dia(1)}, HOY))


class Respuesta(unittest.TestCase):
    def test_orden_ventana_y_rutas(self):
        r = L.construir_respuesta(list(reversed(EVENTOS)), RUTAS, [], HOY)
        self.assertEqual([e["id"] for e in r["events"]], ["E-1", "E-2"])
        self.assertEqual(r["totals"]["events"], 2)
        self.assertEqual(r["events"][0]["rutas_afectadas"], ["R-100"])      # misma zona y fecha (sin tildes)
        self.assertEqual(r["events"][1]["rutas_afectadas"], ["R-102"])      # feriado nacional afecta a todas ese día

    def test_evento_sin_rutas(self):
        e = {"inicio": dia(5), "zona": "Soyapango"}
        self.assertEqual(L.rutas_afectadas(e, RUTAS), [])


class Registro(unittest.TestCase):
    ok = {"nombre": "Cierre en el bulevar", "tipo": "cierre_vial", "inicio": dia(5, "08:00"), "zona": "Santa Tecla", "impacto": "alto"}

    def test_valido(self):
        self.assertEqual(L.validar_evento(self.ok, EVENTOS, HOY), [])

    def test_obligatorios(self):
        self.assertGreaterEqual(len(L.validar_evento({}, EVENTOS, HOY)), 5)

    def test_fecha_pasada_o_lejana(self):
        self.assertEqual(len(L.validar_evento({**self.ok, "inicio": dia(-2)}, EVENTOS, HOY)), 1)
        self.assertEqual(len(L.validar_evento({**self.ok, "inicio": dia(40)}, EVENTOS, HOY)), 1)

    def test_coordenadas(self):
        self.assertEqual(len(L.validar_evento({**self.ok, "lat": 13.6}, EVENTOS, HOY)), 1)
        self.assertEqual(len(L.validar_evento({**self.ok, "lat": 95, "lng": 0}, EVENTOS, HOY)), 1)
        self.assertEqual(L.validar_evento({**self.ok, "lat": 13.6, "lng": -89.2}, EVENTOS, HOY), [])

    def test_duplicados(self):
        mismo_nombre = {**self.ok, "nombre": " MARCHA ", "tipo": "otro", "inicio": dia(1, "20:00"), "zona": "Centro Histórico"}
        self.assertTrue(L.validar_evento(mismo_nombre, EVENTOS, HOY)[0].startswith("Ya existe"))
        mismo_tipo_hora = {**self.ok, "nombre": "Otra", "tipo": "marcha", "inicio": dia(1, "09:00"), "zona": "Centro Histórico"}
        self.assertTrue(L.validar_evento(mismo_tipo_hora, EVENTOS, HOY)[0].startswith("Ya existe"))
        distinto = {**self.ok, "nombre": "Otra", "tipo": "otro", "inicio": dia(1, "20:00"), "zona": "Centro Histórico"}
        self.assertEqual(L.validar_evento(distinto, EVENTOS, HOY), [])


if __name__ == "__main__":
    unittest.main()
