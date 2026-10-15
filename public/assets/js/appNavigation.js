(function (global) {
  "use strict";

  const SESSION_KEY = "session";
  const LOGIN_URL = "/PaginaPrincipal.html";
  const LINKS = [
    { id: "map", label: "Asignar rutas", detail: "Planificación", href: LOGIN_URL },
    { id: "routes", label: "Alternativas de ruta", detail: "Recorridos por calles", href: LOGIN_URL + "#rutas" },
    { id: "events", label: "Monitoreo operativo", detail: "Eventos y seguridad", href: "/eventosEspeciales.html" },
    { id: "deliveries", label: "Entregas del día", detail: "Pedidos y destinos", href: "/entregasDia.html" },
    { id: "drivers", label: "Empleados y vehículos", detail: "Disponibilidad", href: "/Verificar%20conductores.html" },
    { id: "alerts", label: "Alertas de seguridad", detail: "Incidentes", href: "/alertasSeguridad.html", role: "coordinador_rutas" }
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
    const brand = createElement("div", { class: "app-nav-brand" });
    const logo = createElement("img", {
      class: "app-nav-logo",
      src: "/assets/img/sersaprosa-logo.svg",
      alt: ""
    });
    const brandCopy = createElement("span", { class: "app-nav-brand-copy" });
    brandCopy.append(
      createElement("strong", {}, "SERSAPROSA"),
      createElement("small", {}, "Control de operaciones")
    );
    brand.append(logo, brandCopy);
    nav.append(brand, createElement("div", { class: "app-nav-section" }, "MENÚ PRINCIPAL"));
    const list = createElement("ul", { class: "app-nav-links" });
    const active = activeSection();
    LINKS.forEach(item => {
      if (item.role && session.role !== item.role) return;
      const link = createElement("a", {
        href: item.href,
        class: item.id === active ? "active" : ""
      });
      link.append(
        createElement("span", { class: "app-nav-label" }, item.label),
        createElement("small", {}, item.detail)
      );
      if (item.id === active) link.setAttribute("aria-current", "page");
      link.addEventListener("click", closeMenu);
      const listItem = createElement("li", {});
      listItem.append(link);
      list.append(listItem);
    });
    nav.append(list);
    const status = createElement("div", { class: "app-nav-status" });
    status.append(
      createElement("span", { class: "app-nav-status-label" }, "Estado de sesión"),
      createElement("strong", {}, "CONECTADA"),
      createElement("small", {}, "Acceso autenticado")
    );
    nav.append(status);
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
    const operator = createElement("div", { class: "app-nav-operator" });
    const initials = String(session.name || session.code || "OP")
      .split(/\s+/).slice(0, 2).map(part => part.charAt(0).toUpperCase()).join("");
    const operatorCopy = createElement("span", {});
    operatorCopy.append(
      createElement("strong", {}, session.name || "Operador"),
      createElement("small", {}, session.role || "Personal autorizado")
    );
    operator.append(createElement("b", {}, initials), operatorCopy);
    nav.append(operator);
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
