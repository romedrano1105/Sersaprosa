// Pruebas de la lógica del centro de control de rutas (sin navegador): node --test tests/js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function cargar() {
  const window = { document: {} };
  const codigo = fs.readFileSync(path.join(__dirname, "../../public/assets/js/centroRutas.js"), "utf8");
  vm.runInNewContext(codigo, { window, Date, Math, Number, String, Array, Map, Set });
  return window.CentroRutas.util;
}

const pedidos = [
  { id: 1, cliente: "A", hora: "10:00", estado: "pendiente", ruta: "Ruta Centro", lat: 13.70, lng: -89.20 },
  { id: 2, cliente: "B", hora: "09:00", estado: "proceso", ruta: " ruta  CENTRO ", lat: 13.71, lng: -89.21 },
  { id: 3, cliente: "C", hora: "08:00", estado: "completada", ruta: "Ruta Centro", lat: 13.72, lng: -89.22 },
  { id: 4, cliente: "D", hora: "11:00", estado: "pendiente", ruta: "Ruta Oriente", lat: null, lng: null },
  { id: 5, cliente: "E", hora: "12:00", estado: "pendiente", ruta: "", lat: 13.80, lng: -89.30 }
];

test("los pedidos de una ruta son los marcados con su nombre, sin importar mayúsculas ni espacios", () => {
  const u = cargar();
  assert.deepEqual(u.pedidosDeRuta(pedidos, { nombre: "Ruta Centro" }).map(p => p.id), [1, 2, 3]);
  assert.equal(u.pedidosDeRuta(pedidos, { nombre: "" }).length, 0);
});

test("orden de visita: el guardado manda y lo demás va por hora", () => {
  const u = cargar();
  assert.deepEqual(u.aplicarOrden(pedidos, null).map(p => p.id), [3, 2, 1, 4, 5]);
  assert.deepEqual(u.aplicarOrden(pedidos, [5, 1]).map(p => p.id), [5, 1, 3, 2, 4]);
});

test("optimizar: vecino más cercano desde el inicio y sin coordenadas al final", () => {
  const u = cargar();
  const orden = u.ordenarVecinoCercano([13.69, -89.19], pedidos).map(p => p.id);
  assert.deepEqual(Array.from(orden.slice(-1)), [4]);        // sin coordenadas, al final
  assert.equal(orden[0], 1);                      // el más cercano al inicio
  assert.deepEqual(Array.from(orden).sort(), [1, 2, 3, 4, 5]);
});

test("resumen de pedidos", () => {
  const u = cargar();
  assert.deepEqual(JSON.parse(JSON.stringify(u.resumenPedidos(pedidos))),
    { total: 5, pendientes: 3, proceso: 1, completados: 1, sinUbicacion: 1 });
});

test("estado de la ruta según pedidos y asignación", () => {
  const u = cargar();
  const solo = estado => [{ estado }];
  assert.equal(u.estadoRuta(solo("pendiente"), false), "sin_asignar");
  assert.equal(u.estadoRuta(solo("pendiente"), true), "asignada");
  assert.equal(u.estadoRuta(solo("proceso"), true), "en_curso");
  assert.equal(u.estadoRuta([{ estado: "completada" }, { estado: "pendiente" }], true), "en_curso");
  assert.equal(u.estadoRuta(solo("completada"), true), "completada");
  assert.equal(u.estadoRuta([], false), "sin_asignar");
});

test("ETA: suma las duraciones de los tramos y detecta el retraso frente a la hora programada", () => {
  const u = cargar();
  const inicio = new Date(2026, 9, 20, 8, 0, 0).getTime();
  const etas = u.calcularEtas(inicio, [{ duration: 600 }, { duration: 1200 }, {}]);
  assert.deepEqual(etas.map(t => (t - inicio) / 60000), [10, 30, 30]);
  assert.equal(u.minutosTarde(etas[1], "08:20"), 10);   // llega 08:30, programado 08:20
  assert.equal(u.minutosTarde(etas[0], "09:00"), 0);    // llega antes
  assert.equal(u.minutosTarde(etas[0], "sin hora"), 0);
  assert.equal(u.minutosTarde(null, "08:00"), 0);
});

test("distancia entre dos puntos conocidos (San Salvador – Santa Tecla ≈ 12 km)", () => {
  const u = cargar();
  const d = u.distanciaKm([13.6989, -89.1914], [13.6769, -89.2797]);
  assert.ok(d > 8 && d < 12, "distancia " + d);
});
