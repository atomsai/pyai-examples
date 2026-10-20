import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import plivo from 'plivo';
import { TranslationHost } from '../host.mjs';
import { createCallRetirer } from '../retirement.mjs';

const config = { publicOrigin: 'https://test.example.com', authId: 'MAfixtureaccount12345',
  applicationId: '12345678901234567', authToken: 'fixture-account-token', pyaiKey: 'fixture-interpretation-key',
  endpointUsernames: { customer: 'pyaiCustomer1', agent: 'pyaiAgent2', replacement: 'pyaiReplacement3' } };
const input = { language: 'hi', customerVoice: 'hi1', agentVoice: 'en1' };
const uuid = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const grantOf = link => new URL(link).hash.slice(1);
// Pinned plivo@4.79.0 canonicalization for these fixed, non-query test URLs.
const postSignature = (form, nonce, path = '/plivo/voice') => createHmac('sha256', config.authToken)
  .update(`${config.publicOrigin}${path}?${Object.keys(form).sort().map(key => key + form[key]).join('')}.${nonce}`).digest('base64');
const wsSignature = (url, nonce) => createHmac('sha256', config.authToken).update(url.replace('wss:', 'http:') + '.' + nonce).digest('base64');
const makeForm = (host, role, digit) => ({ AuthId: config.authId, CallUUID: uuid(digit),
  From: `sip:${host.room.endpoints[role].username}_${config.authId}@phone.plivo.com`,
  To: config.applicationId, 'X-PH-JoinGrant': host.room.endpoints[role].grant });

test('official Plivo V3 helper validates actual GET/POST canonicalization, not the manual documentation formula', () => {
  const form = { From: 'sip:fixture@phone.plivo.com', CallUUID: uuid('1') }, nonce = 'fixed-nonce';
  const signature = postSignature(form, nonce);
  assert.equal(plivo.validateV3Signature('POST', `${config.publicOrigin}/plivo/voice`, nonce,
    config.authToken, signature, form), true);
  const url = 'wss://test.example.com/plivo/media/fixed-permit';
  assert.equal(plivo.validateV3Signature('GET', url.replace('wss:', 'http:'), nonce,
    config.authToken, wsSignature(url, nonce)), true);
  assert.equal(plivo.validateV3Signature('GET', url.replace('wss:', 'https:'), nonce,
    config.authToken, wsSignature(url, nonce)), false, 'the signing protocol is exact, independent of encrypted transport');
  const wrong = createHmac('sha256', config.authToken).update('GET' + url.replace('wss:', 'http:') + nonce).digest('base64');
  assert.equal(plivo.validateV3Signature('GET', url.replace('wss:', 'http:'), nonce, config.authToken, wrong), false);
});

