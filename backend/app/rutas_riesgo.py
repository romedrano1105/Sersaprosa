"""Monto, tipo de carga y nivel de riesgo de las rutas."""
from decimal import Decimal, InvalidOperation

import httpx
from fastapi import APIRouter, Header, HTTPException

router = APIRouter(prefix="/rutas-riesgo", tags=["riesgo de rutas"])

MONTO_MAXIMO = Decimal("1000000000000")  # numeric(14,2)


def _error(status: int, mensaje: str, errores: dict | None = None):
    return HTTPException(status, detail={"mensaje": mensaje, "errores": errores or {}})


def validar_entrada(datos) -> tuple[Decimal | None, int | None, dict]:
    """Devuelve (monto, tipo_carga_id, errores). Nunca asigna valores por defecto."""
    errores: dict[str, str] = {}
    monto = None
    tipo = None

    if not isinstance(datos, dict):
        return None, None, {"monto": "El monto es obligatorio.",
                            "tipo_carga_id": "El tipo de carga es obligatorio."}

    bruto = datos.get("monto")
    if bruto is None or (isinstance(bruto, str) and not bruto.strip()):
        errores["monto"] = "El monto es obligatorio."
    elif isinstance(bruto, bool):
        errores["monto"] = "El monto debe ser numérico."
    else:
        try:
            monto = Decimal(str(bruto).strip())
            if not monto.is_finite():
                raise InvalidOperation
        except InvalidOperation:
            monto = None
            errores["monto"] = "El monto debe ser numérico."
        else:
            if monto <= 0:
                monto = None
                errores["monto"] = "El monto debe ser mayor a cero."
            elif monto >= MONTO_MAXIMO:
                monto = None
                errores["monto"] = "El monto es demasiado grande."

    bruto_tipo = datos.get("tipo_carga_id")
    if bruto_tipo is None or (isinstance(bruto_tipo, str) and not bruto_tipo.strip()):
        errores["tipo_carga_id"] = "El tipo de carga es obligatorio."
    else:
        try:
            if isinstance(bruto_tipo, bool):
                raise ValueError
            tipo = int(str(bruto_tipo).strip())
        except ValueError:
            errores["tipo_carga_id"] = "El tipo de carga no es válido."

    return monto, tipo, errores


def _token(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise _error(401, "Debes iniciar sesión.")
    return authorization.split(" ", 1)[1].strip()


async def _rpc(nombre: str, token: str, payload: dict):
    from . import database  # import diferido: los tests de validación no necesitan Supabase

    url = f"{database.SUPABASE_URL.rstrip('/')}/rest/v1/rpc/{nombre}"
    headers = {
        "apikey": database.SUPABASE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=10) as cliente:
            r = await cliente.post(url, json=payload, headers=headers)
    except httpx.HTTPError:
        raise _error(502, "No se pudo conectar con la base de datos.")

    if r.is_success:
        return r.json()

    try:
        mensaje = r.json().get("message", "")
    except ValueError:
        mensaje = ""

    if r.status_code in (401, 403) or mensaje == "no_autorizado":
        raise _error(403, "Solo el administrador de rutas puede realizar esta acción.")
    if mensaje == "monto_invalido":
        raise _error(422, "Datos inválidos.", {"monto": "El monto debe ser mayor a cero."})
    if mensaje == "tipo_invalido":
        raise _error(422, "Datos inválidos.", {"tipo_carga_id": "El tipo de carga no es válido."})
    if mensaje == "ruta_no_encontrada":
        raise _error(404, "La ruta no existe.")
    raise _error(502, "No se pudo completar la operación.")


@router.get("/tipos-carga")
async def tipos_carga(authorization: str | None = Header(None)):
    return await _rpc("listar_tipos_carga", _token(authorization), {})


@router.post("/calcular")
async def calcular(datos: dict, authorization: str | None = Header(None)):
    token = _token(authorization)
    monto, tipo, errores = validar_entrada(datos)
    if errores:
        raise _error(422, "Revisa los campos marcados.", errores)
    nivel = await _rpc(
        "calcular_nivel_riesgo", token,
        {"p_monto": str(monto), "p_tipo_carga_id": tipo},
    )
    return {"nivel_riesgo": nivel}


@router.put("/{ruta_id}")
async def especificar(ruta_id: int, datos: dict, authorization: str | None = Header(None)):
    token = _token(authorization)
    monto, tipo, errores = validar_entrada(datos)
    if errores:  # No se guarda nada y no se asigna riesgo por defecto
        raise _error(422, "Revisa los campos marcados.", errores)
    return await _rpc(
        "especificar_riesgo_ruta", token,
        {"p_ruta_id": ruta_id, "p_monto": str(monto), "p_tipo_carga_id": tipo},
    )


@router.get("")
async def listar(authorization: str | None = Header(None)):
    return await _rpc("listar_rutas_riesgo", _token(authorization), {})


@router.get("/{ruta_id}")
async def detalle(ruta_id: int, authorization: str | None = Header(None)):
    filas = await _rpc("listar_rutas_riesgo", _token(authorization), {"p_ruta_id": ruta_id})
    if not filas:
        raise _error(404, "La ruta no existe.")
    return filas[0]