from types import SimpleNamespace

from fastapi import HTTPException

from . import database


def usuario_desde_autorizacion(authorization: str | None):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Sesión vencida. Inicie sesión de nuevo.")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(401, "Sesión vencida. Inicie sesión de nuevo.")

    try:
        claims = database.verificar_token(token)
    except database.VerificacionTokenNoDisponible as error:
        raise HTTPException(503, "No se pudo validar la sesión con Supabase.") from error
    except database.TokenInvalido as error:
        raise HTTPException(401, "Sesión vencida. Inicie sesión de nuevo.") from error

    usuario = SimpleNamespace(
        id=claims["sub"],
        email=claims.get("email"),
        app_metadata=claims.get("app_metadata") or {},
        user_metadata=claims.get("user_metadata") or {},
    )
    return token, usuario
