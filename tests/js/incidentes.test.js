// Reglas del panel de incidentes en curso (sin navegador): node --test tests/js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function cargar() {
  const window = {};
  const codigo = fs.readFileSync(path.join(__dirname, "../../public/assets/js/incidentesViaje.js"), "utf8");
  vm.runInNewContext(codigo, { window });
  return window.IncidentesViaje.util;
}

const item = (id, fecha, vista = false) => ({ id, fecha, vista });

test("las alertas nuevas van primero y, dentro de cada grupo, la más reciente arriba", () => {
  const u = cargar();
  const orden = u.ordenar([
    item("vista-reciente", "2026-10-24T10:00:00Z", true),
    item("nueva-vieja", "2026-10-24T08:00:00Z"),
    item("nueva-reciente", "2026-10-24T09:00:00Z")
  ]).map(i => i.id);
  assert.deepEqual(orden, ["nueva-reciente", "nueva-vieja", "vista-reciente"]);
});

test("ordenar no modifica la lista original", () => {
  const u = cargar();
  const original = [item("a", "2026-10-24T08:00:00Z", true), item("b", "2026-10-24T09:00:00Z")];
  u.ordenar(original);
  assert.deepEqual(original.map(i => i.id), ["a", "b"]);
});

test("solo se avisa de las alertas que aún no se conocían", () => {
  const u = cargar();
  const conocidas = new Set(["a", "b"]);
  assert.deepEqual(u.nuevasDesde(conocidas, [item("a"), item("c"), item("d")]).map(i => i.id), ["c", "d"]);
});

test("al recuperar la conexión el mensaje indica cuántas alertas se recuperaron", () => {
  const u = cargar();
  assert.equal(u.textoRecuperadas(1), "Se recuperó 1 alerta que llegó mientras no había conexión.");
  assert.equal(u.textoRecuperadas(3), "Se recuperaron 3 alertas que llegaron mientras no había conexión.");
});

test("el panel nunca se muestra vacío como si no hubiera incidentes si no hay conexión", () => {
  const u = cargar();
  assert.equal(u.mostrarVacio({ cargado: true, sinConexion: false, items: [] }), true);
  assert.equal(u.mostrarVacio({ cargado: true, sinConexion: true, items: [] }), false);
  assert.equal(u.mostrarVacio({ cargado: false, sinConexion: true, items: [] }), false);
  assert.equal(u.mostrarVacio({ cargado: false, sinConexion: false, items: [] }), false);
  assert.equal(u.mostrarVacio({ cargado: true, sinConexion: false, items: [{}] }), false);
});

test("el sondeo cumple el tiempo máximo de entrega y el aviso usa el texto de la historia", () => {
  const u = cargar();
  assert.ok(u.POLL_MS <= 10000);
  assert.equal(u.MSG_SIN_TIEMPO_REAL, "No se pueden recibir alertas en tiempo real");
});