// Reglas del formulario «Rechazar ruta» (sin navegador): node --test tests/js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function cargar() {
  const window = { document: {} };
  const codigo = fs.readFileSync(path.join(__dirname, "../../public/assets/js/rechazoRutas.js"), "utf8");
  vm.runInNewContext(codigo, { window, Number, String, Array, Object });
  return window.Rechazos.util;
}

test("sin motivo no se puede rechazar", () => {
  const u = cargar();
  for (const vacio of ["", "   ", null, undefined]) {
    assert.equal(u.validar(vacio, "").motivo, "El motivo del rechazo es obligatorio.");
  }
});

test("un motivo válido no tiene errores, con o sin comentario", () => {
  const u = cargar();
  assert.deepEqual(Object.keys(u.validar("Zona insegura", "")), []);
  assert.deepEqual(Object.keys(u.validar("  Zona   insegura ", "Hubo asaltos")), []);
});

test("motivo demasiado corto o largo", () => {
  const u = cargar();
  assert.match(u.validar("ab", "").motivo, /entre 3 y 200/);
  assert.match(u.validar("x".repeat(201), "").motivo, /entre 3 y 200/);
  assert.equal(u.validar("x".repeat(200), "").motivo, undefined);
});

test("el comentario admite hasta 500 caracteres", () => {
  const u = cargar();
  assert.equal(u.validar("Zona insegura", "x".repeat(500)).comentario, undefined);
  assert.match(u.validar("Zona insegura", "x".repeat(501)).comentario, /500/);
});
