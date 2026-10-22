import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { TranslationHost } from './host.mjs';
import { createPreviewRoomBudget } from './preview.mjs';
import { createCallRetirer } from './retirement.mjs';
import { MultiRoomTranslationHost } from './multi-room.mjs';
import { createFleetAllowance } from './fleet-allowance.mjs';

const here = dirname(fileURLToPath(import.meta.url)), require = createRequire(import.meta.url);
const env = { ...process.env, ...(process.env.CONFIG_PATH ? JSON.parse(await readFile(process.env.CONFIG_PATH, 'utf8')) : {}) };
const config = { publicOrigin: env.PUBLIC_ORIGIN, authId: env.PLIVO_AUTH_ID, authToken: env.PLIVO_AUTH_TOKEN,
  applicationId: env.PLIVO_APP_ID, pyaiKey: env.PYAI_API_KEY,
  endpointUsernames: { customer: env.PLIVO_CUSTOMER_USERNAME, agent: env.PLIVO_AGENT_USERNAME, replacement: env.PLIVO_REPLACEMENT_USERNAME } };
const consolePermanent = env.CONSOLE_PERMANENT === '1';
const deadline = consolePermanent ? Infinity : Date.parse(env.TEST_DEADLINE ?? '');
const consolePreview = env.CONSOLE_PREVIEW === '1';
if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || !/^[a-z0-9][a-z0-9._-]{2,62}$/.test(env.JOURNAL_BUCKET ?? '')
    || !/^[\w/-]{1,160}$/.test(env.JOURNAL_PREFIX ?? '') || (consolePermanent && consolePreview)
    || (!consolePermanent && (!Number.isFinite(deadline) || deadline <= Date.now()
      || deadline > Date.now() + (consolePreview ? 86_400_000 : 1_800_000)))
    || (consolePermanent && (!/^[a-z0-9-]{8,80}$/.test(env.SERVICE_ID ?? '')
      || !/^[a-z0-9-]{1,100}$/.test(env.SERVICE_REVISION ?? '') || env.K_REVISION === undefined))
    || (consolePreview && (!/^[a-z0-9-]{8,80}$/.test(env.PREVIEW_ID ?? '')
      || !/^[a-z0-9-]{1,100}$/.test(env.K_REVISION ?? '')))) throw new Error('invalid_bounded_test_config');
const carrierAuthorization = 'Basic ' + Buffer.from(`${config.authId}:${config.authToken}`).toString('base64');
const carrierBase = `https://api.plivo.com/v1/Account/${config.authId}`;
let adc = { value: '', expires: 0 };
async function cloudToken() {
  if (adc.expires > Date.now() + 30_000) return adc.value;
  const response = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error('journal_identity_failed');
  const value = await response.json(); adc = { value: value.access_token, expires: Date.now() + value.expires_in * 1000 };
  return adc.value;
}
const previewBudget = consolePreview ? createPreviewRoomBudget({ bucket: env.JOURNAL_BUCKET, prefix: env.JOURNAL_PREFIX,
  previewId: env.PREVIEW_ID, deadline, token: cloudToken }) : null;
const endpointPool = consolePermanent ? (typeof env.PLIVO_ENDPOINT_POOL === 'string'
  ? JSON.parse(env.PLIVO_ENDPOINT_POOL) : env.PLIVO_ENDPOINT_POOL) : null;
// Permanent storage/lifecycle owner provides CAS endpoint leases and exact-call recovery.
const retire = createCallRetirer(config);
const permanentAllowance = consolePermanent ? createFleetAllowance({ bucket: env.JOURNAL_BUCKET,
  prefix: env.JOURNAL_PREFIX, serviceId: env.SERVICE_ID, token: cloudToken }) : null;
const permanentLeases = consolePermanent ? (await import('./fleet-leases.mjs')).createFleetLeases({
  bucket: env.JOURNAL_BUCKET, prefix: env.JOURNAL_PREFIX, serviceId: env.SERVICE_ID, token: cloudToken,
  reserveAllowance: (roomId, options) => permanentAllowance.reserve(roomId, options),
  recover: async ({ callIds }) => { await Promise.all(callIds.map(callId => retire(callId))); } }) : null;
