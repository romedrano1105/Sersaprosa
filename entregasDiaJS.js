// Estados válidos (también evita usar valores raros como clase CSS)
const NOMBRES = {pendiente: "Pendiente", proceso: "En proceso", completada: "Completada"};

const API_URL = "http://localhost:8000"; // ajusta al puerto de tu FastAPI

let pedidos = [];
let filtroActual = "todos";

function leerSesion() {
  try { return JSON.parse(sessionStorage.getItem("session")); } catch (e) { return null; }
}

const $lista = document.getElementById("lista");
const $vacio = document.getElementById("vacio");
const $cargando = document.getElementById("cargando");
const $error = document.getElementById("error");
const $modal = document.getElementById("modal");

document.getElementById("fecha").textContent =
  new Date().toLocaleDateString("es-SV", {weekday: "long", year: "numeric", month: "long", day: "numeric"});

// Crea un elemento con texto seguro (sin innerHTML)
function el(tag, texto, clase) {
  const e = document.createElement(tag);
  if (texto !== undefined) e.textContent = texto;
  if (clase) e.className = clase;
  return e;
}

// FCJ1-55: Consultar los pedidos del día desde el backend
async function cargarPedidos() {
  $cargando.hidden = false;
  $error.hidden = true;
  $vacio.hidden = true;
  try {
    const s = leerSesion();
    const res = await fetch(API_URL + "/entregas/listar", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(s && s.token ? { Authorization: "Bearer " + s.token } : {})
      },
      body: JSON.stringify({})
    });
    if (!res.ok) throw new Error("Error " + res.status);
    const data = await res.json();
    pedidos = data.entregas;
    render();
  } catch (err) {
    console.error(err);
    $lista.replaceChildren();
    $error.hidden = false;
  } finally {
    $cargando.hidden = true;
  }
}

// FCJ1-57: filtrar por estado
function filtrar(lista, estado) {
  return estado === "todos" ? lista : lista.filter(p => p.estado === estado);
}

// FCJ1-56 + FCJ1-58: lista con cliente, dirección, hora y estado (resaltado por clase)
function render() {
  const visibles = filtrar(pedidos, filtroActual);
  $lista.replaceChildren();
  $vacio.hidden = visibles.length > 0;   // FCJ1-60: mensaje sin pedidos

  visibles.forEach(p => {
    const estado = NOMBRES[p.estado] ? p.estado : "pendiente";
    const t = el("article", undefined, "tarjeta " + estado);
    t.append(
      el("h3", p.cliente),
      el("span", p.hora, "hora"),
      el("p", p.direccion),
      el("span", NOMBRES[estado], "badge")
    );
    t.addEventListener("click", () => verDetalle(p));
    $lista.appendChild(t);
  });

  ["todos", "pendiente", "proceso", "completada"].forEach(e => {
    document.getElementById("c-" + e).textContent = filtrar(pedidos, e).length;
  });
}

// FCJ1-59: detalle de la entrega
function verDetalle(p) {
  document.getElementById("d-titulo").textContent = `${p.id} · ${p.cliente}`;
  const filas = [
    ["Dirección", p.direccion],
    ["Hora programada", p.hora],
    ["Estado", NOMBRES[p.estado] || p.estado],
    ["Contacto", p.contacto || "Sin contacto"],
    ["Productos", p.productos || "Sin detalle"],
    ["Notas", p.notas || "Sin notas"],
  ];
  const dl = document.getElementById("d-datos");
  dl.replaceChildren();
  filas.forEach(([k, v]) => dl.append(el("dt", k), el("dd", v)));
  $modal.hidden = false;
}

document.getElementById("cerrar").onclick = () => $modal.hidden = true;
$modal.addEventListener("click", e => { if (e.target === $modal) $modal.hidden = true; });
document.addEventListener("keydown", e => { if (e.key === "Escape") $modal.hidden = true; });

document.getElementById("filtros").addEventListener("click", e => {
  const b = e.target.closest(".filtro");
  if (!b) return;
  document.querySelectorAll(".filtro").forEach(x => x.classList.remove("activo"));
  b.classList.add("activo");
  filtroActual = b.dataset.estado;
  render();
});

cargarPedidos();