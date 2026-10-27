// Reglas del historial de incidentes (sin navegador): node --test tests/js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Los objetos creados dentro de vm son de otro «mundo»: se copian para compararlos.
const plano = valor => JSON.parse(JSON.stringify(valor));

function cargar() {
  const window = {};
  const codigo = fs.readFileSync(path.join(__dirname, "../../public/assets/js/historialIncidentes.js"), "utf8");
  vm.runInNewContext(codigo, { window });
  return window.HistorialIncidentes.util;
}

test("armarFiltros descarta los vacíos y recorta espacios", () => {
  const u = cargar();
  assert.deepEqual(plano(u.armarFiltros({ desde: "", hasta: " 2026-10-26 ", tipo: "robo", severidad: "", estado: null, ruta: "  Centro ", otro: "x" })),
    { hasta: "2026-10-26", tipo: "robo", ruta: "Centro" });
  assert.deepEqual(plano(u.armarFiltros({})), {});
  assert.deepEqual(plano(u.armarFiltros(undefined)), {});
});

test("hayFiltros distingue entre filtrar y ver todo", () => {
  const u = cargar();
  assert.equal(u.hayFiltros({}), false);
  assert.equal(u.hayFiltros({ tipo: "", ruta: "  " }), false);
  assert.equal(u.hayFiltros({ estado: "atendida" }), true);
});

test("«desde» posterior a «hasta» se rechaza antes de pedir nada", () => {
  const u = cargar();
  assert.match(u.errorDeFiltros({ desde: "2026-10-26", hasta: "2026-10-01" }), /no puede ser posterior/);
  assert.equal(u.errorDeFiltros({ desde: "2026-10-01", hasta: "2026-10-26" }), "");
  assert.equal(u.errorDeFiltros({ desde: "2026-10-01" }), "");
});

test("nunca dice «no hay incidentes» si no cargó o si hubo error", () => {
  const u = cargar();
  const base = { cargado: true, error: "", items: [], filtros: {} };
  assert.equal(u.textoVacio(Object.assign({}, base, { cargado: false })), "");
  assert.equal(u.textoVacio(Object.assign({}, base, { error: u.MSG_ERROR })), "");
  assert.equal(u.textoVacio(Object.assign({}, base, { items: [{ id: "a" }] })), "");
});

test("sin resultados: con filtros dice que no hay con esos filtros; sin filtros, que aún no hay registros", () => {
  const u = cargar();
  assert.equal(u.textoVacio({ cargado: true, error: "", items: [], filtros: { tipo: "robo" } }), "No hay incidentes con esos filtros.");
  assert.equal(u.textoVacio({ cargado: true, error: "", items: [], filtros: {} }), "Todavía no hay incidentes registrados.");
});

test("textos de rango y contador", () => {
  const u = cargar();
  assert.equal(u.textoRango(1, 25, 25, 60), "1–25 de 60");
  assert.equal(u.textoRango(3, 25, 10, 60), "51–60 de 60");
  assert.equal(u.textoRango(1, 25, 0, 0), "0 incidentes");
  assert.equal(u.textoContador(1), "1 incidente");
  assert.equal(u.textoContador(0), "0 incidentes");
  assert.equal(u.textoContador(60), "60 incidentes");
});

test("el tamaño de página coincide con el que el servidor acepta (máx. 100)", () => {
  const u = cargar();
  assert.ok(u.LIMITE >= 1 && u.LIMITE <= 100);
});
