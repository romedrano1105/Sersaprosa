"""Reglas puras de la gestión de empleados (se prueban sin Supabase ni FastAPI).

Las mismas validaciones viven en guardar_empleado_operativo() (empleados_gestion.sql); aquí se repiten para
responder rápido y por campo antes de llamar a la base de datos.
"""
import re
from datetime import date

CATEGORIAS = ("conductor", "guardia")
PATRON_CODIGO = re.compile(r"^[A-Z0-9][A-Z0-9_-]{1,39}$")


def _a_fecha(valor) -> date | None:
    if valor in (None, ""):
        return None
    if isinstance(valor, date):
        return valor
    try:
        return date.fromisoformat(str(valor)[:10])
    except ValueError:
        return None


def validar(datos: dict) -> tuple[dict, dict]:
    """Limpia los datos del formulario. Devuelve (limpio, errores_por_campo)."""
    d = datos or {}
    errores = {}
    nombre = " ".join(str(d.get("nombre") or "").split())
    if not 3 <= len(nombre) <= 120:
        errores["nombre"] = "El nombre debe tener entre 3 y 120 caracteres."
    categoria = str(d.get("categoria") or "").strip().lower()
    if categoria not in CATEGORIAS:
        errores["categoria"] = "La categoría debe ser conductor o guardia."
    licencia = _a_fecha(d.get("licencia"))
    if d.get("licencia") not in (None, "") and licencia is None:
        errores["licencia"] = "La fecha de licencia no es válida."
    elif categoria == "conductor" and licencia is None:
        errores["licencia"] = "Un conductor necesita la fecha de vencimiento de su licencia."
    codigo = str(d.get("codigo") or "").strip().upper() or None
    if codigo and not PATRON_CODIGO.match(codigo):
        errores["codigo"] = "El código solo admite letras, números, guiones y guiones bajos."
    limpio = {
        "codigo": codigo,
        "nombre": nombre,
        "categoria": categoria,
        "licencia": licencia.isoformat() if (licencia and categoria == "conductor") else None,
        "activo": bool(d.get("activo", True)),
    }
    return limpio, errores


def estado_de(empleado: dict, hoy: date | None = None) -> str:
    """inactivo · asignado · licencia_vencida · sin_licencia · disponible."""
    hoy = hoy or date.today()
    if not empleado.get("activo", True):
        return "inactivo"
    if empleado.get("asignacion"):
        return "asignado"
    if (empleado.get("categoria") or "conductor") == "conductor":
        licencia = _a_fecha(empleado.get("licencia"))
        if licencia is None:
            return "sin_licencia"
        if licencia < hoy:
            return "licencia_vencida"
    return "disponible"


def con_estado(fila: dict, hoy: date | None = None) -> dict:
    empleado = dict(fila or {})
    empleado["categoria"] = empleado.get("categoria") or "conductor"
    empleado["estado"] = estado_de(empleado, hoy)
    return empleado


def resumen(empleados: list[dict]) -> dict:
    activos = [e for e in empleados or [] if e.get("activo", True)]
    return {
        "total": len(empleados or []),
        "conductores": sum(1 for e in activos if e.get("categoria") == "conductor"),
        "guardias": sum(1 for e in activos if e.get("categoria") == "guardia"),
        "disponibles": sum(1 for e in activos if e.get("estado") == "disponible"),
        "asignados": sum(1 for e in activos if e.get("estado") == "asignado"),
        "inactivos": sum(1 for e in empleados or [] if not e.get("activo", True)),
    }
