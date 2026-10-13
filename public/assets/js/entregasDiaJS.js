const NOMBRES = {pendiente: "Pendiente", proceso: "En proceso", completada: "Completada"};

const API_URL = "http://localhost:8000"; // ajusta al puerto de tu FastAPI
const MODO_DEMO = false;                 // true = datos de ejemplo sin backend

const PEDIDOS_DEMO = [
  {id:"P-1001", cliente:"Distribuidora El Sol", direccion:"Col. Escalón, San Salvador", hora:"08:30", estado:"completada", zona:"San Salvador", ruta:"R-100", sin_ruta:false, contacto:"2222-1010", productos:"20 cajas de arroz", notas:"Entregado sin novedades"},
  {id:"P-1002", cliente:"Supermercado La Esperanza", direccion:"Santa Tecla, La Libertad", hora:"10:00", estado:"proceso", zona:"Santa Tecla", ruta:"R-102", sin_ruta:false, contacto:"2288-3344", productos:"15 sacos de frijol", notas:"Camión en ruta"},
  {id:"P-1003", cliente:"Tienda Don Pepe", direccion:"Soyapango, San Salvador", hora:"11:30", estado:"pendiente", zona:"Soyapango", ruta:"", sin_ruta:true, contacto:"7788-5566", productos:"10 cajas de aceite", notas:"Confirmar horario con el cliente"},
  {id:"P-1004", cliente:"Mercado Central", direccion:"Centro, San Salvador", hora:"14:00", estado:"pendiente", zona:"San Salvador", ruta:"R-100", sin_ruta:false, contacto:"2270-9900", productos:"30 bolsas de azúcar", notas:""},
];

let pedidos = [];
let fEstado = "todos", fZona = "todos", fRuta = "todos";

const $lista = document.getElementById("lista");
const $vacio = document.getElementById("vacio");
const $cargando = document.getElementById("cargando");
const $error = document.getElementById("error");
const $modal = document.getElementById("modal");
const $aviso = document.getElementById("aviso-sin-ruta");
const $fecha = document.getElementById("f-fecha");
const $zona = document.getElementById("f-zona");
const $ruta = document.getElementById("f-ruta");

function leerSesion() {
  try { return JSON.parse(sessionStorage.getItem("session")); } catch (e) { return null; }
}

// Crea un elemento con texto seguro (sin innerHTML)
function el(tag, texto, clase) {
  const e = document.createElement(tag);
  if (texto !== undefined) e.textContent = texto;
  if (clase) e.className = clase;
  return e;
}

function hoyISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function mostrarFecha() {
  const d = new Date(($fecha.value || hoyISO()) + "T00:00:00");
  document.getElementById("fecha").textContent =
    d.toLocaleDateString("es-SV", {weekday: "long", year: "numeric", month: "long", day: "numeric"});
}

// Llena las listas de zona y ruta con lo que hay en la fecha elegida
function llenarOpciones(select, valores, textoTodos, extra) {
  const actual = select.value;
  select.replaceChildren(new Option(textoTodos, "todos"));
  if (extra) select.append(new Option(extra[1], extra[0]));
  valores.forEach(v => select.append(new Option(v, v)));
  select.value = [...select.options].some(o => o.value === actual) ? actual : "todos";
}

// FCJ1-55: consultar los pedidos programados para la fecha elegida
async function cargarPedidos() {
  $cargando.hidden = false;
  $error.hidden = true;
  $vacio.hidden = true;
  mostrarFecha();
  try {
    if (MODO_DEMO) {
      pedidos = PEDIDOS_DEMO;
    } else {
      const s = leerSesion();
      const res = await fetch(API_URL + "/entregas/listar", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(s && s.token ? { Authorization: "Bearer " + s.token } : {})
        },
        body: JSON.stringify({ fecha: $fecha.value })
      });
      if (!res.ok) throw new Error("Error " + res.status);
      pedidos = (await res.json()).entregas;
    }
    llenarOpciones($zona, [...new Set(pedidos.map(p => p.zona))].sort(), "Todas las zonas");
    llenarOpciones($ruta, [...new Set(pedidos.map(p => p.ruta).filter(Boolean))].sort(),
                   "Todas las rutas", ["sin_ruta", "Sin ruta asignada"]);
    fZona = $zona.value; fRuta = $ruta.value;
    render();
  } catch (err) {
    console.error(err);
    pedidos = [];
    $lista.replaceChildren();
    $aviso.hidden = true;
    $error.hidden = false;
  } finally {
    $cargando.hidden = true;
  }
}

// FCJ1-57: filtrar por estado, zona y ruta
function filtrar(lista, estado, zona, ruta) {
  return lista.filter(p =>
    (estado === "todos" || p.estado === estado) &&
    (zona === "todos" || p.zona === zona) &&
    (ruta === "todos" || (ruta === "sin_ruta" ? p.sin_ruta : p.ruta === ruta)));
}

// FCJ1-56 + FCJ1-58: lista con cliente, dirección y estado; resalta los pedidos sin ruta
function render() {
  const visibles = filtrar(pedidos, fEstado, fZona, fRuta);
  $lista.replaceChildren();
  $vacio.hidden = visibles.length > 0;   // FCJ1-60: mensaje sin pedidos

  visibles.forEach(p => {
    const estado = NOMBRES[p.estado] ? p.estado : "pendiente";
    const t = el("article", undefined, "tarjeta " + estado + (p.sin_ruta ? " sin-ruta" : ""));
    t.append(
      el("h3", p.cliente),
      el("span", p.hora, "hora"),
      el("p", p.direccion + " · " + p.zona),
      el("span", NOMBRES[estado], "badge")
    );
    if (p.sin_ruta) t.append(el("span", "Sin ruta asignada", "tag-sin-ruta"));
    t.addEventListener("click", () => verDetalle(p));
    $lista.appendChild(t);
  });

  // Los contadores respetan zona y ruta, pero no el estado (para que cada botón muestre su total)
  const base = filtrar(pedidos, "todos", fZona, fRuta);
  ["todos", "pendiente", "proceso", "completada"].forEach(e => {
    document.getElementById("c-" + e).textContent = filtrar(base, e, "todos", "todos").length;
  });

  const sinRuta = pedidos.filter(p => p.sin_ruta).length;
  $aviso.hidden = sinRuta === 0;
  $aviso.textContent = sinRuta === 1 ? "1 pedido sin ruta asignada." : sinRuta + " pedidos sin ruta asignada.";
}

// FCJ1-59: detalle del pedido seleccionado
function verDetalle(p) {
  document.getElementById("d-titulo").textContent = `${p.id} · ${p.cliente}`;
  const filas = [
    ["Dirección", p.direccion],
    ["Zona", p.zona],
    ["Ruta", p.sin_ruta ? "Sin ruta asignada" : p.ruta],
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
  fEstado = b.dataset.estado;
  render();
});
$zona.addEventListener("change", () => { fZona = $zona.value; render(); });
$ruta.addEventListener("change", () => { fRuta = $ruta.value; render(); });
$fecha.addEventListener("change", () => { if ($fecha.value) cargarPedidos(); });

$fecha.value = hoyISO();
cargarPedidos();