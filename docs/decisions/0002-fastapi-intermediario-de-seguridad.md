# ADR 0002: Uso del backend FastAPI como intermediario de seguridad y lógica hacia Supabase

- Estado: Aceptada
- Fecha: 2026-10-20

## Contexto
Al integrar Supabase para persistencia y autenticación, el navegador no debe tener acceso directo a credenciales con privilegios elevados (`service_role`), ya que violaría el principio de mínimo privilegio. Asimismo, el sistema requiere validar reglas de negocio complejas antes de alterar los registros en la base de datos.

## Decisión
Canalizamos todas las operaciones críticas de lectura y escritura a través de endpoints en FastAPI, manteniendo las credenciales sensibles resguardadas únicamente en el servidor. Descartamos la conexión directa del cliente web a Supabase mediante su SDK de JavaScript y políticas RLS exclusivas.

En la implementación actual:
- FastAPI valida el token de Supabase Auth y exige `app_metadata.role = coordinador_rutas` antes de operar.
- Las escrituras críticas se delegan a funciones SQL `security definer` (`asignar_ruta_operativa`, `guardar_ruta_operativa`, `actualizar_ruta_operativa`, `desasignar_ruta_operativa`) que revalidan el rol en PostgreSQL; RLS queda activa como segunda barrera, no como único control.
- La clave `service_role` solo la usa el backend (login por código de empleado y el respaldo descrito en el ADR 0003).

## Alternativas consideradas
- SDK de Supabase en el navegador con RLS exclusivas: menos código de backend, pero toda la seguridad depende de políticas bien configuradas y las reglas de negocio quedarían en el cliente.

## Consecuencias
* **Positivas:**
  * Protege las llaves privadas del sistema y evita la exposición de credenciales elevadas en el cliente web.
  * Centraliza la validación de reglas de negocio complejas y la sanitización de entradas en un único punto antes de persistir los datos.
  * Reduce la superficie de ataque y el riesgo de brechas de seguridad por configuraciones erróneas en políticas de cliente.
* **Negativas:**
  * Obliga a implementar endpoints CRUD manuales en FastAPI para operaciones que el cliente web habría resuelto de forma directa y automática con Supabase.
  * Incrementa el tiempo de desarrollo por cada nueva entidad o funcionalidad requerida en los sprints.
  * Convierte al backend en un potencial cuello de botella de rendimiento y punto único de fallo para el frontend.
  * Cada cambio de reglas puede exigir también aplicar SQL en Supabase además de desplegar código.
