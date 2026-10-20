# ADR 0001: Front en JavaScript puro, un módulo por pantalla

- Estado: Aceptada
- Fecha: 2026-10-20

## Contexto
El front es una página (`public/pages/PaginaPrincipal.html`) con varias pantallas. El equipo ya trabajaba en HTML/CSS/JS sin paso de compilación y el despliegue sirve archivos estáticos.

## Decisión
JavaScript sin framework ni bundler. Un archivo por módulo (`pedidosEnCurso.js`, `centroRutas.js`, `VerificarConduJS.js`, …) expuesto en `window`, `core/api.js` para sesión y llamadas, y `dashboard.js` como arranque que cambia de pantalla. El DOM se construye sin `innerHTML` para texto de usuario. La lógica pura se exporta aparte y se prueba con `node --test` (`tests/js`).

## Alternativas consideradas
- React/Vue con build: más estructura, pero añade toolchain y reescritura sin necesidad hoy.

## Consecuencias
- Sin build, despliegue simple y pruebas rápidas.
- Estado global en `window` y orden de `<script>` importante; si el front crece, reevaluar un framework.