test('carrier-issued browser token and signed call/stream requests bind one disposable SIP endpoint', async () => {
  for (const applicationId of ['123456789012345', '+14155551234', '12345678901234567@app.plivo.com']) {
    assert.throws(() => new TranslationHost({ ...config, applicationId }, { record: async () => {} }), /invalid_host_config/);
  }
  const claims = [], records = [];
  const host = new TranslationHost(config, { record: async event => records.push(event), retire: async () => {},
    mintToken: async value => { claims.push(value); return 'carrier-issued-fixture-token'; } });
  try {
    const room = await host.create(input), grant = grantOf(room.links.customer);
    const emptyStatus = { CallUUID: '', CallStatus: 'completed' };
    await assert.rejects(host.status(emptyStatus, postSignature(emptyStatus, 'empty-status', '/plivo/status'), 'empty-status'), /invalid_call_binding/);
    assert.equal(host.snapshot().state, 'waiting', 'an unbound status cannot terminate a waiting room');
    await assert.rejects(host.mint('unknown'), /invalid_join_grant/);
    const minted = await host.mint(grant);
    assert.equal(minted.token, 'carrier-issued-fixture-token');
    assert.equal(minted.destination, config.applicationId);
    assert.equal(claims[0].sub, config.endpointUsernames.customer); assert.equal(claims[0].app, config.applicationId);
    assert.deepEqual(claims[0].per, { voice: { incoming_allow: false, outgoing_allow: true } });
    assert.equal(claims[0].exp - claims[0].nbf, 600);
    await assert.rejects(host.mint(grant), /invalid_join_grant/);
    const form = makeForm(host, 'customer', '1');
    await assert.rejects(host.answer(form, 'bad', 'bad-signature'), /invalid_plivo_signature/);
    const pstn = { ...form, To: '+14155551234' };
    await assert.rejects(host.answer(pstn, postSignature(pstn, 'pstn'), 'pstn'), /invalid_call_binding/);
    for (const [index, destination] of [`${config.endpointUsernames.customer}@phone.plivo.com`, '99999999999999999',
      `${config.applicationId}@app.plivo.com`, `${config.applicationId}@phone.plivo.com.attacker.example`].entries()) {
      const wrongDestination = { ...form, To: destination }, nonce = 'destination-' + index;
      await assert.rejects(host.answer(wrongDestination, postSignature(wrongDestination, nonce), nonce), /invalid_call_binding/);
    }
    const otherIdentity = { ...form, From: 'sip:unrelated@phone.plivo.com' };
    await assert.rejects(host.answer(otherIdentity, postSignature(otherIdentity, 'other'), 'other'), /invalid_call_binding/);
    const xml = await host.answer(form, postSignature(form, 'answer'), 'answer');
    const schedule = Number(xml.match(/<Hangup schedule="(\d+)"\/>/)[1]);
    assert.ok(schedule > 0 && schedule <= 480); assert.match(xml, /contentType="audio\/x-l16;rate=16000"/);
    assert.ok(!xml.includes('<Dial'), 'the two humans are not directly mixed');
    await assert.rejects(host.answer(form, postSignature(form, 'answer'), 'answer'), /invalid_plivo_signature/);
    const stream = xml.match(/<Stream[^>]*>([^<]+)<\/Stream>/)[1], path = new URL(stream).pathname;
    assert.equal(new URL(stream).protocol, 'wss:', 'HTTP signing never permits unencrypted media transport');
    assert.equal(host.admit(path, 'bad', 'stream'), null);
    const signed = wsSignature(stream, 'stream');
    for (const changed of [stream.replace('test.example.com', 'other.example.com'), stream + '/']) {
      assert.equal(host.admit(path, wsSignature(changed, 'stream'), 'stream'), null, 'another origin/path cannot authorize this permit');
    }
    for (const protocol of ['https:', 'wss:']) {
      const other = createHmac('sha256', config.authToken).update(stream.replace('wss:', protocol) + '.stream').digest('base64');
      assert.equal(host.admit(path, other, 'stream'), null, 'no alternate-signature fallback');
    }
    assert.equal(host.admit(path, signed, 'different-nonce'), null);
    assert.equal(host.admit(path + '/', signed, 'stream'), null);
    assert.equal(host.admit(path, wsSignature(stream, 'stream'), 'stream')?.callId, form.CallUUID);
    assert.equal(host.admit(path, wsSignature(stream, 'stream'), 'stream'), null);
    await host.mint(host.room.endpoints.agent.grant);
    const agentForm = makeForm(host, 'agent', '2');
    const agentXml = await host.answer(agentForm, postSignature(agentForm, 'agent-answer'), 'agent-answer');
    const agentStream = agentXml.match(/<Stream[^>]*>([^<]+)<\/Stream>/)[1], agentPath = new URL(agentStream).pathname;
    assert.equal(host.admit(agentPath, wsSignature(agentStream, 'stream'), 'stream'), null,
      'a valid official HMAC cannot reuse another participant\'s consumed nonce');
    assert.equal(host.admit(agentPath, wsSignature(agentStream, 'agent-stream'), 'agent-stream')?.callId, agentForm.CallUUID);
    assert.ok(records.some(event => event.event === 'host.call.admitted'));
    assert.ok(!JSON.stringify(host.snapshot()).includes('fixture-account-token'));
    assert.ok(!JSON.stringify(host.snapshot()).includes('carrier-issued-fixture-token'));
  } finally { await host.finish(); }
});

