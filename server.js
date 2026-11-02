const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = __dirname;
const SITE_DIR = path.join(ROOT, 'site');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);
const STM_STATUS_URL = 'https://api.stm.info/pub/od/i3/v2/messages/etatservice';
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function sendJSON(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload));
}

async function serveStaticFile(pathname, response) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }

  const isDataFile = decodedPath.startsWith('/data/');
  const baseDir = isDataFile ? DATA_DIR : SITE_DIR;
  const relativePath = decodedPath === '/'
    ? 'index.html'
    : decodedPath.slice(isDataFile ? '/data/'.length : 1);
  const filePath = path.resolve(baseDir, relativePath);
  if (!filePath.startsWith(baseDir + path.sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const contentType = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': contentType });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') {
      response.writeHead(404).end('Not found');
      return;
    }
    throw error;
  }
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' }).end('Method not allowed');
    return;
  }

  if (requestUrl.pathname === '/api/stm/service-status') {
    const apiKey = process.env.STM_API_KEY;
    if (!apiKey) {
      sendJSON(response, 503, { error: 'STM_API_KEY is not configured on the server.' });
      return;
    }

    let upstream;
    try {
      upstream = await fetch(STM_STATUS_URL, {
        headers: { apiKey: apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      });
    } catch (error) {
      console.error('STM service-status request failed:', error.message);
      sendJSON(response, 502, { error: 'Could not reach the STM service-status feed.' });
      return;
    }

    const body = await upstream.text();
    if (!upstream.ok) {
      const diagnostic = body.slice(0, 1000).split(apiKey).join('[redacted]');
      console.error('STM service-status returned HTTP', upstream.status, diagnostic);
      sendJSON(response, 502, { error: `STM service-status returned HTTP ${upstream.status}.` });
      return;
    }

    try {
      JSON.parse(body);
    } catch (error) {
      console.error('STM service-status returned invalid JSON:', error.message);
      sendJSON(response, 502, { error: 'STM returned an invalid service-status response.' });
      return;
    }

    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8'
    });
    response.end(body);
    return;
  }

  await serveStaticFile(requestUrl.pathname, response);
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error('Request failed:', error);
    if (!response.headersSent) {
      sendJSON(response, 500, { error: 'The local map server encountered an error.' });
    } else {
      response.destroy();
    }
  });
});

// On Render the server must accept outside connections; locally it stays private to this computer.
const HOST = process.env.RENDER ? '0.0.0.0' : '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.log(`Map running at http://localhost:${PORT}`);
});