if (consolePermanent && ['reserveRoom', 'releaseRoom', 'recordEntry'].some(key => typeof permanentLeases?.[key] !== 'function')) {
  throw new Error('permanent_durable_room_leases_required');
}
const Host = consolePermanent ? MultiRoomTranslationHost : TranslationHost;
const host = new Host(config, {
  ...(consolePermanent ? { endpointPool, reserveRoom: permanentLeases.reserveRoom, releaseRoom: permanentLeases.releaseRoom,
    reconcileRoom: permanentLeases.reconcileRoom }
    : { maxRooms: consolePreview ? 12 : 2, absoluteDeadline: deadline,
      reserveRoom: previewBudget ? room => previewBudget.reserve(room) : async () => {} }),
  mintToken: async claims => {
    const response = await fetch(`${carrierBase}/JWT/Token/`, { method: 'POST', headers: {
      Authorization: carrierAuthorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(claims), signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('carrier_token_failed');
    return (await response.json()).token;
  },
  retire,
  record: async entry => {
    if (consolePermanent) await permanentLeases.recordEntry(entry);
    const token = await cloudToken();
    const name = `${env.JOURNAL_PREFIX}/${entry.host_room_id}/${String(entry.host_sequence).padStart(6, '0')}.json`;
    const response = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${env.JOURNAL_BUCKET}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(name)}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(entry), signal: AbortSignal.timeout(1700) });
    if (!response.ok) throw new Error('journal_write_failed');
    if (entry.event === 'host.room.closed' && entry.cleanup === 'calls_terminal_verified') previewBudget?.retired(entry.host_room_id);
  },
});
const assets = new Map([
  ['/', ['text/html; charset=utf-8', await readFile(join(here, 'index.html'))]],
  ['/browser.mjs', ['application/javascript; charset=utf-8', await readFile(join(here, 'browser.mjs'))]],
  ['/plivo-browser.js', ['application/javascript', await readFile(require.resolve('plivo-browser-sdk'))]],
  ['/plivobrowsersdk.js.LICENSE.txt', ['text/plain; charset=utf-8', await readFile(require.resolve('plivo-browser-sdk') + '.LICENSE.txt')]],
]);
const equal = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.plivo.com wss://*.plivo.com https://*.plivocdn.com wss://*.plivocdn.com; media-src 'self' blob: mediastream: https://*.plivo.com https://*.plivocdn.com; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'" };
let inFlight = 0;
const webhookFailureCodes = new Set(['invalid_plivo_signature', 'invalid_call_binding', 'journal_write_failed',
  'journal_identity_failed', 'journal_limit', 'body_limit', 'call_admission_failed']);
const storageFailureCodes = new Set(['fleet_allowance_unavailable', 'fleet_lease_storage_failed',
  'fleet_lease_response_limit', 'fleet_lease_binding_failed', 'fleet_drain_busy',
  'journal_write_failed', 'journal_identity_failed', 'journal_limit']);
