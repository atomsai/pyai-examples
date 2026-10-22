import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import twilio from 'twilio';
import { TranslationHost } from '../host.mjs';

const config = { publicOrigin: 'https://test.example.com', accountSid: `AC${'a'.repeat(32)}`,
  applicationSid: `AP${'b'.repeat(32)}`, apiKeySid: `SK${'c'.repeat(32)}`, apiKeySecret: 'fixture-signing-secret',
  authToken: 'fixture-account-token', pyaiKey: 'fixture-interpretation-key' };
const input = { language: 'hi', customerVoice: 'hi1', agentVoice: 'en1' };
const grantOf = link => new URL(link).hash.slice(1);
const signature = form => twilio.getExpectedTwilioSignature(config.authToken, `${config.publicOrigin}/twilio/voice`, form);
const makeForm = (host, role, digit) => ({ AccountSid: config.accountSid,
  CallSid: `CA${digit.repeat(32)}`, From: `client:${host.room.endpoints[role].identity}`,
  JoinGrant: host.room.endpoints[role].grant });

test('preview reserves durable allowance before issuing grants and clamps rooms to the fixed preview end', async () => {
  const reserved = [], host = new TranslationHost({ ...config, identityPrefix: 'a'.repeat(20) }, { now: () => 1000, maxRooms: 12, absoluteDeadline: 2000,
    reserveRoom: async value => reserved.push(value), record: async () => {}, retire: async () => {} });
  try {
    const room = await host.create(input);
    assert.equal(Date.parse(room.expires_at), 2000);
    assert.deepEqual(reserved, [{ id: room.id, expiresAt: 2000 }]);
    assert.ok(Object.values(host.room.endpoints).every(endpoint => endpoint.identity.startsWith('pyai_test_' + 'a'.repeat(20) + '_')),
      'independent cleanup can identify only this preview’s browser calls');
  } finally { await host.finish(); }
  const denied = new TranslationHost(config, { maxRooms: 12, reserveRoom: async () => { throw new Error('allowance_exhausted'); },
    record: async () => {}, retire: async () => {} });
  await assert.rejects(denied.create(input), /allowance_exhausted/);
  assert.equal(denied.grants.size, 0); assert.equal(denied.snapshot().state, 'closed');
});

test('browser grant and signed Twilio webhook bind one exact identity, call and WSS upgrade', async () => {
  const records = [], limits = [];
  const host = new TranslationHost(config, { record: async e => records.push(e), retire: async () => {},
    limitCall: async (...args) => limits.push(args) });
  try {
    const room = await host.create(input), grant = grantOf(room.links.customer);
    assert.throws(() => host.mint('unknown'), /invalid_join_grant/);
    const minted = host.mint(grant);
    const claims = JSON.parse(Buffer.from(minted.token.split('.')[1], 'base64url'));
    assert.equal(claims.grants.voice.outgoing.application_sid, config.applicationSid);
    assert.notEqual(claims.grants.voice.incoming?.allow, true);
    assert.throws(() => host.mint(grant), /invalid_join_grant/);
    const form = makeForm(host, 'customer', '1');
    await assert.rejects(host.answer(form, 'bad'), /invalid_twilio_signature/);
    const otherIdentity = { ...form, From: 'client:someone_else' };
    await assert.rejects(host.answer(otherIdentity, signature(otherIdentity)), /invalid_call_binding/);
    const xml = await host.answer(form, signature(form));
    assert.equal(limits.length, 0, 'answer must not update a call that may still be ringing');
    await assert.rejects(host.answer(form, signature(form)), /invalid_call_binding/);
    const stream = xml.match(/url="([^"]+)"/)[1], path = new URL(stream).pathname;
    assert.equal(host.admit(path, 'bad'), null);
    const wsSignature = twilio.getExpectedTwilioSignature(config.authToken, stream, {});
    assert.equal(host.admit(path, wsSignature)?.callId, form.CallSid);
    assert.equal(host.admit(path, wsSignature), null, 'stream admission is single-use');
    assert.equal(records[0].event, 'host.room.created');
    assert.ok(!JSON.stringify(host.snapshot()).includes('fixture-signing-secret'));
  } finally { await host.finish(); }
});

