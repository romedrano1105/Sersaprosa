// Reglas de los reportes automáticos de viaje (sin navegador): node --test tests/js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plano = valor => JSON.parse(JSON.stringify(valor));

function cargar() {
  const window = {};
  const codigo = fs.readFileSync(path.join(__dirname, "../../public/assets/js/reportesViaje.js"), "utf8");
  vm.runInNewContext(codigo, { window });
  return window.ReportesViaje.util;
}

const T0 = Date.parse("2026-11-01T08:00:00-06:00");
const MIN = 60000;
const PEDIDOS = [
  { id: 1, cliente: "Banco A", direccion: "Col. Escalón", hora: "08:30", estado: "completada", ruta: "Ruta Centro" },
  { id: 2, cliente: "Joyería B", direccion: "Metrocentro", hora: "09:15", estado: "completada", ruta: "Ruta Centro" }
];
const lecturasCada = (desde, hasta, paso) => { const l = []; for (let t = desde; t <= hasta; t += paso) l.push(t); return l; };

function datosCompletos(extra) {
  return Object.assign({
    ruta: { id: "R1", nombre: "Ruta Centro", zona: "Centro", horario: "08:00" }, fecha: "2026-11-01",
    pedidos: PEDIDOS, conductor: "Carlos Mejía", vehiculo: "P 482-193",
    inicio: T0, inicioFuente: "observada", fin: T0 + 90 * MIN, finFuente: "observada",
    eventos: [], lecturas: lecturasCada(T0, T0 + 90 * MIN, MIN), telemetria: true, ahora: T0 + 91 * MIN
  }, extra);
}

test("el estado del viaje sigue la regla del centro de control", () => {
  const u = cargar();
  assert.equal(u.estadoViaje(PEDIDOS, true), "completada");
  assert.equal(u.estadoViaje([{ estado: "proceso" }, { estado: "pendiente" }], true), "en_curso");
  assert.equal(u.estadoViaje([{ estado: "pendiente" }], true), "asignada");
  assert.equal(u.estadoViaje([], true), "asignada");
  assert.equal(u.estadoViaje([{ estado: "pendiente" }], false), "sin_asignar");
});

test("un viaje con todos sus datos genera un reporte completo con su contenido", () => {
  const r = plano(cargar().armarReporte(datosCompletos()));
  assert.equal(r.estado, "completo");
  assert.deepEqual(r.faltantes, []);
  assert.equal(r.conductor, "Carlos Mejía");
  assert.equal(r.vehiculo, "P 482-193");
  assert.equal(r.fecha, "2026-11-01");
  assert.equal(r.duracion_min, 90);
  assert.equal(r.entregas.realizadas.length, 2);
  assert.equal(r.entregas.pendientes.length, 0);
  assert.equal(r.id, "rep-R1-2026-11-01");
});

test("sin conductor ni vehículo el reporte queda incompleto e indica qué falta", () => {
  const r = cargar().armarReporte(datosCompletos({ conductor: null, vehiculo: "" }));
  assert.equal(r.estado, "incompleto");
  assert.deepEqual(plano(r.faltantes.map(f => f.campo)), ["Conductor", "Vehículo"]);
});

test("sin inicio observado se usa la hora programada y se avisa", () => {
  const r = cargar().armarReporte(datosCompletos({ inicio: null, inicioFuente: null }));
  assert.equal(r.hora_inicio.fuente, "programada");
  assert.equal(r.hora_inicio.valor, new Date(T0).toISOString());
  assert.ok(r.faltantes.some(f => f.campo === "Hora real de inicio"));
});

test("un tramo sin señal durante el viaje se reporta como información faltante", () => {
  const u = cargar();
  const lecturas = lecturasCada(T0, T0 + 30 * MIN, MIN).concat(lecturasCada(T0 + 50 * MIN, T0 + 90 * MIN, MIN));
  const r = u.armarReporte(datosCompletos({ lecturas }));
  assert.equal(r.estado, "incompleto");
  const sinSenal = r.faltantes.filter(f => f.campo === "Sin señal");
  assert.equal(sinSenal.length, 1);
});

