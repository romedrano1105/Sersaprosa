import unittest
from datetime import date
from types import SimpleNamespace

from backend.app import viajes_logica as logica
from backend.app import viajes_servicio as servicio

HOY = date(2026, 10, 23)
OK = {"origen": "Bodega Central, San Salvador", "destino": "Metrocentro", "horario": "09:30", "tipo_carga_id": 3, "monto": "1500.50"}


class ValidacionTest(unittest.TestCase):
    def test_viaje_completo_es_valido(self):
        limpio, errores = logica.validar_viaje(OK)
        self.assertEqual(errores, {})
        self.assertEqual(limpio["horario"], "09:30")
        self.assertEqual(limpio["monto"], "1500.50")

    def test_campos_vacios_se_listan_todos(self):
        _, errores = logica.validar_viaje({})
        self.assertEqual(set(errores), {"origen", "destino", "horario", "tipo_carga_id", "monto"})
        self.assertEqual(logica.mensaje_de_errores(errores),
                         "Faltan campos obligatorios: Origen, Destino, Horario, Tipo de carga, Monto.")

    def test_solo_falta_un_campo(self):
        _, errores = logica.validar_viaje({**OK, "destino": "  "})
        self.assertEqual(list(errores), ["destino"])
        self.assertIn("Destino", logica.mensaje_de_errores(errores))

    def test_horario_fuera_del_horario_de_entregas(self):
        for hora in ("03:00", "05:59", "20:01", "23:30"):
            _, errores = logica.validar_viaje({**OK, "horario": hora})
            self.assertIn("No se realizan entregas", errores["horario"], hora)
        for hora in ("06:00", "12:15", "20:00"):
            self.assertNotIn("horario", logica.validar_viaje({**OK, "horario": hora})[1], hora)

    def test_horario_con_formato_invalido(self):
        for hora in ("25:00", "9", "abc", "12:70"):
            self.assertIn("formato", logica.validar_viaje({**OK, "horario": hora})[1]["horario"])

    def test_monto_y_tipo_invalidos(self):
        for monto in ("0", "-5", "abc", "1.234", True):
            self.assertIn("monto", logica.validar_viaje({**OK, "monto": monto})[1], monto)
        for tipo in ("x", 0, 99999, True):
            self.assertIn("tipo_carga_id", logica.validar_viaje({**OK, "tipo_carga_id": tipo})[1], tipo)

    def test_origen_igual_a_destino(self):
        self.assertIn("destino", logica.validar_viaje({**OK, "origen": "Metrocentro"})[1])

    def test_nombre_unico_del_dia(self):
        self.assertEqual(logica.nombre_de_viaje("Metrocentro", "09:30", []), "09:30 · Metrocentro")
        self.assertEqual(logica.nombre_de_viaje("Metrocentro", "09:30", ["09:30 · metrocentro"]), "09:30 · Metrocentro #2")

    def test_ruta_ya_salio(self):
        self.assertTrue(logica.ruta_ya_salio({"conductor": "Ana"}, False))
        self.assertTrue(logica.ruta_ya_salio({"conductor": None}, True))
        self.assertFalse(logica.ruta_ya_salio({"conductor": None}, False))


class Resp:
    def __init__(self, data): self.data = data


class Consulta:
    def __init__(self, db, tabla, falla_insert=False):
        self.db, self.tabla, self.op, self.valores, self.f, self.falla = db, tabla, "select", None, [], falla_insert

    def select(self, *_): return self
    def limit(self, *_): return self
    def insert(self, v): self.op, self.valores = "insert", v; return self
    def update(self, v): self.op, self.valores = "update", v; return self
    def delete(self): self.op = "delete"; return self
    def eq(self, c, v): self.f.append(lambda r: r.get(c) == v); return self
    def in_(self, c, vs): self.f.append(lambda r: r.get(c) in vs); return self

    def execute(self):
        filas = self.db.setdefault(self.tabla, [])
        if self.op == "insert":
            if self.falla:
                raise SimpleNamespace_error("PGRST204", "column origen_texto does not exist")
            nuevas = self.valores if isinstance(self.valores, list) else [self.valores]
            filas.extend(dict(v) for v in nuevas); return Resp(nuevas)
        coincide = lambda r: all(f(r) for f in self.f)
        if self.op == "update":
            [r.update(self.valores) for r in filas if coincide(r)]; return Resp([])
        if self.op == "delete":
            filas[:] = [r for r in filas if not coincide(r)]; return Resp([])
        return Resp([dict(r) for r in filas if coincide(r)])


def SimpleNamespace_error(code, msg):
    e = Exception(msg); e.code = code; return e


