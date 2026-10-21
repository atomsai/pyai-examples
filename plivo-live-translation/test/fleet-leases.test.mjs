import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFleetLeases } from '../fleet-leases.mjs';

const serviceId = 'plivo-permanent-fixture';
const callId = value => `${String(value).padStart(8, '0')}-1111-4111-8111-111111111111`;
const roomId = value => `test-${callId(value)}`;

function fixture() {
  let clock = 1_800_000_000_000, generation = 0;
  const objects = new Map(), history = new Map(), requests = [], recovered = [];
  const name = slot => `qualification/fleet/fleet-${serviceId}/${slot}.json`;
  const store = (slot, value) => {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    const item = { raw, generation: String(++generation), name: name(slot) };
    objects.set(name(slot), item); history.set(item.generation, item); return item;
  };
  let intercept;
  const fetchImpl = async (target, options) => {
    const url = new URL(target), objectName = url.searchParams.get('name') ?? decodeURIComponent(url.pathname.split('/o/')[1]);
    assert.equal(url.origin, 'https://storage.googleapis.com');
    assert.equal(options.headers.Authorization, 'Bearer fixture-private-adc');
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    assert.ok(!String(options.body ?? '').includes('fixture-private-adc'));
    requests.push({ method: options.method ?? 'GET', objectName, generation: url.searchParams.get('generation'),
      condition: url.searchParams.get('ifGenerationMatch') });
    const override = await intercept?.(url, options);
    if (override) return override;
    if (options.method === 'POST') {
      assert.equal(options.headers['Content-Type'], 'application/json');
      const previous = objects.get(objectName);
      if (url.searchParams.get('ifGenerationMatch') !== (previous?.generation ?? '0')) return new Response('', { status: 412 });
      const slot = objectName.split('/').at(-1).replace(/\.json$/, '');
      const item = store(slot, options.body);
      return Response.json({ name: objectName, generation: item.generation });
    }
    const item = url.searchParams.has('generation') ? history.get(url.searchParams.get('generation')) : objects.get(objectName);
    if (!item || item.name !== objectName) return new Response('', { status: 404 });
    return url.searchParams.get('alt') === 'media' ? new Response(item.raw) : Response.json({ name: item.name, generation: item.generation });
  };
  const make = (recover = async value => { recovered.push(value); }, reserveAllowance = async () => {}) => createFleetLeases({
    bucket: 'fixture-private', prefix: 'qualification/fleet', serviceId, token: async () => 'fixture-private-adc',
    recover, reserveAllowance, fetchImpl, now: () => clock,
  });
  const binding = (value, slotId = 'slot-01') => ({ roomId: roomId(value), slotId,
    project: 'proj-fixture', owner: 'user-fixture', expiresAt: clock + 480_000, leaseUntil: clock + 1_110_000 });
  return { make, binding, objects, requests, recovered, store, name,
    item: slot => objects.get(name(slot)), advanceTo(value) { clock = value; },
    intercept(value) { intercept = value; } };
}

test('ten shared slots survive process restarts and an eleventh claimant cannot bypass occupied slots', async () => {
  const f = fixture();
  for (let i = 1; i <= 10; i++) await f.make().reserveRoom(f.binding(i, `slot-${String(i).padStart(2, '0')}`));
  for (let i = 1; i <= 10; i++) {
    await assert.rejects(f.make().reserveRoom(f.binding(11, `slot-${String(i).padStart(2, '0')}`)), /fleet_slot_busy/);
  }
  await assert.rejects(f.make().reserveRoom(f.binding(11, 'slot-11')), /invalid_fleet_lease/);
  assert.equal(f.objects.size, 10); assert.equal(f.requests.filter(row => row.method === 'POST').length, 10);
});

