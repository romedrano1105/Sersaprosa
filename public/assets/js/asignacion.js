/* =====================================================================
   ASIGNACIÓN DE CONDUCTOR Y VEHÍCULO A UNA RUTA O ENTREGA — SERSAPROSA
   (FCJ1-86 consulta por fecha y horario · FCJ1-87 asignación ·
    FCJ1-88 estados de carga, error y reintento · FCJ1-89 confirmación)

   Módulo independiente y compatible con PaginaPrincipal.html / server.js:
   - No crea variables globales (solo window.Asignacion).
   - No usa ids; todas sus clases CSS empiezan con "asn-".
   - Lee la sesión de sessionStorage["session"] = { token, name, code, role }.

   CÓMO INCRUSTARLO EN PaginaPrincipal.html (cuando llegue el momento):
     <link rel="stylesheet" href="asignacion.css">
     <div id="panelAsignacion"></div>
     <script src="asignacion.js"></script>
     <script>
       Asignacion.mount(document.getElementById('panelAsignacion'), {
         ROUTES: "...", DRIVERS: "...", VEHICLES: "...", ASSIGN: "...",
         onUnauthorized: logout        // la función de salir de PaginaPrincipal
       });
     </script>

   CONTRATO DE ENDPOINTS (si ROUTES está vacío, funciona en modo demostración).
   Todos son POST con Authorization: Bearer <token>. Las fechas son "YYYY-MM-DD"
   y las horas "HH:MM".
   1) ROUTES    { fecha }
        → [{ id, tipo:"ruta"|"entrega", nombre, fecha, inicio, fin,
             asignacion: null | { conductor, vehiculo, asignado_en, usuario } }]
   2) DRIVERS   { fecha, ruta, inicio, fin }
        → [{ id, nombre, licencia, ocupaciones:[{ ruta, inicio, fin }] }]
        "ocupaciones" = rutas que ese conductor ya tiene ESE día.
   3) VEHICLES  { fecha, ruta, inicio, fin }
        → [{ id, placa, tipo, seguro, revision, ocupaciones:[{ ruta, inicio, fin }] }]
   4) ASSIGN    { ruta, conductor, vehiculo }
        → { ruta, conductor, vehiculo, fecha, inicio, fin, asignado_en, usuario }
        El backend DEBE rechazar (409/422 con { error } o { detail }) si el conductor
        o el vehículo tiene un documento vencido en esa fecha, o ya está asignado a
        otra ruta que se cruza en horario. El rol y el token se validan siempre allá.
   ===================================================================== */
