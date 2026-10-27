import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import { TranslationHost } from './host.mjs';
import { MultiRoomTranslationHost } from './multi-room.mjs';
import { createPreviewRoomBudget } from './preview.mjs';
import { createEventJournal } from './journal.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const env = { ...process.env, ...(process.env.CONFIG_PATH ? JSON.parse(await readFile(process.env.CONFIG_PATH, 'utf8')) : {}) };
const config = { publicOrigin: env.PUBLIC_ORIGIN, accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN,
  applicationSid: env.TWILIO_APPLICATION_SID, apiKeySid: env.TWILIO_API_KEY_SID, apiKeySecret: env.TWILIO_API_KEY_SECRET,
  pyaiKey: env.PYAI_API_KEY, identityPrefix: env.CONSOLE_PREVIEW === '1' ? env.PREVIEW_OWNER : undefined };
const deadline = Date.parse(env.TEST_DEADLINE ?? '');
const consolePreview = env.CONSOLE_PREVIEW === '1';
const concurrentTest = env.CONCURRENT_ROOMS === '10';
if (env.CONCURRENT_ROOMS !== undefined && !concurrentTest || concurrentTest && consolePreview) throw new Error('invalid_pool_config');
if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || !/^[a-z0-9][a-z0-9._-]{2,62}$/.test(env.JOURNAL_BUCKET ?? '')
    || !/^[\w/-]{1,160}$/.test(env.JOURNAL_PREFIX ?? '') || !Number.isFinite(deadline)
    || deadline <= Date.now() || deadline > Date.now() + (consolePreview ? 86_400_000 : 1_800_000)
    || (consolePreview && (!/^[a-z0-9-]{8,80}$/.test(env.PREVIEW_ID ?? '')
      || !/^[0-9a-f]{20}$/.test(env.PREVIEW_OWNER ?? '')))) throw new Error('invalid_bounded_test_config');

const client = twilio(config.accountSid, config.authToken, { timeout: 4000, autoRetry: false });
let adc = { value: '', expires: 0 };
async function cloudToken() {
  if (adc.expires > Date.now() + 30_000) return adc.value;
  const response = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error('journal_identity_failed');
  const value = await response.json(); adc = { value: value.access_token, expires: Date.now() + value.expires_in * 1000 };
  return adc.value;
}

const writeJournal = createEventJournal({ bucket: env.JOURNAL_BUCKET, prefix: env.JOURNAL_PREFIX, token: cloudToken });

const previewBudget = consolePreview ? createPreviewRoomBudget({ bucket: env.JOURNAL_BUCKET,
  prefix: env.JOURNAL_PREFIX, previewId: env.PREVIEW_ID, deadline, token: cloudToken }) : null;
const host = new (concurrentTest ? MultiRoomTranslationHost : TranslationHost)(config, {
  maxRooms: consolePreview ? 12 : 2, absoluteDeadline: deadline,
  ...(concurrentTest ? { roomLifetimeMs: env.ROOM_SECONDS === undefined ? 480_000 : Number(env.ROOM_SECONDS) * 1000 } : {}),
  reserveRoom: concurrentTest ? async binding => {
    const name = `${env.JOURNAL_PREFIX}/admissions/${binding.slotId}.json`;
    const response = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${env.JOURNAL_BUCKET}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(name)}`,
      { method: 'POST', headers: { Authorization: `Bearer ${await cloudToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(binding), signal: AbortSignal.timeout(1700), redirect: 'error' });
    if (!response.ok) throw new Error('room_reservation_failed');
    await response.body?.cancel();
  } : previewBudget ? room => previewBudget.reserve(room) : async () => {},
  limitCall: async (callId, seconds) => { await client.calls(callId).update({ timeLimit: Math.min(seconds, 480) }); },
  retire: async callId => {
    const current = await client.calls(callId).fetch();
    const terminal = ['completed', 'canceled', 'failed', 'busy', 'no-answer'];
    if (!terminal.includes(current.status)) await client.calls(callId).update({ status: 'completed' });
    const final = await client.calls(callId).fetch();
    if (!terminal.includes(final.status)) throw new Error('call_not_terminal');
  },
  record: async entry => {
    await writeJournal(entry);
    if (entry.event === 'host.room.closed' && entry.cleanup === 'calls_terminal_verified') previewBudget?.retired(entry.host_room_id);
  },
});

