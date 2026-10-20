/* =====================================================================
   NÚCLEO: sesión y llamadas al backend — window.Api

   Un solo lugar para leer la sesión (sessionStorage["session"]) y hacer POST con el
   token. Los módulos nuevos deben usar Api.post en vez de escribir su propio fetch.

     Api.session()              → { token, name, code, role, apiBase } o null
     Api.post(ruta, cuerpo)     → JSON de la respuesta; lanza Error con el mensaje del servidor

   401 = sesión vencida: cierra la sesión (AppNavigation.handleUnauthorized) y lanza Error.
   Los errores de FastAPI llegan como { detail } (texto u objeto con { message }).
   ===================================================================== */
(function (global) {
  "use strict";

  const SESSION_KEY = "session";

  function session() {
    try {
      const value = JSON.parse(global.sessionStorage.getItem(SESSION_KEY) || "null");
      return value && typeof value.token === "string" && value.token ? value : null;
    } catch (error) {
      return null;
    }
  }

  async function post(path, payload) {
    const current = session();
    if (!current) {
      if (global.AppNavigation) global.AppNavigation.handleUnauthorized();
      throw new Error("La sesión venció. Inicia sesión de nuevo.");
    }
    const base = (current.apiBase || global.location.origin).replace(/\/$/, "");
    const response = await global.fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + current.token },
      body: JSON.stringify(payload)
    });
    let result = {};
    try {
      result = await response.json();
    } catch (error) {
      result = {};
    }
    if (response.status === 401) {
      if (global.AppNavigation) global.AppNavigation.handleUnauthorized();
      throw new Error("La sesión venció. Inicia sesión de nuevo.");
    }
    if (!response.ok) {
      const detail = result.detail;
      const message = detail && typeof detail === "object" ? detail.message : detail;
      throw new Error(message || "Error al consultar el servidor (" + response.status + ").");
    }
    return result;
  }

  global.Api = { session, post };
})(window);
