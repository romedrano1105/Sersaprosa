/* =====================================================================
   DISPONIBILIDAD DE CONDUCTORES Y VEHÍCULOS — SERSAPROSA

   Módulo integrado en PaginaPrincipal.html: no crea variables globales
   (solo window.Disponibilidad), no usa ids propios y todas sus clases CSS
   empiezan con "dsp-".

   Integración en PaginaPrincipal.html:
     <link rel="stylesheet" href="/assets/css/verificarConduCSS.css">
     <div id="panelDisponibilidad"></div>
     <script src="/assets/js/VerificarConduJS.js"></script>
     <script>
       Disponibilidad.mount(document.getElementById('panelDisponibilidad'), {
         LOAD:   N8N.DISP_LOAD,     // o la URL del endpoint
         ASSIGN: N8N.DISP_ASSIGN,
         onUnauthorized: logout     // misma función de salir de PaginaPrincipal
       });
     </script>

   SESIÓN: lee sessionStorage["session"] = { token, name, code, role }, que es lo
   mismo que guarda el login de PaginaPrincipal.html. El backend vuelve a validar
   el token y el rol "coordinador_rutas" en cada petición.

   CONTRATO DE ENDPOINTS:
   1) LOAD (POST, Authorization: Bearer <token>)  {}
        → { drivers:  [{ id, nombre, licencia:"YYYY-MM-DD" }],
            vehicles: [{ id, placa, tipo, seguro:"YYYY-MM-DD", revision:"YYYY-MM-DD" }],
            routes:   [{ id, nombre }],
            assignments: [{ ruta, conductor, vehiculo, fecha:ISO, usuario }],
            totals:   { drivers, vehicles } }     (cantidad registrada, para validar el listado)
   2) ASSIGN (POST, Authorization: Bearer <token>)  { conductor, vehiculo, ruta }
        → { ruta, conductor, vehiculo, fecha, usuario }
        Errores: 401 sesión vencida · 409/422 con { error } o { detail } (FastAPI)
        El servidor debe rechazar a quien esté No disponible y guardar fecha, hora y usuario.
   ===================================================================== */
