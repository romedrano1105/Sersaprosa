from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import database
import motor_rutas
from eventos_router import router as eventos_router

app = FastAPI()

# Permite que el navegador haga peticiones desde PaginaPrincipal.html sin bloqueos de CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(eventos_router)  # /eventos/listar · /eventos/revisar · /eventos/registrar (FCJ1-15)

# --- ENDPOINT DE VERIFICACIÓN Y AUTENTICACIÓN ---
@app.post("/login")
def login(credenciales: dict):
    codigo = credenciales.get("code")
    password = credenciales.get("password")
    
    empleado = database.validar_credenciales(codigo, password)
    
    if not empleado:
        raise HTTPException(status_code=401, detail="Código o contraseña incorrectos")
    
    return {
        "status": "success",
        "token": f"token-{empleado['codigo']}",
        "name": empleado['nombre']
    }

# --- GENERADOR DE RUTA EXISTENTE ---
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
