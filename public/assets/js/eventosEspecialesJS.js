/* =====================================================================
   EVENTOS ESPECIALES — SERSAPROSA   (FCJ1-15 · subtareas FCJ1-62 a FCJ1-71)

   Historia: como coordinador de rutas quiero revisar los eventos especiales
   (marchas, feriados, cierres viales y otros) para anticipar su impacto en las
   rutas planificadas.

   Módulo integrado en PaginaPrincipal.html: no crea variables globales
   (solo window.EventosEspeciales), no usa ids propios y todas sus clases CSS
   empiezan con "ev-".

   CÓMO INCRUSTARLO EN PaginaPrincipal.html:
     <link rel="stylesheet" href="/assets/css/eventosEspecialesCSS.css">
     <div id="panelEventos"></div>
     <script src="/assets/js/eventosEspecialesJS.js"></script>
     <script>
       EventosEspeciales.mount(document.getElementById('panelEventos'), {
         LOAD:   N8N.EVT_LOAD,      // o la URL del endpoint
         REVIEW: N8N.EVT_REVIEW,
         CREATE: N8N.EVT_CREATE,
         onUnauthorized: logout     // misma función de salir de PaginaPrincipal
       });
     </script>

   SESIÓN: lee sessionStorage["session"] = { token, name, code, role }, igual que
   el módulo de disponibilidad. El rol permitido es "coordinador_rutas". La
   validación real del rol y del token SIEMPRE debe repetirse en el backend
   (ver eventos_router.py).

   CONTRATO DE ENDPOINTS (si una URL está vacía, funciona en modo demostración):
   1) LOAD (POST, Authorization: Bearer <token>)  {}
        → { events: [{ id, nombre, tipo:"feriado|marcha|cierre_vial|otro",
                       inicio:"YYYY-MM-DDTHH:mm", fin?:"YYYY-MM-DDTHH:mm",
                       zona, lat?, lng?, radius_m?, impacto:"bajo|medio|alto",
                       estado:"pendiente|revisado", fuente,
                       rutas_afectadas:[id,...] | [{id},...],
                       nota?, revisado_por?, revisado_en? }],
            routes: [{ id, nombre, zona, fecha:"YYYY-MM-DD", entregas, conductor }],
            audit:  [{ evento, accion:"registro|revision", usuario, fecha, nota? }],
            totals: { events }  }      (cantidad registrada en los próximos 30 días)
   2) REVIEW (POST)  { id, nota }
        → { id, estado:"revisado", revisado_por, revisado_en }
   3) CREATE (POST)  { nombre, tipo, inicio, zona, impacto, fuente?, lat?, lng?, radius_m? }
        → { id, ... }   Errores: 401 sesión vencida · 409/422 con { error } o { detail }
   ===================================================================== */
