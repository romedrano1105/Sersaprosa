import osmnx as ox
import networkx as nx

# Cargas el mapa una sola vez aquí
G_base = ox.graph_from_place("Santa Tecla, El Salvador", network_type='drive')

def calcular_ruta_segura(origen, destino, zonas_riesgo):
    # Aquí va toda la lógica de los nodos, los pesos y el factor aleatorio
    # y retornas las coordenadas finales
    pass