class Cliente:
    def __init__(self, db, rpc_falla=False, sin_columnas=False, sin_funciones=False):
        self.db, self.rpc_falla, self.sin_columnas, self.sin_funciones, self.llamadas = db, rpc_falla, sin_columnas, sin_funciones, []

    def table(self, t): return Consulta(self.db, t, falla_insert=self.sin_columnas and t == "rutas_planificadas")

    def rpc(self, nombre, params):
        self.llamadas.append((nombre, params))
        def ejecutar():
            if self.sin_funciones:
                raise SimpleNamespace_error("PGRST202", "function not found")
            if self.rpc_falla:
                raise RuntimeError("rpc caído")
            return Resp({"ruta_id": params["p_ruta_id"], "nivel_riesgo": "Medio"})
        return SimpleNamespace(execute=ejecutar)


def geo(texto):
    if "xx" in texto.lower():
        raise ValueError("No se encontró la dirección en El Salvador.")
    return {"lat": 13.7 if "Bodega" in texto else 13.71, "lng": -89.2, "label": texto}


def evaluar(o, d):
    return {"modo": "determinista", "ruta_elegida": {"ruta_id": "R1", "distancia_km": 3.2}, "justificacion": "ok"}


def base():
    return {"entregas": [{"id": "P1", "ruta": None, "estado": "pendiente"}], "rutas_planificadas": [], "asignaciones_ruta": []}


def llamar(f, *args, db=None, usuario_cli=None, **kw):
    db = base() if db is None else db
    servicio_cli, usuario_cli = Cliente(db, sin_columnas=kw.pop("sin_columnas", False)), usuario_cli or Cliente(db)
    return f(*args, usuario="Ana", cliente_usuario=usuario_cli, cliente_servicio=servicio_cli, geocodificar=geo,
             evaluar=kw.pop("evaluar", evaluar), hoy=HOY, **kw), db, usuario_cli


class GenerarTest(unittest.TestCase):
    def test_camino_feliz_guarda_ruta_con_viaje_y_riesgo(self):
        r, db, cli = llamar(servicio.generar_viaje, OK, ["P1"])
        fila = db["rutas_planificadas"][0]
        self.assertEqual((fila["destino_texto"], fila["hora_salida"], fila["monto"], fila["tipo_carga_id"]),
                         ("Metrocentro", "09:30", "1500.50", 3))
        self.assertEqual(db["entregas"][0]["ruta"], r["ruta"]["nombre"])
        self.assertEqual(cli.llamadas[0][0], "especificar_riesgo_ruta")
        self.assertEqual(r["viaje"]["nivel_riesgo"], "Medio")
        self.assertEqual(r["evaluacion"]["ruta_elegida"]["ruta_id"], "R1")

    def test_campos_faltantes_no_generan_ruta(self):
        db = base()
        with self.assertRaises(servicio.ErrorViaje) as cm:
            llamar(servicio.generar_viaje, {**OK, "origen": "", "monto": None}, [], db=db)
        self.assertEqual(cm.exception.estado, 422)
        self.assertIn("Origen", cm.exception.mensaje)
        self.assertEqual(db["rutas_planificadas"], [])

    def test_horario_fuera_de_rango_no_genera_ruta(self):
        db = base()
        with self.assertRaises(servicio.ErrorViaje) as cm:
            llamar(servicio.generar_viaje, {**OK, "horario": "02:00"}, [], db=db)
        self.assertIn("horario", cm.exception.errores)
        self.assertEqual(db["rutas_planificadas"], [])

    def test_direccion_inexistente(self):
        with self.assertRaises(servicio.ErrorViaje) as cm:
            llamar(servicio.generar_viaje, {**OK, "destino": "xx yy zz"}, [])
        self.assertEqual((cm.exception.estado, list(cm.exception.errores)), (422, ["destino"]))

    def test_si_la_ia_falla_no_se_guarda_nada(self):
        db = base()
        def roto(o, d): raise ConnectionError("osrm")
        with self.assertRaises(servicio.ErrorViaje) as cm:
            llamar(servicio.generar_viaje, OK, ["P1"], db=db, evaluar=roto)
        self.assertEqual(cm.exception.estado, 502)
        self.assertEqual((db["rutas_planificadas"], db["entregas"][0]["ruta"]), ([], None))

    def test_si_falla_el_riesgo_se_deshace_la_ruta(self):
        db = base()
        with self.assertRaises(servicio.ErrorViaje) as cm:
            llamar(servicio.generar_viaje, OK, ["P1"], db=db, usuario_cli=Cliente(db, rpc_falla=True))
        self.assertEqual(cm.exception.estado, 503)
        self.assertEqual((db["rutas_planificadas"], db["entregas"][0]["ruta"]), ([], None))

    def test_falta_el_sql_da_mensaje_claro(self):
        with self.assertRaises(servicio.ErrorViaje) as cm:
            llamar(servicio.generar_viaje, OK, [], sin_columnas=True)
        self.assertIn("viajes_ruta.sql", cm.exception.mensaje)


