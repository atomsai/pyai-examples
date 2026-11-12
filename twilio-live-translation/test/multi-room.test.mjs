import assert from 'node:assert/strict';
import { test } from 'node:test';
import twilio from 'twilio';
import { MultiRoomTranslationHost } from '../multi-room.mjs';

const config = { publicOrigin: 'https://test.example.com', accountSid: `AC${'a'.repeat(32)}`,
  applicationSid: `AP${'b'.repeat(32)}`, apiKeySid: `SK${'c'.repeat(32)}`, apiKeySecret: 'fixture-signing-secret',
  authToken: 'fixture-account-token', pyaiKey: 'fixture-interpretation-key' };
const scope = { project: 'project-one', owner: 'owner-one' };
const input = { language: 'hi', customerVoice: 'hi1', agentVoice: 'en1' };
const sign = form => twilio.getExpectedTwilioSignature(config.authToken, config.publicOrigin + '/twilio/voice', form);
const build = overrides => new MultiRoomTranslationHost(config, { absoluteDeadline: Date.now() + 600_000,
  reserveRoom: async () => {}, record: async () => {}, retire: async () => {}, ...overrides });

test('customer credentials cannot cross project bindings or consume a slot before validation', async () => {
  const host = new MultiRoomTranslationHost({ ...config, customerBilling: true, sessionOrigin: 'https://console.pyai.com' },
    { absoluteDeadline: Date.now() + 600_000, reserveRoom: async () => {}, record: async () => {}, retire: async () => {} });
  try {
    const billing_session = {token:'fixture-customer-token',expires_at:Date.now()+470_000,project_id:'another-project'};
    await assert.rejects(host.create({...input,billing_session},scope),/invalid_billing_session/);
    assert.equal(host.capacity().admitted_rooms,0);
    const room = await host.create({...input,billing_session:{...billing_session,project_id:scope.project}},scope);
    assert.equal(Date.parse(room.expires_at),billing_session.expires_at);
    assert.ok(!JSON.stringify(room).includes(billing_session.token));
  } finally { await host.finishAll(); }
});

test('ten concurrent reservations are isolated and failed persistence never refunds a slot', async () => {
  const reservations = [], writes = [];
  const host = build({ reserveRoom: async b => { reservations.push(b); }, record: async e => writes.push(e) });
  try {
    const rooms = await Promise.all(Array.from({ length: 10 }, () => host.create(input, scope)));
    assert.equal(new Set(rooms.map(r => r.id)).size, 10);
    assert.equal(new Set(reservations.map(r => r.slotId)).size, 10);
    assert.equal(host.capacity().active_rooms, 10);
    await assert.rejects(host.create(input, scope), /session_limit/);
    for (const room of rooms) {
      assert.equal(host.snapshot(room.id, scope).id, room.id);
      assert.throws(() => host.snapshot(room.id, { ...scope, project: 'foreign' }), /room_not_found/);
      assert.throws(() => host.mint(new URL(room.links.customer).hash.slice(1), rooms.find(r => r.id !== room.id).id, scope), /invalid_join_grant/);
    }
    assert.ok(writes.every(e => e.host_project_id === scope.project && e.host_owner_id === scope.owner));
    await host.finishAll();
    await assert.rejects(host.create(input, scope), /host_draining/);
  } finally { await host.finishAll(); }
  const failed = build({ reserveRoom: async () => { throw new Error('ambiguous_durable_write'); } });
  try {
    await assert.rejects(failed.create(input, scope), /ambiguous_durable_write/);
    assert.equal(failed.capacity().admitted_rooms, 1);
    assert.throws(() => failed.mint('anything', [...failed.rooms.keys()][0], scope), /invalid_join_grant/);
  } finally { await failed.finishAll(); }
});

test('signed webhooks and one-use media admission route only to the bound child', async () => {
  const host = build();
  try {
    const rooms = await Promise.all([host.create(input, scope), host.create(input, scope)]);
    const forms = rooms.map((r, i) => {
      const child = host.entry(r.id, scope).child, grant = new URL(r.links.customer).hash.slice(1);
      host.mint(grant, r.id, scope);
      return { AccountSid: config.accountSid, CallSid: `CA${String(i + 1).repeat(32)}`,
        From: `client:${child.room.endpoints.customer.identity}`, JoinGrant: grant };
    });
    await assert.rejects(host.answer(forms[0], 'bad'), /invalid_twilio_signature/);
    assert.equal(host.calls.size, 0, 'failed signature does not consume a global call binding');
    const xml = await host.answer(forms[0], sign(forms[0]));
    const duplicate = { ...forms[1], CallSid: forms[0].CallSid };
    await assert.rejects(host.answer(duplicate, sign(duplicate)), /invalid_call_binding/);
    const url = xml.match(/url="([^"]+)"/)[1], path = new URL(url).pathname;
    assert.equal(host.admit(path, 'bad'), null);
    const endpoint = host.admit(path, twilio.getExpectedTwilioSignature(config.authToken, url, {}));
    assert.equal(endpoint.callId, forms[0].CallSid);
    assert.equal(host.admit(path, twilio.getExpectedTwilioSignature(config.authToken, url, {})), null);
    let closed = false; host.attach({}, { close: () => { closed = true; } }); assert.ok(closed);
    await host.finish('operator_end', rooms[0].id, scope);
    assert.equal(host.snapshot(rooms[1].id, scope).state, 'waiting');
  } finally { await host.finishAll(); }
});


