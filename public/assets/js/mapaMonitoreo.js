/* Mapa de unidades en vivo — Monitoreo en Vivo › Notificaciones.
 *
 * Se monta solo en <div id="panelMapaMonitoreo"> la primera vez que ese panel se ve (no hace falta
 * llamarlo desde dashboard.js). Usa lo que el sistema ya tiene:
 *   POST /rutas/listar          rutas de hoy: conductor, origen, destino, horario, monto y riesgo
 *   POST /disponibilidad/listar vehículo (placa y tipo) asignado a cada ruta
 *   POST /incidentes/listar     incidentes pendientes: la unidad cambia de color según la severidad
 *   OSRM (navegador)            trazado por calles, igual que el mapa de Tracking de rutas (ADR 0004)
 *
 * Posición: el sistema aún no recibe GPS de los vehículos, así que la unidad se mueve por la ruta
 * según la hora de salida y la duración estimada del trayecto. Si más adelante llega GPS real:
 *   MapaMonitoreo.setPosicion(rutaId, lat, lng)   // fija la posición real de esa unidad
 *
 * Colores: azul = en ruta, gris = por salir, verde = llegó,
 *          rojo / naranja / amarillo = incidente alto / medio / bajo (igual que Notificaciones).
 * Sin innerHTML para texto de usuario (ADR 0001).
 */
