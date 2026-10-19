(() => {
  "use strict";

  const API = "/rutas-riesgo";
  const MONTO_MAXIMO = 1e12;
  const fmtMonto = new Intl.NumberFormat("es-SV", { style: "currency", currency: "USD" });
  const fmtFecha = new Intl.DateTimeFormat("es-SV", { dateStyle: "medium", timeStyle: "short" });
  const $ = (id) => document.getElementById(id);

  const el = {
    form: $("rr-form"), ruta: $("rr-ruta"), monto: $("rr-monto"), tipo: $("rr-tipo"),
    nivel: $("rr-nivel"), estado: $("rr-estado"), tbody: $("rr-tbody"), detalle: $("rr-detalle"),
  };
  const campos = {
    ruta: { input: el.ruta, error: $("rr-err-ruta") },
    monto: { input: el.monto, error: $("rr-err-monto") },
    tipo_carga_id: { input: el.tipo, error: $("rr-err-tipo") },
  };

  let rutas = [];

    // ---------- Sesión y API ----------
  // AJUSTA: agrega aquí la clave exacta con la que tu login guarda data.token.
  const CLAVES_TOKEN = ["token", "access_token", "sersaprosa_token", "authToken", "jwt"];

  function obtenerToken() {
    for (const almacen of [localStorage, sessionStorage]) {
      for (const clave of CLAVES_TOKEN) {
        const valor = almacen.getItem(clave);
        if (valor) return valor;
      }
    }
    return "";
  }
  async function api(ruta, { method = "GET", body } = {}) {
    const token = obtenerToken();
    if (!token) {
      window.location.href = "/"; // AJUSTA: página de login
      throw new Error("Sin sesión");
    }
    const resp = await fetch(API + ruta, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const datos = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const detalle = datos.detail && typeof datos.detail === "object" ? datos.detail : {};
      const err = new Error(detalle.mensaje || "No se pudo completar la operación.");
      err.status = resp.status;
      err.errores = detalle.errores || {};
      throw err;
    }
    return datos;
  }

  // ---------- Utilidades de UI ----------
  function nombreRuta(r) {
    return r.nombre || r.descripcion || r.codigo || `Ruta ${r.id}`;
  }

  function crearBadge(nivel) {
    const span = document.createElement("span");
    if (!nivel) {
      span.className = "rr-badge rr-badge--vacio";
      span.textContent = "Sin especificar";
    } else {
      span.className = `rr-badge rr-badge--${nivel.toLowerCase()}`;
      span.textContent = nivel;
    }
    return span;
  }

  function mostrarNivel(nivel) {
    el.nivel.replaceChildren();
    if (nivel) {
      el.nivel.append(crearBadge(nivel));
    } else {
      const s = document.createElement("span");
      s.className = "rr-badge rr-badge--vacio";
      s.textContent = "Se calculará al ingresar monto y tipo";
      el.nivel.append(s);
    }
  }

  function limpiarErrores() {
    Object.values(campos).forEach(({ input, error }) => {
      error.textContent = "";
      input.classList.remove("rr-invalido");
      input.removeAttribute("aria-invalid");
    });
  }

  function mostrarErrores(errores) {
    Object.entries(errores || {}).forEach(([clave, mensaje]) => {
      const c = campos[clave];
      if (!c) return;
      c.error.textContent = mensaje;
      c.input.classList.add("rr-invalido");
      c.input.setAttribute("aria-invalid", "true");
    });
  }

  function estado(texto, esError = false) {
    el.estado.textContent = texto;
    el.estado.className = "rr-estado " + (texto ? (esError ? "rr-estado--error" : "rr-estado--ok") : "");
  }

  // ---------- Validación en el cliente (el servidor vuelve a validar) ----------
  function validarMontoYTipo() {
    const errores = {};
    const crudo = el.monto.value.trim();
    if (!crudo) {
      errores.monto = "El monto es obligatorio.";
    } else {
      const n = Number(crudo);
      if (!Number.isFinite(n)) errores.monto = "El monto debe ser numérico.";
      else if (n <= 0) errores.monto = "El monto debe ser mayor a cero.";
      else if (n >= MONTO_MAXIMO) errores.monto = "El monto es demasiado grande.";
    }
    if (!el.tipo.value) errores.tipo_carga_id = "El tipo de carga es obligatorio.";
    return errores;
  }

  // ---------- Cálculo automático del riesgo ----------
  let temporizador = null;
  let secuencia = 0;

  function programarCalculo() {
    clearTimeout(temporizador);
    temporizador = setTimeout(calcularRiesgo, 300);
  }

  async function calcularRiesgo() {
    const mia = ++secuencia;
    if (Object.keys(validarMontoYTipo()).length) {
      mostrarNivel(null); // nunca se muestra un riesgo "por defecto"
      return;
    }
    try {
      const r = await api("/calcular", {
        method: "POST",
        body: { monto: el.monto.value.trim(), tipo_carga_id: Number(el.tipo.value) },
      });
      if (mia === secuencia) mostrarNivel(r.nivel_riesgo);
    } catch (err) {
      if (mia !== secuencia) return;
      mostrarNivel(null);
      mostrarErrores(err.errores);
      estado(err.message, true);
    }
  }

  // ---------- Carga de datos ----------
  async function cargarTipos() {
    const tipos = await api("/tipos-carga");
    tipos.forEach((t) => {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = t.nombre;
      el.tipo.append(o);
    });
  }

  async function cargarRutas() {
    rutas = await api("");
    const seleccion = el.ruta.value;
    el.ruta.replaceChildren(new Option("Selecciona una ruta…", ""));
    rutas.forEach((r) => el.ruta.append(new Option(nombreRuta(r), r.id)));
    el.ruta.value = seleccion;
    renderListado();
  }

  function renderListado() {
    el.tbody.replaceChildren();
    if (!rutas.length) {
      const tr = el.tbody.insertRow();
      const td = tr.insertCell();
      td.colSpan = 5;
      td.textContent = "No hay rutas registradas.";
      return;
    }
    rutas.forEach((r) => {
      const tr = el.tbody.insertRow();
      tr.insertCell().textContent = nombreRuta(r);
      tr.insertCell().textContent = r.monto != null ? fmtMonto.format(r.monto) : "—";
      tr.insertCell().textContent = r.tipo_carga || "—";
      tr.insertCell().append(crearBadge(r.nivel_riesgo));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rr-boton rr-boton--link";
      btn.textContent = "Ver detalle";
      btn.addEventListener("click", () => mostrarDetalle(r.id));
      tr.insertCell().append(btn);
    });
  }

  async function mostrarDetalle(id) {
    try {
      const r = await api(`/${id}`);
      const dl = document.createElement("dl");
      dl.className = "rr-detalle-grid";
      const fila = (etiqueta, valor) => {
        const dt = document.createElement("dt");
        dt.textContent = etiqueta;
        const dd = document.createElement("dd");
        if (valor instanceof Node) dd.append(valor); else dd.textContent = valor;
        dl.append(dt, dd);
      };
      fila("Ruta", nombreRuta(r));
      fila("Monto", r.monto != null ? fmtMonto.format(r.monto) : "—");
      fila("Tipo de carga", r.tipo_carga || "—");
      fila("Nivel de riesgo", crearBadge(r.nivel_riesgo));
      fila("Especificado por", r.riesgo_especificado_por || "—");
      fila("Fecha y hora", r.riesgo_especificado_en ? fmtFecha.format(new Date(r.riesgo_especificado_en)) : "—");

      const titulo = document.createElement("h2");
      titulo.textContent = "Detalle de la ruta";
      el.detalle.replaceChildren(titulo, dl);
      el.detalle.hidden = false;
    } catch (err) {
      estado(err.message, true);
    }
  }

  // ---------- Edición: al elegir ruta se precargan sus datos ----------
  el.ruta.addEventListener("change", () => {
    limpiarErrores();
    estado("");
    const r = rutas.find((x) => String(x.id) === el.ruta.value);
    el.monto.value = r && r.monto != null ? r.monto : "";
    el.tipo.value = r && r.tipo_carga_id != null ? r.tipo_carga_id : "";
    calcularRiesgo();
  });

  el.monto.addEventListener("input", programarCalculo);
  el.tipo.addEventListener("change", programarCalculo);

  // ---------- Guardar ----------
  el.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    limpiarErrores();
    estado("");

    const errores = validarMontoYTipo();
    if (!el.ruta.value) errores.ruta = "Selecciona la ruta.";
    if (Object.keys(errores).length) {
      mostrarErrores(errores);
      estado("No se guardó: revisa los campos marcados.", true);
      return;
    }

    const boton = el.form.querySelector("button[type=submit]");
    boton.disabled = true;
    try {
      const r = await api(`/${el.ruta.value}`, {
        method: "PUT",
        body: { monto: el.monto.value.trim(), tipo_carga_id: Number(el.tipo.value) },
      });
      mostrarNivel(r.nivel_riesgo);
      estado("Ruta guardada correctamente.");
      await cargarRutas();
      await mostrarDetalle(Number(el.ruta.value));
    } catch (err) {
      mostrarErrores(err.errores);
      estado(err.message, true);
    } finally {
      boton.disabled = false;
    }
  });

  // ---------- Inicio ----------
  (async () => {
    try {
      await Promise.all([cargarTipos(), cargarRutas()]);
    } catch (err) {
      estado(err.message, true);
    }
  })();
})();