(function (global) {
  "use strict";

  /* ---------- Configuración por defecto (equivale al bloque N8N de PaginaPrincipal) ---------- */
  const ASN = {
    ROUTES: "", DRIVERS: "", VEHICLES: "", ASSIGN: "",   // vacío = modo demostración
    ROLES_ALLOWED: ["director_rutas", "admin_rutas"],     // perfiles que pueden usar la sección
    SESSION_KEY: "session",                               // dónde guarda la sesión PaginaPrincipal
    onUnauthorized: null
  };

  /* ============ Utilidades ============ */
  const DAY = 864e5;
  // Documentos que deben estar vigentes en la fecha de la ruta
  const DOCS = { driver: [["licencia", "Licencia"]], vehicle: [["seguro", "Seguro"], ["revision", "Revisión técnica"]] };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const fmtD = d => d.toLocaleDateString("es-SV");
  const fmtT = d => d.toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit" });
  const startOfToday = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };
  const iso = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

  // Error con bandera "retry": true = vale la pena reintentar (red/servidor); false = rechazo de negocio
  function fail(msg, retry) { const e = new Error(msg); e.retry = !!retry; return e; }

  // Convierte texto ISO / Date / vacío en Date. "YYYY-MM-DD" se lee en hora local (sin correrse un día)
  function toDate(v) {
    if (v == null || v === "") return null;
    if (v instanceof Date) return v;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const p = v.split("-");
      return new Date(+p[0], +p[1] - 1, +p[2]);
    }
    return new Date(v);
  }

  // Crea elementos HTML sin innerHTML (los textos van como texto, nunca como código)
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null) e.append(c);
    return e;
  }

  /* ============ Regla de negocio (pura, con pruebas) ============ */
  // "08:30" → 510 minutos (NaN si el formato no es válido)
  function mins(t) { const m = /^(\d{1,2}):(\d{2})/.exec(String(t)); return m ? (+m[1]) * 60 + (+m[2]) : NaN; }

  // ¿Se cruzan dos horarios del mismo día? (que uno termine cuando el otro empieza NO es cruce)
  // Si algún horario es inválido se asume cruce, para no asignar por error.
  function overlap(aIni, aFin, bIni, bFin) {
    const a1 = mins(aIni), a2 = mins(aFin), b1 = mins(bIni), b2 = mins(bFin);
    if ([a1, a2, b1, b2].some(isNaN)) return true;
    return a1 < b2 && b1 < a2;
  }

  // Estado de un conductor ('driver') o vehículo ('vehicle') PARA UNA RUTA concreta:
  //   asignado       → ya está asignado a esta misma ruta
  //   no_disponible  → documento vencido en la fecha de la ruta, sin fecha, u ocupado en otra ruta que se cruza
  //   disponible     → puede seleccionarse
  function calcEstado(e, kind, route) {
    const ocup = e.ocupaciones || [];
    if (ocup.some(o => o.ruta === route.id)) return { estado: "asignado", motivos: [] };
    const motivos = [];
    const diaRuta = toDate(route.fecha);
    for (const [k, label] of DOCS[kind]) {
      const f = e[k];
      if (!(f instanceof Date) || isNaN(f)) motivos.push(label + " sin fecha registrada");
      else if (f < diaRuta) motivos.push(label + " vencida el " + fmtD(f));   // vence ese día = aún vigente
    }
    for (const o of ocup) {
      if (o.ruta !== route.id && overlap(o.inicio, o.fin, route.inicio, route.fin)) {
        motivos.push("Ya asignado a la ruta " + o.ruta + " (" + o.inicio + "–" + o.fin + ")");
      }
    }
    return { estado: motivos.length ? "no_disponible" : "disponible", motivos };
  }

  // Pasa las fechas de documentos a Date y asegura "ocupaciones"
  function prep(e, kind) {
    const o = Object.assign({}, e, { ocupaciones: Array.isArray(e.ocupaciones) ? e.ocupaciones : [] });
    DOCS[kind].forEach(p => { o[p[0]] = toDate(o[p[0]]); });
    return o;
  }
  function normalizeList(raw, kind) {
    if (!Array.isArray(raw)) throw fail("La respuesta del servidor no tiene el formato esperado.", true);
    return raw.map(x => prep(x, kind));
  }
  function normRoute(r) {
    return Object.assign({}, r, {
      tipo: r.tipo === "entrega" ? "entrega" : "ruta",
      asignacion: r.asignacion ? Object.assign({}, r.asignacion, { asignado_en: toDate(r.asignacion.asignado_en) || new Date() }) : null
    });
  }

  /* ============ Datos y "backend" de demostración (se ignoran al configurar ROUTES) ============ */
  function makeDemo() {
    const t = startOfToday(), f = n => iso(new Date(t.getTime() + n * DAY));
    return {
      drivers: [
        { id: "C-01", nombre: "Carlos Mejía", licencia: f(300) },
        { id: "C-02", nombre: "José Ramírez", licencia: f(45) },
        { id: "C-03", nombre: "Luis Hernández", licencia: f(120) },
        { id: "C-04", nombre: "Ana Portillo", licencia: f(-12) },
        { id: "C-05", nombre: "Marvin Alas", licencia: f(0) },      // vence hoy: mañana ya estará vencida
        { id: "C-06", nombre: "Kevin Rivas", licencia: f(-90) }
      ],
      vehicles: [
        { id: "V-01", placa: "P 482-193", tipo: "Camión blindado", seguro: f(200), revision: f(150) },
        { id: "V-02", placa: "P 117-654", tipo: "Camioneta de valores", seguro: f(30), revision: f(60) },
        { id: "V-03", placa: "P 905-231", tipo: "Camión de carga", seguro: f(-5), revision: f(90) },
        { id: "V-04", placa: "P 336-780", tipo: "Camión blindado", seguro: f(180), revision: f(75) },
        { id: "V-05", placa: "P 654-012", tipo: "Camioneta de valores", seguro: f(140), revision: f(-20) },
        { id: "V-06", placa: "P 220-415", tipo: "Camión de carga", seguro: f(0), revision: f(120) }   // seguro vence hoy
      ],
      routes: [
        { id: "R-201", tipo: "ruta", nombre: "San Salvador – Santa Ana (valores)", fecha: f(0), inicio: "08:00", fin: "12:00" },
        { id: "R-202", tipo: "entrega", nombre: "Efectivo · Agencia Santa Tecla", fecha: f(0), inicio: "10:00", fin: "14:00" },
        { id: "R-203", tipo: "ruta", nombre: "Soyapango – Sonsonate (valores)", fecha: f(0), inicio: "15:00", fin: "18:00" },
        { id: "R-204", tipo: "ruta", nombre: "San Salvador – San Miguel (efectivo)", fecha: f(1), inicio: "07:00", fin: "11:00" },
        { id: "R-205", tipo: "entrega", nombre: "Mercancía · Zona Franca", fecha: f(1), inicio: "13:00", fin: "16:00" }
      ],
      // R-202 ya tiene asignación: C-03 y V-04 quedan ocupados de 10:00 a 14:00
      assignments: [{ ruta: "R-202", conductor: "C-03", vehiculo: "V-04", asignado_en: new Date(Date.now() - 3600e3), usuario: "Pedro Aguilar" }]
    };
  }

  // Simula el servidor. Aquí vive la validación que, en el sistema real, debe hacer el backend.
  function demoBackend(DB) {
    const rutaDe = id => DB.routes.find(r => r.id === id);
    const ocup = (campo, id, fecha) => DB.assignments.filter(a => a[campo] === id)
      .map(a => rutaDe(a.ruta)).filter(r => r && r.fecha === fecha)
      .map(r => ({ ruta: r.id, inicio: r.inicio, fin: r.fin }));
    return {
      routes(fecha) {
        return DB.routes.filter(r => r.fecha === fecha).map(r => {
          const a = DB.assignments.find(x => x.ruta === r.id);
          return Object.assign({}, r, { asignacion: a ? { conductor: a.conductor, vehiculo: a.vehiculo, asignado_en: a.asignado_en, usuario: a.usuario } : null });
        });
      },
      drivers(fecha) { return DB.drivers.map(d => Object.assign({}, d, { ocupaciones: ocup("conductor", d.id, fecha) })); },
      vehicles(fecha) { return DB.vehicles.map(v => Object.assign({}, v, { ocupaciones: ocup("vehiculo", v.id, fecha) })); },
      assign(rId, dId, vId, usuario) {
        const r = rutaDe(rId), d = DB.drivers.find(x => x.id === dId), v = DB.vehicles.find(x => x.id === vId);
        if (!r || !d || !v) throw fail("Ruta, conductor o vehículo no válidos.", false);
        if (DB.assignments.some(a => a.ruta === rId)) throw fail("La ruta " + rId + " ya tiene una asignación.", false);
        const ed = calcEstado(prep(Object.assign({}, d, { ocupaciones: ocup("conductor", dId, r.fecha) }), "driver"), "driver", r);
        const ev = calcEstado(prep(Object.assign({}, v, { ocupaciones: ocup("vehiculo", vId, r.fecha) }), "vehicle"), "vehicle", r);
        if (ed.estado !== "disponible") throw fail("El backend rechazó la asignación. " + d.nombre + ": " + ed.motivos.join("; ") + ".", false);
        if (ev.estado !== "disponible") throw fail("El backend rechazó la asignación. " + v.placa + ": " + ev.motivos.join("; ") + ".", false);
        const rec = { ruta: rId, conductor: dId, vehiculo: vId, fecha: r.fecha, inicio: r.inicio, fin: r.fin, asignado_en: new Date(), usuario: usuario };
        DB.assignments.push({ ruta: rId, conductor: dId, vehiculo: vId, asignado_en: rec.asignado_en, usuario: usuario });
        return rec;
      }
    };
  }

  /* ============ Pruebas de la lógica ============ */
  function runTests() {
    const res = [], ck = (n, c) => res.push([n, !!c]);
    const t = startOfToday(), D = n => new Date(t.getTime() + n * DAY);
    const rt = { id: "R-1", fecha: iso(t), inicio: "08:00", fin: "12:00" };
    const drv = (extra) => Object.assign({ id: "X", licencia: D(10), ocupaciones: [] }, extra);
    ck("Horarios que se cruzan", overlap("08:00", "12:00", "10:00", "14:00"));
    ck("Horarios que solo se tocan NO se cruzan", !overlap("08:00", "12:00", "12:00", "14:00"));
    ck("Horario inválido se trata como cruce", overlap("xx", "12:00", "13:00", "14:00"));
    ck("Conductor vigente y libre = disponible", calcEstado(drv(), "driver", rt).estado === "disponible");
    ck("Licencia vencida = no disponible", calcEstado(drv({ licencia: D(-1) }), "driver", rt).estado === "no_disponible");
    ck("Licencia que vence el día de la ruta sigue vigente", calcEstado(drv({ licencia: D(0) }), "driver", rt).estado === "disponible");
    ck("Licencia vigente hoy pero vencida en la fecha de la ruta", calcEstado(drv({ licencia: D(0) }), "driver", Object.assign({}, rt, { fecha: iso(D(1)) })).estado === "no_disponible");
    ck("Licencia sin fecha = no disponible", calcEstado(drv({ licencia: null }), "driver", rt).estado === "no_disponible");
    ck("Seguro vencido = no disponible", calcEstado({ id: "V", seguro: D(-1), revision: D(5), ocupaciones: [] }, "vehicle", rt).estado === "no_disponible");
    ck("Revisión vencida = no disponible", calcEstado({ id: "V", seguro: D(5), revision: D(-1), ocupaciones: [] }, "vehicle", rt).estado === "no_disponible");
    const cruce = calcEstado(drv({ ocupaciones: [{ ruta: "R-9", inicio: "10:00", fin: "14:00" }] }), "driver", rt);
    ck("Ocupado en otra ruta que se cruza = no disponible con motivo", cruce.estado === "no_disponible" && cruce.motivos[0].includes("R-9"));
    ck("Ocupado en otra ruta sin cruce = disponible", calcEstado(drv({ ocupaciones: [{ ruta: "R-9", inicio: "12:00", fin: "14:00" }] }), "driver", rt).estado === "disponible");
    ck("Asignado a esta ruta = estado Asignado", calcEstado(drv({ ocupaciones: [{ ruta: "R-1", inicio: "08:00", fin: "12:00" }] }), "driver", rt).estado === "asignado");

    // Backend de demostración: rechaza no disponibles y deja asignado lo válido
    const be = demoBackend(makeDemo()), hoy = iso(t);
    let rechazoDoc = false, rechazoCruce = false, rechazoDoble = false;
    try { be.assign("R-201", "C-04", "V-01", "u"); } catch (e) { rechazoDoc = true; }
    try { be.assign("R-201", "C-03", "V-01", "u"); } catch (e) { rechazoCruce = true; }
    ck("Backend rechaza conductor con licencia vencida", rechazoDoc);
    ck("Backend rechaza conductor ocupado en horario que se cruza", rechazoCruce);
    const rec = be.assign("R-201", "C-01", "V-01", "María");
    ck("Backend guarda asignación con fecha, hora y usuario", rec.usuario === "María" && rec.asignado_en instanceof Date && rec.fecha === hoy);
    try { be.assign("R-201", "C-02", "V-02", "u"); } catch (e) { rechazoDoble = true; }
    ck("Backend no deja asignar dos veces la misma ruta", rechazoDoble);
    const d1 = prep(be.drivers(hoy).find(x => x.id === "C-01"), "driver");
    ck("Tras asignar, el conductor figura Asignado en esa ruta", calcEstado(d1, "driver", be.routes(hoy)[0]).estado === "asignado");
    let okTarde = true; try { be.assign("R-203", "C-01", "V-01", "u"); } catch (e) { okTarde = false; }
    ck("Mismo conductor y vehículo sí quedan libres para una ruta sin cruce", okTarde);
    res.forEach(r => console.log((r[1] ? "OK    " : "FALLO ") + r[0]));
    return { ok: res.filter(r => r[1]).length, total: res.length };
  }

  /* ============ Componente ============ */
  // mount(contenedor, opciones) dibuja la sección dentro de 'contenedor'. Cada llamada tiene su propio estado.
  function mount(container, opts) {
    const cfg = Object.assign({}, ASN, opts || {});
    const demo = !cfg.ROUTES;                                   // sin URL = modo demostración
    const backend = demo ? demoBackend(makeDemo()) : null;
    // Estado de la pantalla. Cada bloque de datos tiene su propio status: idle | loading | ok | error
    const S = {
      fecha: iso(new Date()), routeId: null,
      routes: { status: "loading", data: [], error: null },
      drv: { status: "idle", data: [], error: null },
      veh: { status: "idle", data: [], error: null },
      d: null, v: null,                                         // conductor y vehículo seleccionados
      asg: { status: "idle", retry: false },                    // estado de la acción de asignar
      demo: { failDrv: false, failVeh: false, failAsg: false, role: null }
    };
    const tok = { routes: 0, drv: 0, veh: 0 };                  // evita que una respuesta vieja pise a una nueva
    let alive = true;
    const route = () => S.routes.data.find(r => r.id === S.routeId) || null;

    /* ---- Sesión (formato que guarda el login de PaginaPrincipal) ---- */
    function getSession() {
      if (cfg.session) return typeof cfg.session === "function" ? cfg.session() : cfg.session;
      try { const s = sessionStorage.getItem(cfg.SESSION_KEY); if (s) return JSON.parse(s); } catch (e) { /* sin sesión */ }
      return null;
    }
    const hasSession = () => demo || !!getSession();
    function currentUser() { const s = getSession(); return s ? (s.name || s.code || s.user || "Usuario") : (demo ? "María Hernández" : ""); }
    function currentRole() {
      if (demo && S.demo.role) return S.demo.role;
      const s = getSession();
      if (s && s.role) return s.role;
      return demo ? cfg.ROLES_ALLOWED[0] : null;               // en modo real, sin rol = sin acceso
    }
    const roleOk = () => cfg.ROLES_ALLOWED.indexOf(currentRole()) >= 0;
    const canUse = () => hasSession() && roleOk();

    /* ---- Servicio ---- */
    async function post(url, body) {
      const s = getSession();
      let r;
      try {
        r = await fetch(url, {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, s && s.token ? { Authorization: "Bearer " + s.token } : {}),
          body: JSON.stringify(body)
        });
      } catch (e) { throw fail("No se pudo conectar con el servidor. Revise la conexión.", true); }
      if (r.status === 401) {
        if (typeof cfg.onUnauthorized === "function") cfg.onUnauthorized();
        throw fail("Sesión vencida. Inicie sesión de nuevo.", false);
      }
      let data = null;
      try { data = await r.json(); } catch (e) { /* sin cuerpo */ }
      if (!r.ok) {
        const m = data && (data.error || data.detail);
        throw fail(typeof m === "string" ? m : "Error " + r.status, r.status >= 500);   // 5xx se puede reintentar; 4xx no
      }
      return data;
    }

    async function fetchRoutes() {
      if (!demo) {
        const r = await post(cfg.ROUTES, { fecha: S.fecha });
        if (!Array.isArray(r)) throw fail("La respuesta de rutas no tiene el formato esperado.", true);
        return r;
      }
      await wait(300);
      return backend.routes(S.fecha);
    }
    async function fetchList(kind, rt) {
      const driver = kind === "driver";
      if (!demo) {
        return normalizeList(await post(driver ? cfg.DRIVERS : cfg.VEHICLES, { fecha: rt.fecha, ruta: rt.id, inicio: rt.inicio, fin: rt.fin }), kind);
      }
      await wait(driver ? 400 : 600);
      if (driver ? S.demo.failDrv : S.demo.failVeh) throw fail(driver ? "No se pudieron cargar los conductores." : "No se pudieron cargar los vehículos.", true);
      return normalizeList(driver ? backend.drivers(rt.fecha) : backend.vehicles(rt.fecha), kind);
    }

    // Guarda la asignación. Primero un filtro en pantalla; el backend vuelve a validar siempre.
    async function assignSvc(rt, dId, vId) {
      if (!roleOk()) throw fail("No tiene permiso para asignar.", false);
      if (S.drv.status !== "ok" || S.veh.status !== "ok") throw fail("No se puede asignar hasta que carguen los conductores y vehículos.", false);
      const d = S.drv.data.find(x => x.id === dId), v = S.veh.data.find(x => x.id === vId);
      if (!d || !v) throw fail("Conductor o vehículo no válidos.", false);
      if (calcEstado(d, "driver", rt).estado !== "disponible") throw fail("No se puede asignar a " + d.nombre + ": no está disponible.", false);
      if (calcEstado(v, "vehicle", rt).estado !== "disponible") throw fail("No se puede asignar el vehículo " + v.placa + ": no está disponible.", false);
      if (!demo) {
        const rec = await post(cfg.ASSIGN, { ruta: rt.id, conductor: dId, vehiculo: vId });
        const out = Object.assign({ ruta: rt.id, conductor: dId, vehiculo: vId, fecha: rt.fecha, inicio: rt.inicio, fin: rt.fin, usuario: currentUser() }, rec || {});
        out.asignado_en = toDate(out.asignado_en) || new Date();
        return out;
      }
      await wait(500);
      if (S.demo.failAsg) throw fail("No se pudo guardar la asignación. Error de conexión.", true);
      return backend.assign(rt.id, dId, vId, currentUser());
    }

    /* ---- Estructura fija: encabezado, mensajes y cuerpo (solo el cuerpo se redibuja) ---- */
    const headUser = h("b"), headRole = h("span");
    const head = h("div", { class: "asn-head" },
      h("div", {},
        h("h2", { class: "asn-title" }, "Asignación de conductor y vehículo"),
        h("p", { class: "asn-sub" }, "SERSAPROSA · Cubra la operación del día sin recursos vencidos u ocupados")),
      h("div", { class: "asn-who" }, "Sesión: ", headUser, h("br"), headRole));
    const msgBox = h("div", { class: "asn-msgbox", role: "status", "aria-live": "polite" });
    const body = h("div", { class: "asn-body" });
    const root = h("div", { class: "asn-root" }, head, msgBox, body);
    container.classList.add("asn");
    container.replaceChildren(root);

    function setMsg(type, text) {
      msgBox.replaceChildren();
      if (text) msgBox.append(h("div", { class: "asn-msg asn-msg-" + type }, text));
    }

    /* ---- Cargas ---- */
    // Rutas del día elegido; luego, conductores y vehículos para la ruta seleccionada
    async function loadRoutes() {
      const my = ++tok.routes;
      S.routes = { status: "loading", data: S.routes.data, error: null }; render();
      if (!canUse()) { S.routes = { status: "idle", data: [], error: null }; await loadResources(); return; }
      try {
        const data = (await fetchRoutes()).map(normRoute);
        if (!alive || my !== tok.routes) return;
        S.routes = { status: "ok", data, error: null };
        if (!data.some(r => r.id === S.routeId)) { S.routeId = data.length ? data[0].id : null; S.d = null; S.v = null; }
      } catch (e) {
        if (!alive || my !== tok.routes) return;
        S.routes = { status: "error", data: [], error: e.message }; S.routeId = null;
      }
      await loadResources();
    }

    // which = "driver" | "vehicle" para recargar solo uno (botón Reintentar); sin argumento carga ambos
    async function loadResources(which) {
      const rt = route();
      if (!rt || !canUse()) {
        S.drv = { status: "idle", data: [], error: null }; S.veh = { status: "idle", data: [], error: null };
        S.d = null; S.v = null; render(); return;
      }
      const kinds = which ? [which] : ["driver", "vehicle"];
      await Promise.all(kinds.map(async k => {
        const slot = k === "driver" ? "drv" : "veh", my = ++tok[slot];
        S[slot] = { status: "loading", data: [], error: null }; render();
        try {
          const data = await fetchList(k, rt);
          if (!alive || my !== tok[slot]) return;
          S[slot] = { status: "ok", data, error: null };
        } catch (e) {
          if (!alive || my !== tok[slot]) return;
          S[slot] = { status: "error", data: [], error: e.message };
        }
        // Si lo seleccionado ya no está disponible, se quita de la selección
        const cur = route();
        if (S.drv.status === "ok" && S.d) { const x = S.drv.data.find(i => i.id === S.d); if (!x || !cur || calcEstado(x, "driver", cur).estado !== "disponible") S.d = null; }
        if (S.veh.status === "ok" && S.v) { const x = S.veh.data.find(i => i.id === S.v); if (!x || !cur || calcEstado(x, "vehicle", cur).estado !== "disponible") S.v = null; }
        render();
      }));
    }

    /* ---- Acciones ---- */
    function resetSel() { S.d = null; S.v = null; S.asg = { status: "idle", retry: false }; setMsg("", ""); }
    function onFecha(v) { if (!v) return; S.fecha = v; resetSel(); loadRoutes(); }
    function onRuta(id) { S.routeId = id; resetSel(); loadResources(); }
    function pick(kind, item) {
      const key = kind === "driver" ? "d" : "v";
      S[key] = S[key] === item.id ? null : item.id;
      S.asg = { status: "idle", retry: false }; setMsg("", ""); render();
    }

    // Confirmar asignación (también la usa "Reintentar asignación", conservando la selección)
    async function doAssign() {
      const rt = route();
      if (!rt || !S.d || !S.v || S.asg.status === "saving") return;
      const dn = (S.drv.data.find(x => x.id === S.d) || {}).nombre || S.d;
      const vp = (S.veh.data.find(x => x.id === S.v) || {}).placa || S.v;
      S.asg = { status: "saving", retry: false }; setMsg("", ""); render();
      try {
        const rec = await assignSvc(rt, S.d, S.v);
        S.d = null; S.v = null; S.asg = { status: "idle", retry: false };
        setMsg("ok", "Asignación confirmada: " + dn + " y el vehículo " + vp + " quedaron asignados a la " + (rt.tipo === "entrega" ? "entrega " : "ruta ") + rec.ruta +
          " (" + rt.inicio + "–" + rt.fin + "). Estado: Asignado.");
        await loadRoutes();                                      // refresca estados y marca la ruta como Asignada
      } catch (e) {
        S.asg = { status: e.retry ? "error" : "idle", retry: !!e.retry };
        setMsg("err", e.message);
        render();
        if (!e.retry) await loadResources();                     // rechazo de negocio: se actualizan los estados
      }
    }

    /* ---- Vista ---- */
    const PILL = { disponible: ["asn-ok", "Disponible"], no_disponible: ["asn-no", "No disponible"], asignado: ["asn-asg", "Asignado"] };

    function row(kind, item, rt) {
      const est = calcEstado(item, kind, rt);
      const sel = (kind === "driver" ? S.d : S.v) === item.id;
      const title = kind === "driver" ? item.nombre : item.placa;
      const meta = kind === "driver"
        ? item.id + " · Licencia vence " + (item.licencia && !isNaN(item.licencia) ? fmtD(item.licencia) : "sin registrar")
        : item.id + " · " + (item.tipo || "Vehículo");
      const bloqueado = est.estado !== "disponible" || !!rt.asignacion || S.asg.status === "saving";
      return h("li", { class: "asn-row" + (sel ? " asn-sel" : "") + (est.estado === "no_disponible" ? " asn-blocked" : "") },
        h("div", {},
          h("span", { class: "asn-nm" }, title),
          h("span", { class: "asn-pill " + PILL[est.estado][0] }, PILL[est.estado][1]),
          h("div", { class: "asn-meta" }, meta)),
        h("button", { type: "button", class: "asn-btn", disabled: bloqueado, "aria-pressed": sel ? "true" : "false", onclick: () => pick(kind, item) }, sel ? "Quitar" : "Seleccionar"),
        est.estado === "no_disponible" ? h("div", { class: "asn-why" }, "Motivo: " + est.motivos.join("; ")) : null);
    }

    // Panel de una lista (conductores o vehículos) con sus tres estados: cargando, error con reintento, datos
    function listPanel(kind, rt) {
      const driver = kind === "driver", slot = driver ? S.drv : S.veh, nombre = driver ? "Conductores" : "Vehículos";
      if (slot.status === "loading" || slot.status === "idle") {
        return h("div", { class: "asn-panel" }, h("h3", { class: "asn-h" }, nombre), h("p", { class: "asn-meta" }, "Cargando " + nombre.toLowerCase() + "…"));
      }
      if (slot.status === "error") {
        return h("div", { class: "asn-panel asn-panel-err", role: "alert" }, h("h3", { class: "asn-h" }, nombre),
          h("p", {}, slot.error || "No se pudo cargar."),
          h("button", { type: "button", class: "asn-btn asn-primary", onclick: () => loadResources(kind) }, "Reintentar"));
      }
      const libres = slot.data.filter(x => calcEstado(x, kind, rt).estado === "disponible").length;
      return h("div", { class: "asn-panel" },
        h("h3", { class: "asn-h" }, nombre + " (" + libres + " disponibles de " + slot.data.length + ")"),
        h("ul", { class: "asn-list" }, slot.data.map(x => row(kind, x, rt))));
    }

    function nombreDe(slot, id, campo) { const x = slot.data.find(i => i.id === id); return x ? x[campo] : id; }

    function render() {
      headUser.textContent = currentUser() || "sin sesión";
      headRole.textContent = roleOk() ? "Director de rutas" : (currentRole() || "");
      body.replaceChildren();
      if (!hasSession()) { body.append(h("div", { class: "asn-state asn-state-err" }, h("h3", { class: "asn-h" }, "Sesión requerida"), h("p", {}, "Inicie sesión para asignar recursos."))); return; }
      if (!roleOk()) { body.append(h("div", { class: "asn-state asn-state-err" }, h("h3", { class: "asn-h" }, "Acceso restringido"), h("p", {}, "Esta sección es solo para el director de rutas."))); return; }

      // 1) Filtros: fecha y ruta/entrega del día
      const rt = route();
      const rutaSel = h("select", { class: "asn-select", disabled: S.routes.status !== "ok" || !S.routes.data.length, onchange: e => onRuta(e.target.value) },
        S.routes.data.length
          ? S.routes.data.map(r => h("option", { value: r.id, selected: r.id === S.routeId },
            r.id + " · " + r.inicio + "–" + r.fin + " · " + (r.tipo === "entrega" ? "Entrega" : "Ruta") + " · " + r.nombre + (r.asignacion ? " · Asignada" : "")))
          : h("option", { value: "" }, S.routes.status === "loading" ? "Cargando rutas…" : "No hay rutas para esta fecha"));
      body.append(h("div", { class: "asn-panel asn-filters" },
        h("label", { class: "asn-field" }, h("span", { class: "asn-lbl" }, "Fecha"),
          h("input", { type: "date", class: "asn-input", value: S.fecha, onchange: e => onFecha(e.target.value) })),
        h("label", { class: "asn-field asn-grow" }, h("span", { class: "asn-lbl" }, "Ruta o entrega del día"), rutaSel)));

      if (S.routes.status === "loading" && !S.routes.data.length) { body.append(h("div", { class: "asn-state" }, "Cargando rutas del día…")); return; }
      if (S.routes.status === "error") {
        body.append(h("div", { class: "asn-state asn-state-err", role: "alert" }, h("h3", { class: "asn-h" }, "No se pudieron cargar las rutas"),
          h("p", {}, S.routes.error), h("button", { type: "button", class: "asn-btn asn-primary", onclick: loadRoutes }, "Reintentar")));
        return;
      }
      if (!rt) { body.append(h("div", { class: "asn-state" }, "No hay rutas ni entregas para esta fecha.")); return; }

      // 2) Resumen de la ruta elegida
      body.append(h("div", { class: "asn-route" },
        h("div", {}, h("b", {}, rt.id), " · ", rt.tipo === "entrega" ? "Entrega" : "Ruta", " · ", rt.nombre),
        h("div", { class: "asn-meta" }, "Horario " + rt.inicio + "–" + rt.fin + " · " + fmtD(toDate(rt.fecha))),
        h("span", { class: "asn-pill " + (rt.asignacion ? "asn-asg" : "asn-no-asig") }, rt.asignacion ? "Asignada" : "Sin asignar")));

      // 3) Listas de conductores y vehículos
      body.append(h("div", { class: "asn-cols" }, listPanel("driver", rt), listPanel("vehicle", rt)));

      // 4) Confirmación
      if (rt.asignacion) {
        const a = rt.asignacion;
        body.append(h("div", { class: "asn-panel asn-done" },
          h("h3", { class: "asn-h" }, "Asignación confirmada · Estado: Asignado"),
          h("p", {}, "Conductor: ", h("b", {}, nombreDe(S.drv, a.conductor, "nombre")), " · Vehículo: ", h("b", {}, nombreDe(S.veh, a.vehiculo, "placa"))),
          h("p", { class: "asn-meta" }, "Guardada el " + fmtD(a.asignado_en) + " a las " + fmtT(a.asignado_en) + " por " + a.usuario + ".")));
        return;
      }
      const cargado = S.drv.status === "ok" && S.veh.status === "ok";
      const dSel = S.drv.data.find(x => x.id === S.d), vSel = S.veh.data.find(x => x.id === S.v);
      const saving = S.asg.status === "saving";
      const can = !!(cargado && dSel && vSel && !saving);
      body.append(h("div", { class: "asn-panel" },
        h("h3", { class: "asn-h" }, "Confirmar asignación"),
        h("div", { class: "asn-assign" },
          h("div", {}, h("div", { class: "asn-lbl" }, "Conductor"), h("div", { class: "asn-val" }, dSel ? dSel.nombre : "Seleccione un conductor disponible")),
          h("div", {}, h("div", { class: "asn-lbl" }, "Vehículo"), h("div", { class: "asn-val" }, vSel ? vSel.placa + " · " + (vSel.tipo || "") : "Seleccione un vehículo disponible")),
          h("div", {}, h("div", { class: "asn-lbl" }, "Ruta"), h("div", { class: "asn-val" }, rt.id + " · " + rt.inicio + "–" + rt.fin)),
          h("div", {}, h("button", { type: "button", class: "asn-btn asn-primary", disabled: !can, onclick: doAssign }, saving ? "Asignando…" : "Confirmar asignación"))),
        cargado ? null : h("p", { class: "asn-warn" }, "No se puede asignar hasta que carguen los conductores y vehículos."),
        S.asg.status === "error" && S.asg.retry
          ? h("div", { class: "asn-retry" }, h("span", {}, "La asignación no se guardó."), h("button", { type: "button", class: "asn-btn asn-primary", onclick: doAssign }, "Reintentar asignación"))
          : null));
    }

    /* ---- Panel de pruebas (solo en modo demostración) ---- */
    if (demo) {
      const chk = (txt, key) => h("label", {}, h("input", { type: "checkbox", onchange: e => { S.demo[key] = e.target.checked; } }), " " + txt);
      const roleSel = h("select", { class: "asn-select asn-auto", "aria-label": "Rol de sesión", onchange: e => { S.demo.role = e.target.value; setMsg("", ""); loadRoutes(); } },
        h("option", { value: "director_rutas" }, "Director de rutas"), h("option", { value: "operador" }, "Operador (sin permiso)"));
      // Salta la pantalla y le pide al "backend" asignar un recurso No disponible, para ver que lo rechaza
      const probarRechazo = () => {
        const rt = route();
        if (!rt || rt.asignacion || S.drv.status !== "ok" || S.veh.status !== "ok") { setMsg("err", "Elija una ruta sin asignar y espere a que carguen los datos."); return; }
        const est = (x, k) => calcEstado(x, k, rt).estado;
        const dBad = S.drv.data.find(x => est(x, "driver") === "no_disponible"), vBad = S.veh.data.find(x => est(x, "vehicle") === "no_disponible");
        const dOk = S.drv.data.find(x => est(x, "driver") === "disponible"), vOk = S.veh.data.find(x => est(x, "vehicle") === "disponible");
        const d = dBad || dOk, v = vBad || vOk;
        if (!d || !v || (!dBad && !vBad)) { setMsg("err", "No hay recursos No disponibles en esta ruta para probar."); return; }
        try { backend.assign(rt.id, d.id, v.id, currentUser()); setMsg("err", "FALLO: el backend aceptó un recurso No disponible."); }
        catch (e) { setMsg("ok", "Prueba superada: el backend rechazó la operación y no se creó la asignación. " + e.message); }
      };
      root.append(h("div", { class: "asn-demo" },
        h("strong", {}, "Modo demostración (sin endpoints configurados)"),
        chk("Fallar carga de conductores", "failDrv"), chk("Fallar carga de vehículos", "failVeh"), chk("Fallar al asignar", "failAsg"),
        h("label", {}, "Rol: ", roleSel),
        h("button", { type: "button", class: "asn-btn", onclick: () => loadRoutes() }, "Recargar datos"),
        h("button", { type: "button", class: "asn-btn", onclick: probarRechazo }, "Probar rechazo del backend"),
        h("button", { type: "button", class: "asn-btn", onclick: () => {
          const r = runTests();
          setMsg(r.ok === r.total ? "ok" : "err", "Pruebas de lógica: " + r.ok + " de " + r.total + " correctas. Detalle en la consola.");
        } }, "Ejecutar pruebas de lógica")));
    }

    loadRoutes();                                                // carga inicial

    return { reload: loadRoutes, unmount() { alive = false; container.replaceChildren(); container.classList.remove("asn"); } };
  }

  global.Asignacion = { mount: mount, calcEstado: calcEstado, overlap: overlap, runTests: runTests };

  /* Auto-montaje solo en la página independiente: <div data-asignacion></div> */
  function auto() {
    const el = document.querySelector("[data-asignacion]");
    if (el && !el.dataset.mounted) { el.dataset.mounted = "1"; mount(el); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", auto);
  else auto();
})(window);
