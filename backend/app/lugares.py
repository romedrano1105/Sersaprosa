"""Sugerencias de lugares al escribir origen o destino (lógica pura, sin red ni base de datos).

Se combinan dos fuentes: lugares ya usados en el sistema (rutas y entregas), que salen primero y al
instante, y los del mapa (OpenRouteService / Nominatim). Aquí solo se filtran, ordenan y deduplican.
"""
import unicodedata

MAX_SUGERENCIAS = 8
MIN_CARACTERES = 2


def normalizar(texto) -> str:
    """Minúsculas, sin tildes y sin espacios repetidos: «  Metrocéntro » → «metrocentro»."""
    s = unicodedata.normalize("NFD", str(texto or ""))
    return " ".join("".join(c for c in s if unicodedata.category(c) != "Mn").lower().split())


def _rango(consulta: str, texto: str):
    """0 = el texto empieza con lo escrito; 1 = alguna palabra empieza con ello; None = no coincide."""
    if texto.startswith(consulta):
        return 0
    return 1 if any(p.startswith(consulta) for p in texto.split()) else None


def filtrar(consulta: str, candidatos: list[dict], limite: int = MAX_SUGERENCIAS) -> list[dict]:
    """Candidatos {texto, lat, lng, fuente} que empiezan con lo escrito, primero los que empiezan igual
    que todo el texto, luego los que tienen una palabra que empieza así. Sin repetidos."""
    q = normalizar(consulta)
    if len(q) < MIN_CARACTERES:
        return []
    vistos, hallados = set(), []
    for c in candidatos:
        t = normalizar(c.get("texto"))
        r = _rango(q, t) if t else None
        if r is None or t in vistos:
            continue
        vistos.add(t)
        hallados.append((r, t, c))
    hallados.sort(key=lambda x: (x[0], len(x[1]), x[1]))
    return [c for _, _, c in hallados[:limite]]


def combinar(consulta: str, locales: list[dict], externos: list[dict], limite: int = MAX_SUGERENCIAS) -> list[dict]:
    """Primero los lugares del sistema que coinciden; luego los del mapa sin repetir ninguno."""
    propios = filtrar(consulta, locales, limite)
    vistos = {normalizar(c["texto"]) for c in propios}
    resto = [e for e in externos if normalizar(e.get("texto")) not in vistos and e.get("texto")]
    return (propios + resto)[:limite]


def candidatos_de_filas(rutas: list[dict], entregas: list[dict]) -> list[dict]:
    """Lugares conocidos a partir de rutas guardadas (origen/destino) y entregas (dirección y cliente)."""
    salida = []
    for r in rutas or []:
        for campo in ("origen", "destino"):
            if r.get(f"{campo}_texto"):
                salida.append({"texto": r[f"{campo}_texto"], "lat": r.get(f"{campo}_lat"), "lng": r.get(f"{campo}_lng"), "fuente": "ruta"})
    for e in entregas or []:
        for campo in ("direccion", "cliente"):
            if e.get(campo):
                salida.append({"texto": str(e[campo]), "lat": e.get("lat"), "lng": e.get("lng"), "fuente": "pedido"})
    return salida
