"""Pruebas de las notificaciones del administrador (FCJ1-16).
Se llama test_*.py a propósito: así pytest en CI sí las encuentra."""
import os
import unittest
from datetime import date
from types import SimpleNamespace
from unittest import mock

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")

from fastapi.testclient import TestClient

from backend.app import notificaciones_logica as L
from backend.app import notificaciones_router as R
from backend.app.main import app

HOY = date(2026, 10, 18)
RUTAS = [
    {"id": "R-1", "nombre": "Ruta Centro", "zona": "Centro Histórico", "fecha": "2026-10-18"},
    {"id": "R-2", "nombre": "Ruta Santa Tecla", "zona": "Santa Tecla", "fecha": "2026-10-18"},
]


class Urgencia(unittest.TestCase):
    def test_colores(self):
        self.assertEqual(L.color_de("alta"), "roja")
        self.assertEqual(L.color_de("media"), "naranja")
        self.assertEqual(L.color_de("baja"), "amarilla")

    def test_impacto_de_eventos_se_traduce(self):
        self.assertEqual(L.urgencia_valida("alto"), "alta")
        self.assertEqual(L.urgencia_valida("Medio"), "media")
        self.assertEqual(L.urgencia_valida("bajo"), "baja")

    def test_sin_urgencia_valida_no_inventa_color(self):
        for valor in (None, "", "grave", "urgente"):
            self.assertIsNone(L.urgencia_valida(valor))
        self.assertEqual(L.color_de(None), "sin_clasificar")


class Generacion(unittest.TestCase):
    def evento(self, **extra):
        return L.hecho_de_evento({"id": "E-1", "nombre": "Marcha", "inicio": "2026-10-18T09:00", "zona": "centro historico", "impacto": "alto", **extra})

    def test_evento_coincide_por_fecha_y_zona(self):
        nuevas = L.generar([self.evento()], RUTAS, set(), HOY)
        self.assertEqual([(n["origen"], n["ruta_id"], n["urgencia"]) for n in nuevas], [("evento", "R-1", "alta")])
        self.assertEqual(nuevas[0]["ruta"], "Ruta Centro")

    def test_otra_fecha_o_zona_no_notifica(self):
        self.assertEqual(L.generar([self.evento(inicio="2026-10-20T09:00")], RUTAS, set(), HOY), [])
        self.assertEqual(L.generar([self.evento(zona="Soyapango")], RUTAS, set(), HOY), [])

    def test_zona_nacional_afecta_a_todas_las_rutas(self):
        nuevas = L.generar([self.evento(zona="Nacional")], RUTAS, set(), HOY)
        self.assertEqual({n["ruta_id"] for n in nuevas}, {"R-1", "R-2"})

    def test_sin_duplicados(self):
        hechos = [self.evento(), self.evento()]            # el mismo hecho repetido en la tanda
        self.assertEqual(len(L.generar(hechos, RUTAS, set(), HOY)), 1)
        existentes = {L.clave("evento", "E-1", "R-1")}      # ya notificado antes
        self.assertEqual(L.generar([self.evento()], RUTAS, existentes, HOY), [])

    def test_alerta_avisa_por_nombre_de_ruta_durante_una_semana(self):
        viaje = {"id": "V-1", "ruta": "Ruta Santa Tecla"}
        reciente = L.hecho_de_alerta({"id": "A-1", "tipo": "Exceso de velocidad", "fecha": "2026-10-16T10:00:00+00:00", "severidad": "media"}, viaje)
        vieja = L.hecho_de_alerta({"id": "A-2", "tipo": "Frenado", "fecha": "2026-09-01T10:00:00+00:00", "severidad": "alta"}, viaje)
        nuevas = L.generar([reciente, vieja], RUTAS, set(), HOY)
        self.assertEqual([(n["origen_id"], n["ruta_id"], n["urgencia"]) for n in nuevas], [("A-1", "R-2", "media")])

    def test_choque_y_emergencia_usan_zona_y_fecha(self):
        choque = L.hecho_de_incidente({"id": "C-1", "tipo": "choque", "titulo": "Choque en bulevar", "zona": "Santa Tecla", "fecha": "2026-10-18T07:30:00", "urgencia": "baja"})
        emergencia = L.hecho_de_incidente({"id": "M-1", "tipo": "emergencia", "titulo": "Incendio", "zona": "Centro Histórico", "fecha": "2026-10-18T08:00:00", "urgencia": "alta"})
        nuevas = {n["origen"]: n for n in L.generar([choque, emergencia], RUTAS, set(), HOY)}
        self.assertEqual(nuevas["choque"]["ruta_id"], "R-2")
        self.assertEqual(nuevas["emergencia"]["ruta_id"], "R-1")
        self.assertIsNone(L.hecho_de_incidente({"id": "X", "tipo": "otro"}))

    def test_hecho_sin_urgencia_queda_sin_clasificar(self):
        nuevas = L.generar([self.evento(impacto="raro")], RUTAS, set(), HOY)
        self.assertIsNone(nuevas[0]["urgencia"])