const assets = new Map([
  ['/', ['text/html; charset=utf-8', await readFile(join(here, 'index.html'))]],
  ['/browser.mjs', ['application/javascript; charset=utf-8', await readFile(join(here, 'browser.mjs'))]],
  ['/twilio.min.js', ['application/javascript', await readFile(join(dirname(require.resolve('@twilio/voice-sdk')), '../dist/twilio.min.js'))]],
]);
const equal = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.twilio.com wss://*.twilio.com https://media.twiliocdn.com; media-src 'self' blob: mediastream: https://media.twiliocdn.com https://sdk.twilio.com; frame-ancestors 'none'; base-uri 'none'" };
let inFlight = 0;
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { if ((size += chunk.length) > 8192) throw new Error('body_limit'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
const server = createServer(async (req, res) => {
  const send = (code, value, type = 'application/json') => { res.writeHead(code, { ...headers, 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(value) : value); };
  if (++inFlight > (concurrentTest ? 64 : 12)) { inFlight--; return send(429, { error: 'request_limit' }); }
  try {
    if (Date.now() >= deadline) return send(410, { error: 'test_expired' });
    // Cloud Run reserves some paths ending in z; keep application readiness on /health.
    if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ready', recording_supported: true, language_pairs:"all_supported",recording_formats:["mixed-v1","party-v1"], expires_at: new Date(deadline).toISOString() });
    if (req.method === 'GET' && assets.has(req.url)) { const [type, value] = assets.get(req.url); return send(200, value, type); }
    if (req.method === 'POST' && req.url === '/twilio/voice') {
      if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return send(415, { error: 'invalid_content_type' });
      const params = new URLSearchParams(await body(req));
      if (new Set(params.keys()).size !== [...params.keys()].length) return send(400, { error: 'duplicate_parameter' });
      const xml = await host.answer(Object.fromEntries(params), String(req.headers['x-twilio-signature'] ?? ''));
      return send(200, xml, 'text/xml');
    }
    if (req.headers.origin && req.headers.origin !== config.publicOrigin) return send(403, { error: 'origin_denied' });
    if (consolePreview && (!equal(String(req.headers.authorization ?? ''), `Bearer ${env.ADMIN_TOKEN}`)
        || req.headers['x-pyai-preview-id'] !== env.PREVIEW_ID
        || req.headers['x-pyai-preview-revision'] !== env.K_REVISION)) return send(401, { error: 'unauthorized' });
    if (!concurrentTest && req.method === 'POST' && req.url === '/join') {
      return send(200, host.mint(JSON.parse(await body(req)).grant));
    }
    if (!equal(String(req.headers.authorization ?? ''), `Bearer ${env.ADMIN_TOKEN}`)) return send(401, { error: 'unauthorized' });
    if (concurrentTest) {
      const url = new URL(req.url, config.publicOrigin);
      if (req.method === 'GET' && url.pathname === '/capacity') return send(200, host.capacity());
      const scope = { project: req.headers['x-pyai-room-project'], owner: req.headers['x-pyai-room-owner'] };
      if (req.method === 'GET' && url.pathname === '/room') return send(200, host.snapshot(url.searchParams.get('room_id'), scope));
      if (req.method === 'POST') {
        const input = JSON.parse(await body(req));
        if (url.pathname === '/rooms') return send(201, await host.create(input, scope));
        if (url.pathname === '/join') return send(200, host.mint(input.grant, input.room_id, scope));
        if (url.pathname === '/commit') { host.commit(input.room_id, input.leg, scope); return send(200, { accepted: true }); }
        if (url.pathname === '/end') { await host.finish('host_closed', input.room_id, scope); return send(200, host.snapshot(input.room_id, scope)); }
      }
      return send(404, { error: 'not_found' });
    }
    if (req.method === 'POST' && req.url === '/rooms') return send(201, await host.create(JSON.parse(await body(req))));
    if (req.method === 'GET' && req.url === '/room') return send(200, host.snapshot());
    if (req.method === 'POST' && req.url === '/end') {
      const { room_id } = JSON.parse(await body(req));
      if ((consolePreview || room_id !== undefined) && (typeof room_id !== 'string' || room_id !== host.room?.id))
        return send(409, { error: 'room_changed' });
      const room = host.room; await host.finish('host_closed', room); return send(200, host.snapshot());
    }
    if (req.method === 'POST' && req.url === '/commit') {
      const { leg } = JSON.parse(await body(req));
      if (!['customer', 'agent'].includes(leg) || !host.room?.interpretation) throw new Error('input_not_ready');
      host.room.interpretation.commit(leg); return send(200, { accepted: true });
    }
    return send(404, { error: 'not_found' });
  } catch (error) { send(concurrentTest && error?.message === 'session_limit' ? 429 : concurrentTest && ['room_not_found','invalid_room_binding'].includes(error?.message) ? 404 : 400, { error: 'request_rejected' }); }
  finally { inFlight--; }
});
server.requestTimeout = 10_000; server.headersTimeout = 10_000;
const sockets = new WebSocketServer({ noServer: true, maxPayload: 16384 });
server.on('upgrade', (req, socket, head) => {
  const endpoint = Date.now() < deadline && host.admit(req.url, String(req.headers['x-twilio-signature'] ?? ''));
  if (!endpoint) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  sockets.handleUpgrade(req, socket, head, ws => host.attach(endpoint, ws));
});
async function stop() {
  clearTimeout(expiry);
  await (concurrentTest ? host.finishAll('test_deadline') : host.finish('test_deadline'));
  for (const client of sockets.clients) client.terminate();
  server.close(); sockets.close();
}
const expiry = setTimeout(() => { void stop(); }, deadline - Date.now());
expiry.unref();
process.once('SIGTERM', () => { void stop(); });
await new Promise(resolve => server.listen(Number(env.PORT ?? 8080), '0.0.0.0', resolve));
console.log(JSON.stringify({ event: 'test_host_ready', port: server.address().port, expires_at: new Date(deadline).toISOString() }));
