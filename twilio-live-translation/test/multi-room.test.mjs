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
