(function (global) {
  "use strict";

  const $ = id => global.document.getElementById(id);
  const MAX_DIAS = 365;
  const MSG_RANGO_INVALIDO = "Por favor, seleccione un rango de fechas válido";
  const MSG_RANGO_MAXIMO = "El rango máximo para consulta en tiempo real es de 365 días. Por favor, ajuste el filtro o exporte el reporte histórico";
  let inicializado = false;

  function mostrarMensaje(texto, error) {
    const mensaje = $("metricsMessage");
    mensaje.textContent = texto;
    mensaje.classList.toggle("is-error", Boolean(error));
  }

  function marcarCampo(campo, invalido) {
    campo.classList.toggle("is-invalid", invalido);
    if (invalido) campo.setAttribute("aria-invalid", "true");
    else campo.removeAttribute("aria-invalid");
  }

  function validar() {
    const desde = $("metricsStart");
    const hasta = $("metricsEnd");
    const start = desde.value ? Date.parse(desde.value + "T00:00:00Z") : NaN;
    const end = hasta.value ? Date.parse(hasta.value + "T00:00:00Z") : NaN;
    const camposValidos = Number.isFinite(start) && Number.isFinite(end) &&
      new Date(start).toISOString().slice(0, 10) === desde.value &&
      new Date(end).toISOString().slice(0, 10) === hasta.value && end >= start;
    marcarCampo(desde, !desde.value || !camposValidos);
    marcarCampo(hasta, !hasta.value || !camposValidos);
    if (!camposValidos) {
      mostrarMensaje(MSG_RANGO_INVALIDO, true);
      return false;
    }
    const dias = Math.floor((end - start) / 86400000) + 1;
    if (dias > MAX_DIAS) {
      marcarCampo(desde, true);
      marcarCampo(hasta, true);
      mostrarMensaje(MSG_RANGO_MAXIMO, true);
      return false;
    }
    return true;
  }

  function crear(tag, clase, texto) {
    const nodo = global.document.createElement(tag);
    if (clase) nodo.className = clase;
    if (texto != null) nodo.textContent = texto;
    return nodo;
  }

  function renderizarEventos(eventos) {
    const cuerpo = $("metricsEvents");
    cuerpo.replaceChildren();
    const puedeEditar = ["coordinador_rutas", "supervisor", "administrador"]
      .includes(String((global.Api.session() || {}).role || "").toLowerCase());
    if (!eventos.length) {
      const fila = crear("tr", "metrics-empty");
      const celda = crear("td", "", "No hay eventos de riesgo en el rango seleccionado.");
      celda.colSpan = 4;
      fila.append(celda);
      cuerpo.append(fila);
      return;
    }

    eventos.forEach(evento => {
      const fila = crear("tr");
      fila.append(crear("td", "", evento.nombre));
      const fecha = evento.inicio ? new Date(evento.inicio).toLocaleString() : "Sin fecha";
      fila.append(crear("td", "", fecha));
      const estado = evento.estado_metrica || "sin_confirmar";
      const etiqueta = {
        sin_confirmar: "Sin confirmar",
        mitigado: "Mitigado antes del despacho",
        ocurrido: "Ocurrió",
      }[estado] || "Sin confirmar";
      fila.append(crear("td", "metrics-status metrics-status-" + estado, etiqueta));
      const acciones = crear("td", "metrics-actions");
      if (!puedeEditar) {
        acciones.append(crear("small", "metrics-permission-note", "Permisos insuficientes"));
      }
      ["mitigado", "ocurrido"].forEach(nuevoEstado => {
        const boton = crear("button", "secondary-button metrics-state-button",
          nuevoEstado === "mitigado" ? "Marcar mitigado" : "Marcar ocurrido");
        boton.type = "button";
        boton.disabled = !puedeEditar || estado === nuevoEstado;
        if (!puedeEditar) boton.title = "Permisos insuficientes";
        boton.setAttribute("aria-label", puedeEditar ? boton.textContent + ": " + evento.nombre : "Permisos insuficientes");
        boton.addEventListener("click", () => actualizarEstado(evento.id, nuevoEstado));
        acciones.append(boton);
      });
      fila.append(acciones);
      cuerpo.append(fila);
    });
  }

  function renderizar(datos) {
    const rutas = datos.rutas;
    const entregas = datos.entregas;
    $("metricsAiPercent").textContent = rutas.porcentaje_ia == null ? "—" : rutas.porcentaje_ia + "%";
    $("metricsRouteCounts").textContent = rutas.total_clasificadas
      ? rutas.optimizadas_ia + " IA · " + rutas.manuales + " manuales"
      : "Sin rutas clasificadas en este rango";
    $("metricsAvoided").textContent = String(datos.incidentes_evitados);
    $("metricsDeliveryTime").textContent = entregas.promedio_minutos == null
      ? "—" : entregas.promedio_minutos + " min";
    $("metricsDeliveryCount").textContent = entregas.contabilizadas
      ? "Promedio de " + entregas.contabilizadas + " entregas con tiempos registrados"
      : "Sin entregas con tiempos reales registrados";

    const chart = $("metricsRouteChart");
    chart.replaceChildren();
    const max = Math.max(rutas.optimizadas_ia, rutas.manuales, 1);
    [
      ["Rutas IA", rutas.optimizadas_ia, "metrics-bar-ia"],
      ["Manuales", rutas.manuales, "metrics-bar-manual"],
    ].forEach(([label, valor, clase]) => {
      const fila = crear("div", "metrics-bar-row");
      fila.append(crear("span", "metrics-bar-label", label));
      const track = crear("div", "metrics-bar-track");
      const barra = crear("div", "metrics-bar " + clase);
      barra.style.width = (valor / max * 100) + "%";
      barra.setAttribute("aria-hidden", "true");
      track.append(barra);
      fila.append(track, crear("strong", "metrics-bar-value", String(valor)));
      chart.append(fila);
    });
    chart.setAttribute("aria-label",
      rutas.optimizadas_ia + " rutas optimizadas por IA y " + rutas.manuales + " rutas manuales");
    $("metricsUnclassified").textContent = rutas.sin_clasificar
      ? rutas.sin_clasificar + " rutas históricas sin método registrado se excluyen del porcentaje."
      : "";
    renderizarEventos(datos.eventos);
    $("metricsResults").hidden = false;
  }

  async function consultar() {
    const inicio = $("metricsStart").value;
    const fin = $("metricsEnd").value;
    if (!validar()) return;
    const boton = $("metricsApply");
    boton.disabled = true;
    mostrarMensaje("Consultando métricas…", false);
    try {
      const datos = await global.Api.post("/metricas/consultar", { inicio, fin });
      renderizar(datos);
      mostrarMensaje("Métricas actualizadas para el rango seleccionado.", false);
    } catch (error) {
      mostrarMensaje(error.message || "No se pudieron cargar las métricas.", true);
    } finally {
      boton.disabled = false;
    }
  }

  async function actualizarEstado(eventoId, estado) {
    const botones = $("metricsEvents").querySelectorAll("button");
    botones.forEach(boton => { boton.disabled = true; });
    mostrarMensaje("Guardando cambio de estado…", false);
    try {
      await global.Api.post("/metricas/estado-incidente", { evento_id: eventoId, estado });
      await consultar();
    } catch (error) {
      mostrarMensaje(error.message || "No se pudo actualizar el estado del evento.", true);
      botones.forEach(boton => { boton.disabled = false; });
    }
  }

  function init() {
    if (inicializado) return;
    inicializado = true;
    $("metricsForm").addEventListener("submit", event => {
      event.preventDefault();
      consultar();
    });
    [$("metricsStart"), $("metricsEnd")].forEach(campo => {
      campo.addEventListener("input", () => marcarCampo(campo, false));
    });
  }

  global.MetricasDashboard = { init };
})(window);
