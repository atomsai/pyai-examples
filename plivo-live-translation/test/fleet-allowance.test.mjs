import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFleetAllowance } from '../fleet-allowance.mjs';

const serviceId = 'plivo-permanent-fixture';
const room = value => `test-${String(value).padStart(8, '0')}-1111-4111-8111-111111111111`;
const tick = value => Date.parse(value + 'T12:00:00.000Z');

function fixture() {
  let clock = tick('2026-10-20'), generation = 0, intercept;
  const objects = new Map(), history = new Map(), requests = [];
  const name = month => `qualification/fleet/fleet-${serviceId}/allowance-${month}.json`;
  const store = (month, value) => {
    const item = { name: name(month), generation: String(++generation),
      raw: typeof value === 'string' ? value : JSON.stringify(value) };
    objects.set(item.name, item); history.set(item.generation, item); return item;
  };
  const fetchImpl = async (target, options) => {
    const url = new URL(target), objectName = url.searchParams.get('name') ?? decodeURIComponent(url.pathname.split('/o/')[1]);
    assert.equal(url.origin, 'https://storage.googleapis.com'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-private-adc');
    assert.ok(options.signal instanceof AbortSignal); assert.ok(!String(options.body ?? '').includes('fixture-private-adc'));
    requests.push({ method: options.method ?? 'GET', objectName, condition: url.searchParams.get('ifGenerationMatch') });
    const override = await intercept?.(url, options);
    if (override) return override;
    if (options.method === 'POST') {
      assert.equal(options.headers['Content-Type'], 'application/json');
      if (url.searchParams.get('ifGenerationMatch') !== (objects.get(objectName)?.generation ?? '0')) return new Response('', { status: 412 });
      const month = /allowance-(\d{4}-\d{2})\.json$/.exec(objectName)[1];
      const item = store(month, options.body); return Response.json({ name: item.name, generation: item.generation });
    }
    const item = url.searchParams.has('generation') ? history.get(url.searchParams.get('generation')) : objects.get(objectName);
    if (!item || item.name !== objectName) return new Response('', { status: 404 });
    return url.searchParams.get('alt') === 'media' ? new Response(item.raw) : Response.json({ generation: item.generation, name: item.name });
  };
  const make = () => createFleetAllowance({ bucket: 'fixture-private', prefix: 'qualification/fleet', serviceId,
    token: async () => 'fixture-private-adc', fetchImpl, now: () => clock });
  const seed = rooms => store('2026-10', { schema: 'pyai-carrier-allowance-v1', service_id: serviceId, month: '2026-10', rooms });
  return { make, seed, store, objects, requests, item: month => JSON.parse(objects.get(name(month)).raw),
    setClock(value) { clock = typeof value === 'string' ? Date.parse(value) : value; },
    intercept(value) { intercept = value; } };
}

test('fifteen full-call reservations exhaust the UTC day across restarted instances and duplicate admission is idempotent', async () => {
  const f = fixture();
  for (let i = 1; i <= 15; i++) await f.make().reserve(room(i));
  const writes = f.requests.filter(row => row.method === 'POST').length;
  await f.make().reserve(room(1)); await f.make().reserve(room(15));
  await assert.rejects(f.make().reserve(room(16)), /test_allowance_exhausted/);
  assert.equal(f.item('2026-10').rooms.length, 15);
  assert.equal(f.requests.filter(row => row.method === 'POST').length, writes);
  assert.ok(f.item('2026-10').rooms.every(row => row.date === '2026-10-20'));
});

test('one daily reservation remains one complete eight-minute allowance even when a room is retried later that month', async () => {
  const f = fixture(); await f.make().reserve(room(1));
  f.setClock('2026-10-21T00:00:00.000Z'); await f.make().reserve(room(1));
  await f.make().reserve(room(2));
  assert.deepEqual(f.item('2026-10').rooms, [{ id: room(1), date: '2026-10-20' }, { id: room(2), date: '2026-10-21' }]);
  assert.equal(f.requests.filter(row => row.method === 'POST').length, 2);
});

test('the UTC day resets independently of the monthly ceiling while old-month records cannot consume the new month', async () => {
  const f = fixture();
  f.setClock('2026-10-31T23:59:59.900Z');
  for (let i = 1; i <= 15; i++) await f.make().reserve(room(i));
  await assert.rejects(f.make().reserve(room(16)), /test_allowance_exhausted/);
  f.setClock('2026-11-01T00:00:00.000Z');
  await f.make().reserve(room(16));
  assert.equal(f.objects.size, 2); assert.equal(f.item('2026-10').rooms.length, 15);
  assert.deepEqual(f.item('2026-11').rooms, [{ id: room(16), date: '2026-11-01' }]);
});

test('seventy-five reservations exhaust the month even on a fresh UTC day and a prior reservation still retries safely', async () => {
  const f = fixture(); let value = 1;
  for (const date of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']) {
    f.setClock(tick(date));
    for (let i = 0; i < 15; i++) await f.make().reserve(room(value++));
  }
  f.setClock(tick('2026-10-25')); const writes = f.requests.filter(row => row.method === 'POST').length;
  await f.make().reserve(room(1)); await assert.rejects(f.make().reserve(room(76)), /test_allowance_exhausted/);
  assert.equal(f.item('2026-10').rooms.length, 75);
  assert.equal(f.requests.filter(row => row.method === 'POST').length, writes);
});

test('cross-process contenders for the final daily reservation cannot both spend it', async () => {
  const f = fixture(); f.seed(Array.from({ length: 14 }, (_, i) => ({ id: room(i + 1), date: '2026-10-20' })));
  let arrivals = 0, resume;
  const release = new Promise(resolve => { resume = resolve; });
  f.intercept(async (_url, options) => {
    if (options.method === 'POST' && arrivals < 2) { if (++arrivals === 2) resume(); await release; }
  });
  const results = await Promise.allSettled([f.make().reserve(room(15)), f.make().reserve(room(16))]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.match(results.find(row => row.status === 'rejected').reason.message, /test_allowance_exhausted/);
  assert.equal(f.item('2026-10').rooms.length, 15); assert.equal(arrivals, 2);
});

test('cross-process retries of one room reserve once and sustained CAS contention has a finite attempt limit', async () => {
  const f = fixture(); let arrivals = 0, resume;
  const release = new Promise(resolve => { resume = resolve; });
  f.intercept(async (_url, options) => {
    if (options.method === 'POST' && arrivals < 2) { if (++arrivals === 2) resume(); await release; }
  });
  await Promise.all([f.make().reserve(room(1)), f.make().reserve(room(1))]);
  assert.equal(f.item('2026-10').rooms.length, 1);
  const contended = fixture(); contended.intercept((_url, options) => options.method === 'POST' ? new Response('', { status: 412 }) : undefined);
  await assert.rejects(contended.make().reserve(room(1)), /fleet_allowance_busy/);
  assert.equal(contended.requests.filter(row => row.method === 'POST').length, 12); assert.equal(contended.objects.size, 0);
});

test('admission keeps its original UTC day and month during a midnight CAS retry', async () => {
  const f = fixture(); f.setClock('2026-10-31T23:59:59.999Z'); let first = true;
  f.intercept((_url, options) => {
    if (options.method === 'POST' && first) { first = false; f.setClock('2026-11-01T00:00:00.001Z'); return new Response('', { status: 412 }); }
  });
  await f.make().reserve(room(1));
  assert.deepEqual(f.item('2026-10').rooms, [{ id: room(1), date: '2026-10-31' }]); assert.equal(f.objects.size, 1);
});

test('foreign, malformed or oversized retained ledgers fail closed without making a reservation write', async () => {
  const valid = { schema: 'pyai-carrier-allowance-v1', service_id: serviceId, month: '2026-10',
    rooms: [{ id: room(1), date: '2026-10-20' }] };
  const variants = [{ ...valid, service_id: 'another-service' }, { ...valid, month: '2026-11' },
    { ...valid, rooms: [{ id: 'test-' + '-'.repeat(36), date: '2026-10-20' }] },
    { ...valid, rooms: [{ id: room(1), date: '2026-10-99' }] },
    { ...valid, rooms: [{ id: room(1), date: '2026-10-00' }] },
    { ...valid, rooms: [{ id: room(1), date: '2026-11-01' }] },
    { ...valid, rooms: [...valid.rooms, ...valid.rooms] },
    { ...valid, rooms: Array.from({ length: 76 }, (_, i) => ({ id: room(i + 1), date: '2026-10-20' })) }];
  for (const value of variants) {
    const f = fixture(); f.store('2026-10', value);
    await assert.rejects(f.make().reserve(room(2)), /fleet_allowance_unavailable/);
    assert.equal(f.requests.filter(row => row.method === 'POST').length, 0);
  }
  for (const phase of ['metadata', 'body', 'write']) {
    const f = fixture(); if (phase !== 'write') f.store('2026-10', valid);
    f.intercept((url, options) => {
      if ((phase === 'write' && options.method === 'POST') || (phase === 'metadata' && options.method !== 'POST' && !url.searchParams.has('alt'))
          || (phase === 'body' && url.searchParams.get('alt') === 'media')) return new Response('x'.repeat(8193));
    });
    await assert.rejects(f.make().reserve(room(2)), /fleet_allowance_unavailable/);
  }
});

test('bad input, malformed generations and ambiguous committed writes never create duplicate spend', async () => {
  const f = fixture();
  for (const value of ['', '../room', 'test-' + '-'.repeat(36), room(1).toUpperCase()]) {
    await assert.rejects(f.make().reserve(value), /invalid_allowance_room/);
  }
  assert.equal(f.requests.length, 0);
  for (const generation of ['', '0', 'bad', '1'.repeat(32)]) {
    const bad = fixture(); bad.intercept(() => Response.json({ generation }));
    await assert.rejects(bad.make().reserve(room(1)), /fleet_allowance_unavailable/);
  }
  const ambiguous = fixture(); let first = true;
  ambiguous.intercept((_url, options) => {
    if (options.method === 'POST' && first) {
      first = false; ambiguous.store('2026-10', options.body); return new Response('', { status: 500 });
    }
  });
  await assert.rejects(ambiguous.make().reserve(room(1)), /fleet_allowance_unavailable/);
  await ambiguous.make().reserve(room(1));
  assert.equal(ambiguous.item('2026-10').rooms.length, 1);
  assert.equal(ambiguous.requests.filter(row => row.method === 'POST').length, 1);
});
