"""Pruebas de las alertas de incidentes de viajes en curso (FCJ1-10 / FCJ1-30).
Se llama test_*.py a propósito: así pytest en CI sí las encuentra."""
import os
import unittest
from types import SimpleNamespace
from unittest import mock

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")

from fastapi.testclient import TestClient

from backend.app import incidentes_logica as L
from backend.app import incidentes_router as R
from backend.app import notificaciones_router
from backend.app.main import app

ID_1 = "11111111-1111-1111-1111-111111111111"
ID_2 = "22222222-2222-2222-2222-222222222222"
ID_3 = "33333333-3333-3333-3333-333333333333"
RUTAS = [{"id": "RT-1", "nombre": "Ruta Centro", "conductor": "Ana López"}]


def incidente(id_, **extra):
    base = {"id": id_, "ruta_id": "RT-1", "fecha": "2026-10-24T10:00:00+00:00", "tipo": "robo", "severidad": "alta",
            "origen": "conductor", "descripcion": "", "lat": 13.69, "lng": -89.19, "vista": False, "estado": "pendiente"}
    base.update(extra)
    return base


class Reglas(unittest.TestCase):
    def test_tipos_y_severidades_acordados(self):
        self.assertEqual(set(L.TIPOS), {"robo", "accidente", "desvio_ruta", "falla_mecanica", "boton_panico"})
        self.assertEqual(set(L.SEVERIDADES), {"alta", "media", "baja"})

    def test_el_sondeo_cumple_el_tiempo_maximo_de_entrega(self):
        self.assertLess(L.INTERVALO_SONDEO_SEG, L.TIEMPO_MAX_ENTREGA_SEG)

    def test_nuevas_primero_y_dentro_de_cada_grupo_la_mas_reciente(self):
        incidentes = [
            incidente(ID_1, fecha="2026-10-24T09:00:00+00:00", vista=True),
            incidente(ID_2, fecha="2026-10-24T08:00:00+00:00"),
            incidente(ID_3, fecha="2026-10-24T09:30:00+00:00"),
        ]
        listado = L.construir_listado(incidentes, RUTAS)
        self.assertEqual([i["id"] for i in listado["items"]], [ID_3, ID_2, ID_1])
        self.assertEqual((listado["no_atendidas"], listado["nuevas"]), (3, 2))

    def test_las_atendidas_no_aparecen_ni_cuentan(self):
        listado = L.construir_listado([incidente(ID_1), incidente(ID_2, estado="atendida", vista=True)], RUTAS)
        self.assertEqual([i["id"] for i in listado["items"]], [ID_1])
        self.assertEqual(listado["no_atendidas"], 1)

    def test_la_alerta_trae_todo_lo_que_pide_la_historia(self):
        item = L.construir_listado([incidente(ID_1, tipo="boton_panico")], RUTAS)["items"][0]
        self.assertEqual((item["ruta"], item["conductor"], item["tipo_etiqueta"], item["severidad_etiqueta"]),
                         ("Ruta Centro", "Ana López", "Botón de pánico", "Alta"))
        self.assertTrue(item["fecha"] and item["viaje"] and item["lat"] and item["lng"])

    def test_ruta_desconocida_no_rompe_el_listado(self):
        item = L.construir_listado([incidente(ID_1, ruta_id="RT-X")], RUTAS)["items"][0]
        self.assertEqual(item["conductor"], "Sin conductor asignado")

    def test_comentario_obligatorio(self):
        for malo in (None, "", "  ", "ab", "x" * 501):
            with self.assertRaises(ValueError):
                L.validar_comentario(malo)
        self.assertEqual(L.validar_comentario("  Se avisó a la policía  "), "Se avisó a la policía")


class Consulta:
    """Imita el encadenado de supabase-py (table().select().eq()...execute()) sobre listas en memoria."""
    def __init__(self, filas, escritas):
        self.filas, self.escritas, self.cambio = list(filas), escritas, None

    def select(self, *_):
        return self

    def eq(self, campo, valor):
        self.filas = [f for f in self.filas if str(f.get(campo)) == str(valor)]
        return self

    def in_(self, campo, valores):
        self.filas = [f for f in self.filas if f.get(campo) in valores]
        return self

    def order(self, *_, **__):
        return self

    def limit(self, *_):
        return self

    def update(self, cambio):
        self.cambio = cambio
        return self

    def execute(self):
        if self.cambio is not None:
            for f in self.filas:
                f.update(self.cambio)
            self.escritas.append(self.cambio)
        return SimpleNamespace(data=self.filas)


class ClienteFalso:
    def __init__(self, incidentes, rpc=None, falla=False):
        self.tablas = {"incidentes_viaje": incidentes, "rutas_planificadas": RUTAS, "incidentes_viaje_auditoria": []}
        self.escritas, self._rpc, self.falla, self.llamadas_rpc = [], rpc, falla, []

    def table(self, nombre):
        if self.falla:
            raise RuntimeError("Supabase caído")
        return Consulta(self.tablas[nombre], self.escritas)

    def rpc(self, nombre, params):
        self.llamadas_rpc.append((nombre, params))
        if self.falla:
            raise RuntimeError("Supabase caído")
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=self._rpc))


