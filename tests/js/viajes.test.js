// Reglas del formulario de viaje (sin navegador): node --test tests/js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function cargar() {
  const window = { document: {} };
  const codigo = fs.readFileSync(path.join(__dirname, "../../public/assets/js/viajeRutas.js"), "utf8");
  vm.runInNewContext(codigo, { window, Number, String, Array, Object });
  return window.Viajes.util;
}

const OK = { origen: "Bodega Central", destino: "Metrocentro", horario: "09:30", tipo_carga_id: "3", monto: "1500.50" };

test("un viaje completo no tiene errores", () => {
  assert.deepEqual(Object.keys(cargar().validar(OK)), []);
});

test("sin datos: se listan todos los campos obligatorios que faltan", () => {
  const u = cargar();
  const errores = u.validar({});
  assert.deepEqual(Object.keys(errores), ["origen", "destino", "horario", "tipo_carga_id", "monto"]);
  assert.equal(u.resumen(errores), "Faltan campos obligatorios: Origen, Destino, Horario, Tipo de carga, Monto.");
});

test("si falta uno solo, solo ese aparece", () => {
  const u = cargar();
  const errores = u.validar({ ...OK, horario: "" });
  assert.equal(u.resumen(errores), "Faltan campos obligatorios: Horario.");
});

test("un horario fuera del horario de entregas se rechaza", () => {
  const u = cargar();
  for (const hora of ["03:00", "05:59", "20:01", "23:30"]) assert.match(u.validar({ ...OK, horario: hora }).horario, /No se realizan entregas/, hora);
  for (const hora of ["06:00", "12:15", "20:00"]) assert.equal(u.validar({ ...OK, horario: hora }).horario, undefined, hora);
  assert.match(u.validar({ ...OK, horario: "25:00" }).horario, /formato/);
});

test("monto: debe ser positivo y con máximo 2 decimales", () => {
  const u = cargar();
  for (const monto of ["0", "-5", "abc", "1.234"]) assert.ok(u.validar({ ...OK, monto }).monto, monto);
  assert.equal(u.validar({ ...OK, monto: "10" }).monto, undefined);
});

test("el destino no puede ser igual al origen", () => {
  assert.ok(cargar().validar({ ...OK, destino: "bodega  central" }).destino);
});
