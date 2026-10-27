/* =====================================================================
   PEDIDOS EN CURSO — SERSAPROSA

   Muestra los pedidos del día que todavía faltan por entregar (estado
   "pendiente" o "proceso") y permite ELEGIR cuáles entran en la ruta de
   "Planificar rutas". Los datos los entrega dashboard.js (POST /entregas/listar),
   así que este módulo no hace peticiones propias.

   Expone una sola variable global: window.Pedidos
     Pedidos.store            selección compartida entre la pantalla de pedidos
                              y el selector de "Planificar rutas" (sessionStorage)
     Pedidos.mountPage(el, opts)    pantalla completa "Pedidos en curso"
     Pedidos.mountPicker(el, opts)  lista compacta para elegir pedidos de la ruta
     ambos devuelven { setData(entregas), unmount() }

   SELECCIÓN: store.get() === null significa "el usuario aún no eligió" y se
   usan TODOS los pedidos en curso; un arreglo (aunque esté vacío) es la elección
   explícita. Solo cuentan los pedidos en curso con coordenadas para trazar la ruta.

   Contrato de cada pedido (lo que ya devuelve /entregas/listar):
     { id, cliente, direccion, hora:"HH:MM", estado:"pendiente|proceso|completada",
       zona, ruta, sin_ruta:boolean, contacto, productos, notas, lat, lng }
   ===================================================================== */
