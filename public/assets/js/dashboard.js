(function () {
  "use strict";

  const CENTER = [13.6929, -89.2182];
  const COLORS = { alta: "#e5533d", media: "#f2b544", baja: "#7fb2e5" };
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
  let deliveries = [];
  let mapEvents = [];
  let routeChoices = [];
  let selectedRoute = 0;
  let refreshing = false;
  let lastRefreshAt = 0;
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
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 20
    }).addTo(map);
    routeLayers = L.layerGroup().addTo(map);
    eventLayers = L.layerGroup().addTo(map);
    liveLayers = L.layerGroup().addTo(map);
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
    $("eventsMessage").textContent = messages.join(" ");
    $("eventsMessage").classList.toggle("hidden", messages.length === 0);
    drawEvents();
    return messages.length === 0;
  }

  function eventColor(item) {
    return COLORS[item.severity] || COLORS.baja;
  }

  function drawEvents() {
    if (!eventLayers) return;
    eventLayers.clearLayers();
    const list = $("eventsList");
    list.replaceChildren();
    const severity = $("eventSeverity").value;
    const from = $("eventFrom").value;
    const to = $("eventTo").value;
    const shown = mapEvents.filter(item => {
      const day = String(item.date).slice(0, 10);
      return (!severity || item.severity === severity) && (!from || day >= from) && (!to || day <= to);
    });
    if (!shown.length) {
      list.append(element("p", "empty", "No hay eventos que coincidan con estos filtros."));
      return;
    }
    shown.forEach(item => {
      const color = eventColor(item);
      let marker = null;
      if (hasLocation(item)) {
        marker = L.circle([Number(item.lat), Number(item.lng)], {
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
      const row = element("article", "event-item");
      const dot = element("span", "dot");
      dot.style.backgroundColor = color;
      row.append(dot, element("strong", "", item.name),
        element("small", "", item.type + " · " + item.severity + " · " + formatDate(item.date)));
      if (item.source) row.append(element("small", "", item.source));
      row.addEventListener("click", () => {
        if (marker) {
          map.setView([Number(item.lat), Number(item.lng)], 15);
          marker.openPopup();
        }
      });
      list.append(row);
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
      throw new Error("No se encontró una ruta por calles entre las paradas.");
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
      geometry: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      steps: Array.isArray(route.steps) ? route.steps : []
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

  async function requestRoutes(stops) {
    const data = await post("/rutas/calcular", {
      coordinates: [origin, ...stops.map(stop => [stop.lat, stop.lng])]
    });
    if (!data || !Array.isArray(data.routes)) {
      throw new Error("El servicio de rutas devolvió una respuesta no válida.");
    }
    $("providerLabel").textContent = data.provider + (data.cached ? " · caché" : "");
    const routeMessage = [];
    if (data.hazards_missing_location) {
      routeMessage.push(data.hazards_missing_location +
        " evento(s) de severidad alta o media no tienen coordenadas y no pueden excluirse.");
    }
    $("routeMessage").textContent = routeMessage.join(" ");
    $("routeMessage").classList.toggle("hidden", routeMessage.length === 0);
    return { routes: normalizeRoutes(data.routes), cached: Boolean(data.cached) };
  }

  function drawDirections(route) {
    const list = $("directions");
    list.replaceChildren();
    if (!route || !route.steps.length) {
      list.append(element("li", "empty", "El proveedor no devolvió indicaciones paso a paso."));
      return;
    }
    let activeIndex = 0;
    if (livePosition) {
      let closest = Infinity;
      route.steps.forEach((step, index) => {
        if (!Array.isArray(step.location) || !validCoordinates(step.location[1], step.location[0])) return;
        const distance = pointSegmentDistanceMeters(
          [livePosition[1], livePosition[0]], step.location, step.location
        );
        if (distance < closest) {
          closest = distance;
          activeIndex = index;
        }
      });
    }
    route.steps.forEach((step, index) => {
      const instruction = element("li", index === activeIndex && liveWatchId !== null ? "direction-active" : "");
      instruction.append(element("span", "", step.instruction || "Continúa por la ruta"));
      const distance = Number(step.distance);
      if (Number.isFinite(distance) && distance > 0) {
        instruction.append(element("small", "", distance >= 1000 ?
          (distance / 1000).toFixed(1) + " km" : Math.round(distance) + " m"));
      }
      list.append(instruction);
    });
  }

  function drawRoutes(stops, fitMap = true) {
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
        drawRoutes(stops, false);
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
    drawDirections(routeChoices[selectedRoute]);
    if (fitMap) {
      const combined = bounds.reduce((result, bound) => result.extend(bound), L.latLngBounds([]));
      if (combined.isValid()) map.fitBounds(combined, { padding: [35, 35], maxZoom: 15 });
    }
  }

  async function calculateRoute(options = {}) {
    $("noRoute").classList.add("hidden");
    $("routeMessage").classList.add("hidden");
    $("stops").replaceChildren();
    $("routeOptions").replaceChildren();
    try {
      const missing = deliveries.filter(delivery => !hasLocation(delivery));
      const stops = dailyStops();
      if (!stops.length) {
        throw new Error(deliveries.length ?
          "Los destinos de hoy no tienen coordenadas guardadas. Añádelas en Supabase para calcular la ruta diaria." :
          "No hay destinos programados para hoy.");
      }
      $("routeTitle").textContent = "Ruta del día";
      const previousSelection = selectedRoute;
      const result = await requestRoutes(stops);
      routeChoices = result.routes;
      if (missing.length) {
        const warning = missing.length +
          " destino(s) no se incluirán porque faltan coordenadas. Actualiza lat y lng en Supabase.";
        const previous = $("routeMessage").classList.contains("hidden") ? "" : $("routeMessage").textContent;
        $("routeMessage").textContent = [previous, warning].filter(Boolean).join(" ");
        $("routeMessage").classList.remove("hidden");
      }
      selectedRoute = result.cached ? Math.min(previousSelection, routeChoices.length - 1) : 0;
      updateRouteMetrics(routeChoices[selectedRoute]);
      drawRoutes(stops, options.fitMap !== false);
      if (location.hash === "#rutas") setPanel("routes");
      return true;
    } catch (error) {
      routeChoices = [];
      routeLayers.clearLayers();
      $("directions").replaceChildren();
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
    if (routeChoices.length) drawDirections(routeChoices[selectedRoute]);
    if (position.coords.accuracy > 150) {
      $("trackingStatus").textContent = "GPS impreciso (" +
        Math.round(position.coords.accuracy) + " m); esperando una ubicación más precisa.";
      return;
    }
    if (!firstLivePosition) {
      firstLivePosition = true;
      origin = livePosition;
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
      origin = livePosition;
      $("originLabel").textContent = "Ubicación en vivo";
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

  function setPanel(name) {
    const routes = name === "routes";
    $("routesPanel").classList.toggle("hidden", !routes);
    $("eventsPanel").classList.toggle("hidden", routes);
    document.querySelectorAll(".panel-tabs button").forEach(button => {
      button.setAttribute("aria-selected", String(button.dataset.panel === name));
    });
    if (map) setTimeout(() => map.invalidateSize(), 50);
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
    const deliveriesResult = results[0];
    const eventsResult = results[1];
    let routeOk = false;
    if (deliveriesResult.status === "fulfilled") {
      routeOk = await calculateRoute({ fitMap: !routeChoices.length });
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
    window.AppNavigation.mount();
    if (!window.L) {
      $("noRoute").textContent = "No se pudo cargar el mapa. Revisa tu conexión e inténtalo de nuevo.";
      $("noRoute").classList.remove("hidden");
      setConnectionStatus("Mapa no disponible", true);
      return;
    }
    initMap();
    setTimeout(() => map.invalidateSize(), 50);
    document.querySelectorAll(".panel-tabs button").forEach(button => {
      button.addEventListener("click", () => setPanel(button.dataset.panel));
    });
    ["eventSeverity", "eventFrom", "eventTo"].forEach(id => $(id).addEventListener("change", drawEvents));
    $("refresh").addEventListener("click", refreshDashboard);
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
    if (location.hash === "#rutas") setPanel("routes");
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