class Presentacion(unittest.TestCase):
    def test_orden_urgentes_primero_y_mas_reciente_dentro_del_nivel(self):
        items = [
            {"id": 1, "urgencia": "baja", "fecha": "2026-10-18T12:00"},
            {"id": 2, "urgencia": "alta", "fecha": "2026-10-18T08:00"},
            {"id": 3, "urgencia": "alta", "fecha": "2026-10-18T10:00"},
            {"id": 4, "urgencia": None, "fecha": "2026-10-18T13:00"},
            {"id": 5, "urgencia": "media", "fecha": "2026-10-18T09:00"},
        ]
        self.assertEqual([n["id"] for n in L.ordenar(items)], [3, 2, 5, 1, 4])

    def test_resumen_cuenta_solo_no_leidas_por_color(self):
        items = [
            {"urgencia": "alta", "leida": False}, {"urgencia": "alta", "leida": True},
            {"urgencia": "media", "leida": False}, {"urgencia": None, "leida": False},
        ]
        r = L.resumen(items)
        self.assertEqual((r["total"], r["no_leidas"], r["roja"], r["naranja"], r["amarilla"], r["sin_clasificar"]), (4, 3, 1, 1, 0, 1))


# ---------- Endpoints con un Supabase de mentira ----------

class Consulta:
    def __init__(self, tablas, nombre, falla):
        self.tablas, self.nombre, self.falla = tablas, nombre, falla
        self.filtros, self.accion, self.datos = [], "select", None

    def select(self, *_): self.accion = "select"; return self
    def order(self, *_, **__): return self
    def limit(self, *_): return self
    def eq(self, col, valor): self.filtros.append((col, valor)); return self
    def upsert(self, datos, **_): self.accion, self.datos = "upsert", datos; return self
    def insert(self, datos): self.accion, self.datos = "insert", datos; return self
    def update(self, datos): self.accion, self.datos = "update", datos; return self

    def execute(self):
        if self.nombre in self.falla:
            raise RuntimeError("falla simulada en " + self.nombre)
        filas = self.tablas.setdefault(self.nombre, [])
        if self.accion == "select":
            sel = [f for f in filas if all(str(f.get(c)) == str(v) for c, v in self.filtros)]
            return SimpleNamespace(data=sel)
        datos = self.datos if isinstance(self.datos, list) else [self.datos]
        if self.accion == "upsert":
            claves = {(f["origen"], f["origen_id"], f["ruta_id"]) for f in filas}
            nuevos = []
            for d in datos:
                k = (d["origen"], d["origen_id"], d["ruta_id"])
                if k not in claves:
                    claves.add(k)
                    fila = {**d, "id": f"N-{len(filas) + 1}", "leida": False, "creada_en": "2026-10-18T10:00:00+00:00"}
                    filas.append(fila)
                    nuevos.append(fila)
            return SimpleNamespace(data=nuevos)
        if self.accion == "insert":
            filas.extend(datos)
            return SimpleNamespace(data=datos)
        for f in filas:
            if all(str(f.get(c)) == str(v) for c, v in self.filtros):
                f.update(self.datos)
        return SimpleNamespace(data=[])


class Cliente:
    def __init__(self, tablas, falla=()):
        self.tablas, self.falla = tablas, set(falla)

    def table(self, nombre):
        return Consulta(self.tablas, nombre, self.falla)


