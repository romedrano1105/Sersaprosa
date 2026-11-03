import unittest
from datetime import date, datetime, timezone

from backend.agente_rutas import geo
from backend.agente_rutas.agente import SinAlternativa
from backend.agente_rutas.ejemplo import DESTINO, ORIGEN, construir_agente
from backend.app import rechazos_logica as logica
from backend.app import rechazos_servicio as servicio

HOY = date(2026, 10, 23)
AHORA = datetime(2026, 10, 23, 15, 0, tzinfo=timezone.utc)
TRAZADO = [[13.70, -89.22], [13.70, -89.195], [13.70, -89.17]]


class Resp:
    def __init__(self, data): self.data = data


class Consulta:
    def __init__(self, db, tabla, falla_insert=False):
        self.db, self.tabla, self.op, self.valores, self.f, self.falla = db, tabla, "select", None, [], falla_insert

    def select(self, *_): return self
    def limit(self, *_): return self
    def insert(self, v): self.op, self.valores = "insert", v; return self
    def update(self, v): self.op, self.valores = "update", v; return self
    def eq(self, c, v): self.f.append(lambda r: r.get(c) == v); return self

    def execute(self):
        filas = self.db.setdefault(self.tabla, [])
        if self.op == "insert":
            if self.falla:
                raise RuntimeError("relation rechazos_ruta does not exist")
            fila = {"id": len(filas) + 1, **self.valores}
            filas.append(fila)
            return Resp([dict(fila)])
        coincide = lambda r: all(f(r) for f in self.f)
        if self.op == "update":
            [r.update(self.valores) for r in filas if coincide(r)]
            return Resp([])
        return Resp([dict(r) for r in filas if coincide(r)])


class Cliente:
    def __init__(self, db, sin_tabla=False):
        self.db, self.sin_tabla = db, sin_tabla

    def table(self, t): return Consulta(self.db, t, falla_insert=self.sin_tabla and t == "rechazos_ruta")


class ClienteUsuario:
    def __init__(self, db):
        self.db, self.llamadas = db, []

    def rpc(self, nombre, parametros):
        self.llamadas.append((nombre, parametros))
        if nombre != "aceptar_propuesta_ruta_operativa":
            raise AssertionError("RPC no esperado")
        ruta = next((fila for fila in self.db["rutas_planificadas"] if fila["id"] == parametros["p_ruta"]), None)
        if ruta and ruta["estado_propuesta"] == "rechazada":
            error = RuntimeError("La propuesta está rechazada.")
            error.code = "P0001"
            error.message = str(error)
            raise error
        if ruta:
            ruta["estado_propuesta"] = "aceptada"
        return type("ConsultaRPC", (), {"execute": lambda self: Resp({"id": parametros["p_ruta"], "estado_propuesta": "aceptada"})})()


class ClienteFallaFinalizar(Cliente):
    def table(self, tabla):
        consulta = super().table(tabla)
        ejecutar = consulta.execute

        def ejecutar_con_falla():
            if tabla == "rechazos_ruta" and consulta.op == "update":
                raise RuntimeError("no se pudo actualizar el historial")
            return ejecutar()

        consulta.execute = ejecutar_con_falla
        return consulta


def base(**ruta):
    fila = {"id": "RT-1", "nombre": "09:30 · Metrocentro", "fecha": HOY.isoformat(), "conductor": None, "nivel_riesgo": "Alto",
            "origen_lat": 13.70, "origen_lng": -89.22, "destino_lat": 13.70, "destino_lng": -89.17,
            "estado_propuesta": "propuesta", **ruta}
    return {"rutas_planificadas": [fila], "asignaciones_ruta": [], "rechazos_ruta": []}


def elegida(**extra):
    return {"ruta_id": "R1", "distancia_km": 5.2, "duracion_min_ajustada": 11.0, "geometria": TRAZADO, **extra}


