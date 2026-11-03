/* =====================================================================
   ALERTAS E INCIDENTES — SERSAPROSA   (window.AlertasIncidentes)

   Un solo panel en «Monitoreo en vivo» que reemplaza las pestañas «Incidentes en curso»,
   «Alertas de seguridad» e «Historial de incidentes». Junta dos fuentes sin duplicarlas:
     • incidentes de viajes EN CURSO   → tabla incidentes_viaje   (se «atienden»)
       tiempo real: incidentesViaje.js consulta /incidentes/listar cada 4 s y avisa en pantalla;
       este panel recibe esa misma lista (onItems), así no se consulta dos veces.
     • alertas de viajes FINALIZADOS    → tabla alertas_seguridad  (se «revisan»)  /alertas/listar
   Resueltos (opcional, filtro Estado): /incidentes/historial (atendidos) y /alertas/listar (revisadas).

   Uso (lo hace dashboard.js):
     AlertasIncidentes.iniciar({ onCount: n => ... })   // segundo plano + contador de la pestaña
     AlertasIncidentes.mount(contenedor)                 // dibuja el panel → { reload }

   Nunca dice «no hay alertas» si alguna fuente no se pudo consultar: muestra cuál falló y «Reintentar».
   ===================================================================== */
(function (global) {
  "use strict";

  const ROL = "coordinador_rutas";
  const LIMITE_ALERTAS = 100;
  const LIMITE_RESUELTOS = 50;
  const ORDEN_SEVERIDAD = { alta: 0, media: 1, baja: 2 };
  const SEVERIDADES = { alta: "Alta", media: "Media", baja: "Baja" };
  const FUENTES = { incidente: "Viaje en curso", alerta: "Viaje finalizado" };
  const ESTADOS = { pendiente: "Pendiente", resuelta: "Resuelta" };

  /* ============ Reglas puras (se prueban con node --test tests/js/alertasIncidentes.test.js) ============ */

  const norm = texto => String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const tiempo = valor => { const t = new Date(valor).getTime(); return Number.isNaN(t) ? 0 : t; };
  const etiquetaTipo = tipo => {
    const t = String(tipo || "Sin tipo").replace(/_/g, " ").trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  };

  function deIncidente(i) {
    return {
      clave: "incidente:" + i.id, fuente: "incidente", id: String(i.id), fecha: i.fecha,
      tipo: i.tipo_etiqueta || etiquetaTipo(i.tipo), severidad: i.severidad,
      ruta: i.ruta || "Ruta sin nombre", conductor: i.conductor || "Sin conductor asignado",
      descripcion: i.descripcion || "", estado: i.estado === "atendida" ? "resuelta" : "pendiente",
      nueva: i.estado !== "atendida" && i.vista === false, lat: i.lat, lng: i.lng
    };
  }

  function deAlerta(a) {
    return {
      clave: "alerta:" + a.id, fuente: "alerta", id: String(a.id), fecha: a.fecha,
      tipo: etiquetaTipo(a.tipo), severidad: a.severidad,
      ruta: a.ruta || "Ruta sin nombre", conductor: a.conductor || "Sin conductor",
      descripcion: a.descripcion || "", estado: a.estado === "revisada" ? "resuelta" : "pendiente",
      nueva: false, lat: a.lat, lng: a.lng
    };
  }

  // Une las listas sin repetir (la misma alerta puede llegar en «pendientes» y en «todas»):
  // primero pendientes, luego por severidad y, dentro de cada grupo, la más reciente arriba.
  function combinar(...listas) {
    const porClave = new Map();
    listas.flat().forEach(item => { if (item && item.clave) porClave.set(item.clave, item); });
    return Array.from(porClave.values()).sort((a, b) =>
      (a.estado === "pendiente" ? 0 : 1) - (b.estado === "pendiente" ? 0 : 1) ||
      (ORDEN_SEVERIDAD[a.severidad] ?? 3) - (ORDEN_SEVERIDAD[b.severidad] ?? 3) ||
      tiempo(b.fecha) - tiempo(a.fecha));
  }

  function filtrar(items, f) {
    const filtros = f || {};
    const q = norm(filtros.texto);
    return (items || []).filter(i =>
      (!filtros.estado || filtros.estado === "todas" || i.estado === filtros.estado) &&
      (!filtros.severidad || i.severidad === filtros.severidad) &&
      (!filtros.fuente || i.fuente === filtros.fuente) &&
      (!q || norm([i.tipo, i.ruta, i.conductor, i.descripcion].join(" ")).includes(q)));
  }

  function resumen(items) {
    const pendientes = (items || []).filter(i => i.estado === "pendiente");
    return {
      pendientes: pendientes.length,
      enCurso: pendientes.filter(i => i.fuente === "incidente").length,
      finalizados: pendientes.filter(i => i.fuente === "alerta").length,
      altas: pendientes.filter(i => i.severidad === "alta").length
    };
  }

  // «No hay…» solo cuando todas las fuentes necesarias respondieron.
  function textoVacio(estado) {
    if (!estado.cargado || estado.errores.length || estado.items.length) return "";
    const conFiltros = estado.filtros.severidad || estado.filtros.fuente || norm(estado.filtros.texto);
    if (conFiltros) return "No hay alertas ni incidentes con esos filtros.";
    return estado.filtros.estado === "resuelta" ? "Todavía no hay alertas ni incidentes resueltos."
      : estado.filtros.estado === "todas" ? "Todavía no hay alertas ni incidentes registrados."
      : "No hay alertas ni incidentes pendientes.";
  }

  /* ============ Utilidades de DOM (sin innerHTML para texto: ADR 0001) ============ */

  function h(tag, attrs, ...hijos) {
    const node = global.document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (k === "selected" || k === "disabled") node[k] = !!v;
      else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
    });
    hijos.flat().filter(c => c != null && c !== false).forEach(c => {
      node.append(typeof c === "string" || typeof c === "number" ? global.document.createTextNode(String(c)) : c);
    });
    return node;
  }

  function fecha(valor) {
    const d = new Date(valor);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-SV") + " " +
      d.toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit" });
  }

  /* ============ Estado ============ */

  const S = {
    iniciado: false, onCount: null, panel: null, ui: {},
    incidentes: [], incCargados: false, incSinConexion: false,
    alertas: [], alertasCargadas: false, alertasError: "",
    resueltos: [], resueltosCargados: false, resueltosError: "", cargandoResueltos: false,
    filtros: { estado: "pendiente", severidad: "", fuente: "", texto: "" },
    modal: null, mapa: null, mensaje: ""
  };

  const esCoordinador = () => ((global.Api && global.Api.session()) || {}).role === ROL;
  const todos = () => combinar(S.incidentes, S.alertas, S.resueltos);

  function contar() {
    if (S.onCount) S.onCount(resumen(combinar(S.incidentes, S.alertas)).pendientes);
  }

  /* ============ Consultas ============ */

  function recibirIncidentes(items, estado) {
    S.incidentes = (items || []).map(deIncidente);
    S.incCargados = Boolean(estado && estado.cargado);
    S.incSinConexion = Boolean(estado && estado.sinConexion);
    contar();
    pintar();
  }

  async function cargarAlertas() {
    try {
      const datos = await global.Api.post("/alertas/listar", { estado: "pendiente", page: 1, page_size: LIMITE_ALERTAS });
      if (!datos || !Array.isArray(datos.items)) throw new Error("El servicio de alertas devolvió una respuesta no válida.");
      S.alertas = datos.items.map(deAlerta);
      S.alertasCargadas = true;
      S.alertasError = "";
    } catch (error) {
      if (!global.Api.session()) return;
      S.alertasError = error.message || "No se pudieron cargar las alertas de seguridad.";
    }
    contar();
    pintar();
  }

  async function cargarResueltos() {
    if (S.cargandoResueltos) return;
    S.cargandoResueltos = true;
    pintar();
    const [inc, ale] = await Promise.allSettled([
      global.Api.post("/incidentes/historial", { estado: "atendida", pagina: 1, limite: LIMITE_RESUELTOS }),
      global.Api.post("/alertas/listar", { estado: "revisada", page: 1, page_size: LIMITE_RESUELTOS })
    ]);
    const errores = [];
    const lista = [];
    if (inc.status === "fulfilled" && Array.isArray(inc.value.items)) lista.push(...inc.value.items.map(deIncidente));
    else errores.push("incidentes atendidos" + (inc.reason ? " (" + inc.reason.message + ")" : ""));
    if (ale.status === "fulfilled" && Array.isArray(ale.value.items)) lista.push(...ale.value.items.map(deAlerta));
    else errores.push("alertas revisadas" + (ale.reason ? " (" + ale.reason.message + ")" : ""));
    S.resueltos = lista;
    S.resueltosCargados = true;
    S.resueltosError = errores.length ? "No se pudieron cargar: " + errores.join("; ") + "." : "";
    S.cargandoResueltos = false;
    pintar();
  }

  function recargar() {
    if (!esCoordinador()) return;
    cargarAlertas();
    if (global.IncidentesViaje && global.IncidentesViaje.consultar) global.IncidentesViaje.consultar();
    if (S.filtros.estado !== "pendiente") cargarResueltos();
  }

  /* ============ Pantalla ============ */

  function construir() {
    const ui = S.ui;
    const select = (id, opciones, valor, alCambiar) => h("select", { id, onchange: e => alCambiar(e.target.value) },
      opciones.map(([v, t]) => h("option", { value: v, selected: v === valor }, t)));
    ui.estado = select("ai-estado", [["pendiente", "Pendientes"], ["resuelta", "Resueltas"], ["todas", "Todas"]], S.filtros.estado, v => {
      S.filtros.estado = v;
      if (v !== "pendiente" && !S.resueltosCargados) cargarResueltos();
      pintar();
    });
    ui.severidad = select("ai-severidad", [["", "Todas"]].concat(Object.entries(SEVERIDADES)), "", v => { S.filtros.severidad = v; pintar(); });
    ui.fuente = select("ai-fuente", [["", "Todos"]].concat(Object.entries(FUENTES)), "", v => { S.filtros.fuente = v; pintar(); });
    ui.texto = h("input", { id: "ai-texto", type: "search", maxlength: "80", placeholder: "Tipo, ruta o conductor",
      oninput: e => { S.filtros.texto = e.target.value; pintar(); } });
    const campo = (texto, id, control) => h("div", { class: "ai-campo" }, h("label", { for: id }, texto), control);
    ui.contador = h("div", { class: "ai-contador", "aria-live": "polite" });
    ui.avisos = h("div", { class: "ai-avisos" });
    ui.lista = h("div", { class: "ai-resultados" });
    S.panel.replaceChildren(h("div", { class: "ai" },
      h("header", { class: "ai-cabecera" },
        h("div", {}, h("span", { class: "ai-kicker" }, "CENTRO DE CONTROL"), h("h2", {}, "Alertas e incidentes"),
          h("p", {}, "Incidentes de viajes en curso y alertas de viajes finalizados, en un solo lugar.")),
        ui.contador),
      h("div", { class: "ai-filtros", role: "search", "aria-label": "Filtros de alertas e incidentes" },
        campo("Estado", "ai-estado", ui.estado), campo("Severidad", "ai-severidad", ui.severidad),
        campo("Origen", "ai-fuente", ui.fuente), campo("Buscar", "ai-texto", ui.texto)),
      ui.avisos, ui.lista));
  }

  function aviso(texto, detalle, accion) {
    return h("div", { class: "ai-error", role: "alert" },
      h("div", {}, h("strong", {}, texto), detalle ? h("small", {}, detalle) : null),
      accion ? h("button", { type: "button", onclick: accion }, "Reintentar") : null);
  }

  function pintar() {
    if (!S.panel || !S.ui.lista) return;
    const ui = S.ui;
    const pendientes = resumen(combinar(S.incidentes, S.alertas));
    ui.contador.replaceChildren(
      h("strong", {}, S.incCargados || S.alertasCargadas ? String(pendientes.pendientes) : "–"),
      h("span", {}, "pendientes"),
      h("small", {}, pendientes.enCurso + " en curso · " + pendientes.finalizados + " finalizados"));

    const errores = [];
    const avisos = [];
    if (S.mensaje) {
      avisos.push(h("div", { class: "ai-ok", role: "status" }, h("span", {}, S.mensaje),
        h("button", { type: "button", "aria-label": "Cerrar mensaje", onclick: () => { S.mensaje = ""; pintar(); } }, "×")));
    }
    if (S.incSinConexion) {
      errores.push("incidentes");
      avisos.push(aviso("No se pueden recibir incidentes en tiempo real",
        S.incCargados ? "Se muestra la última información recibida." : "",
        () => global.IncidentesViaje && global.IncidentesViaje.consultar()));
    }
    if (S.alertasError) {
      errores.push("alertas");
      avisos.push(aviso("No se pudieron cargar las alertas de seguridad", S.alertasError, cargarAlertas));
    }
    if (S.filtros.estado !== "pendiente" && S.resueltosError) {
      errores.push("resueltas");
      avisos.push(aviso("Historial incompleto", S.resueltosError, cargarResueltos));
    }
    ui.avisos.replaceChildren(...avisos);

    const cargado = S.incCargados && S.alertasCargadas && (S.filtros.estado === "pendiente" || S.resueltosCargados);
    const visibles = filtrar(todos(), S.filtros);
    const partes = [];
    if (!cargado && !errores.length) partes.push(h("p", { class: "ai-estado", role: "status" }, "Cargando alertas e incidentes…"));
    const vacio = textoVacio({ cargado, errores, items: visibles, filtros: S.filtros });
    if (vacio) partes.push(h("p", { class: "ai-estado", role: "status" }, vacio));
    if (visibles.length) partes.push(h("ul", { class: "ai-lista" }, visibles.map(tarjeta)));
    ui.lista.replaceChildren(...partes);
  }

  function tarjeta(i) {
    return h("li", {},
      h("button", { type: "button", class: "ai-tarjeta ai-sev-" + i.severidad + (i.estado === "resuelta" ? " ai-resuelta" : "") + (i.nueva ? " ai-nueva" : ""),
        onclick: () => abrir(i) },
        h("span", { class: "ai-fila" },
          h("strong", {}, i.tipo),
          h("span", { class: "ai-chip ai-chip-sev" }, SEVERIDADES[i.severidad] || "Sin clasificar"),
          h("span", { class: "ai-chip ai-chip-" + i.fuente }, FUENTES[i.fuente]),
          i.estado === "resuelta" ? h("span", { class: "ai-chip ai-chip-ok" }, i.fuente === "alerta" ? "Revisada" : "Atendido") : null,
          i.nueva ? h("span", { class: "ai-chip ai-chip-nueva" }, "NUEVA") : null),
        h("span", { class: "ai-linea" }, i.ruta + " · Conductor: " + i.conductor),
        h("small", {}, fecha(i.fecha) + (i.descripcion ? " · " + i.descripcion : ""))));
  }

  /* ============ Detalle ============ */

  function abrir(item) {
    if (item.fuente === "incidente" && global.IncidentesViaje && global.IncidentesViaje.abrir) {
      global.IncidentesViaje.abrir(item.id);   // detalle, mapa y «Marcar como atendida» de incidentesViaje.js
      return;
    }
    abrirAlerta(item.id);
  }

  function cerrar() {
    if (S.mapa) { S.mapa.remove(); S.mapa = null; }
    if (S.modal) { S.modal.remove(); S.modal = null; }
    global.document.removeEventListener("keydown", alTeclear);
  }

  function alTeclear(e) { if (e.key === "Escape") cerrar(); }

  async function abrirAlerta(id) {
    cerrar();
    let datos;
    try {
      datos = await global.Api.post("/alertas/detalle", { id });
    } catch (error) {
      S.alertasError = error.message || "No se pudo abrir la alerta.";
      pintar();
      return;
    }
    const a = datos.alerta || {};
    const pendiente = a.estado !== "revisada";
    const error = h("p", { class: "ai-form-error", role: "alert", hidden: true });
    const comentario = h("textarea", { id: "ai-comentario", rows: "3", maxlength: "500", placeholder: "Qué se revisó o qué acción se tomó (mín. 3 caracteres)" });
    const boton = h("button", { type: "button", class: "ai-primario" }, "Marcar como revisada");
    boton.addEventListener("click", async () => {
      error.hidden = true;
      boton.disabled = true;
      try {
        await global.Api.post("/alertas/revisar", { id: a.id, comentario: comentario.value });
        cerrar();
        S.mensaje = "Alerta revisada. Quedó registrada en la auditoría.";
        S.resueltosCargados = false;
        await cargarAlertas();
        if (S.filtros.estado !== "pendiente") cargarResueltos();
      } catch (e) {
        error.textContent = e.message || "No se pudo guardar la revisión.";
        error.hidden = false;
        boton.disabled = false;
      }
    });
    const filas = [
      ["Fecha y hora", fecha(a.fecha)], ["Viaje", a.viaje_id || "—"], ["Ruta", a.ruta || "—"], ["Conductor", a.conductor || "—"],
      ["Tipo", etiquetaTipo(a.tipo)], ["Severidad", SEVERIDADES[a.severidad] || "—"], ["Origen", FUENTES.alerta],
      ["Descripción", a.descripcion || "—"], ["Ubicación", a.lat != null && a.lng != null ? a.lat + ", " + a.lng : "Sin ubicación"]
    ];
    if (!pendiente) filas.push(["Revisada", fecha(a.revisado_en)], ["Comentario", a.comentario || "—"]);
    const mapa = h("div", { class: "ai-mapa", role: "img", "aria-label": "Ubicación de la alerta en el mapa" });
    const auditoria = (datos.auditoria || []).map(x => h("li", {}, (x.revisor_nombre || "—") + " · " + fecha(x.fecha) + " · " + (x.comentario || "")));
    S.modal = h("div", { class: "ai-fondo", onclick: e => { if (e.target === S.modal) cerrar(); } },
      h("section", { class: "ai-modal ai-sev-" + a.severidad, role: "dialog", "aria-modal": "true", "aria-labelledby": "ai-titulo" },
        h("button", { type: "button", class: "ai-cerrar", "aria-label": "Cerrar", onclick: cerrar }, "×"),
        h("h3", { id: "ai-titulo" }, etiquetaTipo(a.tipo) + " · " + (SEVERIDADES[a.severidad] || "")),
        h("dl", { class: "ai-datos" }, filas.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
        a.lat != null && a.lng != null ? mapa : null,
        pendiente ? h("div", { class: "ai-atencion" }, h("label", { for: "ai-comentario" }, "Comentario de revisión"), comentario, error, boton) : null,
        auditoria.length ? h("div", {}, h("h4", {}, "Auditoría"), h("ul", { class: "ai-auditoria" }, auditoria)) : null));
    global.document.body.append(S.modal);
    global.document.addEventListener("keydown", alTeclear);
    if (pendiente) comentario.focus();
    if (global.L && a.lat != null && a.lng != null) {
      S.mapa = global.L.map(mapa).setView([a.lat, a.lng], 15);
      global.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>', maxZoom: 19 }).addTo(S.mapa);
      global.L.marker([a.lat, a.lng]).addTo(S.mapa);
      global.setTimeout(() => S.mapa && S.mapa.invalidateSize(), 60);
    }
  }

  /* ============ API pública ============ */

  function iniciar(opciones) {
    if (opciones && opciones.onCount) S.onCount = opciones.onCount;
    if (S.iniciado || !esCoordinador()) return;
    S.iniciado = true;
    if (global.IncidentesViaje) global.IncidentesViaje.iniciar({ onItems: recibirIncidentes });
    else S.incCargados = true;
    cargarAlertas();
  }

  function mount(contenedor) {
    if (!contenedor) throw new Error("No se encontró el contenedor de alertas e incidentes.");
    if (!esCoordinador()) {
      contenedor.textContent = "Las alertas e incidentes son solo para el coordinador de rutas.";
      return { reload() {} };
    }
    if (S.panel !== contenedor) {
      S.panel = contenedor;
      construir();
    }
    iniciar({});
    pintar();
    return { reload: recargar };
  }

  global.AlertasIncidentes = {
    mount, iniciar, reload: recargar,
    util: { deIncidente, deAlerta, combinar, filtrar, resumen, textoVacio, etiquetaTipo }
  };
})(window);
