import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// The public examples mirror bundles these canonical modules beside the starter.
const bundledWidgets = new URL('./trace-widgets/', import.meta.url);
const widgetRoot = existsSync(new URL('model.mjs', bundledWidgets))
  ? bundledWidgets : new URL('../../console/public/trace-widgets/', import.meta.url);
const { traceDashboardResponse } = await import(new URL('server-adapter.mjs', widgetRoot));
const { SAMPLE_EXPOSURE, projectExposure } = await import(new URL('model.mjs', widgetRoot));

const live = process.argv.includes('--live');
const port = Number(process.env.PORT || 3024);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port from 1024 to 65535.');
if (live && !process.env.PYAI_API_KEY) throw new Error('Set PYAI_API_KEY in your server environment before choosing live mode.');
const staticFiles = new Map([
  ['/', [new URL('./index.html', import.meta.url), 'text/html; charset=utf-8']],
  ['/app.mjs', [new URL('./app.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ...['model.mjs', 'trace-dashboard.mjs'].map(file => [`/trace-widgets/${file}`, [new URL(file, widgetRoot), 'text/javascript; charset=utf-8']]),
]);
const security = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};
// This preview is local only. Production uses your application's existing
// authentication and tenant lookup with traceDashboardResponse instead.
const server = createServer(async (req, res) => {
  try {
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) { res.writeHead(403, security).end(); return; }
    const origin = `http://${req.headers.host}`;
    if (req.headers.origin && req.headers.origin !== origin) { res.writeHead(403, security).end(); return; }
    if (req.method !== 'GET') { res.writeHead(405, { ...security, Allow: 'GET' }).end(); return; }
    const url = new URL(req.url, origin);
    if (url.pathname === '/api/trace-dashboard') {
      const days = url.searchParams.get('window_days') || '30';
      if (!['7', '30', '90'].includes(days)) { res.writeHead(400, security).end(); return; }
      const result = live
        ? await traceDashboardResponse(new Request(url), { resolveApiKey: async () => process.env.PYAI_API_KEY })
        : new Response(JSON.stringify({ exposure: projectExposure({ ...SAMPLE_EXPOSURE, window_days: Number(days) }), generated_at: new Date().toISOString(), sample: true }), { headers: { 'Content-Type': 'application/json' } });
      res.writeHead(result.status, { ...security, ...Object.fromEntries(result.headers) }); res.end(await result.text()); return;
    }
    const file = staticFiles.get(url.pathname);
    if (!file) { res.writeHead(404, security).end(); return; }
    res.writeHead(200, { ...security, 'Content-Type': file[1] }); res.end(await readFile(file[0]));
  } catch { if (!res.headersSent) res.writeHead(500, security); res.end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`Trace dashboard preview: http://127.0.0.1:${port} (${live ? 'live organization data' : 'fictional sample data'})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
