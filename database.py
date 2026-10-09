from supabase import create_client

supabase = create_client("", "")

def obtener_riesgos():
    return supabase.table('riesgos').select("*").execute().data

def guardar_ruta(datos):
    return supabase.table('historial_rutas').insert(datos).execute()

