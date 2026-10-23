/* =====================================================================
   VIAJES — SERSAPROSA   (window.Viajes)

   Formulario «Nuevo viaje» (origen, destino, horario, tipo de carga y monto) con el botón
   GENERAR RUTA, y el mismo formulario para editar mientras la ruta no haya salido.

     Viajes.abrir({ modo: "nuevo" | "editar", ruta, pedidos: { ids, eleccion }, post, get, onSaved(resultado) })
     Viajes.util.validar(datos)   reglas puras (mismas que backend/app/viajes_logica.py)

   El servidor vuelve a validar todo: este archivo solo evita viajes de ida y vuelta y muestra
   qué campos faltan. Los textos del usuario se insertan como texto, nunca como HTML.
   ===================================================================== */
(function (global) {
  "use strict";

  // Mantener alineado con ENTREGAS_HORA_INICIO / ENTREGAS_HORA_FIN de viajes_logica.py.
  const HORARIO = { inicio: "06:00", fin: "20:00" };
  const ETIQUETAS = { origen: "Origen", destino: "Destino", horario: "Horario", tipo_carga_id: "Tipo de carga", monto: "Monto" };
  const ORDEN = ["origen", "destino", "horario", "tipo_carga_id", "monto"];

  /* ============ Reglas puras ============ */
  const minutos = texto => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(texto || "").trim());
    return m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? Number(m[1]) * 60 + Number(m[2]) : null;
  };

  function validar(datos) {
    const d = datos || {};
    const errores = {};
    const limpio = valor => String(valor == null ? "" : valor).replace(/\s+/g, " ").trim();
    const origen = limpio(d.origen), destino = limpio(d.destino);
    if (!origen) errores.origen = "Origen es obligatorio.";
    else if (origen.length < 3 || origen.length > 200) errores.origen = "Origen debe tener entre 3 y 200 caracteres.";
    if (!destino) errores.destino = "Destino es obligatorio.";
    else if (destino.length < 3 || destino.length > 200) errores.destino = "Destino debe tener entre 3 y 200 caracteres.";
    else if (origen && origen.toLowerCase() === destino.toLowerCase()) errores.destino = "El destino debe ser distinto del origen.";

    const horario = limpio(d.horario);
    if (!horario) errores.horario = "Horario es obligatorio.";
    else if (minutos(horario) === null) errores.horario = "El horario debe tener formato HH:MM.";
    else if (minutos(horario) < minutos(HORARIO.inicio) || minutos(horario) > minutos(HORARIO.fin)) {
      errores.horario = "No se realizan entregas a esa hora: el horario permitido es de " + HORARIO.inicio + " a " + HORARIO.fin + ".";
    }

    if (d.tipo_carga_id == null || limpio(d.tipo_carga_id) === "") errores.tipo_carga_id = "Tipo de carga es obligatorio.";

    const bruto = limpio(d.monto);
    if (!bruto) errores.monto = "Monto es obligatorio.";
    else if (!/^\d+(\.\d{1,2})?$/.test(bruto)) errores.monto = /^-?\d+(\.\d+)?$/.test(bruto) && Number(bruto) > 0
      ? "El monto admite como máximo 2 decimales." : "El monto debe ser un número mayor a cero.";
    else if (Number(bruto) <= 0) errores.monto = "El monto debe ser mayor a cero.";
    return errores;
  }

  // «Faltan campos obligatorios: Origen, Horario.» + el resto de los problemas.
  function resumen(errores) {
    const faltan = ORDEN.filter(c => errores[c] && /es obligatorio\.$/.test(errores[c])).map(c => ETIQUETAS[c]);
    const otros = ORDEN.filter(c => errores[c] && !/es obligatorio\.$/.test(errores[c])).map(c => errores[c]);
    return (faltan.length ? ["Faltan campos obligatorios: " + faltan.join(", ") + "."] : []).concat(otros).join(" ");
  }

  /* ============ Pantalla ============ */
  function h(tag, attrs, ...kids) {
    const e = global.document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "checked" || k === "disabled" || k === "value") e[k] = v;
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null) e.append(c);
    return e;
  }

  let tiposCache = null;

  async function cargarTipos(get) {
    if (!tiposCache) {
      const lista = await get("/rutas-riesgo/tipos-carga");
      if (!Array.isArray(lista)) throw new Error("No se pudieron cargar los tipos de carga.");
      tiposCache = lista;
    }
    return tiposCache;
  }

  async function abrir(opciones) {
    const o = Object.assign({ modo: "nuevo", ruta: null, pedidos: { ids: [], eleccion: false }, post: null, get: null, onSaved: null }, opciones || {});
    const editar = o.modo === "editar" && o.ruta && o.ruta.viaje;
    const previo = editar ? o.ruta.viaje : null;
    let abierto = true;

    const campo = (clave, etiqueta, control, ayuda) => h("div", { class: "vj-field", "data-campo": clave },
      h("label", {}, etiqueta, " ", h("span", { class: "vj-req", "aria-hidden": "true" }, "*")), control,
      ayuda ? h("small", {}, ayuda) : null, h("p", { class: "vj-error", role: "alert", id: "vj-err-" + clave }));
    const origen = h("input", { type: "text", maxlength: "200", class: "cc-input", autocomplete: "off", placeholder: "Ej. Bodega central, San Salvador", value: previo ? previo.origen.texto : "" });
    const destino = h("input", { type: "text", maxlength: "200", class: "cc-input", autocomplete: "off", placeholder: "Ej. Metrocentro, San Salvador", value: previo ? previo.destino.texto : "" });
    const horario = h("input", { type: "time", class: "cc-input", value: previo ? previo.horario : "", min: HORARIO.inicio, max: HORARIO.fin });
    const tipo = h("select", { class: "cc-input" }, h("option", { value: "" }, "Cargando tipos…"));
    const monto = h("input", { type: "number", class: "cc-input", min: "0.01", step: "0.01", inputmode: "decimal", placeholder: "0.00", value: previo && previo.monto != null ? String(previo.monto) : "" });
    const incluir = h("input", { type: "checkbox", checked: false, disabled: editar || !o.pedidos.eleccion });
    const controles = { origen, destino, horario, tipo_carga_id: tipo, monto };

    const resumenCaja = h("p", { class: "cc-modal-error vj-summary", role: "alert", hidden: true });
    const enviar = h("button", { type: "button", class: "cc-btn cc-primary" }, editar ? "GUARDAR CAMBIOS" : "GENERAR RUTA");
    const cancelar = h("button", { type: "button", class: "cc-btn" }, "Cancelar");
    const cuerpo = h("div", { class: "vj-form" },
      resumenCaja,
      campo("origen", "Origen", origen),
      campo("destino", "Destino", destino),
      h("div", { class: "vj-row" },
        campo("horario", "Horario de salida", horario, "Entregas de " + HORARIO.inicio + " a " + HORARIO.fin),
        campo("monto", "Monto de la carga (USD)", monto)),
      campo("tipo_carga_id", "Tipo de carga", tipo),
      editar ? null : h("label", { class: "vj-check" }, incluir,
        h("span", {}, o.pedidos.eleccion ? "Incluir los " + o.pedidos.ids.length + " pedidos marcados en la lista" : "Marca pedidos en la lista para incluirlos (opcional)")),
      editar ? h("p", { class: "cc-hint" }, "Solo se puede editar mientras la ruta no haya salido (sin conductor asignado).") : null);

    const titulo = editar ? "Editar viaje" : "Nuevo viaje";
    const fondo = h("div", { class: "cc-backdrop" },
      h("div", { class: "cc-modal", role: "dialog", "aria-modal": "true", "aria-label": titulo },
        h("div", { class: "cc-modal-head" }, h("h3", {}, titulo), h("button", { type: "button", class: "cc-x", "aria-label": "Cerrar", onclick: cerrar }, "×")),
        h("div", { class: "cc-modal-body" }, cuerpo),
        h("div", { class: "cc-modal-actions" }, cancelar, enviar)));

    function cerrar() {
      if (!abierto) return;
      abierto = false;
      fondo.remove();
      global.document.removeEventListener("keydown", esc);
    }
    function esc(e) { if (e.key === "Escape" && !enviar.disabled) cerrar(); }
    cancelar.addEventListener("click", cerrar);
    fondo.addEventListener("click", e => { if (e.target === fondo && !enviar.disabled) cerrar(); });
    global.document.addEventListener("keydown", esc);
    global.document.body.append(fondo);
    origen.focus();

    function pintar(errores, mensaje) {
      ORDEN.forEach(c => {
        const nodo = cuerpo.querySelector("#vj-err-" + c);
        nodo.textContent = errores[c] || "";
        controles[c].setAttribute("aria-invalid", errores[c] ? "true" : "false");
        controles[c].setAttribute("aria-describedby", "vj-err-" + c);
      });
      resumenCaja.hidden = !mensaje;
      resumenCaja.textContent = mensaje || "";
      const primero = ORDEN.find(c => errores[c]);
      if (primero) controles[primero].focus();
    }
    const leer = () => ({ origen: origen.value, destino: destino.value, horario: horario.value, tipo_carga_id: tipo.value, monto: monto.value });

    try {
      const tipos = await cargarTipos(o.get);
      tipo.replaceChildren(h("option", { value: "" }, "Selecciona un tipo…"),
        ...tipos.map(t => h("option", { value: String(t.id) }, t.nombre)));
      if (previo && previo.tipo_carga_id != null) tipo.value = String(previo.tipo_carga_id);
    } catch (error) {
      tipo.replaceChildren(h("option", { value: "" }, "No disponible"));
      pintar({}, error.message || "No se pudieron cargar los tipos de carga.");
    }

    enviar.addEventListener("click", async () => {
      const datos = leer();
      const errores = validar(datos);
      if (Object.keys(errores).length) { pintar(errores, resumen(errores)); return; }   // no se genera la ruta
      pintar({}, "");
      enviar.disabled = cancelar.disabled = true;
      enviar.textContent = editar ? "Guardando…" : "Generando ruta…";
      try {
        const cuerpoPeticion = Object.assign({}, datos, { tipo_carga_id: Number(datos.tipo_carga_id) });
        const resultado = editar
          ? await o.post("/viajes/actualizar", Object.assign({ id: o.ruta.id }, cuerpoPeticion))
          : await o.post("/viajes/generar", Object.assign({ pedidos: incluir.checked ? o.pedidos.ids : [] }, cuerpoPeticion));
        cerrar();
        if (typeof o.onSaved === "function") await o.onSaved(resultado);
      } catch (error) {
        pintar({}, error.message || "No se pudo completar la operación.");
        enviar.disabled = cancelar.disabled = false;
        enviar.textContent = editar ? "GUARDAR CAMBIOS" : "GENERAR RUTA";
      }
    });
    return { cerrar };
  }

  global.Viajes = { abrir, util: { validar, resumen, HORARIO } };
})(window);
