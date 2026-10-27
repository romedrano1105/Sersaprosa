"""Notificaciones del administrador de rutas (FCJ1-16).

Endpoints (todos POST, con el token de Supabase en Authorization: Bearer):
  /notificaciones/sincronizar  Busca eventos, alertas, choques y emergencias que coinciden con
                               rutas planificadas y crea las notificaciones que falten.
  /notificaciones/listar       Devuelve las notificaciones (más urgentes primero), el contador
                               de no leídas y la auditoría reciente.
  /notificaciones/leer         Marca una notificación como leída y lo registra en auditoría.

Tablas: backend/database/notificaciones.sql (además de eventos_especiales, rutas_planificadas,
alertas_seguridad y viajes_finalizados, que ya usan las otras secciones).

Seguridad: el rol se valida AQUÍ con el token (app_metadata.role) y las consultas usan el cliente
autenticado del usuario, así que también aplica RLS en Supabase.
"""
import logging
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from . import database, notificaciones_logica as logica

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/notificaciones", tags=["notificaciones"])

LIMITE_LISTADO = 200
LIMITE_AUDITORIA = 40
MENSAJE_FALLO = "No se pudieron generar algunas notificaciones"


def usuario_administrador(authorization: str | None):
    """Valida el token y el rol. Devuelve (cliente autenticado, id de usuario, nombre)."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Sesión vencida. Inicie sesión de nuevo.")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(401, "Sesión vencida. Inicie sesión de nuevo.")
    try:
        user = database.supabase.auth.get_user(token).user
    except Exception:
        raise HTTPException(401, "Sesión vencida. Inicie sesión de nuevo.")
    if not user:
        raise HTTPException(401, "Sesión vencida. Inicie sesión de nuevo.")
    if (user.app_metadata or {}).get("role") != logica.ROL_PERMITIDO:
        raise HTTPException(403, "Esta sección es solo para el administrador de rutas.")
    nombre = (user.user_metadata or {}).get("name") or user.email or "Usuario"
    return database.cliente_autenticado(token), str(user.id), nombre


def _tabla(cliente, nombre: str) -> list[dict]:
    return cliente.table(nombre).select("*").execute().data or []


def _fallo(mensaje: str = MENSAJE_FALLO):
    return HTTPException(503, detail={"message": mensaje, "retryable": True})


class Lectura(BaseModel):
    id: UUID


@router.post("/sincronizar")
def sincronizar(authorization: str | None = Header(default=None)):
    """Crea las notificaciones que falten. Si una fuente falla, NO se da por creada:
    se registra el fallo y se devuelve en `fallos` para que el administrador pueda reintentar."""
    cliente, _, nombre = usuario_administrador(authorization)
    fallos: list[str] = []

    def leer(tabla: str, etiqueta: str) -> list[dict]:
        try:
            return _tabla(cliente, tabla)
        except Exception:
            logger.exception("No se pudo leer %s para generar notificaciones.", tabla)
            fallos.append(etiqueta)
            return []

    # Sin rutas planificadas o sin las notificaciones existentes no se puede decidir
    # qué crear sin riesgo de duplicar: se corta y se avisa.
    try:
        rutas = _tabla(cliente, "rutas_planificadas")
        existentes = {
            logica.clave(n["origen"], n["origen_id"], n["ruta_id"])
            for n in _tabla(cliente, "notificaciones")
        }
    except Exception:
        logger.exception("No se pudieron leer las rutas o las notificaciones existentes.")
        raise _fallo()

    hechos = [logica.hecho_de_evento(e) for e in leer("eventos_especiales", "eventos")]
    viajes = {str(v["id"]): v for v in leer("viajes_finalizados", "alertas")}
    hechos += [
        logica.hecho_de_alerta(a, viajes.get(str(a.get("viaje_id"))))
        for a in leer("alertas_seguridad", "alertas")
    ]
    hechos += [logica.hecho_de_incidente(i) for i in leer("incidentes_ruta", "choques y emergencias")]

    nuevas = logica.generar(hechos, rutas, existentes)
    if nuevas:
        try:
            # El índice único (origen, origen_id, ruta_id) evita duplicados aunque dos
            # sesiones sincronicen a la vez: la segunda inserción se ignora.
            guardadas = (
                cliente.table("notificaciones")
                .upsert(nuevas, on_conflict="origen,origen_id,ruta_id", ignore_duplicates=True)
                .execute().data or []
            )
            if guardadas:
                ahora = datetime.now(timezone.utc).isoformat()
                cliente.table("notificaciones_auditoria").insert([
                    {"notificacion_id": n["id"], "accion": "generada", "usuario": nombre, "fecha": ahora}
                    for n in guardadas
                ]).execute()
        except Exception:
            logger.exception("No se pudieron guardar las notificaciones nuevas.")
            raise _fallo()
    else:
        guardadas = []

    return {
        "creadas": len(guardadas),
        "sin_urgencia": sum(1 for n in nuevas if not n.get("urgencia")),
        "fallos": fallos,
    }


@router.post("/listar")
def listar(authorization: str | None = Header(default=None)):
    cliente, _, _ = usuario_administrador(authorization)
    try:
        notificaciones = (
            cliente.table("notificaciones").select("*")
            .order("creada_en", desc=True).limit(LIMITE_LISTADO).execute().data or []
        )
        auditoria = (
            cliente.table("notificaciones_auditoria").select("*")
            .order("fecha", desc=True).limit(LIMITE_AUDITORIA).execute().data or []
        )
    except Exception:
        logger.exception("No se pudieron cargar las notificaciones.")
        raise _fallo("No se pudieron cargar las notificaciones")
    titulos = {str(n["id"]): n for n in notificaciones}
    for registro in auditoria:
        origen = titulos.get(str(registro.get("notificacion_id")))
        registro["titulo"] = origen["titulo"] if origen else "Notificación"
        registro["urgencia"] = origen.get("urgencia") if origen else None
        registro["ruta"] = origen.get("ruta") if origen else ""
    return logica.construir_respuesta(notificaciones, auditoria)


@router.post("/leer")
def leer(req: Lectura, authorization: str | None = Header(default=None)):
    cliente, usuario_id, nombre = usuario_administrador(authorization)
    ahora = datetime.now(timezone.utc).isoformat()
    try:
        actual = cliente.table("notificaciones").select("id, leida").eq("id", str(req.id)).execute().data
        if not actual:
            raise HTTPException(404, "La notificación ya no existe.")
        if actual[0].get("leida"):
            return {"id": str(req.id), "leida": True, "ya_estaba": True}
        cliente.table("notificaciones").update({
            "leida": True, "leida_por": usuario_id, "leida_nombre": nombre, "leida_en": ahora,
        }).eq("id", str(req.id)).eq("leida", False).execute()
        cliente.table("notificaciones_auditoria").insert({
            "notificacion_id": str(req.id), "accion": "leida", "usuario": nombre, "fecha": ahora,
        }).execute()
    except HTTPException:
        raise
    except Exception:
        logger.exception("No se pudo marcar la notificación como leída.")
        raise _fallo("No se pudo marcar la notificación como leída")
    return {"id": str(req.id), "leida": True, "leida_nombre": nombre, "leida_en": ahora}