def evaluador_ok(vetada=False, hallazgos=()):
    llamadas = []

    def evaluar(o, d, excluir):
        llamadas.append(excluir)
        return {"ruta_elegida": {"ruta_id": "R2", "distancia_km": 6.0, "vetada": vetada, "hallazgos": list(hallazgos),
                                 "geometria": [[13.69, -89.22], [13.69, -89.17]]}, "justificacion": "Evita la zona."}
    evaluar.llamadas = llamadas
    return evaluar


def evaluador_falla(error):
    def evaluar(o, d, excluir):
        raise error
    return evaluar


def rechazar(db, evaluar, motivo="Zona insegura", comentario="  Hubo asaltos ", **kw):
    return servicio.rechazar_ruta("RT-1", motivo, comentario, elegida(), TRAZADO, usuario="Ana",
                                  cliente_servicio=kw.pop("cliente", Cliente(db)), evaluar=evaluar, hoy=HOY)


class ValidacionTest(unittest.TestCase):
    def test_motivo_es_obligatorio(self):
        for motivo in (None, "", "   "):
            with self.assertRaisesRegex(ValueError, "obligatorio"):
                logica.validar_rechazo(motivo, None)

    def test_motivo_y_comentario_se_normalizan_y_limitan(self):
        self.assertEqual(logica.validar_rechazo("  Zona   insegura ", "  ok  "), ("Zona insegura", "ok"))
        self.assertEqual(logica.validar_rechazo("Zona insegura", "  "), ("Zona insegura", None))
        with self.assertRaises(ValueError):
            logica.validar_rechazo("ab", None)
        with self.assertRaises(ValueError):
            logica.validar_rechazo("x" * 201, None)
        with self.assertRaises(ValueError):
            logica.validar_rechazo("Zona insegura", "x" * 501)

    def test_trazado_valido_e_invalido(self):
        self.assertEqual(logica.limpiar_trazado(TRAZADO)[0], (13.7, -89.22))
        for malo in (None, [], [[1, 2]], [[1, 2], ["a", 3]], [[91, 0], [0, 0]], [[0, 181], [0, 0]], [[0, 0]] * 5001):
            with self.assertRaises(ValueError):
                logica.limpiar_trazado(malo)

    def test_nivel_del_trayecto(self):
        self.assertEqual(logica.nivel_trayecto({"vetada": True}), "Alto")
        self.assertEqual(logica.nivel_trayecto({"hallazgos": [{"x": 1}]}), "Medio")
        self.assertEqual(logica.nivel_trayecto({"hallazgos": []}), "Bajo")


