import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import WebSocket from 'ws';
import { verifyProject, createDemo } from './server.js';
import { captureContext, applyTranscript } from './public/client.js';

const identity = { org_id: 'fixture-org', project_id: 'fixture-project', env: 'test',
  scopes: ['hear:stream'], limits: { daily_unit_cap: 10 } };

test('project and budget admission happens before any streaming connection', async () => {
  for (const change of [{ project_id: 'wrong' }, { env: 'live' }, { scopes: [] },
    { limits: undefined }, { limits: [] }, { limits: { daily_unit_cap: 0 } }, { limits: { daily_unit_cap: '10' } }]) {
    await assert.rejects(verifyProject({ apiKey: 'fixture-secret', projectId: identity.project_id,
      fetchImpl: async () => Response.json({ ...identity, ...change }) }));
  }
  const result = await verifyProject({ apiKey: 'fixture-secret', projectId: identity.project_id,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.pyai.com/v1/me');
      assert.equal(options.headers.Authorization, 'Bearer fixture-secret');
      return Response.json({ ...identity, api_key: 'must-not-return' });
    } });
  assert.equal(result.project_id, identity.project_id);
  assert.equal(result.api_key, undefined);
});

test('requests actual 16 kHz; unsupported 48 kHz closes before connection', () => {
  let closed = false;
  class AudioContext { constructor(options) { assert.equal(options.sampleRate, 16000); this.sampleRate = 16000; } }
  assert.equal(captureContext(AudioContext).sampleRate, 16000);
  class WrongRate { sampleRate = 48000; close() { closed = true; } }
  assert.throws(() => captureContext(WrongRate), /did not provide 16 kHz/);
  assert.equal(closed, true);
});

test('speech_final then corrected final commits one corrected sentence', () => {
  const finals = new Map();
  for (const type of ['partial', 'partial_stable', 'speech_final']) {
    assert.equal(applyTranscript(finals, { type, text: 'tuesday', utterance_id: '1' }), 'tuesday');
    assert.equal(finals.size, 0);
  }
  applyTranscript(finals, { type: 'final', text: 'Tuesday.', utterance_id: '1' });
  applyTranscript(finals, { type: 'final', text: 'Tuesday.', utterance_id: '1' });
  assert.deepEqual([...finals.values()], ['Tuesday.']);
});

async function localDemo(t, options = {}) {
  let connections = 0;
  const upstream = new EventEmitter();
  upstream.readyState = WebSocket.OPEN;
  upstream.bufferedAmount = 0;
  upstream.send = data => { upstream.sent = data; };
  upstream.terminate = () => { upstream.terminated = true; };
  const server = createDemo({ identity, apiKey: 'fixture-secret', ...options,
    connect: () => { connections++; setImmediate(() => upstream.emit('open')); return upstream; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, upstream, origin, connections: () => connections,
    socket: (from = origin) => new WebSocket(origin.replace('http:', 'ws:') + '/stream', { origin: from }) };
}

test('local proxy hides credentials, rejects foreign origins, relays frames and permits one attempt', async t => {
  const demo = await localDemo(t);
  const page = await (await fetch(demo.origin)).text();
  assert.doesNotMatch(page, /fixture-secret|pyai-key|id="key"/);
  assert.deepEqual(await (await fetch(demo.origin + '/identity')).json(), identity);
  const wrong = demo.socket('https://foreign.example');
  await once(wrong, 'error');
  assert.equal(demo.connections(), 0);
  const client = demo.socket();
  const [ready] = await once(client, 'message');
  assert.equal(JSON.parse(ready).type, 'ready');
  const received = once(client, 'message');
  demo.upstream.emit('message', Buffer.from('{"type":"final","text":"fixture"}'), false);
  assert.equal(JSON.parse((await received)[0]).text, 'fixture');
  client.send(Buffer.from([0, 0])); // Synthetic bytes, no model or audio service.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(demo.upstream.sent, Buffer.from([0, 0]));
  client.close(); await once(client, 'close');
  const again = demo.socket(); await once(again, 'error');
  assert.equal(demo.connections(), 1);
  assert.equal(demo.upstream.terminated, true);
});

test('session deadline closes idle upstream without retry', async t => {
  const demo = await localDemo(t, { durationMs: 30 });
  const client = demo.socket(); await once(client, 'close');
  assert.equal(demo.upstream.terminated, true);
  assert.equal(demo.connections(), 1);
});

test('browser uses local socket only after verified capture and stops tracks on close', async () => {
  const html = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/import .*?;\n/, '');
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { classList: { add() {}, remove() {} } }); return elements.get(id); };
  let contextOptions, trackStopped = false, socket;
  class AudioContext {
    sampleRate = 16000;
    constructor(options) { contextOptions = options; }
    async resume() {} close() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return { connect() {}, disconnect() {} }; }
  }
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor(url, protocols) { assert.equal(protocols, undefined); this.url = url; socket = this; }
    close() { this.readyState = 3; }
  }
  vm.runInNewContext(script, { captureContext, applyTranscript, document: { getElementById: element },
    window: { AudioContext, addEventListener() {} }, location: { host: '127.0.0.1:5173' },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { trackStopped = true; } }] }) } },
    fetch: async () => Response.json(identity), WebSocket: Socket });
  await element('toggle').onclick();
  assert.equal(contextOptions.sampleRate, 16000);
  assert.equal(socket.url, 'ws://127.0.0.1:5173/stream');
  socket.onmessage({ data: '{"type":"ready"}' });
  socket.onclose({ code: 1000 });
  assert.equal(trackStopped, true);
  assert.equal(element('toggle').disabled, true);
});

for (const [label, payload, congested] of [
  ['text control', 'arbitrary control', false],
  ['odd-length PCM', Buffer.from([0]), false],
  ['upstream backpressure', Buffer.from([0, 0]), true],
]) test(`invalid or congested input stops the only session: ${label}`, async t => {
  const demo = await localDemo(t);
  const client = demo.socket(); await once(client, 'message');
  if (congested) demo.upstream.bufferedAmount = 65 * 1024;
  client.send(payload); await once(client, 'close');
  assert.equal(demo.upstream.sent, undefined);
  assert.equal(demo.upstream.terminated, true);
  assert.equal(demo.connections(), 1);
});