(function (global) {
  "use strict";

  const OSRM_URL = "https://router.project-osrm.org/route/v1/driving/";
  const DATOS_MS = 30000;        // rutas, vehículos y conductores
  const INCIDENTES_MS = 5000;    // incidentes (el panel de Incidentes en curso consulta cada 4 s)
  const TICK_MS = 1000;          // movimiento de las unidades
  const FALLOS_PARA_AVISAR = 2;
  const CENTRO = [13.6929, -89.2182]; // San Salvador
  const VELOCIDAD_RESPALDO_KMH = 35;  // solo si OSRM no responde
  const MULTIPLICADORES = [1, 10, 60];

  const SEV = {
    alta: { color: "#e5484d", titulo: "Crítico", rango: 3 },
    media: { color: "#f5a524", titulo: "Advertencia", rango: 2 },
    baja: { color: "#f2c94c", titulo: "Aviso", rango: 1 }
  };
  const ESTADO = {
    por_salir: { color: "#9a9fa8", texto: "Por salir" },
    en_ruta: { color: "#5b8cff", texto: "En ruta" },
    llego: { color: "#3fb27f", texto: "Llegó" }
  };
  const TIPOS = { robo: "Robo", accidente: "Accidente", desvio_ruta: "Desvío de ruta", falla_mecanica: "Falla mecánica", boton_panico: "Botón de pánico" };
  const FILTROS = [["todos", "Todas"], ["en_ruta", "En ruta"], ["incidente", "Incidente"], ["otras", "Otras"]];

  /* ---------- lógica pura (se puede probar sin navegador) ---------- */

  const RAD = Math.PI / 180;

  function distancia(a, b) {
    const dLat = (b[0] - a[0]) * RAD;
    const dLng = (b[1] - a[1]) * RAD;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function rumbo(a, b) {
    const y = Math.sin((b[1] - a[1]) * RAD) * Math.cos(b[0] * RAD);
    const x = Math.cos(a[0] * RAD) * Math.sin(b[0] * RAD) - Math.sin(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.cos((b[1] - a[1]) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }

  function acumulado(coords) {
    const acc = [0];
    for (let i = 1; i < coords.length; i += 1) acc.push(acc[i - 1] + distancia(coords[i - 1], coords[i]));
    return acc;
  }

  // Punto de la ruta a una fracción (0..1) de su largo, con el rumbo del tramo y el índice del vértice anterior.
  function puntoEn(coords, acc, fraccion) {
    const total = acc[acc.length - 1];
    if (coords.length < 2 || !(total > 0)) return { lat: coords[0][0], lng: coords[0][1], rumbo: 0, idx: 0 };
    const objetivo = Math.min(Math.max(fraccion, 0), 1) * total;
    let lo = 0;
    let hi = acc.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (acc[mid] <= objetivo) lo = mid; else hi = mid;
    }
    const tramo = acc[hi] - acc[lo];
    const t = tramo > 0 ? (objetivo - acc[lo]) / tramo : 0;
    const a = coords[lo];
    const b = coords[hi];
    return { lat: a[0] + (b[0] - a[0]) * t, lng: a[1] + (b[1] - a[1]) * t, rumbo: rumbo(a, b), idx: lo };
  }

  // "08:30" → milisegundos de hoy a esa hora (hora local del navegador). Sin horario válido → null.
  function horaASalida(horario, ref) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(horario || ""));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    const d = new Date(ref);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d.getTime();
  }

  // Estado de viaje y avance (0..1) según la hora (simulada o real).
  function avance(salidaMs, duracionMs, ahoraMs) {
    if (ahoraMs < salidaMs) return { estado: "por_salir", p: 0 };
    if (!(duracionMs > 0) || ahoraMs >= salidaMs + duracionMs) return { estado: "llego", p: 1 };
    return { estado: "en_ruta", p: (ahoraMs - salidaMs) / duracionMs };
  }

  function peorIncidente(lista) {
    let peor = null;
    (lista || []).forEach(i => {
      if (SEV[i.severidad] && (!peor || SEV[i.severidad].rango > SEV[peor.severidad].rango)) peor = i;
    });
    return peor;
  }

  function grupo(unidad, estado) {
    if (unidad.incidentes.length) return "incidente";
    return estado === "en_ruta" ? "en_ruta" : "otras";
  }

  function montoTexto(valor) {
    const n = Number(valor);
    if (valor == null || valor === "" || !Number.isFinite(n)) return "—";
    return new Intl.NumberFormat("es-SV", { style: "currency", currency: "USD" }).format(n);
  }

  function horaTexto(ms) {
    return new Date(ms).toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit" });
  }

  // Une rutas de hoy + asignaciones + incidentes. Solo entran las rutas con viaje (coordenadas) y conductor.
  function armarUnidades(rutas, disp, incidentes) {
    const asignaciones = new Map(((disp && disp.assignments) || []).map(a => [String(a.ruta), a]));
    const vehiculos = new Map(((disp && disp.vehicles) || []).map(v => [String(v.id), v]));
    const porRuta = new Map();
    (incidentes || []).forEach(i => {
      const clave = String(i.ruta_id || i.viaje || "");
      if (!porRuta.has(clave)) porRuta.set(clave, []);
      porRuta.get(clave).push(i);
    });
    const conViaje = (rutas || []).filter(r => r && r.viaje && r.viaje.origen && r.viaje.destino);
    const unidades = conViaje.filter(r => r.conductor).map(r => {
      const asignacion = asignaciones.get(String(r.id));
      const vehiculo = asignacion ? vehiculos.get(String(asignacion.vehiculo)) : null;
      return {
        id: String(r.id),
        nombre: r.nombre || "Ruta sin nombre",
        conductor: r.conductor,
        vehiculo: vehiculo ? { placa: vehiculo.placa, tipo: vehiculo.tipo } : null,
        monto: r.viaje.monto,
        riesgo: r.viaje.nivel_riesgo || null,
        horario: r.viaje.horario || "",
        salidaMs: r.viaje.salida_ms || null,
        origen: r.viaje.origen,
        destino: r.viaje.destino,
        incidentes: porRuta.get(String(r.id)) || []
      };
    });
    return { unidades, sinAsignar: conViaje.length - unidades.length };
  }

  /* ---------- DOM ---------- */

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

  /* ---------- demostración (datos de ejemplo en memoria: nada se guarda) ---------- */

  function demoDatos() {
    const ahora = Date.now();
    const lugar = (texto, lat, lng) => ({ texto, lat, lng });
    const centro = lugar("Centro de San Salvador", 13.6989, -89.1914);
    const viaje = (origen, destino, minutosAtras, monto, riesgo) => ({
      origen, destino, horario: "", salida_ms: ahora - minutosAtras * 60000, monto, nivel_riesgo: riesgo
    });
    const rutas = [
      { id: "demo-1", nombre: "Ruta Oriente (demo)", conductor: "Carlos Mendoza", viaje: viaje(centro, lugar("Soyapango", 13.7100, -89.1394), 6, 25000, "Alto") },
      { id: "demo-2", nombre: "Ruta Poniente (demo)", conductor: "Sofía Valenzuela", viaje: viaje(lugar("Metrocentro", 13.7050, -89.2170), lugar("Santa Tecla", 13.6769, -89.2797), 9, 4800, "Medio") },
      { id: "demo-3", nombre: "Ruta Sur (demo)", conductor: "Arturo Beltrán", viaje: viaje(lugar("Colonia Escalón", 13.7000, -89.2400), lugar("San Marcos", 13.6555, -89.1800), 3, 1200, "Bajo") },
      { id: "demo-4", nombre: "Ruta Norte (demo)", conductor: "Mariana Rojas", viaje: viaje(centro, lugar("Ilopango", 13.7000, -89.1100), -25, 900, "Bajo") }
    ];
    const disp = {
      vehicles: [
        { id: "v1", placa: "P-482-913", tipo: "Camión blindado" }, { id: "v2", placa: "P-317-206", tipo: "Camioneta" },
        { id: "v3", placa: "P-905-441", tipo: "Pick-up" }, { id: "v4", placa: "P-228-775", tipo: "Furgón" }
      ],
      assignments: [
        { ruta: "demo-1", vehiculo: "v1" }, { ruta: "demo-2", vehiculo: "v2" },
        { ruta: "demo-3", vehiculo: "v3" }, { ruta: "demo-4", vehiculo: "v4" }
      ]
    };
    // Incidentes de ejemplo: aparecen a una fracción del recorrido (se ubican cuando la ruta ya está trazada).
    const incidentes = [
      { id: "demo-i1", ruta_id: "demo-1", tipo: "accidente", severidad: "alta", descripcion: "Colisión leve en el bulevar (demo)", fraccion: 0.45 },
      { id: "demo-i2", ruta_id: "demo-3", tipo: "desvio_ruta", severidad: "baja", descripcion: "Desvío menor de la ruta planificada (demo)", fraccion: 0.3 }
    ];
    return { rutas, disp, incidentes, ahora };
  }

  /* ---------- montaje ---------- */

  function mount(container) {
    if (!container || container.dataset.mmListo) return null;
    container.dataset.mmListo = "1";

    const S = {
      map: null, capaUnidades: null, capaIncidentes: null, capaRuta: null,
      unidades: new Map(),           // id → unidad (con marcador, geometría y tarjeta)
      incidentes: [], firmaIncidentes: "", marcadoresIncidente: new Map(),
      sinAsignar: 0,
      seleccion: null, seguir: false, filtro: "todos", busca: "",
      mult: 1, relojSim: Date.now(), relojReal: Date.now(),
      demo: false, demoDatos: null,
      cargando: true, errorDatos: "", fallosIncidentes: 0, errorIncidentes: "",
      timers: [], iniciado: false, visible: false, geoCola: [], geoActivas: 0
    };
    const el = {};

    const ahoraSim = () => S.relojSim + (Date.now() - S.relojReal) * S.mult;

    /* --- esqueleto (se construye una vez; el mapa nunca se destruye) --- */
    function construir() {
      el.stats = {
        ruta: h("b", {}, "0"), incidente: h("b", {}, "0"), otras: h("b", {}, "0")
      };
      el.velocidad = h("div", { class: "mm-seg", role: "group", "aria-label": "Velocidad de la simulación" },
        MULTIPLICADORES.map(m => h("button", {
          type: "button", "data-mult": m, "aria-pressed": String(m === 1),
          title: m === 1 ? "Tiempo real" : "Avanza el reloj " + m + " veces más rápido (solo para revisar el recorrido)",
          onclick: () => cambiarVelocidad(m)
        }, m + "x")));
      el.btnDemo = h("button", { type: "button", class: "mm-btn", onclick: alternarDemo }, "Ver demostración");
      el.btnFlota = h("button", { type: "button", class: "mm-btn", onclick: enfocarFlota }, "Enfocar flota");
      el.notas = h("div", { class: "mm-notas" });
      el.busca = h("input", { type: "search", maxlength: "60", placeholder: "Buscar conductor, placa o ruta…", "aria-label": "Buscar unidad", autocomplete: "off",
        oninput: e => { S.busca = e.target.value.trim().toLowerCase(); pintarLista(); } });
      el.chips = h("div", { class: "mm-chips", role: "group", "aria-label": "Filtrar unidades" },
        FILTROS.map(([id, texto]) => h("button", {
          type: "button", "data-filtro": id, "aria-pressed": String(id === "todos"),
          onclick: () => { S.filtro = id; pintarLista(); }
        }, texto + " ", h("b", {}, "0"))));
      el.lista = h("div", { class: "mm-list", "aria-live": "off" });
      el.mapa = h("div", { class: "mm-map mm-dark", role: "application", "aria-label": "Mapa de unidades en vivo" });
      el.detalle = construirDetalle();

      container.replaceChildren(h("div", { class: "mm" },
        h("div", { class: "mm-head" },
          h("div", {}, h("span", { class: "mm-kicker" }, "MAPA EN VIVO"), h("h2", {}, "Unidades en ruta")),
          h("div", { class: "mm-tools" },
            h("div", { class: "mm-stats", "aria-label": "Resumen de unidades" },
              h("span", { class: "mm-stat mm-s-ruta" }, h("i", {}), el.stats.ruta, " en ruta"),
              h("span", { class: "mm-stat mm-s-inc" }, h("i", {}), el.stats.incidente, " con incidente"),
              h("span", { class: "mm-stat mm-s-otras" }, h("i", {}), el.stats.otras, " otras")),
            el.velocidad, el.btnFlota, el.btnDemo)),
        el.notas,
        h("div", { class: "mm-body" },
          h("aside", { class: "mm-side" }, h("div", { class: "mm-filtros" }, el.busca, el.chips), el.lista),
          h("section", { class: "mm-mapwrap" }, el.mapa, el.detalle)),
        h("p", { class: "mm-foot" }, "La posición de cada unidad es estimada: se calcula con la hora de salida y la ruta por calles. © OpenStreetMap · OSRM")));
    }

    function campo(etiqueta, nodo) {
      return h("div", { class: "mm-d-campo" }, h("small", {}, etiqueta), nodo);
    }

    function construirDetalle() {
      const d = el.det = {
        icono: h("div", { class: "mm-d-icono", "aria-hidden": "true" }, "▲"),
        placa: h("strong", { class: "mm-d-placa" }, "—"),
        estado: h("span", { class: "mm-badge" }, "—"),
        conductor: h("p", { class: "mm-d-conductor" }, "—"),
        ruta: h("small", { class: "mm-d-ruta" }, "—"),
        vehiculo: h("strong", {}, "—"), monto: h("strong", {}, "—"), riesgo: h("strong", {}, "—"),
        velocidad: h("strong", {}, "—"), llegada: h("strong", {}, "—"), avance: h("strong", {}, "—"),
        barra: h("span", {}), trayecto: h("small", { class: "mm-d-trayecto" }, "—"),
        incidentes: h("div", { class: "mm-d-inc" }),
        seguir: h("button", { type: "button", class: "mm-btn mm-btn-prim", onclick: () => { S.seguir = true; const u = actual(); if (u && u.pos) S.map.panTo([u.pos.lat, u.pos.lng]); } }, "Seguir unidad"),
        ocultar: h("button", { type: "button", class: "mm-btn", onclick: () => { S.capaRuta.clearLayers(); } }, "Ocultar ruta")
      };
      return h("div", { class: "mm-detail hidden", "aria-live": "polite" },
        h("div", { class: "mm-d-top" }, d.icono,
          h("div", { class: "mm-d-id" }, h("div", { class: "mm-d-fila" }, d.placa, d.estado), d.conductor, d.ruta),
          h("button", { type: "button", class: "mm-x", "aria-label": "Cerrar detalle", onclick: cerrarDetalle }, "×")),
        h("div", { class: "mm-d-grid" },
          campo("Vehículo", d.vehiculo), campo("Monto que lleva", d.monto), campo("Riesgo", d.riesgo),
          campo("Velocidad est.", d.velocidad), campo("Llegada est.", d.llegada), campo("Avance", d.avance)),
        h("div", { class: "mm-bar" }, d.barra),
        d.trayecto, d.incidentes,
        h("div", { class: "mm-d-acciones" }, d.seguir, d.ocultar));
    }

    /* --- mapa --- */
    function iniciarMapa() {
      if (S.map || !global.L) return;
      const L = global.L;
      S.map = L.map(el.mapa, { center: CENTRO, zoom: 12, zoomControl: false });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 19
      }).addTo(S.map);
      L.control.zoom({ position: "topright" }).addTo(S.map);
      S.capaRuta = L.layerGroup().addTo(S.map);
      S.capaIncidentes = L.layerGroup().addTo(S.map);
      S.capaUnidades = L.layerGroup().addTo(S.map);
      S.map.on("dragstart", () => { S.seguir = false; });
      if (global.ResizeObserver) new global.ResizeObserver(() => { if (S.map) S.map.invalidateSize(); }).observe(el.mapa);
    }

    function iconoUnidad(u) {
      u.dom = {
        raiz: h("div", { class: "mm-pin" }),
        flecha: h("i", { class: "mm-arrow" }),
        placa: h("span", { class: "mm-plate" }, "—")
      };
      u.dom.raiz.append(h("span", { class: "mm-pulse" }), h("span", { class: "mm-dot" }, u.dom.flecha), u.dom.placa);
      return global.L.divIcon({ className: "mm-pin-wrap", html: u.dom.raiz, iconSize: [46, 46], iconAnchor: [23, 23] });
    }

    function textoTooltip(u) {
      return h("div", {}, h("strong", {}, u.conductor), h("span", {}, (u.vehiculo ? u.vehiculo.placa + " · " : "") + montoTexto(u.monto)));
    }

    function crearMarcador(u) {
      const L = global.L;
      const inicio = [u.origen.lat, u.origen.lng];
      u.marcador = L.marker(inicio, { icon: iconoUnidad(u), keyboard: false, zIndexOffset: 500 }).addTo(S.capaUnidades);
      u.marcador.bindTooltip(textoTooltip(u), { direction: "top", offset: [0, -22], className: "mm-tip" });
      u.marcador.on("click", () => seleccionar(u.id, false));
    }

    /* --- unidades --- */
    function claveGeo(u) {
      return [u.origen.lat, u.origen.lng, u.destino.lat, u.destino.lng].join(",");
    }

    function aplicarUnidades(nuevas) {
      const ids = new Set(nuevas.map(u => u.id));
      S.unidades.forEach((u, id) => {
        if (!ids.has(id)) {
          if (u.marcador) S.capaUnidades.removeLayer(u.marcador);
          S.unidades.delete(id);
          if (S.seleccion === id) cerrarDetalle();
        }
      });
      nuevas.forEach(n => {
        const previa = S.unidades.get(n.id);
        if (previa) {
          const cambioRuta = claveGeo(previa) !== claveGeo(n);
          Object.assign(previa, n, { dom: previa.dom, marcador: previa.marcador, tarjeta: previa.tarjeta, geo: cambioRuta ? null : previa.geo, posReal: previa.posReal });
          if (cambioRuta) pedirGeometria(previa);
          if (previa.marcador) previa.marcador.setTooltipContent(textoTooltip(previa));
        } else {
          const u = Object.assign({}, n, { geo: null, pos: null, posReal: null, visto: Date.now() });
          crearMarcador(u);
          S.unidades.set(u.id, u);
          pedirGeometria(u);
        }
      });
    }

    // Trazado por calles con OSRM (máx. 2 a la vez para no saturar el servicio público). Si falla, línea recta marcada como aproximada.
    function pedirGeometria(u) {
      u.geo = null;
      S.geoCola.push(u.id);
      correrColaGeo();
    }

    function correrColaGeo() {
      while (S.geoActivas < 2 && S.geoCola.length) {
        const u = S.unidades.get(S.geoCola.shift());
        if (!u || u.geo) continue;
        const clave = claveGeo(u);
        S.geoActivas += 1;
        obtenerRuta(u.origen, u.destino).then(geo => {
          const actual = S.unidades.get(u.id);
          if (actual && claveGeo(actual) === clave) {
            actual.geo = Object.assign(geo, { acc: acumulado(geo.coords) });
            if (S.seleccion === actual.id) dibujarRuta(actual);
          }
        }).finally(() => {
          S.geoActivas -= 1;
          correrColaGeo();
          if (S.demo) cargarIncidentes();   // los incidentes de la demo necesitan la ruta ya trazada
          tick();
        });
      }
    }

    async function obtenerRuta(origen, destino) {
      const url = OSRM_URL + origen.lng + "," + origen.lat + ";" + destino.lng + "," + destino.lat + "?overview=full&geometries=geojson";
      const control = new global.AbortController();
      const plazo = global.setTimeout(() => control.abort(), 9000);
      try {
        const respuesta = await global.fetch(url, { signal: control.signal });
        if (!respuesta.ok) throw new Error("OSRM " + respuesta.status);
        const datos = await respuesta.json();
        const ruta = datos.code === "Ok" && datos.routes && datos.routes[0];
        if (!ruta || !ruta.geometry || ruta.geometry.coordinates.length < 2) throw new Error("Sin ruta");
        return { coords: ruta.geometry.coordinates.map(c => [c[1], c[0]]), duracionMs: ruta.duration * 1000, distanciaM: ruta.distance, aprox: false };
      } catch (error) {
        const recta = [[origen.lat, origen.lng], [destino.lat, destino.lng]];
        const metros = distancia(recta[0], recta[1]) * 1.3;
        return { coords: recta, duracionMs: (metros / (VELOCIDAD_RESPALDO_KMH / 3.6)) * 1000, distanciaM: metros, aprox: true };
      } finally {
        global.clearTimeout(plazo);
      }
    }

    /* --- estado y movimiento --- */
    function estadoDe(u) {
      const inc = peorIncidente(u.incidentes);
      const ahora = ahoraSim();
      const salida = u.salidaMs || horaASalida(u.horario, ahora) || u.visto;
      const dur = u.geo ? u.geo.duracionMs : 0;
      const base = u.posReal ? { estado: "en_ruta", p: u.posReal.p == null ? 0 : u.posReal.p } : (u.geo ? avance(salida, dur, ahora) : { estado: ahora < salida ? "por_salir" : "en_ruta", p: 0 });
      return Object.assign({ inc, salida }, base);
    }

    function colorDe(info) {
      return info.inc ? SEV[info.inc.severidad].color : ESTADO[info.estado].color;
    }

    function textoEstado(info) {
      return info.inc ? "Incidente · " + SEV[info.inc.severidad].titulo : ESTADO[info.estado].texto;
    }

    function velocidadKmh(u, info) {
      if (info.estado !== "en_ruta" || !u.geo || !(u.geo.duracionMs > 0)) return 0;
      return Math.round((u.geo.distanciaM / (u.geo.duracionMs / 1000)) * 3.6);
    }

    function tick() {
      if (!S.map) return;
      const conteo = { en_ruta: 0, incidente: 0, otras: 0 };
      S.unidades.forEach(u => {
        const info = estadoDe(u);
        u.info = info;
        if (u.posReal) u.pos = { lat: u.posReal.lat, lng: u.posReal.lng, rumbo: u.pos ? u.pos.rumbo : 0, idx: 0 };
        else if (u.geo) u.pos = puntoEn(u.geo.coords, u.geo.acc, info.p);
        else u.pos = { lat: u.origen.lat, lng: u.origen.lng, rumbo: 0, idx: 0 };
        u.marcador.setLatLng([u.pos.lat, u.pos.lng]);
        const color = colorDe(info);
        u.dom.raiz.style.setProperty("--c", color);
        u.dom.raiz.classList.toggle("mm-alerta", Boolean(info.inc));
        u.dom.raiz.classList.toggle("mm-quieta", info.estado !== "en_ruta" && !info.inc);
        u.dom.flecha.style.transform = "rotate(" + Math.round(u.pos.rumbo) + "deg)";
        u.dom.placa.textContent = u.vehiculo ? u.vehiculo.placa : u.conductor;
        conteo[grupo(u, info.estado)] += 1;
        actualizarTarjeta(u, info, color);
      });
      el.stats.ruta.textContent = conteo.en_ruta;
      el.stats.incidente.textContent = conteo.incidente;
      el.stats.otras.textContent = conteo.otras;
      const u = actual();
      if (u && u.pos) {
        if (S.seguir) S.map.panTo([u.pos.lat, u.pos.lng], { animate: false });
        actualizarDetalle(u);
        actualizarRecorrido(u);
      }
    }

    /* --- barra lateral --- */
    function pasaFiltro(u) {
      const info = u.info || estadoDe(u);
      if (S.filtro !== "todos" && grupo(u, info.estado) !== S.filtro) return false;
      if (!S.busca) return true;
      return [u.conductor, u.nombre, u.vehiculo && u.vehiculo.placa, u.vehiculo && u.vehiculo.tipo].filter(Boolean).join(" ").toLowerCase().includes(S.busca);
    }

    function pintarLista() {
      const todas = Array.from(S.unidades.values());
      todas.forEach(u => { u.info = estadoDe(u); });
      const cuenta = { todos: todas.length, en_ruta: 0, incidente: 0, otras: 0 };
      todas.forEach(u => { cuenta[grupo(u, u.info.estado)] += 1; });
      el.chips.querySelectorAll("button").forEach(b => {
        b.setAttribute("aria-pressed", String(b.dataset.filtro === S.filtro));
        b.querySelector("b").textContent = cuenta[b.dataset.filtro];
      });
      // Incidentes primero (más graves arriba), luego en ruta, luego el resto.
      const peso = u => (u.info.inc ? 10 + SEV[u.info.inc.severidad].rango : u.info.estado === "en_ruta" ? 5 : 0);
      const visibles = todas.filter(pasaFiltro).sort((a, b) => peso(b) - peso(a) || a.conductor.localeCompare(b.conductor));
      todas.forEach(u => { u.tarjeta = null; });
      if (!visibles.length) {
        el.lista.replaceChildren(vacioLista(todas.length));
        return;
      }
      el.lista.replaceChildren(...visibles.map(tarjeta));
      visibles.forEach(u => actualizarTarjeta(u, u.info, colorDe(u.info)));
    }

    function vacioLista(hayUnidades) {
      if (S.cargando) return h("p", { class: "mm-empty", role: "status" }, "Cargando unidades…");
      if (S.errorDatos) return h("p", { class: "mm-empty mm-empty-error", role: "alert" }, "No se pueden mostrar las unidades en este momento. Esto no significa que no haya ninguna en ruta.");
      if (hayUnidades) return h("p", { class: "mm-empty" }, "Ninguna unidad coincide con el filtro.");
      return h("div", { class: "mm-empty" },
        h("p", {}, "No hay unidades en ruta ahora mismo."),
        h("small", {}, "Aparecen aquí las rutas de hoy con viaje (origen y destino) que ya tienen conductor y vehículo asignados."),
        h("button", { type: "button", class: "mm-btn", onclick: alternarDemo }, "Ver demostración"));
    }

    function tarjeta(u) {
      const ref = u.tarjeta = {
        raiz: h("button", { type: "button", class: "mm-card", onclick: () => seleccionar(u.id, true) }),
        estado: h("span", { class: "mm-badge" }, "—"),
        vel: h("span", { class: "mm-card-vel" }, "—"),
        barra: h("span", {})
      };
      ref.raiz.append(
        h("div", { class: "mm-card-top" }, h("strong", {}, u.vehiculo ? u.vehiculo.placa : "Sin vehículo"), ref.estado, ref.vel),
        h("div", { class: "mm-card-driver" }, "👤 ", u.conductor),
        h("div", { class: "mm-card-meta" }, h("span", {}, "Monto " + montoTexto(u.monto)), h("span", { class: "mm-card-ruta" }, u.nombre)),
        h("div", { class: "mm-bar" }, ref.barra));
      if (S.seleccion === u.id) ref.raiz.classList.add("mm-sel");
      return ref.raiz;
    }

    function actualizarTarjeta(u, info, color) {
      const t = u.tarjeta;
      if (!t) return;
      t.raiz.style.setProperty("--c", color);
      t.raiz.classList.toggle("mm-card-alerta", Boolean(info.inc));
      t.estado.textContent = textoEstado(info);
      t.vel.textContent = velocidadKmh(u, info) + " km/h";
      t.barra.style.width = Math.round(info.p * 100) + "%";
    }

    /* --- detalle, selección y recorrido --- */
    const actual = () => (S.seleccion ? S.unidades.get(S.seleccion) : null);

    function seleccionar(id, volar) {
      const u = S.unidades.get(id);
      if (!u) return;
      S.seleccion = id;
      S.seguir = true;
      el.detalle.classList.remove("hidden");
      el.lista.querySelectorAll(".mm-card").forEach(c => c.classList.remove("mm-sel"));
      if (u.tarjeta) u.tarjeta.raiz.classList.add("mm-sel");
      if (u.pos && volar) S.map.flyTo([u.pos.lat, u.pos.lng], 15, { duration: 1 });
      dibujarRuta(u);
      tick();
    }

    function cerrarDetalle() {
      S.seleccion = null;
      S.seguir = false;
      el.detalle.classList.add("hidden");
      if (S.capaRuta) S.capaRuta.clearLayers();
      el.lista.querySelectorAll(".mm-sel").forEach(c => c.classList.remove("mm-sel"));
    }

    function dibujarRuta(u) {
      const L = global.L;
      S.capaRuta.clearLayers();
      if (!u.geo) return;
      u.capas = {
        total: L.polyline(u.geo.coords, { color: "#5b8cff", weight: 5, opacity: 0.3, dashArray: u.geo.aprox ? "6 8" : null }).addTo(S.capaRuta),
        hecho: L.polyline([], { color: "#5b8cff", weight: 5, opacity: 0.95 }).addTo(S.capaRuta)
      };
      const punto = (lugar, etiqueta, color) => L.circleMarker([lugar.lat, lugar.lng], { radius: 7, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 })
        .bindTooltip(h("div", {}, h("strong", {}, etiqueta), h("span", {}, lugar.texto || "")), { className: "mm-tip" }).addTo(S.capaRuta);
      punto(u.origen, "Origen", "#3fb27f");
      punto(u.destino, "Destino", "#e5484d");
      actualizarRecorrido(u);
    }

    function actualizarRecorrido(u) {
      if (!u.capas || !u.geo || !u.pos) return;
      const color = colorDe(u.info);
      const hecho = u.geo.coords.slice(0, u.pos.idx + 1);
      hecho.push([u.pos.lat, u.pos.lng]);
      u.capas.hecho.setLatLngs(hecho);
      u.capas.hecho.setStyle({ color });
      u.capas.total.setStyle({ color });
    }

    function actualizarDetalle(u) {
      const d = el.det;
      const info = u.info;
      const color = colorDe(info);
      el.detalle.style.setProperty("--c", color);
      d.placa.textContent = u.vehiculo ? u.vehiculo.placa : "Sin vehículo";
      d.estado.textContent = textoEstado(info);
      d.conductor.textContent = u.conductor;
      d.ruta.textContent = u.nombre;
      d.vehiculo.textContent = u.vehiculo ? u.vehiculo.tipo : "—";
      d.monto.textContent = montoTexto(u.monto);
      d.riesgo.textContent = u.riesgo || "—";
      d.velocidad.textContent = velocidadKmh(u, info) + " km/h";
      d.llegada.textContent = u.geo ? horaTexto(info.salida + u.geo.duracionMs) : "…";
      d.avance.textContent = Math.round(info.p * 100) + "%";
      d.barra.style.width = Math.round(info.p * 100) + "%";
      d.trayecto.textContent = (u.origen.texto || "Origen") + " → " + (u.destino.texto || "Destino") + (u.geo && u.geo.aprox ? " · ruta aproximada (sin conexión al servicio de calles)" : "");
      d.incidentes.replaceChildren(...u.incidentes.map(i => h("div", { class: "mm-d-inc-item", style: "--c:" + (SEV[i.severidad] ? SEV[i.severidad].color : "#9a9fa8") },
        h("strong", {}, i.tipo_etiqueta || TIPOS[i.tipo] || "Incidente"),
        h("span", {}, i.descripcion || "Sin descripción"))));
      d.icono.style.transform = "rotate(" + Math.round(u.pos ? u.pos.rumbo : 0) + "deg)";
    }

    /* --- incidentes en el mapa --- */
    function pintarIncidentes() {
      const L = global.L;
      const firma = S.incidentes.map(i => [i.id, i.severidad, i.lat, i.lng].join(":")).sort().join("|");
      if (firma === S.firmaIncidentes) return;
      S.firmaIncidentes = firma;
      S.capaIncidentes.clearLayers();
      S.incidentes.forEach(i => {
        if (!SEV[i.severidad] || i.lat == null || i.lng == null) return;
        const color = SEV[i.severidad].color;
        const icono = L.divIcon({ className: "mm-inc-wrap", html: h("div", { class: "mm-inc", style: "--c:" + color }, h("span", {}, "!")), iconSize: [30, 30], iconAnchor: [15, 15] });
        const u = S.unidades.get(String(i.ruta_id || ""));
        L.marker([i.lat, i.lng], { icon: icono, zIndexOffset: 800 }).addTo(S.capaIncidentes).bindPopup(
          h("div", { class: "mm-pop", style: "--c:" + color },
            h("small", {}, SEV[i.severidad].titulo.toUpperCase() + " · " + (i.tipo_etiqueta || TIPOS[i.tipo] || "Incidente").toUpperCase()),
            h("strong", {}, i.descripcion || "Sin descripción"),
            h("span", {}, [i.ruta || (u && u.nombre), i.conductor || (u && u.conductor)].filter(Boolean).join(" · "))),
          { className: "mm-popup" });
      });
    }

    function aplicarIncidentes(items) {
      S.incidentes = items;
      S.unidades.forEach(u => { u.incidentes = []; });
      items.forEach(i => {
        const u = S.unidades.get(String(i.ruta_id || i.viaje || ""));
        if (u) u.incidentes.push(i);
      });
      pintarIncidentes();
      pintarLista();
      tick();
    }

    /* --- datos --- */
    function pintarNotas() {
      const notas = [];
      if (S.demo) notas.push(["mm-nota-demo", "MODO DEMOSTRACIÓN · datos de ejemplo, no se guardan. Usa 10x o 60x para ver el recorrido completo."]);
      if (S.errorDatos) notas.push(["mm-nota-error", S.errorDatos, "Reintentar", () => cargarDatos(true)]);
      if (S.errorIncidentes) notas.push(["mm-nota-warn", S.errorIncidentes, "Reintentar", () => cargarIncidentes(true)]);
      if (S.sinAsignar && !S.demo) notas.push(["mm-nota-info", S.sinAsignar + (S.sinAsignar === 1 ? " ruta con viaje sin conductor asignado" : " rutas con viaje sin conductor asignado") + " (se asigna en Empleados y Vehículos)."]);
      if (S.mult > 1) notas.push(["mm-nota-info", "Reloj acelerado ×" + S.mult + ": las posiciones no corresponden a la hora real."]);
      el.notas.replaceChildren(...notas.map(([clase, texto, accion, fn]) => h("div", { class: "mm-nota " + clase, role: "status" },
        h("span", {}, texto), accion ? h("button", { type: "button", class: "mm-btn", onclick: fn }, accion) : null)));
    }

    async function cargarDatos(manual) {
      if (S.demo) return;
      if (!global.Api || !global.Api.session()) return;
      if (manual) { S.cargando = true; pintarLista(); }
      try {
        const [rutas, disp] = await Promise.all([global.Api.post("/rutas/listar"), global.Api.post("/disponibilidad/listar")]);
        if (S.demo) return;
        const armado = armarUnidades(rutas && rutas.rutas, disp, S.incidentes);
        S.sinAsignar = armado.sinAsignar;
        S.errorDatos = "";
        aplicarUnidades(armado.unidades);
      } catch (error) {
        if (S.demo) return;
        S.errorDatos = (error && error.message) || "No se pudieron cargar las rutas y los vehículos";
      }
      S.cargando = false;
      pintarNotas();
      pintarLista();
      tick();
    }

    async function cargarIncidentes(manual) {
      if (S.demo) {
        const items = [];
        S.demoDatos.incidentes.forEach(spec => {
          const u = S.unidades.get(spec.ruta_id);
          if (!u || !u.geo) return;
          const p = puntoEn(u.geo.coords, u.geo.acc, spec.fraccion);
          items.push(Object.assign({}, spec, { lat: p.lat, lng: p.lng, ruta: u.nombre, conductor: u.conductor }));
        });
        aplicarIncidentes(items);
        return;
      }
      if (!global.Api || !global.Api.session()) return;
      try {
        const datos = await global.Api.post("/incidentes/listar");
        if (S.demo) return;
        S.fallosIncidentes = 0;
        S.errorIncidentes = "";
        aplicarIncidentes(Array.isArray(datos && datos.items) ? datos.items : []);
      } catch (error) {
        if (S.demo) return;
        S.fallosIncidentes += 1;
        // Nunca se pinta «sin incidentes» si en realidad no hay conexión: se conserva lo último y se avisa.
        if (manual || S.fallosIncidentes >= FALLOS_PARA_AVISAR) S.errorIncidentes = "No se pueden recibir alertas de incidentes en tiempo real";
      }
      pintarNotas();
    }

    /* --- controles --- */
    function cambiarVelocidad(m) {
      // 1x vuelve a la hora real (si no, el reloj se quedaría adelantado); 10x/60x aceleran desde el instante actual.
      S.relojSim = m === 1 ? Date.now() : ahoraSim();
      S.relojReal = Date.now();
      S.mult = m;
      el.velocidad.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.mult) === m)));
      pintarNotas();
      tick();
    }

    function enfocarFlota() {
      const puntos = Array.from(S.unidades.values()).filter(u => u.pos).map(u => [u.pos.lat, u.pos.lng]);
      if (!puntos.length || !S.map) return;
      S.seguir = false;
      S.map.fitBounds(global.L.latLngBounds(puntos).pad(0.25), { maxZoom: 15 });
    }

    function reiniciarUnidades() {
      cerrarDetalle();
      S.unidades.forEach(u => { if (u.marcador) S.capaUnidades.removeLayer(u.marcador); });
      S.unidades.clear();
      S.incidentes = [];
      S.firmaIncidentes = "";
      S.capaIncidentes.clearLayers();
      S.geoCola = [];
    }

    function alternarDemo() {
      reiniciarUnidades();
      cambiarVelocidad(1);
      if (!S.demo) {
        S.demo = true;
        S.demoDatos = demoDatos();
        el.btnDemo.textContent = "Salir de la demo";
        const armado = armarUnidades(S.demoDatos.rutas, S.demoDatos.disp, []);
        S.sinAsignar = 0;
        S.errorDatos = S.errorIncidentes = "";
        S.cargando = false;
        aplicarUnidades(armado.unidades);
        pintarNotas();
        pintarLista();
        tick();
        enfocarFlota();
      } else {
        S.demo = false;
        S.demoDatos = null;
        el.btnDemo.textContent = "Ver demostración";
        S.cargando = true;
        pintarNotas();
        pintarLista();
        cargarDatos(true).then(() => cargarIncidentes());
      }
    }

    /* --- ciclo de vida: solo trabaja mientras el panel se ve --- */
    function detener() {
      S.timers.forEach(t => global.clearInterval(t));
      S.timers = [];
    }

    function arrancar() {
      if (S.timers.length) return;
      S.timers = [
        global.setInterval(tick, TICK_MS),
        global.setInterval(() => { if (!S.demo) cargarDatos(); }, DATOS_MS),
        global.setInterval(() => { if (!S.demo) cargarIncidentes(); }, INCIDENTES_MS)
      ];
    }

    function alCambiarVisibilidad(visible) {
      S.visible = visible;
      if (!visible) { detener(); return; }
      if (!S.iniciado) {
        if (!global.L) { container.replaceChildren(h("p", { class: "mm-empty mm-empty-error", role: "alert" }, "No se pudo cargar el mapa (Leaflet).")); return; }
        S.iniciado = true;
        iniciarMapa();
        pintarLista();
        cargarDatos().then(() => cargarIncidentes());
      }
      setTimeout(() => { if (S.map) S.map.invalidateSize(); }, 50);
      arrancar();
      tick();
    }

    construir();
    pintarNotas();
    pintarLista();
    if (global.IntersectionObserver) {
      new global.IntersectionObserver(entradas => alCambiarVisibilidad(entradas.some(e => e.isIntersecting))).observe(container);
    } else {
      alCambiarVisibilidad(true);
    }

    return {
      // GPS real: fija la posición de la unidad (p = avance 0..1 opcional, para la barra y el estado).
      setPosicion(rutaId, lat, lng, p) {
        const u = S.unidades.get(String(rutaId));
        if (u && Number.isFinite(lat) && Number.isFinite(lng)) { u.posReal = { lat, lng, p: p == null ? null : p }; tick(); }
      },
      refresh() { return cargarDatos(true).then(() => cargarIncidentes(true)); }
    };
  }

  function autoMontar() {
    const contenedor = document.getElementById("panelMapaMonitoreo");
    if (contenedor) global.MapaMonitoreo.instancia = mount(contenedor);
  }

  global.MapaMonitoreo = {
    mount,
    instancia: null,
    util: { distancia, acumulado, puntoEn, horaASalida, avance, peorIncidente, armarUnidades, montoTexto, grupo }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoMontar);
  else autoMontar();
})(window);
