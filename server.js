const http = require('http');
const fs = require('fs');
const path = require('path');
 
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_ROOT = path.join(ROOT, 'public');
const PAGE_NAMES = new Set([
  'PaginaPrincipal.html',
  'alertasSeguridad.html',
  'entregasDia.html',
  'eventosEspeciales.html',
  'Verificar conductores.html'
]);
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
  if (pathname === '/' || pathname === '/PaginaPrincipal.html') {
    return path.join(PUBLIC_ROOT, 'pages', 'PaginaPrincipal.html');
  }

  const pageName = pathname.slice(1);
  if (PAGE_NAMES.has(pageName)) {
    return path.join(PUBLIC_ROOT, 'pages', pageName);
  }

  if (pathname.startsWith('/assets/')) {
    const file = path.resolve(PUBLIC_ROOT, `.${pathname}`);
    const relative = path.relative(PUBLIC_ROOT, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return file;
  }

  return null;
}

http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    return res.end('Método no permitido');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
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
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(err.code === 'ENOENT' ? 'No encontrado' : 'Error interno del servidor');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}).listen(PORT, () => console.log('Servidor activo en el puerto ' + PORT));