test('two Plivo sockets create one interpreter and the replacement uses that same session', async () => {
  const rooms = [], retired = [], records = [];
  class Transport {
    constructor(socket, callId, participantId) { this.callId = callId; this.participantId = participantId; this.ready = Promise.resolve(); }
    close() { this.closed = true; }
  }
  class Room {
    constructor(opts) { this.opts = opts; rooms.push(this); void opts.record({ event: 'session.started' }); }
    async replaceAgent(participant, transport) {
      await this.opts.retireCall(this.opts.legs.agent.transport.callId);
      this.opts.legs.agent = { participant, transport }; await this.opts.record({ event: 'session.updated', revision: 2 });
    }
    close(reason) { this.opts.onClose(reason); }
  }
  const host = new TranslationHost(config, { Room, Transport, record: async event => records.push(event),
    retire: async callId => { retired.push(callId); }, mintToken: async () => 'carrier-issued-fixture-token' });
  async function connect(role, digit) {
    await host.mint(host.room.endpoints[role].grant);
    const form = makeForm(host, role, digit), nonce = 'answer-' + role;
    const xml = await host.answer(form, postSignature(form, nonce), nonce);
    const url = xml.match(/<Stream[^>]*>([^<]+)<\/Stream>/)[1], streamNonce = 'stream-' + role;
    const endpoint = host.admit(new URL(url).pathname, wsSignature(url, streamNonce), streamNonce);
    host.attach(endpoint, {});
  }
  try {
    await host.create(input);
    await assert.rejects(host.mint(host.room.endpoints.replacement.grant), /invalid_join_grant/);
    await connect('customer', '1'); await connect('agent', '2'); await delay(20);
    assert.equal(rooms.length, 1); assert.equal(host.snapshot().state, 'connected');
    await connect('replacement', '3'); await delay(20);
    assert.equal(rooms.length, 1); assert.deepEqual(retired, [uuid('2')]);
    const oldStatus = { CallUUID: uuid('2'), CallStatus: 'completed' };
    await host.status(oldStatus, postSignature(oldStatus, 'old-status', '/plivo/status'), 'old-status');
    assert.equal(host.snapshot().state, 'connected', 'retired-agent status does not end the replacement conversation');
    assert.ok(records.some(event => event.event === 'host.transfer.completed'));
    await Promise.all([host.finish(), host.finish()]);
    assert.equal(retired.length, 3); assert.equal(new Set(retired).size, 3);
    assert.equal(host.snapshot().cleanup, 'calls_terminal_verified');
    assert.ok(records.every(event => event.host_room_id === host.room.id && !('audio' in event)));
    await host.create({ ...input, language: 'pa' }); await host.finish();
    await assert.rejects(host.create(input), /session_limit/);
  } finally { await host.finish(); }
});

test('JWT registration identities are bound to the expected account and participant', async () => {
  for (const format of [identity => identity, identity => identity + '@phone.plivo.com', identity => 'sip:' + identity + '@phone.plivo.com']) {
    const host = new TranslationHost(config, { record: async () => {}, retire: async () => {}, mintToken: async () => 'carrier-token' });
    try {
      await host.create(input); await host.mint(host.room.endpoints.customer.grant);
      const form = makeForm(host, 'customer', '1');
      const wrongAccount = { ...form, From: format(config.endpointUsernames.customer + '_MAotheraccount12345') };
      await assert.rejects(host.answer(wrongAccount, postSignature(wrongAccount, 'wrong'), 'wrong'), /invalid_call_binding/);
      const expected = { ...form, From: format(config.endpointUsernames.customer + '_' + config.authId),
        To: format(config.applicationId) };
      assert.match(await host.answer(expected, postSignature(expected, 'right'), 'right'), /<Stream/);
    } finally { await host.finish(); }
  }
});

test('token or durable-store failures close the bounded room and block unsafe reuse', async () => {
  const journal = new TranslationHost(config, { record: async () => { throw new Error('storage_unavailable'); } });
  await assert.rejects(journal.create(input), /storage_unavailable/);
  assert.equal(journal.snapshot().cleanup, 'journal_failed');
  await assert.rejects(journal.create(input), /room_already_exists/);
  const token = new TranslationHost(config, { record: async () => {}, mintToken: async () => { throw new Error('provider_unavailable'); } });
  await token.create(input); await assert.rejects(token.mint(token.room.endpoints.customer.grant), /provider_unavailable/);
  assert.equal(token.snapshot().state, 'closed');
});

test('preview reservation precedes role grants and the fixed deadline bounds every room', async () => {
  let clock = Date.now(); const reserved = [];
  const host = new TranslationHost(config, { now: () => clock, maxRooms: 12, absoluteDeadline: clock + 1000,
    reserveRoom: async room => { reserved.push(room); }, record: async () => {} });
  try {
    const room = await host.create(input);
    assert.equal(Date.parse(room.expires_at), clock + 1000);
    assert.deepEqual(reserved, [{ id: room.id, expiresAt: clock + 1000 }]);
    await host.finish(); clock += 1001;
    await assert.rejects(host.create(input), /session_limit/);
  } finally { await host.finish(); }
  const denied = new TranslationHost(config, { reserveRoom: async () => { throw new Error('preview_session_limit'); },
    record: async () => {} });
  await assert.rejects(denied.create(input), /preview_session_limit/);
  assert.equal(denied.grants.size, 0, 'no participant grant escapes a failed durable admission');
});