def tablas_base():
    return {
        "rutas_planificadas": [dict(r) for r in RUTAS],
        "eventos_especiales": [{"id": "E-1", "nombre": "Marcha", "inicio": date.today().isoformat() + "T09:00", "zona": "Nacional", "impacto": "alto"}],
        "viajes_finalizados": [], "alertas_seguridad": [], "incidentes_ruta": [],
    }


class Endpoints(unittest.TestCase):
    H = {"Authorization": "Bearer token"}

    def setUp(self):
        self.client = TestClient(app)

    def con_cliente(self, tablas, falla=()):
        cliente = Cliente(tablas, falla)
        return mock.patch.object(R, "usuario_administrador", return_value=(cliente, "u-1", "Cristi"))

    def test_sin_token_responde_401(self):
        for ruta in ("/notificaciones/sincronizar", "/notificaciones/listar"):
            self.assertEqual(self.client.post(ruta).status_code, 401)

    def test_sincronizar_crea_una_vez_y_no_duplica(self):
        tablas = tablas_base()
        for r in tablas["rutas_planificadas"]:
            r["fecha"] = date.today().isoformat()
        with self.con_cliente(tablas):
            primera = self.client.post("/notificaciones/sincronizar", headers=self.H).json()
            segunda = self.client.post("/notificaciones/sincronizar", headers=self.H).json()
        self.assertEqual(primera["creadas"], 2)      # feriado nacional: las dos rutas
        self.assertEqual(segunda["creadas"], 0)
        self.assertEqual(len(tablas["notificaciones"]), 2)
        self.assertEqual([a["accion"] for a in tablas["notificaciones_auditoria"]], ["generada", "generada"])

    def test_fallo_al_guardar_no_se_da_por_creado(self):
        tablas = tablas_base()
        for r in tablas["rutas_planificadas"]:
            r["fecha"] = date.today().isoformat()
        with self.con_cliente(tablas, falla=["notificaciones_auditoria"]):
            respuesta = self.client.post("/notificaciones/sincronizar", headers=self.H)
        self.assertEqual(respuesta.status_code, 503)
        self.assertEqual(respuesta.json()["detail"]["message"], "No se pudieron generar algunas notificaciones")
        self.assertTrue(respuesta.json()["detail"]["retryable"])

    def test_fuente_caida_se_informa_en_fallos(self):
        tablas = tablas_base()
        with self.con_cliente(tablas, falla=["alertas_seguridad"]):
            respuesta = self.client.post("/notificaciones/sincronizar", headers=self.H).json()
        self.assertEqual(respuesta["fallos"], ["alertas"])

    def test_listar_marcar_leida_y_auditoria(self):
        tablas = tablas_base()
        for r in tablas["rutas_planificadas"]:
            r["fecha"] = date.today().isoformat()
        with self.con_cliente(tablas):
            self.client.post("/notificaciones/sincronizar", headers=self.H)
            antes = self.client.post("/notificaciones/listar", headers=self.H).json()
            self.assertEqual(antes["resumen"]["no_leidas"], 2)
            self.assertEqual(antes["items"][0]["color"], "roja")
            tablas["notificaciones"][0]["id"] = "6f9619ff-8b86-d011-b42d-00c04fc964ff"
            nid = tablas["notificaciones"][0]["id"]
            self.assertTrue(self.client.post("/notificaciones/leer", headers=self.H, json={"id": nid}).json()["leida"])
            despues = self.client.post("/notificaciones/listar", headers=self.H).json()
            self.assertEqual(despues["resumen"]["no_leidas"], 1)
            repetida = self.client.post("/notificaciones/leer", headers=self.H, json={"id": nid}).json()
            self.assertTrue(repetida["ya_estaba"])
        acciones = [a["accion"] for a in tablas["notificaciones_auditoria"]]
        self.assertEqual(acciones.count("leida"), 1)

    def test_error_al_listar_no_devuelve_lista_vacia(self):
        with self.con_cliente(tablas_base(), falla=["notificaciones"]):
            respuesta = self.client.post("/notificaciones/listar", headers=self.H)
        self.assertEqual(respuesta.status_code, 503)


if __name__ == "__main__":
    unittest.main()