class FlujoExitosoTest(unittest.TestCase):
    def test_registra_rechazo_y_devuelve_alternativa_con_justificacion_y_riesgo(self):
        db, evaluar = base(), evaluador_ok(hallazgos=[{"fuente": "zona"}])
        r = rechazar(db, evaluar)
        fila = db["rechazos_ruta"][0]
        self.assertEqual((fila["ruta_id"], fila["motivo"], fila["comentario"], fila["usuario"]),
                         ("RT-1", "Zona insegura", "Hubo asaltos", "Ana"))
        self.assertTrue(fila["fecha"])
        self.assertEqual(fila["resultado"], "generada")
        self.assertEqual(db["rutas_planificadas"][0]["estado_propuesta"], "propuesta")
        self.assertEqual(r["alternativa"]["justificacion"], "Evita la zona.")
        self.assertEqual((r["alternativa"]["nivel_riesgo"], r["alternativa"]["nivel_riesgo_trayecto"]), ("Alto", "Medio"))
        self.assertIsNone(r["error"])

    def test_excluye_la_ruta_rechazada(self):
        evaluar = evaluador_ok()
        rechazar(base(), evaluar)
        self.assertEqual(len(evaluar.llamadas[0]), 1)
        self.assertEqual(evaluar.llamadas[0][0][0], (13.7, -89.22))

    def test_rechazar_otra_vez_excluye_todas_las_anteriores(self):
        db, evaluar = base(), evaluador_ok()
        rechazar(db, evaluar)
        servicio.rechazar_ruta("RT-1", "Mucho tráfico", None, elegida(ruta_id="R2"), [[13.69, -89.22], [13.69, -89.17]],
                               usuario="Ana", cliente_servicio=Cliente(db), evaluar=evaluar, hoy=HOY)
        self.assertEqual(len(evaluar.llamadas[1]), 2)
        self.assertEqual(len(db["rechazos_ruta"]), 2)

    def test_historial_lista_los_rechazos_mas_recientes_primero(self):
        db, evaluar = base(), evaluador_ok()
        rechazar(db, evaluar, motivo="Primero")
        db["rechazos_ruta"][0]["fecha"] = "2026-10-23T10:00:00+00:00"
        rechazar(db, evaluar, motivo="Segundo")
        db["rechazos_ruta"][1]["fecha"] = "2026-10-23T11:00:00+00:00"
        h = servicio.historial("RT-1", cliente_servicio=Cliente(db))
        self.assertEqual([x["motivo"] for x in h["rechazos"]], ["Segundo", "Primero"])
        self.assertNotIn("geometria", h["rechazos"][0])

    def test_aceptar_la_alternativa(self):
        db = base()
        cliente_usuario = ClienteUsuario(db)
        self.assertEqual(
            servicio.aceptar_propuesta("RT-1", cliente_usuario=cliente_usuario)["estado_propuesta"],
            "aceptada",
        )
        self.assertEqual(db["rutas_planificadas"][0]["estado_propuesta"], "aceptada")
        self.assertEqual(cliente_usuario.llamadas, [
            ("aceptar_propuesta_ruta_operativa", {"p_ruta": "RT-1"})
        ])

    def test_no_rechaza_una_propuesta_ya_aceptada(self):
        db = base(estado_propuesta="aceptada")
        with self.assertRaises(servicio.ErrorRechazo) as error:
            rechazar(db, evaluador_ok())
        self.assertEqual(error.exception.estado, 409)
        self.assertEqual(db["rechazos_ruta"], [])


class ReglasTest(unittest.TestCase):
    def test_sin_motivo_no_se_registra_nada(self):
        db = base()
        with self.assertRaises(servicio.ErrorRechazo) as e:
            rechazar(db, evaluador_ok(), motivo="  ")
        self.assertEqual(e.exception.estado, 422)
        self.assertEqual(db["rechazos_ruta"], [])

    def test_sin_trazado_no_se_registra_nada(self):
        db = base()
        with self.assertRaises(servicio.ErrorRechazo) as e:
            servicio.rechazar_ruta("RT-1", "Zona insegura", None, {}, None, usuario="Ana", cliente_servicio=Cliente(db),
                                   evaluar=evaluador_ok(), hoy=HOY)
        self.assertEqual(e.exception.estado, 422)

    def test_ruta_con_conductor_o_asignacion_no_se_rechaza(self):
        for db in (base(conductor="Luis"), {**base(), "asignaciones_ruta": [{"ruta_id": "RT-1", "fecha_operativa": HOY.isoformat()}]}):
            with self.assertRaises(servicio.ErrorRechazo) as e:
                rechazar(db, evaluador_ok())
            self.assertEqual(e.exception.estado, 409)
            self.assertEqual(db["rechazos_ruta"], [])

    def test_ruta_inexistente_o_de_otro_dia(self):
        for db in ({**base(), "rutas_planificadas": []}, base(fecha="2026-10-22")):
            with self.assertRaises(servicio.ErrorRechazo) as e:
                rechazar(db, evaluador_ok())
            self.assertEqual(e.exception.estado, 404)

    def test_ruta_sin_viaje_generado(self):
        with self.assertRaises(servicio.ErrorRechazo) as e:
            rechazar(base(origen_lat=None), evaluador_ok())
        self.assertEqual(e.exception.estado, 422)

    def test_falta_la_tabla_de_rechazos(self):
        db = base()
        with self.assertRaises(servicio.ErrorRechazo) as e:
            rechazar(db, evaluador_ok(), cliente=Cliente(db, sin_tabla=True))
        self.assertEqual(e.exception.estado, 503)
        self.assertIn("rechazos_ruta.sql", e.exception.mensaje)


