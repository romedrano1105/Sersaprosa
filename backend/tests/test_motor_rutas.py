"""Pruebas de exclusión de riesgos, proveedores y caché de rutas."""
import os
import unittest
from datetime import date, timedelta
from unittest.mock import Mock, patch

import httpx

from backend.app import motor_rutas
from backend.app import rutas_router


class ZonasDeRiesgo(unittest.TestCase):
    def setUp(self):
        with motor_rutas._cache_lock:
            motor_rutas._cache.clear()

    def test_solo_incluye_riesgos_altos_y_medios_geolocalizados(self):
        eventos = [
            {"severidad": "alta", "lat": 13.7, "lng": -89.2, "radius_m": 500},
            {"severidad": "media", "lat": 13.8, "lng": -89.1},
            {"severidad": "baja", "lat": 13.9, "lng": -89.0},
            {"severidad": "alta", "lat": None, "lng": None},
        ]
        zonas = motor_rutas.filtrar_zonas_de_riesgo(eventos)
        self.assertEqual(len(zonas), 2)
        self.assertEqual(zonas[0]["radius_m"], 500)
        self.assertEqual(zonas[1]["radius_m"], 350)

    def test_poligono_geojson_cierra_anillo(self):
        poligono = motor_rutas._poligonos_a_evitar([
            {"lat": 13.7, "lng": -89.2, "radius_m": 350}
        ])
        self.assertEqual(poligono["type"], "MultiPolygon")
        anillo = poligono["coordinates"][0][0]
        self.assertEqual(anillo[0], anillo[-1])

    def test_detecta_ruta_que_cruza_zona_de_riesgo(self):
        zona = {"lat": 13.7, "lng": -89.2, "radius_m": 100}
        cruza = [[-89.202, 13.7], [-89.198, 13.7]]
        segura = [[-89.202, 13.71], [-89.198, 13.71]]
        self.assertTrue(motor_rutas.ruta_intersecta_zonas(cruza, [zona]))
        self.assertFalse(motor_rutas.ruta_intersecta_zonas(segura, [zona]))


class RiesgosDesdeLaBase(unittest.TestCase):
    def test_impactos_se_mapean_y_eventos_fuera_de_ventana_se_ignoran(self):
        hoy = date(2026, 10, 16)
        eventos = [
            {"impacto": "alto", "inicio": hoy.isoformat(), "lat": 13.7, "lng": -89.2, "radius_m": 400},
            {"impacto": "medio", "inicio": (hoy + timedelta(days=31)).isoformat(), "lat": 13.8, "lng": -89.1},
            {"impacto": "bajo", "inicio": hoy.isoformat(), "lat": 13.9, "lng": -89.0},
        ]
        alertas = [{"severidad": "media", "lat": 13.6, "lng": -89.3}]
        riesgos = rutas_router._normalizar_riesgos(eventos, alertas, hoy)
        self.assertEqual([riesgo["severidad"] for riesgo in riesgos], ["alta", "media"])
        self.assertEqual(riesgos[1]["radius_m"], 250)


