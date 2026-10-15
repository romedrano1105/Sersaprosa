(function (global) {
  "use strict";

  const SESSION_KEY = "session";
  const LOGIN_URL = "/PaginaPrincipal.html";
  const LINKS = [
    { id: "map", label: "Ruta del día / Mapa", href: LOGIN_URL },
    { id: "routes", label: "Rutas (alternativas)", href: LOGIN_URL + "#rutas" },
    { id: "deliveries", label: "Destinos diarios", href: "/entregasDia.html" },
    { id: "events", label: "Eventos especiales", href: "/eventosEspeciales.html" },
    { id: "alerts", label: "Alertas de seguridad", href: "/alertasSeguridad.html", role: "coordinador_rutas" },
    { id: "drivers", label: "Verificar conductores", href: "/Verificar%20conductores.html" }
  ];

  function readSession() {
    try {
      const value = JSON.parse(global.sessionStorage.getItem(SESSION_KEY) || "null");
      return value && typeof value.token === "string" && value.token ? value : null;
    } catch (error) {
      return null;
    }
  }

  function createElement(tag, attrs, text) {
    const node = global.document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (key === "class") node.className = value;
      else node.setAttribute(key, value);
    });
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function activeSection() {
    const page = decodeURIComponent(global.location.pathname.split("/").pop() || "");
    if (page === "entregasDia.html") return "deliveries";
    if (page === "eventosEspeciales.html") return "events";
    if (page === "alertasSeguridad.html") return "alerts";
    if (page === "Verificar conductores.html") return "drivers";
    return global.location.hash === "#rutas" ? "routes" : "map";
  }

  function closeMenu() {
    global.document.body.classList.remove("app-nav-open");
    const toggle = global.document.querySelector(".app-nav-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }

  function mount() {
    const session = readSession();
    const page = decodeURIComponent(global.location.pathname.split("/").pop() || "");
    if (!session) {
      if (page !== "PaginaPrincipal.html" && page !== "") global.location.replace(LOGIN_URL);
      return false;
    }
    if (global.document.querySelector(".app-nav")) return true;

    global.document.body.classList.add("app-nav-enabled");
    const toggle = createElement("button", {
      class: "app-nav-toggle",
      type: "button",
      "aria-label": "Abrir menú de navegación",
      "aria-expanded": "false",
      "aria-controls": "app-nav"
    }, "☰ Menú");
    const backdrop = createElement("button", {
      class: "app-nav-backdrop",
      type: "button",
      "aria-label": "Cerrar menú"
    });
    const nav = createElement("nav", {
      class: "app-nav",
      id: "app-nav",
      "aria-label": "Navegación principal"
    });
    nav.append(createElement("div", { class: "app-nav-brand" }, "Rutas seguras"));
    const list = createElement("ul", { class: "app-nav-links" });
    const active = activeSection();
    LINKS.forEach(item => {
      if (item.role && session.role !== item.role) return;
      const link = createElement("a", {
        href: item.href,
        class: item.id === active ? "active" : ""
      }, item.label);
      if (item.id === active) link.setAttribute("aria-current", "page");
      link.addEventListener("click", closeMenu);
      const listItem = createElement("li", {});
      listItem.append(link);
      list.append(listItem);
    });
    nav.append(list);
    const logout = createElement("button", { class: "app-nav-logout", type: "button" }, "Salir");
    logout.addEventListener("click", () => {
      try {
        global.sessionStorage.removeItem(SESSION_KEY);
      } catch (error) {
        global.console.error("No se pudo limpiar la sesión del navegador.", error);
      }
      global.location.assign(LOGIN_URL);
    });
    nav.append(logout);
    toggle.addEventListener("click", () => {
      const open = !global.document.body.classList.contains("app-nav-open");
      global.document.body.classList.toggle("app-nav-open", open);
      toggle.setAttribute("aria-expanded", String(open));
    });
    backdrop.addEventListener("click", closeMenu);
    global.document.body.prepend(backdrop, nav, toggle);
    return true;
  }

  global.AppNavigation = {
    mount,
    readSession,
    handleUnauthorized() {
      try {
        global.sessionStorage.removeItem(SESSION_KEY);
      } catch (error) {
        global.console.error("No se pudo limpiar la sesión vencida.", error);
      }
      global.location.replace(LOGIN_URL);
    }
  };

  const page = decodeURIComponent(global.location.pathname.split("/").pop() || "");
  if (page !== "PaginaPrincipal.html" && page !== "") mount();
})(window);
