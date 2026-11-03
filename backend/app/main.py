import logging
import math
import os
import time
import uuid
from collections import deque
from pathlib import Path
from threading import Lock

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from postgrest.exceptions import APIError
from pydantic import BaseModel, Field
from supabase import create_client
from supabase_auth.errors import AuthApiError
from .rechazos_router import router as rechazos_router   

from . import database
from .agente_router import router as agente_router
from .alertas_seguridad_router import router as alertas_router
from .disponibilidad_router import router as disponibilidad_router
from .entregas_router import router as entregas_router
from .empleados_router import router as empleados_router
from .eventos_router import router as eventos_router
from .geocodificacion_router import router as geocodificacion_router
from .historial_incidentes_router import router as historial_incidentes_router
from .incidentes_router import router as incidentes_router
from .metricas_router import router as metricas_router
from .notificaciones_router import router as notificaciones_router
from .rutas_riesgo import router as rutas_riesgo_router
from .rutas_calculo_router import router as rutas_calculo_router
from .rutas_router import router as rutas_router
from .viajes_router import router as viajes_router

logger = logging.getLogger(__name__)

app = FastAPI()
LOGIN_MAX_INTENTOS = 5
LOGIN_VENTANA_SEGUNDOS = 15 * 60
_login_lock = Lock()
_login_fallos: dict[str, deque[float]] = {}

# Permite que el navegador haga peticiones desde PaginaPrincipal.html sin bloqueos de CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(eventos_router)  # /eventos/listar · /eventos/revisar · /eventos/registrar (FCJ1-15)
app.include_router(entregas_router)
app.include_router(alertas_router)
app.include_router(disponibilidad_router)
app.include_router(notificaciones_router)
app.include_router(rutas_riesgo_router)
app.include_router(geocodificacion_router)
app.include_router(rutas_calculo_router)
app.include_router(rutas_router)
app.include_router(viajes_router)
app.include_router(agente_router)
app.include_router(incidentes_router)
app.include_router(metricas_router)
app.include_router(historial_incidentes_router)
app.include_router(rechazos_router)
app.include_router(empleados_router)  # /empleados/listar · /guardar · /estado
# --- ENDPOINT DE VERIFICACIÓN Y AUTENTICACIÓN ---
class CredencialesEmpleado(BaseModel):
    code: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=256)


@app.exception_handler(Exception)
async def error_inesperado(request, error):
    """Devuelve una referencia opaca; la excepción y su traceback quedan solo en logs."""
    error_id = uuid.uuid4().hex
    logger.exception("Error no controlado. error_id=%s path=%s", error_id, request.url.path)
    return JSONResponse(status_code=500, content={
        "error_id": error_id,
        "detail": f"Error interno del servidor. Referencia: {error_id}.",
    })


@app.get("/version", include_in_schema=False)
def version():
    """Qué commit y rama están desplegados (Render define estas variables en cada deploy)."""
    return JSONResponse(
        {"commit": (os.getenv("RENDER_GIT_COMMIT") or "desconocido")[:7], "rama": os.getenv("RENDER_GIT_BRANCH") or "desconocida"},
        headers={"Cache-Control": "no-store"},
    )


@app.get("/salud", include_in_schema=False)
def salud():
    """Estado de la conexión con Supabase: variables (sí/no), URL y tablas. No expone claves ni datos."""
    datos = database.diagnostico()
    return JSONResponse(datos, status_code=200 if datos.get("ok") else 503, headers={"Cache-Control": "no-store"})


