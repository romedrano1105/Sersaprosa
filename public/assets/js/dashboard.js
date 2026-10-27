(function () {
  "use strict";

  const CENTER = [13.6929, -89.2182];
  const COLORS = { alta: "#e5484d", media: "#f5a524", baja: "#5b8cff" };
  const REROUTE_DISTANCE_METERS = 60;
  const REROUTE_COOLDOWN_MS = 30000;
  const $ = id => document.getElementById(id);
  const sessionKey = "session";
  let session = null;
  let map = null;
  let origin = CENTER.slice();
  let routeLayers = null;
  let eventLayers = null;
  let liveLayers = null;
  let agentLayer = null;     // ruta que recomienda el agente de seguridad
  let deliveries = [];
  let manualStops = null; // paradas del planificador multi-paradas; null = ruta del día
  let mapEvents = [];
  let routeChoices = [];
  let selectedRoute = 0;
  let refreshing = false;
  let currentScreen = "routes";
  let monitorTab = "notifications";
  let eventModule = null;
  let alertModule = null;
  let notificationsModule = null;
  let incidentsModule = null;
  let historyModule = null;
  let availabilityModule = null;
  let ordersModule = null;
  let recalcTimer = null;
  let centroModule = null;   // centro de control de rutas (centroRutas.js)
  let notifData = null;      // última respuesta de notificaciones (para las alertas de la ruta)
  let searchMarker = null;   // marcador de la búsqueda de direcciones del mapa
  let stopMarkers = [];      // marcadores de las paradas trazadas, en orden
  const ORDER_KEY = "ordenVisita";
  let lastRefreshAt = 0;
  let lastRouteInput = null;
  let lastRiskInput = null;
  let liveWatchId = null;
  let liveMarker = null;
  let livePosition = null;
  let lastRerouteAt = 0;
  let rerouting = false;
  let firstLivePosition = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function todayISO() {
    const date = new Date();
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 10);
  }

  function storedSession() {
    try {
      return JSON.parse(sessionStorage.getItem(sessionKey) || "null");
    } catch (error) {
      return null;
    }
  }

  // Llamadas al backend: núcleo compartido (core/api.js), con token y manejo de sesión vencida.
  const post = (path, payload) => window.Api.post(path, payload);

  function validCoordinates(lat, lng) {
    const latitude = Number(lat);
    const longitude = Number(lng);
    return Number.isFinite(latitude) && Number.isFinite(longitude) &&
      Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  }

  function hasLocation(item) {
    return item && item.lat != null && item.lng != null && validCoordinates(item.lat, item.lng);
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Fecha desconocida" :
      date.toLocaleString("es-SV", { dateStyle: "short", timeStyle: "short" });
  }

  function initMap() {
    map = L.map("map").setView(CENTER, 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19
    }).addTo(map);
    routeLayers = L.layerGroup().addTo(map);
    eventLayers = L.layerGroup().addTo(map);
    liveLayers = L.layerGroup().addTo(map);
    agentLayer = L.layerGroup().addTo(map);
  }

  // Barra del mapa: estilo de calles, capa de eventos de riesgo y búsqueda de direcciones.
  function mountMapToolbar() {
    $("mapStyle").addEventListener("change", event => {
      $("map").classList.toggle("map-dark", event.target.value === "oscuro");
    });
    $("mapEventsToggle").addEventListener("change", event => {
      if (!eventLayers) return;
      if (event.target.checked) eventLayers.addTo(map); else map.removeLayer(eventLayers);
    });
    $("agentBtn").addEventListener("click", evaluateSafety);
    $("mapSearch").addEventListener("submit", async event => {
      event.preventDefault();
      const text = $("mapSearchInput").value.trim();
      const message = $("mapSearchMsg");
      if (text.length < 3) return;
      message.classList.add("hidden");
      try {
        const place = await geocodePoint({ text });
        map.setView([place.lat, place.lng], 16);
        if (searchMarker) map.removeLayer(searchMarker);
        searchMarker = L.marker([place.lat, place.lng]).addTo(map);
        searchMarker.bindPopup(element("div", "", place.label || text)).openPopup();
      } catch (error) {
        message.textContent = error.message || "No se encontró esa dirección.";
        message.classList.remove("hidden");
      }
    });
  }

  // ---- Agente de rutas seguras: POST /agente/ruta-segura (inicio → última parada trazada) ----
  function clearAgent() {
    if (agentLayer) agentLayer.clearLayers();
    $("agentPanel").classList.add("hidden");
  }

  function showAgent(kind, title, lines, warnings) {
    const panel = $("agentPanel");
    const close = element("button", "agent-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Cerrar evaluación");
    close.addEventListener("click", clearAgent);
    panel.className = "agent-panel" + (kind ? " is-" + kind : "");
    panel.replaceChildren(close, element("h3", "", title));
    lines.forEach(line => panel.append(element("p", "", line)));
    if (warnings && warnings.length) {
      const list = element("ul", "agent-warn");
      warnings.forEach(text => list.append(element("li", "", text)));
      panel.append(list);
    }
  }

  // Dibuja la ruta óptima del agente (verde) y su justificación; sirve para el botón y para «Generar ruta».
  function drawAgentReport(report) {
    const chosen = report.ruta_elegida;
    agentLayer.clearLayers();
    const points = (chosen.geometria || []).map(point => [point[0], point[1]]);
    if (points.length > 1) {
      const line = L.polyline(points, { color: "#3ec27a", weight: 5, opacity: 0.95, dashArray: "9 8" }).addTo(agentLayer);
      map.fitBounds(line.getBounds(), { padding: [35, 35], maxZoom: 15 });
    }
    const risky = chosen.vetada;
    const resume = chosen.distancia_km + " km · " + Math.round(chosen.duracion_min_ajustada) + " min" +
      (chosen.desvio ? " · desvío para evitar riesgo" : "");
    const warnings = (report.advertencias || []).slice();
    (report.riesgos_residuales || []).forEach(text => warnings.push("Riesgo residual: " + text));
    showAgent(risky ? "risk" : "", risky ? "Todas las rutas tienen riesgo alto" : "Ruta óptima de la IA",
      [resume, report.justificacion], warnings);
  }

  async function evaluateSafety() {
    const stops = manualStops || dailyStops();
    if (!stops.length) {
      showAgent("error", "No hay ruta que evaluar", ["Elige pedidos con coordenadas o calcula una ruta primero."]);
      return;
    }
    const last = stops[stops.length - 1];
    const button = $("agentBtn");
    button.disabled = true;
    showAgent("", "Evaluando seguridad…", ["Consultando incidentes, eventos y zonas de riesgo."]);
    try {
      const report = await post("/agente/ruta-segura", {
        origen: { lat: routeOrigin()[0], lng: routeOrigin()[1] },
        destino: { lat: last.lat, lng: last.lng },
        usar_llm: $("agentLlm").checked
      });
      drawAgentReport(report);
    } catch (error) {
      agentLayer.clearLayers();
      showAgent("error", "No se pudo evaluar la seguridad", [error.message || "Inténtalo de nuevo."]);
    }
    button.disabled = false;
  }

  async function loadDeliveries() {
    const response = await post("/entregas/listar", { fecha: todayISO() });
    if (!response || !Array.isArray(response.entregas)) {
      throw new Error("El servicio de entregas devolvió una respuesta no válida.");
    }
    deliveries = response.entregas;
    if (ordersModule) ordersModule.setData(deliveries);
    pushCentro();
  }

  async function loadEvents() {
    const records = [];
    const messages = [];
    try {
      const response = await post("/eventos/listar", {});
      if (!response || !Array.isArray(response.events)) {
        throw new Error("El servicio de eventos devolvió una respuesta no válida.");
      }
      response.events.forEach(event => records.push({
        id: "evento-" + event.id,
        name: event.nombre || "Evento sin nombre",
        type: event.tipo || "Evento especial",
        severity: event.impacto === "alto" ? "alta" : event.impacto === "medio" ? "media" : event.impacto || "baja",
        date: event.inicio,
        source: event.fuente || "",
        lat: event.lat,
        lng: event.lng,
        radius_m: event.radius_m || 350
      }));
    } catch (error) {
      if (error.message.includes("403") || error.message.toLowerCase().includes("solo para el coordinador")) {
        messages.push("Los eventos especiales solo están disponibles para el coordinador de rutas.");
      } else {
        messages.push("No se pudieron cargar los eventos especiales: " + error.message);
      }
    }

    if (session.role === "coordinador_rutas") {
      try {
        const response = await post("/alertas/listar", { page: 1, page_size: 100 });
        if (!response || !Array.isArray(response.items)) {
          throw new Error("El servicio de alertas devolvió una respuesta no válida.");
        }
        response.items.forEach(alert => records.push({
          id: "alerta-" + alert.id,
          name: alert.descripcion || alert.tipo || "Incidente reportado",
          type: alert.tipo || "Incidente",
          severity: alert.severidad || "baja",
          date: alert.fecha,
          source: "Alerta de viaje",
          lat: alert.lat,
          lng: alert.lng,
          radius_m: 250
        }));
      } catch (error) {
        messages.push("No se pudieron cargar los incidentes registrados: " + error.message);
      }
    }
    mapEvents = records.filter(record => record.date);
    drawEvents();
    return messages.length === 0;
  }

  function eventColor(item) {
    return COLORS[item.severity] || COLORS.baja;
  }

  function drawEvents() {
    if (!eventLayers) return;
    eventLayers.clearLayers();
    mapEvents.forEach(item => {
      const color = eventColor(item);
      if (hasLocation(item)) {
        const marker = L.circle([Number(item.lat), Number(item.lng)], {
          radius: Math.max(50, Number(item.radius_m) || 300),
          color,
          fillColor: color,
          fillOpacity: 0.2,
          weight: 2
        }).addTo(eventLayers);
        const popup = element("div", "", item.name);
        popup.append(element("small", "", item.type + " · " + formatDate(item.date)));
        marker.bindPopup(popup);
      }
    });
  }

  function pointSegmentDistanceMeters(point, start, end) {
    const latScale = 111320;
    const lonScale = Math.cos(point[1] * Math.PI / 180) * 111320;
    const px = (point[0] - start[0]) * lonScale;
    const py = (point[1] - start[1]) * latScale;
    const dx = (end[0] - start[0]) * lonScale;
    const dy = (end[1] - start[1]) * latScale;
    const length = dx * dx + dy * dy;
    const fraction = length ? Math.max(0, Math.min(1, (px * dx + py * dy) / length)) : 0;
    return Math.hypot(px - fraction * dx, py - fraction * dy);
  }

  // Puntaje de riesgo del recorrido y los eventos que lo cruzan (dentro de su radio).
  function routeRiskDetail(route) {
    const line = route.geometry.coordinates;
    let score = 0;
    const events = [];
    mapEvents.filter(event => hasLocation(event)).forEach(event => {
      const center = [Number(event.lng), Number(event.lat)];
      let closest = Infinity;
      for (let index = 1; index < line.length; index += 1) {
        closest = Math.min(closest, pointSegmentDistanceMeters(center, line[index - 1], line[index]));
      }
      const radius = Math.max(50, Number(event.radius_m) || 300);
      if (closest <= radius) {
        const weight = event.severity === "alta" ? 5 : event.severity === "media" ? 2 : 1;
        score += weight * (1 - closest / radius);
        events.push(event);
      }
    });
    return { score, events };
  }

  function riskForRoute(route) {
    return routeRiskDetail(route).score;
  }

  function riskLabel(score) {
    return score >= 4 ? "alto" : score >= 1.5 ? "medio" : "bajo";
  }

  function updateRouteMetrics(route) {
    $("mDist").textContent = route.distanceKm.toFixed(1) + " km";
    $("mEta").textContent = Math.round(route.durationMin) + " min";
    $("mRisk").textContent = riskLabel(route.riskScore);
  }

  function normalizeRoutes(rawRoutes) {
    if (!Array.isArray(rawRoutes) || rawRoutes.length === 0) {
      throw new Error("No se encontró una ruta por calles entre las paradas.");
    }
    const candidates = rawRoutes.filter(route =>
      route.geometry && Array.isArray(route.geometry.coordinates) && route.geometry.coordinates.length > 1 &&
      route.geometry.coordinates.every(point => Array.isArray(point) && validCoordinates(point[1], point[0])) &&
      Number.isFinite(route.distance) && Number.isFinite(route.duration));
    if (!candidates.length) throw new Error("El servicio de rutas devolvió geometría incompleta.");
    return candidates.map(route => {
      const risk = routeRiskDetail(route);
      return {
        raw: route,
        distanceKm: route.distance / 1000,
        durationMin: route.duration / 60,
        riskScore: risk.score,
        riskEvents: risk.events,
        geometry: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
        steps: Array.isArray(route.steps) ? route.steps : []
      };
    }).sort((first, second) =>
      (first.riskScore * 250 + first.durationMin + first.distanceKm) -
      (second.riskScore * 250 + second.durationMin + second.distanceKm))
      .map((route, index) => Object.assign(route, {
        name: index === 0 ? "Ruta recomendada" : "Alternativa " + index
      }));
  }

  // Pedidos en curso que se eligieron para la ruta (por defecto, todos los que están en curso).
  function selectedOrders() {
    return window.Pedidos.store.effective(deliveries);
  }

  // Las rutas generadas con «Nuevo viaje» traen su propio origen y destino.
  function routeOrigin() {
    if (liveWatchId !== null && livePosition) return livePosition;
    const trip = (currentRoute() || {}).viaje;
    return trip && !manualStops ? [Number(trip.origen.lat), Number(trip.origen.lng)] : origin;
  }

  function currentRoute() {
    return centroModule ? centroModule.activeRoute : null;
  }

  // Orden de visita guardado en este navegador, por ruta (invertir / optimizar).
  function visitOrderKey() {
    const route = currentRoute();
    return route ? "r:" + route.id : "borrador";
  }

  function readVisitOrder() {
    try {
      const all = JSON.parse(sessionStorage.getItem(ORDER_KEY) || "{}");
      return Array.isArray(all[visitOrderKey()]) ? all[visitOrderKey()] : null;
    } catch (error) {
      return null;
    }
  }

  function saveVisitOrder(ids) {
    try {
      const all = JSON.parse(sessionStorage.getItem(ORDER_KEY) || "{}");
      all[visitOrderKey()] = ids;
      sessionStorage.setItem(ORDER_KEY, JSON.stringify(all));
    } catch (error) { /* sin almacenamiento: el orden vale solo hasta recargar */ }
  }

  // Todos los pedidos que muestra la lista, en orden de visita: los de la ruta guardada o, en borrador, los elegidos.
  function routeAllOrders() {
    const util = window.CentroRutas.util;
    const route = currentRoute();
    return util.aplicarOrden(route ? util.pedidosDeRuta(deliveries, route) : selectedOrders(), readVisitOrder());
  }

  // Los que realmente se trazan: en curso y con coordenadas.
  function tracedOrders() {
    return routeAllOrders().filter(order => window.Pedidos.enCurso(order) && hasLocation(order));
  }

  function dailyStops() {
    const stops = tracedOrders().map(delivery => ({
      id: String(delivery.id),
      name: delivery.cliente || delivery.direccion || "Destino diario",
      detail: delivery.direccion || "",
      time: delivery.hora || "",
      lat: Number(delivery.lat),
      lng: Number(delivery.lng)
    }));
    const trip = (currentRoute() || {}).viaje;
    if (trip) {
      stops.push({
        id: "destino",
        name: "Destino: " + trip.destino.texto,
        detail: trip.destino.texto,
        time: trip.horario || "",
        lat: Number(trip.destino.lat),
        lng: Number(trip.destino.lng)
      });
    }
    return stops;
  }

  function routeInputSignature() {
    return JSON.stringify([liveWatchId !== null ? "live" : routeOrigin(), manualStops || dailyStops()]);
  }

  function riskInputSignature() {
    return JSON.stringify(mapEvents.map(event => [
      event.id, event.severity, event.date, event.lat, event.lng, event.radius_m
    ]));
  }

  async function requestRoutes(stops) {
    const data = await post("/rutas/calcular", {
      coordinates: [routeOrigin(), ...stops.map(stop => [stop.lat, stop.lng])]
    });
    if (!data || !Array.isArray(data.routes)) {
      throw new Error("El servicio de rutas devolvió una respuesta no válida.");
    }
    $("providerLabel").textContent = data.provider || "Proveedor de rutas";
    if (data.cached) $("providerLabel").textContent += " · caché";
    const warnings = [];
    if (!$("routeMessage").classList.contains("hidden")) warnings.push($("routeMessage").textContent);
    if (data.hazards_missing_location) {
      warnings.push(data.hazards_missing_location + " evento(s) de riesgo no tienen coordenadas y no pueden evitarse.");
    }
    $("routeMessage").textContent = warnings.filter(Boolean).join(" ");
    $("routeMessage").classList.toggle("hidden", warnings.length === 0);
    return normalizeRoutes(data.routes);
  }

  function drawRoutes(stops, fitMap = true) {
    routeLayers.clearLayers();
    stopMarkers = [];
    const options = $("routeOptions");
    options.replaceChildren();
    const bounds = [];
    routeChoices.forEach((choice, index) => {
      const selected = index === selectedRoute;
      const line = L.polyline(choice.geometry, {
        color: selected ? "#f2873b" : "#7c8d9a",
        weight: selected ? 6 : 3,
        opacity: selected ? 0.95 : 0.55
      }).addTo(routeLayers);
      bounds.push(line.getBounds());
      const button = element("button", "route-option");
      button.type = "button";
      button.setAttribute("aria-pressed", String(selected));
      button.append(element("strong", "", choice.name));
      button.append(element("small", "", choice.distanceKm.toFixed(1) + " km · " +
        Math.round(choice.durationMin) + " min · Riesgo " + riskLabel(choice.riskScore)));
      button.addEventListener("click", () => {
        selectedRoute = index;
        updateRouteMetrics(choice);
        drawRoutes(stops);
      });
      options.append(button);
    });
    const originMarker = L.marker(routeOrigin(), {
      icon: L.divIcon({
        className: "route-stop-icon",
        html: element("span", "route-stop-marker route-origin-marker", "A"),
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      })
    }).addTo(routeLayers);
    originMarker.bindPopup(element("div", "", "Inicio de la ruta"));
    stops.forEach((stop, index) => {
      const marker = L.marker([stop.lat, stop.lng], {
        icon: L.divIcon({
          className: "route-stop-icon",
          html: element("span", "route-stop-marker", String(index + 1)),
          iconSize: [28, 28],
          iconAnchor: [14, 14]
        })
      }).addTo(routeLayers);
      const popup = element("div", "", (index + 1) + ". " + stop.name);
      if (stop.detail) popup.append(element("small", "", stop.detail));
      marker.bindPopup(popup);
      stopMarkers.push({ marker, lat: stop.lat, lng: stop.lng });
    });
    if (fitMap) {
      const combined = bounds.reduce((result, bound) => result.extend(bound), L.latLngBounds([]));
      if (combined.isValid()) map.fitBounds(combined, { padding: [35, 35], maxZoom: 15 });
    }
  }

  async function geocodePoint(point) {
    if (point.place) return point.place;
    const data = await post("/rutas/geocodificar", { query: point.text.trim() });
    if (!data || !validCoordinates(data.lat, data.lng)) {
      throw new Error("El servicio de direcciones devolvió una respuesta no válida.");
    }
    point.place = { lat: Number(data.lat), lng: Number(data.lng), label: data.label || point.text.trim() };
    return point.place;
  }

  // Recibe el arreglo [origen, ...paradas, destino] de routePlanner.js, resuelve coordenadas
  // y reutiliza el mismo cálculo y dibujo que la ruta del día.
  async function calculateCustomRoute(points) {
    const places = [];
    for (const point of points) {
      try {
        places.push(await geocodePoint(point));
      } catch (error) {
        throw new Error("«" + point.text.trim() + "»: " + error.message);
      }
    }
    origin = [places[0].lat, places[0].lng];
    $("originLabel").textContent = points[0].text.trim();
    manualStops = places.slice(1).map((place, index) => ({
      name: points[index + 1].text.trim(),
      detail: place.label,
      time: index === places.length - 2 ? "Destino final" : "",
      lat: place.lat,
      lng: place.lng
    }));
    if (!await calculateRoute()) throw new Error($("noRoute").textContent);
    lastRouteInput = routeInputSignature();
    lastRiskInput = riskInputSignature();
  }

  function resetCustomRoute() {
    manualStops = null;
    origin = CENTER.slice();
    $("originLabel").textContent = "Centro de San Salvador";
    refreshDashboard();
  }

  // ---- Guardar la ruta trazada (paso 2 → 3 del flujo): queda disponible para asignarle personal ----
  function routeOrderIds() {
    return manualStops || currentRoute() ? [] : tracedOrders().map(order => String(order.id));
  }

  function suggestedRouteName() {
    const now = new Date();
    return "Ruta " + now.toLocaleDateString("es-SV", { day: "2-digit", month: "2-digit" }) + " " +
      now.toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit" });
  }

  // Solo se ofrece guardar cuando hay una ruta trazada a partir de pedidos elegidos (no la personalizada).
  function updateSaveRoute() {
    const available = !manualStops && !currentRoute() && routeChoices.length > 0 && routeOrderIds().length > 0;
    $("saveRoute").classList.toggle("hidden", !available);
    if (available && !$("saveRouteName").value) $("saveRouteName").value = suggestedRouteName();
  }

  // Botón «Guardar ruta» del encabezado: lleva a la barra de guardado y pone el cursor en el nombre.
  function focusSaveRoute() {
    updateSaveRoute();
    const bar = $("saveRoute");
    if (bar.classList.contains("hidden")) return;
    bar.scrollIntoView({ behavior: "smooth", block: "nearest" });
    $("saveRouteName").focus();
    $("saveRouteName").select();
  }

  async function saveRoute() {
    const button = $("saveRouteBtn");
    const message = $("saveRouteMsg");
    button.disabled = true;
    message.classList.add("hidden");
    try {
      const result = await post("/rutas/guardar", { nombre: $("saveRouteName").value, pedidos: routeOrderIds() });
      message.textContent = "Ruta «" + result.nombre + "» guardada con " + result.entregas + " pedido(s). " +
        "Ya puedes asignarle conductor, guardias y vehículo en Empleados y Vehículos.";
      $("saveRouteName").value = "";
      await loadDeliveries().catch(() => {});
      if (availabilityModule) availabilityModule.reload();
      await centroModule.refresh();
      const saved = centroModule.findRoute(String(result.id));
      if (saved) await selectRoute(saved); // pasa a la ruta guardada para poder asignarla de inmediato
    } catch (error) {
      message.textContent = error.message;
    }
    message.classList.remove("hidden");
    button.disabled = false;
  }

  async function calculateRoute(options = {}) {
    clearAgent();
    $("noRoute").classList.add("hidden");
    $("routeMessage").classList.add("hidden");
    $("routeOptions").replaceChildren();
    try {
      const route = currentRoute();
      const chosen = manualStops ? [] : routeAllOrders().filter(window.Pedidos.enCurso);
      const missing = chosen.filter(delivery => !hasLocation(delivery));
      const stops = manualStops || dailyStops();
      if (!stops.length) {
        throw new Error(
          route ? (chosen.length ? "Los pedidos pendientes de esta ruta no tienen coordenadas guardadas." :
            "Esta ruta no tiene pedidos pendientes por trazar.") :
          !deliveries.some(window.Pedidos.enCurso) ? "No hay pedidos en curso para hoy." :
          !chosen.length ? "Elige al menos un pedido en curso para calcular la ruta." :
          "Los pedidos elegidos no tienen coordenadas guardadas. Añádelas en Supabase para trazar la ruta.");
      }
      $("routeTitle").textContent = manualStops ? "Ruta personalizada" : route ? route.nombre : "Ruta de pedidos (" + stops.length + ")";
      if (missing.length) {
        $("routeMessage").textContent = missing.length + " pedido(s) elegidos no se incluirán porque faltan coordenadas. Actualiza lat y lng en Supabase.";
        $("routeMessage").classList.remove("hidden");
      }
      routeChoices = await requestRoutes(stops);
      selectedRoute = 0;
      updateRouteMetrics(routeChoices[selectedRoute]);
      drawRoutes(stops, options.fitMap !== false);
      updateSaveRoute();
      pushCentro();
      return true;
    } catch (error) {
      routeChoices = [];
      updateSaveRoute();
      stopMarkers = [];
      routeLayers.clearLayers();
      pushCentro();
      $("mDist").textContent = "–";
      $("mEta").textContent = "–";
      $("mRisk").textContent = "–";
      $("noRoute").textContent = error.message || "No se pudo calcular una ruta. Revisa tu conexión e inténtalo de nuevo.";
      $("noRoute").classList.remove("hidden");
      return false;
    }
  }

  function distanceToCurrentRoute(position, route) {
    if (!route || route.geometry.length < 2) return Infinity;
    const point = [position[1], position[0]];
    let closest = Infinity;
    for (let index = 1; index < route.geometry.length; index += 1) {
      const start = [route.geometry[index - 1][1], route.geometry[index - 1][0]];
      const end = [route.geometry[index][1], route.geometry[index][0]];
      closest = Math.min(closest, pointSegmentDistanceMeters(point, start, end));
    }
    return closest;
  }

  async function onLivePosition(position) {
    livePosition = [position.coords.latitude, position.coords.longitude];
    if (!liveMarker) {
      liveMarker = L.circleMarker(livePosition, {
        radius: 8, color: "#ffffff", weight: 2, fillColor: "#2688ff", fillOpacity: 1
      }).addTo(liveLayers);
    } else {
      liveMarker.setLatLng(livePosition);
    }
    if (position.coords.accuracy > 150) {
      $("trackingStatus").textContent = "GPS impreciso (" +
        Math.round(position.coords.accuracy) + " m); esperando una ubicación más precisa.";
      return;
    }
    if (!firstLivePosition) {
      firstLivePosition = true;
      $("originLabel").textContent = "Ubicación en vivo";
      lastRerouteAt = Date.now();
      rerouting = true;
      $("trackingStatus").textContent = "Ubicación recibida. Calculando ruta desde tu posición…";
      const ok = await calculateRoute({ fitMap: false });
      rerouting = false;
      $("trackingStatus").textContent = ok ?
        "Seguimiento activo. La ruta se recalculará si te desvías." :
        "Seguimiento activo, pero no se pudo calcular la ruta.";
      return;
    }
    const distance = distanceToCurrentRoute(livePosition, routeChoices[selectedRoute]);
    if (distance > REROUTE_DISTANCE_METERS &&
        Date.now() - lastRerouteAt >= REROUTE_COOLDOWN_MS && !rerouting) {
      lastRerouteAt = Date.now();
      rerouting = true;
      $("trackingStatus").textContent = "Desvío de " + Math.round(distance) +
        " m detectado. Recalculando la ruta…";
      const ok = await calculateRoute({ fitMap: false });
      rerouting = false;
      $("trackingStatus").textContent = ok ?
        "Ruta actualizada. Seguimiento activo." :
        "Se detectó un desvío, pero no se pudo calcular una ruta segura.";
    }
  }

  function stopLiveTracking(status = "Seguimiento detenido.") {
    if (liveWatchId !== null) navigator.geolocation.clearWatch(liveWatchId);
    if (livePosition) origin = livePosition.slice();
    liveWatchId = null;
    firstLivePosition = false;
    $("trackRoute").textContent = "Iniciar seguimiento en vivo";
    $("trackingStatus").textContent = status;
  }

  function startLiveTracking() {
    if (!navigator.geolocation) {
      $("trackingStatus").textContent = "Este navegador no permite obtener la ubicación actual.";
      return;
    }
    $("trackRoute").disabled = true;
    try {
      liveWatchId = navigator.geolocation.watchPosition(position => {
        $("trackRoute").disabled = false;
        onLivePosition(position).catch(error => {
          console.error(error);
          $("trackingStatus").textContent = "No se pudo actualizar la ruta: " + error.message;
        });
      }, error => {
        $("trackRoute").disabled = false;
        const message = error.code === error.PERMISSION_DENIED ?
          "No se concedió permiso para usar la ubicación." :
          "No se pudo obtener la ubicación. Revisa los permisos y vuelve a intentarlo.";
        if (error.code === error.PERMISSION_DENIED) stopLiveTracking(message);
        else $("trackingStatus").textContent = message;
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
      $("trackRoute").textContent = "Detener seguimiento";
      $("trackingStatus").textContent = "Esperando ubicación GPS…";
    } catch (error) {
      $("trackRoute").disabled = false;
      $("trackingStatus").textContent = "No se pudo iniciar el GPS: " + error.message;
    }
  }

  function mountEventPanel() {
    if (eventModule) return;
    eventModule = window.EventosEspeciales.mount($("panelEventos"), {
      LOAD: "/eventos/listar",
      REVIEW: "/eventos/revisar",
      CREATE: "/eventos/registrar",
      onUnauthorized: () => window.AppNavigation.handleUnauthorized()
    });
  }

  function mountAlertPanel() {
    if (alertModule) return;
    alertModule = window.AlertasSeguridad.mount($("panelAlertas"));
  }

     function mountNotificationsPanel() {
     if (notificationsModule) return;
     notificationsModule = window.Notificaciones.mount($("panelNotificaciones"), {
       SYNC: "/notificaciones/sincronizar",
       LOAD: "/notificaciones/listar",
       READ: "/notificaciones/leer",
       ROLE_ALLOWED: "coordinador_rutas",
       onUnauthorized: () => window.AppNavigation.handleUnauthorized(),
       onData: data => { notifData = data; pushCentro(); },
       onCount: count => {
         const badge = $("notifCount");
         badge.textContent = count > 99 ? "99+" : String(count);
         badge.classList.toggle("hidden", count === 0);
       }
     });
   }

  // Incidentes en curso (FCJ1-10 / FCJ1-30): arranca al iniciar sesión para que el contador y los avisos funcionen
  // aunque no se esté en esa pestaña.
  function startIncidents() {
    if (!window.IncidentesViaje) return;
    window.IncidentesViaje.iniciar({
      onCount: count => {
        const badge = $("incCount");
        badge.textContent = count > 99 ? "99+" : String(count);
        badge.classList.toggle("hidden", count === 0);
      }
    });
  }

  function mountIncidentsPanel() {
    if (incidentsModule) return;
    incidentsModule = window.IncidentesViaje.mount($("panelIncidentes"));
  }

  // Historial de incidentes (FCJ1-22): se recarga cada vez que se abre la pestaña.
  function mountHistoryPanel() {
    historyModule = window.HistorialIncidentes.mount($("panelHistorialIncidentes"));
  }

  // ---- Centro de control de rutas (centroRutas.js) ----
  // Le entrega lo último que calculó este archivo: pedidos en orden de visita, el recorrido elegido y las alertas.
  function pushCentro() {
    if (!centroModule) return;
    const choice = routeChoices[selectedRoute] || null;
    centroModule.update({
      deliveries,
      orders: routeAllOrders(),
      result: choice,
      manual: Boolean(manualStops),
      originLabel: $("originLabel").textContent,
      events: choice ? choice.riskEvents.filter(event => event.severity === "alta" || event.severity === "media") : [],
      notifs: notifData
    });
  }

  async function recalcAndRemember() {
    if (await calculateRoute()) {
      lastRouteInput = routeInputSignature();
      lastRiskInput = riskInputSignature();
    }
  }

  // Elegir una ruta guardada (o null = nueva ruta en borrador). Deja la ruta personalizada, si había una.
  function selectRoute(route) {
    manualStops = null;
    centroModule.setActive(route ? route.id : null);
    $("originLabel").textContent = route && route.viaje ? route.viaje.origen.texto : "Centro de San Salvador";
    $("saveRouteName").value = "";
    return recalcAndRemember();
  }

  // Invertir u optimizar el orden de visita de los pedidos que se trazan; se recuerda por ruta en este navegador.
  function reorderStops(kind) {
    const traced = tracedOrders();
    if (traced.length < 2) return;
    const util = window.CentroRutas.util;
    const ordered = kind === "reverse" ? traced.slice().reverse() : util.ordenarVecinoCercano(routeOrigin(), traced);
    saveVisitOrder(ordered.map(order => String(order.id)));
    return recalcAndRemember();
  }

  function focusStop(index) {
    const stop = stopMarkers[index];
    if (!stop) return;
    map.setView([stop.lat, stop.lng], 15);
    stop.marker.openPopup();
  }

  // ---- Viajes: «+» (Nuevo viaje) y edición antes de que la ruta salga ----
  function openTrip(mode, route) {
    const traced = tracedOrders().map(order => String(order.id));
    window.Viajes.abrir({
      modo: mode,
      ruta: route || null,
      pedidos: { ids: traced, eleccion: window.Pedidos.store.get() !== null && traced.length > 0 },
      post,
      get: path => window.Api.get(path),
      onSaved: onTripSaved
    });
  }

  // Tras generar o editar: se recarga todo, se abre la ruta y se dibuja la ruta óptima de la IA.
  async function onTripSaved(result) {
    await loadDeliveries().catch(() => {});
    if (availabilityModule) availabilityModule.reload();
    await centroModule.refresh();
    const saved = centroModule.findRoute(String(result.ruta.id));
    if (saved) await selectRoute(saved);
    if (result.evaluacion && result.evaluacion.ruta_elegida) drawAgentReport(result.evaluacion);
    $("noRoute").classList.add("hidden");
  }

  // Tras asignar, desasignar o editar una ruta: se recargan pedidos y personal, y se vuelve a trazar.
  async function afterRouteChange() {
    await loadDeliveries().catch(() => {});
    if (availabilityModule) availabilityModule.reload();
    await recalcAndRemember();
  }

  // Pedidos en curso: la pantalla completa y el selector de "Planificar rutas" comparten la misma elección.
  function mountOrderModules() {
    if (ordersModule) return;
    ordersModule = window.Pedidos.mountPage($("panelPedidos"), { onGoRoutes: () => setScreen("routes") });
    ordersModule.setData(deliveries);
    // Al cambiar la elección se vuelve a trazar la ruta (con una pequeña espera para agrupar clics seguidos).
    window.Pedidos.store.subscribe(() => {
      if (manualStops || currentRoute()) return;
      pushCentro(); // la lista refleja la casilla al instante; el trazado se recalcula enseguida
      clearTimeout(recalcTimer);
      recalcTimer = setTimeout(recalcAndRemember, 500);
    });
  }

  function mountAvailabilityPanel() {
    if (availabilityModule) return;
    availabilityModule = window.Disponibilidad.mount($("panelDisponibilidad"), {
      view: "resources",
      showHeader: false,
      LOAD: "/disponibilidad/listar",
      ASSIGN: "/disponibilidad/asignar",
      ROLE_ALLOWED: "coordinador_rutas",
      onUnauthorized: () => window.AppNavigation.handleUnauthorized()
    });
  }

  // Pestañas de Monitoreo en Vivo: nombre → panel de la página.
  const MONITOR_PANELS = {
    notifications: "monitorNotifs", events: "monitorEvents", alerts: "monitorAlerts",
    incidents: "monitorIncidents", history: "monitorHistory"
  };

  function setMonitorTab(name) {
    monitorTab = Object.prototype.hasOwnProperty.call(MONITOR_PANELS, name) ? name : "events";
    Object.entries(MONITOR_PANELS).forEach(([tab, panelId]) => {
      $(panelId).classList.toggle("hidden", monitorTab !== tab);
    });
    document.querySelectorAll("[data-monitor-panel]").forEach(button => {
      button.setAttribute("aria-selected", String(button.dataset.monitorPanel === monitorTab));
    });
    if (monitorTab === "notifications") mountNotificationsPanel();
    else if (monitorTab === "events") mountEventPanel();
    else if (monitorTab === "alerts") mountAlertPanel();
    else if (monitorTab === "incidents") mountIncidentsPanel();
    else mountHistoryPanel();
  }

  function setScreen(name) {
    const allowed = (window.Api.session() || {}).role === "coordinador_rutas" ? ["routes", "orders", "monitor", "daily", "risk"] : ["routes", "orders", "monitor", "daily"];
    const screen = allowed.includes(name) ? name : "routes";
    currentScreen = screen;
    $("routesScreen").classList.toggle("hidden", screen !== "routes");
    $("ordersScreen").classList.toggle("hidden", screen !== "orders");
    $("riskScreen").classList.toggle("hidden", screen !== "risk");
    $("monitorScreen").classList.toggle("hidden", screen !== "monitor");
    $("dailyScreen").classList.toggle("hidden", screen !== "daily");
    const headings = {
      routes: ["SEGUIMIENTO DE RUTAS", "Tracking de rutas", "Cree un viaje con «+», vea la ruta óptima de la IA y siga cada pedido."],
      orders: ["SEGUIMIENTO DE ENTREGAS", "Pedidos en curso", "Pedidos del día que faltan por entregar; elija cuáles van en la ruta."],
      risk: ["ANÁLISIS DE CARGA", "Riesgo de rutas", "Registre monto y tipo de carga; el nivel de riesgo se calcula solo."],
      monitor: ["CENTRO DE CONTROL", "Monitoreo en Vivo", "Consulte eventos especiales e incidentes de seguridad."],
      daily: ["GESTIÓN OPERATIVA", "Empleados y Vehículos", "Revise disponibilidad y asignaciones del día."]
    };
    const [eyebrow, title, description] = headings[screen];
    $("pageEyebrow").textContent = eyebrow;
    $("pageTitle").textContent = title;
    $("pageDescription").textContent = description;
    window.AppNavigation.setActive(screen);
    if (screen === "routes") {
      if (map) setTimeout(() => map.invalidateSize(), 50);
    } else if (screen === "risk") {
      if (window.RiesgoRutas) window.RiesgoRutas.reload();
    } else if (screen === "orders") {
      mountOrderModules();
    } else if (screen === "monitor") {
      setMonitorTab(monitorTab);
    } else {
      mountAvailabilityPanel();
    }
  }

  function setConnectionStatus(message, hasError) {
    const status = $("connectionStatus");
    status.querySelector("span").textContent = message;
    status.classList.toggle("is-error", Boolean(hasError));
  }

  async function refreshDashboard() {
    if (refreshing) return;
    refreshing = true;
    $("refresh").disabled = true;
    setConnectionStatus("Actualizando", false);
    const results = await Promise.allSettled([loadDeliveries(), loadEvents()]);
    [eventModule, alertModule, availabilityModule].forEach(module => {
      if (module && typeof module.reload === "function") module.reload();
    });
    if (centroModule) centroModule.refresh();
    const deliveriesResult = results[0];
    const eventsResult = results[1];
    let routeOk = false;
    if (deliveriesResult.status === "fulfilled") {
      const routeInput = routeInputSignature();
      const riskInput = riskInputSignature();
      const routeNeedsUpdate = !routeChoices.length ||
        routeInput !== lastRouteInput || riskInput !== lastRiskInput;
      routeOk = routeNeedsUpdate ? await calculateRoute() : true;
      if (routeOk) {
        lastRouteInput = routeInput;
        lastRiskInput = riskInput;
      }
    } else {
      $("routeMessage").textContent = "No se pudieron actualizar los destinos: " +
        deliveriesResult.reason.message + (routeChoices.length ? " Se conserva la ruta anterior." : "");
      $("routeMessage").classList.remove("hidden");
    }
    lastRefreshAt = Date.now();
    $("lastUpdated").textContent = "Actualizado " +
      new Date(lastRefreshAt).toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit" });
    const eventsOk = eventsResult.status === "fulfilled" && eventsResult.value;
    const synced = routeOk && eventsOk;
    setConnectionStatus(synced ? "Sistema en línea" : "Revisar sincronización", !synced);
    refreshing = false;
    $("refresh").disabled = false;
  }

  async function start() {
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    if (!window.AppNavigation.mount()) return;
    if (!window.L) {
      $("noRoute").textContent = "No se pudo cargar el mapa. Revisa tu conexión e inténtalo de nuevo.";
      $("noRoute").classList.remove("hidden");
      setConnectionStatus("Mapa no disponible", true);
      return;
    }
    initMap();
    setTimeout(() => map.invalidateSize(), 50);
    centroModule = window.CentroRutas.mount($("centroRutas"), {
      taskContainer: $("taskList"),
      post,
      onSelectRoute: selectRoute,
      onReorder: reorderStops,
      onFocusStop: focusStop,
      selection: window.Pedidos.store,
      originNode: $("originRow"),
      onSave: focusSaveRoute,
      onNewTrip: () => openTrip("nuevo"),
      onEditTrip: route => openTrip("editar", route),
      onGoTo: name => setScreen(name),
      onChanged: afterRouteChange
    });
    mountMapToolbar();
    mountOrderModules();
    mountNotificationsPanel();
    startIncidents();
    window.RoutePlanner.mount($("multiRoute"), { onCalculate: calculateCustomRoute, onReset: resetCustomRoute });
    window.addEventListener("app:navigate", event => setScreen(event.detail));
    document.querySelectorAll("[data-monitor-panel]").forEach(button => {
      button.addEventListener("click", () => setMonitorTab(button.dataset.monitorPanel));
    });
    $("refresh").addEventListener("click", refreshDashboard);
    $("saveRouteBtn").addEventListener("click", saveRoute);
    $("trackRoute").addEventListener("click", () => {
      if (liveWatchId !== null) stopLiveTracking();
      else startLiveTracking();
    });
    $("locate").addEventListener("click", () => {
      if (!navigator.geolocation) {
        $("routeMessage").textContent = "Este navegador no permite obtener la ubicación actual.";
        $("routeMessage").classList.remove("hidden");
        return;
      }
      $("locate").disabled = true;
      navigator.geolocation.getCurrentPosition(async position => {
        origin = [position.coords.latitude, position.coords.longitude];
        $("originLabel").textContent = "Ubicación actual";
        await refreshDashboard();
        $("locate").disabled = false;
      }, error => {
        const message = error.code === error.PERMISSION_DENIED ?
          "No se concedió permiso para usar la ubicación. Puedes continuar desde el centro de San Salvador." :
          "No se pudo obtener la ubicación. Revisa los permisos y vuelve a intentarlo.";
        $("routeMessage").textContent = message;
        $("routeMessage").classList.remove("hidden");
        $("locate").disabled = false;
      }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
    });
    setScreen(location.hash === "#monitoreo" ? "monitor" : location.hash === "#personal" ? "daily" :
      location.hash === "#pedidos" ? "orders" : location.hash === "#riesgo" ? "risk" : "routes");
    await refreshDashboard();
    window.setInterval(() => {
      if (!document.hidden) refreshDashboard();
    }, 120000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && Date.now() - lastRefreshAt >= 120000) refreshDashboard();
    });
  }

  $("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    $("err").textContent = "";
    $("loginBtn").disabled = true;
    try {
      const code = $("code").value.trim();
      const password = $("pass").value;
      const response = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, password })
      });
      const result = await response.json();
      if (!response.ok) {
        const detail = result.detail;
        throw new Error(detail && typeof detail === "object" ? detail.message : detail || "No fue posible iniciar sesión.");
      }
      if (!result.token) throw new Error("El servidor de autenticación no devolvió una sesión válida.");
      session = {
        token: result.token,
        name: result.name || code,
        code,
        role: result.role || "",
        apiBase: location.origin
      };
      sessionStorage.setItem(sessionKey, JSON.stringify(session));
      $("pass").value = "";
      await start();
    } catch (error) {
      $("err").textContent = error.message || "No fue posible iniciar sesión.";
    } finally {
      $("loginBtn").disabled = false;
    }
  });

  session = storedSession();
  if (session && session.token) start();
})();