(function (global) {
  "use strict";

  // CONFIGURACIÓN por defecto. LOAD/REVIEW/CREATE vacíos = modo demostración.
  const EV = {
    LOAD: "/eventos/listar", REVIEW: "/eventos/revisar", CREATE: "/eventos/registrar",
    ROLE_ALLOWED: "coordinador_rutas",
    SESSION_KEY: "session",
    onUnauthorized: () => global.AppNavigation && global.AppNavigation.handleUnauthorized()
  };

  /* ============ Constantes ============ */
  const DAY = 864e5;
  const WINDOW_DAYS = 30;          // se muestran los eventos de los próximos 30 días
  const PAGE_SIZE = 5;             // eventos por página del listado
  const MSG_INCONSISTENT = "Algunos eventos o rutas afectadas no pudieron cargarse";
  const TIPOS = [["feriado", "Feriado"], ["marcha", "Marcha"], ["cierre_vial", "Cierre vial"], ["otro", "Otro"]];
  const IMPACTOS = [["bajo", "Bajo"], ["medio", "Medio"], ["alto", "Alto"]];
  const ESTADOS = [["pendiente", "Pendiente de revisión"], ["revisado", "Revisado"]];
  const COLOR = { alto: "#e5533d", medio: "#f2b544", bajo: "#7fb2e5" };
  const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const DIAS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
  const CENTER = [13.6929, -89.2182]; // San Salvador

  /* ============ Utilidades ============ */
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const lab = (list, v) => { const f = list.find(x => x[0] === v); return f ? f[1] : (v || ""); };
  const pad = n => String(n).padStart(2, "0");
  const fmtD = d => d.toLocaleDateString("es-SV");
  const fmtT = d => d.toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit" });
  const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const startOfToday = () => dayStart(new Date());
  // Texto sin tildes, en minúscula y sin espacios repetidos (para comparar zonas y nombres).
  const norm = s => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

  // Convierte texto ISO, Date o vacío en Date. 'YYYY-MM-DD' se lee en hora local.
  function toDate(v) {
    if (v == null || v === "") return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const p = v.split("-");
      return new Date(+p[0], +p[1] - 1, +p[2]);
    }
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }

  // Crea elementos HTML sin innerHTML (los textos van como texto, no como código).
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = v;
      else if (k === "value") e.value = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null) e.append(c);
    return e;
  }

  /* ============ Lógica pura (se prueba con runTests) ============ */
  // Rango de días que cubre un evento: [inicio, fin] (si no hay fin, solo el día de inicio).
  const evRange = e => [dayStart(e.inicio), dayStart(e.fin || e.inicio)];
  const overlap = (a0, a1, b0, b1) => a0 <= b1 && a1 >= b0;
  // ¿El evento cae dentro de los próximos 30 días (contando hoy)?
  function inWindow(e, now) {
    const t = dayStart(now || new Date()), r = evRange(e);
    return overlap(r[0], r[1], t, addDays(t, WINDOW_DAYS));
  }
  const isNacional = z => norm(z) === "nacional";

  // Rutas planificadas que debería afectar un evento: misma zona y fecha dentro de su rango.
  // Un evento de zona "Nacional" (p. ej. un feriado) afecta a todas las rutas de esos días.
  function expectedRoutes(e, routes) {
    const r = evRange(e);
    return routes.filter(x => x.fecha && (isNacional(e.zona) || norm(x.zona) === norm(e.zona)) &&
      overlap(r[0], r[1], dayStart(x.fecha), dayStart(x.fecha)));
  }

  // Convierte la respuesta del servidor al formato interno y VALIDA la consistencia:
  //  - la cantidad listada debe coincidir con la registrada (totals.events);
  //  - las rutas afectadas de cada evento deben coincidir con las rutas planificadas
  //    en esa fecha y zona (ni faltantes ni sobrantes).
  // Si algo no cuadra lanza un error con el mensaje fijo de la historia (y 'detail' con el caso).
  function inconsistent(detail) { const err = new Error(MSG_INCONSISTENT); err.detail = detail; err.retry = true; return err; }
  function normalize(raw, now) {
    now = now || startOfToday();
    if (!raw || !Array.isArray(raw.events)) throw new Error("La respuesta de eventos no tiene el formato esperado.");
    const routes = (raw.routes || []).map(r => Object.assign({}, r, { fecha: toDate(r.fecha) }));
    const audit = (raw.audit || []).map(a => Object.assign({}, a, { fecha: toDate(a.fecha) || new Date() }));
    const events = raw.events.map(e => Object.assign({}, e, {
      inicio: toDate(e.inicio), fin: toDate(e.fin), revisado_en: toDate(e.revisado_en),
      rutas_ids: (e.rutas_afectadas || []).map(x => (x && typeof x === "object") ? x.id : x)
    }));
    if (events.some(e => !e.inicio || !e.id || !e.nombre)) throw new Error("La respuesta de eventos no tiene el formato esperado.");
    if (raw.totals && raw.totals.events !== events.length) {
      throw inconsistent("El listado muestra " + events.length + " eventos y hay " + raw.totals.events + " registrados.");
    }
    const problems = [];
    events.filter(e => inWindow(e, now)).forEach(e => {
      const exp = expectedRoutes(e, routes);
      exp.filter(r => !e.rutas_ids.includes(r.id)).forEach(r =>
        problems.push("La ruta " + r.id + " está planificada en " + e.zona + " el " + fmtD(r.fecha) +
          ", pero el evento «" + e.nombre + "» indica " + e.rutas_ids.length + " rutas afectadas."));
      e.rutas_ids.filter(id => !exp.some(r => r.id === id)).forEach(id =>
        problems.push("El evento «" + e.nombre + "» lista la ruta " + id + ", que no está planificada en " + e.zona + " en esa fecha."));
    });
    if (problems.length) throw inconsistent(problems[0] + (problems.length > 1 ? " (y " + (problems.length - 1) + " más)" : ""));
    // Enriquecer: rutas afectadas, entregas y conductores involucrados.
    const list = events.filter(e => inWindow(e, now)).map(e => {
      const rutas = e.rutas_ids.map(id => routes.find(r => r.id === id) || { id: id, nombre: id });
      const cond = Array.from(new Set(rutas.map(r => r.conductor).filter(Boolean)));
      return Object.assign({}, e, {
        rutas: rutas, conductores: cond,
        entregas: rutas.reduce((s, r) => s + (Number(r.entregas) || 0), 0)
      });
    }).sort((a, b) => a.inicio - b.inicio);
    return { events: list, routes: routes, audit: audit };
  }

  // Filtros: fecha (desde/hasta), tipo, zona, nivel de impacto y estado.
  function matches(e, f) {
    if (f.tipo && e.tipo !== f.tipo) return false;
    if (f.impacto && e.impacto !== f.impacto) return false;
    if (f.estado && e.estado !== f.estado) return false;
    if (f.zona && norm(e.zona) !== norm(f.zona)) return false;
    const d0 = toDate(f.desde), d1 = toDate(f.hasta), r = evRange(e);
    if (d0 && r[1] < d0) return false;
    if (d1 && r[0] > d1) return false;
    return true;
  }
  const applyFilters = (events, f) => events.filter(e => matches(e, f));
  // Eventos de impacto alto que los filtros actuales están dejando fuera.
  const hiddenHigh = (events, f) => events.filter(e => e.impacto === "alto" && !matches(e, f));
  const pendingCount = events => events.filter(e => e.estado !== "revisado").length;
  function paginate(list, page, size) {
    size = size || PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(list.length / size));
    const p = Math.min(Math.max(1, page || 1), pages);
    return { items: list.slice((p - 1) * size, p * size), page: p, pages: pages, total: list.length, from: list.length ? (p - 1) * size + 1 : 0, to: Math.min(p * size, list.length) };
  }
  const hasCoords = e => typeof e.lat === "number" && typeof e.lng === "number" && isFinite(e.lat) && isFinite(e.lng);

  // Validación del formulario de registro manual (campos obligatorios y duplicados).
  // Devuelve un arreglo de mensajes; vacío = válido.
  function validateNew(f, existing, now) {
    now = now || startOfToday();
    const errs = [];
    const nombre = (f.nombre || "").trim();
    if (!nombre) errs.push("El nombre del evento es obligatorio.");
    else if (nombre.length > 120) errs.push("El nombre no puede pasar de 120 caracteres.");
    if (!TIPOS.some(t => t[0] === f.tipo)) errs.push("Elija el tipo de evento.");
    if (!IMPACTOS.some(t => t[0] === f.impacto)) errs.push("Elija el nivel de impacto.");
    if (!(f.zona || "").trim()) errs.push("La zona afectada es obligatoria.");
    const fecha = toDate(f.fecha);
    if (!f.fecha || !fecha) errs.push("La fecha es obligatoria.");
    else if (fecha < now || fecha > addDays(now, WINDOW_DAYS)) errs.push("La fecha debe estar entre hoy y los próximos " + WINDOW_DAYS + " días.");
    if (!/^\d{2}:\d{2}$/.test(f.hora || "")) errs.push("La hora es obligatoria.");
    const hasLat = f.lat !== "" && f.lat != null, hasLng = f.lng !== "" && f.lng != null;
    if (hasLat !== hasLng) errs.push("Para ubicar el evento en el mapa indique latitud y longitud, o deje ambas vacías.");
    else if (hasLat && (!(Math.abs(+f.lat) <= 90) || !(Math.abs(+f.lng) <= 180))) errs.push("Latitud o longitud fuera de rango.");
    if (errs.length) return errs;
    // Duplicados: mismo nombre, fecha y zona; o mismo tipo, fecha, hora y zona.
    const dup = (existing || []).find(e => ymd(e.inicio) === f.fecha && norm(e.zona) === norm(f.zona) &&
      (norm(e.nombre) === norm(nombre) || (e.tipo === f.tipo && (pad(e.inicio.getHours()) + ":" + pad(e.inicio.getMinutes())) === f.hora)));
    if (dup) errs.push("Ya existe un evento parecido: «" + dup.nombre + "» (" + lab(TIPOS, dup.tipo) + ") el " + fmtD(dup.inicio) + " en " + dup.zona + ".");
    return errs;
  }

  /* ============ Datos de demostración (se ignoran al configurar LOAD) ============ */
  function makeDemo() {
    const t = startOfToday(), at = (n, hh, mm) => { const d = addDays(t, n); d.setHours(hh || 0, mm || 0, 0, 0); return d; };
    return {
      events: [
        { id: "E-01", nombre: "Marcha sindical hacia la plaza central", tipo: "marcha", inicio: at(1, 9), fin: at(1, 13), zona: "Centro Histórico", lat: 13.6989, lng: -89.1914, radius_m: 600, impacto: "alto", estado: "pendiente", fuente: "PNC y Tránsito (demo)" },
        { id: "E-07", nombre: "Marcha estudiantil", tipo: "marcha", inicio: at(2, 8), fin: at(2, 11), zona: "Soyapango", lat: 13.7108, lng: -89.1396, radius_m: 500, impacto: "medio", estado: "pendiente", fuente: "Prensa (demo)" },
        { id: "E-03", nombre: "Cierre vial por obras", tipo: "cierre_vial", inicio: at(3, 6), fin: at(3, 18), zona: "Santa Tecla", lat: 13.6769, lng: -89.2797, radius_m: 400, impacto: "medio", estado: "pendiente", fuente: "Ministerio de Obras Públicas (demo)" },
        { id: "E-04", nombre: "Concentración comunitaria", tipo: "marcha", inicio: at(8, 15), zona: "Soyapango", lat: 13.7000, lng: -89.1500, radius_m: 300, impacto: "bajo", estado: "pendiente", fuente: "Registro manual (demo)" },
        { id: "E-05", nombre: "Cierre vial por desfile", tipo: "cierre_vial", inicio: at(12, 7), fin: at(12, 14), zona: "Centro Histórico", lat: 13.6985, lng: -89.1920, radius_m: 700, impacto: "alto", estado: "revisado", fuente: "Alcaldía (demo)", nota: "Se avisó a logística; la ruta R-101 sale antes de las 7:00.", revisado_por: "María Hernández", revisado_en: addDays(t, -1) },
        { id: "E-02", nombre: "Feriado oficial de ejemplo", tipo: "feriado", inicio: at(22), zona: "Nacional", impacto: "medio", estado: "pendiente", fuente: "Calendario oficial del sistema (demo)" },
        { id: "E-06", nombre: "Evento deportivo con cierre parcial", tipo: "otro", inicio: at(27, 16), fin: at(27, 21), zona: "Santa Tecla", lat: 13.6740, lng: -89.2830, radius_m: 350, impacto: "bajo", estado: "pendiente", fuente: "Prensa (demo)" },
        { id: "E-08", nombre: "Marcha fuera de la ventana de 30 días", tipo: "marcha", inicio: at(45, 9), zona: "Centro Histórico", impacto: "alto", estado: "pendiente", fuente: "Prensa (demo)" }
      ],
      routes: [
        { id: "R-100", nombre: "Centro – Mercado Central (valores)", zona: "Centro Histórico", fecha: at(1), entregas: 14, conductor: "Carlos Mejía" },
        { id: "R-103", nombre: "Soyapango – Ilopango (efectivo)", zona: "Soyapango", fecha: at(2), entregas: 6, conductor: "Marvin Alas" },
        { id: "R-102", nombre: "Santa Tecla – La Libertad (mercancía)", zona: "Santa Tecla", fecha: at(3), entregas: 11, conductor: "Luis Hernández" },
        { id: "R-104", nombre: "San Marcos – Panchimalco", zona: "San Marcos", fecha: at(1), entregas: 8, conductor: "Kevin Rivas" },
        { id: "R-101", nombre: "Centro – Colonia Escalón (valores)", zona: "Centro Histórico", fecha: at(12), entregas: 9, conductor: "José Ramírez" },
        { id: "R-106", nombre: "Santa Tecla – Antiguo Cuscatlán", zona: "Santa Tecla", fecha: at(22), entregas: 5, conductor: "Ana Portillo" }
      ],
      audit: [
        { evento: "E-05", accion: "registro", usuario: "Sistema", fecha: addDays(t, -3) },
        { evento: "E-05", accion: "revision", usuario: "María Hernández", fecha: addDays(t, -1), nota: "Se avisó a logística; la ruta R-101 sale antes de las 7:00." }
      ]
    };
  }

  /* ============ Pruebas de la lógica ============ */
  function runTests() {
    const res = [], t = startOfToday(), at = (n, hh) => { const d = addDays(t, n); d.setHours(hh || 0, 0, 0, 0); return d; };
    const ck = (n, c) => res.push([n, !!c]);
    const throws = fn => { try { fn(); return null; } catch (e) { return e; } };
    const demoRaw = () => { const D = makeDemo(); const ev = D.events.filter(e => inWindow(e, t)); return { events: ev.map(e => Object.assign({}, e, { rutas_afectadas: expectedRoutes(e, D.routes).map(r => r.id) })), routes: D.routes, audit: D.audit, totals: { events: ev.length } }; };

    ck("Evento de hoy está dentro de la ventana", inWindow({ inicio: at(0) }, t));
    ck("Evento a 30 días está dentro de la ventana", inWindow({ inicio: at(30) }, t));
    ck("Evento a 31 días queda fuera", !inWindow({ inicio: at(31) }, t));
    ck("Evento de ayer queda fuera", !inWindow({ inicio: at(-1) }, t));
    ck("Evento que empezó ayer y termina mañana entra", inWindow({ inicio: at(-1), fin: at(1) }, t));

    const n = normalize(demoRaw(), t);
    ck("Listado ordenado del más próximo al más lejano", n.events.every((e, i) => !i || n.events[i - 1].inicio <= e.inicio));
    ck("No incluye eventos fuera de 30 días", !n.events.some(e => e.id === "E-08"));
    ck("Contador de pendientes correcto", pendingCount(n.events) === n.events.filter(e => e.estado === "pendiente").length && pendingCount(n.events) === 6);
    const e1 = n.events.find(e => e.id === "E-01");
    ck("Marcha en Centro Histórico marca la ruta R-100", e1.rutas.length === 1 && e1.rutas[0].id === "R-100");
    ck("Muestra entregas y conductores involucrados", e1.entregas === 14 && e1.conductores.length === 1 && e1.conductores[0] === "Carlos Mejía");
    ck("Feriado nacional afecta las rutas de ese día", n.events.find(e => e.id === "E-02").rutas.some(r => r.id === "R-106"));
    ck("Evento sin rutas planificadas es válido (0 rutas)", n.events.find(e => e.id === "E-04").rutas.length === 0);

    const bad = demoRaw(); bad.events.find(e => e.id === "E-01").rutas_afectadas = [];
    const e2 = throws(() => normalize(bad, t));
    ck("Evento con 0 rutas pero ruta planificada = inconsistencia", e2 && e2.message === MSG_INCONSISTENT && e2.detail.includes("R-100"));
    const bad2 = demoRaw(); bad2.events.find(e => e.id === "E-04").rutas_afectadas = ["R-100"];
    ck("Ruta afectada que no está planificada ahí = inconsistencia", throws(() => normalize(bad2, t)));
    const bad3 = demoRaw(); bad3.totals.events += 1;
    const e3 = throws(() => normalize(bad3, t));
    ck("Listado distinto a lo registrado = inconsistencia", e3 && e3.message === MSG_INCONSISTENT);
    ck("Respuesta sin formato = error", throws(() => normalize({}, t)));

    const all = n.events;
    ck("Filtro por tipo", applyFilters(all, { tipo: "marcha" }).every(e => e.tipo === "marcha"));
    ck("Filtro por zona ignora tildes y mayúsculas", applyFilters(all, { zona: "centro historico" }).length === all.filter(e => e.zona === "Centro Histórico").length);
    ck("Filtro por impacto", applyFilters(all, { impacto: "alto" }).every(e => e.impacto === "alto"));
    ck("Filtro por estado", applyFilters(all, { estado: "revisado" }).length === 1);
    ck("Filtro por fecha", applyFilters(all, { desde: ymd(at(2)), hasta: ymd(at(3)) }).length === 2);
    ck("Aviso de impacto alto fuera de filtros", hiddenHigh(all, { tipo: "feriado" }).length === 2 && hiddenHigh(all, {}).length === 0);
    const pg = paginate(all, 2, 5);
    ck("Paginación: página 2 con el resto", pg.page === 2 && pg.items.length === all.length - 5 && pg.pages === 2);
    ck("Paginación: página fuera de rango se ajusta", paginate(all, 99, 5).page === 2);

    const ok = { nombre: "Cierre en el bulevar", tipo: "cierre_vial", fecha: ymd(at(5)), hora: "08:00", zona: "Santa Tecla", impacto: "alto", lat: "", lng: "" };
    ck("Registro válido sin errores", validateNew(ok, all, t).length === 0);
    ck("Campos obligatorios", validateNew({}, all, t).length >= 6);
    ck("Fecha pasada rechazada", validateNew(Object.assign({}, ok, { fecha: ymd(at(-2)) }), all, t).length === 1);
    ck("Solo latitud = error", validateNew(Object.assign({}, ok, { lat: "13.6" }), all, t).length === 1);
    ck("Duplicado por nombre, fecha y zona", validateNew({ nombre: " marcha ESTUDIANTIL ", tipo: "otro", fecha: ymd(at(2)), hora: "20:00", zona: "soyapango", impacto: "bajo" }, all, t)[0].includes("Ya existe"));
    ck("Duplicado por tipo, fecha, hora y zona", validateNew({ nombre: "Otro nombre", tipo: "marcha", fecha: ymd(at(2)), hora: "08:00", zona: "Soyapango", impacto: "bajo" }, all, t)[0].includes("Ya existe"));
    ck("Misma zona y fecha pero distinto evento no es duplicado", validateNew({ nombre: "Otro nombre", tipo: "cierre_vial", fecha: ymd(at(2)), hora: "20:00", zona: "Soyapango", impacto: "bajo" }, all, t).length === 0);
    ck("Fecha YYYY-MM-DD se lee en hora local", toDate("2026-10-10").getDate() === 10);

    res.forEach(r => console.log((r[1] ? "OK    " : "FALLO ") + r[0]));
    return { ok: res.filter(r => r[1]).length, total: res.length };
  }

  /* ============ Componente ============ */
  function mount(container, opts) {
    const cfg = Object.assign({}, EV, opts || {});
    const demo = !cfg.LOAD;
    const DB = demo ? makeDemo() : null;
    const emptyForm = () => ({ nombre: "", tipo: "", fecha: "", hora: "", zona: "", impacto: "", fuente: "", lat: "", lng: "" });
    const S = {
      data: null, loading: true, error: null, errorDetail: null,
      view: "lista", filters: { desde: "", hasta: "", tipo: "", zona: "", impacto: "", estado: "" }, page: 1,
      sel: null, note: "", showForm: false, form: emptyForm(), formErrors: [], saving: false,
      cal: null, demoFail: false, demoZero: false, demoRole: null
    };
    let alive = true, maps = [];

    /* ---- sesión (igual que el módulo de disponibilidad) ---- */
    function getSession() {
      if (cfg.session) return typeof cfg.session === "function" ? cfg.session() : cfg.session;
      try { const s = sessionStorage.getItem(cfg.SESSION_KEY); if (s) return JSON.parse(s); } catch (e) { /* sin sesión */ }
      return null;
    }
    function currentUser() { const s = getSession(); return s ? (s.name || s.code || s.user || "Usuario") : (demo ? "María Hernández" : ""); }
    function currentRole() {
      if (demo && S.demoRole) return S.demoRole;
      const s = getSession();
      if (s && s.role) return s.role;
      return demo ? cfg.ROLE_ALLOWED : null;
    }
    const roleOk = () => currentRole() === cfg.ROLE_ALLOWED;
    const hasSession = () => demo || !!getSession();

    /* ---- servicio ---- */
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

    // Lo que "devolvería el servidor" en demostración: solo los eventos de los próximos 30 días,
    // con sus rutas afectadas calculadas, y los interruptores del panel de pruebas aplicados.
    function demoResponse() {
      const now = startOfToday();
      const ev = DB.events.filter(e => inWindow(e, now)).map(e => {
        const ids = expectedRoutes(e, DB.routes).map(r => r.id);
        return Object.assign({}, e, { rutas_afectadas: (S.demoZero && e.id === "E-01") ? [] : ids });
      });
      return { events: ev, routes: DB.routes, audit: DB.audit.slice(), totals: { events: ev.length } };
    }
    async function fetchData() {
      if (!demo) return normalize(await post(cfg.LOAD, {}));
      await wait(500);
      if (S.demoFail) throw new Error("No se pudieron cargar los eventos. Revise la conexión e intente de nuevo.");
      return normalize(demoResponse());
    }

    // Marcar como revisado (con nota). Queda en auditoría quién y cuándo.
    async function reviewSvc(id, nota) {
      if (!roleOk()) throw new Error("No tiene permiso para revisar eventos.");
      if (!demo) {
        const rec = await post(cfg.REVIEW, { id: id, nota: nota });
        return Object.assign({ revisado_por: currentUser(), revisado_en: new Date() }, rec || {}, { revisado_en: toDate(rec && rec.revisado_en) || new Date() });
      }
      await wait(300);
      const e = DB.events.find(x => x.id === id);
      if (!e) throw new Error("El evento ya no existe.");
      if (e.estado === "revisado") throw new Error("El evento ya fue revisado por " + e.revisado_por + ".");
      const now = new Date();
      Object.assign(e, { estado: "revisado", nota: nota, revisado_por: currentUser(), revisado_en: now });
      DB.audit.push({ evento: id, accion: "revision", usuario: currentUser(), fecha: now, nota: nota });
      return { id: id, revisado_por: currentUser(), revisado_en: now };
    }

    // Registrar evento manualmente. El servidor debe repetir la validación de campos y duplicados.
    async function createSvc(f) {
      if (!roleOk()) throw new Error("No tiene permiso para registrar eventos.");
      const errs = validateNew(f, S.data ? S.data.events : [], startOfToday());
      if (errs.length) throw new Error(errs[0]);
      const payload = {
        nombre: f.nombre.trim(), tipo: f.tipo, inicio: f.fecha + "T" + f.hora, zona: f.zona.trim(), impacto: f.impacto,
        fuente: (f.fuente || "").trim() || "Registro manual", radius_m: 400
      };
      if (f.lat !== "" && f.lng !== "") { payload.lat = +f.lat; payload.lng = +f.lng; }
      if (!demo) return post(cfg.CREATE, payload);
      await wait(300);
      const dup = validateNew(f, DB.events.map(e => Object.assign({}, e, { inicio: toDate(e.inicio) })), startOfToday());
      if (dup.length) throw new Error(dup[0]);
      const rec = Object.assign({}, payload, { id: "E-" + pad(DB.events.length + 1), inicio: toDate(payload.inicio), estado: "pendiente" });
      DB.events.push(rec);
      DB.audit.push({ evento: rec.id, accion: "registro", usuario: currentUser(), fecha: new Date() });
      return rec;
    }

    /* ---- estructura fija ---- */
    const headUser = h("b"), headRole = h("span");
    const head = h("div", { class: "ev-head" },
      h("div", {},
        h("h2", { class: "ev-title" }, "Eventos especiales"),
        h("p", { class: "ev-sub" }, "SERSAPROSA · Marchas, feriados y cierres viales de los próximos " + WINDOW_DAYS + " días")),
      h("div", { class: "ev-who" }, "Sesión: ", headUser, h("br"), headRole));
    const msgBox = h("div", { class: "ev-msgbox", role: "status", "aria-live": "polite" });
    const body = h("div", { class: "ev-body" });
    const root = h("div", { class: "ev-root" }, head, msgBox, body);
    container.classList.add("ev");
    container.replaceChildren(root);

    function setMsg(type, text) {
      msgBox.replaceChildren();
      if (text) msgBox.append(h("div", { class: "ev-msg ev-msg-" + type }, text));
    }

    /* ---- acciones ---- */
    async function load() {
      S.loading = true; S.error = null; S.errorDetail = null; render();
      if (hasSession() && roleOk()) {
        try { S.data = await fetchData(); } catch (e) { S.error = e.message; S.errorDetail = e.detail || null; S.data = null; }
      } else { S.data = null; }
      if (!alive) return;
      S.loading = false;
      if (S.data && S.sel && !S.data.events.some(e => e.id === S.sel)) S.sel = null;
      render();
    }
    function setFilter(k, v) { S.filters[k] = v; S.page = 1; render(); }
    function clearFilters() { S.filters = { desde: "", hasta: "", tipo: "", zona: "", impacto: "", estado: "" }; S.page = 1; render(); }
    function openEvent(id) { S.sel = id; S.note = ""; render(); }

    async function doReview(e) {
      const nota = (S.note || "").trim();
      if (nota.length < 3) { setMsg("err", "Escriba una nota de al menos 3 caracteres para marcar el evento como revisado."); return; }
      if (nota.length > 500) { setMsg("err", "La nota no puede pasar de 500 caracteres."); return; }
      S.saving = true; render();
      try {
        const rec = await reviewSvc(e.id, nota);
        S.note = "";
        setMsg("ok", "Evento «" + e.nombre + "» marcado como revisado por " + rec.revisado_por + " el " + fmtD(rec.revisado_en) + " a las " + fmtT(rec.revisado_en) + ".");
      } catch (err) { setMsg("err", err.message); }
      S.saving = false;
      await load();
    }

    async function doCreate() {
      S.formErrors = validateNew(S.form, S.data ? S.data.events : [], startOfToday());
      if (S.formErrors.length) { setMsg("", ""); render(); return; }
      S.saving = true; render();
      try {
        const rec = await createSvc(S.form);
        S.form = emptyForm(); S.formErrors = []; S.showForm = false;
        S.sel = rec.id; S.view = "lista"; S.saving = false;
        setMsg("ok", "Evento «" + rec.nombre + "» registrado por " + currentUser() + " el " + fmtD(new Date()) + " a las " + fmtT(new Date()) + ".");
      } catch (err) {
        S.saving = false; S.formErrors = [err.message]; setMsg("", "");
      }
      await load();
    }

    /* ---- mapa (Leaflet, si está cargado) ---- */
    function drawMap(el, events) {
      if (!global.L) { el.append(h("p", { class: "ev-meta" }, "El mapa no está disponible (no se cargó Leaflet).")); return; }
      const map = global.L.map(el).setView(CENTER, 12);
      maps.push(map);
      global.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
      const shapes = [];
      events.filter(hasCoords).forEach(e => {
        const c = global.L.circle([e.lat, e.lng], { radius: e.radius_m || 400, color: COLOR[e.impacto] || COLOR.bajo, fillColor: COLOR[e.impacto] || COLOR.bajo, fillOpacity: .25, weight: 2 }).addTo(map);
        c.bindPopup(h("div", {}, h("b", {}, e.nombre), h("br"), h("span", {}, lab(TIPOS, e.tipo) + " · " + fmtD(e.inicio) + " " + fmtT(e.inicio) + " · impacto " + lab(IMPACTOS, e.impacto))));
        c.on("click", () => { S.sel = e.id; });
        shapes.push(c);
      });
      if (shapes.length) map.fitBounds(global.L.featureGroup(shapes).getBounds(), { padding: [30, 30], maxZoom: 15 });
      setTimeout(() => { try { map.invalidateSize(); } catch (x) { /* mapa ya quitado */ } }, 60);
    }

    /* ---- vista ---- */
    const pill = (kind, v) => h("span", { class: "ev-pill ev-" + (kind === "impacto" ? v : (v === "revisado" ? "ok" : "warn")) },
      kind === "impacto" ? lab(IMPACTOS, v) : lab(ESTADOS, v));
    const when = e => {
      const a = fmtD(e.inicio) + " " + fmtT(e.inicio);
      if (!e.fin) return a;
      return a + " – " + (ymd(e.fin) === ymd(e.inicio) ? fmtT(e.fin) : fmtD(e.fin) + " " + fmtT(e.fin));
    };
    const rutasTxt = e => e.rutas.length ? e.rutas.map(r => r.id).join(", ") : "Ninguna";

    function field(label, ctrl) { return h("div", { class: "ev-field" }, h("span", { class: "ev-lbl" }, label), ctrl); }
    function selectOf(list, value, onchange, first, label) {
      return h("select", { class: "ev-select", "aria-label": label, onchange: e => onchange(e.target.value) },
        h("option", { value: "" }, first), list.map(x => h("option", { value: x[0], selected: x[0] === value }, x[1])));
    }

    function filtersBar(D) {
      const zonas = Array.from(new Set(D.events.map(e => e.zona))).sort((a, b) => a.localeCompare(b, "es"));
      const f = S.filters;
      return h("div", { class: "ev-panel ev-filters" },
        field("Desde", h("input", { class: "ev-input", type: "date", value: f.desde, "aria-label": "Fecha desde", onchange: e => setFilter("desde", e.target.value) })),
        field("Hasta", h("input", { class: "ev-input", type: "date", value: f.hasta, "aria-label": "Fecha hasta", onchange: e => setFilter("hasta", e.target.value) })),
        field("Tipo", selectOf(TIPOS, f.tipo, v => setFilter("tipo", v), "Todos", "Tipo")),
        field("Zona", selectOf(zonas.map(z => [z, z]), f.zona, v => setFilter("zona", v), "Todas", "Zona")),
        field("Impacto", selectOf(IMPACTOS, f.impacto, v => setFilter("impacto", v), "Todos", "Nivel de impacto")),
        field("Estado", selectOf(ESTADOS, f.estado, v => setFilter("estado", v), "Todos", "Estado")),
        h("div", { class: "ev-field ev-end" }, h("button", { type: "button", class: "ev-btn", onclick: clearFilters }, "Limpiar filtros")));
    }

    function listView(filtered) {
      if (!filtered.length) return h("div", { class: "ev-state" }, "Ningún evento coincide con los filtros actuales.");
      const pg = paginate(filtered, S.page);
      S.page = pg.page;
      const rows = pg.items.map(e => h("tr", { class: e.id === S.sel ? "ev-sel" : "" },
        h("td", {}, h("b", {}, e.nombre), h("div", { class: "ev-meta" }, e.id)),
        h("td", {}, lab(TIPOS, e.tipo)),
        h("td", {}, when(e)),
        h("td", {}, e.zona),
        h("td", {}, pill("impacto", e.impacto)),
        h("td", {}, pill("estado", e.estado)),
        h("td", {}, String(e.rutas.length)),
        h("td", {}, h("button", { type: "button", class: "ev-btn", onclick: () => openEvent(e.id) }, "Ver detalle"))));
      return h("div", { class: "ev-panel" },
        h("div", { class: "ev-scroll" }, h("table", { class: "ev-table" },
          h("thead", {}, h("tr", {}, ["Evento", "Tipo", "Fecha y hora", "Zona afectada", "Impacto", "Estado", "Rutas afectadas", ""].map(t => h("th", {}, t)))),
          h("tbody", {}, rows))),
        h("div", { class: "ev-pager" },
          h("span", { class: "ev-meta" }, "Mostrando " + pg.from + "–" + pg.to + " de " + pg.total + " · Página " + pg.page + " de " + pg.pages),
          h("span", {},
            h("button", { type: "button", class: "ev-btn", disabled: pg.page <= 1, onclick: () => { S.page = pg.page - 1; render(); } }, "Anterior"), " ",
            h("button", { type: "button", class: "ev-btn", disabled: pg.page >= pg.pages, onclick: () => { S.page = pg.page + 1; render(); } }, "Siguiente"))));
    }

    function calendarView(filtered, D) {
      const now = startOfToday(), last = addDays(now, WINDOW_DAYS);
      const first0 = new Date(now.getFullYear(), now.getMonth(), 1), first1 = new Date(last.getFullYear(), last.getMonth(), 1);
      if (!S.cal || S.cal < first0 || S.cal > first1) S.cal = first0;
      const m = S.cal, daysIn = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
      const lead = (new Date(m.getFullYear(), m.getMonth(), 1).getDay() + 6) % 7; // lunes primero
      const cells = DIAS.map(d => h("div", { class: "ev-cal-h" }, d));
      for (let i = 0; i < lead; i++) cells.push(h("div", { class: "ev-cal-c ev-cal-x" }));
      for (let d = 1; d <= daysIn; d++) {
        const day = new Date(m.getFullYear(), m.getMonth(), d), inW = day >= now && day <= last;
        const evs = filtered.filter(e => { const r = evRange(e); return r[0] <= day && r[1] >= day; });
        cells.push(h("div", { class: "ev-cal-c" + (inW ? "" : " ev-cal-off") + (ymd(day) === ymd(now) ? " ev-cal-today" : "") },
          h("div", { class: "ev-cal-d" }, String(d)),
          evs.slice(0, 3).map(e => h("button", { type: "button", class: "ev-chip ev-chip-" + e.impacto, title: e.nombre + " · " + lab(IMPACTOS, e.impacto), onclick: () => openEvent(e.id) }, e.nombre)),
          evs.length > 3 ? h("button", { type: "button", class: "ev-chip ev-chip-more", onclick: () => { S.filters.desde = ymd(day); S.filters.hasta = ymd(day); S.view = "lista"; S.page = 1; render(); } }, "+" + (evs.length - 3) + " más") : null));
      }
      return h("div", { class: "ev-panel" },
        h("div", { class: "ev-cal-nav" },
          h("button", { type: "button", class: "ev-btn", disabled: m <= first0, onclick: () => { S.cal = new Date(m.getFullYear(), m.getMonth() - 1, 1); render(); } }, "‹ Mes anterior"),
          h("h3", { class: "ev-h" }, MESES[m.getMonth()] + " " + m.getFullYear()),
          h("button", { type: "button", class: "ev-btn", disabled: m >= first1, onclick: () => { S.cal = new Date(m.getFullYear(), m.getMonth() + 1, 1); render(); } }, "Mes siguiente ›")),
        h("div", { class: "ev-cal" }, cells),
        h("p", { class: "ev-meta" }, "Se muestran los eventos que cumplen los filtros. Los días en gris están fuera de los próximos " + WINDOW_DAYS + " días."));
    }

    function mapView(filtered) {
      const sin = filtered.filter(e => !hasCoords(e));
      const el = h("div", { class: "ev-map", role: "img", "aria-label": "Mapa de eventos especiales" });
      after.push(() => drawMap(el, filtered));
      return h("div", { class: "ev-panel" }, el,
        sin.length ? h("p", { class: "ev-meta" }, sin.length + " evento(s) no tienen coordenadas y no se pueden ubicar en el mapa: " + sin.map(e => e.nombre).join(", ") + ".") : null);
    }

    function detailView(e, D) {
      const hist = D.audit.filter(a => a.evento === e.id).sort((a, b) => b.fecha - a.fecha);
      const zoneMap = h("div", { class: "ev-map ev-map-sm", role: "img", "aria-label": "Zona del evento en el mapa" });
      if (hasCoords(e)) after.push(() => drawMap(zoneMap, [e]));
      const review = e.estado === "revisado"
        ? h("div", { class: "ev-box" }, h("b", {}, "Revisado"), " por " + (e.revisado_por || "—") + (e.revisado_en ? " el " + fmtD(e.revisado_en) + " a las " + fmtT(e.revisado_en) : ""),
          e.nota ? h("div", { class: "ev-meta" }, "Nota: " + e.nota) : null)
        : h("div", { class: "ev-box" },
          h("label", { class: "ev-lbl", for: "ev-nota-" + e.id }, "Nota de revisión (obligatoria)"),
          h("textarea", { class: "ev-input ev-area", id: "ev-nota-" + e.id, rows: "3", maxlength: "500", placeholder: "Qué se revisó y qué se decidió con las rutas afectadas", oninput: ev => { S.note = ev.target.value; } }, S.note),
          h("div", {}, h("button", { type: "button", class: "ev-btn ev-primary", disabled: S.saving, onclick: () => doReview(e) }, S.saving ? "Guardando…" : "Marcar como revisado")));
      return h("div", { class: "ev-panel ev-gap" },
        h("div", { class: "ev-detail-head" },
          h("h3", { class: "ev-h" }, "Detalle del evento"),
          h("button", { type: "button", class: "ev-btn", onclick: () => { S.sel = null; S.note = ""; render(); } }, "Cerrar")),
        h("div", { class: "ev-detail" },
          h("div", {},
            h("p", { class: "ev-name" }, e.nombre, pill("impacto", e.impacto), pill("estado", e.estado)),
            h("dl", { class: "ev-dl" },
              h("dt", {}, "Tipo"), h("dd", {}, lab(TIPOS, e.tipo)),
              h("dt", {}, "Fecha y hora"), h("dd", {}, when(e)),
              h("dt", {}, "Zona afectada"), h("dd", {}, e.zona),
              h("dt", {}, "Fuente de la información"), h("dd", {}, e.fuente || "Sin fuente registrada"),
              h("dt", {}, "Entregas involucradas"), h("dd", {}, String(e.entregas)),
              h("dt", {}, "Conductores involucrados"), h("dd", {}, e.conductores.length ? e.conductores.length + " · " + e.conductores.join(", ") : "0")),
            h("h4", { class: "ev-h2" }, "Rutas planificadas afectadas (" + e.rutas.length + ")"),
            e.rutas.length
              ? h("ul", { class: "ev-routes" }, e.rutas.map(r => h("li", {}, h("b", {}, r.id), " · " + (r.nombre || "") + (r.fecha ? " · " + fmtD(r.fecha) : "") + (r.conductor ? " · " + r.conductor : "") + (r.entregas != null ? " · " + r.entregas + " entregas" : ""))))
              : h("p", { class: "ev-meta" }, "No hay rutas planificadas en esta zona y fecha (validado contra la planificación)."),
            review),
          h("div", {}, hasCoords(e) ? zoneMap : h("div", { class: "ev-box ev-meta" }, "Este evento no tiene coordenadas; no se puede mostrar la zona en el mapa."))),
        h("h4", { class: "ev-h2" }, "Auditoría"),
        hist.length
          ? h("div", { class: "ev-scroll" }, h("table", { class: "ev-table ev-table-sm" },
            h("thead", {}, h("tr", {}, ["Fecha", "Hora", "Acción", "Usuario", "Nota"].map(t => h("th", {}, t)))),
            h("tbody", {}, hist.map(a => h("tr", {}, h("td", {}, fmtD(a.fecha)), h("td", {}, fmtT(a.fecha)), h("td", {}, a.accion === "revision" ? "Revisión" : "Registro"), h("td", {}, a.usuario), h("td", {}, a.nota || "—"))))))
          : h("p", { class: "ev-meta" }, "Sin movimientos de auditoría."));
    }

    function formView(D) {
      const f = S.form;
      const bind = k => ev => { f[k] = ev.target.value; };
      const inp = (k, type, extra) => h("input", Object.assign({ class: "ev-input", type: type, value: f[k], oninput: bind(k) }, extra || {}));
      return h("div", { class: "ev-panel ev-gap" },
        h("h3", { class: "ev-h" }, "Registrar evento manualmente"),
        S.formErrors.length ? h("div", { class: "ev-msg ev-msg-err", role: "alert" }, S.formErrors.length > 1 ? h("ul", { class: "ev-errs" }, S.formErrors.map(x => h("li", {}, x))) : S.formErrors[0]) : null,
        h("div", { class: "ev-form" },
          field("Nombre *", inp("nombre", "text", { maxlength: "120", "aria-required": "true" })),
          field("Tipo *", selectOf(TIPOS, f.tipo, v => { f.tipo = v; }, "Elija…", "Tipo")),
          field("Fecha *", inp("fecha", "date", { min: ymd(startOfToday()), max: ymd(addDays(startOfToday(), WINDOW_DAYS)) })),
          field("Hora *", inp("hora", "time")),
          field("Zona afectada *", inp("zona", "text", { list: "ev-zonas", placeholder: "Ej.: Centro Histórico" })),
          field("Impacto *", selectOf(IMPACTOS, f.impacto, v => { f.impacto = v; }, "Elija…", "Impacto")),
          field("Fuente", inp("fuente", "text", { placeholder: "Registro manual" })),
          field("Latitud (opcional)", inp("lat", "number", { step: "any" })),
          field("Longitud (opcional)", inp("lng", "number", { step: "any" }))),
        h("datalist", { id: "ev-zonas" }, Array.from(new Set(D.events.map(e => e.zona))).map(z => h("option", { value: z }))),
        h("p", { class: "ev-meta" }, "* Obligatorio. No se permiten duplicados (mismo nombre, fecha y zona). Si no hay coordenadas, el evento se registra sin ubicación en el mapa."),
        h("div", {},
          h("button", { type: "button", class: "ev-btn ev-primary", disabled: S.saving, onclick: doCreate }, S.saving ? "Guardando…" : "Registrar evento"), " ",
          h("button", { type: "button", class: "ev-btn", onclick: () => { S.showForm = false; S.formErrors = []; render(); } }, "Cancelar")));
    }

    // Tareas que deben ejecutarse después de poner el cuerpo en la página (mapas).
    let after = [];
    function render() {
      maps.forEach(m => { try { m.remove(); } catch (e) { /* ya quitado */ } }); maps = []; after = [];
      headUser.textContent = currentUser() || "sin sesión";
      headRole.textContent = roleOk() ? "Coordinador de rutas" : (currentRole() || "");
      body.replaceChildren();
      if (!hasSession()) {
        body.append(h("div", { class: "ev-state ev-state-err" }, h("h3", { class: "ev-h" }, "Sesión requerida"), h("p", {}, "Inicie sesión para ver los eventos especiales.")));
        return;
      }
      if (!roleOk()) {
        body.append(h("div", { class: "ev-state ev-state-err" }, h("h3", { class: "ev-h" }, "Acceso restringido"), h("p", {}, "Esta sección es solo para el coordinador de rutas.")));
        return;
      }
      if (S.loading) { body.append(h("div", { class: "ev-state" }, "Cargando eventos especiales…")); return; }
      // Flujo fallido: no se muestra un listado vacío ni "sin rutas afectadas" como si fuera correcto.
      if (S.error) {
        body.append(h("div", { class: "ev-state ev-state-err", role: "alert" },
          h("h3", { class: "ev-h" }, S.error),
          S.errorDetail ? h("p", { class: "ev-meta" }, S.errorDetail) : null,
          h("button", { type: "button", class: "ev-btn ev-primary", onclick: load }, "Reintentar")));
        return;
      }
      const D = S.data;
      const filtered = applyFilters(D.events, S.filters);
      const pend = pendingCount(D.events), pendHigh = D.events.filter(e => e.estado !== "revisado" && e.impacto === "alto").length;
      const hidden = hiddenHigh(D.events, S.filters);
      const cnt = (n, label, extra) => h("div", { class: "ev-cnt" }, h("div", { class: "ev-n" }, String(n), extra ? h("small", {}, " " + extra) : null), h("div", { class: "ev-l" }, label));
      body.append(h("div", { class: "ev-counters" },
        cnt(pend, "Eventos pendientes de revisión", "de " + D.events.length),
        cnt(pendHigh, "Pendientes de impacto alto"),
        cnt(filtered.length, "Eventos que cumplen los filtros")));
      if (hidden.length) {
        body.append(h("div", { class: "ev-msg ev-msg-warn", role: "alert" },
          "Hay " + hidden.length + " evento(s) de impacto alto fuera de los filtros actuales: " + hidden.map(e => e.nombre + " (" + fmtD(e.inicio) + ")").join("; ") + ". ",
          h("button", { type: "button", class: "ev-btn", onclick: clearFilters }, "Ver todos")));
      }
      body.append(
        h("div", { class: "ev-toolbar" },
          h("div", { class: "ev-tabs" }, [["lista", "Lista"], ["calendario", "Calendario"], ["mapa", "Mapa"]].map(v =>
            h("button", { type: "button", class: "ev-btn" + (S.view === v[0] ? " ev-primary" : ""), "aria-pressed": S.view === v[0] ? "true" : "false", onclick: () => { S.view = v[0]; render(); } }, v[1]))),
          h("button", { type: "button", class: "ev-btn", onclick: () => { S.showForm = !S.showForm; S.formErrors = []; render(); } }, S.showForm ? "Ocultar registro" : "Registrar evento")),
        filtersBar(D),
        S.view === "lista" ? (D.events.length ? listView(filtered) : h("div", { class: "ev-state" }, "No hay eventos especiales en los próximos " + WINDOW_DAYS + " días."))
          : S.view === "calendario" ? calendarView(filtered, D) : mapView(filtered));
      if (S.sel) { const e = D.events.find(x => x.id === S.sel); if (e) body.append(detailView(e, D)); }
      if (S.showForm) body.append(formView(D));
      after.forEach(fn => fn());
    }

    /* ---- panel de pruebas (solo en modo demostración) ---- */
    if (demo) {
      const fail = h("input", { type: "checkbox", onchange: e => { S.demoFail = e.target.checked; } });
      const zero = h("input", { type: "checkbox", onchange: e => { S.demoZero = e.target.checked; } });
      const roleSel = h("select", { class: "ev-select ev-auto", "aria-label": "Rol de sesión", onchange: e => { S.demoRole = e.target.value; setMsg("", ""); load(); } },
        h("option", { value: "coordinador_rutas" }, "Coordinador de rutas"),
        h("option", { value: "operador" }, "Operador (sin permiso)"));
      const testBtn = h("button", { type: "button", class: "ev-btn", onclick: () => {
        const r = runTests();
        setMsg(r.ok === r.total ? "ok" : "err", "Pruebas de lógica: " + r.ok + " de " + r.total + " correctas. Detalle en la consola.");
      } }, "Ejecutar pruebas de lógica");
      root.append(h("div", { class: "ev-demo" },
        h("strong", {}, "Modo demostración (sin endpoints configurados)"),
        h("label", {}, fail, " Simular falla de carga"),
        h("label", {}, zero, " Simular evento con “0 rutas afectadas” (inconsistencia)"),
        h("span", {}, "Los cambios se aplican al pulsar Reintentar o cambiar el rol."),
        h("label", {}, "Rol de sesión: ", roleSel),
        testBtn));
    }

    load();

    return {
      reload: load,
      unmount() { alive = false; maps.forEach(m => { try { m.remove(); } catch (e) { /* ya quitado */ } }); container.replaceChildren(); container.classList.remove("ev"); }
    };
  }

  // Única variable global que se expone.
  global.EventosEspeciales = { mount: mount, normalize: normalize, applyFilters: applyFilters, validateNew: validateNew, expectedRoutes: expectedRoutes, runTests: runTests };

  /* Auto-montaje solo en la página independiente: <div data-eventos></div> */
  function auto() {
    const el = document.querySelector("[data-eventos]");
    if (el && !el.dataset.mounted) { el.dataset.mounted = "1"; mount(el); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", auto);
  else auto();
})(window);
