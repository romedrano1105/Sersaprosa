"""Pruebas del historial de incidentes para análisis posterior (FCJ1-22).
Se llama test_*.py a propósito: así pytest en CI sí las encuentra."""
import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import mock

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")

from fastapi.testclient import TestClient

from backend.app import historial_incidentes_logica as L
from backend.app import historial_incidentes_router as R
from backend.app import incidentes_logica as alertas
from backend.app import notificaciones_router
from backend.app.main import app

ID_1 = "11111111-1111-1111-1111-111111111111"
ID_2 = "22222222-2222-2222-2222-222222222222"
ID_3 = "33333333-3333-3333-3333-333333333333"
AHORA = datetime(2026, 10, 26, 18, 0, tzinfo=timezone.utc)
RUTAS = [{"id": "RT-1", "nombre": "Ruta Centro", "conductor": "Ana López"},
         {"id": "RT-2", "nombre": "Ruta Santa Tecla", "conductor": "Luis Pérez"}]
AUTH = {"Authorization": "Bearer t"}


def datos(**extra):
    base = {"ruta_id": "RT-1", "tipo": "robo", "severidad": "alta", "origen": "conductor", "descripcion": "Asalto en semáforo",
            "lat": 13.69, "lng": -89.19, "fecha": "2026-10-26T10:00:00-06:00"}
    base.update(extra)
    return base


def incidente(id_, **extra):
    base = {"id": id_, "ruta_id": "RT-1", "fecha": "2026-10-24T10:00:00+00:00", "tipo": "robo", "severidad": "alta",
            "origen": "conductor", "descripcion": "", "lat": 13.69, "lng": -89.19, "vista": False, "estado": "pendiente",
            "registrado_en": "2026-10-24T10:00:01+00:00"}
    base.update(extra)
    return base


