/**
 * Monitor en Tiempo Real de Unidades - Sersaprosa
 * Conexión Supabase / FastAPI
 */

let map = null;
const vehiculosEnMapa = new Map(); // id -> { marker, polylines: [], tramos: [], animIndex: 0, progress: 0 }
let pollingTimer = null;

const coloresRiesgo = {
  low: '#10b981',    // Verde
  medium: '#f59e0b', // Ámbar
  high: '#ef4444'    // Rojo alerta
};

// 1. Inicialización de la escena cartográfica
function initMap() {
  if (map) return;

  // Centro en San Salvador / Santa Tecla
  map = L.map('map', { zoomControl: true }).setView([13.6850, -89.2500], 13);

  // Cartografía oscura profesional
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    maxZoom: 19
  }).addTo(map);

  // Comenzar ciclo de sincronización
  sincronizarFlota();
  pollingTimer = setInterval(sincronizarFlota, 8000); // Polling a Supabase/FastAPI cada 8s

  // Bucle suave de animación para vehículos en movimiento
  requestAnimationFrame(animarVehiculos);
}

// 2. Consulta y actualización de datos desde la API
async function sincronizarFlota() {
  try {
    const res = await fetch('/api/viajes/monitoreo/en-vivo');
    if (!res.ok) return;
    const flota = await res.json();

    if (!flota || flota.length === 0) {
      mostrarSinVehiculos();
      return;
    }

    flota.forEach(dataVehiculo => {
      if (vehiculosEnMapa.has(dataVehiculo.viaje_id)) {
        actualizarVehiculoExistente(dataVehiculo);
      } else {
        registrarNuevoVehiculo(dataVehiculo);
      }
    });
  } catch (error) {
    console.warn("Error sincronizando viajes:", error);
  }
}

// 3. Registro y trazado de rutas con gradientes de riesgo
function registrarNuevoVehiculo(v) {
  const tramosValidos = v.tramos && v.tramos.length > 0 ? v.tramos : [v.posicion_actual];
  const polilineas = [];

  // Trazar cada segmento con el color de su riesgo
  for (let i = 0; i < tramosValidos.length - 1; i++) {
    const origen = tramosValidos[i];
    const destino = tramosValidos[i + 1];
    const segmento = [[origen.lat, origen.lng], [destino.lat, destino.lng]];
    const color = coloresRiesgo[origen.riesgo] || '#00b4d8';

    // Línea exterior con brillo/halo
    const glow = L.polyline(segmento, {
      color: color,
      weight: 7,
      opacity: 0.35
    }).addTo(map);

    // Línea central sólida
    const core = L.polyline(segmento, {
      color: color,
      weight: 3.5,
      opacity: 0.95
    }).addTo(map);

    polilineas.push(glow, core);
  }

  // Crear marcador inicial
  const marker = L.marker([v.posicion_actual.lat, v.posicion_actual.lng], {
    icon: crearIconoVehiculo(0)
  }).addTo(map);

  marker.bindPopup(`
    <div style="font-size: 13px;">
      <strong style="color: #00b4d8;">${v.unidad}</strong><br>
      <b>Conductor:</b> ${v.conductor}<br>
      <b>Estado:</b> ${v.estado.toUpperCase()}<br>
      <b>Destino:</b> ${tramosValidos[tramosValidos.length - 1]?.direccion || 'Base'}
    </div>
  `);

  marker.on('click', () => enfocarVehiculoEnPanel(v));

  vehiculosEnMapa.set(v.viaje_id, {
    info: v,
    marker: marker,
    polylines: polilineas,
    tramos: tramosValidos,
    tramoIndex: 0,
    progress: 0,
    bearing: 0
  });

  // Mostrar el primer vehículo en el panel lateral
  enfocarVehiculoEnPanel(v);
}

function actualizarVehiculoExistente(v) {
  const item = vehiculosEnMapa.get(v.viaje_id);
  if (!item) return;
  item.info = v;
  if (v.tramos && v.tramos.length > 0) {
    item.tramos = v.tramos;
  }
}

// 4. Marcadores SVG giratorios con bearing
function crearIconoVehiculo(rotacion = 0) {
  return L.divIcon({
    className: 'custom-vehicle-marker-wrapper',
    html: `
      <div class="custom-vehicle-marker" style="transform: rotate(${rotacion}deg);">
        <div class="custom-vehicle-icon">
          <svg viewBox="0 0 24 24">
            <path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/>
          </svg>
        </div>
      </div>
    `,
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });
}

function calcularBearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const y = Math.sin(dLon) * Math.cos(lat2 * (Math.PI / 180));
  const x = Math.cos(lat1 * (Math.PI / 180)) * Math.sin(lat2 * (Math.PI / 180)) -
            Math.sin(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * (180 / Math.PI)) + 360) % 360;
}

// 5. Animación continua entre waypoints
function animarVehiculos() {
  vehiculosEnMapa.forEach((vData) => {
    const { tramos } = vData;
    if (tramos.length < 2) return;

    const pOrigen = tramos[vData.tramoIndex];
    const pDestino = tramos[vData.tramoIndex + 1];

    if (!pOrigen || !pDestino) return;

    vData.progress += 0.004; // Tasa de desplazamiento continuo
    if (vData.progress >= 1) {
      vData.progress = 0;
      vData.tramoIndex++;
      if (vData.tramoIndex >= tramos.length - 1) {
        vData.tramoIndex = 0; // Bucle simulado en lo que llega nueva telemetría
      }
    }

    const currentLat = pOrigen.lat + (pDestino.lat - pOrigen.lat) * vData.progress;
    const currentLng = pOrigen.lng + (pDestino.lng - pOrigen.lng) * vData.progress;
    const angulo = calcularBearing(pOrigen.lat, pOrigen.lng, pDestino.lat, pDestino.lng);

    vData.marker.setLatLng([currentLat, currentLng]);
    vData.marker.setIcon(crearIconoVehiculo(angulo));
    vData.bearing = angulo;
  });

  requestAnimationFrame(animarVehiculos);
}

// 6. Actualización del panel de telemetría corporativo
function enfocarVehiculoEnPanel(v) {
  const elemUnidad = document.getElementById('telemetria-unidad');
  const elemConductor = document.getElementById('telemetria-conductor');
  const elemVel = document.getElementById('telemetria-vel');
  const elemTramo = document.getElementById('telemetria-tramo');
  const elemRiesgo = document.getElementById('telemetria-riesgo');

  const vData = vehiculosEnMapa.get(v.viaje_id);
  const tramoActual = vData?.tramos[vData.tramoIndex] || v.posicion_actual;

  if (elemUnidad) elemUnidad.innerText = v.unidad;
  if (elemConductor) elemConductor.innerText = v.conductor;
  if (elemVel) elemVel.innerText = "42.5 km/h";
  if (elemTramo) elemTramo.innerText = tramoActual.direccion || "En ruta";
  if (elemRiesgo) {
    const r = tramoActual.riesgo || 'low';
    elemRiesgo.innerText = r.toUpperCase();
    elemRiesgo.style.color = coloresRiesgo[r];
  }
}

function mostrarSinVehiculos() {
  const elemTramo = document.getElementById('telemetria-tramo');
  if (elemTramo) elemTramo.innerText = "Sin viajes activos";
}

document.addEventListener('DOMContentLoaded', initMap);