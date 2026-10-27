/*
 * Planificador de rutas multi-paradas: origen fijo, paradas intermedias dinámicas
 * (agregar, eliminar y reordenar arrastrando) y destino final fijo.
 *
 * Uso (ver dashboard.js):
 *   RoutePlanner.mount(document.getElementById("multiRoute"), {
 *     onCalculate: async points => { ... },   // se llama al pulsar "Calcular ruta"
 *     onReset: () => { ... },                 // vuelve a la ruta del día
 *     autocomplete: (input, pick) => { ... }  // opcional, ver más abajo
 *   });
 *
 * ARREGLO DE UBICACIONES (lo que recibe onCalculate)
 *   [origen, ...paradas en el orden visible, destino]. Cada elemento es:
 *     { role: "origin" | "stop" | "destination",
 *       text: "lo que escribió la persona",
 *       place: { lat, lng, label } | null }   // null = aún sin geocodificar
 *   Quien reciba el arreglo debe: (1) resolver cada `place` nulo a coordenadas
 *   (aquí: POST /rutas/geocodificar en el backend, que protege la clave de
 *   OpenRouteService), (2) guardar el resultado en `point.place` para no repetir
 *   la búsqueda y (3) enviar [[lat, lng], ...] a POST /rutas/calcular. El orden
 *   del arreglo ES el orden de la ruta; no se reordena por distancia.
 *
 * CONECTAR UNA API DE AUTOCOMPLETADO (Google Places, Mapbox, Nominatim...)
 *   Pasa `autocomplete(input, pick)`. Se invoca una vez por cada <input> creado
 *   (origen, destino y cada parada nueva). Engancha ahí el widget de la API y,
 *   cuando la persona elija una sugerencia, llama pick({ lat, lng, label }).
 *   Ejemplo con Google Places:
 *     autocomplete(input, pick) {
 *       const ac = new google.maps.places.Autocomplete(input, { componentRestrictions: { country: "sv" } });
 *       ac.addListener("place_changed", () => {
 *         const p = ac.getPlace();
 *         if (p.geometry) pick({ lat: p.geometry.location.lat(), lng: p.geometry.location.lng(), label: p.formatted_address });
 *       });
 *     }
 *   Con `place` ya resuelto, el paso de geocodificación se omite.
 */