class FlujoFallidoTest(unittest.TestCase):
    def assert_sin_alternativa(self, evaluar, codigo):
        db = base()
        r = rechazar(db, evaluar)
        self.assertIsNone(r["alternativa"])
        self.assertEqual(r["error"]["codigo"], codigo)
        self.assertTrue(r["puede_reintentar"])
        self.assertEqual(db["rutas_planificadas"][0]["estado_propuesta"], "rechazada")   # queda marcada
        self.assertEqual(len(db["rechazos_ruta"]), 1)                                      # y el rechazo se conserva
        self.assertEqual(db["rechazos_ruta"][0]["resultado"], "sin_alternativa")
        self.assertIn(codigo, db["rechazos_ruta"][0]["error"])                              # y el error queda registrado
        return db

    def test_no_hay_otra_ruta(self):
        self.assert_sin_alternativa(evaluador_falla(SinAlternativa("x")), logica.SIN_RUTA)

    def test_el_motor_no_responde(self):
        self.assert_sin_alternativa(evaluador_falla(TimeoutError("osrm")), logica.MOTOR_NO_RESPONDE)

    def test_todas_las_alternativas_vetadas(self):
        self.assert_sin_alternativa(evaluador_ok(vetada=True), logica.TODAS_VETADAS)

    def test_no_responde_exitoso_si_no_puede_guardar_el_resultado(self):
        db = base()
        with self.assertRaises(servicio.ErrorRechazo) as error:
            rechazar(db, evaluador_ok(), cliente=ClienteFallaFinalizar(db))
        self.assertEqual(error.exception.estado, 503)
        self.assertIn("Reintenta", error.exception.mensaje)
        self.assertEqual(db["rutas_planificadas"][0]["estado_propuesta"], "rechazada")
        self.assertEqual(db["rechazos_ruta"][0]["resultado"], "pendiente")

    def test_reintentar_genera_la_alternativa(self):
        db = self.assert_sin_alternativa(evaluador_falla(TimeoutError("osrm")), logica.MOTOR_NO_RESPONDE)
        evaluar = evaluador_ok()
        r = servicio.reintentar_alternativa("RT-1", cliente_servicio=Cliente(db), evaluar=evaluar, hoy=HOY)
        self.assertIsNotNone(r["alternativa"])
        self.assertEqual(len(evaluar.llamadas[0]), 1)                                       # sigue excluyendo la rechazada
        self.assertEqual(db["rutas_planificadas"][0]["estado_propuesta"], "propuesta")
        self.assertEqual(db["rechazos_ruta"][0]["resultado"], "generada")

    def test_reintentar_vuelve_a_fallar(self):
        db = self.assert_sin_alternativa(evaluador_falla(SinAlternativa("x")), logica.SIN_RUTA)
        r = servicio.reintentar_alternativa("RT-1", cliente_servicio=Cliente(db), evaluar=evaluador_falla(SinAlternativa("x")), hoy=HOY)
        self.assertIsNone(r["alternativa"])
        self.assertEqual(db["rutas_planificadas"][0]["estado_propuesta"], "rechazada")

    def test_no_se_reintenta_si_no_esta_rechazada(self):
        with self.assertRaises(servicio.ErrorRechazo) as e:
            servicio.reintentar_alternativa("RT-1", cliente_servicio=Cliente(base()), evaluar=evaluador_ok(), hoy=HOY)
        self.assertEqual(e.exception.estado, 409)

    def test_no_se_rechaza_dos_veces_una_ruta_sin_alternativa(self):
        db = self.assert_sin_alternativa(evaluador_falla(SinAlternativa("x")), logica.SIN_RUTA)
        with self.assertRaises(servicio.ErrorRechazo) as e:
            rechazar(db, evaluador_ok())
        self.assertEqual(e.exception.estado, 409)

    def test_no_se_acepta_una_ruta_rechazada_sin_alternativa(self):
        db = self.assert_sin_alternativa(evaluador_falla(SinAlternativa("x")), logica.SIN_RUTA)
        with self.assertRaises(servicio.ErrorRechazo):
            servicio.aceptar_propuesta("RT-1", cliente_usuario=ClienteUsuario(db))


