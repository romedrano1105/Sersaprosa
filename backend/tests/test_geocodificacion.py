"""Pruebas de la geocodificación del planificador multi-paradas."""
import os
import unittest
from unittest.mock import Mock, patch

from backend.app import geocodificacion_router as geo


class Geocodificacion(unittest.TestCase):
    def test_openrouteservice_devuelve_lat_lng_y_etiqueta(self):
        response = Mock()
        response.json.return_value = {"features": [{
            "geometry": {"coordinates": [-89.2182, 13.6929]},
            "properties": {"label": "San Salvador, El Salvador"},
        }]}
        with patch.dict(os.environ, {"OPENROUTESERVICE_API_KEY": "test-key"}), \
             patch.object(geo.httpx, "get", return_value=response) as get:
            lugar = geo.geocodificar("San Salvador")
        self.assertEqual(lugar, {"lat": 13.6929, "lng": -89.2182, "label": "San Salvador, El Salvador"})
        self.assertEqual(get.call_args.kwargs["params"]["boundary.country"], "SV")

    def test_sin_clave_usa_nominatim(self):
        response = Mock()
        response.json.return_value = [{"lat": "13.7", "lon": "-89.2", "display_name": "Soyapango"}]
        with patch.dict(os.environ, {"OPENROUTESERVICE_API_KEY": ""}), \
             patch.object(geo.httpx, "get", return_value=response) as get:
            lugar = geo.geocodificar("Soyapango")
        self.assertEqual(lugar["lat"], 13.7)
        self.assertEqual(get.call_args.args[0], geo.NOMINATIM_URL)

    def test_sin_resultados_o_texto_corto_es_error_de_validacion(self):
        response = Mock()
        response.json.return_value = []
        with patch.dict(os.environ, {"OPENROUTESERVICE_API_KEY": ""}), \
             patch.object(geo.httpx, "get", return_value=response):
            with self.assertRaises(ValueError):
                geo.geocodificar("lugar inexistente")
        with self.assertRaises(ValueError):
            geo.geocodificar("ab")


if __name__ == "__main__":
    unittest.main()