test('simultaneous independent claimants are generation-fenced to exactly one owner', async () => {
  const f = fixture(); let arrivals = 0, release;
  const ready = new Promise(resolve => { release = resolve; });
  f.intercept(async (_url, options) => {
    if (options.method === 'POST') { if (++arrivals === 2) release(); await ready; }
  });
  const results = await Promise.allSettled([f.make().reserveRoom(f.binding(1)), f.make().reserveRoom(f.binding(2))]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.match(results.find(row => row.status === 'rejected').reason.message, /fleet_slot_busy/);
  assert.equal(f.objects.size, 1); assert.equal(arrivals, 2);
});

test('concurrent admitted-call writes serialize without losing identities and reject duplicate or fourth calls', async () => {
  const f = fixture(), leases = f.make(), binding = f.binding(1);
  binding.lease = await leases.reserveRoom(binding);
  await Promise.all([1, 2, 3].map(value => leases.recordEntry({ event: 'host.call.admitted', host_room_id: binding.roomId,
    provider_call_id: callId(value) })));
  assert.deepEqual(JSON.parse(f.item('slot-01').raw).call_ids, [1, 2, 3].map(callId));
  for (const value of [1, 4]) await assert.rejects(leases.recordEntry({ event: 'host.call.admitted',
    host_room_id: binding.roomId, provider_call_id: callId(value) }), /fleet_call_binding_failed/);
  assert.equal(JSON.parse(f.item('slot-01').raw).terminal_verified, false);
});

test('expired unverified slots reconcile only retained calls, then fence stale owners across processes', async () => {
  const f = fixture(), first = f.make(), old = f.binding(1);
  old.lease = await first.reserveRoom(old);
  await first.recordEntry({ event: 'host.call.admitted', host_room_id: old.roomId, provider_call_id: callId(1) });
  await assert.rejects(f.make().reserveRoom(f.binding(2)), /fleet_slot_busy/); assert.equal(f.recovered.length, 0);
  f.advanceTo(old.leaseUntil);
  const current = f.binding(2), second = f.make(); current.lease = await second.reserveRoom(current);
  assert.deepEqual(f.recovered, [{ roomId: old.roomId, callIds: [callId(1)] }]);
  assert.notEqual(current.lease, old.lease);
  await assert.rejects(first.recordEntry({ event: 'host.room.closed', host_room_id: old.roomId,
    cleanup: 'calls_terminal_verified' }), /fleet_lease_fenced/);
  await assert.rejects(first.releaseRoom(old), /fleet_lease_fenced/);
  assert.equal(JSON.parse(f.item('slot-01').raw).room_id, current.roomId);
  assert.equal(JSON.parse(f.item('slot-01').raw).terminal_verified, false);
});

test('a stale read cannot overwrite a replacement claim which wins before the conditional write', async () => {
  const f = fixture(), first = f.make(), old = f.binding(1);
  await first.reserveRoom(old); f.advanceTo(old.leaseUntil);
  let reachedWrite, resumeWrite;
  const reached = new Promise(resolve => { reachedWrite = resolve; });
  const resume = new Promise(resolve => { resumeWrite = resolve; });
  f.intercept(async (_url, options) => {
    if (options.method === 'POST' && JSON.parse(options.body).room_id === old.roomId) {
      reachedWrite(); await resume;
    }
  });
  const stale = first.recordEntry({ event: 'host.room.closed', host_room_id: old.roomId, cleanup: 'calls_terminal_verified' });
  const rejected = assert.rejects(stale, /fleet_slot_busy/);
  await reached;
  const current = f.binding(2); await f.make().reserveRoom(current);
  resumeWrite(); await rejected;
  const retained = JSON.parse(f.item('slot-01').raw);
  assert.equal(retained.room_id, current.roomId); assert.equal(retained.terminal_verified, false);
});

test('durable pause survives a restarted instance and resume preserves existing room leases', async () => {
  const f = fixture(), leases = f.make(), binding = f.binding(1);
  await leases.reserveRoom(binding);
  await leases.recordEntry({ event: 'host.call.admitted', host_room_id: binding.roomId, provider_call_id: callId(1) });
  const original = f.item('slot-01');
  assert.deepEqual(await f.make().setPaused(true), { admissions_paused: true, durable_active_rooms: 1 });
  const writes = f.requests.filter(row => row.method === 'POST').length;
  await assert.rejects(f.make().reserveRoom(f.binding(2, 'slot-02')), /host_draining/);
  assert.equal(f.requests.filter(row => row.method === 'POST').length, writes, 'paused admission makes no slot claim');
  assert.equal(f.item('slot-01'), original, 'pausing never rewrites an active room');
  assert.deepEqual(await f.make().setPaused(false), { admissions_paused: false, durable_active_rooms: 1 });
  assert.equal(f.item('slot-01'), original, 'resuming never resets leases or drops call identity');
  await leases.recordEntry({ event: 'host.call.admitted', host_room_id: binding.roomId, provider_call_id: callId(2) });
  assert.deepEqual(JSON.parse(f.item('slot-01').raw).call_ids, [callId(1), callId(2)]);
  await assert.rejects(f.make().reserveRoom(f.binding(3)), /fleet_slot_busy/);
  await f.make().reserveRoom(f.binding(2, 'slot-02'));
});

test('a claimed admission racing pause remains visible to drain and cannot escape the final pause check', async () => {
  const f = fixture(); let reachedAllowance, releaseAllowance, granted = false;
  const reached = new Promise(resolve => { reachedAllowance = resolve; });
  const release = new Promise(resolve => { releaseAllowance = resolve; });
  const leases = f.make(undefined, async value => { assert.equal(value, roomId(1)); reachedAllowance(); await release; });
  const pending = leases.reserveRoom(f.binding(1)).then(value => { granted = true; return value; });
  const rejected = assert.rejects(pending, /host_draining/);
  await reached;
  assert.deepEqual(await f.make().setPaused(true), { admissions_paused: true, durable_active_rooms: 1 });
  releaseAllowance(); await rejected;
  assert.equal(granted, false); assert.equal(JSON.parse(f.item('slot-01').raw).terminal_verified, false);
  await leases.recordEntry({ event: 'host.room.closed', host_room_id: roomId(1), cleanup: 'calls_terminal_verified' });
  assert.deepEqual(await f.make().setPaused(true), { admissions_paused: true, durable_active_rooms: 0 });
});

test('crash recovery failure leaves the old lease intact and never attempts a replacement write', async () => {
  const f = fixture(), first = f.make(), binding = f.binding(1);
  await first.reserveRoom(binding);
  await first.recordEntry({ event: 'host.call.admitted', host_room_id: binding.roomId, provider_call_id: callId(1) });
  const old = f.item('slot-01'); f.advanceTo(binding.leaseUntil);
  const count = f.requests.filter(row => row.method === 'POST').length;
  await assert.rejects(f.make(async value => {
    assert.deepEqual(value, { roomId: binding.roomId, callIds: [callId(1)] }); throw new Error('terminal_not_verified');
  }).reserveRoom(f.binding(2)), /terminal_not_verified/);
  assert.equal(f.item('slot-01'), old); assert.equal(f.requests.filter(row => row.method === 'POST').length, count);
});

test('an expired ambiguous local reservation reconciles its owned calls and leaves foreign replacements untouched', async () => {
  const f = fixture(), leases = f.make(), binding = f.binding(1);
  const lease = await leases.reserveRoom(binding);
  await leases.recordEntry({ event: 'host.call.admitted', host_room_id: binding.roomId, provider_call_id: callId(1) });
  await assert.rejects(leases.reconcileRoom(binding), /fleet_token_still_live/);
  f.advanceTo(binding.leaseUntil);
  await leases.reconcileRoom(binding);
  assert.deepEqual(f.recovered, [{ roomId: binding.roomId, callIds: [callId(1)] }]);
  assert.equal(JSON.parse(f.item('slot-01').raw).terminal_verified, true);
  const replacement = f.binding(2); await f.make().reserveRoom(replacement);
  const generation = f.item('slot-01').generation;
  await leases.reconcileRoom(binding);
  assert.equal(f.item('slot-01').generation, generation);
  await assert.rejects(leases.releaseRoom({ ...binding, lease }), /fleet_lease_fenced/);
});

test('terminal cleanup does not permit endpoint reuse until the full JWT cooldown and release is one-use', async () => {
  const f = fixture(), leases = f.make(), binding = f.binding(1);
  binding.lease = await leases.reserveRoom(binding);
  await leases.recordEntry({ event: 'host.room.closed', host_room_id: binding.roomId, cleanup: 'needs_reconciliation' });
  f.advanceTo(binding.leaseUntil);
  await assert.rejects(leases.releaseRoom(binding), /fleet_cleanup_unverified/);
  await leases.recordEntry({ event: 'host.room.closed', host_room_id: binding.roomId, cleanup: 'calls_terminal_verified' });
  f.advanceTo(binding.leaseUntil - 1);
  await assert.rejects(leases.releaseRoom(binding), /fleet_token_still_live/);
  await assert.rejects(f.make().reserveRoom(f.binding(2)), /fleet_slot_busy/);
  f.advanceTo(binding.leaseUntil); await leases.releaseRoom(binding);
  await assert.rejects(leases.releaseRoom(binding), /fleet_lease_fenced/);
  await f.make().reserveRoom(f.binding(2)); assert.deepEqual(f.recovered, []);
});

test('foreign, corrupt or unbounded retained identities cannot trigger recovery or overwrite', async () => {
  const corruptions = [value => ({ ...value, service_id: 'another-service' }), value => ({ ...value, slot_id: 'slot-02' }),
    value => ({ ...value, project: '' }), value => ({ ...value, owner: 'x'.repeat(101) }),
    value => ({ ...value, owner: 'user/another' }), value => ({ ...value, lease: 'not-a-lease' }),
    value => ({ ...value, lease_until: value.lease_until + 1 }), value => ({ ...value, call_ids: [callId(1), callId(1)] }),
    value => ({ ...value, call_ids: ['../Call/'] })];
  for (const corrupt of corruptions) {
    const f = fixture(), binding = f.binding(1); await f.make().reserveRoom(binding);
    f.store('slot-01', corrupt(JSON.parse(f.item('slot-01').raw))); f.advanceTo(binding.leaseUntil);
    const count = f.requests.filter(row => row.method === 'POST').length;
    await assert.rejects(f.make().reserveRoom(f.binding(2)), /fleet_lease_binding_failed/);
    assert.deepEqual(f.recovered, []); assert.equal(f.requests.filter(row => row.method === 'POST').length, count);
  }
});

test('metadata, retained-body and write-response reads are byte-bounded and malformed generations fail closed', async () => {
  for (const phase of ['metadata', 'body', 'write']) {
    const f = fixture();
    if (phase !== 'write') await f.make().reserveRoom(f.binding(1));
    f.intercept((url, options) => {
      if ((phase === 'write' && options.method === 'POST') || (phase === 'metadata' && options.method !== 'POST' && !url.searchParams.has('alt'))
          || (phase === 'body' && url.searchParams.get('alt') === 'media')) return new Response('x'.repeat(8193));
    });
    await assert.rejects(f.make().reserveRoom(f.binding(2)), /fleet_lease_response_limit/);
    assert.deepEqual(f.recovered, []);
  }
  for (const generation of ['', '0', '123x', '1'.repeat(32)]) {
    const f = fixture(); f.intercept(() => Response.json({ generation }));
    await assert.rejects(f.make().reserveRoom(f.binding(1)), /fleet_lease_storage_failed/);
    assert.deepEqual(f.recovered, []);
  }
});

test('an ambiguous committed claim is never retried or mistaken for an available slot', async () => {
  const f = fixture(); let committed = false;
  f.intercept((url, options) => {
    if (options.method === 'POST' && !committed) {
      committed = true; f.store('slot-01', options.body); return new Response('', { status: 500 });
    }
  });
  await assert.rejects(f.make().reserveRoom(f.binding(1)), /fleet_lease_storage_failed/);
  await assert.rejects(f.make().reserveRoom(f.binding(2)), /fleet_slot_busy/);
  assert.equal(f.objects.size, 1); assert.equal(f.requests.filter(row => row.method === 'POST').length, 1);
});
