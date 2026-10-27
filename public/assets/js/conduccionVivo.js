/* =====================================================================
   CONDUCCIÓN EN VIVO — SERSAPROSA   (window.ConduccionVivo)

   FCJ1-142  Pantalla de monitoreo en tiempo real de rutas activas
   FCJ1-143  Detectar pérdida de señal y mostrar estado «Sin señal»
   FCJ1-144  Alertas dentro de la aplicación por velocidad excesiva o conducta de riesgo
   FCJ1-145  Registro de eventos de exceso de velocidad y conducta de riesgo

   Solo HTML + JS: los datos se guardan en este navegador (localStorage).
   Datos reales:  ConduccionVivo.recibirLectura({ ruta_id, velocidad_kmh, lat, lng, eventos: ["frenada_brusca"] })
   ===================================================================== */
(function (global) {
  "use strict";

  // Valores que la HU deja como [X]
  const CONFIG = {
    refrescoSeg: 10,    // cada cuántos segundos se actualiza la pantalla
    sinSenalMin: 2,     // minutos sin datos para mostrar «Sin señal»
    limiteKmh: 80       // límite de velocidad
  };

  const CLAVE = "sersaprosa.conduccion.v1";
  const ZONA = "America/El_Salvador";
  const TIPOS = {
    exceso_velocidad: "Exceso de velocidad",
    frenada_brusca: "Frenada brusca",
    aceleracion_brusca: "Aceleración brusca",
    giro_brusco: "Giro brusco"
  };
  const MAX_REGISTRO = 500, MAX_ALERTAS = 5, FILAS_REGISTRO = 50;

  // Rutas en curso (ejemplo). Reemplazar con definirRutas([...]) al conectar las rutas reales.
  let rutas = [
    { id: "RT-1", nombre: "Ruta Centro", conductor: "Ana López", vehiculo: "P123-456", lat: 13.69, lng: -89.22 },
    { id: "RT-2", nombre: "Ruta Norte", conductor: "Luis Pérez", vehiculo: "P789-012", lat: 13.72, lng: -89.19 },
    { id: "RT-3", nombre: "Ruta Sur", conductor: "Marta Rivas", vehiculo: "P345-678", lat: 13.65, lng: -89.17 }
  ];
  let pantalla = null;

  /* ---------- Almacenamiento ---------- */
  let memoria = { ultimas: {}, eventos: [] };
  function leer() {
    try {
      const dato = JSON.parse(global.localStorage.getItem(CLAVE) || "null");
      if (dato && dato.ultimas && Array.isArray(dato.eventos)) return dato;
    } catch (error) { /* sin almacenamiento: se usa la memoria de la página */ }
    return memoria;
  }
  function guardar(estado) {
    memoria = estado;
    try { global.localStorage.setItem(CLAVE, JSON.stringify(estado)); } catch (error) { /* idem */ }
  }

  /* ---------- Recepción de lecturas y detección de eventos ---------- */
  function recibirLectura(datos) {
    const d = datos || {};
    const ruta = rutas.find(r => r.id === String(d.ruta_id || ""));
    if (!ruta) throw new Error("La ruta no está en curso.");
    const velocidad = d.velocidad_kmh;
    if (typeof velocidad !== "number" || !isFinite(velocidad) || velocidad < 0 || velocidad > 250) {
      throw new Error("La velocidad debe ser un número entre 0 y 250 km/h.");
    }
    const fecha = d.fecha ? Date.parse(d.fecha) : Date.now();
    if (isNaN(fecha)) throw new Error("La fecha de la lectura no es válida.");
    const conductas = d.eventos || [];
    conductas.forEach(tipo => {
      if (!TIPOS[tipo] || tipo === "exceso_velocidad") throw new Error("Tipo de evento no válido: " + tipo);
    });

    const estado = leer();
    const previa = estado.ultimas[ruta.id];
    const fechaPrevia = previa ? Date.parse(previa.fecha) : null;
    if (fechaPrevia !== null && fecha < fechaPrevia) return;     // lectura atrasada: no pisa la más reciente

    // Un exceso prolongado es UN solo evento: se registra cuando empieza.
    const yaExcedia = previa && previa.velocidad_kmh > CONFIG.limiteKmh && fecha - fechaPrevia <= CONFIG.sinSenalMin * 60000;
    const nuevos = [];
    if (velocidad > CONFIG.limiteKmh && !yaExcedia) nuevos.push("exceso_velocidad");
    conductas.forEach(tipo => nuevos.push(tipo));

    nuevos.forEach(tipo => estado.eventos.unshift({
      id: "ev-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      ruta: ruta.nombre, conductor: ruta.conductor, vehiculo: ruta.vehiculo, tipo: tipo,
      fecha: new Date(fecha).toISOString(), velocidad_kmh: velocidad,
      limite_kmh: tipo === "exceso_velocidad" ? CONFIG.limiteKmh : null,
      lat: typeof d.lat === "number" ? d.lat : null, lng: typeof d.lng === "number" ? d.lng : null
    }));
    estado.eventos.length = Math.min(estado.eventos.length, MAX_REGISTRO);
    estado.ultimas[ruta.id] = {
      velocidad_kmh: velocidad, fecha: new Date(fecha).toISOString(),
      lat: typeof d.lat === "number" ? d.lat : null, lng: typeof d.lng === "number" ? d.lng : null
    };
    guardar(estado);
    if (pantalla) pantalla.refrescar();
  }

  // «Sin señal»: pasados sinSenalMin minutos sin lecturas. No se muestra velocidad vieja como actual.
  function filaRuta(ruta, ultima, ahora) {
    const t = ultima ? Date.parse(ultima.fecha) : null;
    const senal = t === null ? "sin_datos" : (ahora - t > CONFIG.sinSenalMin * 60000 ? "sin_senal" : "activa");
    const velocidad = senal === "activa" ? ultima.velocidad_kmh : null;
    return {
      ruta: ruta.nombre, conductor: ruta.conductor, vehiculo: ruta.vehiculo, senal: senal, velocidad: velocidad,
      exceso: velocidad !== null && velocidad > CONFIG.limiteKmh, ultima: t
    };
  }

  /* ---------- Utilidades de pantalla ---------- */
  function h(tag, attrs, ...hijos) {
    const e = global.document.createElement(tag);
    for (const k in (attrs || {})) {
      if (k === "class") e.className = attrs[k];
      else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    hijos.flat().forEach(c => { if (c != null) e.append(c); });
    return e;
  }
  const hora = ms => new Date(ms).toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: ZONA });
  const fechaHora = ms => new Date(ms).toLocaleDateString("es-SV", { timeZone: ZONA }) + " " + hora(ms);
  const kmh = v => (v == null ? "—" : Math.round(v) + " km/h");
  const ubicacion = e => (e.lat == null || e.lng == null ? "—" : e.lat.toFixed(5) + ", " + e.lng.toFixed(5));
  function hace(desde, ahora) {
    const min = Math.floor((ahora - desde) / 60000);
    return min < 1 ? "hace menos de 1 min" : min < 60 ? "hace " + min + " min" : "hace " + Math.floor(min / 60) + " h " + (min % 60) + " min";
  }
  const ESTADOS = {
    activa: ["cv-ok", "Con señal"], sin_senal: ["cv-aviso", "Sin señal"], sin_datos: ["cv-nulo", "Sin datos"], exceso: ["cv-peligro", "Exceso de velocidad"]
  };

  /* ---------- Pantalla ---------- */
  function mount(contenedor) {
    const sesion = global.Api && global.Api.session ? global.Api.session() : null;
    if (!sesion || sesion.role !== "coordinador_rutas") {
      contenedor.textContent = "Esta sección es solo para el coordinador de rutas.";
      return;
    }
    const S = { vistos: null, alertas: [], simulando: null, dispositivos: {}, actualizado: 0 };

    function refrescar() {
      const estado = leer();
      // Alertas nuevas desde que se abrió la pantalla (lo que ya estaba registrado no es una alerta nueva)
      const nuevos = estado.eventos.filter(e => S.vistos && !S.vistos.has(e.id));
      S.vistos = new Set(estado.eventos.map(e => e.id));
      nuevos.reverse().forEach(e => S.alertas.unshift(e));
      S.alertas = S.alertas.slice(0, MAX_ALERTAS);
      S.actualizado = Date.now();
      pintar(estado);
    }

    function pintar(estado) {
      const ahora = Date.now();
      const filas = rutas.map(r => filaRuta(r, estado.ultimas[r.id], ahora));
      const partes = [
        h("div", { class: "cv-cabecera" },
          h("div", {}, h("h2", {}, "Conducción en vivo"),
            h("p", { class: "cv-muted" }, "Velocidad y comportamiento de manejo de las rutas en curso")),
          h("div", { class: "cv-acciones" },
            h("span", { class: "cv-muted" }, "Actualizado " + hora(S.actualizado) + " · cada " + CONFIG.refrescoSeg + " s"),
            h("button", { type: "button", class: "cv-boton", onclick: alternarSimulacion }, S.simulando ? "■ Detener simulación" : "▶ Simular lecturas (demo)"))),

        // FCJ1-144: alertas dentro de la aplicación
        S.alertas.length ? h("div", { class: "cv-alertas", role: "alert" }, S.alertas.map(e =>
          h("div", { class: "cv-alerta" + (e.tipo === "exceso_velocidad" ? " cv-alerta-alta" : "") },
            h("div", {}, h("strong", {}, TIPOS[e.tipo]), " — " + e.conductor + " · " + e.vehiculo + " · " + hora(Date.parse(e.fecha)),
              e.tipo === "exceso_velocidad" ? " · " + kmh(e.velocidad_kmh) + " (límite " + Math.round(e.limite_kmh) + ")" : ""),
            h("button", { type: "button", class: "cv-cerrar", "aria-label": "Cerrar alerta", onclick: () => { S.alertas = S.alertas.filter(a => a !== e); pintar(leer()); } }, "×")))) : null,

        // FCJ1-142 y FCJ1-143: rutas en curso, velocidad y «Sin señal»
        h("h3", {}, "Rutas en curso"),
        h("div", { class: "cv-scroll" }, h("table", { class: "cv-tabla" },
          h("thead", {}, h("tr", {}, ["Ruta", "Conductor", "Vehículo", "Velocidad", "Estado", "Última lectura"].map(t => h("th", { scope: "col" }, t)))),
          h("tbody", {}, filas.map(f => {
            const e = ESTADOS[f.exceso ? "exceso" : f.senal];
            return h("tr", { class: f.senal === "sin_senal" ? "cv-fila-aviso" : f.exceso ? "cv-fila-peligro" : "" },
              h("td", {}, f.ruta), h("td", {}, f.conductor), h("td", {}, f.vehiculo),
              h("td", { class: "cv-vel" }, kmh(f.velocidad)),
              h("td", {}, h("span", { class: "cv-pastilla " + e[0] }, e[1])),
              h("td", {}, f.ultima === null ? "Sin lecturas todavía" : hora(f.ultima) + " (" + hace(f.ultima, ahora) + ")"));
          })))),

        // FCJ1-145: registro de eventos
        h("h3", {}, "Registro de eventos"),
        estado.eventos.length
          ? h("div", { class: "cv-scroll" }, h("table", { class: "cv-tabla" },
            h("thead", {}, h("tr", {}, ["Fecha y hora", "Evento", "Conductor", "Vehículo", "Ruta", "Velocidad", "Ubicación"].map(t => h("th", { scope: "col" }, t)))),
            h("tbody", {}, estado.eventos.slice(0, FILAS_REGISTRO).map(e => h("tr", {},
              h("td", {}, fechaHora(Date.parse(e.fecha))),
              h("td", {}, h("span", { class: "cv-pastilla " + (e.tipo === "exceso_velocidad" ? "cv-peligro" : "cv-aviso") }, TIPOS[e.tipo])),
              h("td", {}, e.conductor), h("td", {}, e.vehiculo), h("td", {}, e.ruta),
              h("td", {}, kmh(e.velocidad_kmh)), h("td", {}, ubicacion(e)))))))
          : h("p", { class: "cv-vacio" }, "Todavía no hay excesos de velocidad ni conductas de riesgo registrados.")
      ];
      contenedor.replaceChildren(h("div", { class: "cv" }, partes.filter(p => p != null)));
    }

    /* Simulación de dispositivos, solo para ver la pantalla funcionando sin datos reales */
    function enviarSimulado() {
      rutas.forEach(r => {
        const d = S.dispositivos[r.id] || (S.dispositivos[r.id] = { vel: 45, lat: r.lat, lng: r.lng });
        d.vel = Math.min(70, Math.max(25, d.vel + (Math.random() - 0.5) * 12));
        d.lat += (Math.random() - 0.5) * 0.001;
        d.lng += (Math.random() - 0.5) * 0.001;
        const velocidad = Math.random() < 0.06 ? 90 + Math.random() * 15 : d.vel;
        const eventos = Math.random() < 0.04 ? ["frenada_brusca"] : [];
        try { recibirLectura({ ruta_id: r.id, velocidad_kmh: Math.round(velocidad * 10) / 10, lat: d.lat, lng: d.lng, eventos: eventos }); } catch (error) { /* se ignora */ }
      });
    }
    function alternarSimulacion() {
      if (S.simulando) { global.clearInterval(S.simulando); S.simulando = null; }
      else { enviarSimulado(); S.simulando = global.setInterval(enviarSimulado, 3000); }
      refrescar();
    }

    pantalla = { refrescar: refrescar };
    refrescar();
    global.setInterval(() => { if (!global.document.hidden) refrescar(); }, CONFIG.refrescoSeg * 1000);
  }

  global.ConduccionVivo = {
    mount: mount,
    recibirLectura: recibirLectura,
    config: CONFIG,
    definirRutas(lista) {
      rutas = (lista || []).filter(r => r && r.id).map(r => ({ id: String(r.id), nombre: r.nombre || String(r.id), conductor: r.conductor || "—", vehiculo: r.vehiculo || "—", lat: r.lat || 0, lng: r.lng || 0 }));
    }
  };
})(window);