class PropuestaVigenteTest(unittest.TestCase):
    def test_sin_rechazos_muestra_la_mejor_ruta_aunque_tenga_veto(self):
        r = servicio.propuesta_vigente("RT-1", cliente_servicio=Cliente(base()), evaluar=evaluador_ok(vetada=True), hoy=HOY)
        self.assertIsNone(r["error"])
        self.assertEqual(r["propuesta"]["nivel_riesgo_trayecto"], "Alto")

    def test_con_rechazos_excluye_las_rechazadas_y_no_cambia_datos(self):
        db, evaluar = base(), evaluador_ok()
        rechazar(db, evaluar)
        antes = [dict(x) for x in db["rechazos_ruta"]]
        r = servicio.propuesta_vigente("RT-1", cliente_servicio=Cliente(db), evaluar=evaluar, hoy=HOY)
        self.assertEqual((r["rechazos"], len(evaluar.llamadas[-1])), (1, 1))
        self.assertEqual(db["rechazos_ruta"], antes)

    def test_con_rechazos_una_propuesta_vetada_no_se_ofrece(self):
        db = base()
        rechazar(db, evaluador_ok())
        r = servicio.propuesta_vigente("RT-1", cliente_servicio=Cliente(db), evaluar=evaluador_ok(vetada=True), hoy=HOY)
        self.assertEqual(r["error"]["codigo"], logica.TODAS_VETADAS)

    def test_ruta_rechazada_sin_alternativa(self):
        db = base(estado_propuesta="rechazada")
        with self.assertRaises(servicio.ErrorRechazo) as e:
            servicio.propuesta_vigente("RT-1", cliente_servicio=Cliente(db), evaluar=evaluador_ok(), hoy=HOY)
        self.assertEqual(e.exception.estado, 409)


class AgenteExcluyeTest(unittest.TestCase):
    """Con el escenario simulado del agente: la ruta elegida por defecto es el desvío sur."""

    def test_misma_ruta_reconoce_el_mismo_trazado(self):
        a = [(13.70, -89.22), (13.70, -89.17)]
        self.assertTrue(geo.misma_ruta(a, [(13.70001, -89.22), (13.70, -89.195), (13.70, -89.17)]))
        self.assertFalse(geo.misma_ruta(a, [(13.688, -89.22), (13.688, -89.17)]))

    def test_excluir_la_elegida_propone_otra(self):
        primera = construir_agente(AHORA).decidir(ORIGEN, DESTINO, ahora=AHORA, usar_llm=False)
        trazado = [tuple(p) for p in primera["ruta_elegida"]["geometria"]]
        segunda = construir_agente(AHORA).decidir(ORIGEN, DESTINO, ahora=AHORA, usar_llm=False, excluir=[trazado])
        self.assertNotEqual(primera["ruta_elegida"]["distancia_km"], segunda["ruta_elegida"]["distancia_km"])

    def test_excluir_todas_lanza_sin_alternativa(self):
        elegida = construir_agente(AHORA).decidir(ORIGEN, DESTINO, ahora=AHORA, usar_llm=False)["ruta_elegida"]
        trazados = [[tuple(p) for p in elegida["geometria"]], [ORIGEN, (13.700, -89.195), DESTINO]]  # desvío sur + ruta directa
        with self.assertRaises(SinAlternativa):
            construir_agente(AHORA).decidir(ORIGEN, DESTINO, ahora=AHORA, usar_llm=False, excluir=trazados)


