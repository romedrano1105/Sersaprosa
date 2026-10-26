import os

from supabase import create_client

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://kdaoiepfwtaonvhmhipa.supabase.co").rstrip("/")
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
    empleados = resultado.data or []
    return _como_diccionario(empleados[0]) if empleados else None


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
