(function () {
  "use strict";

  const CENTER = [13.6929, -89.2182];
  const OSRM_URL = "https://router.project-osrm.org/route/v1/driving/";
  const COLORS = { alta: "#ff4d55", media: "#ff9e45", baja: "#2494ff" };
  const $ = id => document.getElementById(id);
  const sessionKey = "session";
  let session = null;
  let map = null;
  let origin = CENTER.slice();
  let routeLayers = null;
  let eventLayers = null;
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
  let availabilityModule = null;
  let assignmentModule = null;
  let lastRefreshAt = 0;
  let lastRouteInput = null;
  let lastRiskInput = null;

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

  function apiUrl(path) {
    return (session.apiBase || location.origin).replace(/\/$/, "") + path;
  }

  async function post(path, payload) {
    const response = await fetch(apiUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.token },
      body: JSON.stringify(payload)
    });
    let result = {};
    try {
      result = await response.json();
    } catch (error) {
      result = {};
    }
    if (response.status === 401) {
      window.AppNavigation.handleUnauthorized();
      throw new Error("La sesión venció. Inicia sesión de nuevo.");
    }
    if (!response.ok) {
      const detail = result.detail;
      const message = detail && typeof detail === "object" ? detail.message : detail;
      throw new Error(message || "Error al consultar el servidor (" + response.status + ").");
    }
    return result;
  }

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
  }

  async function loadDeliveries() {
    const response = await post("/entregas/listar", { fecha: todayISO() });
    if (!response || !Array.isArray(response.entregas)) {
      throw new Error("El servicio de entregas devolvió una respuesta no válida.");
    }
    deliveries = response.entregas;
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

  function riskForRoute(route) {
    const line = route.geometry.coordinates;
    let score = 0;
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
      }
    });
    return score;
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
      throw new Error("OSRM no encontró una ruta por calles entre las paradas.");
    }
    const candidates = rawRoutes.filter(route =>
      route.geometry && Array.isArray(route.geometry.coordinates) && route.geometry.coordinates.length > 1 &&
      route.geometry.coordinates.every(point => Array.isArray(point) && validCoordinates(point[1], point[0])) &&
      Number.isFinite(route.distance) && Number.isFinite(route.duration));
    if (!candidates.length) throw new Error("El servicio de rutas devolvió geometría incompleta.");
    return candidates.map(route => ({
      raw: route,
      distanceKm: route.distance / 1000,
      durationMin: route.duration / 60,
      riskScore: riskForRoute(route),
      geometry: route.geometry.coordinates.map(([lng, lat]) => [lat, lng])
    })).sort((first, second) =>
      (first.riskScore * 250 + first.durationMin + first.distanceKm) -
      (second.riskScore * 250 + second.durationMin + second.distanceKm))
      .map((route, index) => Object.assign(route, {
        name: index === 0 ? "Ruta recomendada" : "Alternativa " + index
      }));
  }

  function dailyStops() {
    return deliveries.filter(hasLocation).map(delivery => ({
      name: delivery.cliente || delivery.direccion || "Destino diario",
      detail: delivery.direccion || "",
      time: delivery.hora || "",
      lat: Number(delivery.lat),
      lng: Number(delivery.lng)
    }));
  }

  function routeInputSignature() {
    return JSON.stringify([origin, manualStops || dailyStops()]);
  }

  function riskInputSignature() {
    return JSON.stringify(mapEvents.map(event => [
      event.id, event.severity, event.date, event.lat, event.lng, event.radius_m
    ]));
  }

  async function requestRoutes(stops) {
    const coordinates = [origin, ...stops.map(stop => [stop.lat, stop.lng])]
      .map(([lat, lng]) => lng + "," + lat).join(";");
    const query = new URLSearchParams({
      overview: "full",
      geometries: "geojson",
      alternatives: "true",
      steps: "true"
    });
    const response = await fetch(OSRM_URL + coordinates + "?" + query.toString());
    if (!response.ok) throw new Error("El servicio público de rutas respondió con HTTP " + response.status + ".");
    const data = await response.json();
    if (data.code !== "Ok") throw new Error(data.message || "OSRM no pudo calcular la ruta (" + data.code + ").");
    return normalizeRoutes(data.routes);
  }

  function drawRoutes(stops) {
    routeLayers.clearLayers();
    $("stops").replaceChildren();
    const options = $("routeOptions");
    options.replaceChildren();
    const bounds = [];
    routeChoices.forEach((choice, index) => {
      const selected = index === selectedRoute;
      const line = L.polyline(choice.geometry, {
        color: selected ? "#3cc8b4" : "#7c8d9a",
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
    const originMarker = L.marker(origin, {
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
      const item = element("li", "", (index + 1) + ". " + stop.name);
      if (stop.time) item.append(element("small", "", stop.time));
      item.addEventListener("click", () => {
        map.setView([stop.lat, stop.lng], 15);
        marker.openPopup();
      });
      $("stops").append(item);
    });
    const combined = bounds.reduce((result, bound) => result.extend(bound), L.latLngBounds([]));
    if (combined.isValid()) map.fitBounds(combined, { padding: [35, 35], maxZoom: 15 });
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

  async function calculateRoute() {
    $("noRoute").classList.add("hidden");
    $("routeMessage").classList.add("hidden");
    $("stops").replaceChildren();
    $("routeOptions").replaceChildren();
    try {
      const missing = manualStops ? [] : deliveries.filter(delivery => !hasLocation(delivery));
      const stops = manualStops || dailyStops();
      if (!stops.length) {
        throw new Error(deliveries.length ?
          "Los destinos de hoy no tienen coordenadas guardadas. Añádelas en Supabase para calcular la ruta diaria." :
          "No hay destinos programados para hoy.");
      }
      $("routeTitle").textContent = manualStops ? "Ruta personalizada" : "Ruta del día";
      if (missing.length) {
        $("routeMessage").textContent = missing.length + " destino(s) no se incluirán porque faltan coordenadas. Actualiza lat y lng en Supabase.";
        $("routeMessage").classList.remove("hidden");
      }
      routeChoices = await requestRoutes(stops);
      selectedRoute = 0;
      updateRouteMetrics(routeChoices[selectedRoute]);
      drawRoutes(stops);
      return true;
    } catch (error) {
      routeChoices = [];
      routeLayers.clearLayers();
      $("mDist").textContent = "–";
      $("mEta").textContent = "–";
      $("mRisk").textContent = "–";
      $("noRoute").textContent = error.message || "No se pudo calcular una ruta. Revisa tu conexión e inténtalo de nuevo.";
      $("noRoute").classList.remove("hidden");
      return false;
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
       onCount: count => {
         const badge = $("notifCount");
         badge.textContent = count > 99 ? "99+" : String(count);
         badge.classList.toggle("hidden", count === 0);
       }
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

  function mountAssignmentPanel() {
    if (assignmentModule) return;
    assignmentModule = window.Disponibilidad.mount($("routeAssignment"), {
      view: "assignment",
      showHeader: false,
      showHistory: false,
      LOAD: "/disponibilidad/listar",
      ASSIGN: "/disponibilidad/asignar",
      ROLE_ALLOWED: "coordinador_rutas",
      onUnauthorized: () => window.AppNavigation.handleUnauthorized()
    });
  }

  function setMonitorTab(name) {
    monitorTab = ["alerts", "notifications"].includes(name) ? name : "events";
    $("monitorNotifs").classList.toggle("hidden", monitorTab !== "notifications");
    $("monitorEvents").classList.toggle("hidden", monitorTab !== "events");
    $("monitorAlerts").classList.toggle("hidden", monitorTab !== "alerts");
    document.querySelectorAll("[data-monitor-panel]").forEach(button => {
      button.setAttribute("aria-selected", String(button.dataset.monitorPanel === monitorTab));
    });
    if (monitorTab === "notifications") mountNotificationsPanel();
    else if (monitorTab === "events") mountEventPanel();
    else mountAlertPanel();
  }

  function setScreen(name) {
    const screen = ["routes", "monitor", "daily"].includes(name) ? name : "routes";
    currentScreen = screen;
    $("routesScreen").classList.toggle("hidden", screen !== "routes");
    $("monitorScreen").classList.toggle("hidden", screen !== "monitor");
    $("dailyScreen").classList.toggle("hidden", screen !== "daily");
    const headings = {
      routes: ["PLANIFICACIÓN OPERATIVA", "Asignar Rutas", "Configure y despache unidades de forma segura."],
      monitor: ["CENTRO DE CONTROL", "Monitoreo en Vivo", "Consulte eventos especiales e incidentes de seguridad."],
      daily: ["GESTIÓN OPERATIVA", "Empleados y Vehículos", "Revise disponibilidad y asignaciones del día."]
    };
    const [eyebrow, title, description] = headings[screen];
    $("pageEyebrow").textContent = eyebrow;
    $("pageTitle").textContent = title;
    $("pageDescription").textContent = description;
    window.AppNavigation.setActive(screen);
    if (screen === "routes") {
      mountAssignmentPanel();
      if (map) setTimeout(() => map.invalidateSize(), 50);
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
    [eventModule, alertModule, availabilityModule, assignmentModule].forEach(module => {
      if (module && typeof module.reload === "function") module.reload();
    });
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
    mountAssignmentPanel();
    mountNotificationsPanel();
    window.RoutePlanner.mount($("multiRoute"), { onCalculate: calculateCustomRoute, onReset: resetCustomRoute });
    window.addEventListener("app:navigate", event => setScreen(event.detail));
    document.querySelectorAll("[data-monitor-panel]").forEach(button => {
      button.addEventListener("click", () => setMonitorTab(button.dataset.monitorPanel));
    });
    $("refresh").addEventListener("click", refreshDashboard);
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
    setScreen(location.hash === "#monitoreo" ? "monitor" : location.hash === "#personal" ? "daily" : "routes");
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
