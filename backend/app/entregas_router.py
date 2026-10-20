"""Endpoints de pedidos y entregas del día (FCJ1-54 a FCJ1-61). Contrato = el de pedidosEnCurso.js.

Tabla de Supabase que espera (crear antes de usar):
  entregas(id text pk, cliente text, direccion text, hora_programada timestamptz,
           estado text default 'pendiente',   -- pendiente | en_proceso | completada
           zona text null, ruta text null,    -- ruta vacía/null = pedido sin ruta asignada
           contacto text null, productos text null, notas text null,
           lat float8 null, lng float8 null)  -- coordenadas verificadas para el mapa

Seguridad: el rol se valida AQUÍ con el token de Supabase (app_metadata.role), nunca solo en la página.
"""
from datetime import date

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from . import database, entregas_logica as logica

router = APIRouter(prefix="/entregas", tags=["pedidos y entregas del dia"])


def usuario_autorizado(authorization: str | None):
    """Valida el token y devuelve un cliente Supabase autenticado."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Sesión vencida. Inicie sesión de nuevo.")
    try:
        user = database.supabase.auth.get_user(authorization.split(" ", 1)[1]).user
    except Exception:
        raise HTTPException(401, "Sesión vencida. Inicie sesión de nuevo.")
    if not user:
        raise HTTPException(401, "Sesión vencida. Inicie sesión de nuevo.")
    meta = user.app_metadata or {}
    if meta.get("role") not in logica.ROLES_PERMITIDOS:
        raise HTTPException(403, "No tiene permiso para ver los pedidos.")
    return database.cliente_autenticado(authorization.split(" ", 1)[1].strip())


class Consulta(BaseModel):
    fecha: str | None = None    # "YYYY-MM-DD"; vacío = hoy
    estado: str | None = None   # pendiente | proceso | completada | todos
    zona: str | None = None
    ruta: str | None = None     # nombre de ruta o "sin_ruta"


@router.post("/listar")
def listar(req: Consulta | None = None, authorization: str | None = Header(default=None)):
    cliente = usuario_autorizado(authorization)
    req = req or Consulta()
    try:
        fecha = date.fromisoformat(req.fecha) if req.fecha else None
    except ValueError:
        raise HTTPException(422, "Fecha no válida. Use el formato AAAA-MM-DD.")
    if req.estado and req.estado != "todos" and req.estado not in logica.ESTADOS:
        raise HTTPException(422, "Estado no válido.")
    filas = cliente.table("entregas").select("*").execute().data or []
    return logica.construir_respuesta(filas, fecha, req.estado, req.zona, req.ruta)