@app.post("/login")
def login(credenciales: CredencialesEmpleado, request: Request):
    ip = request.client.host if request.client else "desconocido"
    retry_after = _login_segundos_bloqueo(ip)
    if retry_after:
        raise HTTPException(
            status_code=429,
            detail={"message": "Demasiados intentos. Espere antes de volver a iniciar sesión."},
            headers={"Retry-After": str(retry_after)},
        )

    codigo = credenciales.code.strip()
    if not codigo:
        raise HTTPException(status_code=422, detail="El código de empleado es obligatorio.")

    try:
        empleado = database.buscar_empleado_por_codigo(codigo)
    except database.AuthConfigurationError as error:
        logger.error("Configuración de autenticación incompleta: %s", error)
        raise HTTPException(status_code=503, detail=str(error)) from error
    except (APIError, httpx.HTTPError) as error:
        logger.exception("No fue posible consultar el empleado en Supabase.")
        raise HTTPException(
            status_code=502,
            detail="No fue posible consultar el empleado en Supabase. Revise la tabla y las políticas.",
        ) from error
    except Exception as error:  # p. ej. clave de Supabase mal pegada o formato de fila inesperado
        logger.exception("Falló la conexión con Supabase al buscar el empleado.")
        raise HTTPException(
            status_code=503,
            detail="No se pudo leer el empleado en Supabase. Revise la configuración del servidor.",
        ) from error

    if not empleado:
        _login_registrar_fallo(ip)
        raise HTTPException(status_code=401, detail="Código de empleado o contraseña incorrectos.")
    if not empleado.get("email"):
        logger.error("El empleado con código %s no tiene email de Supabase Auth asociado.", codigo)
        raise HTTPException(
            status_code=503,
            detail="El empleado todavía no tiene un email de Supabase Auth asociado.",
        )

    try:
        auth_client = create_client(database.SUPABASE_URL, database.SUPABASE_KEY)
        auth = auth_client.auth.sign_in_with_password(
            {"email": empleado["email"], "password": credenciales.password}
        )
    except AuthApiError as error:
        status = getattr(error, "status", None)
        code = getattr(error, "code", "supabase_auth_error")
        message = getattr(error, "message", str(error))
        logger.warning(
            "Supabase Auth rechazó el inicio de sesión: status=%s code=%s message=%s",
            status,
            code,
            message,
        )
        if isinstance(status, int) and 400 <= status < 500:
            _login_registrar_fallo(ip)
        status_code = status if isinstance(status, int) and 400 <= status < 600 else 502
        raise HTTPException(
            status_code=status_code,
            detail={"message": message, "code": code},
        ) from error
    except httpx.HTTPError as error:
        logger.exception("No fue posible contactar Supabase Auth.")
        raise HTTPException(
            status_code=502,
            detail="No fue posible contactar Supabase Auth. Inténtelo de nuevo.",
        ) from error

    if not auth.session or not auth.user or not auth.session.access_token:
        logger.error("Supabase Auth respondió sin usuario o access token.")
        raise HTTPException(
            status_code=502,
            detail="Supabase Auth no devolvió una sesión válida.",
        )

    _login_limpiar_fallos(ip)
    metadata = auth.user.user_metadata or {}
    app_metadata = auth.user.app_metadata or {}
    return {
        "status": "success",
        "token": auth.session.access_token,
        "name": metadata.get("name") or empleado.get("nombre") or codigo,
        "email": auth.user.email,
        "role": app_metadata.get("role", ""),
    }


def _login_segundos_bloqueo(ip: str, ahora: float | None = None) -> int:
    ahora = time.monotonic() if ahora is None else ahora
    with _login_lock:
        for clave, intentos in list(_login_fallos.items()):
            while intentos and ahora - intentos[0] >= LOGIN_VENTANA_SEGUNDOS:
                intentos.popleft()
            if not intentos:
                _login_fallos.pop(clave, None)
        intentos = _login_fallos.get(ip, ())
        if len(intentos) < LOGIN_MAX_INTENTOS:
            return 0
        return max(1, math.ceil(LOGIN_VENTANA_SEGUNDOS - (ahora - intentos[0])))


def _login_registrar_fallo(ip: str, ahora: float | None = None) -> None:
    ahora = time.monotonic() if ahora is None else ahora
    with _login_lock:
        intentos = _login_fallos.setdefault(ip, deque())
        while intentos and ahora - intentos[0] >= LOGIN_VENTANA_SEGUNDOS:
            intentos.popleft()
        intentos.append(ahora)


def _login_limpiar_fallos(ip: str) -> None:
    with _login_lock:
        _login_fallos.pop(ip, None)

# --- PÁGINAS WEB (frontend servido por esta misma API) ---
PUBLIC_DIR = Path(__file__).resolve().parents[2] / "public"
PAGINAS = {
    "PaginaPrincipal.html",
    "riesgo_rutas.html",
}

class ArchivosSinCache(StaticFiles):
    """Los navegadores deben revalidar siempre: así, tras un deploy, nadie se queda con JS o CSS viejos."""

    async def get_response(self, path, scope):
        respuesta = await super().get_response(path, scope)
        respuesta.headers["Cache-Control"] = "no-cache"
        return respuesta


app.mount("/assets", ArchivosSinCache(directory=PUBLIC_DIR / "assets"), name="assets")


@app.get("/", include_in_schema=False)
def pagina_inicio():
    return FileResponse(PUBLIC_DIR / "pages" / "PaginaPrincipal.html", headers={"Cache-Control": "no-cache"})


@app.get("/{pagina}", include_in_schema=False)
def pagina_html(pagina: str):
    if pagina not in PAGINAS:
        raise HTTPException(status_code=404, detail="Not Found")
    return FileResponse(PUBLIC_DIR / "pages" / pagina, headers={"Cache-Control": "no-cache"})