class RouterTest(unittest.TestCase):
    """POST /rutas/rechazar de punta a punta con Supabase y agente simulados."""

    def setUp(self):
        import os
        os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
        os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")
        from unittest import mock

        from fastapi.testclient import TestClient

        from backend.app import rechazos_router
        from backend.app.main import app

        self.db = base()
        hoy = mock.patch.object(servicio.rutas_logica, "hoy_el_salvador", return_value=HOY)
        coord = mock.patch.object(
            rechazos_router, "usuario_coordinador", return_value=(ClienteUsuario(self.db), "Ana")
        )
        nube = mock.patch.object(rechazos_router.database, "cliente_servicio", return_value=Cliente(self.db))
        agente = mock.patch.object(rechazos_router, "_agente", return_value=construir_agente(AHORA))
        for parche in (hoy, coord, nube, agente):
            parche.start()
            self.addCleanup(parche.stop)
        self.client = TestClient(app)

    def preparar(self):
        self.db["rutas_planificadas"][0].update(origen_lat=ORIGEN[0], origen_lng=ORIGEN[1], destino_lat=DESTINO[0], destino_lng=DESTINO[1])

    def test_rechazar_devuelve_una_alternativa_distinta_y_registra_al_usuario(self):
        self.preparar()
        directa = {"ruta_id": "R1", "distancia_km": 5.0, "geometria": [list(ORIGEN), [13.700, -89.195], list(DESTINO)]}
        r = self.client.post("/rutas/rechazar", json={"ruta_id": "RT-1", "motivo": "Zona insegura", "ruta_propuesta": directa})
        self.assertEqual(r.status_code, 200, r.text)
        cuerpo = r.json()
        self.assertIsNone(cuerpo["error"])
        self.assertTrue(cuerpo["alternativa"]["evaluacion"]["ruta_elegida"]["desvio"])     # el desvío, no la directa rechazada
        self.assertEqual(self.db["rechazos_ruta"][0]["usuario"], "Ana")
        self.assertEqual(self.db["rutas_planificadas"][0]["estado_propuesta"], "propuesta")

    def test_aceptar_propuesta_usa_rpc_con_token_de_usuario(self):
        from unittest import mock
        from backend.app import rechazos_router

        with mock.patch.object(
            rechazos_router.database, "cliente_servicio", side_effect=AssertionError("no requiere service role")
        ):
            respuesta = self.client.post("/rutas/aceptar-propuesta", json={"ruta_id": "RT-1"})

        self.assertEqual(respuesta.status_code, 200, respuesta.text)
        self.assertEqual(respuesta.json(), {"ruta_id": "RT-1", "estado_propuesta": "aceptada"})
        self.assertEqual(self.db["rutas_planificadas"][0]["estado_propuesta"], "aceptada")

    def test_si_la_unica_alternativa_esta_vetada_se_informa_y_queda_rechazada(self):
        self.preparar()
        desvio = construir_agente(AHORA).decidir(ORIGEN, DESTINO, ahora=AHORA, usar_llm=False)["ruta_elegida"]
        r = self.client.post("/rutas/rechazar", json={"ruta_id": "RT-1", "motivo": "Zona insegura", "ruta_propuesta": desvio})
        self.assertEqual(r.status_code, 200, r.text)
        cuerpo = r.json()
        self.assertIsNone(cuerpo["alternativa"])
        self.assertEqual(cuerpo["error"]["codigo"], logica.TODAS_VETADAS)
        self.assertTrue(cuerpo["puede_reintentar"])
        self.assertEqual(self.db["rutas_planificadas"][0]["estado_propuesta"], "rechazada")

    def test_rechazar_sin_motivo_responde_422(self):
        r = self.client.post("/rutas/rechazar", json={"ruta_id": "RT-1", "ruta_propuesta": {"geometria": TRAZADO}})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(self.db["rechazos_ruta"], [])


if __name__ == "__main__":
    unittest.main()