(function (global) {
  "use strict";

  const STORE_KEY = "pedidosSeleccion";
  const ESTADOS = { pendiente: "Pendiente", proceso: "En proceso", completada: "Completada" };

  /* ============ Reglas puras (se prueban sin pantalla) ============ */
  // En curso = todo lo que no está completado.
  const enCurso = pedido => !!pedido && pedido.estado !== "completada";
  // Con ubicación válida para poder trazar la ruta.
  const conUbicacion = pedido => !!pedido && pedido.lat != null && pedido.lng != null &&
    Number.isFinite(Number(pedido.lat)) && Number.isFinite(Number(pedido.lng)) &&
    Math.abs(Number(pedido.lat)) <= 90 && Math.abs(Number(pedido.lng)) <= 180;
  const norm = texto => String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  // Filtra la lista de la pantalla: por estado, zona y texto libre (cliente, dirección, ruta, productos).
  function filtrar(pedidos, f) {
    const q = norm(f.q).trim();
    return pedidos.filter(p => {
      if (!f.completados && !enCurso(p)) return false;
      if (f.estado && f.estado !== "todos" && p.estado !== f.estado) return false;
      if (f.zona && f.zona !== "todos" && p.zona !== f.zona) return false;
      return !q || norm([p.cliente, p.direccion, p.ruta, p.productos, p.zona].join(" ")).includes(q);
    });
  }

  function resumen(pedidos) {
    const curso = pedidos.filter(enCurso);
    return {
      enCurso: curso.length,
      pendientes: curso.filter(p => p.estado === "pendiente").length,
      proceso: curso.filter(p => p.estado === "proceso").length,
      completados: pedidos.length - curso.length,
      sinUbicacion: curso.filter(p => !conUbicacion(p)).length,
      sinRuta: curso.filter(p => p.sin_ruta).length
    };
  }

  /* ============ Selección compartida ============ */
  const store = (function () {
    let ids = null;
    const subs = new Set();
    try {
      const guardado = JSON.parse(global.sessionStorage.getItem(STORE_KEY));
      if (Array.isArray(guardado)) ids = guardado.map(String);
    } catch (e) { /* sin almacenamiento: la selección vive solo en memoria */ }

    function guardar() {
      try {
        if (ids === null) global.sessionStorage.removeItem(STORE_KEY);
        else global.sessionStorage.setItem(STORE_KEY, JSON.stringify(ids));
      } catch (e) { /* ignorar */ }
      subs.forEach(fn => fn(ids));
    }
    const todosEnCurso = pedidos => pedidos.filter(enCurso).map(p => String(p.id));

    return {
      get: () => (ids === null ? null : ids.slice()),
      // Pedidos en curso que cuentan para la ruta: los elegidos o, si no se eligió nada aún, todos.
      effective: pedidos => pedidos.filter(enCurso).filter(p => ids === null || ids.includes(String(p.id))),
      set(lista) { ids = lista === null ? null : lista.map(String); guardar(); },
      toggle(id, pedidos) {
        const base = ids === null ? todosEnCurso(pedidos) : ids;
        const sid = String(id);
        ids = base.includes(sid) ? base.filter(x => x !== sid) : base.concat(sid);
        guardar();
      },
      selectAll(pedidos) { ids = todosEnCurso(pedidos).filter(id => conUbicacion(pedidos.find(p => String(p.id) === id))); guardar(); },
      clear() { ids = []; guardar(); },
      subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
    };
  })();

  /* ============ Utilidades de pantalla ============ */
  // Crea elementos sin innerHTML: los textos van como texto, no como código.
  function h(tag, attrs, ...kids) {
    const e = global.document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "checked" || k === "disabled" || k === "selected") e[k] = !!v;
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null) e.append(c);
    return e;
  }

  const pill = estado => h("span", { class: "ord-pill ord-" + estado }, ESTADOS[estado] || estado);

  /* ============ Pantalla "Pedidos en curso" ============ */
  function mountPage(container, opts) {
    const cfg = Object.assign({ onGoRoutes: null }, opts || {});
    const S = { pedidos: [], loaded: false, f: { estado: "todos", zona: "todos", q: "", completados: false } };
    container.classList.add("ord");
    const root = h("div", { class: "ord-root" });
    container.replaceChildren(root);
    const off = store.subscribe(() => render());

    function render() {
      root.replaceChildren();
      if (!S.loaded) { root.append(h("div", { class: "ord-state" }, "Cargando pedidos…")); return; }
      const r = resumen(S.pedidos);
      const cnt = (n, texto, clase) => h("div", { class: "ord-cnt" + (clase ? " " + clase : "") },
        h("div", { class: "ord-n" }, String(n)), h("div", { class: "ord-l" }, texto));
      const zonas = Array.from(new Set(S.pedidos.map(p => p.zona).filter(Boolean))).sort();
      const utiles = store.effective(S.pedidos).filter(conUbicacion).length;

      const filtros = h("div", { class: "ord-filters" },
        h("input", {
          type: "search", class: "ord-input", placeholder: "Buscar cliente, dirección o ruta…", "aria-label": "Buscar pedidos",
          value: S.f.q, oninput: e => { S.f.q = e.target.value; renderList(); }
        }),
        h("select", { class: "ord-input", "aria-label": "Estado", onchange: e => { S.f.estado = e.target.value; render(); } },
          [["todos", "Todos los estados"], ["pendiente", "Pendientes"], ["proceso", "En proceso"]].map(([v, t]) =>
            h("option", { value: v, selected: S.f.estado === v }, t))),
        h("select", { class: "ord-input", "aria-label": "Zona", onchange: e => { S.f.zona = e.target.value; render(); } },
          h("option", { value: "todos" }, "Todas las zonas"),
          zonas.map(z => h("option", { value: z, selected: S.f.zona === z }, z))),
        h("label", { class: "ord-check" },
          h("input", { type: "checkbox", checked: S.f.completados, onchange: e => { S.f.completados = e.target.checked; render(); } }),
          " Mostrar completados"));

      const barra = h("div", { class: "ord-bar" },
        h("div", {}, h("strong", {}, utiles + " pedido" + (utiles === 1 ? "" : "s")), " elegido" + (utiles === 1 ? "" : "s") + " para la ruta",
          store.get() === null ? h("span", { class: "ord-hint" }, " (todos los que están en curso)") : null),
        h("div", { class: "ord-actions" },
          h("button", { type: "button", class: "ord-btn", onclick: () => store.selectAll(S.pedidos) }, "Elegir todos"),
          h("button", { type: "button", class: "ord-btn", onclick: () => store.clear() }, "Limpiar elección"),
          cfg.onGoRoutes ? h("button", { type: "button", class: "ord-btn ord-primary", onclick: cfg.onGoRoutes }, "Ir a Planificar rutas →") : null));

      const tabla = h("div", { class: "ord-scroll", id: "ordList" });
      root.append(
        h("div", { class: "ord-counters" },
          cnt(r.enCurso, "Pedidos en curso"), cnt(r.pendientes, "Pendientes"), cnt(r.proceso, "En proceso"),
          cnt(r.sinRuta, "Sin ruta asignada", r.sinRuta ? "ord-warn" : ""),
          cnt(r.sinUbicacion, "Sin coordenadas", r.sinUbicacion ? "ord-warn" : ""),
          cnt(r.completados, "Completados hoy")),
        filtros, barra, tabla);
      renderList();
    }

    // Solo la tabla se vuelve a dibujar al escribir en el buscador (así no se pierde el foco).
    function renderList() {
      const tabla = root.querySelector("#ordList");
      if (!tabla) return;
      const lista = filtrar(S.pedidos, S.f).sort((a, b) => String(a.hora).localeCompare(String(b.hora)));
      tabla.replaceChildren();
      if (!lista.length) {
        tabla.append(h("p", { class: "ord-state" }, S.pedidos.some(enCurso)
          ? "Ningún pedido coincide con los filtros."
          : "No hay pedidos en curso para hoy."));
        return;
      }
      tabla.append(h("table", { class: "ord-table" },
        h("thead", {}, h("tr", {}, ["Elegir", "Hora", "Cliente", "Dirección", "Zona", "Estado", "Ruta asignada", "Ubicación"].map((t, i) =>
          h("th", { class: i === 0 ? "ord-col-check" : "" }, t)))),
        h("tbody", {}, lista.map(p => {
          const util = enCurso(p) && conUbicacion(p);
          const marcado = store.effective(S.pedidos).some(x => String(x.id) === String(p.id));
          return h("tr", { class: marcado ? "ord-on" : "" },
            h("td", { class: "ord-col-check" }, h("input", {
              type: "checkbox", checked: marcado && util, disabled: !util,
              "aria-label": "Elegir pedido de " + (p.cliente || "cliente"),
              title: util ? "" : (enCurso(p) ? "Sin coordenadas: no se puede trazar" : "Ya completado"),
              onchange: () => store.toggle(p.id, S.pedidos)
            })),
            h("td", {}, p.hora || "--:--"),
            h("td", {}, h("strong", {}, p.cliente || "Sin cliente"), p.productos ? h("div", { class: "ord-sub" }, p.productos) : null),
            h("td", {}, p.direccion || "Sin dirección"),
            h("td", {}, p.zona || "—"),
            h("td", {}, pill(p.estado)),
            h("td", {}, p.sin_ruta ? h("span", { class: "ord-pill ord-sinruta" }, "Sin ruta") : (p.ruta || "—")),
            h("td", {}, enCurso(p) ? (conUbicacion(p) ? "✓" : h("span", { class: "ord-pill ord-sinruta" }, "Sin coordenadas")) : "—"));
        }))));
    }

    render();
    return {
      setData(lista) { S.pedidos = Array.isArray(lista) ? lista : []; S.loaded = true; render(); },
      unmount() { off(); container.replaceChildren(); container.classList.remove("ord"); }
    };
  }

  /* ============ Selector compacto dentro de "Planificar rutas" ============ */
  function mountPicker(container, opts) {
    const cfg = Object.assign({ onGoOrders: null }, opts || {});
    const S = { pedidos: [], loaded: false };
    container.classList.add("ord", "ord-picker");
    const root = h("div", { class: "ord-root" });
    container.replaceChildren(root);
    const off = store.subscribe(() => render());

    function render() {
      root.replaceChildren();
      const curso = S.pedidos.filter(enCurso).sort((a, b) => String(a.hora).localeCompare(String(b.hora)));
      const efectivos = store.effective(S.pedidos).filter(conUbicacion);
      root.append(h("div", { class: "ord-picker-head" },
        h("div", {}, h("span", { class: "ord-kicker" }, "PEDIDOS EN CURSO"),
          h("h3", { class: "ord-title" }, "Pedidos de la ruta"),
          h("div", { class: "ord-sub" }, S.loaded ? efectivos.length + " de " + curso.length + " elegidos" : "Cargando…")),
        cfg.onGoOrders ? h("button", { type: "button", class: "ord-link", onclick: cfg.onGoOrders }, "Ver todos →") : null));
      if (S.loaded && curso.length) {
        root.append(h("div", { class: "ord-actions" },
          h("button", { type: "button", class: "ord-btn", onclick: () => store.selectAll(S.pedidos) }, "Todos"),
          h("button", { type: "button", class: "ord-btn", onclick: () => store.clear() }, "Ninguno")));
      }
      if (!S.loaded) return;
      if (!curso.length) { root.append(h("p", { class: "ord-state" }, "No hay pedidos en curso para hoy.")); return; }
      root.append(h("ul", { class: "ord-picklist" }, curso.map(p => {
        const util = conUbicacion(p);
        const marcado = util && store.effective(S.pedidos).some(x => String(x.id) === String(p.id));
        return h("li", { class: "ord-pick" + (marcado ? " ord-on" : "") },
          h("label", {},
            h("input", { type: "checkbox", checked: marcado, disabled: !util, onchange: () => store.toggle(p.id, S.pedidos) }),
            h("span", { class: "ord-pick-main" },
              h("strong", {}, p.cliente || "Sin cliente"),
              h("span", { class: "ord-sub" }, (p.hora || "--:--") + " · " + (p.zona || "Sin zona") + " · " + (p.direccion || "Sin dirección")),
              util ? null : h("span", { class: "ord-pill ord-sinruta" }, "Sin coordenadas: no entra en la ruta")),
            pill(p.estado)));
      })));
    }

    render();
    return {
      setData(lista) { S.pedidos = Array.isArray(lista) ? lista : []; S.loaded = true; render(); },
      unmount() { off(); container.replaceChildren(); container.classList.remove("ord", "ord-picker"); }
    };
  }

  global.Pedidos = { store, mountPage, mountPicker, enCurso, conUbicacion, filtrar, resumen };
})(window);