test('two started legs create one interpreter; replacement preserves room, retires old call, ends all owned calls', async () => {
  const rooms = [], retired = [], records = [], limits = [], started = new Map(), limited = new Map();
  class Transport {
    constructor(socket, callId, participantId) {
      this.callId = callId; this.participantId = participantId;
      this.ready = new Promise(resolve => started.set(callId, resolve));
    }
    close() { this.closed = true; }
  }
  class Room {
    constructor(opts) { this.opts = opts; rooms.push(this); void opts.record({ event: 'session.started' }); }
    async replaceAgent(participant, transport) {
      await this.opts.retireCall(this.opts.legs.agent.transport.callId);
      this.opts.legs.agent = { participant, transport };
      await this.opts.record({ event: 'session.updated', revision: 2 });
    }
    close(reason) { this.opts.onClose(reason); }
  }
  const host = new TranslationHost(config, { Room, Transport, record: async e => records.push(e),
    retire: async callId => { retired.push(callId); }, limitCall: (callId, seconds) => {
      limits.push({ callId, seconds }); return new Promise(resolve => limited.set(callId, resolve));
    } });
  try {
    await host.create(input);
    for (const [role, digit] of [['customer', '1'], ['agent', '2']]) {
      host.mint(host.room.endpoints[role].grant);
      const form = makeForm(host, role, digit);
      const xml = await host.answer(form, signature(form)), url = xml.match(/url="([^"]+)"/)[1];
      const endpoint = host.admit(new URL(url).pathname, twilio.getExpectedTwilioSignature(config.authToken, url, {}));
      host.attach(endpoint, {});
    }
    assert.equal(limits.length, 0, 'attached transports must wait for actual media start');
    started.get(`CA${'2'.repeat(32)}`)(); await delay(0);
    assert.equal(limits.length, 1); assert.equal(rooms.length, 0);
    started.get(`CA${'1'.repeat(32)}`)(); await delay(0);
    assert.equal(limits.length, 2); assert.equal(rooms.length, 0, 'both pending carrier limits block the interpreter');
    assert.ok(limits.every(item => item.seconds > 0 && item.seconds <= 480));
    assert.ok(!records.some(item => item.event === 'host.call.connected'));
    limited.get(`CA${'1'.repeat(32)}`)(); await delay(0);
    assert.equal(rooms.length, 0, 'one completed limit cannot bypass the other pending limit');
    limited.get(`CA${'2'.repeat(32)}`)(); await delay(20);
    assert.equal(rooms.length, 1); assert.equal(host.snapshot().state, 'connected');
    host.mint(host.room.endpoints.replacement.grant);
    const form = makeForm(host, 'replacement', '3');
    const xml = await host.answer(form, signature(form)), url = xml.match(/url="([^"]+)"/)[1];
    assert.equal(limits.length, 2, 'replacement answer also leaves its ringing call untouched');
    host.attach(host.admit(new URL(url).pathname, twilio.getExpectedTwilioSignature(config.authToken, url, {})), {});
    assert.equal(limits.length, 2);
    started.get(`CA${'3'.repeat(32)}`)(); await delay(0);
    assert.equal(limits.length, 3); assert.deepEqual(retired, []);
    assert.ok(!records.some(item => item.event === 'host.call.connected' && item.role === 'replacement'));
    limited.get(`CA${'3'.repeat(32)}`)();
    await delay(20);
    assert.equal(rooms.length, 1); assert.deepEqual(retired, [`CA${'2'.repeat(32)}`]);
    assert.ok(records.some(e => e.event === 'host.transfer.completed'));
    await Promise.all([host.finish(), host.finish()]);
    assert.equal(new Set(retired).size, 3); assert.equal(retired.length, 3);
    assert.equal(host.snapshot().cleanup, 'calls_terminal_verified');
    assert.ok(records.every(e => e.host_room_id === host.room.id && !('audio' in e)));
    await host.create({ ...input, language: 'pa' });
    const currentId = host.room.id;
    rooms[0].opts.onClose('late_old_interpreter_failure');
    rooms[0].opts.legs.customer.transport.onFailure();
    await rooms[0].opts.record({ event: 'transcript.final', text: 'stale old transcript' });
    await delay(0);
    assert.equal(host.snapshot().id, currentId);
    assert.equal(host.snapshot().state, 'waiting', 'late callbacks cannot close the next conversation');
    assert.ok(!host.snapshot().events.some(event => event.text === 'stale old transcript'));
    await host.finish();
    await assert.rejects(host.create(input), /session_limit/);
  } finally { await host.finish(); }
});

test('durable journal failure closes admission and uncertain cleanup prevents another session', async () => {
  const host = new TranslationHost(config, { record: async () => { throw new Error('storage_unavailable'); } });
  await assert.rejects(host.create(input), /storage_unavailable/);
  assert.equal(host.snapshot().state, 'closed');
  assert.equal(host.snapshot().cleanup, 'journal_failed');
  assert.throws(() => host.mint('anything'), /invalid_join_grant/);
  await assert.rejects(host.create(input), /room_already_exists/);

  const records = [], retired = [];
  class Transport {
    constructor() { this.ready = Promise.resolve(); }
    close() { this.closed = true; }
  }
  const limitedHost = new TranslationHost(config, { Transport, record: async event => records.push(event),
    retire: async callId => retired.push(callId), limitCall: async () => {
      throw Object.assign(new Error('credential-in-error-message-must-not-be-recorded'), { code: 21220, status: 400 });
    } });
  try {
    await limitedHost.create(input); limitedHost.mint(limitedHost.room.endpoints.customer.grant);
    const form = makeForm(limitedHost, 'customer', '4');
    const xml = await limitedHost.answer(form, signature(form)), url = xml.match(/url="([^"]+)"/)[1];
    limitedHost.attach(limitedHost.admit(new URL(url).pathname, twilio.getExpectedTwilioSignature(config.authToken, url, {})), {});
    await delay(20);
    assert.equal(limitedHost.snapshot().state, 'closed');
    assert.equal(limitedHost.snapshot().cleanup, 'calls_terminal_verified');
    assert.deepEqual(retired, [form.CallSid]);
    const failure = records.find(event => event.event === 'host.call.limit.failed');
    assert.equal(failure.twilio_error_code, 21220); assert.equal(failure.twilio_http_status, 400);
    assert.ok(!records.some(event => event.event === 'host.call.connected'));
    assert.ok(!JSON.stringify(records).includes('credential-in-error-message'));
    assert.ok(records.some(event => event.event === 'host.room.closed' && event.reason === 'carrier_limit_failed'));
  } finally { await limitedHost.finish(); }
});
