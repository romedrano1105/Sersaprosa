/* Alertas de incidentes de viajes en curso para el administrador de rutas (FCJ1-10 / FCJ1-30).
 *
 * Uso (lo hace dashboard.js):
 *   IncidentesViaje.iniciar({ onCount: n => ... })   // arranca la consulta en segundo plano y las notificaciones
 *   IncidentesViaje.mount(contenedor)                // dibuja el panel de alertas activas
 *
 * Tiempo real: el navegador consulta POST /incidentes/listar cada POLL_MS (4 s; el máximo acordado
 * es 10 s). Como cada consulta trae TODAS las alertas activas, al volver la conexión se recuperan
 * solas las que llegaron mientras estuvo caída. Si fallan FALLOS_PARA_AVISAR consultas seguidas se
 * muestra «No se pueden recibir alertas en tiempo real» con «Reintentar». Nunca se pinta el panel
 * vacío como si no hubiera incidentes si en realidad no hay conexión.
 */
(function (global) {
  "use strict";

  const POLL_MS = 4000;            // igual a INTERVALO_SONDEO_SEG en incidentes_logica.py
  const FALLOS_PARA_AVISAR = 2;
  const MAX_TOASTS = 3;
  const TOAST_MS = 15000;
  const MSG_SIN_TIEMPO_REAL = "No se pueden recibir alertas en tiempo real";
  const SEVERIDAD_TITULO = { alta: "ALERTA CRÍTICA", media: "ADVERTENCIA", baja: "AVISO" };

  /* ---------- lógica pura (se prueba con node --test tests/js/incidentes.test.js) ---------- */

  function tiempo(valor) {
    const t = new Date(valor).getTime();
    return Number.isNaN(t) ? 0 : t;
  }

  // Las nuevas (no vistas) primero; dentro de cada grupo, la más reciente arriba.
  function ordenar(items) {
    return items.slice().sort((a, b) => (Number(Boolean(a.vista)) - Number(Boolean(b.vista))) || (tiempo(b.fecha) - tiempo(a.fecha)));
  }

  function nuevasDesde(conocidas, items) {
    return items.filter(item => !conocidas.has(item.id));
  }

  function textoRecuperadas(cantidad) {
    return cantidad === 1
      ? "Se recuperó 1 alerta que llegó mientras no había conexión."
      : "Se recuperaron " + cantidad + " alertas que llegaron mientras no había conexión.";
  }

  // «No hay alertas» solo se dice cuando de verdad se consultó y hay conexión.
  function mostrarVacio(estado) {
    return Boolean(estado.cargado) && !estado.sinConexion && estado.items.length === 0;
  }

  /* ---------- utilidades de DOM (sin innerHTML para texto de usuario: ADR 0001) ---------- */

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : value);
    });
    children.flat().filter(child => child != null).forEach(child => {
      node.append(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
    });
    return node;
  }

  function fecha(valor) {
    const d = new Date(valor);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-SV") + " " +
      d.toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  /* ---------- estado compartido ---------- */

  const state = {
    items: [], conocidas: new Set(), cargado: false, fallos: 0, sinConexion: false,
    consultando: false, timer: null, iniciado: false, onCount: null, panel: null,
    modal: null, mapa: null, toasts: null
  };

  /* ---------- consulta periódica ---------- */

  function programar() {
    global.clearTimeout(state.timer);
    state.timer = global.setTimeout(consultar, POLL_MS);
  }

  async function consultar() {
    if (state.consultando) return;
    state.consultando = true;
    try {
      const datos = await global.Api.post("/incidentes/listar", {});
      const llegaron = state.cargado ? nuevasDesde(state.conocidas, datos.items) : [];
      const veniaSinConexion = state.sinConexion;
      state.items = datos.items;
      datos.items.forEach(item => state.conocidas.add(item.id));
      state.cargado = true;
      state.fallos = 0;
      state.sinConexion = false;
      if (llegaron.length) avisar(llegaron, veniaSinConexion);
      if (state.onCount) state.onCount(state.items.length);
    } catch (error) {
      if (!global.Api.session()) {         // sesión cerrada: se deja de consultar
        state.consultando = false;
        return;
      }
      state.fallos += 1;
      if (state.fallos >= FALLOS_PARA_AVISAR) state.sinConexion = true;
    }
    state.consultando = false;
    renderPanel();
    programar();
  }

  function reintentar() {
    state.fallos = FALLOS_PARA_AVISAR;     // mientras no responda, el aviso sigue visible
    consultar();
  }

  /* ---------- notificaciones en pantalla ---------- */

  function contenedorToasts() {
    if (!state.toasts) {
      state.toasts = h("div", { class: "iv-toasts", "aria-live": "assertive" });
      document.body.append(state.toasts);
    }
    return state.toasts;
  }

  function toast(clase, titulo, texto, alAbrir) {
    const caja = contenedorToasts();
    const nodo = h("div", { class: "iv-toast " + clase, role: "alert" },
      h("button", { type: "button", class: "iv-toast-cuerpo", onclick: () => { nodo.remove(); if (alAbrir) alAbrir(); } },
        h("strong", {}, titulo), h("span", {}, texto)),
      h("button", { type: "button", class: "iv-toast-cerrar", "aria-label": "Cerrar aviso", onclick: () => nodo.remove() }, "×"));
    caja.prepend(nodo);
    while (caja.children.length > MAX_TOASTS) caja.lastElementChild.remove();
    global.setTimeout(() => nodo.remove(), TOAST_MS);
  }

  function avisar(llegaron, veniaSinConexion) {
    ordenar(llegaron).slice(0, MAX_TOASTS).forEach(item => {
      toast("iv-sev-" + item.severidad,
        (SEVERIDAD_TITULO[item.severidad] || "ALERTA") + " · " + item.tipo_etiqueta,
        item.ruta + " · " + item.conductor,
        () => abrirDetalle(item.id));
    });
    if (veniaSinConexion) toast("iv-info", "Conexión recuperada", textoRecuperadas(llegaron.length), null);
  }

  /* ---------- panel de alertas activas ---------- */

  function renderPanel() {
    const cont = state.panel;
    if (!cont) return;
    const lista = ordenar(state.items);
    const partes = [
      h("header", { class: "iv-cabecera" },
        h("div", {}, h("span", { class: "iv-kicker" }, "CENTRO DE CONTROL"), h("h2", {}, "Incidentes de viajes en curso")),
        h("div", { class: "iv-contador", "aria-live": "polite" },
          h("strong", {}, state.cargado ? String(lista.length) : "–"), h("span", {}, "sin atender")))
    ];
    if (state.sinConexion) {
      partes.push(h("div", { class: "iv-error", role: "alert" },
        h("div", {}, h("strong", {}, MSG_SIN_TIEMPO_REAL),
          state.cargado ? h("small", {}, "Se muestra la última información recibida; puede haber alertas nuevas que no ves.") : null),
        h("button", { type: "button", onclick: reintentar }, "Reintentar")));
    }
    if (!state.cargado && !state.sinConexion) partes.push(h("p", { class: "iv-estado", role: "status" }, "Cargando alertas…"));
    if (mostrarVacio({ cargado: state.cargado, sinConexion: state.sinConexion, items: lista })) {
      partes.push(h("p", { class: "iv-estado", role: "status" }, "No hay alertas de incidentes sin atender."));
    }
    if (lista.length) partes.push(h("ul", { class: "iv-lista" }, lista.map(tarjeta)));
    cont.replaceChildren(...partes);
  }

  function tarjeta(item) {
    return h("li", {},
      h("button", { type: "button", class: "iv-tarjeta iv-sev-" + item.severidad + (item.vista ? "" : " iv-nueva"), onclick: () => abrirDetalle(item.id) },
        h("span", { class: "iv-fila" },
          h("strong", {}, item.tipo_etiqueta),
          h("span", { class: "iv-chip" }, item.severidad_etiqueta),
          item.vista ? null : h("span", { class: "iv-chip iv-chip-nueva" }, "NUEVA")),
        h("span", { class: "iv-linea" }, item.ruta + " · Conductor: " + item.conductor),
        h("small", {}, fecha(item.fecha))));
  }

  /* ---------- detalle, mapa y «Marcar como atendida» ---------- */

  function cerrarDetalle() {
    if (state.mapa) { state.mapa.remove(); state.mapa = null; }
    if (state.modal) { state.modal.remove(); state.modal = null; }
    document.removeEventListener("keydown", alTeclear);
  }

  function alTeclear(evento) {
    if (evento.key === "Escape") cerrarDetalle();
  }

  async function abrirDetalle(id) {
    cerrarDetalle();
    let datos;
    try {
      datos = await global.Api.post("/incidentes/detalle", { id });
    } catch (error) {
      toast("iv-info", "No se pudo abrir la alerta", error.message || "Inténtelo de nuevo.", null);
      return;
    }
    const alerta = datos.alerta;
    const local = state.items.find(item => item.id === alerta.id);
    if (local) local.vista = true;           // deja de verse como «nueva»
    renderPanel();

    const aviso = h("p", { class: "iv-form-error", role: "alert", hidden: true });
    const comentario = h("textarea", { id: "iv-comentario", rows: "3", maxlength: "500", placeholder: "Describa qué acción se tomó (mín. 3 caracteres)" });
    const boton = h("button", { type: "button", class: "iv-primario" }, "Marcar como atendida");
    boton.addEventListener("click", async () => {
      aviso.hidden = true;
      boton.disabled = true;
      try {
        await global.Api.post("/incidentes/atender", { id: alerta.id, comentario: comentario.value });
        state.items = state.items.filter(item => item.id !== alerta.id);
        if (state.onCount) state.onCount(state.items.length);
        cerrarDetalle();
        renderPanel();
        toast("iv-ok", "Alerta atendida", "Quedó registrada en la auditoría.", null);
      } catch (error) {
        aviso.textContent = error.message || "No se pudo guardar la atención.";
        aviso.hidden = false;
        boton.disabled = false;
        if (/ya atendi/i.test(aviso.textContent)) consultar();   // otro administrador la atendió primero
      }
    });

    const filas = [
      ["Fecha y hora", fecha(alerta.fecha)], ["Viaje", alerta.viaje], ["Ruta", alerta.ruta], ["Conductor", alerta.conductor],
      ["Tipo de incidente", alerta.tipo_etiqueta], ["Severidad", alerta.severidad_etiqueta],
      ["Descripción", alerta.descripcion || "—"], ["Ubicación", alerta.lat + ", " + alerta.lng]
    ];
    const mapa = h("div", { class: "iv-mapa", role: "img", "aria-label": "Ubicación del incidente en el mapa" });
    const atendida = alerta.estado === "atendida";
    const auditoria = (datos.auditoria || []).map(a => h("li", {}, a.usuario_nombre + " · " + fecha(a.fecha) + " · " + a.comentario));

    state.modal = h("div", { class: "iv-fondo", onclick: evento => { if (evento.target === state.modal) cerrarDetalle(); } },
      h("section", { class: "iv-modal iv-sev-" + alerta.severidad, role: "dialog", "aria-modal": "true", "aria-labelledby": "iv-titulo" },
        h("button", { type: "button", class: "iv-cerrar", "aria-label": "Cerrar", onclick: cerrarDetalle }, "×"),
        h("h3", { id: "iv-titulo" }, alerta.tipo_etiqueta + " · " + alerta.severidad_etiqueta),
        h("dl", { class: "iv-datos" }, filas.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
        mapa,
        atendida
          ? h("p", { class: "iv-estado" }, "Alerta atendida: " + (alerta.comentario || ""))
          : h("div", { class: "iv-atencion" }, h("label", { for: "iv-comentario" }, "Comentario de atención"), comentario, aviso, boton),
        auditoria.length ? h("div", {}, h("h4", {}, "Auditoría"), h("ul", { class: "iv-auditoria" }, auditoria)) : null));
    document.body.append(state.modal);
    document.addEventListener("keydown", alTeclear);
    if (!atendida) comentario.focus();

    if (global.L && alerta.lat != null && alerta.lng != null) {
      state.mapa = global.L.map(mapa).setView([alerta.lat, alerta.lng], 15);
      global.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(state.mapa);
      global.L.marker([alerta.lat, alerta.lng]).addTo(state.mapa);
      global.setTimeout(() => state.mapa && state.mapa.invalidateSize(), 60);
    } else {
      mapa.textContent = "No se pudo cargar el mapa. Ubicación: " + alerta.lat + ", " + alerta.lng;
    }
  }

  /* ---------- API pública ---------- */

  function iniciar(opciones) {
    if (opciones && opciones.onCount) state.onCount = opciones.onCount;   // vale aunque ya haya arrancado
    if (state.iniciado) return;
    state.iniciado = true;
    document.addEventListener("visibilitychange", () => { if (!document.hidden) consultar(); });
    consultar();
  }

  function mount(contenedor) {
    if (!contenedor) throw new Error("No se encontró el contenedor de incidentes.");
    state.panel = contenedor;
    renderPanel();
    iniciar({});
    return { reload: consultar };
  }

  global.IncidentesViaje = { iniciar, mount, util: { ordenar, nuevasDesde, textoRecuperadas, mostrarVacio, POLL_MS, FALLOS_PARA_AVISAR, MSG_SIN_TIEMPO_REAL } };
})(window);