class TiposYRiesgoTest(unittest.TestCase):
    def test_nivel_de_riesgo_como_en_sql(self):
        self.assertEqual(logica.nivel_de_riesgo("500", 0), "Bajo")
        self.assertEqual(logica.nivel_de_riesgo("500", 2), "Medio")
        self.assertEqual(logica.nivel_de_riesgo("50000", 1), "Medio")
        self.assertEqual(logica.nivel_de_riesgo("500000", 1), "Alto")

    def test_tipos_vacios_se_siembran_y_se_listan(self):
        db = {"tipos_carga": []}
        # la tabla del fake asigna id al insertar solo si se lo damos: se simula con un cliente que numera
        class Numera(Cliente):
            def table(self, t):
                q = super().table(t)
                if t == "tipos_carga":
                    original = q.insert
                    q.insert = lambda v: original([{**x, "id": i + 1, "activo": True} for i, x in enumerate(v)])
                return q
        servicio_cli = Numera(db)
        tipos = servicio.listar_tipos_carga(Cliente(db, sin_funciones=True), servicio_cli)
        self.assertEqual(len(tipos), 6)
        self.assertIn("Electrónicos", [t["nombre"] for t in tipos])

    def test_si_la_funcion_de_riesgo_no_existe_se_calcula_en_el_servidor(self):
        db = base()
        db["tipos_carga"] = [{"id": 3, "sensibilidad": 1}]
        r, db, cli = llamar(servicio.generar_viaje, OK, [], db=db, usuario_cli=Cliente(db, sin_funciones=True))
        self.assertEqual(r["viaje"]["nivel_riesgo"], "Bajo")            # monto 1500.50 (0) + sensibilidad 1 = 1 → Bajo
        self.assertEqual(db["rutas_planificadas"][0]["nivel_riesgo"], "Bajo")

    def test_tipo_inexistente_deshace_la_ruta(self):
        db = base()
        db["tipos_carga"] = []
        with self.assertRaises(servicio.ErrorViaje) as cm:
            llamar(servicio.generar_viaje, OK, [], db=db, usuario_cli=Cliente(db, sin_funciones=True))
        self.assertEqual(cm.exception.estado, 422)
        self.assertEqual(db["rutas_planificadas"], [])

    def test_coordenadas_elegidas_evitan_geocodificar(self):
        def sin_geo(_):
            raise AssertionError("no debe geocodificar")
        datos = {**OK, "origen_lat": 13.7, "origen_lng": -89.2, "destino_lat": 13.71, "destino_lng": -89.19}
        db = base()
        servicio.generar_viaje(datos, [], usuario="Ana", cliente_usuario=Cliente(db), cliente_servicio=Cliente(db),
                               geocodificar=sin_geo, evaluar=evaluar, hoy=HOY)
        self.assertEqual(db["rutas_planificadas"][0]["destino_lat"], 13.71)


class EditarTest(unittest.TestCase):
    def crear(self):
        r, db, cli = llamar(servicio.generar_viaje, OK, [])
        return r["ruta"]["id"], db

    def test_edita_destino_y_monto_antes_de_salir(self):
        rid, db = self.crear()
        r, db, cli = llamar(servicio.actualizar_viaje, rid, {**OK, "destino": "Santa Tecla", "monto": "99"}, db=db)
        fila = db["rutas_planificadas"][0]
        self.assertEqual(fila["destino_texto"], "Santa Tecla")
        self.assertEqual(cli.llamadas[0][1]["p_monto"], "99")

    def test_no_edita_si_la_ruta_ya_salio(self):
        rid, db = self.crear()
        db["asignaciones_ruta"].append({"ruta_id": rid, "fecha_operativa": HOY.isoformat()})
        with self.assertRaises(servicio.ErrorViaje) as cm:
            llamar(servicio.actualizar_viaje, rid, OK, db=db)
        self.assertEqual(cm.exception.estado, 409)
        self.assertIn("ya salió", cm.exception.mensaje)

    def test_no_edita_si_tiene_conductor(self):
        rid, db = self.crear()
        db["rutas_planificadas"][0]["conductor"] = "Luis"
        with self.assertRaises(servicio.ErrorViaje) as cm:
            llamar(servicio.actualizar_viaje, rid, OK, db=db)
        self.assertEqual(cm.exception.estado, 409)

    def test_edicion_invalida_no_cambia_nada(self):
        rid, db = self.crear()
        with self.assertRaises(servicio.ErrorViaje):
            llamar(servicio.actualizar_viaje, rid, {**OK, "horario": "01:00"}, db=db)
        self.assertEqual(db["rutas_planificadas"][0]["hora_salida"], "09:30")

    def test_ruta_inexistente(self):
        with self.assertRaises(servicio.ErrorViaje) as cm:
            llamar(servicio.actualizar_viaje, "RT-NO", OK)
        self.assertEqual(cm.exception.estado, 404)


if __name__ == "__main__":
    unittest.main()
