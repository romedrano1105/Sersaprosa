import unittest
from datetime import date

from backend.app import rutas_admin


class Resp:
    def __init__(self, data):
        self.data = data


class Consulta:
    def __init__(self, db, tabla):
        self.db, self.tabla = db, tabla
        self.op, self.valores, self.filtros = "select", None, []
        self.limite = None

    def select(self, *_):
        return self

    def insert(self, valores):
        self.op, self.valores = "insert", valores
        return self

    def update(self, valores):
        self.op, self.valores = "update", valores
        return self

    def delete(self):
        self.op = "delete"
        return self

    def eq(self, campo, valor):
        self.filtros.append((campo, lambda v, x=valor: v == x))
        return self

    def in_(self, campo, valores):
        self.filtros.append((campo, lambda v, xs=tuple(valores): v in xs))
        return self

    def limit(self, n):
        self.limite = n
        return self

    def _coincide(self, fila):
        return all(f(fila.get(c)) for c, f in self.filtros)

    def execute(self):
        filas = self.db.setdefault(self.tabla, [])
        if self.op == "insert":
            filas.append(dict(self.valores))
            return Resp([self.valores])
        if self.op == "update":
            for fila in filas:
                if self._coincide(fila):
                    fila.update(self.valores)
            return Resp([])
        if self.op == "delete":
            filas[:] = [f for f in filas if not self._coincide(f)]
            return Resp([])
        hallados = [dict(f) for f in filas if self._coincide(f)]
        return Resp(hallados[: self.limite] if self.limite else hallados)


class Cliente:
    def __init__(self, db):
        self.db = db

    def table(self, tabla):
        return Consulta(self.db, tabla)


HOY = date(2026, 10, 20)


def base():
    return {
        "entregas": [
            {"id": "P1", "ruta": None, "estado": "pendiente"},
            {"id": "P2", "ruta": None, "estado": "pendiente"},
            {"id": "P3", "ruta": "Otra", "estado": "pendiente"},
        ],
        "rutas_planificadas": [],
        "asignaciones_ruta": [],
    }


class RutasAdminTest(unittest.TestCase):
    def test_guardar_marca_pedidos(self):
        db = base()
        r = rutas_admin.guardar_ruta(Cliente(db), "Norte", ["P1", "P2"], "ana", HOY)
        self.assertEqual(db["rutas_planificadas"][0]["entregas"], 2)
        self.assertEqual({f["ruta"] for f in db["entregas"][:2]}, {"Norte"})
        self.assertTrue(r["id"].startswith("RT-"))

    def test_guardar_rechaza_pedido_en_otra_ruta(self):
        with self.assertRaises(rutas_admin.ReglaDeNegocio):
            rutas_admin.guardar_ruta(Cliente(base()), "Norte", ["P3"], "ana", HOY)

    def test_actualizar_libera_pedidos_quitados(self):
        db = base()
        c = Cliente(db)
        r = rutas_admin.guardar_ruta(c, "Norte", ["P1", "P2"], "ana", HOY)
        rutas_admin.actualizar_ruta(c, r["id"], "Norte 2", ["P2"], "ana", HOY)
        self.assertIsNone(db["entregas"][0]["ruta"])
        self.assertEqual(db["entregas"][1]["ruta"], "Norte 2")
        self.assertEqual(db["rutas_planificadas"][0]["nombre"], "Norte 2")

    def test_desasignar(self):
        db = base()
        db["rutas_planificadas"].append({"id": "R", "nombre": "N", "fecha": HOY.isoformat(), "conductor": "Ana"})
        db["asignaciones_ruta"].append({"ruta_id": "R", "fecha_operativa": HOY.isoformat()})
        rutas_admin.desasignar_ruta(Cliente(db), "R", HOY)
        self.assertEqual(db["asignaciones_ruta"], [])
        self.assertIsNone(db["rutas_planificadas"][0]["conductor"])
        with self.assertRaises(rutas_admin.ReglaDeNegocio):
            rutas_admin.desasignar_ruta(Cliente(db), "R", HOY)


if __name__ == "__main__":
    unittest.main()
