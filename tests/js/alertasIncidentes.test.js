// Reglas del panel unificado de alertas e incidentes (sin navegador): node --test tests/js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plano = valor => JSON.parse(JSON.stringify(valor));

function cargar() {
  const window = {};
  const codigo = fs.readFileSync(path.join(__dirname, "../../public/assets/js/alertasIncidentes.js"), "utf8");
  vm.runInNewContext(codigo, { window });
  return window.AlertasIncidentes.util;
}

const INC = { id: "i1", fecha: "2026-11-02T10:00:00Z", tipo: "robo", tipo_etiqueta: "Robo", severidad: "alta", ruta: "Ruta Centro", conductor: "Ana", estado: "pendiente", vista: false };
const ALE = { id: "a1", fecha: "2026-11-02T11:00:00Z", tipo: "exceso_velocidad", severidad: "media", ruta: "Ruta Norte", conductor: "Luis", estado: "pendiente" };

test("normaliza las dos fuentes al mismo formato", () => {
  const u = cargar();
  const i = u.deIncidente(INC);
  const a = u.deAlerta(ALE);
  assert.deepEqual([i.clave, i.fuente, i.estado, i.nueva, i.tipo], ["incidente:i1", "incidente", "pendiente", true, "Robo"]);
  assert.deepEqual([a.clave, a.fuente, a.estado, a.tipo], ["alerta:a1", "alerta", "pendiente", "Exceso velocidad"]);
  assert.equal(u.deIncidente({ ...INC, estado: "atendida" }).estado, "resuelta");
  assert.equal(u.deAlerta({ ...ALE, estado: "revisada" }).estado, "resuelta");
});

test("combinar no duplica y ordena: pendientes, severidad y luego la más reciente", () => {
  const u = cargar();
  const lista = u.combinar(
    [u.deIncidente(INC)],
    [u.deAlerta(ALE), u.deAlerta({ ...ALE, id: "a2", severidad: "alta", fecha: "2026-11-02T12:00:00Z" })],
    [u.deAlerta(ALE), u.deAlerta({ ...ALE, id: "a3", estado: "revisada", severidad: "alta" })]
  );
  assert.deepEqual(plano(lista.map(x => x.clave)), ["alerta:a2", "incidente:i1", "alerta:a1", "alerta:a3"]);
});

test("filtros por estado, severidad, origen y texto", () => {
  const u = cargar();
  const lista = u.combinar([u.deIncidente(INC)], [u.deAlerta(ALE), u.deAlerta({ ...ALE, id: "a3", estado: "revisada" })]);
  assert.equal(u.filtrar(lista, { estado: "pendiente" }).length, 2);
  assert.equal(u.filtrar(lista, { estado: "resuelta" }).length, 1);
  assert.equal(u.filtrar(lista, { estado: "todas" }).length, 3);
  assert.equal(u.filtrar(lista, { estado: "todas", fuente: "incidente" }).length, 1);
  assert.equal(u.filtrar(lista, { estado: "todas", severidad: "alta" }).length, 1);
  assert.equal(u.filtrar(lista, { estado: "todas", texto: "luis" }).length, 2);
});

test("resumen cuenta solo pendientes, separados por origen", () => {
  const u = cargar();
  const lista = u.combinar([u.deIncidente(INC)], [u.deAlerta(ALE), u.deAlerta({ ...ALE, id: "a3", estado: "revisada" })]);
  assert.deepEqual(plano(u.resumen(lista)), { pendientes: 2, enCurso: 1, finalizados: 1, altas: 1 });
});

test("nunca dice «no hay» si no cargó o si alguna fuente falló", () => {
  const u = cargar();
  const base = { cargado: true, errores: [], items: [], filtros: { estado: "pendiente" } };
  assert.equal(u.textoVacio({ ...base, cargado: false }), "");
  assert.equal(u.textoVacio({ ...base, errores: ["alertas"] }), "");
  assert.equal(u.textoVacio(base), "No hay alertas ni incidentes pendientes.");
  assert.equal(u.textoVacio({ ...base, filtros: { estado: "pendiente", severidad: "alta" } }), "No hay alertas ni incidentes con esos filtros.");
});