test("sin ninguna lectura del vehículo se avisa que los eventos pueden estar incompletos", () => {
  const r = cargar().armarReporte(datosCompletos({ lecturas: [] }));
  assert.ok(r.faltantes.some(f => f.campo === "Señal del vehículo"));
});

test("huecosDeSenal detecta tramos mayores que el umbral, incluidos inicio y fin", () => {
  const u = cargar();
  assert.equal(u.huecosDeSenal(lecturasCada(T0, T0 + 10 * MIN, MIN), T0, T0 + 10 * MIN, 2).length, 0);
  const h = plano(u.huecosDeSenal([T0 + 5 * MIN], T0, T0 + 6 * MIN, 2));
  assert.deepEqual(h, [{ desde: T0, hasta: T0 + 5 * MIN }]);
  assert.equal(u.huecosDeSenal([], T0, T0 + 10 * MIN, 2).length, 0);
});

test("solo se incluyen los eventos de manejo de esa ruta y dentro del viaje", () => {
  const u = cargar();
  const eventos = [
    { ruta: "Ruta Centro", tipo: "exceso_velocidad", fecha: new Date(T0 + 10 * MIN).toISOString(), velocidad_kmh: 95, limite_kmh: 80 },
    { ruta: "ruta centro", tipo: "frenada_brusca", fecha: new Date(T0 + 20 * MIN).toISOString(), velocidad_kmh: 40 },
    { ruta: "Ruta Norte", tipo: "giro_brusco", fecha: new Date(T0 + 20 * MIN).toISOString() },
    { ruta: "Ruta Centro", tipo: "giro_brusco", fecha: new Date(T0 + 200 * MIN).toISOString() }
  ];
  const lista = plano(u.eventosDelViaje(eventos, "Ruta Centro", "2026-11-01", T0, T0 + 90 * MIN));
  assert.deepEqual(lista.map(e => e.tipo), ["exceso_velocidad", "frenada_brusca"]);
  const r = u.armarReporte(datosCompletos({ eventos: lista }));
  assert.deepEqual(plano(r.resumen_eventos), { velocidad: 1, comportamiento: 1 });
});

test("una generación fallida conserva la ruta y el mensaje para reintentar", () => {
  const r = plano(cargar().reporteFallido({ id: "R1", nombre: "Ruta Centro" }, "2026-11-01", "Sin conexión", 2, T0));
  assert.equal(r.estado, "error");
  assert.equal(r.error, "Sin conexión");
  assert.equal(r.intentos, 2);
  assert.equal(r.id, "rep-R1-2026-11-01");
});

test("avisos y filtros del historial", () => {
  const u = cargar();
  const lista = [
    { id: "a", ruta: "Ruta Centro", conductor: "Carlos", fecha: "2026-10-30", estado: "completo", generado_en: "1" },
    { id: "b", ruta: "Ruta Norte", conductor: "Ana", fecha: "2026-11-01", estado: "incompleto", generado_en: "2" },
    { id: "c", ruta: "Ruta Sur", conductor: "Luis", fecha: "2026-10-31", estado: "error", generado_en: "3" }
  ];
  assert.deepEqual(plano(u.resumenAvisos(lista)), { incompletos: 1, errores: 1 });
  assert.deepEqual(plano(u.filtrarHistorial(lista, {}).map(r => r.id)), ["b", "c", "a"]);
  assert.deepEqual(plano(u.filtrarHistorial(lista, { texto: "ana" }).map(r => r.id)), ["b"]);
  assert.deepEqual(plano(u.filtrarHistorial(lista, { desde: "2026-10-31", estado: "error" }).map(r => r.id)), ["c"]);
  assert.match(u.errorDeFiltros({ desde: "2026-11-02", hasta: "2026-11-01" }), /no puede ser posterior/);
  assert.equal(u.errorDeFiltros({ desde: "2026-11-01" }), "");
});
