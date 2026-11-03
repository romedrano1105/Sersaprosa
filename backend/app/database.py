import json
import os
import re
from threading import Lock

import jwt
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientConnectionError, PyJWKClientError
from supabase import create_client

# En local se pueden poner las claves en un archivo .env (ver .env.example). En Render se configuran en
# «Environment». python-dotenv es opcional: si no está instalado, se usan solo las variables del sistema.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


def normalizar_url_supabase(valor: str) -> str:
    """La API vive en https://<ref>.supabase.co. Si pegaron la URL del panel
    (https://supabase.com/dashboard/project/<ref>/...) se deduce la correcta del <ref>."""
    valor = (valor or "").strip().strip("\"'").rstrip("/")
    m = re.search(r"supabase\.com/dashboard/project/([a-z0-9]{15,25})", valor)
    return f"https://{m.group(1)}.supabase.co" if m else valor


SUPABASE_URL = normalizar_url_supabase(os.getenv("SUPABASE_URL") or "https://kdaoiepfwtaonvhmhipa.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_ANON_KEY") or os.getenv("SUPABASE_KEY")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
_jwks_client = PyJWKClient(
    f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json",
    cache_keys=True,
    lifespan=300,
    timeout=5,
)
_service_client = None
_service_client_lock = Lock()

if not SUPABASE_KEY:
    raise RuntimeError("Falta configurar la variable de entorno SUPABASE_ANON_KEY.")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)


def cliente_autenticado(token: str):
    # No se comparte este cliente: su Authorization header contiene el JWT del usuario.
    cliente = create_client(SUPABASE_URL, SUPABASE_KEY)
    cliente.postgrest.auth(token)
    return cliente


def consultar_todas_las_filas(consulta, tamano: int = 1000) -> list[dict]:
    """Lee resultados PostgREST por páginas, evitando el límite predeterminado de 1000 filas."""
    filas = []
    inicio = 0
    while True:
        pagina = consulta.range(inicio, inicio + tamano - 1).execute().data or []
        filas.extend(pagina)
        if len(pagina) < tamano:
            return filas
        inicio += tamano


class TokenInvalido(ValueError):
    pass


class VerificacionTokenNoDisponible(RuntimeError):
    pass


def verificar_token(token: str) -> dict:
    if not isinstance(token, str) or not token.strip():
        raise TokenInvalido("Token vacío.")
    try:
        clave = _jwks_client.get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            clave.key,
            algorithms=["ES256"],
            audience="authenticated",
            issuer=f"{SUPABASE_URL}/auth/v1",
            options={"require": ["exp", "sub"]},
        )
    except PyJWKClientConnectionError as error:
        raise VerificacionTokenNoDisponible("No se pudo consultar JWKS de Supabase.") from error
    except (jwt.PyJWTError, PyJWKClientError) as error:
        raise TokenInvalido("El JWT no es válido.") from error


def obtener_riesgos():
    return supabase.table("riesgos").select("*").execute().data


def guardar_ruta(datos):
    return supabase.table("historial_rutas").insert(datos).execute()


class AuthConfigurationError(RuntimeError):
    pass


def buscar_empleado_por_codigo(codigo: str):
    if not SUPABASE_SERVICE_ROLE_KEY:
        raise AuthConfigurationError(
            "Falta configurar SUPABASE_SERVICE_ROLE_KEY para resolver el código de empleado."
        )

    resultado = (
        cliente_servicio().table("empleados")
        .select("codigo, nombre, email")
        .eq("codigo", codigo)
        .eq("activo", True)
        .limit(1)
        .execute()
    )
    empleados = _filas(resultado.data)
    return _como_diccionario(empleados[0]) if empleados else None


