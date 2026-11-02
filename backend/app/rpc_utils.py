FUNCION_AUSENTE = {"PGRST202", "42883"}


def funcion_ausente(error) -> bool:
    return str(getattr(error, "code", "") or "") in FUNCION_AUSENTE
