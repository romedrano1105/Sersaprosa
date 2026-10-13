"""Pruebas de consistencia, filtros y paginación del historial de alertas."""
import unittest
from datetime import datetime, timedelta, timezone

from backend.app import alertas_seguridad_logica as logica

AHORA = datetime(2026, 10, 11, 18, tzinfo=timezone.utc)


def fixture():
    viajes = [
        {"id": "V-1", "fecha_finalizacion": (AHORA - timedelta(days=2)).isoformat(), "ruta": "Centro", "conductor": "Ana", "alertas_count": 2},
        {"id": "V-2", "fecha_finalizacion": (AHORA - timedelta(days=4)).isoformat(), "ruta": "Norte", "conductor": "Luis", "alertas_count": 1},
    ]
    alertas = [
        {"id": "A-1", "viaje_id": "V-1", "fecha": (AHORA - timedelta(hours=3)).isoformat(), "tipo": "frenado", "severidad": "baja", "estado": "pendiente"},
        {"id": "A-2", "viaje_id": "V-1", "fecha": (AHORA - timedelta(hours=2)).isoformat(), "tipo": "velocidad", "severidad": "alta", "estado": "revisada"},
        {"id": "A-3", "viaje_id": "V-2", "fecha": (AHORA - timedelta(days=1)).isoformat(), "tipo": "frenado", "severidad": "baja", "estado": "pendiente"},
    ]
    return viajes, alertas


class ListadoAlertas(unittest.TestCase):
    def test_orden_paginacion_y_pendientes(self):
        viajes, alertas = fixture()
        resultado = logica.construir_respuesta(viajes, alertas, {}, 1, 2, AHORA)
        self.assertEqual([item["id"] for item in resultado["items"]], ["A-2", "A-1"])
        self.assertEqual(resultado["total"], 3)
        self.assertEqual(resultado["pending_count"], 2)
        self.assertEqual(resultado["pending_outside_filters"], 0)

    def test_filtros_avisan_pendientes_fuera(self):
        viajes, alertas = fixture()
        resultado = logica.construir_respuesta(viajes, alertas, {"conductor": "Ana"}, 1, 25, AHORA)
        self.assertEqual([item["id"] for item in resultado["items"]], ["A-2", "A-1"])
        self.assertEqual(resultado["pending_outside_filters"], 1)

    def test_conteo_inconsistente_no_devuelve_listado(self):
        viajes, alertas = fixture()
        viajes[0]["alertas_count"] = 3
        with self.assertRaises(logica.InconsistenciaAlertas):
            logica.construir_respuesta(viajes, alertas, {}, 1, 25, AHORA)

    def test_excluye_viajes_fuera_de_retencion(self):
        viajes, alertas = fixture()
        viajes[0]["fecha_finalizacion"] = (AHORA - timedelta(days=91)).isoformat()
        resultado = logica.construir_respuesta(viajes, alertas, {}, 1, 25, AHORA)
        self.assertEqual({item["id"] for item in resultado["items"]}, {"A-3"})


if __name__ == "__main__":
    unittest.main()
