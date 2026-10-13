(function (global) {
  "use strict";

  const API_DEFAULT = "";
  const SESSION_KEY = "session";
  const PAGE_SIZE = 25;
  const PAGE_SIZE_EXPORT = 100;
  const MSG_LOAD_ERROR = "Algunas alertas no pudieron cargarse";
  const CATEGORIES = [["baja", "Baja"], ["media", "Media"], ["alta", "Alta"]];
  const STATES = [["pendiente", "Pendiente"], ["revisada", "Revisada"]];

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : value);
    });
    children.flat().filter(child => child != null).forEach(child => node.append(child));
    return node;
  }

  const formatDate = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("es-SV");
  };
  const formatTime = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit" });
  };
  const formatDateTime = value => `${formatDate(value)} ${formatTime(value)}`;
  const label = (values, value) => (values.find(entry => entry[0] === value) || [null, value || "—"])[1];

  function mount(container) {
    if (!container) throw new Error("No se encontró el contenedor de alertas de seguridad.");
    let session = null;
    try {
      session = JSON.parse(global.sessionStorage.getItem(SESSION_KEY) || "null");
    } catch (error) {
      session = null;
    }

    const state = {
      page: 1,
      data: null,
      filters: { fecha_desde: "", fecha_hasta: "", tipo: "", severidad: "", conductor: "", ruta: "", estado: "" },
      selected: new Set(),
      detail: null,
      busy: false,
      error: "",
      actionMessage: "",
      actionError: "",
      map: null
    };
    const apiBase = (session && session.apiBase) || API_DEFAULT || global.location.origin;

    async function request(path, payload) {
      if (!session || !session.token) throw new Error("Sesión vencida. Inicie sesión de nuevo.");
      const response = await global.fetch(apiBase.replace(/\/$/, "") + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.token },
        body: JSON.stringify(payload)
      });
      let body = {};
      try {
        body = await response.json();
      } catch (error) {
        body = {};
      }
      if (!response.ok) {
        const detail = body.detail;
        const message = detail && typeof detail === "object" ? detail.message : detail;
        const failure = new Error(message || body.error || `Error ${response.status}`);
        failure.retryable = Boolean(detail && typeof detail === "object" && detail.retryable);
        failure.status = response.status;
        throw failure;
      }
      return body;
    }

    function checkedResponse(raw) {
      if (!raw || !Array.isArray(raw.items) || !raw.options || !raw.integrity || raw.integrity.ok !== true ||
          !Number.isInteger(raw.total) || !Number.isInteger(raw.pending_count) ||
          !Number.isInteger(raw.pending_outside_filters) ||
          raw.items.some(item => !item.id || !item.viaje_id || !item.fecha || !item.ruta || !item.conductor)) {
        throw new Error(MSG_LOAD_ERROR);
      }
      if (raw.items.length > raw.total) throw new Error(MSG_LOAD_ERROR);
      return raw;
    }

    async function load() {
      state.busy = true;
      state.error = "";
      state.actionError = "";
      render();
      try {
        const raw = await request("/alertas/listar", {
          ...activeFilters(),
          page: state.page,
          page_size: PAGE_SIZE
        });
        state.data = checkedResponse(raw);
        state.selected.clear();
        state.error = "";
      } catch (error) {
        state.data = null;
        state.error = error.retryable ? MSG_LOAD_ERROR : (error.message || MSG_LOAD_ERROR);
      } finally {
        state.busy = false;
        render();
      }
    }

    function activeFilters() {
      return Object.fromEntries(Object.entries(state.filters).filter(([, value]) => value !== ""));
    }

    function setFilter(name, value) {
      state.filters[name] = value;
      state.page = 1;
      state.selected.clear();
      load();
    }

    function optionsSelect(name, title, entries) {
      const select = h("select", { "aria-label": title, onchange: event => setFilter(name, event.target.value) },
        h("option", { value: "" }, `Todos: ${title.toLowerCase()}`));
      entries.forEach(entry => {
        const value = Array.isArray(entry) ? entry[0] : entry;
        const text = Array.isArray(entry) ? entry[1] : entry;
        select.append(h("option", { value, selected: state.filters[name] === value }, text));
      });
      return select;
    }

    function filtersView(data) {
      const options = data.options;
      return h("div", { class: "as-filters as-no-print" },
        h("label", {}, "Desde", h("input", { type: "date", value: state.filters.fecha_desde, max: state.filters.fecha_hasta || undefined, onchange: event => setFilter("fecha_desde", event.target.value) })),
        h("label", {}, "Hasta", h("input", { type: "date", value: state.filters.fecha_hasta, min: state.filters.fecha_desde || undefined, onchange: event => setFilter("fecha_hasta", event.target.value) })),
        h("label", {}, "Tipo", optionsSelect("tipo", "Tipo", options.tipos || [])),
        h("label", {}, "Severidad", optionsSelect("severidad", "Severidad", CATEGORIES)),
        h("label", {}, "Conductor", optionsSelect("conductor", "Conductor", options.conductores || [])),
        h("label", {}, "Ruta", optionsSelect("ruta", "Ruta", options.rutas || [])),
        h("label", {}, "Estado", optionsSelect("estado", "Estado", STATES.map(entry => entry[0])))
      );
    }

    function tableView(data) {
      const rows = data.items.map(item => {
        const eligible = item.severidad === "baja" && item.estado === "pendiente";
        const checkbox = eligible ? h("input", {
          class: "as-check",
          type: "checkbox",
          checked: state.selected.has(item.id),
          "aria-label": `Seleccionar alerta ${item.id} para revisión masiva`,
          onchange: event => {
            if (event.target.checked) state.selected.add(item.id);
            else state.selected.delete(item.id);
            render();
          }
        }) : "—";
        return h("tr", { class: state.detail && state.detail.alerta.id === item.id ? "as-selected" : "" },
          h("td", {}, checkbox),
          h("td", {}, formatDateTime(item.fecha)),
          h("td", {}, item.viaje_id),
          h("td", {}, item.ruta),
          h("td", {}, item.conductor),
          h("td", {}, item.tipo),
          h("td", {}, h("span", { class: `as-pill as-pill-${item.severidad}` }, label(CATEGORIES, item.severidad))),
          h("td", {}, h("span", { class: `as-pill ${item.estado === "revisada" ? "as-pill-revisada" : ""}` }, label(STATES, item.estado))),
          h("td", {}, h("button", { type: "button", onclick: () => showDetail(item.id) }, "Detalle"))
        );
      });
      const table = h("table", { class: "as-table" },
        h("thead", {}, h("tr", {}, ["", "Fecha y hora", "Viaje", "Ruta", "Conductor", "Tipo de alerta", "Severidad", "Estado", ""].map(text => h("th", {}, text)))),
        h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: "9", class: "as-muted" }, "No hay alertas que coincidan con los filtros seleccionados."))));
      return h("div", { class: "as-scroll" }, table);
    }

    async function showDetail(id) {
      state.actionError = "";
      try {
        const result = await request("/alertas/detalle", { id });
        if (!result || !result.alerta || !Array.isArray(result.auditoria)) throw new Error(MSG_LOAD_ERROR);
        state.detail = result;
        render();
      } catch (error) {
        state.actionError = error.message || MSG_LOAD_ERROR;
        render();
      }
    }

    function mapView(alerta) {
      if (alerta.lat == null || alerta.lng == null) {
        return h("p", { class: "as-muted" }, "Esta alerta no tiene coordenadas disponibles.");
      }
      if (!global.L) return h("p", { class: "as-muted" }, "El mapa no está disponible.");
      const element = h("div", { class: "as-map", role: "img", "aria-label": "Ubicación de la alerta" });
      setTimeout(() => {
        if (!element.isConnected) return;
        state.map = global.L.map(element).setView([alerta.lat, alerta.lng], 15);
        global.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(state.map);
        global.L.marker([alerta.lat, alerta.lng]).addTo(state.map);
        setTimeout(() => state.map && state.map.invalidateSize(), 60);
      }, 0);
      return element;
    }

    function detailView() {
      if (!state.detail) return null;
      const alerta = state.detail.alerta;
      const auditRows = state.detail.auditoria.map(entry => h("tr", {},
        h("td", {}, formatDateTime(entry.fecha)),
        h("td", {}, entry.revisor_nombre || "—"),
        h("td", {}, entry.comentario || "—")));
      const canReview = alerta.estado === "pendiente";
      const form = canReview ? h("form", {
        onsubmit: event => {
          event.preventDefault();
          reviewOne(alerta.id, event.currentTarget.elements.comentario.value);
        }
      },
        h("label", { class: "as-comment" }, "Comentario de revisión (3–500 caracteres)",
          h("textarea", { name: "comentario", minlength: "3", maxlength: "500", required: true })),
        h("button", { class: "as-primary", type: "submit", disabled: state.busy }, "Marcar como revisada")) :
        h("p", { class: "as-muted" }, `Revisada ${alerta.revisado_en ? "el " + formatDateTime(alerta.revisado_en) : ""}. ${alerta.comentario || ""}`);
      return h("section", { class: "as-panel", id: "as-detail" },
        h("div", { class: "as-detail-head" }, h("h2", {}, "Detalle de alerta"),
          h("button", { type: "button", onclick: () => { state.detail = null; render(); } }, "Cerrar")),
        h("div", { class: "as-detail" },
          h("div", {},
            h("p", {}, h("b", {}, "Alerta: "), alerta.tipo),
            h("p", {}, h("b", {}, "Viaje: "), alerta.viaje_id),
            h("p", {}, h("b", {}, "Fecha: "), formatDateTime(alerta.fecha)),
            h("p", {}, h("b", {}, "Ruta: "), alerta.ruta),
            h("p", {}, h("b", {}, "Conductor: "), alerta.conductor),
            h("p", {}, h("b", {}, "Severidad: "), label(CATEGORIES, alerta.severidad)),
            h("p", {}, h("b", {}, "Estado: "), label(STATES, alerta.estado)),
            h("p", {}, h("b", {}, "Descripción: "), alerta.descripcion || "—"),
            alerta.lat != null && alerta.lng != null ? h("p", {}, h("b", {}, "Coordenadas: "), `${alerta.lat}, ${alerta.lng}`) : null,
            form),
          h("div", {}, h("h3", {}, "Ubicación"), mapView(alerta))),
        h("h3", {}, "Auditoría de revisiones"),
        h("div", { class: "as-scroll" }, h("table", { class: "as-audit" },
          h("thead", {}, h("tr", {}, ["Fecha y hora", "Revisor", "Comentario"].map(text => h("th", {}, text)))),
          h("tbody", {}, auditRows.length ? auditRows : h("tr", {}, h("td", { colspan: "3" }, "Aún no hay revisiones."))))));
    }

    async function reviewOne(id, comentario) {
      state.busy = true;
      state.actionError = "";
      state.actionMessage = "";
      render();
      try {
        await request("/alertas/revisar", { id, comentario });
        state.actionMessage = "Alerta marcada como revisada.";
        state.detail = null;
        await load();
      } catch (error) {
        state.actionError = error.message || "No se pudo guardar la revisión.";
      } finally {
        state.busy = false;
        render();
      }
    }

    async function reviewSelected(form) {
      const comentario = form.elements.comentario.value.trim();
      if (state.selected.size < 1 || comentario.length < 3 || comentario.length > 500) {
        state.actionError = "Seleccione alertas de severidad baja y escriba un comentario de 3 a 500 caracteres.";
        render();
        return;
      }
      state.busy = true;
      state.actionError = "";
      state.actionMessage = "";
      render();
      try {
        const result = await request("/alertas/revisar-bajas", { ids: Array.from(state.selected), comentario });
        state.actionMessage = `${result.revisadas} alerta(s) marcada(s) como revisadas.`;
        state.selected.clear();
        await load();
      } catch (error) {
        state.actionError = error.message || "No se pudieron revisar las alertas seleccionadas.";
      } finally {
        state.busy = false;
        render();
      }
    }

    function requestFilters() {
      return { ...activeFilters(), page: 1, page_size: PAGE_SIZE_EXPORT };
    }

    async function filteredRows() {
      const first = checkedResponse(await request("/alertas/listar", requestFilters()));
      const items = first.items.slice();
      const pages = Math.ceil(first.total / PAGE_SIZE_EXPORT);
      for (let page = 2; page <= pages; page += 1) {
        const response = checkedResponse(await request("/alertas/listar", { ...requestFilters(), page }));
        items.push(...response.items);
      }
      if (items.length !== first.total) throw new Error(MSG_LOAD_ERROR);
      return items;
    }

    function csvField(value) {
      return `"${String(value == null ? "" : value).replace(/"/g, '""')}"`;
    }

    async function exportCsv() {
      state.actionError = "";
      render();
      try {
        const rows = await filteredRows();
        const columns = ["Fecha y hora", "Viaje", "Ruta", "Conductor", "Tipo", "Severidad", "Estado", "Descripción", "Comentario"];
        const values = rows.map(item => [formatDateTime(item.fecha), item.viaje_id, item.ruta, item.conductor, item.tipo, label(CATEGORIES, item.severidad), label(STATES, item.estado), item.descripcion, item.comentario]);
        const csv = "\uFEFF" + [columns, ...values].map(row => row.map(csvField).join(",")).join("\r\n");
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        const link = h("a", { href: url, download: "alertas-seguridad.csv" });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) {
        state.actionError = error.message || MSG_LOAD_ERROR;
        render();
      }
    }

    function reportDocument(win, rows) {
      const doc = win.document;
      const style = doc.createElement("style");
      style.textContent = "body{font:12px Arial,sans-serif;color:#111}h1{font-size:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #777;padding:5px;text-align:left}";
      doc.head.append(style);
      const title = doc.createElement("h1");
      title.textContent = "Reporte filtrado de alertas de seguridad";
      doc.body.append(title);
      const table = doc.createElement("table");
      const headings = ["Fecha y hora", "Viaje", "Ruta", "Conductor", "Tipo", "Severidad", "Estado", "Descripción"];
      const head = doc.createElement("tr");
      headings.forEach(text => { const th = doc.createElement("th"); th.textContent = text; head.append(th); });
      const thead = doc.createElement("thead");
      thead.append(head);
      table.append(thead);
      const tbody = doc.createElement("tbody");
      rows.forEach(item => {
        const row = doc.createElement("tr");
        [formatDateTime(item.fecha), item.viaje_id, item.ruta, item.conductor, item.tipo, label(CATEGORIES, item.severidad), label(STATES, item.estado), item.descripcion || ""]
          .forEach(value => { const cell = doc.createElement("td"); cell.textContent = value; row.append(cell); });
        tbody.append(row);
      });
      table.append(tbody);
      doc.body.append(table);
      win.focus();
      win.print();
    }

    async function exportPdf() {
      const win = global.open("", "_blank");
      if (!win) {
        state.actionError = "Permita las ventanas emergentes para generar el reporte PDF.";
        render();
        return;
      }
      state.actionError = "";
      render();
      try {
        reportDocument(win, await filteredRows());
      } catch (error) {
        win.close();
        state.actionError = error.message || MSG_LOAD_ERROR;
        render();
      }
    }

    function render() {
      if (state.map) {
        state.map.remove();
        state.map = null;
      }
      const content = h("div", { class: "as" },
        h("header", { class: "as-head" },
          h("div", {}, h("h1", {}, "Alertas de seguridad"), h("p", {}, "Alertas de viajes finalizados · historial de los últimos 90 días")),
          h("a", { class: "as-button", href: "PaginaPrincipal.html" }, "Volver a la ruta")),
        !session || !session.token ? h("div", { class: "as-state as-error", role: "alert" }, "Inicie sesión para consultar esta sección.") :
          session.role !== "coordinador_rutas" ? h("div", { class: "as-state as-error", role: "alert" }, "Esta sección es solo para el coordinador de rutas.") :
            state.busy && !state.data ? h("div", { class: "as-state", role: "status" }, "Cargando alertas…") :
              state.error ? h("div", { class: "as-state as-error", role: "alert" }, h("p", {}, state.error === MSG_LOAD_ERROR ? MSG_LOAD_ERROR : state.error),
                h("button", { class: "as-primary", type: "button", disabled: state.busy, onclick: load }, "Reintentar")) :
                state.data ? h("div", {},
                  h("div", { class: "as-counters" }, h("div", { class: "as-counter" },
                    h("strong", {}, String(state.data.pending_count)), h("span", {}, "Alertas pendientes de revisar"))),
                  state.data.pending_outside_filters > 0 ? h("div", { class: "as-message as-warning", role: "status" },
                    `${state.data.pending_outside_filters} alerta(s) pendiente(s) están fuera de los filtros actuales.`) : null,
                  state.actionMessage ? h("div", { class: "as-message", role: "status" }, state.actionMessage) : null,
                  state.actionError ? h("div", { class: "as-message as-error", role: "alert" }, state.actionError) : null,
                  h("section", { class: "as-panel" },
                    h("div", { class: "as-toolbar as-no-print" },
                      h("h2", {}, "Listado"),
                      h("div", { class: "as-actions" },
                        h("button", { type: "button", disabled: state.busy, onclick: load }, "Actualizar"),
                        h("button", { type: "button", disabled: state.busy, onclick: exportCsv }, "Exportar CSV"),
                        h("button", { type: "button", disabled: state.busy, onclick: exportPdf }, "Exportar PDF"))),
                    filtersView(state.data),
                    tableView(state.data),
                    h("div", { class: "as-pager as-no-print" },
                      h("span", {}, `${state.data.total} alerta(s) · Página ${state.page} de ${Math.max(1, Math.ceil(state.data.total / PAGE_SIZE))}`),
                      h("div", { class: "as-actions" },
                        h("button", { type: "button", disabled: state.page <= 1 || state.busy, onclick: () => { state.page -= 1; load(); } }, "Anterior"),
                        h("button", { type: "button", disabled: state.page >= Math.ceil(state.data.total / PAGE_SIZE) || state.busy, onclick: () => { state.page += 1; load(); } }, "Siguiente"))),
                    h("form", { class: "as-footer as-no-print", onsubmit: event => { event.preventDefault(); reviewSelected(event.currentTarget); } },
                      h("label", { class: "as-comment" }, `Comentario para revisar ${state.selected.size} alerta(s) de severidad baja`,
                        h("textarea", { name: "comentario", minlength: "3", maxlength: "500", required: true, disabled: state.selected.size === 0 })),
                      h("button", { class: "as-primary", type: "submit", disabled: state.busy || state.selected.size === 0 }, "Revisión masiva"))),
                  detailView()) : h("div", { class: "as-state" }, "No hay alertas para mostrar."));
      container.replaceChildren(content);
    }

    render();
    if (session && session.token && session.role === "coordinador_rutas") load();
    return { reload: load };
  }

  global.AlertasSeguridad = { mount };
})(window);
