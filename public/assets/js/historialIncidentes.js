/* Historial de incidentes para análisis posterior (FCJ1-22).
 *
 * Uso (lo hace dashboard.js):
 *   HistorialIncidentes.mount(contenedor)   // dibuja el historial y devuelve { reload }
 *
 * Llama a POST /incidentes/historial (lista con filtros y páginas) y a POST /incidentes/historial/detalle.
 * Solo lee: nunca modifica un incidente. Si la consulta falla muestra el error con «Reintentar»; jamás
 * dice «no hay incidentes» cuando en realidad no pudo consultar.
 */
(function (global) {
  "use strict";

  const LIMITE = 25;
  const MSG_ERROR = "No se pudo cargar el historial de incidentes";
  const TIPOS = {
    robo: "Robo", accidente: "Accidente", desvio_ruta: "Desvío de ruta", falla_mecanica: "Falla mecánica",
    boton_panico: "Botón de pánico", choque: "Choque", emergencia: "Emergencia"
  };
  const SEVERIDADES = { alta: "Alta", media: "Media", baja: "Baja" };
  const ESTADOS = { pendiente: "Pendiente", atendida: "Atendida" };
  const CAMPOS = ["desde", "hasta", "tipo", "severidad", "estado", "ruta"];

  /* ---------- lógica pura (se prueba con node --test tests/js/historial.test.js) ---------- */

  // Solo los filtros que tienen valor (los vacíos no se envían).
  function armarFiltros(valores) {
    const filtros = {};
    CAMPOS.forEach(campo => {
      const texto = String((valores && valores[campo]) == null ? "" : valores[campo]).trim();
      if (texto) filtros[campo] = texto;
    });
    return filtros;
  }

  function hayFiltros(filtros) {
    return Object.keys(armarFiltros(filtros)).length > 0;
  }

  // Devuelve el mensaje de error si los filtros no se pueden enviar, o "" si están bien.
  function errorDeFiltros(filtros) {
    if (filtros.desde && filtros.hasta && filtros.desde > filtros.hasta) return "La fecha «desde» no puede ser posterior a «hasta».";
    return "";
  }

  // Qué decir cuando no hay filas. «Sin incidentes» solo si de verdad se consultó y no hubo error.
  function textoVacio(estado) {
    if (!estado.cargado || estado.error || estado.items.length) return "";
    return hayFiltros(estado.filtros) ? "No hay incidentes con esos filtros." : "Todavía no hay incidentes registrados.";
  }

  function textoRango(pagina, limite, cantidad, total) {
    if (!total || !cantidad) return "0 incidentes";
    const desde = (pagina - 1) * limite + 1;
    return desde + "–" + (desde + cantidad - 1) + " de " + total;
  }

  function textoContador(total) {
    return total === 1 ? "1 incidente" : total + " incidentes";
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
      d.toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit" });
  }

  function opciones(lista, textoTodos) {
    return [h("option", { value: "" }, textoTodos)].concat(Object.entries(lista).map(([valor, texto]) => h("option", { value: valor }, texto)));
  }

  /* ---------- estado ---------- */

  const state = {
    contenedor: null, controles: {}, resultados: null, pie: null,
    filtros: {}, pagina: 1, limite: LIMITE, items: [], total: 0, paginas: 1,
    cargado: false, cargando: false, error: "", pedido: 0, modal: null, mapa: null
  };

  /* ---------- consulta ---------- */

  async function cargar() {
    const pedido = ++state.pedido;           // si llega una respuesta vieja, se ignora
    state.cargando = true;
    state.error = "";
    pintarResultados();
    try {
      const datos = await global.Api.post("/incidentes/historial", Object.assign({}, state.filtros, { pagina: state.pagina, limite: LIMITE }));
      if (pedido !== state.pedido) return;
      state.items = datos.items || [];
      state.total = datos.total || 0;
      state.paginas = datos.paginas || 1;
      state.limite = datos.limite || LIMITE;   // el servidor decide el tamaño real de la página
      state.cargado = true;
      if (state.pagina > state.paginas) {    // la última página quedó vacía (p. ej. al cambiar los datos)
        state.pagina = state.paginas;
        return cargar();
      }
    } catch (error) {
      if (pedido !== state.pedido) return;
      if (!global.Api.session()) return;     // sesión cerrada: Api ya redirigió
      state.error = error && error.message ? error.message : MSG_ERROR;
    }
    state.cargando = false;
    pintarResultados();
  }

  function buscar(evento) {
    if (evento) evento.preventDefault();
    const valores = {};
    CAMPOS.forEach(campo => { valores[campo] = state.controles[campo].value; });
    const filtros = armarFiltros(valores);
    const problema = errorDeFiltros(filtros);
    state.controles.aviso.textContent = problema;
    state.controles.aviso.hidden = !problema;
    if (problema) return;
    state.filtros = filtros;
    state.pagina = 1;
    cargar();
  }

  function limpiar() {
    CAMPOS.forEach(campo => { state.controles[campo].value = ""; });
    state.controles.aviso.hidden = true;
    state.filtros = {};
    state.pagina = 1;
    cargar();
  }

  function irAPagina(numero) {
    state.pagina = Math.min(Math.max(1, numero), state.paginas);
    cargar();
  }

  /* ---------- dibujo ---------- */

  function construir() {
    const c = state.controles;
    c.desde = h("input", { type: "date", id: "hi-desde" });
    c.hasta = h("input", { type: "date", id: "hi-hasta" });
    c.tipo = h("select", { id: "hi-tipo" }, opciones(TIPOS, "Todos"));
    c.severidad = h("select", { id: "hi-severidad" }, opciones(SEVERIDADES, "Todas"));
    c.estado = h("select", { id: "hi-estado" }, opciones(ESTADOS, "Todos"));
    c.ruta = h("input", { type: "search", id: "hi-ruta", maxlength: "80", placeholder: "Nombre o código" });
    c.aviso = h("p", { class: "hi-aviso", role: "alert", hidden: true });
    c.contador = h("strong", { "aria-live": "polite" }, "–");
    const campo = (texto, id, control) => h("div", { class: "hi-campo" }, h("label", { for: id }, texto), control);

    const formulario = h("form", { class: "hi-filtros", onsubmit: buscar, "aria-label": "Filtros del historial" },
      campo("Desde", "hi-desde", c.desde), campo("Hasta", "hi-hasta", c.hasta),
      campo("Tipo", "hi-tipo", c.tipo), campo("Severidad", "hi-severidad", c.severidad),
      campo("Estado", "hi-estado", c.estado), campo("Ruta", "hi-ruta", c.ruta),
      h("div", { class: "hi-acciones" },
        h("button", { type: "submit", class: "hi-primario" }, "Buscar"),
        h("button", { type: "button", class: "hi-secundario", onclick: limpiar }, "Limpiar")),
      c.aviso);

    state.resultados = h("div", { class: "hi-resultados" });
    state.pie = h("nav", { class: "hi-pie", "aria-label": "Páginas del historial" });
    state.contenedor.replaceChildren(
      h("header", { class: "hi-cabecera" },
        h("div", {}, h("span", { class: "hi-kicker" }, "CENTRO DE CONTROL"), h("h2", {}, "Historial de incidentes"),
          h("p", {}, "Todos los incidentes registrados, atendidos o no, para consultarlos y analizarlos después.")),
        h("div", { class: "hi-contador" }, c.contador)),
      formulario, state.resultados, state.pie);
  }

  function pintarResultados() {
    const partes = [];
    if (state.error) {
      partes.push(h("div", { class: "hi-error", role: "alert" },
        h("div", {}, h("strong", {}, state.error),
          state.cargado ? h("small", {}, "Se muestra la última información cargada.") : null),
        h("button", { type: "button", onclick: cargar }, "Reintentar")));
    }
    if (!state.cargado && !state.error) partes.push(h("p", { class: "hi-estado", role: "status" }, "Cargando historial…"));
    const vacio = textoVacio({ cargado: state.cargado, error: state.error, items: state.items, filtros: state.filtros });
    if (vacio) {
      partes.push(h("p", { class: "hi-estado", role: "status" }, vacio,
        hayFiltros(state.filtros) ? h("button", { type: "button", class: "hi-enlace", onclick: limpiar }, "Limpiar filtros") : null));
    }
    if (state.items.length) {
      partes.push(h("ul", { class: "hi-lista" + (state.cargando ? " hi-cargando" : "") }, state.items.map(tarjeta)));
    }
    state.resultados.replaceChildren(...partes);
    state.controles.contador.textContent = state.cargado ? textoContador(state.total) : "–";
    pintarPie();
  }

  function pintarPie() {
    if (!state.cargado || !state.items.length) { state.pie.replaceChildren(); return; }
    state.pie.replaceChildren(
      h("span", {}, textoRango(state.pagina, state.limite, state.items.length, state.total)),
      h("div", {},
        h("button", { type: "button", class: "hi-secundario", disabled: state.pagina <= 1 || state.cargando, onclick: () => irAPagina(state.pagina - 1) }, "Anterior"),
        h("span", { class: "hi-pagina" }, "Página " + state.pagina + " de " + state.paginas),
        h("button", { type: "button", class: "hi-secundario", disabled: state.pagina >= state.paginas || state.cargando, onclick: () => irAPagina(state.pagina + 1) }, "Siguiente")));
  }

  function tarjeta(item) {
    return h("li", {},
      h("button", { type: "button", class: "hi-tarjeta hi-sev-" + item.severidad, onclick: () => abrirDetalle(item.id) },
        h("span", { class: "hi-fila" },
          h("strong", {}, item.tipo_etiqueta),
          h("span", { class: "hi-chip" }, item.severidad_etiqueta),
          h("span", { class: "hi-chip hi-estado-" + item.estado }, item.estado_etiqueta)),
        h("span", { class: "hi-linea" }, item.ruta + " · Conductor: " + item.conductor),
        h("small", {}, fecha(item.fecha) + " · Origen: " + item.origen_etiqueta)));
  }

  /* ---------- detalle ---------- */

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
      datos = await global.Api.post("/incidentes/historial/detalle", { id });
    } catch (error) {
      state.error = (error && error.message) || "No se pudo cargar el detalle del incidente";
      pintarResultados();
      return;
    }
    const i = datos.incidente;
    const filas = [
      ["Fecha y hora", fecha(i.fecha)], ["Registrado", fecha(i.registrado_en)], ["Viaje", i.viaje], ["Ruta", i.ruta],
      ["Conductor", i.conductor], ["Tipo de incidente", i.tipo_etiqueta], ["Severidad", i.severidad_etiqueta],
      ["Origen", i.origen_etiqueta], ["Estado", i.estado_etiqueta], ["Descripción", i.descripcion || "—"],
      ["Ubicación", i.lat + ", " + i.lng]
    ];
    if (i.estado === "atendida") filas.push(["Atendido", fecha(i.atendido_en)], ["Comentario", i.comentario || "—"]);
    const mapa = h("div", { class: "hi-mapa", role: "img", "aria-label": "Ubicación del incidente en el mapa" });
    const auditoria = (datos.auditoria || []).map(a =>
      h("li", {}, h("strong", {}, a.accion_etiqueta), " · " + (a.usuario_nombre || "—") + " · " + fecha(a.fecha) + (a.comentario ? " · " + a.comentario : "")));

    state.modal = h("div", { class: "hi-fondo", onclick: evento => { if (evento.target === state.modal) cerrarDetalle(); } },
      h("section", { class: "hi-modal hi-sev-" + i.severidad, role: "dialog", "aria-modal": "true", "aria-labelledby": "hi-titulo" },
        h("button", { type: "button", class: "hi-cerrar", "aria-label": "Cerrar", onclick: cerrarDetalle }, "×"),
        h("h3", { id: "hi-titulo" }, i.tipo_etiqueta + " · " + i.severidad_etiqueta),
        h("dl", { class: "hi-datos" }, filas.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
        mapa,
        h("div", {}, h("h4", {}, "Auditoría"),
          auditoria.length ? h("ul", { class: "hi-auditoria" }, auditoria) : h("p", { class: "hi-nota" }, "Este incidente es anterior a la auditoría: no tiene movimientos guardados."))));
    document.body.append(state.modal);
    document.addEventListener("keydown", alTeclear);

    if (global.L && i.lat != null && i.lng != null) {
      state.mapa = global.L.map(mapa).setView([i.lat, i.lng], 15);
      global.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(state.mapa);
      global.L.marker([i.lat, i.lng]).addTo(state.mapa);
      global.setTimeout(() => state.mapa && state.mapa.invalidateSize(), 60);
    } else {
      mapa.textContent = "No se pudo cargar el mapa. Ubicación: " + i.lat + ", " + i.lng;
    }
  }

  /* ---------- API pública ---------- */

  function mount(contenedor) {
    if (!contenedor) throw new Error("No se encontró el contenedor del historial de incidentes.");
    if (state.contenedor !== contenedor) {
      state.contenedor = contenedor;
      construir();
    }
    cargar();
    return { reload: cargar };
  }

  global.HistorialIncidentes = { mount, util: { armarFiltros, hayFiltros, errorDeFiltros, textoVacio, textoRango, textoContador, LIMITE, MSG_ERROR } };
})(window);
