/* =====================================================================
   CENTRO DE CONTROL DE RUTAS — SERSAPROSA   (window.CentroRutas)

   Encabezado y lista de pedidos de "Planificar rutas", al estilo de un centro de
   control de reparto: rutas de hoy, estado, acciones (editar, asignar, desasignar,
   invertir, optimizar, historial), cuatro tarjetas de resumen y la lista de pedidos
   con su hora estimada de llegada (ETA). El mapa y el cálculo del recorrido siguen en
   dashboard.js; este módulo recibe sus resultados con update() y le avisa con opciones.

   Se vincula con el resto del sistema:
     Pedidos            → los pedidos de una ruta son las entregas cuyo campo `ruta` = nombre
     Empleados/Vehículos→ asignar y desasignar usan /disponibilidad/asignar y /desasignar
     Riesgo / Eventos   → la tarjeta de alertas cuenta los eventos que cruzan el recorrido
     Notificaciones     → sin leer de la ruta, y su historial

   Uso (ver dashboard.js):
     const centro = CentroRutas.mount(encabezadoEl, {
       taskContainer: listaEl, post, onSelectRoute(ruta|null), onReorder("reverse"|"optimize"),
       onPreviewOrder(ids), onClearPreview(),
       onFocusStop(i), onGoTo(pantalla), onChanged(), onSave(), onNewTrip(), onEditTrip(ruta), onReviewRoute(ruta), onAcceptProposal(ruta), selection (Pedidos.store),
       originNode (fila «Inicio de ruta» que se coloca al inicio de la lista)
     });
     centro.update({ deliveries, orders, result, originLabel, events, notifications });
   ===================================================================== */