class Endpoints(unittest.TestCase):
    def setUp(self):
        self.http = TestClient(app, raise_server_exceptions=False)

    def con_cliente(self, cliente):
        parche = mock.patch.object(R, "usuario_administrador", return_value=(cliente, "u-1", "Marta"))
        parche.start()
        self.addCleanup(parche.stop)

    def test_sin_token_es_401(self):
        self.assertEqual(self.http.post("/incidentes/listar").status_code, 401)

    def test_otro_rol_es_403_en_todos_los_endpoints(self):
        usuario = SimpleNamespace(id="u-2", app_metadata={"role": "conductor"}, user_metadata={}, email="x@y.z")
        with mock.patch.object(notificaciones_router.database.supabase.auth, "get_user", return_value=SimpleNamespace(user=usuario)):
            cabecera = {"Authorization": "Bearer token"}
            for ruta, cuerpo in (("listar", {}), ("detalle", {"id": ID_1}), ("atender", {"id": ID_1, "comentario": "Atendida"})):
                with self.subTest(ruta):
                    self.assertEqual(self.http.post("/incidentes/" + ruta, json=cuerpo, headers=cabecera).status_code, 403)

    def test_listar_devuelve_activas_y_contador(self):
        self.con_cliente(ClienteFalso([incidente(ID_1), incidente(ID_2, estado="atendida")]))
        r = self.http.post("/incidentes/listar", headers={"Authorization": "Bearer t"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual([i["id"] for i in r.json()["items"]], [ID_1])
        self.assertEqual(r.json()["no_atendidas"], 1)

    def test_flujo_fallido_no_devuelve_lista_vacia_sino_error_con_reintento(self):
        self.con_cliente(ClienteFalso([incidente(ID_1)], falla=True))
        r = self.http.post("/incidentes/listar", headers={"Authorization": "Bearer t"})
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["detail"], {"message": "No se pueden recibir alertas en tiempo real", "retryable": True})

    def test_detalle_marca_como_vista_y_trae_auditoria(self):
        cliente = ClienteFalso([incidente(ID_1)])
        self.con_cliente(cliente)
        r = self.http.post("/incidentes/detalle", json={"id": ID_1}, headers={"Authorization": "Bearer t"})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["alerta"]["vista"])
        self.assertEqual(cliente.escritas, [{"vista": True}])
        self.assertEqual(r.json()["auditoria"], [])

    def test_detalle_de_alerta_inexistente_es_404(self):
        self.con_cliente(ClienteFalso([]))
        self.assertEqual(self.http.post("/incidentes/detalle", json={"id": ID_1}, headers={"Authorization": "Bearer t"}).status_code, 404)

    def test_atender_con_comentario_llama_a_la_funcion_que_audita(self):
        cliente = ClienteFalso([incidente(ID_1)], rpc={"ok": True, "atendido_en": "2026-10-24T10:05:00+00:00", "atendido_nombre": "Marta"})
        self.con_cliente(cliente)
        r = self.http.post("/incidentes/atender", json={"id": ID_1, "comentario": "  Se avisó a la policía "}, headers={"Authorization": "Bearer t"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(cliente.llamadas_rpc, [("atender_incidente_viaje", {"p_id": ID_1, "p_comentario": "Se avisó a la policía"})])
        self.assertEqual(r.json()["atendido_nombre"], "Marta")

    def test_atender_sin_comentario_es_422_y_no_llama_a_la_base(self):
        cliente = ClienteFalso([incidente(ID_1)], rpc={"ok": True})
        self.con_cliente(cliente)
        for comentario in ("", "  ", "ab"):
            r = self.http.post("/incidentes/atender", json={"id": ID_1, "comentario": comentario}, headers={"Authorization": "Bearer t"})
            self.assertEqual(r.status_code, 422)
        self.assertEqual(cliente.llamadas_rpc, [])

    def test_atender_dos_veces_es_409(self):
        self.con_cliente(ClienteFalso([incidente(ID_1)], rpc={"ok": False, "reason": "already_attended"}))
        r = self.http.post("/incidentes/atender", json={"id": ID_1, "comentario": "Atendida"}, headers={"Authorization": "Bearer t"})
        self.assertEqual((r.status_code, r.json()["detail"]), (409, "Otro administrador ya atendió esta alerta."))

    def test_atender_si_falla_la_base_es_503(self):
        self.con_cliente(ClienteFalso([incidente(ID_1)], falla=True))
        r = self.http.post("/incidentes/atender", json={"id": ID_1, "comentario": "Atendida"}, headers={"Authorization": "Bearer t"})
        self.assertEqual(r.status_code, 503)


if __name__ == "__main__":
    unittest.main()