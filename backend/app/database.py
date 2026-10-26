import json
import os
import re

from supabase import create_client

def normalizar_url_supabase(valor: str) -> str:
    """La API vive en https://<ref>.supabase.co. Si pegaron la URL del panel
    (https://supabase.com/dashboard/project/<ref>/...) se deduce la correcta del <ref>."""
    valor = (valor or "").strip().strip("\"'").rstrip("/")
    m = re.search(r"supabase\.com/dashboard/project/([a-z0-9]{15,25})", valor)
    return f"https://{m.group(1)}.supabase.co" if m else valor


SUPABASE_URL = normalizar_url_supabase(os.getenv("SUPABASE_URL") or "https://kdaoiepfwtaonvhmhipa.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_ANON_KEY") or os.getenv("SUPABASE_KEY")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_KEY:
    raise RuntimeError("Falta configurar la variable de entorno SUPABASE_ANON_KEY.")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)


def cliente_autenticado(token: str):
    cliente = create_client(SUPABASE_URL, SUPABASE_KEY)
    cliente.postgrest.auth(token)
    return cliente


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

    cliente_admin = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    resultado = (
        cliente_admin.table("empleados")
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
    """Cliente con la clave de servicio, solo para el respaldo de escritura del backend."""
    if not SUPABASE_SERVICE_ROLE_KEY:
        raise AuthConfigurationError("Falta configurar SUPABASE_SERVICE_ROLE_KEY.")
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
