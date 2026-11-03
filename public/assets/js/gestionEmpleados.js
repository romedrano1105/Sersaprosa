/* =====================================================================
   GESTIÓN DE PERSONAL — SERSAPROSA   (window.GestionEmpleados)

   Panel «Personal» de Empleados y Vehículos: conductores y guardias (custodios) REALES de la tabla
   empleados de Supabase. Alta, edición y baja lógica; muestra el estado de hoy (disponible, asignado a
   una ruta, licencia vencida, sin licencia, inactivo). La asignación a rutas sigue en el panel de
   disponibilidad (VerificarConduJS.js), que se recarga al guardar.

     POST /empleados/listar   POST /empleados/guardar   POST /empleados/estado   (empleados_router.py)

   Uso (lo hace dashboard.js):
     GestionEmpleados.mount(contenedor, { onChanged() {} })  →  { reload }
   Sin innerHTML para texto de usuario (ADR 0001).
   ===================================================================== */
(function (global) {
  "use strict";

  const CATEGORIAS = { conductor: "Conductor", guardia: "Guardia" };
  const ESTADOS = {
    disponible: ["ge-ok", "Disponible"],
    asignado: ["ge-info", "Asignado"],
    licencia_vencida: ["ge-no", "Licencia vencida"],
    sin_licencia: ["ge-warn", "Sin licencia"],
    inactivo: ["ge-off", "De baja"]
  };

  /* ============ Reglas puras (se prueban con node --test tests/js/empleados.test.js) ============ */

  const norm = t => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

  function validar(datos) {
    const d = datos || {};
    const errores = {};
    const nombre = String(d.nombre || "").replace(/\s+/g, " ").trim();
    if (nombre.length < 3 || nombre.length > 120) errores.nombre = "El nombre debe tener entre 3 y 120 caracteres.";
    if (!CATEGORIAS[d.categoria]) errores.categoria = "Elige conductor o guardia.";
    if (d.categoria === "conductor" && !/^\d{4}-\d{2}-\d{2}$/.test(String(d.licencia || ""))) {
      errores.licencia = "Un conductor necesita la fecha de vencimiento de su licencia.";
    }
    return {
      errores,
      limpio: {
        codigo: String(d.codigo || "").trim().toUpperCase() || null,
        nombre,
        categoria: d.categoria,
        licencia: d.categoria === "conductor" ? d.licencia || null : null,
        activo: d.activo !== false
      }
    };
  }

  function filtrar(lista, f) {
    const q = norm(f && f.texto);
    return (lista || []).filter(e =>
      (!f || !f.categoria || e.categoria === f.categoria) &&
      (!f || !f.estado || (f.estado === "activos" ? e.activo : f.estado === "inactivos" ? !e.activo : e.estado === f.estado)) &&
      (!q || norm([e.nombre, e.codigo, e.asignacion && e.asignacion.ruta].join(" ")).includes(q)));
  }

  function textoEstado(e) {
    if (e.estado === "asignado" && e.asignacion) {
      return (e.asignacion.rol === "guardia" ? "Custodio en " : "Conduce ") + e.asignacion.ruta;
    }
    return (ESTADOS[e.estado] || ["", e.estado])[1];
  }

  function fechaCorta(iso) {
    if (!iso) return "—";
    const [a, m, d] = String(iso).slice(0, 10).split("-");
    return d && m && a ? d + "/" + m + "/" + a : "—";
  }

  /* ============ DOM ============ */

  function h(tag, attrs, ...hijos) {
    const node = global.document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (k === "checked" || k === "disabled" || k === "selected") node[k] = !!v;
      else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
    });
    hijos.flat().filter(c => c != null && c !== false).forEach(c => {
      node.append(typeof c === "string" || typeof c === "number" ? global.document.createTextNode(String(c)) : c);
    });
    return node;
  }

  function mount(contenedor, opciones) {
    if (!contenedor) throw new Error("No se encontró el contenedor de personal.");
    const cfg = Object.assign({ onChanged: null }, opciones || {});
    const sesion = global.Api && global.Api.session();
    if (!sesion || sesion.role !== "coordinador_rutas") {
      contenedor.replaceChildren(h("p", { class: "ge-vacio" }, "La gestión de personal es solo para el coordinador de rutas."));
      return { reload() {} };
    }
    const S = { lista: [], resumen: null, cargado: false, error: "", mensaje: null, filtros: { categoria: "", estado: "activos", texto: "" }, modal: null };
    const ui = {};

    function construir() {
      const sel = (id, opciones, valor, alCambiar) => h("select", { id, class: "ge-input", onchange: e => alCambiar(e.target.value) },
        opciones.map(([v, t]) => h("option", { value: v, selected: v === valor }, t)));
      ui.resumen = h("p", { class: "ge-resumen", "aria-live": "polite" });
      ui.avisos = h("div", { class: "ge-avisos" });
      ui.tabla = h("div", { class: "ge-tabla-wrap" });
      contenedor.replaceChildren(h("section", { class: "ge", "aria-label": "Personal" },
        h("header", { class: "ge-cab" },
          h("div", {}, h("h3", {}, "Personal"), ui.resumen),
          h("button", { type: "button", class: "ge-btn ge-prim", onclick: () => abrirFormulario(null) }, "+ Agregar empleado")),
        h("div", { class: "ge-filtros" },
          sel("ge-f-cat", [["", "Todas las categorías"], ["conductor", "Conductores"], ["guardia", "Guardias"]], "", v => { S.filtros.categoria = v; pintar(); }),
          sel("ge-f-est", [["activos", "Activos"], ["disponible", "Disponibles"], ["asignado", "Asignados hoy"], ["licencia_vencida", "Licencia vencida"], ["inactivos", "De baja"], ["", "Todos"]], "activos",
            v => { S.filtros.estado = v; pintar(); }),
          h("input", { type: "search", class: "ge-input", placeholder: "Buscar nombre, código o ruta", "aria-label": "Buscar empleado", maxlength: "60",
            oninput: e => { S.filtros.texto = e.target.value; pintar(); } })),
        ui.avisos, ui.tabla));
    }

    async function cargar() {
      try {
        const datos = await global.Api.post("/empleados/listar", {});
        S.lista = Array.isArray(datos.empleados) ? datos.empleados : [];
        S.resumen = datos.resumen || null;
        S.cargado = true;
        S.error = "";
      } catch (error) {
        if (!global.Api.session()) return;
        S.error = error.message || "No se pudo cargar el personal.";
      }
      pintar();
    }

    function pintar() {
      const r = S.resumen;
      ui.resumen.textContent = r ? r.conductores + " conductores · " + r.guardias + " guardias activos · " + r.asignados + " asignados hoy" : "";
      const avisos = [];
      if (S.mensaje) avisos.push(h("p", { class: "ge-msg ge-msg-" + S.mensaje.tipo, role: "status" }, S.mensaje.texto));
      if (S.error) avisos.push(h("div", { class: "ge-msg ge-msg-error", role: "alert" }, h("span", {}, S.error),
        h("button", { type: "button", class: "ge-btn", onclick: cargar }, "Reintentar")));
      ui.avisos.replaceChildren(...avisos);
      if (!S.cargado) {
        ui.tabla.replaceChildren(h("p", { class: "ge-vacio" }, S.error ? "No se pudo mostrar el personal." : "Cargando personal…"));
        return;
      }
      const filas = filtrar(S.lista, S.filtros);
      if (!filas.length) {
        ui.tabla.replaceChildren(h("p", { class: "ge-vacio" }, S.lista.length ? "Nadie coincide con el filtro." : "Todavía no hay empleados registrados. Agrega el primero."));
        return;
      }
      ui.tabla.replaceChildren(h("table", { class: "ge-tabla" },
        h("thead", {}, h("tr", {}, ["Nombre", "Código", "Categoría", "Licencia vence", "Estado hoy", ""].map(t => h("th", { scope: "col" }, t)))),
        h("tbody", {}, filas.map(e => {
          const [clase] = ESTADOS[e.estado] || ["ge-off"];
          return h("tr", { class: e.activo ? "" : "ge-fila-off" },
            h("td", {}, h("strong", {}, e.nombre)),
            h("td", { class: "ge-num" }, e.codigo),
            h("td", {}, h("span", { class: "ge-cat ge-cat-" + e.categoria }, CATEGORIAS[e.categoria] || e.categoria)),
            h("td", { class: "ge-num" + (e.estado === "licencia_vencida" ? " ge-txt-no" : "") }, e.categoria === "conductor" ? fechaCorta(e.licencia) : "No aplica"),
            h("td", {}, h("span", { class: "ge-pill " + clase }, textoEstado(e))),
            h("td", { class: "ge-acciones" },
              h("button", { type: "button", class: "ge-btn", onclick: () => abrirFormulario(e) }, "Editar"),
              h("button", { type: "button", class: "ge-btn" + (e.activo ? " ge-btn-no" : ""), disabled: e.activo && e.estado === "asignado",
                title: e.activo && e.estado === "asignado" ? "Tiene una ruta asignada hoy: desasígnala primero" : "",
                onclick: () => cambiarEstado(e) }, e.activo ? "Dar de baja" : "Reactivar")));
        }))));
    }

    async function cambiarEstado(e) {
      if (e.activo && !global.confirm("¿Dar de baja a " + e.nombre + "?\nNo se borra: deja de aparecer para asignar y se puede reactivar.")) return;
      try {
        await global.Api.post("/empleados/estado", { codigo: e.codigo, activo: !e.activo });
        S.mensaje = { tipo: "ok", texto: e.nombre + (e.activo ? " quedó de baja." : " quedó activo otra vez.") };
        await despuesDeCambio();
      } catch (error) {
        S.mensaje = { tipo: "error", texto: error.message || "No se pudo cambiar el estado." };
        pintar();
      }
    }

    async function despuesDeCambio() {
      await cargar();
      if (typeof cfg.onChanged === "function") cfg.onChanged();
    }

    function cerrarFormulario() {
      if (S.modal) { S.modal.remove(); S.modal = null; }
      global.document.removeEventListener("keydown", alTeclear);
    }
    function alTeclear(ev) { if (ev.key === "Escape") cerrarFormulario(); }

    function abrirFormulario(e) {
      cerrarFormulario();
      const editando = !!e;
      const f = {
        nombre: h("input", { id: "ge-nombre", class: "ge-input", maxlength: "120", value: e ? e.nombre : "", autocomplete: "off" }),
        categoria: h("select", { id: "ge-categoria", class: "ge-input" },
          Object.entries(CATEGORIAS).map(([v, t]) => h("option", { value: v, selected: (e ? e.categoria : "conductor") === v }, t))),
        licencia: h("input", { id: "ge-licencia", class: "ge-input", type: "date", value: e && e.licencia ? String(e.licencia).slice(0, 10) : "" }),
        codigo: h("input", { id: "ge-codigo", class: "ge-input", maxlength: "40", value: e ? e.codigo : "", placeholder: "Automático (CON-001, GUA-001…)", disabled: editando }),
        error: h("p", { class: "ge-form-error", role: "alert", hidden: true })
      };
      const filaLicencia = h("div", { class: "ge-campo" }, h("label", { for: "ge-licencia" }, "Vencimiento de la licencia de conducir"), f.licencia);
      const verLicencia = () => { filaLicencia.hidden = f.categoria.value !== "conductor"; };
      f.categoria.addEventListener("change", verLicencia);
      verLicencia();
      const guardar = h("button", { type: "submit", class: "ge-btn ge-prim" }, editando ? "Guardar cambios" : "Agregar");
      const form = h("form", { class: "ge-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "ge-titulo", novalidate: true },
        h("div", { class: "ge-modal-cab" }, h("h3", { id: "ge-titulo" }, editando ? "Editar empleado" : "Agregar empleado"),
          h("button", { type: "button", class: "ge-x", "aria-label": "Cerrar", onclick: cerrarFormulario }, "×")),
        h("div", { class: "ge-campo" }, h("label", { for: "ge-nombre" }, "Nombre completo"), f.nombre),
        h("div", { class: "ge-campo" }, h("label", { for: "ge-categoria" }, "Categoría"), f.categoria),
        filaLicencia,
        h("div", { class: "ge-campo" }, h("label", { for: "ge-codigo" }, "Código de empleado"), f.codigo),
        f.error,
        h("div", { class: "ge-modal-acciones" }, h("button", { type: "button", class: "ge-btn", onclick: cerrarFormulario }, "Cancelar"), guardar));
      form.addEventListener("submit", async ev => {
        ev.preventDefault();
        const { errores, limpio } = validar({
          codigo: editando ? e.codigo : f.codigo.value, nombre: f.nombre.value, categoria: f.categoria.value,
          licencia: f.licencia.value, activo: editando ? e.activo : true
        });
        if (Object.keys(errores).length) {
          f.error.textContent = Object.values(errores).join(" ");
          f.error.hidden = false;
          return;
        }
        guardar.disabled = true;
        try {
          const r = await global.Api.post("/empleados/guardar", limpio);
          cerrarFormulario();
          S.mensaje = { tipo: "ok", texto: r.creado ? r.nombre + " quedó registrado con el código " + r.codigo + "." : "Cambios guardados para " + r.nombre + "." };
          await despuesDeCambio();
        } catch (error) {
          f.error.textContent = error.message || "No se pudo guardar.";
          f.error.hidden = false;
          guardar.disabled = false;
        }
      });
      S.modal = h("div", { class: "ge-fondo", onclick: ev => { if (ev.target === S.modal) cerrarFormulario(); } }, form);
      global.document.body.append(S.modal);
      global.document.addEventListener("keydown", alTeclear);
      f.nombre.focus();
    }

    construir();
    pintar();
    cargar();
    return { reload: cargar };
  }

  global.GestionEmpleados = { mount, util: { validar, filtrar, textoEstado, fechaCorta } };
})(window);
