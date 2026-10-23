const http = require('http');
const fs = require('fs');
const path = require('path');
 
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_ROOT = path.join(ROOT, 'public');
const API_ORIGIN = new URL(process.env.API_ORIGIN || 'http://127.0.0.1:8000');
const API_TRANSPORT = API_ORIGIN.protocol === 'https:' ? require('https') : http;
const API_PATHS = [
  '/login',
  '/generar-ruta',
  '/entregas/',
  '/eventos/',
  '/alertas/',
  '/disponibilidad/',
  '/notificaciones/',
  '/rutas-riesgo',
  '/rutas/',
  '/viajes/',
  '/agente/'
];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};
 
function resolvePublicFile(pathname) {
  // Página principal
  if (
    pathname === '/' ||
    pathname.toLowerCase() === '/paginaprincipal.html'
  ) {
    return path.join(PUBLIC_ROOT, 'pages', 'PaginaPrincipal.html');
  }

  // Página de riesgo de rutas
  if (pathname === '/riesgo_rutas.html' || pathname === '/riesgo_rutas.html') {
    return path.join(PUBLIC_ROOT, 'pages', 'riesgo_rutas.html');
  }

  if (pathname.startsWith('/assets/')) {
    const file = path.resolve(PUBLIC_ROOT, `.${pathname}`);
    const relative = path.relative(PUBLIC_ROOT, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return file;
  }

  return null;
}

function isApiPath(pathname) {
  return API_PATHS.some(prefix =>
    prefix === '/rutas-riesgo'
      ? pathname === prefix || pathname.startsWith(prefix + '/')
      : prefix.endsWith('/')
        ? pathname.startsWith(prefix)
        : pathname === prefix
  );
}

function proxyApiRequest(req, res, pathname, search) {
  const upstream = API_TRANSPORT.request({
    hostname: API_ORIGIN.hostname,
    port: API_ORIGIN.port || (API_ORIGIN.protocol === 'https:' ? 443 : 80),
    path: pathname + search,
    method: req.method,
    headers: { ...req.headers, host: API_ORIGIN.host }
  }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('error', error => {
    console.error('No se pudo conectar con la API FastAPI en ' + API_ORIGIN.origin + '.', error.message);
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      detail: 'No se pudo conectar con la API. Inicie el backend FastAPI en ' + API_ORIGIN.origin + '.'
    }));
  });
  req.pipe(upstream);
}

http.createServer((req, res) => {
  let requestUrl;
  try {
    requestUrl = new URL(req.url, 'http://localhost');
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Solicitud no válida');
  }

  if (
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
    isApiPath(requestUrl.pathname)
  ) {
    proxyApiRequest(req, res, requestUrl.pathname, requestUrl.search);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      'Content-Type': 'text/plain; charset=utf-8',
      Allow: 'GET, HEAD'
    });
    return res.end('Método no permitido');
  }

  let pathname = requestUrl.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Solicitud no válida');
  }

  const file = resolvePublicFile(pathname);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('No encontrado');
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(
        err.code === 'ENOENT' ? 404 : 500,
        { 'Content-Type': 'text/plain; charset=utf-8' }
      );
      return res.end(
        err.code === 'ENOENT'
          ? 'No encontrado'
          : 'Error interno del servidor'
      );
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}).listen(PORT, () => console.log('Servidor activo en el puerto ' + PORT));