(function (global) {
  "use strict";

  // CONFIGURACIÓN por defecto. ROLE_ALLOWED = rol que puede entrar.
  // SESSION_KEY = clave de sessionStorage donde PaginaPrincipal guarda la sesión.
  const DISP = {
    LOAD: "/disponibilidad/listar",
    ASSIGN: "/disponibilidad/asignar",
    ROLE_ALLOWED: "coordinador_rutas",
    SESSION_KEY: "session",
    onUnauthorized: null
  };

  /* ============ Utilidades ============ */
  // ---------- UTILIDADES ----------
  // DAY = milisegundos de un día; DOCS = qué documentos vencen en cada tipo.
  const DAY = 864e5;
  const DOCS = { driver: [["licencia", "Licencia"]], vehicle: [["seguro", "Seguro"], ["revision", "Revisión técnica"]] };
  // wait simula la espera de una red; fmtD/fmtT dan formato de fecha y hora (es-SV).
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const fmtD = d => d.toLocaleDateString("es-SV");
  const fmtT = d => d.toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit" });
  const startOfToday = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };

  // Convierte lo que llegue del servidor (texto ISO, Date o vacío) en un Date.
  // Las fechas 'YYYY-MM-DD' se leen en hora local para que no se corran un día.
  function toDate(v) {
    if (v == null || v === "") return null;
    if (v instanceof Date) return v;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const p = v.split("-");
      return new Date(+p[0], +p[1] - 1, +p[2]);
    }
    return new Date(v);
  }

  // Ayudante para crear elementos HTML sin usar innerHTML (los textos van como texto, no como código).
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

  /* ============ Lógica de disponibilidad (pura) ============ */
  // ---------- REGLA DE NEGOCIO ----------
  // Decide si un conductor ('driver') o vehículo ('vehicle') está disponible.
  // Devuelve { ok, motivos }. No disponible si: documento vencido, sin fecha, o ya asignado a una ruta.
  function calcDisp(e, kind, asg, now) {
    now = now || startOfToday();
    const motivos = [];
    for (const [k, label] of DOCS[kind]) {
      const f = e[k];
      if (!(f instanceof Date) || isNaN(f)) motivos.push(label + " sin fecha registrada");
      else if (f < now) motivos.push(label + " vencida el " + fmtD(f));
    }
    const a = asg.find(x => (kind === "driver" ? x.conductor === e.id : x.vehiculo === e.id));
    if (a) motivos.push("Ya asignado a la ruta " + a.ruta);
    // Lo que devuelve mount(): reload() para recargar y unmount() para quitar el componente.
    return { ok: motivos.length === 0, motivos };
  }

  // Convierte la respuesta del servidor al formato interno: pasa fechas a Date,
  // calcula la disponibilidad de cada registro, valida que la cantidad del listado
  // coincida con 'totals' (cantidad registrada) y deja solo las rutas sin asignar.
  function normalize(raw) {
    if (!raw || !Array.isArray(raw.drivers) || !Array.isArray(raw.vehicles)) {
      throw new Error("La respuesta de disponibilidad no tiene el formato esperado.");
    }
    const asg = (raw.assignments || []).map(a => Object.assign({}, a, { fecha: toDate(a.fecha) || new Date() }));
    const now = startOfToday();
    const drivers = raw.drivers.map(d => {
      const x = Object.assign({}, d, { licencia: toDate(d.licencia) });
      x.disp = calcDisp(x, "driver", asg, now); return x;
    });
    const vehicles = raw.vehicles.map(v => {
      const x = Object.assign({}, v, { seguro: toDate(v.seguro), revision: toDate(v.revision) });
      x.disp = calcDisp(x, "vehicle", asg, now); return x;
    });
    if (raw.totals && (raw.totals.drivers !== drivers.length || raw.totals.vehicles !== vehicles.length)) {
      throw new Error("El listado no coincide con los registros existentes. Intente de nuevo.");
    }
    const usadas = new Set(asg.map(a => a.ruta));
    const routes = (raw.routes || []).filter(r => !usadas.has(r.id));
    return { drivers, vehicles, routes, asg };
  }

  /* ============ Datos de demostración (se ignoran al configurar LOAD) ============ */
  // ---------- DATOS DE DEMOSTRACIÓN ----------
  // Solo se usan si LOAD está vacío. Al conectar el backend real no se necesitan.
  function makeDemo() {
    const t = startOfToday(), off = n => new Date(t.getTime() + n * DAY);
    return {
      drivers: [
        { id: "C-01", nombre: "Carlos Mejía", licencia: off(300) },
        { id: "C-02", nombre: "José Ramírez", licencia: off(45) },
        { id: "C-03", nombre: "Luis Hernández", licencia: off(120) },
        { id: "C-04", nombre: "Ana Portillo", licencia: off(-12) },
        { id: "C-05", nombre: "Marvin Alas", licencia: off(210) },
        { id: "C-06", nombre: "Kevin Rivas", licencia: off(-90) }
      ],
      vehicles: [
        { id: "V-01", placa: "P 482-193", tipo: "Camión blindado", seguro: off(200), revision: off(150) },
        { id: "V-02", placa: "P 117-654", tipo: "Camioneta de valores", seguro: off(30), revision: off(60) },
        { id: "V-03", placa: "P 905-231", tipo: "Camión de carga", seguro: off(-5), revision: off(90) },
        { id: "V-04", placa: "P 336-780", tipo: "Camión blindado", seguro: off(180), revision: off(75) },
        { id: "V-05", placa: "P 654-012", tipo: "Camioneta de valores", seguro: off(140), revision: off(-20) }
      ],
      routes: [
        { id: "R-100", nombre: "San Salvador – Santa Ana (valores)" },
        { id: "R-101", nombre: "San Salvador – San Miguel (efectivo)" },
        { id: "R-102", nombre: "Santa Tecla – La Libertad (mercancía)" },
        { id: "R-103", nombre: "Soyapango – Sonsonate (valores)" }
      ],
      assignments: [
        { ruta: "R-100", conductor: "C-03", vehiculo: "V-04", fecha: new Date(Date.now() - 3600e3), usuario: "Pedro Aguilar" }
      ]
    };
  }

  /* ============ Pruebas de la lógica ============ */
  // ---------- PRUEBAS DE LA LÓGICA ----------
  // Verifican calcDisp, normalize y la lectura de fechas. Resultado en consola y en pantalla.
  function runTests() {
    const res = [], t = startOfToday(), off = n => new Date(t.getTime() + n * DAY);
    const ck = (n, c) => res.push([n, !!c]);
    ck("Conductor vigente y libre = disponible", calcDisp({ id: "X", licencia: off(10) }, "driver", [], t).ok);
    ck("Licencia vencida = no disponible", !calcDisp({ id: "X", licencia: off(-1) }, "driver", [], t).ok);
    ck("Licencia que vence hoy sigue vigente", calcDisp({ id: "X", licencia: off(0) }, "driver", [], t).ok);
    ck("Licencia sin fecha = no disponible", !calcDisp({ id: "X", licencia: null }, "driver", [], t).ok);
    ck("Seguro vencido = no disponible", !calcDisp({ id: "V", seguro: off(-2), revision: off(5) }, "vehicle", [], t).ok);
    ck("Revisión vencida = no disponible", !calcDisp({ id: "V", seguro: off(5), revision: off(-2) }, "vehicle", [], t).ok);
    const a = [{ ruta: "R-9", conductor: "X", vehiculo: "V", fecha: new Date(), usuario: "u" }];
    const r1 = calcDisp({ id: "X", licencia: off(10) }, "driver", a, t);
    ck("Ya asignado = no disponible con motivo", !r1.ok && r1.motivos[0].includes("R-9"));
    ck("Vehículo ya asignado = no disponible", !calcDisp({ id: "V", seguro: off(5), revision: off(5) }, "vehicle", a, t).ok);
    ck("Fecha YYYY-MM-DD se lee en hora local", toDate("2026-10-10").getDate() === 10);
    let fallo = false;
    try { normalize({ drivers: [], vehicles: [], totals: { drivers: 1, vehicles: 0 } }); } catch (e) { fallo = true; }
    ck("Listado distinto a lo registrado produce error", fallo);
    const n = normalize(makeDemo());
    ck("Demo: hay disponibles y no disponibles", n.drivers.some(x => x.disp.ok) && n.drivers.some(x => !x.disp.ok));
    ck("Demo: la ruta ya asignada no se ofrece", !n.routes.some(r => r.id === "R-100"));
    res.forEach(r => console.log((r[1] ? "OK    " : "FALLO ") + r[0]));
    return { ok: res.filter(r => r[1]).length, total: res.length };
  }

  /* ============ Componente ============ */
  // ---------- COMPONENTE PRINCIPAL ----------
  // mount(contenedor, opciones) dibuja toda la sección dentro de 'contenedor'.
  // Cada llamada crea su propio estado, así no choca con nada de la página.
  function mount(container, opts) {
    // cfg = configuración por defecto + las opciones que pase quien llame a mount().
    const cfg = Object.assign({}, DISP, opts || {});
    // Modo demostración: se activa cuando no hay URL de LOAD configurada.
    const demo = !cfg.LOAD;
    const DB = demo ? makeDemo() : null;
    // Estado de la pantalla: datos cargados, cargando/error, conductor (d) y vehículo (v)
    // elegidos, si se está guardando, y los controles del panel de pruebas.
    const S = { data: null, loading: true, error: null, d: null, v: null, saving: false, demoFail: false, demoRole: null };
    let alive = true;

    /* ---- sesión ---- */
    // ---- SESIÓN ----
    // Lee la sesión que guardó el login de PaginaPrincipal.html: { token, name, code, role }.
    function getSession() {
      if (cfg.session) return typeof cfg.session === "function" ? cfg.session() : cfg.session;
      try { const s = sessionStorage.getItem(cfg.SESSION_KEY); if (s) return JSON.parse(s); } catch (e) { /* sin sesión */ }
      return null;
    }
    function currentUser() {
      const s = getSession();
      return s ? (s.name || s.code || s.user || "Usuario") : (demo ? "María Hernández" : "");
    }
    // Rol actual. En demostración, si no hay rol se asume coordinador de rutas.
    // En modo real, si la sesión no trae 'role' el acceso queda bloqueado.
    function currentRole() {
      if (demo && S.demoRole) return S.demoRole;
      const s = getSession();
      if (s && s.role) return s.role;
      return demo ? cfg.ROLE_ALLOWED : null;
    }
    const roleOk = () => currentRole() === cfg.ROLE_ALLOWED;
    const hasSession = () => demo || !!getSession();

    /* ---- servicio ---- */
    // ---- SERVICIO ----
    // POST con JSON y el token en la cabecera Authorization (igual que api() de PaginaPrincipal).
    // 401 = sesión vencida: avisa a la página con onUnauthorized. Otros errores usan 'error' o 'detail' (FastAPI).
    async function post(url, body) {
      const s = getSession();
      const r = await fetch(url, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, s && s.token ? { Authorization: "Bearer " + s.token } : {}),
        body: JSON.stringify(body)
      });
      if (r.status === 401) {
        if (typeof cfg.onUnauthorized === "function") cfg.onUnauthorized();
        throw new Error("Sesión vencida. Inicie sesión de nuevo.");
      }
      let data = null;
      try { data = await r.json(); } catch (e) { /* sin cuerpo */ }
      if (!r.ok) throw new Error((data && (data.error || data.detail)) || ("Error " + r.status));
      return data;
    }

    // Carga conductores, vehículos, rutas y asignaciones (del servidor, o de los datos demo).
    async function fetchData() {
      if (!demo) return normalize(await post(cfg.LOAD, {}));
      await wait(500);
      if (S.demoFail) throw new Error("No se pudo cargar la disponibilidad. Revise la conexión e intente de nuevo.");
      return normalize({
        drivers: DB.drivers, vehicles: DB.vehicles, routes: DB.routes,
        assignments: DB.assignments.slice(), totals: { drivers: DB.drivers.length, vehicles: DB.vehicles.length }
      });
    }

    // Guarda la asignación. FLUJO FALLIDO: si el conductor o el vehículo está No disponible,
    // lanza un error y NO se crea la asignación. FLUJO EXITOSO: guarda con fecha, hora y usuario.
    async function assignSvc(dId, vId, rId) {
      if (!roleOk()) throw new Error("No tiene permiso para asignar rutas.");
      const D = S.data;
      const d = D && D.drivers.find(x => x.id === dId), v = D && D.vehicles.find(x => x.id === vId);
      if (!d || !v || !rId) throw new Error("Conductor, vehículo o ruta no válidos.");
      // Bloqueo de asignación a quien está No disponible (se valida aquí aunque la interfaz ya lo impide).
      if (!d.disp.ok) throw new Error("No se creó la asignación. " + d.nombre + ": " + d.disp.motivos.join("; ") + ".");
      if (!v.disp.ok) throw new Error("No se creó la asignación. " + v.placa + ": " + v.disp.motivos.join("; ") + ".");
      // Modo real: envía la asignación al endpoint ASSIGN. El servidor debe volver a validarla.
      if (!demo) {
        const rec = await post(cfg.ASSIGN, { conductor: dId, vehiculo: vId, ruta: rId });
        const out = Object.assign({ ruta: rId, conductor: dId, vehiculo: vId, usuario: currentUser() }, rec || {});
        out.fecha = toDate(out.fecha) || new Date();
        return out;
      }
      // Modo demostración: se revalida con los datos actuales y se guarda en memoria.
      await wait(300);
      const now = startOfToday();
      const dd = calcDisp(DB.drivers.find(x => x.id === dId), "driver", DB.assignments, now);
      const vd = calcDisp(DB.vehicles.find(x => x.id === vId), "vehicle", DB.assignments, now);
      if (!dd.ok) throw new Error("No se creó la asignación. " + d.nombre + ": " + dd.motivos.join("; ") + ".");
      if (!vd.ok) throw new Error("No se creó la asignación. " + v.placa + ": " + vd.motivos.join("; ") + ".");
      if (DB.assignments.some(a => a.ruta === rId)) throw new Error("La ruta " + rId + " ya tiene una asignación.");
      const rec = { ruta: rId, conductor: dId, vehiculo: vId, fecha: new Date(), usuario: currentUser() };
      DB.assignments.push(rec);
      return rec;
    }

    /* ---- estructura fija ---- */
    // ---- ESTRUCTURA FIJA ----
    // Encabezado, caja de mensajes y cuerpo. Solo el cuerpo se vuelve a dibujar en cada render().
    const headUser = h("b"), headRole = h("span");
    const head = cfg.showHeader === false ? null : h("div", { class: "dsp-head" },
      h("div", {},
        h("h2", { class: "dsp-title" }, cfg.title || (cfg.view === "assignment" ? "Asignar Ruta" : "Empleados y Vehículos")),
        h("p", { class: "dsp-sub" }, cfg.subtitle || "SERSAPROSA · Disponibilidad operativa")),
      h("div", { class: "dsp-who" }, "Sesión: ", headUser, h("br"), headRole));
    const msgBox = h("div", { class: "dsp-msgbox", role: "status", "aria-live": "polite" });
    const body = h("div", { class: "dsp-body" });
    const root = h("div", { class: "dsp-root" }, head, msgBox, body);
    container.classList.add("dsp");
    container.replaceChildren(root);

    // Muestra un mensaje de éxito ('ok') o error ('err'); con texto vacío lo borra.
    function setMsg(type, text) {
      msgBox.replaceChildren();
      if (text) msgBox.append(h("div", { class: "dsp-msg dsp-msg-" + type }, text));
    }

    /* ---- acciones ---- */
    // ---- ACCIONES ----
    // Carga (o recarga) la disponibilidad. Es lo que ejecuta el botón Reintentar.
    // Si lo elegido dejó de estar disponible, se quita de la selección.
    async function load() {
      S.loading = true; S.error = null; render();
      // Solo consulta al servidor si hay sesión y el rol tiene permiso.
      if (hasSession() && roleOk()) {
        try { S.data = await fetchData(); } catch (e) { S.error = e.message; S.data = null; }
      } else { S.data = null; }
      if (!alive) return;
      S.loading = false;
      if (S.data) {
        if (S.d && !(S.data.drivers.find(x => x.id === S.d) || { disp: {} }).disp.ok) S.d = null;
        if (S.v && !(S.data.vehicles.find(x => x.id === S.v) || { disp: {} }).disp.ok) S.v = null;
      }
      render();
    }

    // Elegir o quitar un conductor/vehículo. Si está No disponible no se elige: se muestra el motivo.
    function pick(kind, item) {
      if (!item.disp.ok) {
        setMsg("err", "No se puede asignar " + (kind === "driver" ? item.nombre : item.placa) + ": " + item.disp.motivos.join("; ") + ".");
        return;
      }
      setMsg("", "");
      const key = kind === "driver" ? "d" : "v";
      S[key] = S[key] === item.id ? null : item.id;
      render();
    }

    // Pulsar 'Asignar ruta': guarda, muestra el resultado y recarga para actualizar contadores y listas.
    async function doAssign(routeId) {
      S.saving = true; render();
      try {
        const rec = await assignSvc(S.d, S.v, routeId);
        S.d = null; S.v = null; S.saving = false;
        setMsg("ok", "Asignación guardada: ruta " + rec.ruta + " el " + fmtD(rec.fecha) + " a las " + fmtT(rec.fecha) + " por " + rec.usuario + ".");
      } catch (e) {
        S.saving = false;
        setMsg("err", e.message);
      }
      await load();
    }

    /* ---- vista ---- */
    // ---- VISTA ----
    // Dibuja una fila de conductor o vehículo: nombre, estado, datos y el motivo si no está disponible.
    function row(kind, item) {
      const sel = (kind === "driver" ? S.d : S.v) === item.id;
      const title = kind === "driver" ? item.nombre : item.placa;
      const meta = kind === "driver"
        ? item.id + " · Licencia vence " + (item.licencia && !isNaN(item.licencia) ? fmtD(item.licencia) : "sin registrar")
        : item.id + " · " + (item.tipo || "Vehículo");
      return h("li", { class: "dsp-row" + (sel ? " dsp-sel" : "") },
        h("div", {},
          h("span", { class: "dsp-nm" }, title),
          h("span", { class: "dsp-pill " + (item.disp.ok ? "dsp-ok" : "dsp-no") }, item.disp.ok ? "Disponible" : "No disponible"),
          h("div", { class: "dsp-meta" }, meta)),
        h("button", { type: "button", class: "dsp-btn", "aria-pressed": sel ? "true" : "false", onclick: () => pick(kind, item) }, sel ? "Quitar" : "Elegir"),
        item.disp.ok ? null : h("div", { class: "dsp-why" }, "Motivo: " + item.disp.motivos.join("; ")));
    }

    // Dibuja el cuerpo según el estado: sin sesión, sin permiso, cargando, error o datos.
    function render() {
      headUser.textContent = currentUser() || "sin sesión";
      headRole.textContent = roleOk() ? "Coordinador de rutas" : (currentRole() || "");
      body.replaceChildren();
      // Caso 1: no hay sesión iniciada.
      if (!hasSession()) {
        body.append(h("div", { class: "dsp-state dsp-state-err" }, h("h3", { class: "dsp-h" }, "Sesión requerida"),
          h("p", {}, "Inicie sesión para ver la disponibilidad.")));
        return;
      }
      // Caso 2: el rol no es administrador de rutas.
      if (!roleOk()) {
        body.append(h("div", { class: "dsp-state dsp-state-err" }, h("h3", { class: "dsp-h" }, "Acceso restringido"),
          h("p", {}, "Esta sección es solo para el administrador de rutas.")));
        return;
      }
      // Caso 3: todavía cargando.
      if (S.loading) { body.append(h("div", { class: "dsp-state" }, "Cargando disponibilidad…")); return; }
      // Caso 4: falló la carga o el listado no coincide con lo registrado. Se ofrece Reintentar.
      if (S.error) {
        body.append(h("div", { class: "dsp-state dsp-state-err", role: "alert" },
          h("h3", { class: "dsp-h" }, "No se pudo cargar la disponibilidad"),
          h("p", {}, S.error),
          h("button", { type: "button", class: "dsp-btn dsp-primary", onclick: load }, "Reintentar")));
        return;
      }
      const D = S.data;
      // Contadores de disponibles y las dos listas (conductores y vehículos).
      const dOk = D.drivers.filter(x => x.disp.ok).length, vOk = D.vehicles.filter(x => x.disp.ok).length;
      const cnt = (n, tot, label) => h("div", { class: "dsp-cnt" },
        h("div", { class: "dsp-n" }, String(n), tot != null ? h("small", {}, " de " + tot) : null), h("div", { class: "dsp-l" }, label));
      if (cfg.view !== "assignment") {
        body.append(
          h("div", { class: "dsp-counters" },
            cnt(dOk, D.drivers.length, "Conductores disponibles para asignar"),
            cnt(vOk, D.vehicles.length, "Vehículos disponibles para asignar"),
            cnt(Math.min(dOk, vOk, D.routes.length), null, "Rutas que se pueden cubrir ahora")),
          h("div", { class: "dsp-cols" },
            h("div", { class: "dsp-panel" }, h("h3", { class: "dsp-h" }, "Conductores (" + D.drivers.length + ")"), h("ul", { class: "dsp-list" }, D.drivers.map(x => row("driver", x)))),
            h("div", { class: "dsp-panel" }, h("h3", { class: "dsp-h" }, "Vehículos (" + D.vehicles.length + ")"), h("ul", { class: "dsp-list" }, D.vehicles.map(x => row("vehicle", x))))));
      }

      if (cfg.view !== "resources") {
        const dSel = D.drivers.find(x => x.id === S.d), vSel = D.vehicles.find(x => x.id === S.v);
        const routeSel = h("select", { class: "dsp-select", "aria-label": "Ruta" },
          D.routes.length ? D.routes.map((r, index) => h("option", { value: r.id, selected: index === 0 }, r.id + " · " + r.nombre)) : h("option", { value: "" }, "No hay rutas sin asignar"));
        const can = !!(dSel && vSel && D.routes.length && !S.saving);
        let fields;
        if (cfg.view === "assignment") {
          const choice = (label, items, selected, display, save) => h("label", { class: "dsp-field" },
            h("span", { class: "dsp-lbl" }, label),
            h("select", {
              class: "dsp-select",
              onchange: event => { save(event.target.value || null); render(); }
            },
            h("option", { value: "" }, "Seleccionar " + label.toLowerCase()),
            items.filter(item => item.disp.ok).map(item =>
              h("option", { value: item.id, selected: item.id === selected }, display(item)))));
          fields = h("div", { class: "dsp-assign dsp-assign-form" },
            choice("Conductor", D.drivers, S.d, item => item.nombre, value => { S.d = value; }),
            choice("Vehículo", D.vehicles, S.v, item => item.placa + " · " + (item.tipo || ""), value => { S.v = value; }),
            h("label", { class: "dsp-field" }, h("span", { class: "dsp-lbl" }, "Ruta"), routeSel),
            h("button", { type: "button", class: "dsp-btn dsp-primary", disabled: !can, onclick: () => doAssign(routeSel.value) }, S.saving ? "Guardando…" : "Confirmar asignación"));
        } else {
          fields = h("div", { class: "dsp-assign" },
            h("div", {}, h("div", { class: "dsp-lbl" }, "Conductor"), h("div", { class: "dsp-val" }, dSel ? dSel.nombre : "Elija un conductor disponible")),
            h("div", {}, h("div", { class: "dsp-lbl" }, "Vehículo"), h("div", { class: "dsp-val" }, vSel ? vSel.placa + " · " + (vSel.tipo || "") : "Elija un vehículo disponible")),
            h("div", {}, h("div", { class: "dsp-lbl" }, "Ruta"), routeSel),
            h("div", {}, h("button", { type: "button", class: "dsp-btn dsp-primary", disabled: !can, onclick: () => doAssign(routeSel.value) }, S.saving ? "Guardando…" : "Asignar ruta")));
        }
        body.append(h("div", { class: "dsp-panel dsp-gap" },
          cfg.view === "assignment" ? null : h("h3", { class: "dsp-h" }, "Asignar a una ruta"),
          fields));
      }

      if (cfg.showHistory !== false) {
        const asg = D.asg.slice().reverse();
        body.append(h("div", { class: "dsp-panel dsp-gap" },
          h("h3", { class: "dsp-h" }, "Asignaciones de hoy (" + asg.length + ")"),
          asg.length ? h("div", { class: "dsp-scroll" }, h("table", { class: "dsp-table" },
            h("thead", {}, h("tr", {}, ["Hora", "Ruta", "Conductor", "Vehículo", "Usuario"].map(t => h("th", {}, t)))),
            h("tbody", {}, asg.map(a => {
              const d = D.drivers.find(x => x.id === a.conductor), v = D.vehicles.find(x => x.id === a.vehiculo);
              return h("tr", {}, h("td", {}, fmtT(a.fecha)), h("td", {}, a.ruta),
                h("td", {}, d ? d.nombre : a.conductor), h("td", {}, v ? v.placa : a.vehiculo), h("td", {}, a.usuario));
            })))) : h("p", { class: "dsp-meta" }, "Todavía no hay asignaciones para hoy.")));
      }
    }

    /* ---- panel de pruebas (solo en modo demostración) ---- */
    // ---- PANEL DE PRUEBAS (solo en modo demostración) ----
    // Permite simular una falla de carga, cambiar de rol y ejecutar las pruebas de lógica.
    if (demo) {
      const fail = h("input", { type: "checkbox", onchange: e => { S.demoFail = e.target.checked; } });
      const roleSel = h("select", { class: "dsp-select dsp-auto", "aria-label": "Rol de sesión", onchange: e => { S.demoRole = e.target.value; setMsg("", ""); load(); } },
        h("option", { value: "coordinador_rutas" }, "Coordinador de rutas"),
        h("option", { value: "operador" }, "Operador (sin permiso)"));
      const testBtn = h("button", { type: "button", class: "dsp-btn", onclick: () => {
        const r = runTests();
        setMsg(r.ok === r.total ? "ok" : "err", "Pruebas de lógica: " + r.ok + " de " + r.total + " correctas. Detalle en la consola.");
      } }, "Ejecutar pruebas de lógica");
      root.append(h("div", { class: "dsp-demo" },
        h("strong", {}, "Modo demostración (sin endpoints configurados)"),
        h("label", {}, fail, " Simular falla de carga"),
        h("label", {}, "Rol de sesión: ", roleSel),
        testBtn));
    }

    // Carga inicial al montar el componente.
    load();

    return {
      reload: load,
      unmount() { alive = false; container.replaceChildren(); container.classList.remove("dsp"); }
    };
  }

  // Única variable global que se expone.
  global.Disponibilidad = { mount: mount, calcDisp: calcDisp, normalize: normalize, runTests: runTests };

  /* Auto-montaje solo en la página independiente: <div data-disponibilidad></div> */
  // Auto-montaje: solo si la página trae <div data-disponibilidad>. En PaginaPrincipal.html
  // no hace falta ese atributo: se llama a Disponibilidad.mount(...) a mano.
  function auto() {
    const el = document.querySelector("[data-disponibilidad]");
    if (el && !el.dataset.mounted) { el.dataset.mounted = "1"; mount(el); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", auto);
  else auto();
})(window);
