from supabase import create_client

# 1. Pega aquí tu URL y anon key de Supabase (Project Settings > API)
SUPABASE_URL = "https://kdaoiepfwtaonvhmhipa.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtkYW9pZXBmd3Rhb252aG1oaXBhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyMDUyNzAsImV4cCI6MjEwNjc4MTI3MH0.akL7X9WBM0-Q6ZcQ16UMzqbuZT-1-DiA5DZ6gpOX3LI"

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# Funciones existentes
def obtener_riesgos():
    return supabase.table('riesgos').select("*").execute().data

def guardar_ruta(datos):
    return supabase.table('historial_rutas').insert(datos).execute()

# --- NUEVA FUNCIÓN DE AUTENTICACIÓN ---
def validar_credenciales(codigo: str, password: str):
    res = supabase.table('empleados') \
        .select("codigo, nombre") \
        .eq("codigo", codigo) \
        .eq("password", password) \
        .eq("activo", True) \
        .execute()
    
    if res.data and len(res.data) > 0:
        return res.data[0]
    return None
