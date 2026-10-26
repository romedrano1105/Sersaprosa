"""Reglas puras del viaje (sin FastAPI ni Supabase, se prueban solas).

Historia: el administrador de rutas ingresa origen, destino, horario y tipo de carga (+ monto) y el
sistema genera la ruta del día. Si falta un campo o el horario está fuera del horario de entregas,
no se genera. La edición solo se permite mientras la ruta no haya salido (no tenga asignación).
"""
import os
import re
from datetime import time
from decimal import Decimal, InvalidOperation

HORA_INICIO_ENTREGAS = os.getenv("ENTREGAS_HORA_INICIO", "06:00")   # a confirmar con operaciones
HORA_FIN_ENTREGAS = os.getenv("ENTREGAS_HORA_FIN", "20:00")
MONTO_MAXIMO = Decimal("1000000000000")
TIPO_MAXIMO = 32767  # tipo_carga_id es smallint
NOMBRE_MAX = 80

ETIQUETAS = {"origen": "Origen", "destino": "Destino", "horario": "Horario", "tipo_carga_id": "Tipo de carga", "monto": "Monto"}


def _hora(texto: str) -> time | None:
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", str(texto or "").strip())
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        return None
    return time(int(m.group(1)), int(m.group(2)))


def validar_viaje(datos) -> tuple[dict, dict]:
    """Devuelve (datos limpios, errores por campo). Los errores de campos vacíos usan el mismo texto que el front."""
    datos = datos if isinstance(datos, dict) else {}
    limpio, errores = {}, {}

    for campo in ("origen", "destino"):
        valor = " ".join(str(datos.get(campo) or "").split())
        if not valor:
            errores[campo] = f"{ETIQUETAS[campo]} es obligatorio."
        elif len(valor) < 3 or len(valor) > 200:
            errores[campo] = f"{ETIQUETAS[campo]} debe tener entre 3 y 200 caracteres."
        else:
            limpio[campo] = valor
    if "origen" in limpio and "destino" in limpio and limpio["origen"].lower() == limpio["destino"].lower():
        errores["destino"] = "El destino debe ser distinto del origen."

    bruto = str(datos.get("horario") or "").strip()
    if not bruto:
        errores["horario"] = "Horario es obligatorio."
    else:
        h = _hora(bruto)
        if h is None:
            errores["horario"] = "El horario debe tener formato HH:MM."
        elif not _hora(HORA_INICIO_ENTREGAS) <= h <= _hora(HORA_FIN_ENTREGAS):
            errores["horario"] = f"No se realizan entregas a esa hora: el horario permitido es de {HORA_INICIO_ENTREGAS} a {HORA_FIN_ENTREGAS}."
        else:
            limpio["horario"] = f"{h.hour:02d}:{h.minute:02d}"

    bruto = datos.get("tipo_carga_id")
    if bruto is None or str(bruto).strip() == "":
        errores["tipo_carga_id"] = "Tipo de carga es obligatorio."
    else:
        try:
            if isinstance(bruto, bool):
                raise ValueError
            tipo = int(str(bruto).strip())
            if not 0 < tipo <= TIPO_MAXIMO:
                raise ValueError
            limpio["tipo_carga_id"] = tipo
        except ValueError:
            errores["tipo_carga_id"] = "El tipo de carga no es válido."

    bruto = datos.get("monto")
    if bruto is None or str(bruto).strip() == "":
        errores["monto"] = "Monto es obligatorio."
    elif isinstance(bruto, bool):
        errores["monto"] = "El monto debe ser numérico."
    else:
        try:
            monto = Decimal(str(bruto).strip())
            if not monto.is_finite():
                raise InvalidOperation
        except (InvalidOperation, ValueError):
            errores["monto"] = "El monto debe ser numérico."
        else:
            if monto <= 0:
                errores["monto"] = "El monto debe ser mayor a cero."
            elif monto >= MONTO_MAXIMO:
                errores["monto"] = "El monto es demasiado grande."
            elif monto.normalize().as_tuple().exponent < -2:
                errores["monto"] = "El monto admite como máximo 2 decimales."
            else:
                limpio["monto"] = str(monto)
    return limpio, errores


def mensaje_de_errores(errores: dict) -> str:
    """Texto para el usuario: qué campos faltan o están mal."""
    faltan = [ETIQUETAS[c] for c, m in errores.items() if m.endswith("es obligatorio.")]
    otros = [m for c, m in errores.items() if not m.endswith("es obligatorio.")]
    partes = []
    if faltan:
        partes.append("Faltan campos obligatorios: " + ", ".join(faltan) + ".")
    return " ".join(partes + otros)


def nombre_de_viaje(destino: str, horario: str, existentes: list[str]) -> str:
    """Nombre único del día (los pedidos se enlazan a la ruta por nombre): «09:30 · Destino»."""
    base = f"{horario} · {destino}"[:NOMBRE_MAX]
    nombre, n = base, 1
    usados = {e.lower() for e in existentes}
    while nombre.lower() in usados:
        n += 1
        sufijo = f" #{n}"
        nombre = base[: NOMBRE_MAX - len(sufijo)] + sufijo
    return nombre


def ruta_ya_salio(fila_ruta: dict, hay_asignacion: bool) -> bool:
    """Una ruta «sale» cuando se le asigna conductor y vehículo; desde ahí ya no se edita."""
    return hay_asignacion or bool((fila_ruta or {}).get("conductor"))


# Tipos de carga de arranque (los mismos de riesgo_rutas.sql): (nombre, sensibilidad 0..2).
TIPOS_CARGA_BASE = (
    ("Efectivo / valores", 2), ("Joyería y metales preciosos", 2), ("Medicamentos", 1),
    ("Electrónicos", 1), ("Documentos", 0), ("Mercancía general", 0),
)


def nivel_de_riesgo(monto, sensibilidad: int) -> str:
    """Mismo cálculo que calcular_nivel_riesgo() de riesgo_rutas.sql (umbrales provisionales)."""
    monto = Decimal(str(monto))
    por_monto = 0 if monto < 10000 else 1 if monto < 100000 else 2
    puntaje = por_monto + int(sensibilidad)
    return "Bajo" if puntaje <= 1 else "Medio" if puntaje == 2 else "Alto"
