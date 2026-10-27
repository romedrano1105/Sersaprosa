// Pruebas de la lógica de Pedidos en curso (sin navegador): node --test tests/js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function cargar() {
  const almacen = new Map();
  const window = {
    sessionStorage: {
      getItem: clave => (almacen.has(clave) ? almacen.get(clave) : null),
      setItem: (clave, valor) => almacen.set(clave, String(valor)),
      removeItem: clave => almacen.delete(clave)
    },
    document: {}
  };
  const codigo = fs.readFileSync(path.join(__dirname, "../../public/assets/js/pedidosEnCurso.js"), "utf8");
  vm.runInNewContext(codigo, { window });
  return { Pedidos: window.Pedidos, almacen };
}

const pedidos = [
  { id: 1, cliente: "Cliente A", direccion: "Escalón", zona: "Centro", estado: "pendiente", sin_ruta: true, lat: 13.7, lng: -89.2 },
  { id: 2, cliente: "Cliente B", direccion: "Soyapango", zona: "Oriente", estado: "proceso", sin_ruta: false, lat: 13.71, lng: -89.14 },
  { id: 3, cliente: "Cliente C", direccion: "Ilopango", zona: "Oriente", estado: "completada", sin_ruta: false, lat: 13.7, lng: -89.11 },
  { id: 4, cliente: "Cliente D", direccion: "Mejicanos", zona: "Norte", estado: "pendiente", sin_ruta: true, lat: null, lng: null }
];

test("en curso es todo lo que no está completado", () => {
  const { Pedidos } = cargar();
  assert.deepEqual(pedidos.filter(Pedidos.enCurso).map(p => p.id), [1, 2, 4]);
});

test("ubicación válida: acepta 0,0 y rechaza null, texto y fuera de rango", () => {
  const { Pedidos } = cargar();
  assert.equal(Pedidos.conUbicacion({ lat: 0, lng: 0 }), true);
  assert.equal(Pedidos.conUbicacion({ lat: null, lng: null }), false);
  assert.equal(Pedidos.conUbicacion({ lat: "abc", lng: 1 }), false);
  assert.equal(Pedidos.conUbicacion({ lat: 91, lng: 0 }), false);
});

test("filtrar por estado, zona y texto sin importar tildes", () => {
  const { Pedidos } = cargar();
  const f = extra => Pedidos.filtrar(pedidos, Object.assign({ estado: "todos", zona: "todos", q: "", completados: false }, extra)).map(p => p.id);
  assert.deepEqual(f({}), [1, 2, 4]);
  assert.deepEqual(f({ completados: true }), [1, 2, 3, 4]);
  assert.deepEqual(f({ estado: "proceso" }), [2]);
  assert.deepEqual(f({ zona: "Norte" }), [4]);
  assert.deepEqual(f({ q: "escalon" }), [1]);
});

test("resumen cuenta pendientes, en proceso, sin ruta y sin coordenadas", () => {
  const { Pedidos } = cargar();
  assert.deepEqual(JSON.parse(JSON.stringify(Pedidos.resumen(pedidos))),
    { enCurso: 3, pendientes: 2, proceso: 1, completados: 1, sinUbicacion: 1, sinRuta: 2 });
});

test("selección: sin elegir cuentan todos los en curso; toggle, limpiar y persistencia", () => {
  const { Pedidos, almacen } = cargar();
  const s = Pedidos.store;
  assert.equal(s.get(), null);
  assert.deepEqual(s.effective(pedidos).map(p => p.id), [1, 2, 4]);
  s.toggle(2, pedidos); // pasa a elección explícita sin el 2
  assert.deepEqual(s.effective(pedidos).map(p => p.id), [1, 4]);
  assert.equal(almacen.has("pedidosSeleccion"), true);
  s.clear();
  assert.deepEqual(s.effective(pedidos), []);
  s.selectAll(pedidos); // solo los que tienen coordenadas
  assert.deepEqual(s.effective(pedidos).map(p => p.id), [1, 2]);
});

test("un pedido completado nunca cuenta aunque esté en la elección guardada", () => {
  const { Pedidos } = cargar();
  Pedidos.store.set([1, 3]);
  assert.deepEqual(Pedidos.store.effective(pedidos).map(p => p.id), [1]);
});

test("avisa a los suscriptores cuando cambia la elección", () => {
  const { Pedidos } = cargar();
  let avisos = 0;
  const baja = Pedidos.store.subscribe(() => { avisos += 1; });
  Pedidos.store.clear();
  Pedidos.store.toggle(1, pedidos);
  baja();
  Pedidos.store.clear();
  assert.equal(avisos, 2);
});