test('a shorter funded test bound clamps every room before any call can join', async () => {
  assert.throws(() => build({roomLifetimeMs: 0}), /invalid_pool_config/);
  assert.throws(() => build({roomLifetimeMs: 480001}), /invalid_pool_config/);
  const host=build({now:()=>1000,absoluteDeadline:61000,roomLifetimeMs:5000});
  try {const room=await host.create(input,scope);assert.equal(Date.parse(room.expires_at),6000);}
  finally{await host.finishAll();}
});

test('permanent rooms persist signed call admission and reuse a slot only after its lease expires', async () => {
  let clock = 1_000;
  const reserved = [], released = [], events = [];
  const host = build({ absoluteDeadline: Infinity, now: () => clock,
    reserveRoom: async binding => { reserved.push(binding); return 'lease-' + binding.slotId; },
    releaseRoom: async binding => { released.push(binding); }, reconcileRoom: async () => assert.fail('clean room should release'),
    record: async event => { events.push(event); } });
  try {
    const rooms = await Promise.all(Array.from({ length: 10 }, () => host.create(input, scope)));
    const room = rooms[0], grant = new URL(room.links.customer).hash.slice(1);
    host.mint(grant, room.id, scope);
    const child = host.entry(room.id, scope).child;
    const form = { AccountSid: config.accountSid, CallSid: `CA${'1'.repeat(32)}`,
      From: `client:${child.room.endpoints.customer.identity}`, JoinGrant: grant };
    assert.match(await host.answer(form, sign(form)), /<Stream/);
    assert.equal(events.at(-1).event, 'host.call.admitted');
    assert.equal(events.at(-1).provider_call_id, form.CallSid);
    await host.finish('operator_end', room.id, scope);
    await assert.rejects(host.create(input, scope), /rooms_at_capacity/);
    clock = reserved[0].leaseUntil;
    const replacement = await host.create(input, scope);
    assert.equal(reserved.at(-1).slotId, reserved[0].slotId);
    assert.equal(released[0].roomId, room.id);
    assert.notEqual(replacement.id, room.id);
    assert.throws(() => host.snapshot(room.id, scope), /room_not_found/);
    host.pauseAdmissions(true);
    await assert.rejects(host.create(input, scope), /host_draining/);
  } finally { await host.finishAll(); }
});

test('a rejected fleet slot cannot finalize the recording ticket reused by the admitted room', async (t) => {
  const reservations = [];
  const uploads = [];
  const recording = {
    id: 'tr_0000000000000_' + 'a'.repeat(24),
    upload_capability: 'tr1.fixture.' + 'b'.repeat(64),
    upload_until: Date.now() + 60_000,
    capture_format: 'party-v1',
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    uploads.push({ url: new URL(url), metadata: typeof options.body === 'string' ? JSON.parse(options.body) : null });
    return new Response(null, { status: 200 });
  });
  const host = build({
    absoluteDeadline: Infinity,
    reserveRoom: async binding => {
      reservations.push(binding);
      if (binding.slotId === 'slot-01') throw new Error('fleet_slot_busy');
      return 'lease-' + binding.slotId;
    },
    releaseRoom: async () => {},
    reconcileRoom: async () => {},
  });
  try {
    const room = await host.create({ ...input, recording }, scope);
    assert.equal(reservations.length, 2);
    assert.equal(room.id, reservations[1].roomId);
    assert.equal(room.recording_id, recording.id);
    assert.equal(uploads.length, 0, 'abandoned slot must never upload against the shared recording ticket');
    await host.finish('operator_end', room.id, scope);
    assert.deepEqual(uploads.filter(upload => upload.metadata).map(upload => upload.metadata.room_id), [room.id, room.id]);
    assert.deepEqual(uploads.filter(upload => !upload.metadata).map(upload => upload.url.searchParams.get('perspective')), ['customer', 'agent']);
  } finally { await host.finishAll(); }
});
