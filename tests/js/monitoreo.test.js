// Unidades del mapa de Monitoreo en vivo a partir de datos reales (sin navegador): node --test tests/js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plano = v => JSON.parse(JSON.stringify(v));

function cargar() {
  const window = {};
  const document = { readyState: "complete", getElementById: () => null, addEventListener() {} };
  const codigo = fs.readFileSync(path.join(__dirname, "../../public/assets/js/mapaMonitoreo.js"), "utf8");
  vm.runInNewContext(codigo, { window, document, Intl, Date, Math, Number, String });
  return window.MapaMonitoreo.util;
}

const RUTAS = [
  { id: "R-IA", nombre: "07:30 · Metrocentro", conductor: "Nombre viejo", orden_pedidos: ["P2", "P1"],
    viaje: { origen: { texto: "Bodega", lat: 13.69, lng: -89.19 }, destino: { texto: "Metrocentro", lat: 13.7058, lng: -89.2125 }, horario: "07:30", monto: 10000, nivel_riesgo: "Medio" } },
  { id: "R-MAN", nombre: "Ruta Centro", conductor: null, orden_pedidos: [], riesgo_ruta: "bajo" },
  { id: "R-LIBRE", nombre: "Ruta Libre", conductor: "Fantasma", viaje: { origen: { lat: 13.6, lng: -89.1 }, destino: { lat: 13.7, lng: -89.2 } } },
  { id: "R-SINPEDIDOS", nombre: "Ruta Vacía", orden_pedidos: [] }
];
const DISP = {
  drivers: [{ id: "DEMO-001", nombre: "José Antonio Martínez", licencia: "2027-11-23" }, { id: "CON-001", nombre: "Pedro Ruiz", licencia: "2028-05-01" }],
  guards: [{ id: "GUA-001", nombre: "Mario Ernesto Guzmán" }, { id: "GUA-002", nombre: "Fredy Portillo" }],
  vehicles: [{ id: "V1", placa: "P 482-193", tipo: "Camión blindado" }, { id: "V2", placa: "P 117-654", tipo: "Camioneta" }],
  assignments: [
    { ruta: "R-IA", conductor: "DEMO-001", vehiculo: "V1", guardias: ["GUA-001", "GUA-002"], fecha: "2026-11-02T13:00:00Z" },
    { ruta: "R-MAN", conductor: "CON-001", vehiculo: "V2", guardias: [], fecha: "2026-11-02T14:00:00Z" },
    { ruta: "R-SINPEDIDOS", conductor: "CON-001", vehiculo: "V2", guardias: [], fecha: "2026-11-02T14:00:00Z" }
  ]
};
const ENTREGAS = [
  { id: "P1", ruta: "07:30 · Metrocentro", estado: "pendiente", hora: "08:00", cliente: "Banco", lat: 13.70, lng: -89.20 },
  { id: "P2", ruta: "07:30 · Metrocentro", estado: "proceso", hora: "09:00", cliente: "Joyería", lat: "13.702", lng: "-89.205" },
  { id: "P3", ruta: "07:30 · Metrocentro", estado: "completada", hora: "07:45", cliente: "Ya entregado", lat: 13.71, lng: -89.21 },
  { id: "P4", ruta: "ruta centro", estado: "pendiente", hora: "10:00", cliente: "Farmacia", lat: 13.73, lng: -89.15 },
  { id: "P5", ruta: "Ruta Centro", estado: "pendiente", hora: "11:00", cliente: "Super", lat: 13.80, lng: -89.17 },
  { id: "P6", ruta: "Ruta Centro", estado: "pendiente", hora: "12:00", cliente: "Sin ubicación", lat: null, lng: null }
];

test("solo entran las rutas con asignación vigente, con el conductor y custodios reales", () => {
  const u = cargar();
  const r = u.armarUnidades(RUTAS, DISP, [], ENTREGAS);
  assert.deepEqual(plano(r.unidades.map(x => x.id)), ["R-IA", "R-MAN"]);
  assert.equal(r.sinAsignar, 1);        // R-LIBRE tiene viaje y «conductor» guardado, pero ninguna asignación
  assert.equal(r.sinTrazado, 1);        // R-SINPEDIDOS asignada pero sin destino ni pedidos ubicados
  const ia = r.unidades[0];
  assert.equal(ia.conductor, "José Antonio Martínez");
  assert.deepEqual(plano(ia.conductorInfo), { codigo: "DEMO-001", licencia: "2027-11-23" });
  assert.deepEqual(plano(ia.custodios.map(c => c.nombre)), ["Mario Ernesto Guzmán", "Fredy Portillo"]);
  assert.equal(ia.vehiculo.placa, "P 482-193");
  assert.equal(ia.riesgo, "Medio");
});

test("la ruta pasa por los pedidos en curso en su orden de visita", () => {
  const u = cargar();
  const [ia, manual] = u.armarUnidades(RUTAS, DISP, [], ENTREGAS).unidades;
  assert.deepEqual(plano(ia.paradas.map(p => p.texto)), ["Joyería", "Banco"]);   // orden_pedidos, sin el completado
  assert.equal(ia.destino.texto, "Metrocentro");
  // Ruta manual: sale del centro de San Salvador y termina en su último pedido ubicado.
  assert.equal(manual.origen.texto, "Centro de San Salvador");
  assert.deepEqual(plano(manual.paradas.map(p => p.texto)), ["Farmacia"]);
  assert.equal(manual.destino.texto, "Super");
  assert.equal(manual.riesgo, "Bajo");
  assert.equal(manual.salidaMs, Date.parse("2026-11-02T14:00:00Z"));   // sin horario: desde la asignación
});

test("coordenadas inválidas no se usan", () => {
  const u = cargar();
  assert.equal(u.lugarValido({ lat: null, lng: null }), null);
  assert.equal(u.lugarValido({ lat: 0, lng: 0 }), null);
  assert.deepEqual(plano(u.lugarValido({ texto: "X", lat: "13.7", lng: "-89.2" })), { texto: "X", lat: 13.7, lng: -89.2 });
});