class CalculoDeRutas(unittest.TestCase):
    def setUp(self):
        with motor_rutas._cache_lock:
            motor_rutas._cache.clear()
        self.coordenadas = [(13.7, -89.2), (13.71, -89.19)]
        self.ruta_segura = {
            "distance": 1800,
            "duration": 300,
            "geometry": {"coordinates": [[-89.2, 13.71], [-89.19, 13.71]]},
            "steps": [],
        }
        self.zona = [{"severidad": "alta", "lat": 13.7, "lng": -89.2, "radius_m": 100}]

    def test_osrm_es_respaldo_y_cachea_respuesta(self):
        with patch.dict(os.environ, {"OPENROUTESERVICE_API_KEY": ""}), \
             patch.object(motor_rutas, "_solicitar_osrm", return_value=[self.ruta_segura]) as osrm:
            primero = motor_rutas.calcular_rutas(self.coordenadas, self.zona)
            segundo = motor_rutas.calcular_rutas(self.coordenadas, self.zona)
        self.assertEqual(primero["provider"], "OSRM")
        self.assertFalse(primero["cached"])
        self.assertTrue(segundo["cached"])
        osrm.assert_called_once()

    def test_rechaza_rutas_de_respaldo_que_cruzan_riesgos(self):
        ruta_insegura = {
            **self.ruta_segura,
            "geometry": {"coordinates": [[-89.202, 13.7], [-89.198, 13.7]]},
        }
        with patch.dict(os.environ, {"OPENROUTESERVICE_API_KEY": ""}), \
             patch.object(motor_rutas, "_solicitar_osrm", return_value=[ruta_insegura]):
            with self.assertRaises(motor_rutas.ErrorProveedorRutas):
                motor_rutas.calcular_rutas(self.coordenadas, self.zona)

    def test_openrouteservice_precede_a_osrm(self):
        with patch.dict(os.environ, {"OPENROUTESERVICE_API_KEY": "test-key"}), \
             patch.object(motor_rutas, "_solicitar_ors", return_value=[self.ruta_segura]) as ors, \
             patch.object(motor_rutas, "_solicitar_osrm") as osrm:
            respuesta = motor_rutas.calcular_rutas(self.coordenadas, self.zona)
        self.assertEqual(respuesta["provider"], "OpenRouteService")
        ors.assert_called_once()
        osrm.assert_not_called()

    def test_openrouteservice_recibe_poligonos_y_devuelve_indicaciones(self):
        response = Mock()
        response.json.return_value = {
            "features": [{
                "geometry": {"coordinates": [[-89.2, 13.71], [-89.19, 13.71]]},
                "properties": {
                    "summary": {"distance": 1800, "duration": 300},
                    "segments": [{"steps": [{
                        "instruction": "Gire a la derecha",
                        "distance": 250,
                        "duration": 40,
                        "way_points": [0, 1],
                    }]}],
                },
            }],
        }
        with patch.object(motor_rutas.httpx, "post", return_value=response) as post:
            rutas = motor_rutas._solicitar_ors(self.coordenadas, [
                {"lat": 13.7, "lng": -89.2, "radius_m": 100}
            ], "test-key")
        payload = post.call_args.kwargs["json"]
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "test-key")
        self.assertEqual(payload["options"]["avoid_polygons"]["type"], "MultiPolygon")
        self.assertEqual(rutas[0]["steps"][0]["instruction"], "Gire a la derecha")

    def test_error_de_openrouteservice_activa_osrm(self):
        with patch.dict(os.environ, {"OPENROUTESERVICE_API_KEY": "test-key"}), \
             patch.object(motor_rutas, "_solicitar_ors", side_effect=httpx.ConnectError("sin conexión")), \
             patch.object(motor_rutas, "_solicitar_osrm", return_value=[self.ruta_segura]) as osrm:
            respuesta = motor_rutas.calcular_rutas(self.coordenadas, self.zona)
        self.assertEqual(respuesta["provider"], "OSRM")
        osrm.assert_called_once()


class Geocodificacion(unittest.TestCase):
    def test_openrouteservice_devuelve_lat_lng_y_etiqueta(self):
        response = Mock()
        response.json.return_value = {"features": [{
            "geometry": {"coordinates": [-89.2182, 13.6929]},
            "properties": {"label": "San Salvador, El Salvador"},
        }]}
        with patch.dict(os.environ, {"OPENROUTESERVICE_API_KEY": "test-key"}), \
             patch.object(motor_rutas.httpx, "get", return_value=response) as get:
            lugar = motor_rutas.geocodificar("San Salvador")
        self.assertEqual(lugar, {"lat": 13.6929, "lng": -89.2182, "label": "San Salvador, El Salvador"})
        self.assertEqual(get.call_args.kwargs["params"]["boundary.country"], "SV")

    def test_sin_clave_usa_nominatim(self):
        response = Mock()
        response.json.return_value = [{"lat": "13.7", "lon": "-89.2", "display_name": "Soyapango"}]
        with patch.dict(os.environ, {"OPENROUTESERVICE_API_KEY": ""}), \
             patch.object(motor_rutas.httpx, "get", return_value=response) as get:
            lugar = motor_rutas.geocodificar("Soyapango")
        self.assertEqual(lugar["lat"], 13.7)
        self.assertEqual(get.call_args.args[0], motor_rutas.NOMINATIM_URL)

    def test_sin_resultados_o_texto_corto_es_error_de_validacion(self):
        response = Mock()
        response.json.return_value = []
        with patch.dict(os.environ, {"OPENROUTESERVICE_API_KEY": ""}), \
             patch.object(motor_rutas.httpx, "get", return_value=response):
            with self.assertRaises(ValueError):
                motor_rutas.geocodificar("lugar inexistente")
        with self.assertRaises(ValueError):
            motor_rutas.geocodificar("ab")


if __name__ == "__main__":
    unittest.main()
