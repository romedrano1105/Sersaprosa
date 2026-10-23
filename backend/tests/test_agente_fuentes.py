import unittest
from datetime import datetime, timedelta, timezone

from backend.agente_rutas import geo
from backend.agente_rutas.fuentes_supabase import (IncidentesSupabase, TraficoSinDatos, ZonasSupabase, a_incidente_alerta,
                                                   a_incidente_evento, hotspots)

AHORA = datetime(2026, 10, 23, 15, 0, tzinfo=timezone.utc)
iso = lambda m: (AHORA - timedelta(minutes=m)).isoformat()


class Consulta:
    """Fake encadenable de postgrest: aplica gte/lte/in_ sobre las filas en memoria."""

    def __init__(self, filas):
        self.filas, self.f = filas, []

    def select(self, *_): return self
    def limit(self, *_): return self
    def gte(self, c, v): self.f.append(lambda r: r.get(c) is not None and r[c] >= v); return self
    def lte(self, c, v): self.f.append(lambda r: r.get(c) is not None and r[c] <= v); return self
    def in_(self, c, vs): self.f.append(lambda r: r.get(c) in vs); return self
    def execute(self):
        from types import SimpleNamespace
        return SimpleNamespace(data=[r for r in self.filas if all(f(r) for f in self.f)])


class Cliente:
    def __init__(self, tablas): self.tablas = tablas
    def table(self, n): return Consulta(self.tablas[n])


class MapeoTest(unittest.TestCase):
    def test_alerta_alta_es_gravedad_5(self):
        i = a_incidente_alerta({"id": "a1", "fecha": iso(10), "tipo": "robo", "severidad": "alta", "lat": 13.7, "lng": -89.2})
        self.assertEqual((i.gravedad, i.tipo), (5, "robo"))

    def test_alerta_sin_coordenadas_se_ignora(self):
        self.assertIsNone(a_incidente_alerta({"id": "a", "fecha": iso(1), "severidad": "alta", "lat": None, "lng": None}))

    def test_evento_solo_marcha_o_cierre_y_vigente(self):
        base = {"id": "E1", "nombre": "Marcha", "tipo": "marcha", "impacto": "alto", "lat": 13.7, "lng": -89.2,
                "inicio": iso(60), "fin": (AHORA + timedelta(hours=1)).isoformat(), "radius_m": 500}
        self.assertEqual(a_incidente_evento(base, AHORA).gravedad, 4)
        self.assertIsNone(a_incidente_evento({**base, "tipo": "feriado"}, AHORA))
        self.assertIsNone(a_incidente_evento({**base, "fin": iso(5)}, AHORA))   # ya terminó
        self.assertIsNone(a_incidente_evento({**base, "inicio": (AHORA + timedelta(hours=2)).isoformat()}, AHORA))  # no empezó


class HotspotTest(unittest.TestCase):
    def alerta(self, sev, dias=2, lat=13.7001, lng=-89.2001):
        return {"id": "x", "fecha": (AHORA - timedelta(days=dias)).isoformat(), "tipo": "asalto", "severidad": sev, "lat": lat, "lng": lng}

    def test_umbrales_de_nivel(self):
        self.assertEqual(hotspots([self.alerta("media")] * 2, AHORA), [])                    # 2 puntos: no es zona
        self.assertEqual(hotspots([self.alerta("media")] * 3, AHORA)[0].nivel, 3)             # 3 puntos
        self.assertEqual(hotspots([self.alerta("alta")] * 2, AHORA)[0].nivel, 4)              # 4 puntos
        self.assertEqual(hotspots([self.alerta("alta")] * 3, AHORA)[0].nivel, 5)              # 6 puntos

    def test_alertas_viejas_no_cuentan_y_baja_no_pesa(self):
        self.assertEqual(hotspots([self.alerta("alta", dias=40)] * 5 + [self.alerta("baja")] * 9, AHORA), [])

    def test_el_poligono_contiene_las_alertas(self):
        z = hotspots([self.alerta("alta")] * 3, AHORA)[0]
        self.assertTrue(geo.punto_en_poligono((13.7001, -89.2001), z.poligono))


class AdaptadoresTest(unittest.TestCase):
    def test_incidentes_filtra_por_caja_y_vigencia(self):
        alertas = [
            {"id": "ok", "fecha": iso(30), "tipo": "robo", "severidad": "media", "lat": 13.70, "lng": -89.20},
            {"id": "vieja", "fecha": iso(600), "tipo": "robo", "severidad": "alta", "lat": 13.70, "lng": -89.20},
            {"id": "lejos", "fecha": iso(10), "tipo": "robo", "severidad": "alta", "lat": 14.5, "lng": -89.20},
        ]
        src = IncidentesSupabase(Cliente({"alertas_seguridad": alertas, "eventos_especiales": []}))
        ids = [i.id for i in src.activos((13.6, -89.3, 13.8, -89.1), AHORA)]
        self.assertEqual(ids, ["ok"])

    def test_zonas_desde_alertas(self):
        alertas = [{"id": str(n), "fecha": iso(60 * 24), "tipo": "asalto", "severidad": "alta", "lat": 13.7001, "lng": -89.2001}
                   for n in range(3)]
        zonas = ZonasSupabase(Cliente({"alertas_seguridad": alertas}), AHORA).zonas((13.6, -89.3, 13.8, -89.1))
        self.assertEqual([z.nivel for z in zonas], [5])

    def test_trafico_sin_datos_no_inventa(self):
        self.assertEqual(TraficoSinDatos().tramos((0, 0, 1, 1)), [])


if __name__ == "__main__":
    unittest.main()
