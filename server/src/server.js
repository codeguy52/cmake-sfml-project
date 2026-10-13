import { createServer } from 'node:http';
import { createApp } from './app.js';

/**
 * Node entry point.
 *
 * All the routing lives in `app.js` as a plain `Request -> Response` function;
 * this file only translates between that and `node:http`, so the same backend
 * runs unchanged here, on Deno Deploy and on Cloudflare Workers (see
 * `worker.js`). Nothing about the linking logic is Node-specific.
 */

const MAX_BODY_BYTES = 64 * 1024;

const app = createApp(process.env);

/**
 * Read the body with a hard ceiling. A linking request is a few hundred bytes,
 * and buffering an unbounded upload just to hand it to the app would give away
 * the limit the app is trying to enforce.
 */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function toRequest(req, body) {
  // The URL is only used for its path; the host is whatever proxied us.
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }

  const method = req.method ?? 'GET';
  const hasBody = body !== null && body.length > 0 && method !== 'GET' && method !== 'HEAD';
  return new Request(url, { method, headers, ...(hasBody ? { body } : {}) });
}

async function send(res, response) {
  const headers = Object.fromEntries(response.headers);
  const body = Buffer.from(await response.arrayBuffer());

  if (body.length === 0) {
    // 204 must not carry a Content-Length, and there is nothing to write.
    res.writeHead(response.status, headers);
    res.end();
    return;
  }

  res.writeHead(response.status, { ...headers, 'Content-Length': body.length });
  res.end(body);
}

export const server = createServer(async (req, res) => {
  try {
    const body = await readBody(req);
    if (body === null) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body too large.' }));
      return;
    }
    await send(res, await app.handle(toRequest(req, body)));
  } catch (error) {
    // Anything reaching here is a bug in the adapter itself — the app maps its
    // own errors. Say nothing useful to the caller; log it for the operator.
    console.error('Request failed before reaching the app:', error?.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal error.' }));
  }
});

// Only listen when run directly, so tests can import the server and drive it.
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const port = Number(process.env.PORT ?? 8787);
  const { provider, allowedOrigins } = app.config;

  server.listen(port, () => {
    console.log(
      `Linking backend on http://localhost:${port} ` +
        `(provider: ${provider.name}, mode: ${provider.mode ?? 'personal'})`,
    );
    if (allowedOrigins.length === 0) {
      console.warn('ALLOWED_ORIGINS is empty — browser requests will be blocked by CORS.');
    }
  });
}
