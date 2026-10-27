window.NoticiasRiesgo = (() => {
  let secuencia = 0;

  async function cargar(rutaId) {
    const panel = document.getElementById("riesgoNoticias");

    if (!panel) {
      return;
    }

    const miSecuencia = ++secuencia;
    panel.innerHTML = "<p>Cargando noticias...</p>";

    try {
      const response = await window.Api.get(
        `/rutas-riesgo/${encodeURIComponent(String(rutaId))}/noticias`
      );

      if (miSecuencia !== secuencia) {
        return;
      }

      if (response.error) {
        throw new Error(response.mensaje || "No se pudieron cargar las noticias.");
      }

      const items = Array.isArray(response.items) ? response.items : [];
      const titulo = document.createElement("h3");
      titulo.textContent = `Fuentes de noticias (${response.total ?? items.length})`;
      const contenido = [titulo];

      if (!items.length) {
        const vacio = document.createElement("p");
        vacio.textContent = "No hay noticias para esta ruta.";
        contenido.push(vacio);
        panel.replaceChildren(...contenido);
        return;
      }

      const tabla = document.createElement("table");
      tabla.className = "rr-tabla";
      const thead = tabla.createTHead();
      const encabezado = thead.insertRow();

      ["Titular", "Fuente", "Fecha", "Zona", "Enlace"].forEach((texto) => {
        const th = document.createElement("th");
        th.textContent = texto;
        encabezado.append(th);
      });

      const tbody = tabla.createTBody();
      items.forEach((noticia) => {
        noticia = noticia && typeof noticia === "object" ? noticia : {};
        const fila = tbody.insertRow();

        ["titular", "fuente", "fecha", "zona"].forEach((campo) => {
          const celda = fila.insertCell();
          celda.textContent = noticia[campo] ?? "—";
        });

        const celdaEnlace = fila.insertCell();
        const enlace = document.createElement("a");

        try {
          const url = new URL(noticia.enlace);
          if (url.protocol === "http:" || url.protocol === "https:") {
            enlace.href = url.href;
            enlace.target = "_blank";
            enlace.rel = "noopener noreferrer";
            enlace.textContent = "Abrir";
          } else {
            enlace.textContent = "Enlace no disponible";
          }
        } catch {
          enlace.textContent = "Enlace no disponible";
        }

        celdaEnlace.append(enlace);
      });

      contenido.push(tabla);
      panel.replaceChildren(...contenido);

    } catch (error) {
      if (miSecuencia !== secuencia) {
        return;
      }

      panel.innerHTML = `
        <div class="notice">
          No se pudieron cargar las fuentes de noticias
          <br><br>
          <button id="retryNews">
            Reintentar
          </button>
        </div>
      `;

      document
        .getElementById("retryNews")
        ?.addEventListener("click", () => cargar(rutaId));
    }
  }

  function limpiar() {
    secuencia += 1;
    const panel = document.getElementById("riesgoNoticias");

    if (panel) {
      panel.innerHTML = `
        <h3>Fuentes de noticias</h3>
        <p>Selecciona una ruta para consultar noticias relacionadas.</p>
      `;
    }
  }

  return {
    cargar,
    limpiar,
  };
})();