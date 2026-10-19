/* Apartado de notificaciones del administrador de rutas (FCJ1-16).
 *
 * Uso:   Notificaciones.mount(contenedor, {
 *          SYNC: "/notificaciones/sincronizar",   // crea las notificaciones que falten
 *          LOAD: "/notificaciones/listar",        // lista + contador + auditoría
 *          READ: "/notificaciones/leer",          // marca como leída
 *          ROLE_ALLOWED: "coordinador_rutas",
 *          onUnauthorized: () => ...,             // sesión vencida
 *          onCount: n => ...                      // cuántas no leídas (para la pestaña)
 *        })
 * Colores por urgencia: roja = alta, naranja = media, amarilla = baja, gris = sin clasificar.
 * Nunca muestra "sin notificaciones" si hubo un error: muestra el error con "Reintentar".
 */
(function (global) {
  "use strict";

  const SESSION_KEY = "session";
  const REFRESH_MS = 60000;
  const MSG_SYNC = "No se pudieron generar algunas notificaciones";
  const MSG_LOAD = "No se pudieron cargar las notificaciones";
  const ORIGEN = { evento: "Evento", alerta: "Alerta", choque: "Choque", emergencia: "Emergencia" };
  const COLOR = {
    roja: { etiqueta: "Roja · alta", titulo: "ALERTA CRÍTICA" },
    naranja: { etiqueta: "Naranja · media", titulo: "ADVERTENCIA" },
    amarilla: { etiqueta: "Amarilla · baja", titulo: "AVISO" },
    sin_clasificar: { etiqueta: "Sin clasificar", titulo: "SIN CLASIFICAR" }
  };
  const FILTROS = [["todas", "Todas"], ["no_leidas", "No leídas"], ["roja", "Rojas"], ["naranja", "Naranjas"], ["amarilla", "Amarillas"]];
  const FILTROS_HISTORIAL = [["todos", "Todo"], ["generada", "Generadas"], ["leida", "Leídas"]];

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

  const fecha = valor => {
    const d = new Date(valor);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-SV") + " " +
      d.toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit" });
  };
  const hora = valor => {
    const d = new Date(valor);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit" });
  };
  function hace(valor) {
    const d = new Date(valor);
    if (Number.isNaN(d.getTime())) return "";
    const min = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
    if (min < 1) return "hace un momento";
    if (min < 60) return "hace " + min + " min";
    if (min < 1440) return "hace " + Math.floor(min / 60) + " h";
    return "hace " + Math.floor(min / 1440) + " d";
  }

  function mount(container, options) {
    if (!container) throw new Error("No se encontró el contenedor de notificaciones.");
    const opts = options || {};
    let session = null;
    try {
      session = JSON.parse(global.sessionStorage.getItem(SESSION_KEY) || "null");
    } catch (error) {
      session = null;
    }
    const apiBase = ((session && session.apiBase) || global.location.origin).replace(/\/$/, "");
    const state = {
      data: null,            // última respuesta buena de LOAD
      syncError: "",         // fallo al generar (se puede reintentar)
      syncDetail: "",
      loadError: "",         // fallo al cargar (se puede reintentar)
      actionError: "",
      busy: false,
      filtro: "todas",
      historial: "todos"
    };
    let timer = null;
    let destroyed = false;

    async function request(path, payload) {
      if (!session || !session.token) throw Object.assign(new Error("Sesión vencida. Inicie sesión de nuevo."), { status: 401 });
      const response = await global.fetch(apiBase + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.token },
        body: JSON.stringify(payload || {})
      });
      let body = {};
      try {
        body = await response.json();
      } catch (error) {
        body = {};
      }
      if (!response.ok) {
        const detail = body.detail;
        const message = detail && typeof detail === "object" ? detail.message : detail;
        throw Object.assign(new Error(message || "Error " + response.status), { status: response.status });
      }
      return body;
    }

    function sesionVencida(error) {
      if (error && error.status === 401) {
        if (opts.onUnauthorized) opts.onUnauthorized();
        return true;
      }
      return false;
    }

    function permitido() {
      return !opts.ROLE_ALLOWED || (session && session.role === opts.ROLE_ALLOWED);
    }

    async function refresh() {
      if (destroyed || state.busy || !permitido()) return;
      state.busy = true;
      state.syncError = "";
      state.syncDetail = "";
      state.loadError = "";
      render();
      try {
        const resultado = await request(opts.SYNC || "/notificaciones/sincronizar");
        if (resultado && Array.isArray(resultado.fallos) && resultado.fallos.length) {
          state.syncError = MSG_SYNC;
          state.syncDetail = "Fuentes con problema: " + resultado.fallos.join(", ") + ".";
        }
      } catch (error) {
        if (sesionVencida(error)) return;
        state.syncError = MSG_SYNC;
      }
      try {
        const datos = await request(opts.LOAD || "/notificaciones/listar");
        if (!datos || !Array.isArray(datos.items) || !datos.resumen) throw new Error(MSG_LOAD);
        state.data = datos;
        if (opts.onCount) opts.onCount(datos.resumen.no_leidas);
      } catch (error) {
        if (sesionVencida(error)) return;
        state.loadError = MSG_LOAD;
        state.data = null;       // no se muestra una lista vieja ni vacía como si fuera correcta
      }
      state.busy = false;
      render();
    }

    async function marcarLeida(item) {
      state.actionError = "";
      try {
        await request(opts.READ || "/notificaciones/leer", { id: item.id });
      } catch (error) {
        if (sesionVencida(error)) return;
        state.actionError = error.message || "No se pudo marcar la notificación como leída";
        render();
        return;
      }
      state.busy = false;
      await refreshSoloLista();
    }

    async function refreshSoloLista() {
      try {
        const datos = await request(opts.LOAD || "/notificaciones/listar");
        state.data = datos;
        state.loadError = "";
        if (opts.onCount) opts.onCount(datos.resumen.no_leidas);
      } catch (error) {
        if (sesionVencida(error)) return;
        state.loadError = MSG_LOAD;
        state.data = null;
      }
      render();
    }

    // ---------- Piezas de la pantalla ----------

    function banner(item) {
      const color = COLOR[item.color] || COLOR.sin_clasificar;
      const tipo = item.color === "roja" ? "critical" : "warning";
      return h("div", { class: "nt-banner nt-" + tipo },
        h("div", { class: "nt-symbol", "aria-hidden": "true" }, "!"),
        h("div", { class: "nt-banner-copy" },
          h("span", {}, color.titulo + " · " + (ORIGEN[item.origen] || "").toUpperCase() + " · " + hace(item.creada_en || item.fecha).toUpperCase()),
          h("strong", {}, item.titulo),
          h("small", {}, [item.ruta, item.zona].filter(Boolean).join(" · "))),
        h("button", { type: "button", onclick: () => marcarLeida(item) }, "Marcar como leída"));
    }

    function bannerFallo(mensaje, detalle, accion) {
      return h("div", { class: "nt-banner nt-critical nt-fail", role: "alert" },
        h("div", { class: "nt-symbol", "aria-hidden": "true" }, "!"),
        h("div", { class: "nt-banner-copy" },
          h("span", {}, "ERROR"),
          h("strong", {}, mensaje),
          detalle ? h("small", {}, detalle) : null),
        h("button", { type: "button", onclick: accion, disabled: state.busy }, "Reintentar"));
    }

    function tarjeta(item) {
      const color = COLOR[item.color] || COLOR.sin_clasificar;
      return h("article", { class: "nt-item nt-" + item.color + (item.leida ? " nt-read" : "") },
        h("div", { class: "nt-item-bar", "aria-hidden": "true" }),
        h("div", { class: "nt-item-main" },
          h("div", { class: "nt-item-top" },
            h("span", { class: "nt-chip" }, ORIGEN[item.origen] || item.origen),
            h("span", { class: "nt-level" }, color.etiqueta),
            item.leida ? null : h("span", { class: "nt-new" }, "NUEVA")),
          h("strong", {}, item.titulo),
          h("div", { class: "nt-meta" },
            h("span", {}, "Ruta: " + (item.ruta || "—")),
            h("span", {}, "Zona: " + (item.zona || "—")),
            h("span", {}, fecha(item.fecha))),
          item.color === "sin_clasificar"
            ? h("p", { class: "nt-warn", role: "status" }, "Este hecho no trae un nivel de urgencia válido. Revísalo: no se le asignó un color por defecto.")
            : null),
        h("div", { class: "nt-item-action" },
          item.leida
            ? h("small", {}, "Leída" + (item.leida_nombre ? " por " + item.leida_nombre : "") + (item.leida_en ? " · " + fecha(item.leida_en) : ""))
            : h("button", { type: "button", class: "nt-btn", onclick: () => marcarLeida(item) }, "Marcar como leída")));
    }

    function pasaFiltro(item) {
      switch (state.filtro) {
        case "no_leidas": return !item.leida;
        case "roja": case "naranja": case "amarilla": return item.color === state.filtro;
        default: return true;
      }
    }

    function listaPrincipal(datos) {
      const resumen = datos.resumen;
      const cuenta = {
        todas: resumen.total, no_leidas: resumen.no_leidas,
        roja: resumen.roja, naranja: resumen.naranja, amarilla: resumen.amarilla
      };
      const items = datos.items.filter(pasaFiltro);
      const vacio = datos.items.length === 0
        ? "Sin notificaciones por ahora. Aquí irán llegando los eventos, alertas, choques y emergencias que afecten tus rutas."
        : "No hay notificaciones con este filtro.";
      return h("section", { class: "nt-panel" },
        h("div", { class: "nt-head" },
          h("div", {}, h("span", { class: "nt-kicker" }, "BANDEJA DEL ADMINISTRADOR"), h("h2", {}, "Notificaciones")),
          h("div", { class: "nt-pill" + (resumen.no_leidas ? " nt-pill-on" : "") }, h("i", {}), resumen.no_leidas + (resumen.no_leidas === 1 ? " NO LEÍDA" : " NO LEÍDAS"))),
        h("div", { class: "nt-filters", role: "group", "aria-label": "Filtrar notificaciones" },
          FILTROS.map(([id, texto]) => h("button", {
            type: "button", class: state.filtro === id ? "active" : "", "aria-pressed": String(state.filtro === id),
            onclick: () => { state.filtro = id; render(); }
          }, texto + " ", h("b", {}, cuenta[id])))),
        state.actionError ? h("p", { class: "nt-inline-error", role: "alert" }, state.actionError) : null,
        items.length
          ? h("div", { class: "nt-list", "aria-live": "polite" }, items.map(tarjeta))
          : h("p", { class: "nt-empty" }, vacio));
    }

    function listaError() {
      return h("section", { class: "nt-panel" },
        h("div", { class: "nt-head" }, h("div", {}, h("span", { class: "nt-kicker" }, "BANDEJA DEL ADMINISTRADOR"), h("h2", {}, "Notificaciones"))),
        h("p", { class: "nt-empty nt-empty-error", role: "alert" },
          "No se pueden mostrar las notificaciones en este momento. Esto no significa que no haya ninguna pendiente."));
    }

    function historial(datos) {
      const registros = (datos ? datos.audit : []).filter(r => state.historial === "todos" || r.accion === state.historial);
      const tipo = r => (r.accion === "leida" ? "resolved" : r.urgencia === "alta" ? "critical" : r.urgencia === "media" ? "warning" : r.urgencia === "baja" ? "low" : "info");
      return h("aside", { class: "nt-panel nt-history" },
        h("div", { class: "nt-head" }, h("div", {}, h("span", { class: "nt-kicker" }, "REGISTRO OPERATIVO"), h("h2", {}, "Historial"))),
        h("div", { class: "nt-filters nt-filters-compact", role: "group", "aria-label": "Filtrar historial" },
          FILTROS_HISTORIAL.map(([id, texto]) => h("button", {
            type: "button", class: state.historial === id ? "active" : "", "aria-pressed": String(state.historial === id),
            onclick: () => { state.historial = id; render(); }
          }, texto))),
        registros.length
          ? h("div", { class: "nt-timeline" }, registros.map(r => h("div", { class: "nt-t-item" },
              h("div", { class: "nt-t-dot nt-t-" + tipo(r), "aria-hidden": "true" }, r.accion === "leida" ? "✓" : "●"),
              h("div", { class: "nt-t-body" },
                h("small", {}, hora(r.fecha)),
                h("strong", {}, r.titulo || "Notificación"),
                h("span", {}, (r.accion === "leida" ? "Leída por " : "Generada · ") + (r.usuario || "—") + (r.ruta ? " · " + r.ruta : ""))))))
          : h("p", { class: "nt-empty nt-empty-small" }, datos ? "Sin movimientos para mostrar." : "No disponible mientras haya un error."));
    }

    function render() {
      if (destroyed) return;
      container.replaceChildren();
      const raiz = h("div", { class: "nt" });
      if (!permitido()) {
        raiz.append(h("p", { class: "nt-inline-error", role: "alert" }, "Esta sección es solo para el administrador de rutas."));
        container.append(raiz);
        return;
      }
      const datos = state.data;
      const fila = h("div", { class: "nt-banners" });
      if (state.syncError) fila.append(bannerFallo(state.syncError, state.syncDetail, refresh));
      if (state.loadError) fila.append(bannerFallo(state.loadError, "", refresh));
      if (datos) {
        const sinLeer = datos.items.filter(n => !n.leida);
        const roja = sinLeer.find(n => n.color === "roja");
        const naranja = sinLeer.find(n => n.color === "naranja");
        if (roja) fila.append(banner(roja));
        if (naranja) fila.append(banner(naranja));
        if (datos.resumen.sin_clasificar) {
          fila.append(h("div", { class: "nt-banner nt-neutral", role: "status" },
            h("div", { class: "nt-symbol", "aria-hidden": "true" }, "?"),
            h("div", { class: "nt-banner-copy" },
              h("span", {}, "SIN CLASIFICAR"),
              h("strong", {}, datos.resumen.sin_clasificar + (datos.resumen.sin_clasificar === 1 ? " notificación sin urgencia válida" : " notificaciones sin urgencia válida")),
              h("small", {}, "Se muestran en gris hasta que el hecho traiga su urgencia."))));
        }
      }
      if (fila.children.length) raiz.append(fila);
      if (state.busy && !datos && !state.loadError) raiz.append(h("p", { class: "nt-loading", role: "status" }, "Cargando notificaciones…"));
      else {
        raiz.append(h("div", { class: "nt-layout" },
          state.loadError ? listaError() : datos ? listaPrincipal(datos) : h("section", { class: "nt-panel" }, h("p", { class: "nt-loading" }, "Cargando notificaciones…")),
          historial(datos)));
      }
      container.append(raiz);
    }

    render();
    refresh();
    timer = global.setInterval(() => {
      if (!global.document.hidden && container.isConnected && container.offsetParent !== null) refresh();
    }, REFRESH_MS);

    return {
      refresh,
      destroy() {
        destroyed = true;
        if (timer) global.clearInterval(timer);
      }
    };
  }

  global.Notificaciones = { mount };
})(window);