class Registrar(unittest.TestCase):
    def test_incidente_completo_se_normaliza(self):
        r = L.validar_registro(datos(tipo=" ROBO ", severidad="Alta"), AHORA)
        self.assertEqual((r["tipo"], r["severidad"], r["origen"]), ("robo", "alta", "conductor"))
        self.assertEqual(r["fecha"], "2026-10-26T16:00:00+00:00")  # 10:00 hora de El Salvador

    def test_los_siete_tipos_son_validos_y_los_cinco_acordados_no_cambian(self):
        self.assertEqual(set(L.TIPOS), {"robo", "accidente", "desvio_ruta", "falla_mecanica", "boton_panico", "choque", "emergencia"})
        self.assertEqual(set(alertas.TIPOS), {"robo", "accidente", "desvio_ruta", "falla_mecanica", "boton_panico"})
        for tipo in L.TIPOS:
            self.assertEqual(L.validar_registro(datos(tipo=tipo), AHORA)["tipo"], tipo)

    def test_las_alertas_en_curso_etiquetan_bien_choque_y_emergencia(self):
        for tipo, etiqueta in (("choque", "Choque"), ("emergencia", "Emergencia"), ("robo", "Robo")):
            self.assertEqual(alertas.armar_item(incidente(ID_1, tipo=tipo), None)["tipo_etiqueta"], etiqueta)

    def test_origen_por_defecto_es_sistema(self):
        self.assertEqual(L.validar_registro(datos(origen=None), AHORA)["origen"], "sistema")

    def test_faltan_datos_obligatorios_se_rechaza_y_dice_cuales(self):
        for campo, texto in (("ruta_id", "la ruta"), ("tipo", "el tipo"), ("severidad", "la severidad"), ("lat", "latitud"), ("lng", "longitud")):
            with self.subTest(campo):
                with self.assertRaises(L.DatoInvalido) as error:
                    L.validar_registro(datos(**{campo: None}), AHORA)
                self.assertIn(texto, str(error.exception))
        with self.assertRaises(L.DatoInvalido) as error:
            L.validar_registro({}, AHORA)
        self.assertIn("la ruta", str(error.exception))
        self.assertIn("el tipo de incidente", str(error.exception))

    def test_valores_fuera_de_la_lista_o_rango_se_rechazan(self):
        for malo in (datos(tipo="meteorito"), datos(severidad="critica"), datos(origen="vecino"), datos(lat=91), datos(lng=-181),
                     datos(lat="abc"), datos(lat=True), datos(descripcion="x" * 501), datos(fecha="ayer"), datos(referencia="r" * 101)):
            with self.subTest(malo):
                with self.assertRaises(L.DatoInvalido):
                    L.validar_registro(malo, AHORA)

    def test_la_fecha_no_puede_estar_en_el_futuro_pero_se_tolera_un_reloj_adelantado(self):
        with self.assertRaises(L.DatoInvalido):
            L.validar_registro(datos(fecha="2026-10-27T12:00:00-06:00"), AHORA)
        L.validar_registro(datos(fecha="2026-10-26T12:03:00-06:00"), AHORA)  # 3 min adelantado

    def test_sin_fecha_se_usa_el_momento_actual(self):
        self.assertEqual(L.validar_registro(datos(fecha=None), AHORA)["fecha"], AHORA.isoformat())

    def test_misma_referencia_misma_clave_aunque_cambien_los_demas_datos(self):
        a = L.validar_registro(datos(referencia="GPS-77"), AHORA)["clave"]
        b = L.validar_registro(datos(referencia="GPS-77", descripcion="otra", tipo="choque"), AHORA)["clave"]
        self.assertEqual(a, b)
        self.assertEqual(a, "ref:GPS-77")

    def test_sin_referencia_el_mismo_aviso_reenviado_tiene_la_misma_clave(self):
        a = L.validar_registro(datos(fecha="2026-10-26T10:00:05-06:00"), AHORA)["clave"]
        b = L.validar_registro(datos(fecha="2026-10-26T10:00:50-06:00", descripcion="reintento"), AHORA)["clave"]
        self.assertEqual(a, b)

    def test_incidentes_distintos_tienen_claves_distintas(self):
        base = L.validar_registro(datos(), AHORA)["clave"]
        for otro in (datos(ruta_id="RT-2"), datos(tipo="choque"), datos(origen="sistema"), datos(lat=13.80), datos(fecha="2026-10-26T10:05:00-06:00")):
            with self.subTest(otro):
                self.assertNotEqual(base, L.validar_registro(otro, AHORA)["clave"])


