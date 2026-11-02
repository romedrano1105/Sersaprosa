import os
import unittest
from types import SimpleNamespace

from fastapi import HTTPException

os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")

from backend.app import metricas_logica as logica
from backend.app import metricas_router as router


class ValidacionRangoTests(unittest.TestCase):
    def test_acepta_hasta_365_dias_inclusivos(self):
        desde, hasta = logica.validar_rango("2026-01-01", "2026-12-31")
        self.assertEqual((desde.isoformat(), hasta.isoformat()), ("2026-01-01", "2026-12-31"))

    def test_rechaza_fechas_vacias_invalidas_o_invertidas(self):
        for inicio, fin in (
            ("", "2026-01-01"),
            ("2026-02-30", "2026-03-01"),
            ("2026-02-02", "2026-02-01"),
            ("2026-W01-1", "2026-01-01"),
        ):
            with self.subTest(inicio=inicio, fin=fin):
                with self.assertRaisesRegex(ValueError, logica.MSG_RANGO_INVALIDO):
                    logica.validar_rango(inicio, fin)

    def test_rechaza_mas_de_365_dias(self):
        with self.assertRaisesRegex(ValueError, logica.MSG_RANGO_MAXIMO):
            logica.validar_rango("2026-01-01", "2027-01-01")


class ConstruirMetricasTests(unittest.TestCase):
    def test_porcentaje_usa_solo_rutas_clasificadas(self):
        resultado = logica.construir_respuesta(
            [
                {"metodo_creacion": "ia"},
                {"metodo_creacion": "manual"},
                {"metodo_creacion": "sin_clasificar"},
            ],
            [],
            [],
        )
        self.assertEqual(resultado["rutas"], {
            "optimizadas_ia": 1,
            "manuales": 1,
            "total_clasificadas": 2,
            "porcentaje_ia": 50.0,
            "sin_clasificar": 1,
        })

    def test_solo_mitigaciones_confirmadas_cuentan_y_tiempos_son_reales(self):
        resultado = logica.construir_respuesta(
            [],
            [
                {"id": "1", "estado_metrica": "mitigado"},
                {"id": "2", "estado_metrica": "sin_confirmar"},
                {"id": "3", "estado_metrica": "ocurrido"},
            ],
            [
                {
                    "fecha_inicio_proceso": "2026-01-01T10:00:00Z",
                    "fecha_completada_en": "2026-01-01T10:30:00Z",
                },
                {
                    "fecha_inicio_proceso": None,
                    "fecha_completada_en": "2026-01-01T10:40:00Z",
                },
                {
                    "fecha_inicio_proceso": "2026-01-01T11:00:00",
                    "fecha_completada_en": "2026-01-01T10:45:00Z",
                },
            ],
        )
        self.assertEqual(resultado["incidentes_evitados"], 1)
        self.assertEqual(resultado["entregas"], {"promedio_minutos": 30.0, "contabilizadas": 1})


class PermisosMetricasTests(unittest.TestCase):
    def test_analista_no_puede_cambiar_estado(self):
        anterior = router._usuario
        router._usuario = lambda _: (SimpleNamespace(), "analista")
        try:
            with self.assertRaises(HTTPException) as error:
                router.actualizar_estado_evento(
                    router.EstadoEvento(evento_id="E-1", estado="ocurrido"),
                    "Bearer token",
                )
            self.assertEqual(error.exception.status_code, 403)
            self.assertEqual(error.exception.detail, "Permisos insuficientes")
        finally:
            router._usuario = anterior

    def test_coordinador_puede_cambiar_estado_y_el_cambio_se_audita_en_rpc(self):
        llamada = {}

        class Cliente:
            def rpc(self, nombre, parametros):
                llamada["nombre"] = nombre
                llamada["parametros"] = parametros
                return self

            def execute(self):
                return SimpleNamespace(data={"ok": True, "estado_metrica": "mitigado"})

        anterior_usuario = router._usuario
        anterior_cliente = router.database.cliente_servicio
        router._usuario = lambda _: (
            SimpleNamespace(
                id="usuario-1",
                user_metadata={"name": "Supervisora"},
                email="supervisora@example.com",
            ),
            "coordinador_rutas",
        )
        router.database.cliente_servicio = Cliente
        try:
            respuesta = router.actualizar_estado_evento(
                router.EstadoEvento(evento_id="E-1", estado="mitigado"),
                "Bearer token",
            )
        finally:
            router._usuario = anterior_usuario
            router.database.cliente_servicio = anterior_cliente

        self.assertEqual(respuesta["estado_metrica"], "mitigado")
        self.assertEqual(llamada["nombre"], "actualizar_estado_metrica_evento")
        self.assertEqual(llamada["parametros"]["p_usuario_id"], "usuario-1")


if __name__ == "__main__":
    unittest.main()
