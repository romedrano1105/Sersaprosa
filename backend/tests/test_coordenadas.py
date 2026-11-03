"""Coordenadas de pedidos, ubicación por dirección y errores claros al calcular rutas."""
import os
import unittest
from datetime import datetime, timezone

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")

from backend.agente_rutas import herramientas as h
from backend.app import entregas_logica as logica
from backend.app import viajes_servicio as servicio


class Coordenadas(unittest.TestCase):
    def test_validas_texto_e_invertidas(self):
        self.assertEqual(logica.coordenadas(13.69, -89.19), (13.69, -89.19))
        self.assertEqual(logica.coordenadas("13.69", "-89.19"), (13.69, -89.19))
        self.assertEqual(logica.coordenadas("13,69", "-89,19"), (13.69, -89.19))
        self.assertEqual(logica.coordenadas(-89.19, 13.69), (13.69, -89.19))   # invertidas

    def test_descarta_null_cero_y_fuera_del_pais(self):
        for lat, lng in [(None, None), (13.7, None), ("", ""), (0, 0), (40.4, -3.7), (float("nan"), -89.2), ("x", "y")]:
            with self.subTest(lat=lat, lng=lng):
                self.assertIsNone(logica.coordenadas(lat, lng))

    def test_formatear_nunca_devuelve_coordenadas_a_medias(self):
        base = {"id": 1, "hora_programada": "2026-11-02T09:00:00"}
        self.assertEqual({k: logica.formatear({**base, "lat": "13.7", "lng": "-89.2"})[k] for k in ("lat", "lng", "ubicada")},
                         {"lat": 13.7, "lng": -89.2, "ubicada": True})
        self.assertEqual({k: logica.formatear({**base, "lat": 13.7})[k] for k in ("lat", "lng", "ubicada")},
                         {"lat": None, "lng": None, "ubicada": False})

    def test_totales_cuentan_los_pedidos_sin_ubicacion(self):
        from datetime import date
        filas = [{"id": 1, "hora_programada": "2026-11-02T09:00:00", "lat": 13.7, "lng": -89.2},
                 {"id": 2, "hora_programada": "2026-11-02T10:00:00"}]
        r = logica.construir_respuesta(filas, date(2026, 11, 2))
        self.assertEqual(r["totals"]["sin_ubicacion"], 1)


class UbicarPedidos(unittest.TestCase):
    def test_consultas_de_la_mas_precisa_a_la_zona(self):
        consultas = logica.consultas_ubicacion({"direccion": "Calle Arce 123", "zona": "San Salvador"})
        self.assertEqual(consultas[0], ("Calle Arce 123, San Salvador, El Salvador", "direccion"))
        self.assertEqual(consultas[-1], ("San Salvador, El Salvador", "zona"))
        self.assertEqual(logica.consultas_ubicacion({"direccion": "Sin dirección", "zona": "Sin zona"}), [])

    def test_ubica_guarda_y_nunca_inventa(self):
        guardadas = []

        def geo(texto):
            if texto.startswith("Calle Arce"):
                return {"lat": 13.70, "lng": -89.20, "label": "Calle Arce"}
            if texto.startswith("Soyapango"):
                return {"lat": 13.73, "lng": -89.15, "label": "Soyapango"}
            raise ValueError("no encontrado")

        r = logica.ubicar_pedidos([
            {"id": "A", "direccion": "Calle Arce 1", "zona": None},
            {"id": "B", "direccion": "Lugar inexistente", "zona": "Soyapango"},
            {"id": "C", "direccion": "Lugar inexistente", "zona": None},
            {"id": "D", "lat": 13.68, "lng": -89.25},
        ], geo, lambda pid, lat, lng: guardadas.append(pid))
        ubicadas = {u["id"]: u for u in r["ubicadas"]}
        self.assertEqual((ubicadas["A"]["precision"], ubicadas["A"]["lat"]), ("direccion", 13.70))
        self.assertEqual(ubicadas["B"]["precision"], "zona")
        self.assertEqual(ubicadas["D"]["precision"], "guardada")
        self.assertEqual([s["id"] for s in r["sin_ubicar"]], ["C"])
        self.assertEqual(guardadas, ["A", "B"])                    # la ya guardada no se reescribe
        self.assertTrue(any("aproximada" in a for a in r["avisos"]))

    def test_si_el_servicio_cae_no_insiste_y_lo_dice(self):
        llamadas = []

        def caido(texto):
            llamadas.append(texto)
            raise ConnectionError("sin red")

        r = logica.ubicar_pedidos([{"id": 1, "direccion": "Calle 1"}, {"id": 2, "direccion": "Calle 2"}], caido)
        self.assertEqual(len(llamadas), 1)
        self.assertEqual([s["motivo"] for s in r["sin_ubicar"]], ["El servicio de direcciones no respondió."] * 2)

    def test_coordenada_del_geocodificador_fuera_del_pais_se_descarta(self):
        r = logica.ubicar_pedidos([{"id": 1, "direccion": "Madrid"}], lambda t: {"lat": 40.4, "lng": -3.7})
        self.assertEqual((r["ubicadas"], len(r["sin_ubicar"])), ([], 1))