class Consultar(unittest.TestCase):
    def test_filtros_validos_y_limites(self):
        f = L.validar_filtros({"desde": "2026-10-01", "hasta": "2026-10-26", "tipo": "Robo", "estado": "atendida", "ruta": " Centro% ", "pagina": "2", "limite": "500"})
        self.assertEqual((f["tipo"], f["estado"], f["ruta"], f["pagina"], f["limite"]), ("robo", "atendida", "Centro", 2, L.LIMITE_MAXIMO))
        vacio = L.validar_filtros({})
        self.assertEqual((vacio["pagina"], vacio["limite"], vacio["tipo"], vacio["ruta"]), (1, L.LIMITE_POR_DEFECTO, None, ""))

    def test_filtros_invalidos_se_rechazan(self):
        for malo in ({"tipo": "meteorito"}, {"severidad": "x"}, {"estado": "cerrada"}, {"desde": "26/10/2026"},
                     {"desde": "2026-10-26", "hasta": "2026-10-01"}, {"pagina": "dos"}):
            with self.subTest(malo):
                with self.assertRaises(L.DatoInvalido):
                    L.validar_filtros(malo)

    def test_hasta_incluye_todo_el_dia_en_hora_de_el_salvador(self):
        ini, fin = L.limites_fecha(L.validar_filtros({"desde": "2026-10-26", "hasta": "2026-10-26"}))
        self.assertEqual((ini, fin), ("2026-10-26T00:00:00-06:00", "2026-10-27T00:00:00-06:00"))

    def test_rango_de_paginas(self):
        self.assertEqual(L.rango(L.validar_filtros({"pagina": 1, "limite": 25})), (0, 24))
        self.assertEqual(L.rango(L.validar_filtros({"pagina": 3, "limite": 10})), (20, 29))

    def test_paginas_se_calculan_con_el_total(self):
        f = L.validar_filtros({"limite": 10})
        self.assertEqual(L.construir_historial([], [], 0, f)["paginas"], 1)
        self.assertEqual(L.construir_historial([], [], 21, f)["paginas"], 3)

    def test_el_item_trae_todo_lo_que_pide_la_historia(self):
        item = L.armar_item(incidente(ID_1, estado="atendida", comentario="Se avisó", atendido_en="2026-10-24T11:00:00+00:00"), RUTAS[0])
        self.assertEqual((item["ruta"], item["conductor"], item["tipo_etiqueta"], item["severidad_etiqueta"], item["estado_etiqueta"], item["origen_etiqueta"]),
                         ("Ruta Centro", "Ana López", "Robo", "Alta", "Atendida", "Conductor"))
        self.assertTrue(item["fecha"] and item["viaje"] and item["lat"] and item["lng"] and item["registrado_en"] and item["comentario"])

    def test_ruta_desconocida_no_rompe(self):
        self.assertEqual(L.armar_item(incidente(ID_1, ruta_id="RT-X"), None)["conductor"], "Sin conductor asignado")

    def test_auditoria_en_orden_cronologico_y_filas_viejas_son_atendida(self):
        filas = [{"usuario_nombre": "Marta", "fecha": "2026-10-24T11:00:00+00:00", "comentario": "Atendido"},
                 {"accion": "registrada", "usuario_nombre": "Sistema", "fecha": "2026-10-24T10:00:00+00:00", "comentario": "Incidente registrado"}]
        a = L.armar_auditoria(filas)
        self.assertEqual([x["accion"] for x in a], ["registrada", "atendida"])
        self.assertEqual([x["accion_etiqueta"] for x in a], ["Registrado", "Atendido"])


class Consulta:
    """Imita el encadenado de supabase-py sobre listas en memoria (incluye count, range, ilike, gte y lt)."""
    def __init__(self, filas):
        self.filas, self.contar, self.rango = list(filas), False, None

    def select(self, *_, count=None):
        self.contar = bool(count)
        return self

    def eq(self, campo, valor):
        self.filas = [f for f in self.filas if str(f.get(campo)) == str(valor)]
        return self

    def in_(self, campo, valores):
        self.filas = [f for f in self.filas if f.get(campo) in valores]
        return self

    def ilike(self, campo, patron):
        parte = patron.strip("%").lower()
        self.filas = [f for f in self.filas if parte in str(f.get(campo) or "").lower()]
        return self

    def gte(self, campo, valor):
        self.filas = [f for f in self.filas if _t(f.get(campo)) >= _t(valor)]
        return self

    def lt(self, campo, valor):
        self.filas = [f for f in self.filas if _t(f.get(campo)) < _t(valor)]
        return self

    def order(self, campo, desc=False):
        self.filas.sort(key=lambda f: _t(f.get(campo)), reverse=desc)
        return self

    def range(self, desde, hasta):
        self.rango = (desde, hasta)
        return self

    def limit(self, *_):
        return self

    def execute(self):
        total = len(self.filas)
        filas = self.filas[self.rango[0]:self.rango[1] + 1] if self.rango else self.filas
        return SimpleNamespace(data=filas, count=total if self.contar else None)


def _t(valor):
    return datetime.fromisoformat(str(valor).replace("Z", "+00:00")).timestamp()


