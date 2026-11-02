/* Formulario para rechazar una ruta propuesta (window.Rechazos). */
(function (global) {
  "use strict";

  const MOTIVOS = [
    "Riesgo alto",
    "Zona peligrosa",
    "Incidentes recientes",
    "Desvío excesivo"
  ];

  function validar(motivo, comentario) {
    const errores = {};
    const razon = String(motivo == null ? "" : motivo).replace(/\s+/g, " ").trim();
    const detalle = String(comentario == null ? "" : comentario).replace(/\s+/g, " ").trim();
    if (!razon) errores.motivo = "El motivo del rechazo es obligatorio.";
    else if (razon.length < 3 || razon.length > 200) {
      errores.motivo = "El motivo debe tener entre 3 y 200 caracteres.";
    }
    if (detalle.length > 500) errores.comentario = "El comentario admite como máximo 500 caracteres.";
    return errores;
  }

  function h(tag, attrs, ...kids) {
    const e = global.document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === "class") e.className = value;
      else if (key.startsWith("on")) e.addEventListener(key.slice(2), value);
      else if (key === "value" || key === "disabled") e[key] = value;
      else if (value !== false && value != null) e.setAttribute(key, value === true ? "" : value);
    }
    for (const child of kids.flat()) if (child != null) e.append(child);
    return e;
  }

  function abrir(opciones) {
    const o = opciones || {};
    const motivo = h("textarea", { id: "rj-reason", class: "cc-input", rows: "3", maxlength: "200", minlength: "3", required: true,
      placeholder: "Explica por qué debe rechazarse esta ruta." });
    const comentario = h("textarea", { id: "rj-comment", class: "cc-input", rows: "3", maxlength: "500",
      placeholder: "Detalles adicionales (opcional)." });
    const error = h("p", { class: "cc-modal-error", role: "alert", hidden: true });
    const form = h("form", { id: "rj-form", class: "rj-form" });
    const chips = h("div", { class: "rj-chips", "aria-label": "Motivos frecuentes" });
    MOTIVOS.forEach(texto => {
      const chip = h("button", { type: "button", class: "rj-chip" }, texto);
      chip.addEventListener("click", () => {
        motivo.value = texto;
        motivo.focus();
      });
      chips.append(chip);
    });
    form.append(
      error,
      h("p", {}, "Ruta: " + (o.ruta && o.ruta.nombre || "sin nombre")),
      h("div", { class: "vj-field" },
        h("label", { for: "rj-reason" }, "Motivo del rechazo *"),
        chips,
        motivo),
      h("div", { class: "vj-field" },
        h("label", { for: "rj-comment" }, "Comentario opcional"),
        comentario)
    );

    let abierto = true;
    const cancelar = h("button", { type: "button", class: "cc-btn" }, "Cancelar");
    const enviar = h("button", { type: "submit", form: "rj-form", class: "cc-btn cc-primary" }, "Rechazar ruta");
    const fondo = h("div", { class: "cc-backdrop" },
      h("div", { class: "cc-modal", role: "dialog", "aria-modal": "true", "aria-label": "Rechazar ruta" },
        h("div", { class: "cc-modal-head" }, h("h3", {}, "Rechazar ruta"),
          h("button", { type: "button", class: "cc-x", "aria-label": "Cerrar" }, "×")),
        h("div", { class: "cc-modal-body" }, form),
        h("div", { class: "cc-modal-actions" }, cancelar, enviar)));

    function cerrar() {
      if (!abierto) return;
      abierto = false;
      fondo.remove();
      global.document.removeEventListener("keydown", esc);
    }
    function esc(event) {
      if (event.key === "Escape" && !enviar.disabled) cerrar();
    }
    cancelar.addEventListener("click", cerrar);
    fondo.querySelector(".cc-x").addEventListener("click", cerrar);
    fondo.addEventListener("click", event => {
      if (event.target === fondo && !enviar.disabled) cerrar();
    });
    global.document.addEventListener("keydown", esc);
    global.document.body.append(fondo);

    form.addEventListener("submit", async event => {
      event.preventDefault();
      const razon = motivo.value.replace(/\s+/g, " ").trim();
      const errores = validar(razon, comentario.value);
      if (Object.keys(errores).length) {
        error.textContent = Object.values(errores).join(" ");
        error.hidden = false;
        (errores.motivo ? motivo : comentario).focus();
        return;
      }
      error.hidden = true;
      enviar.disabled = cancelar.disabled = true;
      enviar.textContent = "Registrando rechazo…";
      let result;
      try {
        result = await o.post("/rutas/rechazar", {
          ruta_id: o.ruta.id,
          motivo: razon,
          comentario: comentario.value,
          ruta_propuesta: o.propuesta
        });
      } catch (requestError) {
        error.textContent = requestError.message || "No se pudo registrar el rechazo.";
        error.hidden = false;
        enviar.disabled = cancelar.disabled = false;
        enviar.textContent = "Rechazar ruta";
        return;
      }
      cerrar();
      if (typeof o.onResult === "function") await o.onResult(result);
    });

    motivo.focus();
    return { cerrar };
  }

  global.Rechazos = { abrir, util: { validar } };
})(window);
