(function (global) {
  "use strict";

  const SESSION_KEY = "session";
  const LOGIN_URL = "/PaginaPrincipal.html";
  const LINKS = [
    { id: "routes", label: "Asignar Rutas", detail: "Planificación", icon: "↗" },
    { id: "monitor", label: "Monitoreo en Vivo", detail: "Eventos y alertas", icon: "◎" },
        { id: "daily", label: "Empleados y Vehículos", detail: "Gestión diaria", icon: "♙" },
    { id: "risk", label: "Riesgo de rutas", detail: "Monto y tipo de carga", icon: "⚠",
      href: "/riesgo-rutas.html", rol: "coordinador_rutas" }
  ];

  function readSession() {
    try {
      const value = JSON.parse(global.sessionStorage.getItem(SESSION_KEY) || "null");
      return value && typeof value.token === "string" && value.token ? value : null;
    } catch (error) {
      return null;
    }
  }

  function createElement(tag, attrs, ...children) {
    const node = global.document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (key === "class") node.className = value;
      else node.setAttribute(key, value);
    });
    children.forEach(child => {
      if (child == null) return;
      node.append(typeof child === "string" ? global.document.createTextNode(child) : child);
    });
    return node;
  }
function activeSection() {
    if (global.location.pathname.endsWith("/riesgo-rutas.html")) return "risk";
    return global.location.hash === "#monitoreo" ? "monitor" :
      global.location.hash === "#personal" ? "daily" : "routes";
  }


  function setActive(section) {
    global.document.querySelectorAll(".app-nav-links button").forEach(button => {
      const active = button.dataset.section === section;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
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
    LINKS.filter(item => !item.rol || item.rol === session.role).forEach(item => {
      const link = createElement("button", {
        type: "button",
        class: item.id === active ? "active" : "",
        "data-section": item.id
      });
      link.append(
        createElement("span", { class: "app-nav-icon", "aria-hidden": "true" }, item.icon),
        createElement("span", { class: "app-nav-copy" },
          createElement("span", { class: "app-nav-label" }, item.label),
          createElement("small", {}, item.detail))
      );
      if (item.id === active) {
        link.setAttribute("aria-current", "page");
        link.append(createElement("span", { class: "app-nav-arrow", "aria-hidden": "true" }, "›"));
      }
      link.addEventListener("click", () => {
        // Enlace a otra página (ej. Riesgo de rutas)
        if (item.href) {
          global.location.assign(item.href);
          return;
        }
        // Estamos fuera de la página principal: volver a ella
        if (global.location.pathname.endsWith("/riesgo-rutas.html")) {
          const hashes = { routes: "", monitor: "#monitoreo", daily: "#personal" };
          global.location.assign(LOGIN_URL + (hashes[item.id] || ""));
          return;
        }
        setActive(item.id);
        global.dispatchEvent(new CustomEvent("app:navigate", { detail: item.id }));
        closeMenu();
      });
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
    setActive,
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
