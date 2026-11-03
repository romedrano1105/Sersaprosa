// Reglas del panel de personal (sin navegador): node --test tests/js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plano = v => JSON.parse(JSON.stringify(v));

function cargar() {
  const window = {};
  const codigo = fs.readFileSync(path.join(__dirname, "../../public/assets/js/gestionEmpleados.js"), "utf8");
  vm.runInNewContext(codigo, { window });
  return window.GestionEmpleados.util;
}

const LISTA = [
  { codigo: "CON-001", nombre: "Pedro Ruiz", categoria: "conductor", activo: true, estado: "disponible" },
  { codigo: "DEMO-001", nombre: "José Martínez", categoria: "conductor", activo: true, estado: "asignado", asignacion: { ruta: "Ruta Centro", rol: "conductor" } },
  { codigo: "GUA-001", nombre: "Mario Guzmán", categoria: "guardia", activo: true, estado: "asignado", asignacion: { ruta: "Ruta Centro", rol: "guardia" } },
  { codigo: "GUA-005", nombre: "Laura Pérez", categoria: "guardia", activo: false, estado: "inactivo" }
];

test("validar: conductor con licencia, guardia sin ella", () => {
  const u = cargar();
  const ok = u.validar({ nombre: "  Pedro   Ruiz ", categoria: "conductor", licencia: "2028-05-01" });
  assert.deepEqual(plano(ok.errores), {});
  assert.deepEqual(plano(ok.limpio), { codigo: null, nombre: "Pedro Ruiz", categoria: "conductor", licencia: "2028-05-01", activo: true });
  assert.ok(u.validar({ nombre: "Pedro Ruiz", categoria: "conductor" }).errores.licencia);
  const guardia = u.validar({ nombre: "Laura Pérez", categoria: "guardia", licencia: "2028-05-01" });
  assert.equal(guardia.limpio.licencia, null);
  assert.deepEqual(Object.keys(u.validar({ nombre: "X", categoria: "jefe" }).errores).sort(), ["categoria", "nombre"]);
});

test("filtrar por categoría, estado y texto (incluida la ruta asignada)", () => {
  const u = cargar();
  assert.equal(u.filtrar(LISTA, { estado: "activos" }).length, 3);
  assert.equal(u.filtrar(LISTA, { estado: "inactivos" }).length, 1);
  assert.equal(u.filtrar(LISTA, { estado: "asignado", categoria: "guardia" }).length, 1);
  assert.deepEqual(plano(u.filtrar(LISTA, { texto: "centro" }).map(e => e.codigo)), ["DEMO-001", "GUA-001"]);
  assert.equal(u.filtrar(LISTA, { texto: "perez" }).length, 1);
});

test("texto del estado dice dónde trabaja hoy", () => {
  const u = cargar();
  assert.equal(u.textoEstado(LISTA[1]), "Conduce Ruta Centro");
  assert.equal(u.textoEstado(LISTA[2]), "Custodio en Ruta Centro");
  assert.equal(u.textoEstado(LISTA[0]), "Disponible");
  assert.equal(u.fechaCorta("2028-05-01"), "01/05/2028");
});