async function pendingAdmission(options = {}) {
  const transports = [];
  class Transport {
    constructor(_socket, _call, _participant, _account, settings) {
      this.options = settings; this.ready = new Promise(() => {}); transports.push(this);
    }
    close() {}
  }
  const host = new TranslationHost(config, { Transport, record: async () => {}, retire: async () => {},
    mintToken: async () => 'fixture-token', ...options });
  await host.create(input); await host.mint(host.room.endpoints.customer.grant);
  const form = makeForm(host, 'customer', '1');
  const xml = await host.answer(form, postSignature(form, 'answer'), 'answer');
  const url = xml.match(/<Stream[^>]*>([^<]+)<\/Stream>/)[1], path = new URL(url).pathname;
  const endpoint = host.room.endpoints.customer;
  const admit = () => host.admit(path, wsSignature(url, 'start'), 'start');
  const binding = { accountId: config.authId, callId: form.CallUUID, participantId: endpoint.participant.participant_id,
    streamId: uuid('4'), providerAccountId: '12345678901234567890' };
  return { host, endpoint, url, path, admit, binding, transports };
}
const socketSpy = () => ({ closes: [], close(...args) { this.closes.push(args); } });

test('only the consumed signed admission binds one socket to its exact live role', async () => {
  const { host, endpoint, url, path, admit, binding, transports } = await pendingAdmission();
  try {
    const direct = socketSpy(); host.attach(endpoint, direct);
    assert.deepEqual(direct.closes, [[1008, 'invalid_binding']]);
    assert.equal(transports.length, 0, 'answer-created URL alone never attests account ownership');
    assert.equal(host.admit(path, 'bad-signature', 'start'), null);
    const unsigned = socketSpy(); host.attach(endpoint, unsigned);
    assert.equal(transports.length, 0); assert.equal(unsigned.closes.length, 1);
    const item = host.streams.get(path), consume = item.issued.consume; let consumes = 0;
    item.issued.consume = (...args) => { consumes++; return consume(...args); };
    assert.equal(admit(), endpoint); assert.equal(consumes, 1);
    assert.equal(endpoint.streamUrl, url); assert.ok(Object.isFrozen(host.consumedAdmissions.get(endpoint)));
    host.attach(endpoint, socketSpy());
    assert.equal(host.consumedAdmissions.has(endpoint), false, 'proof is consumed before constructing transport');
    const verify = transports[0].options.verifyStartBinding;
    assert.equal(verify(binding), true, 'numeric provider metadata cannot override authenticated admission');
    assert.equal(verify({ ...binding, providerAccountId: config.authId }), true);
    for (const changed of [{ accountId: 'MAanotheraccount12345' }, { callId: uuid('2') },
      { participantId: host.room.endpoints.agent.participant.participant_id }, { streamId: '../other-stream' },
      { providerAccountId: 'MAanotheraccount12345' }, { providerAccountId: 123 }]) {
      assert.equal(verify({ ...binding, ...changed }), false);
    }
    endpoint.streamUrl += '/'; assert.equal(verify(binding), false); endpoint.streamUrl = url;
    const replay = socketSpy(); host.attach(endpoint, replay);
    assert.equal(transports.length, 1); assert.equal(replay.closes.length, 1);
    assert.equal(admit(), null); assert.equal(consumes, 1, 'SDK permit is never consumed twice');
    await host.finish(); assert.equal(verify(binding), false, 'late Start cannot revive closed room');
    await host.create({ ...input, language: 'pa' }); assert.equal(verify(binding), false);
    assert.ok(!JSON.stringify(host.snapshot()).includes(url));
  } finally { await host.finish(); }
});

