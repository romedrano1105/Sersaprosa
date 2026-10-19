"""Monto, tipo de carga y nivel de riesgo de las rutas."""

from decimal import Decimal, InvalidOperation

import httpx
from fastapi import APIRouter, Header, HTTPException

router = APIRouter(prefix="/rutas-riesgo", tags=["riesgo de rutas"])

MONTO_MAXIMO = Decimal("1000000000000")
TIPO_MAXIMO = 32767  # la columna tipo_carga_id es smallint
RUTA_ID_MAXIMO = 100


def _error(
    status: int,
    mensaje: str,
    errores: dict | None = None,
):
    return HTTPException(
        status_code=status,
        detail={
            "mensaje": mensaje,
            "errores": errores or {},
        },
    )


def validar_entrada(datos) -> tuple[Decimal | None, int | None, dict]:
    errores: dict[str, str] = {}
    monto = None
    tipo = None

    if not isinstance(datos, dict):
        return None, None, {
            "monto": "El monto es obligatorio.",
            "tipo_carga_id": "El tipo de carga es obligatorio.",
        }

    bruto = datos.get("monto")

    if bruto is None or (
        isinstance(bruto, str) and not bruto.strip()
    ):
        errores["monto"] = "El monto es obligatorio."
    elif isinstance(bruto, bool):
        errores["monto"] = "El monto debe ser numérico."
    else:
        try:
            monto = Decimal(str(bruto).strip())
            if not monto.is_finite():
                raise InvalidOperation
        except (InvalidOperation, ValueError):
            monto = None
            errores["monto"] = "El monto debe ser numérico."
        else:
            if monto <= 0:
                monto = None
                errores["monto"] = "El monto debe ser mayor a cero."
            elif monto.normalize().as_tuple().exponent < -2:
                # La columna es numeric(14,2): evita redondeos silenciosos
                # (p. ej. 0.001 pasaría la validación y fallaría en la BD).
                monto = None
                errores["monto"] = "El monto admite máximo 2 decimales."
            elif monto >= MONTO_MAXIMO:
                monto = None
                errores["monto"] = "El monto es demasiado grande."

    bruto_tipo = datos.get("tipo_carga_id")

    if bruto_tipo is None or (
        isinstance(bruto_tipo, str) and not bruto_tipo.strip()
    ):
        errores["tipo_carga_id"] = "El tipo de carga es obligatorio."
    else:
        try:
            if isinstance(bruto_tipo, bool):
                raise ValueError

            tipo = int(str(bruto_tipo).strip())

            if tipo <= 0 or tipo > TIPO_MAXIMO:
                raise ValueError

        except (ValueError, TypeError):
            tipo = None
            errores["tipo_carga_id"] = "El tipo de carga no es válido."

    return monto, tipo, errores


def _validar_ruta_id(ruta_id: str) -> str:
    ruta_id = ruta_id.strip()

    if not ruta_id or len(ruta_id) > RUTA_ID_MAXIMO:
        raise _error(
            422,
            "El identificador de la ruta no es válido.",
        )

    return ruta_id


def _token(authorization: str | None) -> str:
    if not authorization:
        raise _error(401, "Debes iniciar sesión.")

    esquema, separador, credencial = authorization.partition(" ")

    if (
        esquema.lower() != "bearer"
        or not separador
        or not credencial.strip()
    ):
        raise _error(401, "Debes iniciar sesión.")

    return credencial.strip()


async def _rpc(nombre: str, token: str, payload: dict):
    from . import database

    url = (
        f"{database.SUPABASE_URL.rstrip('/')}"
        f"/rest/v1/rpc/{nombre}"
    )

    headers = {
        "apikey": database.SUPABASE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=10) as cliente:
            respuesta = await cliente.post(
                url,
                json=payload,
                headers=headers,
            )

    except httpx.HTTPError as error:
        raise _error(
            502,
            "No se pudo conectar con la base de datos.",
        ) from error

    if respuesta.is_success:
        try:
            return respuesta.json()
        except ValueError as error:
            raise _error(
                502,
                "Supabase devolvió una respuesta no válida.",
            ) from error

    try:
        contenido = respuesta.json()
        mensaje = (
            contenido.get("message", "")
            if isinstance(contenido, dict)
            else ""
        )
    except ValueError:
        mensaje = ""

    if respuesta.status_code == 401:
        raise _error(
            401,
            "La sesión venció. Inicia sesión de nuevo.",
        )

    if (
        respuesta.status_code == 403
        or mensaje == "no_autorizado"
    ):
        raise _error(
            403,
            "Solo el coordinador de rutas puede realizar esta acción.",
        )

    if mensaje == "monto_invalido":
        raise _error(
            422,
            "Datos inválidos.",
            {"monto": "El monto debe ser mayor a cero."},
        )

    if mensaje == "tipo_invalido":
        raise _error(
            422,
            "Datos inválidos.",
            {"tipo_carga_id": "El tipo de carga no es válido."},
        )

    if mensaje == "ruta_no_encontrada":
        raise _error(404, "La ruta no existe.")

    raise _error(
        502,
        "No se pudo completar la operación en Supabase.",
    )


@router.get("/tipos-carga")
async def tipos_carga(
    authorization: str | None = Header(None),
):
    return await _rpc(
        "listar_tipos_carga",
        _token(authorization),
        {},
    )


@router.post("/calcular")
async def calcular(
    datos: dict,
    authorization: str | None = Header(None),
):
    token = _token(authorization)
    monto, tipo, errores = validar_entrada(datos)

    if errores:
        raise _error(422, "Revisa los campos marcados.", errores)

    nivel = await _rpc(
        "calcular_nivel_riesgo",
        token,
        {
            "p_monto": str(monto),
            "p_tipo_carga_id": tipo,
        },
    )

    return {"nivel_riesgo": nivel}


@router.put("/{ruta_id}")
async def especificar(
    ruta_id: str,
    datos: dict,
    authorization: str | None = Header(None),
):
    token = _token(authorization)
    ruta_id = _validar_ruta_id(ruta_id)

    monto, tipo, errores = validar_entrada(datos)

    if errores:
        raise _error(422, "Revisa los campos marcados.", errores)

    return await _rpc(
        "especificar_riesgo_ruta",
        token,
        {
            "p_ruta_id": ruta_id,
            "p_monto": str(monto),
            "p_tipo_carga_id": tipo,
        },
    )


@router.get("")
async def listar(
    authorization: str | None = Header(None),
):
    resultado = await _rpc(
        "listar_rutas_riesgo",
        _token(authorization),
        {},
    )

    if not isinstance(resultado, list):
        raise _error(
            502,
            "Supabase devolvió una lista de rutas no válida.",
        )

    return resultado


@router.get("/{ruta_id}")
async def detalle(
    ruta_id: str,
    authorization: str | None = Header(None),
):
    token = _token(authorization)
    ruta_id = _validar_ruta_id(ruta_id)

    filas = await _rpc(
        "listar_rutas_riesgo",
        token,
        {"p_ruta_id": ruta_id},
    )

    if not isinstance(filas, list):
        raise _error(
            502,
            "Supabase devolvió una respuesta no válida.",
        )

    if not filas:
        raise _error(404, "La ruta no existe.")

    return filas[0]