(function (global) {
  "use strict";

  const ROL = "coordinador_rutas";
  const QUICK_GUARDS = 1;
  const ESTADOS_RUTA = { borrador: "Borrador", sin_asignar: "Sin asignar", asignada: "Asignada", en_curso: "En curso", completada: "Completada" };
  const ESTADOS_PEDIDO = { pendiente: "Pendiente", proceso: "En proceso", completada: "Completado" };
  const WIDGETS_KEY = "centroRutasWidgets";

  /* ============ Reglas puras (se prueban sin pantalla) ============ */
  const norm = texto => String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
  const enCurso = p => !!p && p.estado !== "completada";
  const tieneUbicacion = p => !!p && p.lat != null && p.lng != null &&
    Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) &&
    Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lng)) <= 180;
  const porHora = (a, b) => String(a.hora || "").localeCompare(String(b.hora || ""));

  // Los pedidos de una ruta guardada son las entregas marcadas con su nombre.
  function pedidosDeRuta(entregas, ruta) {
    const nombre = norm(ruta && ruta.nombre);
    return nombre ? (entregas || []).filter(p => norm(p.ruta) === nombre) : [];
  }

  // Orden de visita: primero el guardado (ids), luego por hora programada.
  function aplicarOrden(pedidos, ids) {
    const base = (pedidos || []).slice().sort(porHora);
    if (!Array.isArray(ids) || !ids.length) return base;
    const pos = new Map(ids.map((id, i) => [String(id), i]));
    const lugar = p => (pos.has(String(p.id)) ? pos.get(String(p.id)) : 1e9);
    return base.sort((a, b) => lugar(a) - lugar(b) || porHora(a, b));
  }

  function moverPedido(ids, id, destino) {
    const orden = (ids || []).map(String);
    const origen = orden.indexOf(String(id)), nuevo = orden.indexOf(String(destino));
    if (origen < 0 || nuevo < 0 || origen === nuevo) return orden;
    orden.splice(nuevo, 0, orden.splice(origen, 1)[0]);
    return orden;
  }

  function mismoOrden(a, b) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((id, i) => String(id) === String(b[i]));
  }

  function nivelRiesgo(score) {
    return score >= 4 ? "alto" : score >= 1.5 ? "medio" : "bajo";
  }

  function distanciaKm(a, b) {
    const rad = x => x * Math.PI / 180;
    const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Optimizar: siempre el pedido más cercano al punto actual (vecino más cercano). Los que no
  // tienen coordenadas quedan al final porque no se pueden trazar.
  function ordenarVecinoCercano(origen, pedidos) {
    const resto = (pedidos || []).filter(tieneUbicacion);
    const sin = (pedidos || []).filter(p => !tieneUbicacion(p));
    const orden = [];
    let actual = origen;
    while (resto.length) {
      let mejor = 0, minima = Infinity;
      resto.forEach((p, i) => {
        const d = distanciaKm(actual, [Number(p.lat), Number(p.lng)]);
        if (d < minima) { minima = d; mejor = i; }
      });
      const [elegido] = resto.splice(mejor, 1);
      orden.push(elegido);
      actual = [Number(elegido.lat), Number(elegido.lng)];
    }
    return orden.concat(sin);
  }

  function resumenPedidos(pedidos) {
    const lista = pedidos || [];
    return {
      total: lista.length,
      pendientes: lista.filter(p => p.estado === "pendiente").length,
      proceso: lista.filter(p => p.estado === "proceso").length,
      completados: lista.filter(p => p.estado === "completada").length,
      sinUbicacion: lista.filter(p => enCurso(p) && !tieneUbicacion(p)).length
    };
  }

  // Estado de una ruta guardada según sus pedidos y si ya tiene personal asignado.
  function estadoRuta(pedidos, asignada) {
    const r = resumenPedidos(pedidos);
    if (r.total > 0 && r.completados === r.total) return "completada";
    if (asignada && (r.proceso > 0 || r.completados > 0)) return "en_curso";
    return asignada ? "asignada" : "sin_asignar";
  }

  // Hora estimada de llegada a cada parada: salida + suma de las duraciones de los tramos (segundos).
  function calcularEtas(inicioMs, tramos) {
    let t = inicioMs;
    return (tramos || []).map(tramo => { t += (Number(tramo && tramo.duration) || 0) * 1000; return t; });
  }

  // Minutos de retraso de una llegada estimada frente a la hora programada "HH:MM" (0 si no hay).
  function minutosTarde(etaMs, hora) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hora || ""));
    if (!m || etaMs == null) return 0;
    const programada = new Date(etaMs);
    programada.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return Math.max(0, Math.round((etaMs - programada.getTime()) / 60000));
  }

  /* ============ Utilidades de pantalla ============ */
  const SVG_NS = "http://www.w3.org/2000/svg";
  function h(tag, attrs, ...kids) {
    const e = global.document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "checked" || k === "disabled" || k === "selected" || k === "value") e[k] = v;
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null) e.append(typeof c === "number" ? String(c) : c);
    return e;
  }
  function donut(porcentaje) {
    const r = 42, c = 2 * Math.PI * r;
    const svg = global.document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("class", "cc-donut");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", porcentaje + "% entregado");
    const circulo = (clase, extra) => {
      const node = global.document.createElementNS(SVG_NS, "circle");
      node.setAttribute("cx", "50"); node.setAttribute("cy", "50"); node.setAttribute("r", String(r));
      node.setAttribute("fill", "none"); node.setAttribute("stroke-width", "10"); node.setAttribute("class", clase);
      Object.keys(extra || {}).forEach(k => node.setAttribute(k, extra[k]));
      return node;
    };
    svg.append(circulo("cc-donut-track"), circulo("cc-donut-fill", {
      "stroke-dasharray": (c * porcentaje / 100) + " " + c, "stroke-linecap": "round", transform: "rotate(-90 50 50)"
    }));
    const texto = global.document.createElementNS(SVG_NS, "text");
    texto.setAttribute("x", "50"); texto.setAttribute("y", "55"); texto.setAttribute("text-anchor", "middle");
    texto.setAttribute("class", "cc-donut-text");
    texto.textContent = porcentaje + "%";
    const sub = global.document.createElementNS(SVG_NS, "text");
    sub.setAttribute("x", "50"); sub.setAttribute("y", "68"); sub.setAttribute("text-anchor", "middle");
    sub.setAttribute("class", "cc-donut-sub"); sub.textContent = "entregado";
    texto.setAttribute("y", "52");
    svg.append(texto, sub);
    return svg;
  }
  const hora = ms => new Date(ms).toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit" });
  const fechaHora = valor => {
    const d = new Date(valor);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-SV") + " " + hora(d.getTime());
  };

  /* ============ Componente ============ */
  function mount(container, options) {
    const opts = Object.assign({ post: null, taskContainer: null }, options || {});
    const taskBox = opts.taskContainer;
    let sesion = null;
    try { sesion = JSON.parse(global.sessionStorage.getItem("session") || "null"); } catch (e) { sesion = null; }
    const coordinador = !!sesion && sesion.role === ROL;
    const S = {
      rutas: [], rutasError: "", disp: null, dispError: "",
      deliveries: [], orders: [], result: null, originLabel: "", events: [], notifs: null,
      activeId: null, inicioMs: Date.now(), vista: [], retrasoMax: 0,
      widgets: true, filtro: "todos", q: "", mensaje: null, ocupado: false, editing: null
    };
    try { S.widgets = global.localStorage.getItem(WIDGETS_KEY) !== "cerrado"; } catch (e) { /* por defecto abiertas */ }
    container.classList.add("cc");
    let modalActivo = null;
    let vivo = true;

    const activa = () => S.rutas.find(r => r.id === S.activeId) || null;
    const asignacionDe = ruta => (ruta && S.disp ? S.disp.asg.find(a => a.ruta === ruta.id) || null : null);
    const nombreDe = (lista, id, clave) => { const x = lista.find(e => e.id === id); return x ? x[clave] : id; };

    // En borrador la lista incluye los pedidos en curso aún sin elegir (con casilla) para poder armar la ruta ahí mismo.
    const esBorrador = () => !activa() && !!opts.selection;
    function derivar() {
      const trazados = S.orders.filter(p => enCurso(p) && tieneUbicacion(p));
      const tramos = (S.result && S.result.raw && Array.isArray(S.result.raw.legs)) ? S.result.raw.legs : [];
      const etas = calcularEtas(S.inicioMs, tramos);
      S.vista = S.orders.map(p => {
        const i = trazados.indexOf(p);
        const eta = i >= 0 && etas[i] ? etas[i] : null;
        return { p, i, eta, tarde: eta ? minutosTarde(eta, p.hora) : 0, sel: true };
      });
      S.retrasoMax = S.vista.reduce((m, v) => Math.max(m, v.tarde), 0);
      S.nTarde = S.vista.filter(v => v.tarde > 0).length;
      if (esBorrador()) {
        const elegidos = new Set(S.orders.map(p => String(p.id)));
        S.vista = S.vista.concat(S.deliveries.filter(p => enCurso(p) && !elegidos.has(String(p.id))).sort(porHora)
          .map(p => ({ p, i: -1, eta: null, tarde: 0, sel: false })));
      }
    }

    /* ---- datos propios: rutas de hoy y disponibilidad ---- */
    async function cargarRutas() {
      if (!coordinador || !opts.post) return;
      try {
        const r = await opts.post("/rutas/listar", {});
        S.rutas = Array.isArray(r.rutas) ? r.rutas : [];
        S.rutasError = "";
        if (S.activeId && !activa()) S.activeId = null;
      } catch (error) {
        S.rutasError = error.message || "No se pudieron cargar las rutas.";
      }
    }
    async function cargarDisp() {
      if (!coordinador || !opts.post || !global.Disponibilidad) return;
      try {
        S.disp = global.Disponibilidad.normalize(await opts.post("/disponibilidad/listar", {}));
        S.dispError = "";
      } catch (error) {
        S.dispError = error.message || "No se pudo cargar la disponibilidad.";
      }
    }
    async function refresh() {
      await Promise.all([cargarRutas(), cargarDisp()]);
      if (vivo) render();
    }

    function aviso(tipo, texto) { S.mensaje = texto ? { tipo, texto } : null; render(); }

    /* ---- ventanas (modales) ---- */
    function cerrarModal() {
      if (modalActivo) { modalActivo.remove(); modalActivo = null; }
      global.document.removeEventListener("keydown", teclaEsc);
    }
    function teclaEsc(e) { if (e.key === "Escape") cerrarModal(); }
    function abrirModal(titulo, cuerpo, acciones) {
      cerrarModal();
      const caja = h("div", { class: "cc-modal", role: "dialog", "aria-modal": "true", "aria-label": titulo },
        h("div", { class: "cc-modal-head" }, h("h3", {}, titulo),
          h("button", { type: "button", class: "cc-x", "aria-label": "Cerrar", onclick: cerrarModal }, "×")),
        h("div", { class: "cc-modal-body" }, cuerpo),
        acciones ? h("div", { class: "cc-modal-actions" }, acciones) : null);
      modalActivo = h("div", { class: "cc-backdrop", onclick: e => { if (e.target === modalActivo) cerrarModal(); } }, caja);
      global.document.body.append(modalActivo);
      global.document.addEventListener("keydown", teclaEsc);
      const primero = caja.querySelector("input, select, button.cc-primary");
      if (primero) primero.focus();
      return caja;
    }
    function errorEn(caja, texto) {
      let p = caja.querySelector(".cc-modal-error");
      if (!p) { p = h("p", { class: "cc-modal-error", role: "alert" }); caja.querySelector(".cc-modal-body").append(p); }
      p.textContent = texto;
    }

    async function tras(cambio) {
      await refresh();
      if (typeof opts.onChanged === "function") await opts.onChanged(cambio || {});
    }

    /* ---- acciones ---- */
    function editarOrden() {
      const ruta = activa();
      if (!ruta) return;
      if (asignacionDe(ruta) || ruta.conductor) {
        aviso("error", asignacionDe(ruta) ? "La ruta ya salió (tiene conductor asignado). Desasígnala antes de editar."
          : "La ruta conserva un conductor sin asignación vigente. Usa «Liberar ruta» y vuelve a intentarlo.");
        return;
      }
      const ids = S.orders.filter(enCurso).map(p => String(p.id));
      if (!ids.length) {
        aviso("error", "No se puede dejar la ruta sin pedidos.");
        return;
      }
      S.filtro = "todos";
      S.q = "";
      S.editing = { routeId: ruta.id, baseIds: ids.slice(), ids, error: "", retryIds: null, saving: false,
        completedOrders: S.orders.filter(p => p.estado === "completada") };
      render();
      preview(ids);
    }

    function preview(ids) {
      const editing = S.editing;
      if (!editing) return;
      if (!ids.length) {
        editing.error = "No se puede dejar la ruta sin pedidos.";
        editing.retryIds = null;
        render();
        return;
      }
      const requestId = (editing.previewRequest || 0) + 1;
      editing.previewRequest = requestId;
      editing.retryIds = ids.slice();
      editing.calculating = true;
      editing.retrySave = false;
      editing.reloadNeeded = false;
      editing.error = "";
      render();
      Promise.resolve(typeof opts.onPreviewOrder === "function" ? opts.onPreviewOrder(ids.slice()) : null)
        .then(() => {
          if (S.editing !== editing || editing.previewRequest !== requestId) return;
          editing.ids = ids.slice();
          S.orders = ids.map(id => S.deliveries.find(p => String(p.id) === id)).filter(Boolean)
            .concat(editing.completedOrders);
          editing.retryIds = null;
          editing.calculating = false;
          editing.error = "";
          render();
        })
        .catch(error => {
          if (S.editing !== editing || editing.previewRequest !== requestId) return;
          editing.calculating = false;
          editing.error = error.message || "No se pudo calcular la ruta nueva.";
          render();
        });
    }

    function cambiarOrden(ids) {
      const editing = S.editing;
      if (!editing || editing.saving) return;
      const sinUbicacion = ids.map(id => S.deliveries.find(p => String(p.id) === id))
        .find(p => p && !tieneUbicacion(p));
      if (sinUbicacion) {
        editing.error = "El pedido «" + (sinUbicacion.cliente || sinUbicacion.id) + "» no tiene ubicación y no se agregó.";
        editing.retryIds = null;
        render();
        return;
      }
      preview(ids);
    }

    function cancelarEdicion() {
      S.editing = null;
      const ruta = activa();
      S.orders = aplicarOrden(pedidosDeRuta(S.deliveries, ruta), ruta && ruta.orden_pedidos);
      if (typeof opts.onClearPreview === "function") opts.onClearPreview();
      render();
    }

    async function guardarOrden(reintentar) {
      const editing = S.editing;
      const ruta = activa();
      if (!editing || !ruta || editing.saving) return;
      if (reintentar && editing.retryIds) {
        preview(editing.retryIds);
        return;
      }
      if (mismoOrden(editing.ids, editing.baseIds)) {
        editing.error = "No hay cambios que guardar.";
        render();
        return;
      }
      if (!editing.ids.length) {
        editing.error = "No se puede dejar la ruta sin pedidos.";
        render();
        return;
      }
      const resultado = S.result;
      if (!resultado) {
        editing.error = "No hay un cálculo válido para guardar. Reintenta el cálculo.";
        editing.retryIds = editing.ids.slice();
        render();
        return;
      }
      const riesgo = nivelRiesgo(resultado.riskScore);
      if (riesgo === "alto" && !global.confirm("La ruta nueva pasa por una zona de riesgo alto. ¿Deseas continuar y guardar?")) return;
      editing.saving = true;
      editing.error = "";
      render();
      try {
        await opts.post("/rutas/editar-orden", {
          id: ruta.id,
          pedidos: editing.ids,
          version: ruta.version || 1,
          distancia_km: resultado.distanceKm,
          duracion_min: resultado.durationMin,
          riesgo_ruta: riesgo
        });
        S.editing = null;
        await tras({ seleccionar: ruta.id });
        if (typeof opts.onClearPreview === "function") await opts.onClearPreview();
        aviso("ok", "El orden de la ruta se guardó correctamente.");
      } catch (error) {
        if (S.editing !== editing) return;
        editing.error = error.message || "No se pudo guardar la edición.";
        editing.saving = false;
        editing.reloadNeeded = /la ruta cambió|ya salió/i.test(editing.error);
        editing.retrySave = !editing.reloadNeeded;
        render();
      }
    }

    async function reabrirRuta() {
      const ruta = activa();
      S.editing = null;
      if (typeof opts.onClearPreview === "function") await opts.onClearPreview();
      await tras({ seleccionar: ruta && ruta.id });
      aviso("error", "La ruta cambió, vuelve a abrirla.");
    }

    async function abrirAsignar() {
      const ruta = activa();
      if (!ruta) return;
      await cargarDisp();
      if (!S.disp) { aviso("error", S.dispError || "No se pudo cargar la disponibilidad."); return; }
      const D = S.disp;
      const opcion = (lista, texto) => lista.filter(x => x.disp.ok).map(x => h("option", { value: x.id }, texto(x)));
      const conductor = h("select", { class: "cc-input", "aria-label": "Conductor" }, h("option", { value: "" }, "Elegir conductor…"), opcion(D.drivers, x => x.nombre));
      const vehiculo = h("select", { class: "cc-input", "aria-label": "Vehículo" }, h("option", { value: "" }, "Elegir vehículo…"), opcion(D.vehicles, x => x.placa + " · " + (x.tipo || "")));
      const guardias = D.guards.filter(x => x.disp.ok);
      const marcas = new Map();
      const listaG = guardias.length
        ? h("ul", { class: "cc-checklist" }, guardias.map(g => {
            const caja = h("input", { type: "checkbox" }); marcas.set(g.id, caja);
            return h("li", {}, h("label", {}, caja, h("span", {}, h("strong", {}, g.nombre), h("small", {}, g.id))));
          }))
        : h("p", { class: "cc-hint" }, "No hay guardias disponibles (es opcional).");
      const asignar = h("button", { type: "button", class: "cc-btn cc-primary" }, "Asignar a esta ruta");
      const rapida = h("button", { type: "button", class: "cc-btn" }, "⚡ Asignación rápida");
      const caja = abrirModal("Asignar «" + ruta.nombre + "»", [
        h("label", { class: "cc-field" }, h("span", {}, "Conductor"), conductor),
        h("label", { class: "cc-field" }, h("span", {}, "Vehículo"), vehiculo),
        h("div", { class: "cc-field" }, h("span", {}, "Guardias (opcional)"), listaG)],
      [rapida, h("button", { type: "button", class: "cc-btn", onclick: cerrarModal }, "Cancelar"), asignar]);
      async function enviar(c, v, g) {
        try {
          await opts.post("/disponibilidad/asignar", { conductor: c, vehiculo: v, ruta: ruta.id, guardias: g });
          cerrarModal();
          aviso("ok", "Ruta asignada: " + nombreDe(D.drivers, c, "nombre") + " · " + nombreDe(D.vehicles, v, "placa") +
            (g.length ? " · " + g.length + " guardia" + (g.length > 1 ? "s" : "") : "") + ".");
          await tras({ seleccionar: ruta.id });
        } catch (error) {
          errorEn(caja, error.message);
          asignar.disabled = rapida.disabled = false;
        }
      }
      asignar.addEventListener("click", () => {
        if (!conductor.value || !vehiculo.value) { errorEn(caja, "Elige un conductor y un vehículo."); return; }
        asignar.disabled = rapida.disabled = true;
        enviar(conductor.value, vehiculo.value, [...marcas].filter(([, c]) => c.checked).map(([id]) => id));
      });
      rapida.addEventListener("click", () => {
        const c = D.drivers.find(x => x.disp.ok), v = D.vehicles.find(x => x.disp.ok);
        if (!c || !v) { errorEn(caja, "No hay " + (!c ? "conductor" : "vehículo") + " disponible."); return; }
        const gs = guardias.slice(0, QUICK_GUARDS);
        if (!global.confirm("Asignación rápida\n\nConductor: " + c.nombre + "\nVehículo: " + v.placa +
          "\nGuardias: " + (gs.length ? gs.map(x => x.nombre).join(", ") : "ninguno disponible") + "\n\n¿Confirmar?")) return;
        asignar.disabled = rapida.disabled = true;
        enviar(c.id, v.id, gs.map(x => x.id));
      });
    }

    async function desasignar() {
      const ruta = activa();
      if (!ruta || !global.confirm("¿Quitar la asignación de «" + ruta.nombre + "»?\nConductor, guardias y vehículo quedan disponibles otra vez.")) return;
      try {
        const r = await opts.post("/disponibilidad/desasignar", { ruta: ruta.id });
        aviso("ok", r && r.reparada ? "Ruta liberada: tenía un conductor guardado sin asignación vigente. Ya puedes asignarla."
          : "Asignación quitada: el personal y el vehículo vuelven a estar disponibles.");
        await tras({ seleccionar: ruta.id });
      } catch (error) {
        aviso("error", error.message);
      }
    }

    async function abrirHistorial() {
      const ruta = activa();
      if (!ruta) return;
      const cuerpo = h("div", {}, h("p", { class: "cc-hint" }, "Cargando historial…"));
      abrirModal("Historial de «" + ruta.nombre + "»", cuerpo);
      const eventos = [];
      const a = asignacionDe(ruta);
      if (a) eventos.push({ fecha: a.fecha, texto: "Ruta asignada a " + nombreDe(S.disp.drivers, a.conductor, "nombre") + " (" + nombreDe(S.disp.vehicles, a.vehiculo, "placa") + ")", quien: a.usuario });
      let aviso404 = "";
      try {
        const n = await opts.post("/notificaciones/listar", {});
        const propias = (n.items || []).filter(x => norm(x.ruta) === norm(ruta.nombre));
        propias.forEach(x => eventos.push({ fecha: x.creada_en || x.fecha, texto: "Notificación: " + x.titulo, quien: "Sistema" }));
        (n.audit || []).filter(x => x.accion === "leida" && norm(x.ruta) === norm(ruta.nombre))
          .forEach(x => eventos.push({ fecha: x.fecha, texto: "Notificación leída: " + x.titulo, quien: x.usuario }));
      } catch (error) {
        aviso404 = "No se pudieron cargar las notificaciones de esta ruta.";
      }
      try {
        const respuesta = await opts.post("/rutas/historial-edicion", { id: ruta.id });
        (respuesta.movimientos || []).forEach(movimiento => {
          const antes = movimiento.antes || {};
          const despues = movimiento.despues || {};
          eventos.push({
            fecha: movimiento.fecha,
            texto: "Orden editado: " + (antes.pedidos || []).length + " → " + (despues.pedidos || []).length +
              " pedidos · " + Number(despues.distancia_km || 0).toFixed(1) + " km · " +
              Math.round(Number(despues.duracion_min || 0)) + " min · riesgo " + (despues.riesgo_ruta || "sin datos"),
            detalle: (antes.pedidos || []).join(" → ") + "  ⟶  " + (despues.pedidos || []).join(" → "),
            quien: movimiento.usuario
          });
        });
      } catch (error) {
        aviso404 = "No se pudo cargar el historial de movimientos de la ruta.";
      }
      if (ruta.viaje) {
        try {
          const r = await opts.post("/rutas/rechazos", { ruta_id: ruta.id });
          (r.rechazos || []).forEach(x => eventos.push({
            fecha: x.fecha, quien: x.usuario,
            texto: "Ruta rechazada: " + x.motivo + (x.comentario ? " (" + x.comentario + ")" : "") +
              (x.resultado === "generada" ? " · se generó una alternativa" : x.resultado === "sin_alternativa" ? " · sin alternativa disponible" : "")
          }));
        } catch (error) {
          aviso404 = aviso404 || "No se pudo cargar el historial de rechazos.";
        }
      }
      eventos.sort((x, y) => new Date(y.fecha) - new Date(x.fecha));
      cuerpo.replaceChildren(
        eventos.length
          ? h("ol", { class: "cc-timeline" }, eventos.map(e => h("li", {}, h("small", {}, fechaHora(e.fecha)), h("strong", {}, e.texto),
            e.detalle ? h("span", {}, e.detalle) : null, h("span", {}, e.quien || ""))))
          : h("p", { class: "cc-hint" }, "Todavía no hay movimientos registrados para esta ruta."),
        aviso404 ? h("p", { class: "cc-modal-error" }, aviso404) : null);
    }

    function reordenar(tipo) {
      if (typeof opts.onReorder === "function") opts.onReorder(tipo, S.orders.filter(enCurso));
    }

    /* ---- encabezado ---- */
    function boton(texto, icono, accion, desactivado, titulo, clase) {
      return h("button", { type: "button", class: "cc-btn" + (clase ? " " + clase : ""), disabled: !!desactivado, title: titulo || "", onclick: accion },
        h("span", { "aria-hidden": "true", class: "cc-ico" }, icono), texto);
    }

    // Selector de rutas (la flecha ← de la cabecera): lista las rutas de hoy y "Nueva ruta".
    let selectorAbierto = false;
    function renderSelector() {
      const lista = h("ul", { class: "cc-switch-list", role: "menu" },
        S.rutas.map(x => {
          const est = estadoRuta(pedidosDeRuta(S.deliveries, x), !!asignacionDe(x));
          return h("li", { role: "none" }, h("button", { type: "button", role: "menuitem", class: "cc-switch-item" + (x.id === S.activeId ? " is-active" : ""),
            onclick: () => { selectorAbierto = false; opts.onSelectRoute && opts.onSelectRoute(x); render(); } },
          h("i", { class: "cc-dot cc-" + est, "aria-hidden": "true" }), h("span", {}, x.nombre), h("small", {}, ESTADOS_RUTA[est])));
        }),
        h("li", { role: "none" }, h("button", { type: "button", role: "menuitem", class: "cc-switch-item cc-switch-new" + (!S.activeId ? " is-active" : ""),
          onclick: () => { selectorAbierto = false; opts.onSelectRoute && opts.onSelectRoute(null); render(); } }, "＋ Nueva ruta")));
      return h("div", { class: "cc-switch", role: "region", "aria-label": "Rutas de hoy" },
        S.rutasError ? h("p", { class: "cc-warn", role: "status" }, "⚠ " + S.rutasError) : null,
        S.rutas.length ? null : h("p", { class: "cc-hint" }, "Todavía no hay rutas guardadas hoy."), lista);
    }

    // Las rutas de la IA se asignan después de aceptar su propuesta (asignar_ruta_operativa lo exige);
    // las rechazadas no se asignan hasta generar una alternativa o aceptarla.
    function propuestaDe(ruta) {
      const rechazada = !!ruta && ruta.estado_propuesta === "rechazada";
      const sinAceptar = !!ruta && !!ruta.viaje && !!ruta.estado_propuesta && !rechazada && ruta.estado_propuesta !== "aceptada";
      return { rechazada, sinAceptar };
    }

    function renderCabecera() {
      const ruta = activa();
      const a = asignacionDe(ruta);
      // Sin depender de estados fantasma: la asignación vigente manda; un conductor guardado sin ella se puede liberar.
      const fantasma = !!ruta && !a && !!S.disp && !!String(ruta.conductor || "").trim();
      const { rechazada, sinAceptar } = propuestaDe(ruta);
      const estado = ruta ? estadoRuta(S.orders, !!a) : "borrador";
      const trazados = S.orders.filter(p => enCurso(p) && tieneUbicacion(p)).length;
      const r = S.result;
      const titulo = ruta ? ruta.nombre : "Nueva ruta";
      const etaFinal = S.vista.reduce((m, v) => Math.max(m, v.eta || 0), 0);
      const restante = etaFinal ? Math.max(0, Math.round((etaFinal - Date.now()) / 60000)) : null;
      const metricas = [];
      metricas.push(h("span", {}, S.orders.length + (S.orders.length === 1 ? " pedido" : " pedidos")));
      if (r) metricas.push(h("span", {}, r.distanceKm.toFixed(1) + " km, " + Math.round(r.durationMin) + " min"));
      else if (ruta && ruta.distancia_km != null && ruta.duracion_min != null) {
        metricas.push(h("span", {}, Number(ruta.distancia_km).toFixed(1) + " km, " + Math.round(Number(ruta.duracion_min)) + " min"));
      }
      if (etaFinal) metricas.push(h("span", {}, "Llegada " + hora(etaFinal) + (restante != null ? " · faltan " + restante + " min" : "")));
      if (S.editing && r) metricas.push(h("span", {}, "Riesgo " + nivelRiesgo(r.riskScore)));
      else if (ruta && ruta.riesgo_ruta) metricas.push(h("span", {}, "Riesgo " + ruta.riesgo_ruta));
      else if (ruta && ruta.viaje && ruta.viaje.nivel_riesgo) metricas.push(h("span", {}, "Riesgo " + ruta.viaje.nivel_riesgo));
      if (ruta && ruta.estado_propuesta === "rechazada") metricas.push(h("span", { class: "cc-badge cc-b-rechazada" }, "Ruta rechazada"));
      if (S.retrasoMax) metricas.push(h("span", { class: "cc-late-dot" }, "● " + S.retrasoMax + " min tarde"));
      const nodos = [];
      nodos.push(h("div", { class: "cc-head" },
        h("div", { class: "cc-head-main" },
          h("div", { class: "cc-title" },
            coordinador ? h("button", { type: "button", class: "cc-back", "aria-expanded": String(selectorAbierto), "aria-label": "Cambiar de ruta (rutas de hoy)",
              title: "Rutas de hoy", onclick: () => { selectorAbierto = !selectorAbierto; render(); } }, "←") : null,
            coordinador && opts.onNewTrip ? h("button", { type: "button", class: "cc-back cc-plus", "aria-label": "Nuevo viaje: generar una ruta",
              title: "Nuevo viaje", onclick: () => opts.onNewTrip() }, "+") : null,
            h("h2", {}, titulo),
            h("span", { class: "cc-badge cc-b-" + estado }, ESTADOS_RUTA[estado])),
          h("div", { class: "cc-id" }, ruta && ruta.viaje
            ? "ID " + ruta.id + " · " + ruta.viaje.origen.texto + " → " + ruta.viaje.destino.texto + " · sale " + ruta.viaje.horario
            : ruta ? "ID " + ruta.id + (ruta.zona ? " · " + ruta.zona : "") : "Sin guardar · elige pedidos y guarda la ruta"),
          h("div", { class: "cc-metrics" }, metricas)),
        coordinador ? h("div", { class: "cc-actions" },
          boton("Editar orden", "↕", editarOrden, !ruta || !!a || !!(ruta && ruta.conductor) || !!S.editing,
            a || ruta && ruta.conductor ? "La ruta ya salió (tiene conductor asignado). Desasígnala antes de editar." : "Cambiar manualmente el orden de los pedidos"),
          S.editing ? boton("Guardar orden", "💾", () => guardarOrden(false), S.editing.saving ||
            S.editing.calculating || !!S.editing.retryIds, "Guardar el nuevo orden", "cc-primary") : null,
          S.editing ? boton("Cancelar edición", "×", cancelarEdicion, S.editing.saving, "Descartar los cambios") : null,
          ruta && ruta.viaje && opts.onEditTrip ? boton("Editar viaje", "✎", () => opts.onEditTrip(ruta), !!a,
            a ? "La ruta ya salió: desasígnala para editar el viaje" : "Cambiar origen, destino, horario, carga o monto") : null,
          ruta && ruta.viaje && sinAceptar && opts.onAcceptProposal
            ? boton("Aceptar propuesta", "✓", () => opts.onAcceptProposal(ruta), !!a,
              a ? "La ruta ya tiene asignación" : "Aceptar la propuesta para habilitar la asignación", "cc-primary") : null,
          boton("Asignar ruta", "＋", abrirAsignar, !ruta || !!a || rechazada || sinAceptar,
            !ruta ? "Guarda la ruta primero" : a ? "La ruta ya está asignada" : rechazada ? "La propuesta fue rechazada: genera una alternativa o acéptala"
              : sinAceptar ? "Acepta la propuesta antes de asignarla" : ""),
          fantasma
            ? boton("Liberar ruta", "⊖", desasignar, false, "Tiene un conductor guardado sin asignación vigente: libérala para poder asignarla")
            : boton("Desasignar ruta", "⊖", desasignar, !ruta || !a, a ? "" : "La ruta no tiene asignación"),
          !S.editing ? boton("Invertir orden", "⇅", () => reordenar("reverse"), trazados < 2, "Invierte el orden de visita") : null,
          !S.editing ? boton("Optimizar ruta", "✦", () => reordenar("optimize"), trazados < 2, "Ordena por cercanía desde el inicio") : null,
          boton("Ver historial", "⟲", abrirHistorial, !ruta, ruta ? "" : "Guarda la ruta primero"),
          !ruta && typeof opts.onSave === "function"
            ? boton("Guardar ruta", "💾", () => opts.onSave(), S.orders.length === 0, "Guarda la ruta para asignarla", "cc-primary") : null) : null));
      if (selectorAbierto && coordinador) nodos.push(renderSelector());
      if (fantasma && coordinador) nodos.push(h("p", { class: "cc-msg cc-msg-error", role: "status" },
        "Esta ruta conserva el conductor «" + String(ruta.conductor).trim() + "» pero no tiene asignación vigente hoy. " +
        "Usa «Liberar ruta» para dejarla lista y asignarla de nuevo."));
      if (S.mensaje) nodos.push(h("p", { class: "cc-msg cc-msg-" + S.mensaje.tipo, role: "status" }, S.mensaje.texto));
      if (S.editing && S.editing.error) nodos.push(h("div", { class: "cc-msg cc-msg-error", role: "alert" },
        h("span", {}, S.editing.error),
        S.editing.reloadNeeded ? h("button", { type: "button", class: "cc-btn cc-retry", onclick: reabrirRuta }, "Volver a abrir") :
        S.editing.retrySave || S.editing.retryIds ? h("button", { type: "button", class: "cc-btn cc-retry",
          disabled: S.editing.calculating || S.editing.saving,
          onclick: () => guardarOrden(Boolean(S.editing.retryIds)) }, "Reintentar") : null));
      else if (S.editing && S.editing.calculating) nodos.push(h("p", { class: "cc-msg", role: "status" }, "Calculando la ruta nueva…"));
      return nodos;
    }

    /* ---- tarjetas de resumen ---- */
    function renderWidgets() {
      const ruta = activa();
      const a = asignacionDe(ruta);
      const { rechazada, sinAceptar } = propuestaDe(ruta);
      const alcance = ruta ? S.orders : S.deliveries;
      const res = resumenPedidos(alcance);
      const porcentaje = res.total ? Math.round(res.completados * 100 / res.total) : 0;
      const enCursoN = res.pendientes + res.proceso;
      const sinLeer = S.notifs && Array.isArray(S.notifs.items)
        ? S.notifs.items.filter(n => !n.leida && (!ruta || norm(n.ruta) === norm(ruta.nombre))).length : null;
      const nRiesgo = S.events.length;
      const nTarde = S.nTarde || 0;

      let asignado;
      if (!coordinador) asignado = h("p", { class: "cc-hint" }, "La asignación la gestiona el coordinador de rutas.");
      else if (!ruta) asignado = h("p", { class: "cc-hint" }, "Ruta sin guardar. Guárdala para asignarle conductor, guardias y vehículo.");
      else if (!a && rechazada) asignado = h("p", { class: "cc-hint" }, "La propuesta fue rechazada: genera una alternativa o acéptala antes de asignarla.");
      else if (!a && sinAceptar) asignado = h("p", { class: "cc-hint" }, "Acepta la propuesta para poder asignarla.");
      else if (!a) asignado = h("div", {}, h("p", { class: "cc-hint" }, "Todavía sin conductor ni vehículo."), boton("Asignar ahora", "＋", abrirAsignar, false, "", "cc-primary"));
      else {
        const conductor = S.disp ? nombreDe(S.disp.drivers, a.conductor, "nombre") : a.conductor;
        const veh = S.disp ? S.disp.vehicles.find(x => x.id === a.vehiculo) : null;
        const guardias = a.guardias.map(id => (S.disp ? nombreDe(S.disp.guards, id, "nombre") : id));
        asignado = h("div", { class: "cc-driver" },
          h("div", { class: "cc-avatar", "aria-hidden": "true" }, "🚚"),
          h("div", {},
            h("strong", {}, conductor),
            h("span", { class: "cc-pill" }, estadoRuta(S.orders, true) === "en_curso" ? "En tránsito" : "Asignada"),
            h("small", {}, veh ? veh.placa + " · " + (veh.tipo || "Vehículo") : a.vehiculo),
            h("small", {}, guardias.length ? "Guardias: " + guardias.join(", ") : "Sin guardias"),
            h("small", {}, "Por " + a.usuario + " · " + hora(a.fecha.getTime()))));
      }
      const tarjeta = (titulo, ...contenido) => h("section", { class: "cc-card" }, h("h3", {}, titulo), contenido);
      const tile = (n, texto, clase, onclick) => h(onclick ? "button" : "div", { type: onclick ? "button" : null, class: "cc-tile " + clase, onclick },
        h("b", {}, n), h("span", {}, texto));
      return h("div", { class: "cc-widgets" },
        tarjeta("Asignado a", asignado,
          coordinador ? h("button", { type: "button", class: "cc-link", onclick: () => opts.onGoTo && opts.onGoTo("daily") }, "Empleados y Vehículos →") : null),
        tarjeta("Alertas de la ruta",
          h("div", { class: "cc-tiles" },
            tile(nRiesgo, nRiesgo === 1 ? "Con riesgo" : "Con riesgo", nRiesgo ? "cc-t-red" : "cc-t-ok"),
            tile(nTarde, nTarde === 1 ? "Retrasado" : "Retrasados", nTarde ? "cc-t-amber" : "cc-t-ok")),
          res.sinUbicacion ? h("p", { class: "cc-hint" }, res.sinUbicacion + " sin coordenadas (no se trazan).") : null,
          sinLeer == null ? null : h("button", { type: "button", class: "cc-link", onclick: () => opts.onGoTo && opts.onGoTo("monitor") },
            sinLeer + (sinLeer === 1 ? " notificación sin leer" : " notificaciones sin leer") + " →")),
        tarjeta("Resumen de pedidos",
          h("div", { class: "cc-stats" },
            h("div", {}, h("b", {}, res.total), h("span", {}, "Total")),
            h("div", {}, h("b", {}, res.pendientes), h("span", {}, "Pendientes")),
            h("div", {}, h("b", {}, res.proceso), h("span", {}, "En proceso")))),
        tarjeta(ruta ? "Completados (ruta)" : "Completados (hoy)",
          h("div", { class: "cc-done" }, donut(porcentaje),
            h("ul", { class: "cc-legend" },
              h("li", { class: "cc-l-total" }, "Total ", h("b", {}, res.total)),
              h("li", { class: "cc-l-done" }, "Completados ", h("b", {}, res.completados)),
              h("li", { class: "cc-l-proc" }, "En proceso ", h("b", {}, res.proceso)),
              h("li", { class: "cc-l-pend" }, "Pendientes ", h("b", {}, res.pendientes)))),
          enCursoN === 0 && res.total ? h("p", { class: "cc-hint" }, "Todos los pedidos están completados.") : null));
    }

    /* ---- lista de pedidos ---- */
    function pasaFiltro(v) {
      const p = v.p;
      if (S.q && !norm([p.cliente, p.direccion, p.zona, p.productos].join(" ")).includes(norm(S.q))) return false;
      switch (S.filtro) {
        case "pendiente": case "proceso": case "completada": return p.estado === S.filtro;
        case "retraso": return v.tarde > 0;
        case "sin_ubicacion": return enCurso(p) && !tieneUbicacion(p);
        default: return true;
      }
    }

    // Columna izquierda: buscar y filtrar, fila "Inicio de ruta" y los pedidos numerados.
    function renderTareas() {
      if (!taskBox) return;
      const store = opts.selection;
      taskBox.replaceChildren(...[
        S.editing ? h("div", { class: "cc-edit-tools" },
          h("label", {}, h("span", {}, "Agregar pedido pendiente"),
            h("select", { class: "cc-input", "aria-label": "Agregar pedido pendiente",
              disabled: S.editing.calculating || S.editing.saving,
              onchange: e => {
                const id = e.target.value;
                e.target.value = "";
                if (id) cambiarOrden(S.editing.ids.concat(id));
              } },
            h("option", { value: "" }, "Seleccionar pedido…"),
            S.deliveries.filter(p => p.estado === "pendiente" && (!p.ruta || norm(p.ruta) === norm(activa().nombre)) &&
              !S.editing.ids.includes(String(p.id))).map(p => h("option", { value: String(p.id) },
              (p.cliente || p.id) + (tieneUbicacion(p) ? "" : " · Sin ubicación"))))),
          h("small", {}, "Arrastra los pedidos para cambiar el orden o usa las flechas.")) :
        h("div", { class: "cc-tools" },
          h("input", { type: "search", class: "cc-input", placeholder: "Buscar pedido…", "aria-label": "Buscar pedido", value: S.q,
            oninput: e => { S.q = e.target.value; renderLista(); } }),
          h("select", { class: "cc-input", "aria-label": "Filtrar pedidos", onchange: e => { S.filtro = e.target.value; renderLista(); } },
            [["todos", "Filtro: todos"], ["pendiente", "Pendientes"], ["proceso", "En proceso"], ["completada", "Completados"], ["retraso", "Con retraso"], ["sin_ubicacion", "Sin coordenadas"]]
              .map(([v, t]) => h("option", { value: v, selected: S.filtro === v }, t)))),
        !S.editing && esBorrador() ? h("div", { class: "cc-pick-tools" },
          h("button", { type: "button", class: "cc-link", onclick: () => store.selectAll(S.deliveries) }, "Elegir todos"),
          h("button", { type: "button", class: "cc-link", onclick: () => store.clear() }, "Ninguno")) : null,
        opts.originNode || null,
        h("ol", { class: "cc-tasklist", id: "ccLista", "aria-live": "polite" })
      ].filter(Boolean));
      renderLista();
    }

    function renderLista() {
      const lista = taskBox && taskBox.querySelector("#ccLista");
      if (!lista) return;
      const filas = S.vista.filter(pasaFiltro);
      lista.replaceChildren();
      if (!S.vista.length) {
        lista.append(h("li", { class: "cc-empty" }, activa() ? "Esta ruta no tiene pedidos." : "No hay pedidos en curso para hoy."));
        return;
      }
      if (!filas.length) { lista.append(h("li", { class: "cc-empty" }, "Ningún pedido coincide con el filtro.")); return; }
      filas.forEach(v => {
        const p = v.p;
        const traza = v.i >= 0;
        const editIndex = S.editing ? S.editing.ids.indexOf(String(p.id)) : -1;
        const hecho = p.estado === "completada";
        const caja = esBorrador()
          ? h("input", { type: "checkbox", class: "cc-pick", checked: v.sel, disabled: !tieneUbicacion(p) && !v.sel,
              "aria-label": "Incluir " + (p.cliente || p.id) + " en la ruta", title: tieneUbicacion(p) ? "" : "Sin coordenadas",
              onchange: () => opts.selection.toggle(p.id, S.deliveries) }) : null;
        let derecha;
        if (hecho) derecha = [h("span", { class: "cc-done-tag" }, "Completado")];
        else if (v.eta) derecha = [h("span", { class: v.tarde ? "cc-eta-late" : "cc-eta" }, (v.tarde ? "⏱ " : "") + "ETA " + hora(v.eta)),
          v.tarde ? h("small", { class: "cc-eta-late" }, "+" + v.tarde + " min") : null, p.hora ? h("small", {}, "Prog. " + p.hora) : null];
        else derecha = [p.hora ? h("span", {}, "Hoy, " + p.hora) : null, !tieneUbicacion(p) ? h("small", { class: "cc-eta-late" }, "Sin coordenadas") : null];
        const editarFila = S.editing && editIndex >= 0;
        const fila = h("li", { class: "cc-task cc-s-" + p.estado + (v.tarde ? " cc-late" : "") + (v.sel ? "" : " cc-off") +
          (editarFila ? " cc-editable" : ""),
          draggable: editarFila && !S.editing.calculating && !S.editing.saving,
          ondragstart: e => {
            if (!editarFila) return;
            e.dataTransfer.setData("text/plain", String(p.id));
            e.dataTransfer.effectAllowed = "move";
          },
          ondragover: e => { if (S.editing) e.preventDefault(); },
          ondrop: e => {
            if (!S.editing) return;
            e.preventDefault();
            const fromId = e.dataTransfer.getData("text/plain");
            const ids = moverPedido(S.editing.ids, fromId, String(p.id));
            if (mismoOrden(ids, S.editing.ids)) return;
            cambiarOrden(ids);
          } },
          caja,
          h("button", { type: "button", class: "cc-task-btn", disabled: !traza, title: traza ? "Ver en el mapa" : "",
            onclick: () => opts.onFocusStop && opts.onFocusStop(v.i) },
          h("span", { class: "cc-num" }, hecho ? "✓" : editarFila ? String(editIndex + 1) : traza ? String(v.i + 1) : "–"),
          h("span", { class: "cc-task-main" },
            h("strong", {}, p.direccion || p.cliente || "Sin dirección"),
            h("small", {}, [p.cliente, p.contacto, p.productos].filter(Boolean).join(" · ") || p.zona || "")),
          h("span", { class: "cc-task-side" }, derecha.filter(Boolean))));
        if (editarFila) {
          const mover = (delta) => {
            const nuevo = editIndex + delta;
            if (nuevo < 0 || nuevo >= S.editing.ids.length) return;
            const ids = moverPedido(S.editing.ids, p.id, S.editing.ids[nuevo]);
            cambiarOrden(ids);
          };
          fila.append(h("div", { class: "cc-edit-row-actions" },
            h("button", { type: "button", class: "cc-edit-control", disabled: editIndex === 0 || S.editing.calculating,
              "aria-label": "Mover " + (p.cliente || p.id) + " arriba", onclick: () => mover(-1) }, "↑"),
            h("button", { type: "button", class: "cc-edit-control", disabled: editIndex === S.editing.ids.length - 1 || S.editing.calculating,
              "aria-label": "Mover " + (p.cliente || p.id) + " abajo", onclick: () => mover(1) }, "↓"),
            h("button", { type: "button", class: "cc-edit-control cc-remove-stop", disabled: S.editing.calculating || S.editing.saving,
              "aria-label": "Quitar " + (p.cliente || p.id), onclick: () => cambiarOrden(S.editing.ids.filter(id => id !== String(p.id))) }, "Quitar")));
        }
        lista.append(fila);
      });
    }

    /* ---- pintado general ---- */
    function render() {
      if (!vivo) return;
      derivar();
      const abierto = S.widgets;
      const [...cabecera] = renderCabecera();
      const barra = h("div", { class: "cc-widgets-bar" },
        h("button", { type: "button", class: "cc-link", "aria-expanded": String(abierto),
          onclick: () => { S.widgets = !S.widgets; try { global.localStorage.setItem(WIDGETS_KEY, S.widgets ? "abierto" : "cerrado"); } catch (e) { /* sin almacenamiento */ } render(); } },
        abierto ? "Ocultar resumen ⌃" : "Mostrar resumen ⌄"));
      // replaceChildren convierte null en el texto "null": solo se pasan nodos reales.
      const nSel = S.vista.filter(v => v.sel).length;
      const titulo = h("h3", { class: "cc-tasks-title" }, "Pedidos ", h("span", { class: "cc-count" }, "(" + nSel + ")"),
        esBorrador() && S.vista.length > nSel ? h("small", {}, " · " + (S.vista.length - nSel) + " más sin elegir") : null);
      container.replaceChildren(...[...cabecera, barra, abierto ? renderWidgets() : null, titulo].filter(Boolean));
      renderTareas();
    }

    render();
    refresh();

    return {
      // Lo que dashboard.js entrega tras cada cálculo de ruta.
      update(parcial) {
        Object.assign(S, parcial || {});
        if (parcial && "orders" in parcial) S.inicioMs = Date.now();
        render();
      },
      setActive(id) { S.activeId = id; render(); },
      get activeRoute() { return activa(); },
      refresh,
      findRoute(id) { return S.rutas.find(r => r.id === id) || null; },
      unmount() { vivo = false; cerrarModal(); container.replaceChildren(); if (taskBox) taskBox.replaceChildren(); }
    };
  }

  global.CentroRutas = {
    mount,
    util: { norm, pedidosDeRuta, aplicarOrden, moverPedido, mismoOrden, nivelRiesgo,
      ordenarVecinoCercano, resumenPedidos, estadoRuta, calcularEtas, minutosTarde, distanciaKm }
  };
})(window);
