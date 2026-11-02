/* =====================================================================
   REPORTES AUTOMÁTICOS DE VIAJE — SERSAPROSA   (window.ReportesViaje)

   HU: Generar reporte automático del viaje (director de rutas = rol coordinador_rutas)
     FCJ1-161  Estructura del reporte automático de viaje          → armarReporte()
     FCJ1-162  Generación automática al completar el viaje         → iniciar() / revisar()
     FCJ1-163  Agregación de datos del viaje para el reporte       → recopilar()
     FCJ1-164  Reportes incompletos o con error de generación      → faltantes / estado "error" / avisos
     FCJ1-165  Reintento manual de la generación                   → reintentar()
     FCJ1-166  Consulta del reporte desde el historial de viajes   → mount()

   Uso (lo hace dashboard.js):
     ReportesViaje.iniciar()            // revisión en segundo plano desde que inicia sesión
     ReportesViaje.mount(contenedor)    // historial de viajes y detalle de cada reporte → { reload }

   Cómo funciona:
     • Cada CONFIG.revisarSeg segundos consulta /rutas/listar, /entregas/listar y /disponibilidad/listar.
       Una ruta queda «Completada» con la misma regla del centro de control (todos sus pedidos
       completados, CentroRutas.util.estadoRuta). Al detectarlo genera el reporte sin intervención
       del director, dentro del plazo CONFIG.plazoMin.
     • Hora de inicio: la primera vez que se vio la ruta «En curso». Hora de fin: cuando se vio pasar a
       «Completada». Si no se observó, se usa la hora de salida programada y el reporte lo indica.
     • Eventos de velocidad y comportamiento: los registra ConduccionVivo (conduccionVivo.js). Este
       módulo además anota la hora de cada lectura recibida para detectar tramos «sin señal».
     • Solo lectura: el reporte no se edita, no se envía por correo/SMS/WhatsApp y no evalúa al conductor.

   Igual que conduccionVivo.js, los reportes se guardan en este navegador (localStorage). La
   generación ocurre mientras la aplicación esté abierta por un director de rutas.
   ===================================================================== */
