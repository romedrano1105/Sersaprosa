import os
import unittest
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo
from unittest.mock import patch

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")

from backend.app import entregas_logica, entregas_router


class Consulta:
    def __init__(self, filas):
        self.filas = filas
        self.filtros = []
        self.rangos = []

    def select(self, *_):
        return self

    def gte(self, campo, valor):
        self.filtros.append((campo, ">=", valor))
        return self

    def lt(self, campo, valor):
        self.filtros.append((campo, "<", valor))
        return self

    def order(self, *_args, **_kwargs):
        return self

    def range(self, inicio, fin):
        self.rangos.append((inicio, fin))
        self.rango_actual = (inicio, fin)
        return self

    def execute(self):
        inicio, fin = self.rango_actual
        fecha_inicio = datetime.fromisoformat(self.filtros[0][2])
        fecha_fin = datetime.fromisoformat(self.filtros[1][2])
        filtradas = [
            fila for fila in self.filas
            if fecha_inicio <= datetime.fromisoformat(fila["hora_programada"]) < fecha_fin
        ]
        return type("Respuesta", (), {"data": filtradas[inicio:fin + 1]})()


class Cliente:
    def __init__(self, filas):
        self.consulta = Consulta(filas)

    def table(self, _nombre):
        return self.consulta


class ListarEntregasTest(unittest.TestCase):
    def test_filtra_fecha_en_supabase_y_recupera_todas_las_paginas(self):
        hoy = date(2026, 11, 2)
        inicio_utc = datetime.combine(hoy, time.min, tzinfo=ZoneInfo("America/El_Salvador")).astimezone(timezone.utc)
        filas = [
            {"id": str(i), "hora_programada": (inicio_utc + timedelta(minutes=i)).isoformat(), "estado": "pendiente"}
            for i in range(1001)
        ]
        siguiente_dia_utc = datetime.combine(
            hoy + timedelta(days=1), time.min, tzinfo=ZoneInfo("America/El_Salvador")
        ).astimezone(timezone.utc)
        filas.append({"id": "otro-dia", "hora_programada": siguiente_dia_utc.isoformat()})
        cliente = Cliente(filas)

        with patch.object(entregas_router, "usuario_autorizado", return_value=cliente):
            respuesta = entregas_router.listar(entregas_router.Consulta(fecha=hoy.isoformat()))

        self.assertEqual(respuesta["totals"]["todos"], 1001)
        self.assertEqual(cliente.consulta.rangos, [(0, 999), (1000, 1999)])
        self.assertEqual(
            cliente.consulta.filtros,
            [
                ("hora_programada", ">=", "2026-11-02T06:00:00+00:00"),
                ("hora_programada", "<", "2026-11-03T06:00:00+00:00"),
            ],
        )

    def test_incluye_pedidos_cercanos_a_medianoche_segun_fecha_local(self):
        fecha = date(2026, 11, 2)
        filas = [
            {"id": "antes", "hora_programada": "2026-11-02T05:59:59+00:00"},
            {"id": "inicio", "hora_programada": "2026-11-02T06:00:00+00:00"},
            {"id": "fin", "hora_programada": "2026-11-03T05:59:59+00:00"},
            {"id": "siguiente", "hora_programada": "2026-11-03T06:00:00+00:00"},
        ]

        respuesta = entregas_logica.construir_respuesta(filas, fecha)

        self.assertEqual({pedido["id"] for pedido in respuesta["entregas"]}, {"inicio", "fin"})


if __name__ == "__main__":
    unittest.main()