(function (global) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const DEFAULT_MAX_STOPS = 8;

  // Íconos SVG integrados: [etiqueta, atributos] dentro de un viewBox de 24x24.
  const ICONS = {
    origin: [["circle", { cx: 12, cy: 12, r: 6, fill: "none", "stroke-width": 2.4 }], ["circle", { cx: 12, cy: 12, r: 2, fill: "currentColor", stroke: "none" }]],
    stop: [["circle", { cx: 12, cy: 12, r: 4.5, fill: "currentColor", stroke: "none" }]],
    destination: [["path", { d: "M12 21s-6.5-5.6-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z", fill: "none", "stroke-width": 2 }], ["circle", { cx: 12, cy: 10.5, r: 2.2, fill: "currentColor", stroke: "none" }]],
    grip: [[9, 6], [15, 6], [9, 12], [15, 12], [9, 18], [15, 18]].map(([cx, cy]) => ["circle", { cx, cy, r: 1.6, fill: "currentColor", stroke: "none" }]),
    close: [["path", { d: "M6 6l12 12M18 6L6 18", fill: "none", "stroke-width": 2.2 }]],
    plus: [["path", { d: "M12 5v14M5 12h14", fill: "none", "stroke-width": 2.2 }]],
    route: [["path", { d: "M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 17h6.5a3 3 0 0 0 0-6h-5a3 3 0 0 1 0-6H16", fill: "none", "stroke-width": 2 }]]
  };

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "mr-icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    ICONS[name].forEach(([tag, attrs]) => {
      const node = document.createElementNS(SVG_NS, tag);
      Object.keys(attrs).forEach(key => node.setAttribute(key, attrs[key]));
      svg.append(node);
    });
    return svg;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, label, iconName, text) {
    const node = el("button", className);
    node.type = "button";
    node.setAttribute("aria-label", label);
    node.title = label;
    if (iconName) node.append(icon(iconName));
    if (text) node.append(el("span", "", text));
    return node;
  }

  function mount(root, options) {
    const settings = Object.assign({ maxStops: DEFAULT_MAX_STOPS }, options);
    let nextId = 1;
    const origin = { role: "origin", text: "", place: null };
    const destination = { role: "destination", text: "", place: null };
    let stops = [];
    let busy = false;

    root.replaceChildren();
    root.classList.add("mr-card");

    const heading = el("div", "mr-heading");
    heading.append(el("span", "section-kicker", "RUTA MULTI-PARADAS"), el("h3", "", "Planifica tu recorrido"));
    const originList = el("ul", "mr-list mr-fixed");
    const stopsList = el("ul", "mr-list mr-stops");
    stopsList.setAttribute("aria-label", "Paradas intermedias");
    const destinationList = el("ul", "mr-list mr-fixed");
    const addButton = button("mr-add", "Agregar parada", "plus", "Agregar parada");
    const calculateButton = button("mr-calculate", "Calcular ruta", "route", "Calcular ruta");
    const resetButton = el("button", "mr-reset", "Volver a la ruta del día");
    resetButton.type = "button";
    const message = el("p", "mr-message hidden");
    message.setAttribute("role", "alert");
    const actions = el("div", "mr-actions");
    actions.append(calculateButton, resetButton);
    root.append(heading, originList, stopsList, destinationList, addButton, message, actions);

    function setMessage(text) {
      message.textContent = text || "";
      message.classList.toggle("hidden", !text);
    }

    function field(item, label, placeholder) {
      const wrapper = el("label", "mr-field");
      wrapper.append(el("span", "mr-sr-only", label));
      const input = el("input", "mr-input");
      input.type = "text";
      input.placeholder = placeholder;
      input.value = item.text;
      input.autocomplete = "off";
      input.maxLength = 200;
      input.addEventListener("input", () => {
        item.text = input.value;
        item.place = null; // el texto cambió: hay que volver a resolver sus coordenadas
        setMessage("");
      });
      if (typeof settings.autocomplete === "function") {
        settings.autocomplete(input, place => {
          item.place = place;
          item.text = place.label || input.value;
          input.value = item.text;
        });
      }
      wrapper.append(input);
      return wrapper;
    }

    function row(item, kind, label, placeholder) {
      const li = el("li", "mr-row mr-row--" + kind);
      li.append(el("span", "mr-marker mr-marker--" + kind), field(item, label, placeholder));
      li.firstChild.append(icon(kind));
      return li;
    }

    function stopRow(item, index) {
      const li = row(item, "stop", "Parada " + (index + 1), "Parada " + (index + 1));
      li.dataset.id = String(item.id);
      const handle = button("mr-handle", "Reordenar parada " + (index + 1) + " (flechas arriba y abajo)", "grip");
      handle.addEventListener("pointerdown", event => startDrag(event, li, handle));
      handle.addEventListener("keydown", event => {
        const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
        if (!step) return;
        event.preventDefault();
        moveStop(item, step);
      });
      const remove = button("mr-remove", "Eliminar parada " + (index + 1), "close");
      remove.addEventListener("click", () => {
        stops = stops.filter(stop => stop !== item);
        setMessage("");
        render();
      });
      li.prepend(handle);
      li.append(remove);
      return li;
    }

    function render() {
      originList.replaceChildren(row(origin, "origin", "Origen", "Punto de partida"));
      destinationList.replaceChildren(row(destination, "destination", "Destino final", "Destino final"));
      stopsList.replaceChildren(...stops.map(stopRow));
      addButton.disabled = busy || stops.length >= settings.maxStops;
      addButton.title = stops.length >= settings.maxStops ? "Máximo " + settings.maxStops + " paradas" : "Agregar parada";
    }

    function moveStop(item, step) {
      const from = stops.indexOf(item);
      const to = from + step;
      if (to < 0 || to >= stops.length) return;
      stops.splice(to, 0, stops.splice(from, 1)[0]);
      render();
      const handle = stopsList.querySelector('[data-id="' + item.id + '"] .mr-handle');
      if (handle) handle.focus();
    }

    // Arrastrar con Pointer Events: funciona igual con ratón y con el dedo en móviles.
    function startDrag(event, li, handle) {
      if (busy || (event.pointerType === "mouse" && event.button !== 0)) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      li.classList.add("is-dragging");
      // Se mueven los vecinos, nunca la fila arrastrada: reinsertarla en el DOM soltaría la captura del puntero.
      const midpoint = node => {
        const box = node.getBoundingClientRect();
        return box.top + box.height / 2;
      };
      const onMove = moveEvent => {
        while (li.previousElementSibling && moveEvent.clientY < midpoint(li.previousElementSibling)) {
          li.after(li.previousElementSibling);
        }
        while (li.nextElementSibling && moveEvent.clientY > midpoint(li.nextElementSibling)) {
          li.before(li.nextElementSibling);
        }
      };
      const onEnd = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        li.classList.remove("is-dragging");
        const order = [...stopsList.children].map(node => Number(node.dataset.id));
        stops.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        render();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onEnd);
      handle.addEventListener("pointercancel", onEnd);
    }

    function getPoints() {
      return [origin, ...stops, destination];
    }

    function validate() {
      if (!origin.text.trim()) return "Escribe el punto de partida.";
      if (!destination.text.trim()) return "Escribe el destino final.";
      const empty = stops.findIndex(stop => !stop.text.trim());
      if (empty !== -1) return "Completa la parada " + (empty + 1) + " o elimínala.";
      return "";
    }

    function setBusy(value) {
      busy = value;
      root.classList.toggle("is-busy", value);
      calculateButton.disabled = value;
      resetButton.disabled = value;
      calculateButton.querySelector("span").textContent = value ? "Calculando…" : "Calcular ruta";
      render();
    }

    addButton.addEventListener("click", () => {
      if (stops.length >= settings.maxStops) return;
      stops.push({ id: nextId++, role: "stop", text: "", place: null });
      setMessage("");
      render();
      const inputs = stopsList.querySelectorAll(".mr-input");
      if (inputs.length) inputs[inputs.length - 1].focus();
    });

    calculateButton.addEventListener("click", async () => {
      const problem = validate();
      if (problem) return setMessage(problem);
      setMessage("");
      setBusy(true);
      try {
        // Aquí sale el arreglo [origen, ...paradas, destino] hacia quien calcula la ruta.
        await settings.onCalculate(getPoints());
      } catch (error) {
        setMessage(error && error.message ? error.message : "No se pudo calcular la ruta.");
      } finally {
        setBusy(false);
      }
    });

    resetButton.addEventListener("click", () => {
      origin.text = destination.text = "";
      origin.place = destination.place = null;
      stops = [];
      setMessage("");
      render();
      if (typeof settings.onReset === "function") settings.onReset();
    });

    render();
    return { getPoints, setMessage };
  }

  global.RoutePlanner = { mount };
})(window);