def _filas(datos) -> list:
    """Lista de filas a partir de lo que devuelva la librería: lista, una fila suelta o JSON en texto."""
    if isinstance(datos, (bytes, bytearray)):
        datos = datos.decode("utf-8", errors="replace")
    if isinstance(datos, str):
        try:
            datos = json.loads(datos)
        except ValueError:
            pista = " La SUPABASE_URL parece apuntar a una página web: debe ser https://<id-del-proyecto>.supabase.co." \
                if datos.lstrip().lower().startswith(("<!doctype", "<html")) else ""
            raise TypeError(f"Supabase respondió texto que no es JSON: «{datos[:80]}».{pista}") from None
    if not datos:
        return []
    return [datos] if isinstance(datos, dict) else list(datos)


def _como_diccionario(fila):
    """Normaliza la fila a dict: según la versión de la librería puede llegar como modelo o mapeo."""
    if isinstance(fila, dict):
        return fila
    if hasattr(fila, "model_dump"):
        return fila.model_dump()
    if hasattr(fila, "keys"):
        return dict(fila)
    raise TypeError(f"Supabase devolvió una fila de tipo {type(fila).__name__}, no un diccionario.")


def cliente_servicio():
    """Cliente con clave de servicio para operaciones administrativas del backend."""
    global _service_client
    if not SUPABASE_SERVICE_ROLE_KEY:
        raise AuthConfigurationError("Falta configurar SUPABASE_SERVICE_ROLE_KEY.")
    if _service_client is None:
        with _service_client_lock:
            if _service_client is None:
                _service_client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    return _service_client


# --- Diagnóstico de la conexión (GET /salud). Nunca devuelve claves ni datos de las tablas. ---
TABLAS_REQUERIDAS = {
    "empleados": "codigo,email",
    "entregas": "id,direccion,lat,lng",
    "rutas_planificadas": "id,nombre,fecha",
    "alertas_seguridad": "id,lat,lng",
    "eventos_especiales": "id,lat,lng",
}


def clasificar_error(error: BaseException) -> str:
    texto = f"{getattr(error, 'code', '')} {error}".lower()
    if any(c in texto for c in ("pgrst204", "42703", "column")):
        return "falta una columna (aplica los scripts de backend/database)"
    if any(c in texto for c in ("pgrst205", "42p01", "does not exist", "could not find the table")):
        return "falta la tabla"
    if any(c in texto for c in ("401", "403", "jwt", "permission", "apikey", "invalid api key")):
        return "clave inválida o sin permiso"
    return f"sin conexión ({type(error).__name__})"


def diagnostico(fabrica_cliente=None) -> dict:
    """Variables configuradas (sí/no), formato de la URL y si cada tabla responde."""
    url_ok = bool(re.fullmatch(r"https://[a-z0-9]{15,25}\.supabase\.co", SUPABASE_URL or ""))
    resultado = {
        "variables": {
            "SUPABASE_URL": bool(os.getenv("SUPABASE_URL")),
            "SUPABASE_ANON_KEY": bool(os.getenv("SUPABASE_ANON_KEY") or os.getenv("SUPABASE_KEY")),
            "SUPABASE_SERVICE_ROLE_KEY": bool(SUPABASE_SERVICE_ROLE_KEY),
        },
        "url_valida": url_ok,
        "tablas": {},
    }
    try:
        cliente = (fabrica_cliente or cliente_servicio)()
    except Exception as error:  # noqa: BLE001
        resultado["tablas"] = {t: "sin clave de servicio" for t in TABLAS_REQUERIDAS}
        resultado["ok"] = False
        resultado["error"] = str(error)[:120]
        return resultado
    for tabla, columnas in TABLAS_REQUERIDAS.items():
        try:
            cliente.table(tabla).select(columnas).limit(1).execute()
            resultado["tablas"][tabla] = "ok"
        except Exception as error:  # noqa: BLE001
            resultado["tablas"][tabla] = clasificar_error(error)
    resultado["ok"] = url_ok and all(resultado["variables"].values()) and all(v == "ok" for v in resultado["tablas"].values())
    return resultado
