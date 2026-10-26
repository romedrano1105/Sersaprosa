import logging
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from postgrest.exceptions import APIError
from pydantic import BaseModel, Field
from supabase import create_client
from supabase_auth.errors import AuthApiError

from . import database, motor_rutas
from .agente_router import router as agente_router
from .alertas_seguridad_router import router as alertas_router
from .disponibilidad_router import router as disponibilidad_router
from .entregas_router import router as entregas_router
from .eventos_router import router as eventos_router
from .geocodificacion_router import router as geocodificacion_router
from .incidentes_router import router as incidentes_router
from .notificaciones_router import router as notificaciones_router
from .rutas_riesgo import router as rutas_riesgo_router
from .rutas_router import router as rutas_router
from .viajes_router import router as viajes_router

logger = logging.getLogger(__name__)

app = FastAPI()

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
app.include_router(rutas_router)  # /rutas/guardar
app.include_router(viajes_router)  # /viajes/generar · /viajes/actualizar
app.include_router(agente_router)  # /agente/ruta-segura (agente de IA, solo coordinador)
app.include_router(incidentes_router)  # /incidentes/listar · /incidentes/registrar
# --- ENDPOINT DE VERIFICACIÓN Y AUTENTICACIÓN ---
class CredencialesEmpleado(BaseModel):
    code: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=256)


@app.exception_handler(Exception)
async def error_inesperado(request, error):
    """Siempre JSON (el front lo lee), con el tipo de error y sin datos sensibles; el detalle va a los logs."""
    logger.exception("Error no controlado en %s", request.url.path)
    return JSONResponse(status_code=500, content={
        "detail": f"Error interno del servidor ({type(error).__name__}). Revise los logs del servicio en Render."})


@app.post("/login")
def login(credenciales: CredencialesEmpleado):
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
    except Exception as error:  # p. ej. clave de Supabase mal pegada: create_client lanza otro tipo de error
        logger.exception("Falló la conexión con Supabase al buscar el empleado.")
        raise HTTPException(
            status_code=503,
            detail=f"No se pudo conectar con Supabase ({type(error).__name__}). Revise SUPABASE_URL y las claves en el servidor.",
        ) from error

    if not empleado:
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

    metadata = auth.user.user_metadata or {}
    app_metadata = auth.user.app_metadata or {}
    return {
        "status": "success",
        "token": auth.session.access_token,
        "name": metadata.get("name") or empleado.get("nombre") or codigo,
        "email": auth.user.email,
        "role": app_metadata.get("role", ""),
    }

# --- GENERADOR DE RUTA EXISTENTE ---
@app.post("/generar-ruta")
def endpoint_generar_ruta(req: dict):
    # 1. Leer Supabase
    riesgos = database.obtener_riesgos()
    
    # 2. Calcular ruta
    ruta_final = motor_rutas.calcular_ruta_segura(req['origen'], req['destino'], riesgos)
    
    # 3. Guardar historial
    database.guardar_ruta({"ruta": ruta_final})
    
    # 4. Responder a la web
    return {"status": "success", "ruta": ruta_final}



# --- PÁGINAS WEB (frontend servido por esta misma API) ---
PUBLIC_DIR = Path(__file__).resolve().parents[2] / "public"
PAGINAS = {
    "PaginaPrincipal.html",
    "riesgo_rutas.html",
}

app.mount("/assets", StaticFiles(directory=PUBLIC_DIR / "assets"), name="assets")


@app.get("/", include_in_schema=False)
def pagina_inicio():
    return FileResponse(PUBLIC_DIR / "pages" / "PaginaPrincipal.html")


@app.get("/{pagina}", include_in_schema=False)
def pagina_html(pagina: str):
    if pagina not in PAGINAS:
        raise HTTPException(status_code=404, detail="Not Found")
    return FileResponse(PUBLIC_DIR / "pages" / pagina)