test('signed admission expires at issue time and rejects changed or retired endpoint context', async () => {
  for (const change of ['expired', 'url', 'participant', 'call', 'endpoint', 'room', 'retired', 'retiring']) {
    let clock = Date.now();
    const { host, endpoint, admit, transports } = await pendingAdmission({ now: () => clock });
    try {
      assert.equal(admit(), endpoint);
      assert.equal(host.consumedAdmissions.get(endpoint).expiresAt, clock + 30_000);
      if (change === 'expired') clock += 30_001;
      if (change === 'url') endpoint.streamUrl += '/';
      if (change === 'participant') endpoint.participant = host.room.endpoints.agent.participant;
      if (change === 'call') endpoint.callId = uuid('2');
      if (change === 'endpoint') host.room.endpoints.customer = { ...endpoint };
      if (change === 'room') { await host.finish(); await host.create(input); }
      if (change === 'retired') host.room.retired.add(endpoint.callId);
      if (change === 'retiring') host.room.retiring.set(endpoint.callId, Promise.resolve());
      const socket = socketSpy(); host.attach(endpoint, socket);
      assert.equal(transports.length, 0, change); assert.equal(socket.closes.length, 1, change);
      assert.equal(host.consumedAdmissions.has(endpoint), false, 'rejected proof cannot be replayed');
    } finally { await host.finish(); }
  }
});

test('constructor failure consumes admission and closes the socket without reviving the room', async () => {
  let host, constructors = 0;
  class Transport {
    constructor() { constructors++;
      assert.equal(host.consumedAdmissions.has(host.room.endpoints.customer), false); throw new Error('fixture-failure'); }
  }
  const prepared = await pendingAdmission({ Transport }); host = prepared.host;
  try {
    assert.equal(prepared.admit(), prepared.endpoint);
    const socket = socketSpy(); host.attach(prepared.endpoint, socket);
    assert.deepEqual(socket.closes, [[1008, 'transport_setup_failed']]); assert.equal(host.room.closing, true);
    const replay = socketSpy(); host.attach(prepared.endpoint, replay);
    assert.equal(constructors, 1); assert.equal(replay.closes.length, 1);
    await host.finish(); assert.equal(host.snapshot().cleanup, 'calls_terminal_verified');
  } finally { await host.finish(); }
});

test('transport failure diagnostics retain only fixed codes while closing immediately', async () => {
  for (const reason of ['provider_start_binding_failed', 'private-credential:https://private.example/path']) {
    let transport; const records = [];
    class Transport {
      constructor() { transport = this; this.ready = new Promise(() => {}); }
      close() {}
    }
    const host = new TranslationHost(config, { Transport, record: async event => records.push(event),
      retire: async () => {}, mintToken: async () => 'fixture-token' });
    try {
      await host.create(input); await host.mint(host.room.endpoints.customer.grant);
      const form = makeForm(host, 'customer', '1');
      const xml = await host.answer(form, postSignature(form, 'failure'), 'failure');
      const url = xml.match(/<Stream[^>]*>([^<]+)<\/Stream>/)[1];
      host.attach(host.admit(new URL(url).pathname, wsSignature(url, 'failure-stream'), 'failure-stream'), {});
      transport.onFailure(reason);
      assert.equal(host.room.closing, true); await host.finish();
      const expected = reason === 'provider_start_binding_failed' ? reason : 'provider_transport_failed';
      assert.equal(host.snapshot().endpoints.customer.transport.failure_code, expected);
      assert.equal(records.find(event => event.event === 'host.room.closed').transports.customer.failure_code, expected);
      assert.ok(!JSON.stringify(records).includes('private-credential'));
    } finally { await host.finish(); }
  }
});

async function retiringHost(options = {}) {
  const host = new TranslationHost(config, { record: async () => {}, mintToken: async () => 'fixture-token', ...options });
  await host.create(input); await host.mint(host.room.endpoints.customer.grant);
  const form = makeForm(host, 'customer', '1');
  await host.answer(form, postSignature(form, 'retirement-answer'), 'retirement-answer');
  return host;
}
const signedStatus = (host, form, nonce) => host.status(form, postSignature(form, nonce, '/plivo/status'), nonce);

