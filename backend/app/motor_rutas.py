_G_base = None


def obtener_grafo():
    """Descarga el mapa solo la primera vez que se necesita."""
    global _G_base
    if _G_base is None:
        import osmnx as ox

        _G_base = ox.graph_from_place("Santa Tecla, El Salvador", network_type="drive")
    return _G_base


def calcular_ruta_segura(origen, destino, zonas_riesgo):
    G_base = obtener_grafo()
    # Aquí va toda la lógica de los nodos, los pesos y el factor aleatorio
    # y retornas las coordenadas finales
    pass
