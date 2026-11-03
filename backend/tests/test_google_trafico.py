import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx

from backend.agente_rutas.google_trafico import (
    MAX_INTERMEDIATES,
    URL_RUTAS,
    consultar_trafico_google,
    decodificar_polilinea,
    segmentos_desde_respuesta,
)


class GoogleTrafficTest(unittest.TestCase):
    def test_decodifica_polilinea_de_google(self):
        self.assertEqual(
            decodificar_polilinea("_p~iF~ps|U_ulLnnqC_mqNvxq`@"),
            [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]],
        )

    def test_convierte_intervalos_a_tramos(self):
        respuesta = {
            "routes": [{
                "polyline": {"encodedPolyline": "_p~iF~ps|U_ulLnnqC_mqNvxq`@"},
                "travelAdvisory": {"speedReadingIntervals": [
                    {"endPolylinePointIndex": 1, "speed": "NORMAL"},
                    {"startPolylinePointIndex": 1, "endPolylinePointIndex": 2, "speed": "TRAFFIC_JAM"},
                ]},
            }],
        }
        self.assertEqual(segmentos_desde_respuesta(respuesta), [
            {"velocidad": "NORMAL", "geometria": [[38.5, -120.2], [40.7, -120.95]]},
            {"velocidad": "TRAFFIC_JAM", "geometria": [[40.7, -120.95], [43.252, -126.453]]},
        ])

    def test_omite_segmentos_malformados_o_desconocidos(self):
        respuesta = {
            "routes": [{
                "polyline": {"encodedPolyline": "_p~iF~ps|U_ulLnnqC_mqNvxq`@"},
                "travelAdvisory": {"speedReadingIntervals": [
                    {"startPolylinePointIndex": 2, "endPolylinePointIndex": 9, "speed": "SLOW"},
                    {"startPolylinePointIndex": 0, "endPolylinePointIndex": 1, "speed": "UNKNOWN"},
                ]},
            }],
        }
        self.assertEqual(segmentos_desde_respuesta(respuesta), [])

    def test_sin_clave_no_hace_solicitud(self):
        with patch("backend.agente_rutas.google_trafico.httpx.post") as post:
            resultado = consultar_trafico_google(None, [[13.7, -89.2], [13.8, -89.1]])
        self.assertEqual(resultado, {"disponible": False, "segmentos": []})
        post.assert_not_called()

    def test_solicita_trafico_y_limita_puntos_intermedios(self):
        geometria = [[13.7 + indice / 1000, -89.2] for indice in range(40)]
        respuesta_google = SimpleNamespace(
            json=lambda: {
                "routes": [{
                    "polyline": {"encodedPolyline": "_p~iF~ps|U_ulLnnqC_mqNvxq`@"},
                    "travelAdvisory": {"speedReadingIntervals": [
                        {"endPolylinePointIndex": 2, "speed": "SLOW"},
                    ]},
                }],
            },
            raise_for_status=lambda: None,
        )
        with patch("backend.agente_rutas.google_trafico.httpx.post", return_value=respuesta_google) as post:
            resultado = consultar_trafico_google("secreto-de-prueba", geometria)

        self.assertTrue(resultado["disponible"])
        self.assertEqual(resultado["segmentos"][0]["velocidad"], "SLOW")
        post.assert_called_once()
        args, kwargs = post.call_args
        self.assertEqual(args[0], URL_RUTAS)
        self.assertEqual(kwargs["headers"]["X-Goog-Api-Key"], "secreto-de-prueba")
        self.assertEqual(kwargs["json"]["travelMode"], "DRIVE")
        self.assertEqual(kwargs["json"]["routingPreference"], "TRAFFIC_AWARE")
        self.assertEqual(kwargs["json"]["extraComputations"], ["TRAFFIC_ON_POLYLINE"])
        self.assertLessEqual(len(kwargs["json"]["intermediates"]), MAX_INTERMEDIATES)
        self.assertTrue(all(punto["via"] for punto in kwargs["json"]["intermediates"]))

    def test_propaga_error_http_de_google(self):
        error = httpx.HTTPStatusError(
            "falló", request=httpx.Request("POST", URL_RUTAS), response=httpx.Response(403)
        )
        respuesta_google = SimpleNamespace(raise_for_status=lambda: (_ for _ in ()).throw(error))
        with patch("backend.agente_rutas.google_trafico.httpx.post", return_value=respuesta_google):
            with self.assertRaises(httpx.HTTPStatusError):
                consultar_trafico_google("secreto-de-prueba", [[13.7, -89.2], [13.8, -89.1]])


if __name__ == "__main__":
    unittest.main()