test('only durably journaled exact-call completed status settles an already-registered retirement waiter', async () => {
  let settled = false, journalEntered, releaseJournal;
  const entered = new Promise(resolve => { journalEntered = resolve; });
  const gate = new Promise(resolve => { releaseJournal = resolve; });
  const host = await retiringHost({
    record: async event => {
      if (event.event === 'host.call.status' && event.status === 'completed') {
        journalEntered(); await gate;
      }
    },
    retire: createCallRetirer({ ...config, budgetMs: 250, pollMs: 5,
      fetcher: async () => ({ ok: false, status: 404 }) }),
  });
  try {
    const pending = host.retireOnce(uuid('1')).then(() => { settled = true; });
    assert.equal(host.room.terminalWaiters.has(uuid('1')), true, 'waiter exists before carrier DELETE');
    const completed = { CallUUID: uuid('1'), AuthId: config.authId, CallStatus: 'completed' };
    await assert.rejects(signedStatus(host, { ...completed, CallUUID: uuid('2') }, 'wrong-call'), /invalid_call_binding/);
    await assert.rejects(signedStatus(host, { ...completed, AuthId: 'MAotheraccount12345' }, 'wrong-account'), /invalid_call_binding/);
    await assert.rejects(host.status(completed, 'bad-signature', 'bad-status'), /invalid_plivo_signature/);
    await signedStatus(host, { ...completed, CallStatus: 'ringing' }, 'replayed-status');
    await assert.rejects(signedStatus(host, completed, 'replayed-status'), /invalid_plivo_signature/);
    await delay(10); assert.equal(settled, false); assert.equal(host.room.completed.size, 0);
    const status = signedStatus(host, completed, 'completed-status'); await entered;
    assert.equal(settled, false, 'a valid callback is insufficient while durable journal is pending');
    releaseJournal(); await status; await pending;
    assert.equal(host.room.retired.has(uuid('1')), true); assert.equal(host.room.terminalWaiters.size, 0);
    assert.equal(host.snapshot().endpoints.customer.retirement.proof, 'signed_completed');
    await assert.rejects(signedStatus(host, completed, 'completed-status'), /invalid_plivo_signature/);
  } finally { releaseJournal(); await host.finish(); }
});

test('a signed completed status before retirement is retained, but journal failure supplies no terminal proof', async () => {
  for (const journalFails of [false, true]) {
    let deletes = 0;
    const host = await retiringHost({ record: async event => {
      if (journalFails && event.event === 'host.call.status') throw new Error('journal_write_failed');
    }, retire: createCallRetirer({ ...config, budgetMs: 40, pollMs: 5, fetcher: async (_url, { method }) => {
      if (method === 'DELETE') deletes++; return { ok: false, status: 404 };
    } }) });
    try {
      const form = { CallUUID: uuid('1'), CallStatus: 'completed' };
      if (journalFails) {
        await assert.rejects(signedStatus(host, form, 'failed-journal'), /journal_write_failed/);
        assert.equal(host.room.completed.size, 0);
        await assert.rejects(host.retireOnce(uuid('1')), /call_not_terminal/);
        assert.equal(host.room.retired.size, 0); assert.equal(host.room.terminalWaiters.size, 0);
      } else {
        await signedStatus(host, form, 'early-completed');
        assert.equal(host.snapshot().cleanup, 'calls_terminal_verified');
        assert.equal(host.snapshot().endpoints.customer.retirement.proof, 'signed_completed');
        assert.equal(deletes, 1);
      }
    } finally { await host.finish(); }
  }
});

test('concurrent retirement is deduplicated and a rejected attempt permits cleanup retry with safe diagnostics', async () => {
  let attempts = 0, rejectFirst;
  const first = new Promise((_, reject) => { rejectFirst = reject; });
  const host = await retiringHost({ retire: async () => {
    attempts++; if (attempts === 1) await first; return 'terminal_cdr';
  } });
  try {
    const a = host.retireOnce(uuid('1')), b = host.retireOnce(uuid('1'));
    await delay(0); assert.equal(attempts, 1);
    rejectFirst(new Error('private-response Authorization: fixture-account-token'));
    const results = await Promise.allSettled([a, b]);
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.message === 'carrier_retirement_failed'));
    assert.equal(host.room.retiring.size, 0); assert.equal(host.room.terminalWaiters.size, 0);
    assert.equal(host.snapshot().endpoints.customer.retirement.failure_code, 'carrier_retirement_failed');
    assert.ok(!JSON.stringify(host.snapshot()).includes('private-response'));
    await host.finish();
    assert.equal(attempts, 2); assert.equal(host.snapshot().cleanup, 'calls_terminal_verified');
    assert.deepEqual(host.snapshot().endpoints.customer.retirement, { proof: 'terminal_cdr', failure_code: null });
  } finally { await host.finish(); }
});
