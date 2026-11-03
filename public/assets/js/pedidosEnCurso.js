/* =====================================================================
   PEDIDOS EN CURSO — SERSAPROSA   (reglas y selección; sin pantalla propia)

   La pantalla «Pedidos en curso» se quitó del menú: los pedidos se eligen con las
   casillas de la lista de Tracking de rutas (centroRutas.js). Este módulo conserva
   las reglas y la selección compartida que usan dashboard.js y centroRutas.js.
   Los datos los entrega dashboard.js (POST /entregas/listar); no hace peticiones.

   Expone una sola variable global: window.Pedidos
     Pedidos.store            selección de pedidos para la ruta en borrador (sessionStorage)
     Pedidos.enCurso(p)       ¿falta entregarlo?
     Pedidos.conUbicacion(p)  ¿tiene lat/lng válidas para trazar?
     Pedidos.filtrar / resumen  reglas puras (se prueban en tests/js/pedidos.test.js)

   SELECCIÓN: store.get() === null significa "el usuario aún no eligió" y se
   usan TODOS los pedidos en curso; un arreglo (aunque esté vacío) es la elección
   explícita. Solo cuentan los pedidos en curso con coordenadas para trazar la ruta.

   Contrato de cada pedido (lo que ya devuelve /entregas/listar):
     { id, cliente, direccion, hora:"HH:MM", estado:"pendiente|proceso|completada",
       zona, ruta, sin_ruta:boolean, contacto, productos, notas, lat, lng }
   ===================================================================== */
(function (global) {
  "use strict";

  const STORE_KEY = "pedidosSeleccion";

  /* ============ Reglas puras (se prueban sin pantalla) ============ */
  // En curso = todo lo que no está completado.
  const enCurso = pedido => !!pedido && pedido.estado !== "completada";
  // Con ubicación válida para poder trazar la ruta.
  const conUbicacion = pedido => !!pedido && pedido.lat != null && pedido.lng != null &&
    Number.isFinite(Number(pedido.lat)) && Number.isFinite(Number(pedido.lng)) &&
    Math.abs(Number(pedido.lat)) <= 90 && Math.abs(Number(pedido.lng)) <= 180;
  const norm = texto => String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  // Filtra la lista de la pantalla: por estado, zona y texto libre (cliente, dirección, ruta, productos).
  function filtrar(pedidos, f) {
    const q = norm(f.q).trim();
    return pedidos.filter(p => {
      if (!f.completados && !enCurso(p)) return false;
      if (f.estado && f.estado !== "todos" && p.estado !== f.estado) return false;
      if (f.zona && f.zona !== "todos" && p.zona !== f.zona) return false;
      return !q || norm([p.cliente, p.direccion, p.ruta, p.productos, p.zona].join(" ")).includes(q);
    });
  }

  function resumen(pedidos) {
    const curso = pedidos.filter(enCurso);
    return {
      enCurso: curso.length,
      pendientes: curso.filter(p => p.estado === "pendiente").length,
      proceso: curso.filter(p => p.estado === "proceso").length,
      completados: pedidos.length - curso.length,
      sinUbicacion: curso.filter(p => !conUbicacion(p)).length,
      sinRuta: curso.filter(p => p.sin_ruta).length
    };
  }

  /* ============ Selección compartida ============ */
  const store = (function () {
    let ids = null;
    const subs = new Set();
    try {
      const guardado = JSON.parse(global.sessionStorage.getItem(STORE_KEY));
      if (Array.isArray(guardado)) ids = guardado.map(String);
    } catch (e) { /* sin almacenamiento: la selección vive solo en memoria */ }

    function guardar() {
      try {
        if (ids === null) global.sessionStorage.removeItem(STORE_KEY);
        else global.sessionStorage.setItem(STORE_KEY, JSON.stringify(ids));
      } catch (e) { /* ignorar */ }
      subs.forEach(fn => fn(ids));
    }
    const todosEnCurso = pedidos => pedidos.filter(enCurso).map(p => String(p.id));

    return {
      get: () => (ids === null ? null : ids.slice()),
      // Pedidos en curso que cuentan para la ruta: los elegidos o, si no se eligió nada aún, todos.
      effective: pedidos => pedidos.filter(enCurso).filter(p => ids === null || ids.includes(String(p.id))),
      set(lista) { ids = lista === null ? null : lista.map(String); guardar(); },
      toggle(id, pedidos) {
        const base = ids === null ? todosEnCurso(pedidos) : ids;
        const sid = String(id);
        ids = base.includes(sid) ? base.filter(x => x !== sid) : base.concat(sid);
        guardar();
      },
      selectAll(pedidos) { ids = todosEnCurso(pedidos).filter(id => conUbicacion(pedidos.find(p => String(p.id) === id))); guardar(); },
      clear() { ids = []; guardar(); },
      subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
    };
  })();

  global.Pedidos = { store, enCurso, conUbicacion, filtrar, resumen };
})(window);
