"""Endpoints de eventos especiales (FCJ1-15). Contrato = el de eventosEspecialesJS.js.

Tablas de Supabase que espera (crear antes de usar):
  eventos_especiales(id text pk, nombre text, tipo text, inicio timestamptz, fin timestamptz null,
                     zona text, lat float8 null, lng float8 null, radius_m int null,
                     impacto text, estado text default 'pendiente', fuente text,
                     nota text null, revisado_por text null, revisado_en timestamptz null)
  rutas_planificadas(id text pk, nombre text, zona text, fecha date, entregas int, conductor text)
  eventos_auditoria(id bigint identity pk, evento text, accion text, usuario text, fecha timestamptz, nota text null)

Seguridad: el rol se valida AQUÍ con el token de Supabase (app_metadata.role), nunca solo en la página.
"""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

import database
import eventos_logica as logica

router = APIRouter(prefix="/eventos", tags=["eventos especiales"])


def usuario_coordinador(authorization: str | None) -> str:
    """Valida el token y exige el rol coordinador_rutas. Devuelve el nombre para la auditoría."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Sesión vencida. Inicie sesión de nuevo.")
    try:
        user = database.supabase.auth.get_user(authorization.split(" ", 1)[1]).user
    except Exception:
        raise HTTPException(401, "Sesión vencida. Inicie sesión de nuevo.")
    if not user:
        raise HTTPException(401, "Sesión vencida. Inicie sesión de nuevo.")
    meta = user.app_metadata or {}
    if meta.get("role") != logica.ROL_PERMITIDO:
        raise HTTPException(403, "Esta sección es solo para el coordinador de rutas.")
    return (user.user_metadata or {}).get("name") or user.email or "Usuario"


class Revision(BaseModel):
    id: str
    nota: str = Field(min_length=3, max_length=500)


class EventoNuevo(BaseModel):
    nombre: str = ""
    tipo: str = ""
    inicio: str = ""
    zona: str = ""
    impacto: str = ""
    fuente: str | None = None
    lat: float | None = None
    lng: float | None = None
    radius_m: int | None = 400


def _tabla(nombre: str) -> list[dict]:
    return database.supabase.table(nombre).select("*").execute().data or []


@router.post("/listar")
def listar(authorization: str | None = Header(default=None)):
    usuario_coordinador(authorization)
    return logica.construir_respuesta(_tabla("eventos_especiales"), _tabla("rutas_planificadas"), _tabla("eventos_auditoria"))


@router.post("/revisar")
def revisar(req: Revision, authorization: str | None = Header(default=None)):
    usuario = usuario_coordinador(authorization)
    t = database.supabase.table("eventos_especiales")
    filas = t.select("*").eq("id", req.id).execute().data
    if not filas:
        raise HTTPException(404, "El evento ya no existe.")
    if filas[0].get("estado") == "revisado":
        raise HTTPException(409, f"El evento ya fue revisado por {filas[0].get('revisado_por')}.")
    ahora = datetime.now(timezone.utc).isoformat()
    t.update({"estado": "revisado", "nota": req.nota.strip(), "revisado_por": usuario, "revisado_en": ahora}).eq("id", req.id).execute()
    database.supabase.table("eventos_auditoria").insert(
        {"evento": req.id, "accion": "revision", "usuario": usuario, "fecha": ahora, "nota": req.nota.strip()}).execute()
    return {"id": req.id, "estado": "revisado", "revisado_por": usuario, "revisado_en": ahora}


@router.post("/registrar")
def registrar(req: EventoNuevo, authorization: str | None = Header(default=None)):
    usuario = usuario_coordinador(authorization)
    datos = req.model_dump()
    errores = logica.validar_evento(datos, _tabla("eventos_especiales"))
    if errores:
        # 409 si es duplicado, 422 si falta o sobra algo en los campos.
        raise HTTPException(409 if errores[0].startswith("Ya existe") else 422, errores[0])
    ahora = datetime.now(timezone.utc).isoformat()
    fila = {
        "id": "E-" + uuid.uuid4().hex[:8].upper(),
        "nombre": datos["nombre"].strip(), "tipo": datos["tipo"], "inicio": datos["inicio"],
        "zona": datos["zona"].strip(), "impacto": datos["impacto"], "estado": "pendiente",
        "fuente": (datos["fuente"] or "").strip() or "Registro manual",
        "lat": datos["lat"], "lng": datos["lng"], "radius_m": datos["radius_m"],
    }
    database.supabase.table("eventos_especiales").insert(fila).execute()
    database.supabase.table("eventos_auditoria").insert(
        {"evento": fila["id"], "accion": "registro", "usuario": usuario, "fecha": ahora}).execute()
    return fila
