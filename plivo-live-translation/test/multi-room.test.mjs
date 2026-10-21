import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MultiRoomTranslationHost } from '../multi-room.mjs';

const config = { publicOrigin: 'https://test.example.com', authId: 'MAfixtureaccount12345',
  applicationId: '12345678901234567', authToken: 'fixture-account-token', pyaiKey: 'fixture-interpretation-key' };
const pool = () => Array.from({ length: 10 }, (_, index) => ({ slot_id: `slot-${String(index + 1).padStart(2, '0')}`,
  endpointUsernames: Object.fromEntries(['customer', 'agent', 'replacement'].map(role => [role, `P${index}${role}`])) }));
const input = { language: 'hi', customerVoice: 'hi1', agentVoice: 'en1' };
const scope = index => ({ project: `project-${index}`, owner: `user-${index}` });
const id = index => `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const grant = (room, role) => new URL(room.links[role]).hash.slice(1);
const signed = (form, nonce, path = '/plivo/voice') => createHmac('sha256', config.authToken)
  .update(`${config.publicOrigin}${path}?${Object.keys(form).sort().map(key => key + form[key]).join('')}.${nonce}`).digest('base64');
const streamSignature = (url, nonce) => createHmac('sha256', config.authToken).update(url.replace('wss:', 'http:') + '.' + nonce).digest('base64');
function fixture(extra = {}) {
  const records = [], leases = [], releases = [], retired = [], interpreters = [];
  let clock = Date.now();
  class Transport {
    constructor(_socket, callId, participantId) { this.callId = callId; this.participantId = participantId; this.ready = Promise.resolve(); }
    close() { this.closed = true; }
  }
  class Room {
    constructor(options) { this.options = options; this.commits = []; interpreters.push(this); void options.record({ event: 'session.started' }); }
    async replaceAgent(participant, transport) {
      await this.options.retireCall(this.options.legs.agent.transport.callId);
      this.options.legs.agent = { participant, transport }; await this.options.record({ event: 'session.updated', revision: 2 });
    }
    commit(leg) { this.commits.push(leg); }
    close() {}
  }
  const host = new MultiRoomTranslationHost(config, { endpointPool: pool(), Room, Transport, now: () => clock,
    reserveRoom: async binding => { leases.push(binding); return 'lease-' + binding.roomId; },
    releaseRoom: async binding => { releases.push(binding); },
    record: async event => { records.push(event); }, mintToken: async () => 'fixture-issued-token',
    retire: async callId => { retired.push(callId); return 'terminal_cdr'; }, ...extra });
  return { host, records, leases, releases, retired, interpreters, advance(value) { clock += value; }, now: () => clock };
}
async function connect(host, room, owner, role, index, { nonce = 'answer-' + index, streamNonce = 'stream-' + index } = {}) {
  await host.mint(grant(room, role), room.id, owner);
  const entry = host.rooms.get(room.id), endpoint = entry.child.room.endpoints[role];
  const form = { AuthId: config.authId, CallUUID: id(index), From: `${endpoint.username}_${config.authId}`,
    To: config.applicationId, 'X-PH-JoinGrant': grant(room, role) };
  const xml = await host.answer(form, signed(form, nonce), nonce);
  const url = xml.match(/<Stream[^>]*>([^<]+)<\/Stream>/)[1];
  const admitted = host.admit(new URL(url).pathname, streamSignature(url, streamNonce), streamNonce);
  assert.equal(admitted, endpoint);
  host.attach(admitted, { close() {} }); return { form, url, endpoint };
}

test('ten overlapping durable admissions own distinct endpoint triples and an eleventh fails without a grant', async () => {
  let open; const gate = new Promise(resolve => { open = resolve; }); let reserved = 0;
  const f = fixture({ reserveRoom: async binding => { reserved++; await gate; return 'lease-' + binding.roomId; } });
  try {
    const pending = Array.from({ length: 10 }, (_, index) => f.host.create(input, scope(index)));
    await delay(0); assert.equal(reserved, 10);
    await assert.rejects(f.host.create(input, scope(11)), /rooms_at_capacity/);
    assert.equal(f.host.capacity().active_rooms, 10); open();
    const rooms = await Promise.all(pending);
    assert.equal(new Set(rooms.map(room => room.id)).size, 10);
    const usernames = [...f.host.rooms.values()].flatMap(entry => Object.values(entry.child.room.endpoints).map(endpoint => endpoint.username));
    assert.equal(new Set(usernames).size, 30);
    for (const [index, room] of rooms.entries()) {
      assert.equal(f.host.snapshot(room.id, scope(index)).id, room.id);
      await connect(f.host, room, scope(index), 'customer', 100 + index * 2);
      await connect(f.host, room, scope(index), 'agent', 101 + index * 2);
    }
    await delay(10); assert.equal(f.interpreters.length, 10, 'twenty distinct provider transports own ten interpreters');
    await assert.rejects(f.host.create(input, scope(12)), /rooms_at_capacity/);
  } finally { open(); await f.host.finishAll(); }
});

test('concurrent interpreters isolate captions, signed admission, transfers, commits and room ownership', async () => {
  const f = fixture();
  try {
    const [first, second] = await Promise.all([f.host.create(input, scope(1)), f.host.create({ ...input, language: 'pa' }, scope(2))]);
    const a = await connect(f.host, first, scope(1), 'customer', 1);
    await connect(f.host, first, scope(1), 'agent', 2);
    await connect(f.host, second, scope(2), 'customer', 3);
    await connect(f.host, second, scope(2), 'agent', 4); await delay(10);
    assert.equal(f.interpreters.length, 2);
    assert.throws(() => f.host.snapshot(first.id, scope(2)), /room_not_found/);
    assert.throws(() => f.host.finish('test', second.id, scope(1)), /room_not_found/);
    await assert.rejects(f.host.mint(grant(first, 'replacement'), second.id, scope(2)), /invalid_join_grant/);
    const wrong = { ...a.form, CallUUID: id(5), From: f.host.rooms.get(second.id).child.room.endpoints.agent.username };
    await assert.rejects(f.host.answer(wrong, signed(wrong, 'wrong-role'), 'wrong-role'), /invalid_call_binding/);
    const replay = { ...a.form, CallUUID: id(6) };
    await assert.rejects(f.host.answer(replay, signed(replay, 'answer-3'), 'answer-3'), /invalid_plivo_signature/);
    assert.equal(f.host.admit(new URL(a.url).pathname, streamSignature(a.url, 'stream-3'), 'stream-3'), null);
    await f.interpreters[0].options.record({ event: 'transcript.committed', leg: 'customer', text: 'first-room-only' });
    assert(f.host.snapshot(first.id, scope(1)).events.some(event => event.text === 'first-room-only'));
    assert(!f.host.snapshot(second.id, scope(2)).events.some(event => event.text === 'first-room-only'));
    f.host.commit(second.id, 'agent', scope(2)); assert.deepEqual(f.interpreters[1].commits, ['agent']);
    await connect(f.host, first, scope(1), 'replacement', 7); await delay(10);
    assert.deepEqual(f.retired, [id(2)]); assert.equal(f.host.snapshot(second.id, scope(2)).state, 'connected');
    assert.equal(f.interpreters.length, 2, 'replacement stays inside the first interpreter');
    await f.host.finish('test', first.id, scope(1));
    assert.equal(f.host.snapshot(second.id, scope(2)).state, 'connected');
    assert(f.records.every(event => event.host_project_id && event.host_owner_id && event.host_slot_id));
  } finally { await f.host.finishAll(); }
});

test('terminal cleanup retains endpoint leases through all browser-token lifetimes, then allows another wave', async () => {
  const f = fixture();
  try {
    const rooms = await Promise.all(Array.from({ length: 10 }, (_, index) => f.host.create(input, scope(index))));
    f.advance(470_000); await f.host.mint(grant(rooms[0], 'customer'), rooms[0].id, scope(0));
    await Promise.all(rooms.map((room, index) => f.host.finish('test', room.id, scope(index))));
    assert.deepEqual(f.host.capacity(), { available: true, admissions_paused: false, maximum_concurrent_rooms: 10, active_rooms: 0, cooldown_rooms: 10 });
    f.advance(600_001); await assert.rejects(f.host.create(input, scope(20)), /rooms_at_capacity/);
    assert.equal(f.releases.length, 0, 'an old still-valid registration cannot share a newly leased endpoint');
    f.advance(40_000);
    const next = await Promise.all(Array.from({ length: 10 }, (_, index) => f.host.create(input, scope(index + 20))));
    assert.equal(next.length, 10); assert.equal(f.releases.length, 10); assert.equal(f.leases.length, 20);
    assert.equal(f.host.rooms.size, 10, 'closed-room memory remains bounded after reuse');
    assert.throws(() => f.host.snapshot(rooms[0].id, scope(0)), /room_not_found/);
  } finally { await f.host.finishAll(); }
});

test('known competing leases try another slot; ambiguous reservation and failed cleanup remain fenced', async () => {
  let attempts = 0;
  const f = fixture({ reserveRoom: async binding => { attempts++; if (binding.slotId === 'slot-01') throw new Error('fleet_slot_busy'); return binding.roomId; } });
  try {
    const room = await f.host.create(input, scope(1)); assert.equal(attempts, 2);
    assert.equal(f.host.rooms.get(room.id).binding.slotId, 'slot-02'); assert.equal(f.host.rooms.size, 1);
  } finally { await f.host.finishAll(); }
  const broken = fixture({ reserveRoom: async () => { throw new Error('ambiguous_storage'); } });
  try {
    await assert.rejects(broken.host.create(input, scope(1)), /ambiguous_storage/);
    assert.equal(broken.host.slots.filter(slot => slot.entry).length, 1);
    assert.equal([...broken.host.rooms.values()][0].child.grants.size, 0);
    broken.advance(2_000_000); await broken.host.reclaim(); assert.equal(broken.host.rooms.size, 1);
  } finally { await broken.host.finishAll(); }
  const unconfirmed = fixture({ retire: async () => { throw new Error('call_not_terminal'); } });
  try {
    const room = await unconfirmed.host.create(input, scope(1)); await connect(unconfirmed.host, room, scope(1), 'customer', 8);
    await unconfirmed.host.finish('test', room.id, scope(1)); unconfirmed.advance(2_000_000); await unconfirmed.host.reclaim();
    assert.equal(unconfirmed.releases.length, 0); assert.equal(unconfirmed.host.snapshot(room.id, scope(1)).cleanup, 'needs_reconciliation');
  } finally { await unconfirmed.host.finishAll(); }
});

test('shutdown racing a durable admission cannot return fresh join grants and disables new rooms', async () => {
  let open; const gate = new Promise(resolve => { open = resolve; });
  const f = fixture({ reserveRoom: async binding => { await gate; return binding.roomId; } });
  const pending = f.host.create(input, scope(1)); const rejected = assert.rejects(pending, /host_draining/);
  await delay(0); await f.host.finishAll(); open(); await rejected;
  assert.equal(f.host.capacity().available, false); await assert.rejects(f.host.create(input, scope(2)), /host_draining/);
});
