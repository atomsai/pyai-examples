import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { configuration, routingResponse, RoutingError } from './routing.mjs';

export function createRoutingServer(config, { clock = Date.now } = {}) {
  return createServer(async (req, res) => {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const send = (status, body) => { if (!res.writableEnded) res.writeHead(status, headers).end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/healthz') { send(200, { status: 'ok', routing_enabled: config.enabled }); return; }
    if (req.url !== '/dialpad/route') { send(404, { error: 'not_found' }); return; }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); send(405, { error: 'method_not_allowed' }); return; }
    if (!['application/jwt', 'text/plain', 'application/json'].includes((req.headers['content-type'] ?? '').split(';')[0].trim())) { send(415, { error: 'signed_jwt_required' }); req.resume(); return; }
    let size = 0; const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) { send(413, { error: 'request_too_large' }); req.resume(); return; }
        chunks.push(chunk);
      }
      send(200, routingResponse(Buffer.concat(chunks).toString('utf8'), config, clock()));
    } catch (error) {
      send(error instanceof RoutingError ? error.status : 500, { error: error instanceof RoutingError ? error.message : 'routing_unavailable' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configuration(process.env);
  const port = Number(process.env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Set a valid PORT.');
  const server = createRoutingServer(config);
  server.requestTimeout = 4000;
  server.headersTimeout = 5000;
  server.listen(port, '0.0.0.0', () => console.log('Dialpad routing adapter ready; no calls or credentials are logged.'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close());
}