(function (global) {
  "use strict";

  // Valores que la HU deja como [X]
  const CONFIG = {
    plazoMin: 5,        // el reporte queda disponible como máximo X minutos después de completarse el viaje
    revisarSeg: 60,     // cada cuántos segundos se revisa si algún viaje se completó
    sinSenalMin: 2      // minutos sin lecturas para considerar un tramo «sin señal» (igual que ConduccionVivo)
  };

  const ROL = "coordinador_rutas";
  const CLAVE = "sersaprosa.reportes.v1";
  const CLAVE_CONDUCCION = "sersaprosa.conduccion.v1";
  const ZONA = "America/El_Salvador";
  const MAX_REPORTES = 300;
  const MAX_LECTURAS = 1500;
  const DIAS_OBSERVACION = 3;
  const POR_PAGINA = 20;

  const TIPOS_EVENTO = {
    exceso_velocidad: "Exceso de velocidad",
    frenada_brusca: "Frenada brusca",
    aceleracion_brusca: "Aceleración brusca",
    giro_brusco: "Giro brusco"
  };
  const ESTADOS_REPORTE = { completo: "Completo", incompleto: "Incompleto", error: "Error de generación" };

  /* ============ Reglas puras (se prueban con node --test tests/js/reportes.test.js) ============ */

  const norm = texto => String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();

  function fechaISO(ms) {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "";
    try {
      return d.toLocaleDateString("en-CA", { timeZone: ZONA });   // YYYY-MM-DD en hora de El Salvador
    } catch (error) {
      return d.toISOString().slice(0, 10);
    }
  }

  function horaCorta(ms) {
    if (ms == null || Number.isNaN(Number(ms))) return "—";
    try {
      return new Date(ms).toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit", timeZone: ZONA });
    } catch (error) {
      return new Date(ms).toISOString().slice(11, 16);
    }
  }

  // Misma regla que CentroRutas.util.estadoRuta, para no depender del orden de carga en las pruebas.
  function estadoViaje(pedidos, asignada) {
    const lista = pedidos || [];
    const completados = lista.filter(p => p.estado === "completada").length;
    const avance = lista.filter(p => p.estado === "proceso").length + completados;
    if (lista.length > 0 && completados === lista.length) return "completada";
    if (asignada && avance > 0) return "en_curso";
    return asignada ? "asignada" : "sin_asignar";
  }

  // Pedidos de una ruta: las entregas cuyo campo `ruta` coincide con su nombre (igual que CentroRutas).
  function pedidosDeRuta(entregas, nombre) {
    const clave = norm(nombre);
    return clave ? (entregas || []).filter(p => norm(p.ruta) === clave) : [];
  }

  // "09:30" + fecha "2026-11-01" → milisegundos (hora de El Salvador, UTC-6 sin horario de verano).
  function horaProgramadaMs(fecha, horario) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || "")) || !/^\d{2}:\d{2}/.test(String(horario || ""))) return null;
    const ms = Date.parse(fecha + "T" + String(horario).slice(0, 5) + ":00-06:00");
    return Number.isNaN(ms) ? null : ms;
  }

  // Tramos sin lecturas mayores que el umbral, dentro de [inicio, fin].
  function huecosDeSenal(lecturas, inicio, fin, umbralMin) {
    if (inicio == null || fin == null || fin <= inicio) return [];
    const umbral = (umbralMin || CONFIG.sinSenalMin) * 60000;
    const marcas = (lecturas || []).map(Number).filter(t => Number.isFinite(t) && t >= inicio && t <= fin).sort((a, b) => a - b);
    if (!marcas.length) return [];
    const puntos = [inicio].concat(marcas, [fin]);
    const huecos = [];
    for (let i = 1; i < puntos.length; i += 1) {
      if (puntos[i] - puntos[i - 1] > umbral) huecos.push({ desde: puntos[i - 1], hasta: puntos[i] });
    }
    return huecos;
  }

  // Eventos de manejo de la ruta dentro de la ventana del viaje (o del día, si no se conoce la ventana).
  function eventosDelViaje(eventos, rutaNombre, fecha, inicio, fin) {
    const clave = norm(rutaNombre);
    return (eventos || []).filter(e => {
      if (!e || norm(e.ruta) !== clave) return false;
      const t = Date.parse(e.fecha);
      if (Number.isNaN(t)) return false;
      if (inicio != null && fin != null) return t >= inicio && t <= fin;
      return fechaISO(t) === fecha;
    }).map(e => ({
      tipo: e.tipo,
      tipo_etiqueta: TIPOS_EVENTO[e.tipo] || String(e.tipo || "Evento"),
      fecha: e.fecha,
      velocidad_kmh: typeof e.velocidad_kmh === "number" ? e.velocidad_kmh : null,
      limite_kmh: typeof e.limite_kmh === "number" ? e.limite_kmh : null,
      lat: typeof e.lat === "number" ? e.lat : null,
      lng: typeof e.lng === "number" ? e.lng : null
    })).sort((a, b) => Date.parse(a.fecha) - Date.parse(b.fecha));
  }

  /* FCJ1-161: estructura del reporte. Recibe todo lo recopilado y decide qué falta.
     datos = { ruta:{id,nombre,zona,horario}, fecha, pedidos, conductor, vehiculo,
               inicio, inicioFuente, fin, finFuente, eventos, lecturas, telemetria (bool), ahora, intentos } */
  function armarReporte(datos) {
    const d = datos || {};
    const ruta = d.ruta || {};
    const ahora = d.ahora || Date.now();
    const faltantes = [];
    const pedidos = (d.pedidos || []).map(p => ({
      id: p.id, cliente: p.cliente || "Sin cliente", direccion: p.direccion || "Sin dirección",
      hora: p.hora || "--:--", estado: p.estado
    }));

    if (!d.conductor) faltantes.push({ campo: "Conductor", detalle: "No se encontró el conductor asignado al viaje." });
    if (!d.vehiculo) faltantes.push({ campo: "Vehículo", detalle: "No se encontró el vehículo asignado al viaje." });

    let inicio = d.inicio != null ? Number(d.inicio) : null;
    let inicioFuente = inicio != null ? (d.inicioFuente || "observada") : null;
    if (inicio == null) {
      const programada = horaProgramadaMs(d.fecha, ruta.horario);
      if (programada != null) {
        inicio = programada;
        inicioFuente = "programada";
        faltantes.push({ campo: "Hora real de inicio", detalle: "No se registró el arranque del viaje; se muestra la hora de salida programada." });
      } else {
        faltantes.push({ campo: "Hora de inicio", detalle: "No se registró el arranque del viaje y no tiene hora de salida programada." });
      }
    }

    const fin = d.fin != null ? Number(d.fin) : null;
    const finFuente = fin != null ? (d.finFuente || "observada") : null;
    if (fin == null) {
      faltantes.push({ campo: "Hora de fin", detalle: "No se registró la hora en que terminó el viaje." });
    } else if (finFuente === "detectada") {
      faltantes.push({ campo: "Hora exacta de fin", detalle: "El viaje ya figuraba como completado al consultarse; se muestra la hora en que se detectó." });
    }

    if (!pedidos.length) faltantes.push({ campo: "Entregas", detalle: "No se encontraron pedidos asociados a la ruta." });

    // Telemetría: sin lecturas no se puede asegurar que estén todos los eventos de manejo.
    const ventanaIni = inicioFuente === "observada" ? inicio : null;
    const lecturas = (d.lecturas || []).map(Number).filter(Number.isFinite);
    const lecturasViaje = inicio != null && fin != null ? lecturas.filter(t => t >= inicio && t <= fin) : lecturas.filter(t => fechaISO(t) === d.fecha);
    const sinSenal = huecosDeSenal(lecturas, ventanaIni != null ? ventanaIni : inicio, fin, d.sinSenalMin);
    if (d.telemetria === false || !lecturasViaje.length) {
      faltantes.push({ campo: "Señal del vehículo", detalle: "No se recibieron lecturas de velocidad durante el viaje; los eventos de manejo pueden estar incompletos." });
    } else {
      sinSenal.forEach(h => faltantes.push({
        campo: "Sin señal", detalle: "Sin lecturas de " + horaCorta(h.desde) + " a " + horaCorta(h.hasta) + "; pueden faltar eventos de ese tramo."
      }));
    }

    const eventos = d.eventos || [];
    return {
      id: "rep-" + ruta.id + "-" + d.fecha,
      ruta_id: String(ruta.id || ""),
      ruta: ruta.nombre || "Ruta sin nombre",
      zona: ruta.zona || "",
      fecha: d.fecha || fechaISO(ahora),
      estado: faltantes.length ? "incompleto" : "completo",
      generado_en: new Date(ahora).toISOString(),
      generado_por: d.manual ? "manual" : "automatico",
      intentos: d.intentos || 1,
      conductor: d.conductor || null,
      vehiculo: d.vehiculo || null,
      hora_inicio: inicio != null ? { valor: new Date(inicio).toISOString(), fuente: inicioFuente } : null,
      hora_fin: fin != null ? { valor: new Date(fin).toISOString(), fuente: finFuente } : null,
      duracion_min: inicio != null && fin != null && fin >= inicio ? Math.round((fin - inicio) / 60000) : null,
      entregas: {
        total: pedidos.length,
        realizadas: pedidos.filter(p => p.estado === "completada"),
        pendientes: pedidos.filter(p => p.estado !== "completada")
      },
      eventos,
      resumen_eventos: {
        velocidad: eventos.filter(e => e.tipo === "exceso_velocidad").length,
        comportamiento: eventos.filter(e => e.tipo !== "exceso_velocidad").length
      },
      faltantes,
      error: null
    };
  }

  // FCJ1-164: reporte cuya generación falló (se conserva lo que se sabe de la ruta para reintentar).
  function reporteFallido(ruta, fecha, mensaje, intentos, ahora) {
    const r = ruta || {};
    return {
      id: "rep-" + r.id + "-" + fecha,
      ruta_id: String(r.id || ""), ruta: r.nombre || "Ruta sin nombre", zona: r.zona || "", fecha,
      estado: "error", generado_en: new Date(ahora || Date.now()).toISOString(), generado_por: "automatico",
      intentos: intentos || 1, conductor: null, vehiculo: null, hora_inicio: null, hora_fin: null, duracion_min: null,
      entregas: { total: 0, realizadas: [], pendientes: [] }, eventos: [], resumen_eventos: { velocidad: 0, comportamiento: 0 },
      faltantes: [], error: mensaje || "No se pudo generar el reporte."
    };
  }

  // Avisos: cuántos reportes requieren atención.
  function resumenAvisos(reportes) {
    const lista = reportes || [];
    return {
      incompletos: lista.filter(r => r.estado === "incompleto").length,
      errores: lista.filter(r => r.estado === "error").length
    };
  }

  // FCJ1-166: filtros del historial
  function errorDeFiltros(f) {
    if (f && f.desde && f.hasta && f.desde > f.hasta) return "La fecha «desde» no puede ser posterior a «hasta».";
    return "";
  }

  function filtrarHistorial(reportes, filtros) {
    const f = filtros || {};
    const q = norm(f.texto);
    return (reportes || []).filter(r =>
      (!f.desde || r.fecha >= f.desde) &&
      (!f.hasta || r.fecha <= f.hasta) &&
      (!f.estado || r.estado === f.estado) &&
      (!q || norm([r.ruta, r.conductor, r.vehiculo, r.zona].join(" ")).includes(q))
    ).sort((a, b) => b.fecha.localeCompare(a.fecha) || String(b.generado_en).localeCompare(String(a.generado_en)));
  }

  /* ============ Almacenamiento (localStorage, con respaldo en memoria) ============ */

  let memoria = { observados: {}, reportes: {}, lecturas: {} };

  function leer() {
    try {
      const dato = JSON.parse(global.localStorage.getItem(CLAVE) || "null");
      if (dato && dato.observados && dato.reportes && dato.lecturas) return dato;
    } catch (error) { /* sin almacenamiento: se usa la memoria de la página */ }
    return memoria;
  }

  function guardar(estado) {
    // Recorte: reportes más recientes y observaciones de los últimos días.
    const ids = Object.keys(estado.reportes).sort((a, b) =>
      String(estado.reportes[b].generado_en).localeCompare(String(estado.reportes[a].generado_en)));
    ids.slice(MAX_REPORTES).forEach(id => { delete estado.reportes[id]; });
    const limite = Date.now() - DIAS_OBSERVACION * 86400000;
    Object.keys(estado.observados).forEach(id => {
      if ((estado.observados[id].visto || 0) < limite) delete estado.observados[id];
    });
    Object.keys(estado.lecturas).forEach(id => {
      estado.lecturas[id] = estado.lecturas[id].filter(t => t >= limite).slice(-MAX_LECTURAS);
      if (!estado.lecturas[id].length) delete estado.lecturas[id];
    });
    memoria = estado;
    try { global.localStorage.setItem(CLAVE, JSON.stringify(estado)); } catch (error) { /* idem */ }
  }

  function eventosConduccion() {
    try {
      const dato = JSON.parse(global.localStorage.getItem(CLAVE_CONDUCCION) || "null");
      return dato && Array.isArray(dato.eventos) ? dato.eventos : [];
    } catch (error) {
      return [];
    }
  }

  // Anota la hora de cada lectura que recibe ConduccionVivo, sin cambiar su comportamiento.
  function engancharConduccion() {
    const cv = global.ConduccionVivo;
    if (!cv || typeof cv.recibirLectura !== "function" || cv.recibirLectura.__reportes) return;
    const original = cv.recibirLectura;
    const envuelta = function (datos) {
      const resultado = original.apply(this, arguments);   // si la lectura no es válida, lanza y no se anota
      const d = datos || {};
      const t = d.fecha ? Date.parse(d.fecha) : Date.now();
      if (d.ruta_id != null && !Number.isNaN(t)) {
        const estado = leer();
        const clave = String(d.ruta_id);
        (estado.lecturas[clave] = estado.lecturas[clave] || []).push(t);
        guardar(estado);
      }
      return resultado;
    };
    envuelta.__reportes = true;
    cv.recibirLectura = envuelta;
  }

  /* ============ FCJ1-163: agregación de los datos del viaje ============ */

  const S = {
    iniciado: false, temporizador: null, revisando: false,
    panel: null, ui: {}, filtros: {}, pagina: 1, mensaje: "", errorRevision: "",
    ultimaRevision: 0, hoy: [], modal: null, toast: null, generando: new Set()
  };

  const esDirector = () => ((global.Api && global.Api.session()) || {}).role === ROL;

  function nombreDe(lista, id, campo) {
    const x = (lista || []).find(e => String(e.id) === String(id));
    return x ? x[campo] || x.nombre || String(id) : null;
  }

  // Conductor y vehículo de una ruta según la disponibilidad del día.
  function asignacionDe(disp, ruta) {
    if (!disp || !Array.isArray(disp.assignments)) return null;
    const a = disp.assignments.find(x => String(x.ruta) === String(ruta.id));
    if (!a) return null;
    return {
      conductor: nombreDe(disp.drivers, a.conductor, "nombre") || a.conductor || null,
      vehiculo: (() => {
        const v = (disp.vehicles || []).find(e => String(e.id) === String(a.vehiculo));
        return v ? [v.placa, v.tipo].filter(Boolean).join(" · ") || String(v.id) : a.vehiculo || null;
      })()
    };
  }

  async function consultarDia(fecha, conRutas) {
    const api = global.Api;
    const [rutas, entregas, disp] = await Promise.allSettled([
      conRutas ? api.post("/rutas/listar", {}) : Promise.resolve(null),
      api.post("/entregas/listar", { fecha }),
      api.post("/disponibilidad/listar", {})
    ]);
    if (rutas.status === "rejected") throw new Error("No se pudieron consultar las rutas: " + rutas.reason.message);
    if (entregas.status === "rejected") throw new Error("No se pudieron consultar las entregas: " + entregas.reason.message);
    if (!entregas.value || !Array.isArray(entregas.value.entregas)) throw new Error("El servicio de entregas devolvió una respuesta no válida.");
    return {
      rutas: rutas.value && Array.isArray(rutas.value.rutas) ? rutas.value.rutas : [],
      entregas: entregas.value.entregas,
      disp: disp.status === "fulfilled" ? disp.value : null,
      dispError: disp.status === "rejected"
    };
  }

  function recopilar(obs, entregas, opciones) {
    const estado = leer();
    const lecturas = (estado.lecturas[obs.ruta.id] || []).concat(estado.lecturas[obs.ruta.nombre] || []);
    const eventos = eventosDelViaje(eventosConduccion(), obs.ruta.nombre, obs.fecha,
      obs.inicioFuente === "observada" ? obs.inicio : null, obs.fin);
    return armarReporte({
      ruta: obs.ruta, fecha: obs.fecha,
      pedidos: pedidosDeRuta(entregas, obs.ruta.nombre),
      conductor: obs.conductor, vehiculo: obs.vehiculo,
      inicio: obs.inicio, inicioFuente: obs.inicioFuente, fin: obs.fin, finFuente: obs.finFuente,
      eventos, lecturas, telemetria: !!global.ConduccionVivo || lecturas.length > 0,
      sinSenalMin: CONFIG.sinSenalMin, ahora: Date.now(),
      intentos: (opciones && opciones.intentos) || 1, manual: !!(opciones && opciones.manual)
    });
  }

  /* ============ FCJ1-162: generación automática ============ */

  async function revisar() {
    if (!esDirector() || S.revisando) return;
    S.revisando = true;
    const ahora = Date.now();
    const fecha = fechaISO(ahora);
    let datos;
    try {
      datos = await consultarDia(fecha, true);
      S.errorRevision = "";
    } catch (error) {
      S.revisando = false;
      if (!global.Api.session()) return;          // sesión cerrada: Api ya redirigió
      S.errorRevision = error.message || "No se pudo revisar el estado de los viajes.";
      pintar();
      return;
    }

    const estado = leer();
    const nuevos = [];
    S.hoy = [];
    datos.rutas.forEach(ruta => {
      const pedidos = pedidosDeRuta(datos.entregas, ruta.nombre);
      const asignacion = asignacionDe(datos.disp, ruta);
      const viaje = estadoViaje(pedidos, !!asignacion || !!ruta.conductor);
      const obs = estado.observados[ruta.id] || (estado.observados[ruta.id] = {
        ruta: {}, fecha, inicio: null, inicioFuente: null, fin: null, finFuente: null, estados: []
      });
      obs.ruta = { id: String(ruta.id), nombre: ruta.nombre, zona: ruta.zona || "", horario: (ruta.viaje && ruta.viaje.horario) || "" };
      obs.fecha = ruta.fecha || fecha;
      obs.visto = ahora;
      if (asignacion && asignacion.conductor) obs.conductor = asignacion.conductor;   // se conserva el último conocido
      if (asignacion && asignacion.vehiculo) obs.vehiculo = asignacion.vehiculo;
      if (viaje === "en_curso" && obs.inicio == null) { obs.inicio = ahora; obs.inicioFuente = "observada"; }
      if (viaje === "completada" && obs.fin == null) {
        const yaEstabaVivo = obs.estados.some(e => e !== "completada");
        obs.fin = ahora;
        obs.finFuente = yaEstabaVivo ? "observada" : "detectada";
      }
      if (obs.estados[obs.estados.length - 1] !== viaje) obs.estados.push(viaje);
      obs.estados = obs.estados.slice(-5);

      const idReporte = "rep-" + ruta.id + "-" + obs.fecha;
      S.hoy.push({ ruta: ruta.nombre, estado: viaje, reporte: estado.reportes[idReporte] || null, id: idReporte });
      if (viaje === "completada" && !estado.reportes[idReporte]) nuevos.push({ obs, idReporte });
    });

    nuevos.forEach(({ obs, idReporte }) => {
      let reporte;
      try {
        reporte = recopilar(obs, datos.entregas);
      } catch (error) {
        reporte = reporteFallido(obs.ruta, obs.fecha, "Falló la generación automática: " + (error.message || error), 1);
      }
      estado.reportes[idReporte] = reporte;
      avisar(reporte);
    });
    guardar(estado);
    S.hoy.forEach(v => { v.reporte = estado.reportes[v.id] || null; });
    S.ultimaRevision = ahora;
    S.revisando = false;
    pintar();
  }

  function iniciar() {
    engancharConduccion();
    if (S.iniciado || !esDirector()) return;
    S.iniciado = true;
    revisar();
    S.temporizador = global.setInterval(() => { if (!global.document.hidden) revisar(); }, CONFIG.revisarSeg * 1000);
    global.document.addEventListener("visibilitychange", () => {
      if (!global.document.hidden && Date.now() - S.ultimaRevision >= CONFIG.revisarSeg * 1000) revisar();
    });
  }

  /* ============ FCJ1-165: reintento manual ============ */

  async function reintentar(id) {
    const estado = leer();
    const previo = estado.reportes[id];
    if (!previo || S.generando.has(id)) return;
    S.generando.add(id);
    pintar();
    if (S.modal) abrirDetalle(id);
    const obs = estado.observados[previo.ruta_id] || {
      ruta: { id: previo.ruta_id, nombre: previo.ruta, zona: previo.zona, horario: "" }, fecha: previo.fecha,
      inicio: previo.hora_inicio && previo.hora_inicio.fuente === "observada" ? Date.parse(previo.hora_inicio.valor) : null,
      inicioFuente: previo.hora_inicio && previo.hora_inicio.fuente === "observada" ? "observada" : null,
      fin: previo.hora_fin ? Date.parse(previo.hora_fin.valor) : null,
      finFuente: previo.hora_fin ? previo.hora_fin.fuente : null,
      conductor: previo.conductor, vehiculo: previo.vehiculo, estados: []
    };
    let reporte;
    try {
      const esHoy = obs.fecha === fechaISO(Date.now());
      const datos = await consultarDia(obs.fecha, esHoy);
      if (esHoy) {
        const ruta = datos.rutas.find(r => String(r.id) === String(obs.ruta.id));
        const asignacion = ruta ? asignacionDe(datos.disp, ruta) : null;
        if (asignacion && asignacion.conductor) obs.conductor = asignacion.conductor;
        if (asignacion && asignacion.vehiculo) obs.vehiculo = asignacion.vehiculo;
      }
      reporte = recopilar(obs, datos.entregas, { intentos: (previo.intentos || 1) + 1, manual: true });
    } catch (error) {
      if (!global.Api.session()) { S.generando.delete(id); return; }
      reporte = reporteFallido(obs.ruta, obs.fecha, error.message || "No se pudo generar el reporte.", (previo.intentos || 1) + 1);
      reporte.generado_por = "manual";
    }
    const actual = leer();
    actual.reportes[id] = reporte;
    if (!actual.observados[obs.ruta.id]) actual.observados[obs.ruta.id] = Object.assign({ visto: Date.now() }, obs);
    guardar(actual);
    S.generando.delete(id);
    S.mensaje = reporte.estado === "completo" ? "El reporte de " + reporte.ruta + " se generó completo."
      : reporte.estado === "incompleto" ? "El reporte de " + reporte.ruta + " se generó, pero sigue incompleto."
      : "No se pudo generar el reporte de " + reporte.ruta + ". " + reporte.error;
    pintar();
    if (S.modal) abrirDetalle(id);
  }

  /* ============ Utilidades de DOM (sin innerHTML para texto: ADR 0001) ============ */

  function h(tag, attrs, ...hijos) {
    const node = global.document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
    });
    hijos.flat().filter(c => c != null && c !== false).forEach(c => {
      node.append(typeof c === "string" || typeof c === "number" ? global.document.createTextNode(String(c)) : c);
    });
    return node;
  }

  function fechaLarga(iso) {
    const d = new Date(String(iso).length === 10 ? iso + "T12:00:00-06:00" : iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("es-SV", { timeZone: ZONA, weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  }

  const horaDe = marca => (marca ? horaCorta(Date.parse(marca.valor)) : "—");
  const fuenteDe = marca => (!marca ? "" : marca.fuente === "programada" ? " (programada)" : marca.fuente === "detectada" ? " (detectada)" : "");
  const duracionTexto = min => (min == null ? "—" : min < 60 ? min + " min" : Math.floor(min / 60) + " h " + (min % 60) + " min");

  /* ============ Avisos (FCJ1-164) ============ */

  function avisar(reporte) {
    if (reporte.estado === "completo") return;
    if (S.toast) S.toast.remove();
    const texto = reporte.estado === "error"
      ? "No se pudo generar el reporte de " + reporte.ruta + "."
      : "El reporte de " + reporte.ruta + " se generó incompleto (" + reporte.faltantes.length + " dato" + (reporte.faltantes.length === 1 ? "" : "s") + " faltante" + (reporte.faltantes.length === 1 ? "" : "s") + ").";
    S.toast = h("div", { class: "rv-toast rv-" + reporte.estado, role: "alert" },
      h("div", {}, h("strong", {}, reporte.estado === "error" ? "Error en reporte de viaje" : "Reporte de viaje incompleto"), h("span", {}, texto)),
      h("div", { class: "rv-toast-acciones" },
        h("button", { type: "button", class: "rv-boton", onclick: () => { cerrarToast(); irAReporte(reporte.id); } }, "Ver reporte"),
        h("button", { type: "button", class: "rv-x", "aria-label": "Cerrar aviso", onclick: cerrarToast }, "×")));
    global.document.body.append(S.toast);
  }

  function cerrarToast() {
    if (S.toast) { S.toast.remove(); S.toast = null; }
  }

  function irAReporte(id) {
    global.dispatchEvent(new CustomEvent("app:navigate", { detail: "reports" }));
    if (global.AppNavigation) global.AppNavigation.setActive("reports");
    abrirDetalle(id);
  }

  /* ============ FCJ1-166: pantalla de historial y detalle ============ */

  function construir() {
    const ui = S.ui;
    ui.desde = h("input", { type: "date", id: "rv-desde" });
    ui.hasta = h("input", { type: "date", id: "rv-hasta" });
    ui.estado = h("select", { id: "rv-estado" }, h("option", { value: "" }, "Todos"),
      Object.entries(ESTADOS_REPORTE).map(([v, t]) => h("option", { value: v }, t)));
    ui.texto = h("input", { type: "search", id: "rv-texto", maxlength: "80", placeholder: "Ruta, conductor, placa" });
    ui.aviso = h("p", { class: "rv-aviso-filtro", role: "alert", hidden: true });
    const campo = (texto, id, control) => h("div", { class: "rv-campo" }, h("label", { for: id }, texto), control);
    const formulario = h("form", { class: "rv-filtros", "aria-label": "Filtros del historial de viajes", onsubmit: buscar },
      campo("Desde", "rv-desde", ui.desde), campo("Hasta", "rv-hasta", ui.hasta),
      campo("Estado del reporte", "rv-estado", ui.estado), campo("Buscar", "rv-texto", ui.texto),
      h("div", { class: "rv-acciones" },
        h("button", { type: "submit", class: "rv-primario" }, "Buscar"),
        h("button", { type: "button", class: "rv-boton", onclick: limpiar }, "Limpiar")),
      ui.aviso);
    ui.estadoRevision = h("p", { class: "rv-muted", role: "status" });
    ui.avisos = h("div", { "aria-live": "polite" });
    ui.hoy = h("section", { class: "rv-hoy", "aria-label": "Viajes de hoy" });
    ui.lista = h("div", { class: "rv-lista" });
    ui.pie = h("nav", { class: "rv-pie", "aria-label": "Páginas del historial" });
    S.panel.replaceChildren(h("div", { class: "rv" },
      h("header", { class: "rv-cabecera" },
        h("p", { class: "rv-muted" }, "Al completarse un viaje su reporte se genera automáticamente en un máximo de " + CONFIG.plazoMin + " minutos."),
        h("div", { class: "rv-acciones" }, ui.estadoRevision,
          h("button", { type: "button", class: "rv-boton", onclick: revisar }, "↻ Revisar ahora"))),
      ui.avisos, ui.hoy, formulario, ui.lista, ui.pie));
  }

  function buscar(evento) {
    if (evento) evento.preventDefault();
    const filtros = { desde: S.ui.desde.value, hasta: S.ui.hasta.value, estado: S.ui.estado.value, texto: S.ui.texto.value.trim() };
    const problema = errorDeFiltros(filtros);
    S.ui.aviso.textContent = problema;
    S.ui.aviso.hidden = !problema;
    if (problema) return;
    S.filtros = filtros;
    S.pagina = 1;
    pintar();
  }

  function limpiar() {
    ["desde", "hasta", "estado", "texto"].forEach(c => { S.ui[c].value = ""; });
    S.ui.aviso.hidden = true;
    S.filtros = {};
    S.pagina = 1;
    pintar();
  }

  const ESTADOS_VIAJE = { sin_asignar: "Sin asignar", asignada: "Asignada", en_curso: "En curso", completada: "Completado" };

  function pintar() {
    if (!S.panel || !S.ui.lista) return;
    const ui = S.ui;
    const reportes = Object.values(leer().reportes);

    ui.estadoRevision.textContent = S.revisando ? "Revisando viajes…"
      : S.ultimaRevision ? "Última revisión " + horaCorta(S.ultimaRevision) + " · cada " + CONFIG.revisarSeg + " s" : "Esperando la primera revisión…";

    // Avisos: error al revisar, mensaje del último reintento y reportes que requieren atención
    const avisos = [];
    if (S.errorRevision) {
      avisos.push(h("div", { class: "rv-banner rv-error", role: "alert" },
        h("div", {}, h("strong", {}, "No se pudo revisar si hay viajes completados"), h("small", {}, S.errorRevision)),
        h("button", { type: "button", class: "rv-boton", onclick: revisar }, "Reintentar")));
    }
    if (S.mensaje) {
      avisos.push(h("div", { class: "rv-banner rv-info", role: "status" }, h("span", {}, S.mensaje),
        h("button", { type: "button", class: "rv-x", "aria-label": "Cerrar mensaje", onclick: () => { S.mensaje = ""; pintar(); } }, "×")));
    }
    const conteo = resumenAvisos(reportes);
    if (conteo.incompletos || conteo.errores) {
      const partes = [];
      if (conteo.errores) partes.push(conteo.errores + " con error de generación");
      if (conteo.incompletos) partes.push(conteo.incompletos + " incompleto" + (conteo.incompletos === 1 ? "" : "s"));
      avisos.push(h("div", { class: "rv-banner " + (conteo.errores ? "rv-error" : "rv-incompleto"), role: "alert" },
        h("div", {}, h("strong", {}, "Reportes que requieren atención: " + partes.join(" y ")),
          h("small", {}, "Abra el reporte para ver qué información falta y reintentar la generación.")),
        h("button", { type: "button", class: "rv-boton", onclick: () => {
          ui.estado.value = conteo.errores ? "error" : "incompleto"; buscar();
        } }, "Ver")));
    }
    ui.avisos.replaceChildren(...avisos);

    // Viajes de hoy y si ya tienen reporte
    if (S.hoy.length) {
      ui.hoy.replaceChildren(h("h3", {}, "Viajes de hoy"), h("ul", { class: "rv-chips" }, S.hoy.map(v => {
        const listo = v.reporte;
        const texto = v.estado === "completada"
          ? (listo ? "Reporte " + ESTADOS_REPORTE[listo.estado].toLowerCase() : "Generando reporte…")
          : ESTADOS_VIAJE[v.estado] || v.estado;
        return h("li", {}, listo
          ? h("button", { type: "button", class: "rv-chip rv-" + listo.estado, onclick: () => abrirDetalle(v.id) }, h("strong", {}, v.ruta), " · " + texto)
          : h("span", { class: "rv-chip" + (v.estado === "en_curso" ? " rv-curso" : "") }, h("strong", {}, v.ruta), " · " + texto));
      })));
    } else {
      ui.hoy.replaceChildren();
    }

    // Historial
    const lista = filtrarHistorial(reportes, S.filtros);
    const paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA));
    S.pagina = Math.min(S.pagina, paginas);
    const visibles = lista.slice((S.pagina - 1) * POR_PAGINA, S.pagina * POR_PAGINA);
    if (!lista.length) {
      const filtrado = Object.values(S.filtros).some(Boolean);
      ui.lista.replaceChildren(h("p", { class: "rv-vacio", role: "status" },
        filtrado ? "No hay reportes con esos filtros." : "Todavía no hay viajes completados con reporte. Aparecerán aquí al completarse."));
    } else {
      ui.lista.replaceChildren(h("div", { class: "rv-scroll" }, h("table", { class: "rv-tabla" },
        h("thead", {}, h("tr", {}, ["Fecha", "Ruta", "Conductor", "Vehículo", "Inicio – Fin", "Entregas", "Eventos", "Reporte", ""].map(t => h("th", { scope: "col" }, t)))),
        h("tbody", {}, visibles.map(r => h("tr", { class: "rv-fila-" + r.estado },
          h("td", {}, fechaLarga(r.fecha)),
          h("td", {}, h("strong", {}, r.ruta), r.zona ? h("small", { class: "rv-sub" }, r.zona) : null),
          h("td", {}, r.conductor || "—"),
          h("td", {}, r.vehiculo || "—"),
          h("td", { class: "rv-num" }, r.hora_inicio || r.hora_fin ? horaDe(r.hora_inicio) + " – " + horaDe(r.hora_fin) : "—"),
          h("td", { class: "rv-num" }, r.estado === "error" ? "—" : r.entregas.realizadas.length + "/" + r.entregas.total),
          h("td", { class: "rv-num" }, r.estado === "error" ? "—" : String(r.eventos.length)),
          h("td", {}, h("span", { class: "rv-pastilla rv-" + r.estado }, S.generando.has(r.id) ? "Generando…" : ESTADOS_REPORTE[r.estado])),
          h("td", {}, h("button", { type: "button", class: "rv-boton", onclick: () => abrirDetalle(r.id) }, "Ver reporte"))))))));
    }
    ui.pie.replaceChildren(...(lista.length > POR_PAGINA ? [
      h("span", {}, lista.length + " viajes"),
      h("div", {},
        h("button", { type: "button", class: "rv-boton", disabled: S.pagina <= 1, onclick: () => { S.pagina -= 1; pintar(); } }, "Anterior"),
        h("span", {}, "Página " + S.pagina + " de " + paginas),
        h("button", { type: "button", class: "rv-boton", disabled: S.pagina >= paginas, onclick: () => { S.pagina += 1; pintar(); } }, "Siguiente"))
    ] : []));
  }

  function cerrarDetalle() {
    if (S.modal) { S.modal.remove(); S.modal = null; }
    global.document.removeEventListener("keydown", alTeclear);
  }

  function alTeclear(evento) {
    if (evento.key === "Escape") cerrarDetalle();
  }

  function abrirDetalle(id) {
    const r = leer().reportes[id];
    cerrarDetalle();
    if (!r) return;
    const generando = S.generando.has(id);
    const puedeReintentar = r.estado !== "completo";
    const botonReintento = puedeReintentar
      ? h("button", { type: "button", class: "rv-primario", disabled: generando, onclick: () => reintentar(id) }, generando ? "Generando…" : "↻ Reintentar generación")
      : null;

    const secciones = [];
    if (r.estado === "error") {
      secciones.push(h("div", { class: "rv-banner rv-error", role: "alert" },
        h("div", {}, h("strong", {}, "No se pudo generar el reporte"), h("small", {}, r.error)), botonReintento));
    } else {
      if (r.faltantes.length) {
        secciones.push(h("div", { class: "rv-banner rv-incompleto", role: "alert" },
          h("div", {}, h("strong", {}, "Reporte incompleto: falta información"),
            h("ul", { class: "rv-faltantes" }, r.faltantes.map(f => h("li", {}, h("strong", {}, f.campo + ": "), f.detalle)))),
          botonReintento));
      }
      secciones.push(
        h("h4", {}, "Datos del viaje"),
        h("dl", { class: "rv-datos" }, [
          ["Conductor", r.conductor || "No disponible"],
          ["Vehículo", r.vehiculo || "No disponible"],
          ["Fecha", fechaLarga(r.fecha)],
          ["Hora de inicio", horaDe(r.hora_inicio) + fuenteDe(r.hora_inicio)],
          ["Hora de fin", horaDe(r.hora_fin) + fuenteDe(r.hora_fin)],
          ["Duración", duracionTexto(r.duracion_min)]
        ].flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
        h("h4", {}, "Entregas · " + r.entregas.realizadas.length + " realizadas, " + r.entregas.pendientes.length + " pendientes"),
        r.entregas.total ? h("div", { class: "rv-scroll" }, h("table", { class: "rv-tabla rv-tabla-chica" },
          h("thead", {}, h("tr", {}, ["Hora", "Cliente", "Dirección", "Estado"].map(t => h("th", { scope: "col" }, t)))),
          h("tbody", {}, r.entregas.realizadas.concat(r.entregas.pendientes).map(p => h("tr", {},
            h("td", { class: "rv-num" }, p.hora), h("td", {}, p.cliente), h("td", {}, p.direccion),
            h("td", {}, h("span", { class: "rv-pastilla " + (p.estado === "completada" ? "rv-completo" : "rv-incompleto") },
              p.estado === "completada" ? "Realizada" : "Pendiente")))))))
          : h("p", { class: "rv-vacio" }, "Sin entregas registradas para esta ruta."),
        h("h4", {}, "Eventos de velocidad y comportamiento · " + r.resumen_eventos.velocidad + " de velocidad, " + r.resumen_eventos.comportamiento + " de conducta"),
        r.eventos.length ? h("div", { class: "rv-scroll" }, h("table", { class: "rv-tabla rv-tabla-chica" },
          h("thead", {}, h("tr", {}, ["Hora", "Evento", "Velocidad", "Ubicación"].map(t => h("th", { scope: "col" }, t)))),
          h("tbody", {}, r.eventos.map(e => h("tr", {},
            h("td", { class: "rv-num" }, horaCorta(Date.parse(e.fecha))),
            h("td", {}, h("span", { class: "rv-pastilla " + (e.tipo === "exceso_velocidad" ? "rv-error" : "rv-incompleto") }, e.tipo_etiqueta)),
            h("td", { class: "rv-num" }, e.velocidad_kmh == null ? "—" : Math.round(e.velocidad_kmh) + " km/h" + (e.limite_kmh ? " (límite " + Math.round(e.limite_kmh) + ")" : "")),
            h("td", { class: "rv-num" }, e.lat == null || e.lng == null ? "—" : e.lat.toFixed(5) + ", " + e.lng.toFixed(5)))))))
          : h("p", { class: "rv-vacio" }, "No se registraron excesos de velocidad ni conductas de riesgo durante el viaje."));
    }

    S.modal = h("div", { class: "rv-fondo", onclick: e => { if (e.target === S.modal) cerrarDetalle(); } },
      h("section", { class: "rv-modal rv-borde-" + r.estado, role: "dialog", "aria-modal": "true", "aria-labelledby": "rv-titulo" },
        h("button", { type: "button", class: "rv-cerrar", "aria-label": "Cerrar", onclick: cerrarDetalle }, "×"),
        h("span", { class: "rv-kicker" }, "REPORTE DE VIAJE"),
        h("h3", { id: "rv-titulo" }, r.ruta, " ", h("span", { class: "rv-pastilla rv-" + r.estado }, ESTADOS_REPORTE[r.estado])),
        h("p", { class: "rv-muted" }, "Generado " + (r.generado_por === "manual" ? "por reintento manual" : "automáticamente") +
          " el " + fechaLarga(r.generado_en) + " a las " + horaCorta(Date.parse(r.generado_en)) +
          (r.intentos > 1 ? " · intento " + r.intentos : "") + " · Solo lectura"),
        secciones));
    global.document.body.append(S.modal);
    global.document.addEventListener("keydown", alTeclear);
    const foco = S.modal.querySelector(".rv-cerrar");
    if (foco) foco.focus();
  }

  /* ============ API pública ============ */

  function mount(contenedor) {
    if (!contenedor) throw new Error("No se encontró el contenedor de reportes de viaje.");
    if (!esDirector()) {
      contenedor.textContent = "Los reportes de viaje son solo para el director de rutas.";
      return { reload() {} };
    }
    if (S.panel !== contenedor) {
      S.panel = contenedor;
      construir();
    }
    iniciar();
    pintar();
    return { reload: revisar };
  }

  global.ReportesViaje = {
    mount, iniciar, revisar, reintentar, abrir: abrirDetalle, config: CONFIG,
    util: {
      norm, fechaISO, estadoViaje, pedidosDeRuta, horaProgramadaMs, huecosDeSenal, eventosDelViaje,
      armarReporte, reporteFallido, resumenAvisos, errorDeFiltros, filtrarHistorial, ESTADOS_REPORTE
    }
  };
})(window);
