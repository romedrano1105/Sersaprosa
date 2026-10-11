from fastapi import FastAPI
import database
import motor_rutas
from eventos_router import router as eventos_router

app = FastAPI()
app.include_router(eventos_router)  # /eventos/listar · /eventos/revisar · /eventos/registrar (FCJ1-15)

@app.post("/generar-ruta")
def endpoint_generar_ruta(req: dict):
    # 1. Leer Supabase
    riesgos = database.obtener_riesgos()
    
    # 2. Calcular ruta
    ruta_final = motor_rutas.calcular_ruta_segura(req['origen'], req['destino'], riesgos)
    
    # 3. Guardar historial
    database.guardar_ruta({"ruta": ruta_final})
    
    # 4. Responder a la web
    return {"status": "success", "ruta": ruta_final}