class ErroresDeRuta(unittest.TestCase):
    def test_mensajes_por_tipo_de_fallo(self):
        class SinAlternativa(RuntimeError):
            pass
        self.assertEqual(servicio.mensaje_error_ruta(SinAlternativa("x"))[0], 409)
        self.assertEqual(servicio.mensaje_error_ruta(RuntimeError("No se obtuvieron rutas candidatas del motor de rutas."))[0], 422)
        estado, texto = servicio.mensaje_error_ruta(ConnectionError("osrm"))
        self.assertEqual(estado, 502)
        self.assertIn("OSRM", texto)
        self.assertIn("KeyError", servicio.mensaje_error_ruta(KeyError("x"))[1])

    def test_no_llama_al_motor_sin_coordenadas_validas(self):
        llamado = []
        for o, d in [({"lat": None, "lng": None}, {"lat": 13.7, "lng": -89.2}),
                     ({"lat": 13.7, "lng": -89.2}, {"lat": 13.7, "lng": -89.2}),
                     ({"lat": 13.7, "lng": -89.2}, {"lat": 16.5, "lng": -92.0})]:
            with self.subTest(o=o, d=d), self.assertRaises(servicio.ErrorViaje) as cm:
                servicio._evaluar(lambda a, b: llamado.append(1), o, d)
            self.assertEqual(cm.exception.estado, 422)
        self.assertEqual(llamado, [])


class FuentesQueFallan(unittest.TestCase):
    def test_una_fuente_caida_no_tumba_la_evaluacion(self):
        class Rota:
            def activos(self, caja, ahora):
                raise RuntimeError("relation alertas_seguridad does not exist")

        class Vacia:
            def zonas(self, caja):
                return []

            def tramos(self, caja):
                return []

        s = h.Sesion(origen=(13.70, -89.20), destino=(13.71, -89.19), ahora=datetime.now(timezone.utc),
                     incidentes_src=Rota(), trafico_src=Vacia(), zonas_src=Vacia(), enrutador=None)
        self.assertEqual(h.consultar_incidentes(s)["total"], 0)
        self.assertEqual(len(s.avisos), 1)
        self.assertIn("incidentes", s.avisos[0])


try:
    from backend.app import database
except ImportError:  # sin la librería supabase instalada (el CI sí la tiene)
    database = None


@unittest.skipIf(database is None, "requiere la librería supabase")
class DiagnosticoSupabase(unittest.TestCase):
    def test_clasifica_errores_y_no_expone_claves(self):
        class Tabla:
            def __init__(self, nombre):
                self.nombre = nombre

            def select(self, *_):
                return self

            def limit(self, *_):
                return self

            def execute(self):
                if self.nombre == "eventos_especiales":
                    raise RuntimeError("PGRST205 Could not find the table")
                if self.nombre == "entregas":
                    raise RuntimeError("42703 column entregas.lat does not exist")
                return self

        class Cliente:
            def table(self, nombre):
                return Tabla(nombre)

        r = database.diagnostico(lambda: Cliente())
        self.assertEqual(r["tablas"]["eventos_especiales"], "falta la tabla")
        self.assertTrue(r["tablas"]["entregas"].startswith("falta una columna"))
        self.assertEqual(r["tablas"]["empleados"], "ok")
        self.assertFalse(r["ok"])
        self.assertNotIn("test-anon-key", str(r))


if __name__ == "__main__":
    unittest.main()