const admissionBusyCodes = new Set(['rooms_at_capacity', 'test_allowance_exhausted', 'fleet_allowance_busy', 'host_draining']);
const admissionFailureCodes = new Set([...storageFailureCodes, ...admissionBusyCodes,
  'invalid_room', 'invalid_room_binding', 'body_limit', 'room_not_found']);
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { if ((size += chunk.length) > 8192) throw new Error('body_limit'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
const server = createServer(async (req, res) => {
  const send = (code, value, type = 'application/json') => { res.writeHead(code, { ...headers, 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(value) : value); };
  if (++inFlight > (consolePermanent ? 64 : 12)) { inFlight--; return send(429, { error: 'request_limit' }); }
  try {
    if (Date.now() >= deadline) return send(410, { error: 'test_expired' });
    // Cloud Run reserves some paths ending in z; keep application readiness on /health.
    if (req.method === 'GET' && req.url === '/health') return send(200, consolePermanent
      ? { status: 'ready', recording_supported: true, mode: 'permanent', maximum_active_rooms: 10 }
      : { status: 'ready', recording_supported: true, expires_at: new Date(deadline).toISOString() });
    if (req.method === 'GET' && assets.has(req.url)) { const [type, value] = assets.get(req.url); return send(200, value, type); }
    if (req.method === 'POST' && ['/plivo/voice', '/plivo/status'].includes(req.url)) {
      if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return send(415, { error: 'invalid_content_type' });
      const params = new URLSearchParams(await body(req));
      if (new Set(params.keys()).size !== [...params.keys()].length) return send(400, { error: 'duplicate_parameter' });
      const signature = String(req.headers['x-plivo-signature-v3'] ?? ''), nonce = String(req.headers['x-plivo-signature-v3-nonce'] ?? '');
      if (req.url === '/plivo/status') { await host.status(Object.fromEntries(params), signature, nonce); return send(200, { accepted: true }); }
      const xml = await host.answer(Object.fromEntries(params), signature, nonce);
      return send(200, xml, 'text/xml');
    }
    if (req.headers.origin && req.headers.origin !== config.publicOrigin) return send(403, { error: 'origin_denied' });
    if ((consolePreview || consolePermanent) && (!equal(String(req.headers.authorization ?? ''), `Bearer ${env.ADMIN_TOKEN}`)
        || req.headers['x-pyai-preview-id'] !== (consolePermanent ? env.SERVICE_ID : env.PREVIEW_ID)
        || req.headers['x-pyai-preview-revision'] !== (consolePermanent ? env.SERVICE_REVISION : env.K_REVISION))) {
      return send(401, { error: 'unauthorized' });
    }
    const scope = { project: req.headers['x-pyai-room-project'], owner: req.headers['x-pyai-room-owner'] };
    if (req.method === 'GET' && req.url === '/capacity' && consolePermanent) return send(200, {...host.capacity(),recording_supported:true});
    if (req.method === 'POST' && req.url === '/drain' && consolePermanent) {
      const value = JSON.parse(await body(req));
      if (Object.keys(value).length !== 1 || typeof value.paused !== 'boolean') throw new Error('invalid_drain_state');
      const durable = await permanentLeases.setPaused(value.paused);
      return send(200, { ...host.pauseAdmissions(value.paused), ...durable });
    }
    if (req.method === 'POST' && req.url === '/join') {
      const joined = JSON.parse(await body(req));
      return send(200, await (consolePermanent ? host.mint(joined.grant, joined.room_id, scope) : host.mint(joined.grant)));
    }
    if (!equal(String(req.headers.authorization ?? ''), `Bearer ${env.ADMIN_TOKEN}`)) return send(401, { error: 'unauthorized' });
    if (req.method === 'POST' && req.url === '/rooms') return send(201, await host.create(JSON.parse(await body(req)), scope));
    if (req.method === 'GET' && consolePermanent && req.url.startsWith('/room?')) {
      const query = new URL(req.url, config.publicOrigin).searchParams;
      if ([...query.keys()].length !== 1 || !query.has('room_id')) throw new Error('invalid_room_binding');
      return send(200, host.snapshot(query.get('room_id'), scope));
    }
    if (req.method === 'GET' && req.url === '/room' && !consolePermanent) return send(200, host.snapshot());
    if (req.method === 'POST' && req.url === '/end') {
      if (consolePermanent) {
        const ended = JSON.parse(await body(req));
        await host.finish('host_closed', ended.room_id, scope); return send(200, host.snapshot(ended.room_id, scope));
      }
      if (consolePreview && JSON.parse(await body(req)).room_id !== host.room?.id) return send(409, { error: 'room_changed' });
      await host.finish(); return send(200, host.snapshot());
    }
    if (req.method === 'POST' && req.url === '/commit') {
      const { leg, room_id: roomId } = JSON.parse(await body(req));
      if (consolePermanent) { host.commit(roomId, leg, scope); return send(200, { accepted: true }); }
      if (!['customer', 'agent'].includes(leg) || !host.room?.interpretation) throw new Error('input_not_ready');
      host.room.interpretation.commit(leg); return send(200, { accepted: true });
    }
    return send(404, { error: 'not_found' });
  } catch (error) {
    if (req.method === 'POST' && ['/plivo/voice', '/plivo/status'].includes(req.url)) {
      console.warn(JSON.stringify({ event: 'carrier_webhook_rejected',
        code: webhookFailureCodes.has(error?.message) ? error.message : 'request_rejected' }));
    }
    const storageFailure = consolePermanent && storageFailureCodes.has(error?.message);
    const busy = consolePermanent && admissionBusyCodes.has(error?.message);
    const notFound = consolePermanent && ['room_not_found', 'invalid_room_binding'].includes(error?.message);
    const status = storageFailure ? 503 : busy ? 429 : notFound ? 404 : 400;
    if (req.method === 'POST' && req.url === '/rooms') {
      // Fixed codes and numeric HTTP statuses only; never serialize the exception or request.
      const retryStatus = error?.status === 429 || (Number.isInteger(error?.status) && error.status >= 500 && error.status <= 599)
        ? error.status : undefined;
      console.warn(JSON.stringify({ event: 'room_admission_rejected',
        code: admissionFailureCodes.has(error?.message) ? error.message : 'request_rejected', http_status: status,
        ...(retryStatus === undefined ? {} : { retry_status: retryStatus }) }));
    }
    if (storageFailure) { res.setHeader('Retry-After', '1'); send(status, { error: 'test_unavailable' }); }
    else if (busy) send(status, { error: error.message });
    else if (notFound) send(status, { error: 'room_not_found' });
    else send(status, { error: 'request_rejected' });
  }
  finally { inFlight--; }
});
server.requestTimeout = 10_000; server.headersTimeout = 10_000;
const sockets = new WebSocketServer({ noServer: true, maxPayload: 16384 });
server.on('upgrade', (req, socket, head) => {
  const endpoint = Date.now() < deadline && host.admit(req.url, String(req.headers['x-plivo-signature-v3'] ?? ''),
    String(req.headers['x-plivo-signature-v3-nonce'] ?? ''));
  if (!endpoint) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  sockets.handleUpgrade(req, socket, head, ws => host.attach(endpoint, ws));
});
async function stop() {
  clearTimeout(expiry); await (consolePermanent ? host.finishAll('host_shutdown') : host.finish('test_deadline'));
  for (const client of sockets.clients) client.terminate();
  server.close(); sockets.close();
}
const expiry = consolePermanent ? null : setTimeout(() => { void stop(); }, deadline - Date.now()); expiry?.unref();
process.once('SIGTERM', () => { void stop(); });
await new Promise(resolve => server.listen(Number(env.PORT ?? 8080), '0.0.0.0', resolve));
console.log(JSON.stringify({ event: consolePermanent ? 'carrier_host_ready' : 'test_host_ready', port: server.address().port,
  ...(consolePermanent ? { mode: 'permanent', maximum_active_rooms: 10 } : { expires_at: new Date(deadline).toISOString() }) }));
