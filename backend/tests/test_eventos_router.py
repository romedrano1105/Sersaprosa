import unittest
from unittest.mock import patch

from fastapi import HTTPException

from backend.app import eventos_router


class Respuesta:
    def __init__(self, data):
        self.data = data


class Consulta:
    def __init__(self, cliente, tabla):
        self.cliente, self.tabla = cliente, tabla
        self.operacion, self.valores, self.filtros = "select", None, []
        self.seleccionar_despues = False

    def select(self, *_):
        self.seleccionar_despues = True
        return self

    def update(self, valores):
        self.operacion, self.valores = "update", valores
        return self

    def insert(self, valores):
        self.operacion, self.valores = "insert", valores
        return self

    def eq(self, campo, valor):
        self.filtros.append((campo, valor))
        return self

    def execute(self):
        filas = self.cliente.tablas.setdefault(self.tabla, [])
        if self.operacion == "insert":
            filas.append(dict(self.valores))
            return Respuesta([self.valores])

        if self.operacion == "update" and self.cliente.cambiar_antes_de_actualizar:
            filas[0]["estado"] = "revisado"
            self.cliente.cambiar_antes_de_actualizar = False

        coinciden = [
            fila for fila in filas
            if all(fila.get(campo) == valor for campo, valor in self.filtros)
        ]
        if self.operacion == "update":
            for fila in coinciden:
                fila.update(self.valores)
            return Respuesta([{"id": fila["id"]} for fila in coinciden] if self.seleccionar_despues else [])
        return Respuesta([dict(fila) for fila in coinciden])


class Cliente:
    def __init__(self, cambiar_antes_de_actualizar=False):
        self.tablas = {"eventos_especiales": [{"id": "E-1", "estado": "pendiente"}], "eventos_auditoria": []}
        self.cambiar_antes_de_actualizar = cambiar_antes_de_actualizar

    def table(self, tabla):
        return Consulta(self, tabla)


class RevisionEventoTest(unittest.TestCase):
    def test_revisar_usa_compare_and_set_por_estado_pendiente(self):
        cliente = Cliente()
        with patch.object(eventos_router, "usuario_coordinador", return_value=(cliente, "Ana")):
            resultado = eventos_router.revisar(eventos_router.Revision(id="E-1", nota="Revisado"), "Bearer token")

        self.assertEqual(resultado["estado"], "revisado")
        self.assertEqual(cliente.tablas["eventos_especiales"][0]["revisado_por"], "Ana")
        self.assertEqual(len(cliente.tablas["eventos_auditoria"]), 1)

    def test_conflicto_concurrente_no_inserta_auditoria(self):
        cliente = Cliente(cambiar_antes_de_actualizar=True)
        with patch.object(eventos_router, "usuario_coordinador", return_value=(cliente, "Ana")):
            with self.assertRaises(HTTPException) as error:
                eventos_router.revisar(eventos_router.Revision(id="E-1", nota="Revisado"), "Bearer token")

        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(cliente.tablas["eventos_auditoria"], [])


if __name__ == "__main__":
    unittest.main()
