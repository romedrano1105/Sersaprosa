// Pruebas de la lógica de disponibilidad (conductores, guardias, vehículos): node --test tests/js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function cargar() {
  const window = { document: { readyState: "complete", querySelector: () => null } };
  const codigo = fs.readFileSync(path.join(__dirname, "../../public/assets/js/VerificarConduJS.js"), "utf8");
  vm.runInNewContext(codigo, { window, document: window.document, Date, console: { log() {} } });
  return window.Disponibilidad;
}

const dia = n => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const asignaciones = [{ ruta: "R-9", conductor: "C-1", vehiculo: "V-1", guardias: ["G-1"], fecha: new Date(), usuario: "u" }];

test("conductor: documento vencido o ya asignado = no disponible", () => {
  const D = cargar();
  assert.equal(D.calcDisp({ id: "C-2", licencia: dia(10) }, "driver", [], dia(0)).ok, true);
  assert.equal(D.calcDisp({ id: "C-2", licencia: dia(-1) }, "driver", [], dia(0)).ok, false);
  const ocupado = D.calcDisp({ id: "C-1", licencia: dia(10) }, "driver", asignaciones, dia(0));
  assert.equal(ocupado.ok, false);
  assert.match(ocupado.motivos[0], /R-9/);
});

test("guardia: sin documentos; no disponible solo si ya está en una ruta de hoy", () => {
  const D = cargar();
  assert.equal(D.calcDisp({ id: "G-2" }, "guard", asignaciones, dia(0)).ok, true);
  const ocupado = D.calcDisp({ id: "G-1" }, "guard", asignaciones, dia(0));
  assert.equal(ocupado.ok, false);
  assert.match(ocupado.motivos[0], /R-9/);
});

test("vehículo: seguro o revisión vencidos = no disponible", () => {
  const D = cargar();
  assert.equal(D.calcDisp({ id: "V-2", seguro: dia(5), revision: dia(5) }, "vehicle", [], dia(0)).ok, true);
  assert.equal(D.calcDisp({ id: "V-2", seguro: dia(-1), revision: dia(5) }, "vehicle", [], dia(0)).ok, false);
  assert.equal(D.calcDisp({ id: "V-1", seguro: dia(5), revision: dia(5) }, "vehicle", asignaciones, dia(0)).ok, false);
});

test("normalize: marca disponibilidad, quita rutas ya asignadas y valida totales", () => {
  const D = cargar();
  const crudo = {
    drivers: [{ id: "C-1", nombre: "Uno", licencia: "2999-01-01" }, { id: "C-2", nombre: "Dos", licencia: "2999-01-01" }],
    guards: [{ id: "G-1", nombre: "Guardia Uno" }, { id: "G-2", nombre: "Guardia Dos" }],
    vehicles: [{ id: "V-1", placa: "P1", seguro: "2999-01-01", revision: "2999-01-01" }],
    routes: [{ id: "R-9", nombre: "ya asignada" }, { id: "R-10", nombre: "libre" }],
    assignments: [{ ruta: "R-9", conductor: "C-1", vehiculo: "V-1", guardias: ["G-1"], fecha: new Date().toISOString(), usuario: "u" }],
    totals: { drivers: 2, guards: 2, vehicles: 1 }
  };
  const n = D.normalize(crudo);
  assert.deepEqual(n.drivers.map(x => x.disp.ok), [false, true]);
  assert.deepEqual(n.guards.map(x => x.disp.ok), [false, true]);
  assert.deepEqual(n.routes.map(r => r.id), ["R-10"]);
  assert.throws(() => D.normalize(Object.assign({}, crudo, { totals: { drivers: 2, guards: 5, vehicles: 1 } })), /no coincide/);
});

test("normalize tolera respuestas sin guardias (base sin la categoría)", () => {
  const D = cargar();
  const n = D.normalize({ drivers: [], vehicles: [], totals: { drivers: 0, vehicles: 0 } });
  assert.equal(n.guards.length, 0);
});

test("las pruebas internas del módulo pasan completas", () => {
  const D = cargar();
  const r = D.runTests();
  assert.equal(r.ok, r.total);
});