class ClienteFalso:
    def __init__(self, incidentes=(), rpc=None, falla=False, auditoria=(), error=None):
        self.tablas = {"incidentes_viaje": list(incidentes), "rutas_planificadas": RUTAS, "incidentes_viaje_auditoria": list(auditoria)}
        self._rpc, self.falla, self.llamadas_rpc, self.error = rpc, falla, [], error

    def _romper(self):
        if self.falla:
            raise RuntimeError(self.error or "Supabase caído")

    def table(self, nombre):
        self._romper()
        return Consulta(self.tablas[nombre])

    def rpc(self, nombre, params):
        self.llamadas_rpc.append((nombre, params))
        self._romper()
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=self._rpc))


class Endpoints(unittest.TestCase):
    def setUp(self):
        self.http = TestClient(app, raise_server_exceptions=False)

    def con_cliente(self, cliente):
        parche = mock.patch.object(R, "usuario_administrador", return_value=(cliente, "u-1", "Marta"))
        parche.start()
        self.addCleanup(parche.stop)

    def post(self, ruta, cuerpo=None):
        return self.http.post("/incidentes/" + ruta, json=cuerpo or {}, headers=AUTH)

    # --- acceso ---
    def test_sin_token_es_401(self):
        for ruta in ("registrar", "historial", "historial/detalle"):
            with self.subTest(ruta):
                self.assertEqual(self.http.post("/incidentes/" + ruta, json={"id": ID_1}).status_code, 401)

    def test_otro_rol_es_403_y_no_guarda_nada(self):
        usuario = SimpleNamespace(id="u-2", app_metadata={"role": "conductor"}, user_metadata={}, email="x@y.z")
        with mock.patch.object(notificaciones_router.database.supabase.auth, "get_user", return_value=SimpleNamespace(user=usuario)), \
                mock.patch.object(notificaciones_router.database, "cliente_autenticado") as cliente:
            for ruta, cuerpo in (("registrar", datos()), ("historial", {}), ("historial/detalle", {"id": ID_1})):
                with self.subTest(ruta):
                    self.assertEqual(self.http.post("/incidentes/" + ruta, json=cuerpo, headers=AUTH).status_code, 403)
            cliente.assert_not_called()

    def test_las_rutas_de_las_alertas_en_curso_siguen_ahi(self):
        rutas = app.openapi()["paths"]
        for ruta in ("listar", "detalle", "atender", "registrar", "historial", "historial/detalle"):
            self.assertIn("post", rutas.get("/incidentes/" + ruta, {}), ruta)

    # --- registrar ---
    def test_registrar_llama_a_la_funcion_con_los_datos_normalizados(self):
        cliente = ClienteFalso(rpc={"ok": True, "creado": True, "id": ID_1})
        self.con_cliente(cliente)
        r = self.post("registrar", datos(tipo="Choque", referencia="GPS-77"))
        self.assertEqual((r.status_code, r.json()["creado"], r.json()["id"]), (200, True, ID_1))
        nombre, params = cliente.llamadas_rpc[0]
        self.assertEqual(nombre, "registrar_incidente_viaje")
        self.assertEqual((params["p_tipo"], params["p_clave"], params["p_ruta_id"]), ("choque", "ref:GPS-77", "RT-1"))

    def test_registrar_dos_veces_el_mismo_devuelve_el_mismo_sin_crear_otro(self):
        self.con_cliente(ClienteFalso(rpc={"ok": True, "creado": False, "id": ID_1}))
        r = self.post("registrar", datos(referencia="GPS-77"))
        self.assertEqual((r.status_code, r.json()["creado"], r.json()["id"]), (200, False, ID_1))
        self.assertIn("ya estaba registrado", r.json()["mensaje"])

    def test_registrar_con_datos_incompletos_es_422_con_mensaje_y_no_llama_a_la_base(self):
        cliente = ClienteFalso(rpc={"ok": True})
        self.con_cliente(cliente)
        r = self.post("registrar", datos(lat=None, ruta_id=""))
        self.assertEqual(r.status_code, 422)
        self.assertIn("la ruta", r.json()["detail"])
        self.assertIn("latitud", r.json()["detail"])
        self.assertEqual(self.post("registrar", datos(tipo="meteorito")).status_code, 422)
        self.assertEqual(cliente.llamadas_rpc, [])

    def test_registrar_ruta_inexistente_es_422(self):
        self.con_cliente(ClienteFalso(rpc={"ok": False, "reason": "ruta_no_existe"}))
        r = self.post("registrar", datos(ruta_id="RT-X"))
        self.assertEqual((r.status_code, r.json()["detail"]), (422, "La ruta indicada no existe."))

    def test_registrar_si_falla_la_base_es_503_con_reintentar(self):
        self.con_cliente(ClienteFalso(falla=True))
        r = self.post("registrar", datos())
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["detail"], {"message": "No se pudo registrar el incidente", "retryable": True})

    def test_registrar_reintento_tras_el_fallo_no_duplica(self):
        """Falla, se reintenta con la misma referencia y la base responde 'ya existía': queda uno."""
        cliente = ClienteFalso(falla=True)
        self.con_cliente(cliente)
        self.assertEqual(self.post("registrar", datos(referencia="GPS-9")).status_code, 503)
        cliente.falla, cliente._rpc = False, {"ok": True, "creado": True, "id": ID_1}
        self.assertEqual(self.post("registrar", datos(referencia="GPS-9")).json()["creado"], True)
        claves = {p["p_clave"] for _, p in cliente.llamadas_rpc}
        self.assertEqual(claves, {"ref:GPS-9"})

    def test_si_falta_ejecutar_el_sql_el_mensaje_lo_dice(self):
        self.con_cliente(ClienteFalso(falla=True, error="PGRST202 Could not find the function public.registrar_incidente_viaje"))
        detail = self.post("registrar", datos()).json()["detail"]
        self.assertIn("historial_incidentes.sql", detail["message"])
        self.assertTrue(detail["retryable"])

    def test_respuesta_inesperada_de_la_base_es_503(self):
        self.con_cliente(ClienteFalso(rpc=None))
        self.assertEqual(self.post("registrar", datos()).status_code, 503)

    # --- historial ---
    def muestra(self):
        return [
            incidente(ID_1, fecha="2026-10-26T15:00:00+00:00", tipo="robo", severidad="alta", estado="pendiente"),
            incidente(ID_2, fecha="2026-10-25T15:00:00+00:00", tipo="choque", severidad="media", estado="atendida", ruta_id="RT-2"),
            incidente(ID_3, fecha="2026-10-20T15:00:00+00:00", tipo="robo", severidad="baja", estado="atendida"),
        ]

    def test_historial_incluye_atendidos_y_va_del_mas_reciente_al_mas_antiguo(self):
        self.con_cliente(ClienteFalso(self.muestra()))
        r = self.post("historial")
        self.assertEqual(r.status_code, 200)
        self.assertEqual([i["id"] for i in r.json()["items"]], [ID_1, ID_2, ID_3])
        self.assertEqual((r.json()["total"], r.json()["paginas"]), (3, 1))
        self.assertEqual(r.json()["items"][1]["ruta"], "Ruta Santa Tecla")

    def test_un_incidente_atendido_sigue_en_el_historial_aunque_salga_de_las_alertas(self):
        cliente = ClienteFalso(self.muestra())
        self.con_cliente(cliente)
        self.assertIn(ID_2, [i["id"] for i in self.post("historial").json()["items"]])
        self.assertEqual([i["id"] for i in alertas_en_curso(cliente)], [ID_1])

    def test_filtros_por_tipo_severidad_estado_y_fecha(self):
        self.con_cliente(ClienteFalso(self.muestra()))
        ids = lambda cuerpo: [i["id"] for i in self.post("historial", cuerpo).json()["items"]]
        self.assertEqual(ids({"tipo": "robo"}), [ID_1, ID_3])
        self.assertEqual(ids({"severidad": "media"}), [ID_2])
        self.assertEqual(ids({"estado": "atendida"}), [ID_2, ID_3])
        self.assertEqual(ids({"desde": "2026-10-25", "hasta": "2026-10-26"}), [ID_1, ID_2])
        self.assertEqual(ids({"tipo": "robo", "estado": "atendida", "desde": "2026-10-01"}), [ID_3])

    def test_filtro_por_ruta_busca_por_nombre_o_id(self):
        self.con_cliente(ClienteFalso(self.muestra()))
        ids = lambda cuerpo: [i["id"] for i in self.post("historial", cuerpo).json()["items"]]
        self.assertEqual(ids({"ruta": "santa tecla"}), [ID_2])
        self.assertEqual(ids({"ruta": "RT-1"}), [ID_1, ID_3])

    def test_sin_resultados_es_lista_vacia_con_200_no_error(self):
        self.con_cliente(ClienteFalso(self.muestra()))
        for cuerpo in ({"ruta": "no existe"}, {"tipo": "emergencia"}):
            r = self.post("historial", cuerpo)
            self.assertEqual((r.status_code, r.json()["items"], r.json()["total"]), (200, [], 0))

    def test_paginacion(self):
        self.con_cliente(ClienteFalso(self.muestra()))
        r = self.post("historial", {"limite": 2, "pagina": 2})
        self.assertEqual(([i["id"] for i in r.json()["items"]], r.json()["total"], r.json()["paginas"]), ([ID_3], 3, 2))

    def test_filtros_invalidos_son_422(self):
        self.con_cliente(ClienteFalso(self.muestra()))
        for malo in ({"tipo": "meteorito"}, {"desde": "ayer"}, {"desde": "2026-10-26", "hasta": "2026-10-01"}):
            self.assertEqual(self.post("historial", malo).status_code, 422)

    def test_flujo_fallido_no_devuelve_lista_vacia_sino_error_con_reintento(self):
        self.con_cliente(ClienteFalso(self.muestra(), falla=True))
        r = self.post("historial")
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["detail"], {"message": "No se pudo cargar el historial de incidentes", "retryable": True})

    def test_historial_si_falta_el_sql_lo_dice(self):
        self.con_cliente(ClienteFalso(falla=True, error="column incidentes_viaje.registrado_en does not exist"))
        self.assertIn("historial_incidentes.sql", self.post("historial").json()["detail"]["message"])

    # --- detalle ---
    def test_detalle_trae_auditoria_y_no_modifica_nada(self):
        cliente = ClienteFalso(self.muestra(), auditoria=[
            {"incidente_id": ID_1, "accion": "registrada", "usuario_nombre": "Marta", "fecha": "2026-10-26T15:00:01+00:00", "comentario": "Incidente registrado"}])
        self.con_cliente(cliente)
        antes = [dict(f) for f in cliente.tablas["incidentes_viaje"]]
        r = self.post("historial/detalle", {"id": ID_1})
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["incidente"]["tipo"] == "")
        self.assertEqual(r.json()["auditoria"][0]["accion_etiqueta"], "Registrado")
        self.assertEqual(cliente.tablas["incidentes_viaje"], antes)  # ni siquiera marca «vista»

    def test_detalle_inexistente_es_404_y_si_falla_la_base_es_503(self):
        self.con_cliente(ClienteFalso([]))
        self.assertEqual(self.post("historial/detalle", {"id": ID_1}).status_code, 404)
        self.con_cliente(ClienteFalso(self.muestra(), falla=True))
        self.assertEqual(self.post("historial/detalle", {"id": ID_1}).status_code, 503)


def alertas_en_curso(cliente):
    """Lo que mostraría el panel de alertas activas (incidentes_logica.construir_listado)."""
    pendientes = [i for i in cliente.tablas["incidentes_viaje"]]
    return alertas.construir_listado(pendientes, RUTAS)["items"]


if __name__ == "__main__":
    unittest.main()
