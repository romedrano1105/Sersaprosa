(() => {
  "use strict";

  const API = "/rutas-riesgo";
  const MONTO_MAXIMO = 1e12;

  const fmtMonto = new Intl.NumberFormat("es-SV", {
    style: "currency",
    currency: "USD",
  });

  const fmtFecha = new Intl.DateTimeFormat("es-SV", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const $ = (id) => document.getElementById(id);

  const el = {
    form: $("rr-form"),
    ruta: $("rr-ruta"),
    monto: $("rr-monto"),
    tipo: $("rr-tipo"),
    nivel: $("rr-nivel"),
    estado: $("rr-estado"),
    tbody: $("rr-tbody"),
    detalle: $("rr-detalle"),
  };

  const campos = {
    ruta: { input: el.ruta, error: $("rr-err-ruta") },
    monto: { input: el.monto, error: $("rr-err-monto") },
    tipo_carga_id: { input: el.tipo, error: $("rr-err-tipo") },
  };

  let rutas = [];
  let temporizador = null;
  let secuencia = 0;

  function obtenerToken() {
    try {
      const sesion = JSON.parse(
        sessionStorage.getItem("session") || "null"
      );

      if (sesion && typeof sesion.token === "string") {
        return sesion.token.trim();
      }
    } catch (error) {
      console.error("No se pudo leer la sesión.", error);
    }

    // Compatibilidad por si existe una sesión antigua.
    for (const almacen of [sessionStorage, localStorage]) {
      for (const clave of [
        "token",
        "access_token",
        "sersaprosa_token",
        "authToken",
        "jwt",
      ]) {
        const valor = almacen.getItem(clave);
        if (valor) return valor;
      }
    }

    return "";
  }

  async function api(ruta, opciones = {}) {
    const { method = "GET", body } = opciones;
    const token = obtenerToken();

    if (!token) {
      throw new Error(
        "No se encontró la sesión. Regresa a la página principal e inicia sesión."
      );
    }

    let resp;

    try {
      resp = await fetch(API + ruta, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(
        "No se pudo conectar con el servidor. Verifica que FastAPI esté iniciado."
      );
    }

    const datos = await resp.json().catch(() => ({}));

    if (resp.status === 401) {
      if (
        window.AppNavigation &&
        typeof window.AppNavigation.handleUnauthorized === "function"
      ) {
        window.AppNavigation.handleUnauthorized();
      }

      throw new Error("La sesión venció. Inicia sesión de nuevo.");
    }

    if (!resp.ok) {
      const detalle = datos.detail;
      const mensaje =
        typeof detalle === "string"
          ? detalle
          : detalle && typeof detalle === "object"
            ? detalle.mensaje || detalle.message
            : null;

      const err = new Error(
        mensaje || `No se pudo completar la operación (HTTP ${resp.status}).`
      );

      err.status = resp.status;
      err.errores =
        detalle && typeof detalle === "object"
          ? detalle.errores || {}
          : {};

      throw err;
    }

    return datos;
  }

  function nombreRuta(r) {
    return r.nombre || r.descripcion || r.codigo || `Ruta ${r.id}`;
  }

  function crearBadge(nivel) {
    const span = document.createElement("span");

    if (!nivel) {
      span.className = "rr-badge rr-badge--vacio";
      span.textContent = "Sin especificar";
    } else {
      span.className = `rr-badge rr-badge--${String(nivel).toLowerCase()}`;
      span.textContent = nivel;
    }

    return span;
  }

  function mostrarNivel(nivel) {
    el.nivel.replaceChildren();

    if (nivel) {
      el.nivel.append(crearBadge(nivel));
    } else {
      const span = document.createElement("span");
      span.className = "rr-badge rr-badge--vacio";
      span.textContent = "Se calculará al ingresar monto y tipo";
      el.nivel.append(span);
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
      const campo = campos[clave];
      if (!campo) return;

      campo.error.textContent = mensaje;
      campo.input.classList.add("rr-invalido");
      campo.input.setAttribute("aria-invalid", "true");
    });
  }

  function estado(texto, esError = false) {
    el.estado.textContent = texto;
    el.estado.className =
      "rr-estado " +
      (texto ? (esError ? "rr-estado--error" : "rr-estado--ok") : "");
  }

  function validarMontoYTipo() {
    const errores = {};
    const crudo = el.monto.value.trim();

    if (!crudo) {
      errores.monto = "El monto es obligatorio.";
    } else {
      const monto = Number(crudo);

      if (!Number.isFinite(monto)) {
        errores.monto = "El monto debe ser numérico.";
      } else if (monto <= 0) {
        errores.monto = "El monto debe ser mayor a cero.";
      } else if (monto >= MONTO_MAXIMO) {
        errores.monto = "El monto es demasiado grande.";
      }
    }

    if (!el.tipo.value) {
      errores.tipo_carga_id = "El tipo de carga es obligatorio.";
    }

    return errores;
  }

  function programarCalculo() {
    clearTimeout(temporizador);
    temporizador = setTimeout(calcularRiesgo, 300);
  }

  async function calcularRiesgo() {
    const miSecuencia = ++secuencia;

    if (Object.keys(validarMontoYTipo()).length) {
      mostrarNivel(null);
      return;
    }

    try {
      const resultado = await api("/calcular", {
        method: "POST",
        body: {
          monto: el.monto.value.trim(),
          tipo_carga_id: Number(el.tipo.value),
        },
      });

      if (miSecuencia === secuencia) {
        mostrarNivel(resultado.nivel_riesgo);
        estado("");
      }
    } catch (error) {
      if (miSecuencia !== secuencia) return;

      mostrarNivel(null);
      mostrarErrores(error.errores);
      estado(error.message, true);
    }
  }

  async function cargarTipos() {
    const tipos = await api("/tipos-carga");

    if (!Array.isArray(tipos)) {
      throw new Error("La API no devolvió una lista válida de tipos de carga.");
    }

    const seleccionado = el.tipo.value;
    el.tipo.replaceChildren(new Option("Selecciona un tipo…", ""));

    tipos.forEach((tipo) => {
      el.tipo.append(new Option(tipo.nombre, String(tipo.id)));
    });

    el.tipo.value = seleccionado;
  }

  async function cargarRutas() {
    const resultado = await api("");

    if (!Array.isArray(resultado)) {
      throw new Error("La API no devolvió una lista válida de rutas.");
    }

    rutas = resultado;

    const seleccion = el.ruta.value;
    el.ruta.replaceChildren(new Option("Selecciona una ruta…", ""));

    rutas.forEach((ruta) => {
      el.ruta.append(new Option(nombreRuta(ruta), String(ruta.id)));
    });

    el.ruta.value = seleccion;
    renderListado();
  }

  function renderListado() {
    el.tbody.replaceChildren();

    if (!rutas.length) {
      const fila = el.tbody.insertRow();
      const celda = fila.insertCell();
      celda.colSpan = 5;
      celda.textContent = "No hay rutas registradas.";
      return;
    }

    rutas.forEach((ruta) => {
      const fila = el.tbody.insertRow();

      fila.insertCell().textContent = nombreRuta(ruta);
      fila.insertCell().textContent =
        ruta.monto != null ? fmtMonto.format(ruta.monto) : "—";
      fila.insertCell().textContent = ruta.tipo_carga || "—";
      fila.insertCell().append(crearBadge(ruta.nivel_riesgo));

      const boton = document.createElement("button");
      boton.type = "button";
      boton.className = "rr-boton rr-boton--link";
      boton.textContent = "Ver detalle";
      boton.addEventListener("click", () => mostrarDetalle(ruta.id));

      fila.insertCell().append(boton);
    });
  }

  async function mostrarDetalle(id) {
    try {
      const ruta = await api(`/${encodeURIComponent(String(id))}`);

      const lista = document.createElement("dl");
      lista.className = "rr-detalle-grid";

      function agregarFila(etiqueta, valor) {
        const dt = document.createElement("dt");
        dt.textContent = etiqueta;

        const dd = document.createElement("dd");

        if (valor instanceof Node) {
          dd.append(valor);
        } else {
          dd.textContent = valor;
        }

        lista.append(dt, dd);
      }

      agregarFila("Ruta", nombreRuta(ruta));
      agregarFila(
        "Monto",
        ruta.monto != null ? fmtMonto.format(ruta.monto) : "—"
      );
      agregarFila("Tipo de carga", ruta.tipo_carga || "—");
      agregarFila("Nivel de riesgo", crearBadge(ruta.nivel_riesgo));
      agregarFila(
        "Especificado por",
        ruta.riesgo_especificado_por || "—"
      );
      agregarFila(
        "Fecha y hora",
        ruta.riesgo_especificado_en
          ? fmtFecha.format(new Date(ruta.riesgo_especificado_en))
          : "—"
      );

      const titulo = document.createElement("h2");
      titulo.textContent = "Detalle de la ruta";

      el.detalle.replaceChildren(titulo, lista);
      el.detalle.hidden = false;
    } catch (error) {
      estado(error.message, true);
    }
  }

  el.ruta.addEventListener("change", () => {
    limpiarErrores();
    estado("");

    const ruta = rutas.find(
      (item) => String(item.id) === el.ruta.value
    );

    el.monto.value =
      ruta && ruta.monto != null ? ruta.monto : "";
    el.tipo.value =
      ruta && ruta.tipo_carga_id != null
        ? String(ruta.tipo_carga_id)
        : "";

    if (!el.ruta.value) {
      mostrarNivel(null);
      el.detalle.hidden = true;
      return;
    }

    calcularRiesgo();
  });

  el.monto.addEventListener("input", programarCalculo);
  el.tipo.addEventListener("change", programarCalculo);

  el.form.addEventListener("submit", async (evento) => {
    evento.preventDefault();

    limpiarErrores();
    estado("");

    const errores = validarMontoYTipo();

    if (!el.ruta.value) {
      errores.ruta = "Selecciona la ruta.";
    }

    if (Object.keys(errores).length) {
      mostrarErrores(errores);
      estado("No se guardó: revisa los campos marcados.", true);
      return;
    }

    const boton = el.form.querySelector('button[type="submit"]');
    const rutaId = el.ruta.value;

    boton.disabled = true;

    try {
      const resultado = await api(
        `/${encodeURIComponent(rutaId)}`,
        {
          method: "PUT",
          body: {
            monto: el.monto.value.trim(),
            tipo_carga_id: Number(el.tipo.value),
          },
        }
      );

      mostrarNivel(resultado.nivel_riesgo);
      estado("Ruta guardada correctamente.");

      await cargarRutas();
      await mostrarDetalle(rutaId);
    } catch (error) {
      mostrarErrores(error.errores);
      estado(error.message, true);
    } finally {
      boton.disabled = false;
    }
  });

  (async () => {
    try {
      await Promise.all([cargarTipos(), cargarRutas()]);
    } catch (error) {
      estado(error.message, true);
    }
  })();
})();
