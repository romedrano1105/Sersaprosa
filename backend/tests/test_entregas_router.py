import os
import unittest
from datetime import date, timedelta
from unittest.mock import patch

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")

from backend.app import entregas_router


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
        fecha_inicio = self.filtros[0][2]
        fecha_fin = self.filtros[1][2]
        filtradas = [
            fila for fila in self.filas
            if fecha_inicio <= fila["hora_programada"][:10] < fecha_fin
        ]
        return type("Respuesta", (), {"data": filtradas[inicio:fin + 1]})()


class Cliente:
    def __init__(self, filas):
        self.consulta = Consulta(filas)

    def table(self, _nombre):
        return self.consulta


class ListarEntregasTest(unittest.TestCase):
    def test_filtra_fecha_en_supabase_y_recupera_todas_las_paginas(self):
        hoy = date.today()
        filas = [
            {"id": str(i), "hora_programada": f"{hoy.isoformat()}T08:00:00", "estado": "pendiente"}
            for i in range(1001)
        ]
        filas.append({"id": "otro-dia", "hora_programada": f"{(hoy + timedelta(days=1)).isoformat()}T00:00:00"})
        cliente = Cliente(filas)

        with patch.object(entregas_router, "usuario_autorizado", return_value=cliente):
            respuesta = entregas_router.listar(entregas_router.Consulta(fecha=hoy.isoformat()))

        self.assertEqual(respuesta["totals"]["todos"], 1001)
        self.assertEqual(cliente.consulta.rangos, [(0, 999), (1000, 1999)])
        self.assertEqual(
            cliente.consulta.filtros,
            [
                ("hora_programada", ">=", hoy.isoformat()),
                ("hora_programada", "<", (hoy + timedelta(days=1)).isoformat()),
            ],
        )


if __name__ == "__main__":
    unittest.main()
