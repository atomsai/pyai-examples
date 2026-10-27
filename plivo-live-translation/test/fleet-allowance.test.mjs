import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFleetAllowance } from '../fleet-allowance.mjs';
import { createStorageBudget, isTransientStorageError } from '../storage-retry.mjs';

const serviceId = 'plivo-permanent-fixture';
const room = value => `test-${String(value).padStart(8, '0')}-1111-4111-8111-111111111111`;
const tick = value => Date.parse(value + 'T12:00:00.000Z');

function fixture() {
  let clock = tick('2026-10-20'), generation = 0, intercept;
  const objects = new Map(), history = new Map(), requests = [], delays = [];
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
    token: async () => 'fixture-private-adc', fetchImpl, now: () => clock, sleep: async milliseconds => { delays.push(milliseconds); clock += milliseconds; } });
  const seed = rooms => store('2026-10', { schema: 'pyai-carrier-allowance-v1', service_id: serviceId, month: '2026-10', rooms });
  return { make, seed, store, objects, requests, delays, now: () => clock, item: month => JSON.parse(objects.get(name(month)).raw),
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

for (const extra of [10, 20, 30, 40, 50]) test(`a dated ${extra}-room qualification retains charged rooms and the monthly ceiling, then expires automatically`, async () => {
  const f = fixture(), qualification = { date: '2026-10-20', extra_rooms: extra, reason: 'final_carrier_qualification' };
  f.store('2026-10', { schema: 'pyai-carrier-allowance-v1', service_id: serviceId, month: '2026-10',
    rooms: Array.from({ length: 15 }, (_, i) => ({ id: room(i + 1), date: qualification.date })), qualification });
  const last = 15 + extra;
  for (let i = 16; i <= last; i++) await f.make().reserve(room(i));
  await assert.rejects(f.make().reserve(room(last + 1)), /test_allowance_exhausted/);
  assert.equal(f.item('2026-10').rooms.length, last);
  assert.deepEqual(f.item('2026-10').qualification, qualification);
  f.setClock('2026-10-21T00:00:00.000Z');
  const nextDay = Math.min(15, 75 - last);
  for (let i = last + 1; i <= last + nextDay; i++) await f.make().reserve(room(i));
  await assert.rejects(f.make().reserve(room(last + nextDay + 1)), /test_allowance_exhausted/);
  f.setClock('2026-10-22T00:00:00.000Z');
  f.store('2026-10', { ...f.item('2026-10'), rooms: Array.from({ length: 75 }, (_, i) => ({ id: room(i + 1), date: '2026-10-19' })),
    qualification: { ...qualification, date: '2026-10-22' } });
  await assert.rejects(f.make().reserve(room(76)), /test_allowance_exhausted/);
});

test('malformed qualification grants fail closed without writing', async () => {
  for (const qualification of [{ date: '2026-10-20', extra_rooms: 11, reason: 'final_carrier_qualification' },
    { date: '2026-10-20', extra_rooms: 21, reason: 'final_carrier_qualification' },
    { date: '2026-10-20', extra_rooms: 41, reason: 'final_carrier_qualification' },
    { date: '2026-10-20', extra_rooms: 51, reason: 'final_carrier_qualification' },
    { date: '2026-10-32', extra_rooms: 10, reason: 'final_carrier_qualification' },
    { date: '2026-10-20', extra_rooms: 10, reason: 'unbounded' }]) {
    const f = fixture();
    f.store('2026-10', { schema: 'pyai-carrier-allowance-v1', service_id: serviceId, month: '2026-10', rooms: [], qualification });
    await assert.rejects(f.make().reserve(room(1)), /fleet_allowance_unavailable/);
    assert.equal(f.requests.filter(row => row.method === 'POST').length, 0);
  }
});

test('the final October grant preserves 71 charged attempts, admits the repaired ten-room test and leaves four reservations', async () => {
  const f = fixture(), qualification = { date:'2026-10-22', extra_rooms:60,
    extra_monthly_rooms:10, reason:'final_carrier_qualification' };
  const prior = Array.from({length:71}, (_,i) => ({id:room(i+1),date:i<10?'2026-10-21':'2026-10-22'}));
  f.store('2026-10',{schema:'pyai-carrier-allowance-v1',service_id:serviceId,month:'2026-10',rooms:prior,qualification});
  f.setClock(tick('2026-10-22'));
  for (let i=72;i<=81;i++) await f.make().reserve(room(i));
  assert.deepEqual(f.item('2026-10').rooms.slice(0,71),prior);
  assert.deepEqual(f.item('2026-10').qualification,qualification);
  f.setClock(tick('2026-10-23'));
  for (let i=82;i<=85;i++) await f.make().reserve(room(i));
  await assert.rejects(f.make().reserve(room(86)),/test_allowance_exhausted/);
  await f.make().reserve(room(1));
  assert.equal(f.item('2026-10').rooms.length,85);
  f.setClock(tick('2026-11-01'));
  for (let i=100;i<115;i++) await f.make().reserve(room(i));
  await assert.rejects(f.make().reserve(room(115)),/test_allowance_exhausted/);
  assert.equal(f.item('2026-11').qualification,undefined);
});

test('the final October grant keeps a finite daily cap and cannot activate its monthly exception early', async () => {
  const f=fixture(),qualification={date:'2026-10-22',extra_rooms:60,extra_monthly_rooms:10,reason:'final_carrier_qualification'};
  f.store('2026-10',{schema:'pyai-carrier-allowance-v1',service_id:serviceId,month:'2026-10',rooms:[],qualification});
  f.setClock(tick('2026-10-22'));
  for(let i=1;i<=75;i++) await f.make().reserve(room(i));
  await assert.rejects(f.make().reserve(room(76)),/test_allowance_exhausted/);
  f.setClock(tick('2026-10-21'));
  await assert.rejects(f.make().reserve(room(76)),/test_allowance_exhausted/);
});

test('the completion allowance retains all 83 charges, admits ten qualification and two recording calls, and remains bounded', async () => {
  const f = fixture(), qualification = { date:'2026-10-22', extra_rooms:60,
    extra_monthly_rooms:10, completion_rooms:12, reason:'final_carrier_qualification' };
  const prior = Array.from({length:83}, (_,i) => ({id:room(i+1),date:i<10?'2026-10-21':'2026-10-22'}));
  f.store('2026-10',{schema:'pyai-carrier-allowance-v1',service_id:serviceId,month:'2026-10',rooms:prior,qualification});
  f.setClock(tick('2026-10-22'));
  for(let i=84;i<=95;i++) await f.make().reserve(room(i));
  assert.deepEqual(f.item('2026-10').rooms.slice(0,83),prior);
  assert.deepEqual(f.item('2026-10').qualification,qualification);
  for(let i=96;i<=97;i++) await f.make().reserve(room(i));
  await assert.rejects(f.make().reserve(room(98)),/test_allowance_exhausted/);
  await f.make().reserve(room(1));
  f.setClock(tick('2026-11-01'));
  for(let i=100;i<115;i++) await f.make().reserve(room(i));
  await assert.rejects(f.make().reserve(room(115)),/test_allowance_exhausted/);
  assert.equal(f.item('2026-11').qualification,undefined);
});

test('the final driver correction retains all 93 charges and permits one more ten-room qualification plus recorded calls', async () => {
  const f=fixture(),qualification={date:'2026-10-22',extra_rooms:60,
    extra_monthly_rooms:10,completion_rooms:24,reason:'final_carrier_qualification'};
  const prior=Array.from({length:93},(_,i)=>({id:room(i+1),date:i<10?'2026-10-21':'2026-10-22'}));
  f.store('2026-10',{schema:'pyai-carrier-allowance-v1',service_id:serviceId,month:'2026-10',rooms:prior,qualification});
  f.setClock(tick('2026-10-22'));
  for(let i=94;i<=105;i++)await f.make().reserve(room(i));
  assert.deepEqual(f.item('2026-10').rooms.slice(0,93),prior);
  for(let i=106;i<=109;i++)await f.make().reserve(room(i));
  await assert.rejects(f.make().reserve(room(110)),/test_allowance_exhausted/);
  await f.make().reserve(room(1));
  f.setClock(tick('2026-11-01'));
  for(let i=120;i<135;i++)await f.make().reserve(room(i));
  await assert.rejects(f.make().reserve(room(135)),/test_allowance_exhausted/);
  assert.equal(f.item('2026-11').qualification,undefined);
});

test('dated capture qualification additions preserve charged attempts, admit ten calls and two recordings, and expire their daily allowance',async()=>{
  for(const completion of [36,48,60,72]){
    const f=fixture(),qualification={date:'2026-10-22',extra_rooms:60,extra_monthly_rooms:10,
      completion_rooms:completion,completion_date:'2026-10-23',reason:'final_carrier_qualification'};
    const retained=completion===36?103:completion===48?113:completion===60?123:134,monthly=85+completion,lastToday=monthly-1;
    const prior=Array.from({length:retained},(_,i)=>({id:room(i+1),date:i<93?'2026-10-22':'2026-10-23'}));
    f.store('2026-10',{schema:'pyai-carrier-allowance-v1',service_id:serviceId,month:'2026-10',rooms:prior,qualification});
    f.setClock(tick('2026-10-23'));for(let i=retained+1;i<=retained+12;i++)await f.make().reserve(room(i));
    assert.deepEqual(f.item('2026-10').rooms.slice(0,retained),prior);await f.make().reserve(room(1));
    for(let i=retained+13;i<=lastToday;i++)await f.make().reserve(room(i));
    await assert.rejects(f.make().reserve(room(monthly)),/test_allowance_exhausted/);
    f.setClock(tick('2026-10-24'));await f.make().reserve(room(monthly));
    await assert.rejects(f.make().reserve(room(monthly+1)),/test_allowance_exhausted/);
    f.setClock(tick('2026-11-01'));for(let i=150;i<165;i++)await f.make().reserve(room(i));
    await assert.rejects(f.make().reserve(room(165)),/test_allowance_exhausted/);
    assert.equal(f.item('2026-11').qualification,undefined);
  }
});

test('monthly qualification additions outside the exact final October grant fail closed', async () => {
  const valid={date:'2026-10-22',extra_rooms:60,extra_monthly_rooms:10,reason:'final_carrier_qualification'};
  for(const qualification of [{...valid,extra_monthly_rooms:11},{...valid,extra_monthly_rooms:0},
    {...valid,extra_rooms:50},{...valid,date:'2026-10-23'},
    {date:valid.date,extra_rooms:60,reason:valid.reason},
    {...valid,completion_rooms:48},{...valid,completion_rooms:48,completion_date:'2026-10-24'},
    {...valid,completion_rooms:48,completion_date:'2026-10-23'},
    {...valid,completion_rooms:84,completion_date:'2026-10-23'},{...valid,completion_rooms:36},{...valid,completion_rooms:36,completion_date:'2026-10-24'},
    {...valid,completion_rooms:24,completion_date:'2026-10-23'},
    {...valid,completion_rooms:36,completion_date:'2026-10-23'},
    {...valid,completion_rooms:13},{...valid,completion_rooms:25},{...valid,completion_rooms:0},
    {date:'2026-10-20',extra_rooms:10,reason:valid.reason,completion_rooms:12}]){
    const f=fixture();f.store('2026-10',{schema:'pyai-carrier-allowance-v1',service_id:serviceId,month:'2026-10',rooms:[],qualification});
    f.setClock(tick('2026-10-22'));
    await assert.rejects(f.make().reserve(room(1)),/fleet_allowance_unavailable/);
    assert.equal(f.requests.filter(row=>row.method==='POST').length,0);
  }
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
  const variants = [null, { ...valid, rooms: [null] }, { ...valid, service_id: 'another-service' }, { ...valid, month: '2026-11' },
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
    assert.equal(f.delays.length, 0);
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
  await ambiguous.make().reserve(room(1));
  assert.equal(ambiguous.item('2026-10').rooms.length, 1);
  assert.equal(ambiguous.requests.filter(row => row.method === 'POST').length, 1);
});


test('a throttled tenth allowance write is retried after strong reads without losing the nine admitted rooms', async () => {
  const f = fixture(); for (let i = 1; i <= 9; i++) await f.make().reserve(room(i));
  const until = f.now() + 1000; let throttled = 0;
  f.intercept((_url, options) => {
    if (options.method === 'POST' && f.now() < until) { throttled++; return new Response('', { status: 429 }); }
  });
  const before = f.requests.length; await f.make().reserve(room(10));
  assert.ok(throttled > 0); assert.ok(f.delays.reduce((a, b) => a + b, 0) >= 1000);
  assert.deepEqual(f.item('2026-10').rooms.map(row => row.id), Array.from({ length: 10 }, (_, i) => room(i + 1)));
  const retryRequests = f.requests.slice(before);
  for (let i = 1; i < retryRequests.length; i++) if (retryRequests[i].method === 'POST') {
    assert.equal(retryRequests[i - 1].method, 'GET'); assert.equal(retryRequests[i - 2].method, 'GET');
    assert.equal(retryRequests[i].condition, '9');
  }
});

test('read failures and a lost committed-write response recover while every ambiguous write is reconciled first', async () => {
  for (const phase of ['metadata', 'body', 'committed-write']) {
    const f = fixture(); if (phase === 'body') f.seed([{ id: room(1), date: '2026-10-20' }]); let first = true;
    f.intercept((url, options) => {
      const selected = phase === 'metadata' ? options.method !== 'POST' && !url.searchParams.has('alt')
        : phase === 'body' ? url.searchParams.get('alt') === 'media' : options.method === 'POST';
      if (!first || !selected) return; first = false;
      if (phase === 'committed-write') { f.store('2026-10', options.body); throw new TypeError('fixture connection reset'); }
      return new Response('', { status: 503 });
    });
    await f.make().reserve(room(2));
    assert.equal(f.item('2026-10').rooms.filter(row => row.id === room(2)).length, 1);
    assert.equal(f.requests.filter(row => row.method === 'POST').length, 1);
    assert.equal(f.delays.length, 1);
  }
});

test('403 and malformed retained data stop immediately, while persistent transient errors stop within the shared deadline', async () => {
  const denied = fixture(); denied.intercept(() => new Response('', { status: 403 }));
  await assert.rejects(denied.make().reserve(room(1)), /fleet_allowance_unavailable/);
  assert.equal(denied.requests.length, 1); assert.equal(denied.delays.length, 0);
  const malformed = fixture(); malformed.intercept(() => Response.json(null));
  await assert.rejects(malformed.make().reserve(room(1)), /fleet_allowance_unavailable/);
  assert.equal(malformed.requests.length, 1); assert.equal(malformed.delays.length, 0);
  const f = fixture(), start = f.now(); f.intercept(() => new Response('', { status: 500 }));
  await assert.rejects(f.make().reserve(room(1)), /fleet_allowance_(?:busy|unavailable)/);
  assert.ok(f.now() - start <= 6500); assert.ok(f.requests.length <= 12);
  assert.equal(f.objects.size, 0);
  const clipped = fixture(), deadline = clipped.now() + 150;
  clipped.intercept(() => new Response('', { status: 429 }));
  await assert.rejects(clipped.make().reserve(room(1), { deadline }), /fleet_allowance_(?:busy|unavailable)/);
  assert.ok(clipped.now() <= deadline); assert.equal(clipped.objects.size, 0);
});

test('transient retries retain their original UTC month and do not spend the reservation twice across midnight', async () => {
  const f = fixture(); f.setClock('2026-10-31T23:59:59.950Z'); let first = true;
  f.intercept((_url, options) => {
    if (options.method === 'POST' && first) { first = false; f.store('2026-10', options.body); return new Response('', { status: 503 }); }
  });
  await f.make().reserve(room(1));
  assert.ok(f.now() >= Date.parse('2026-11-01T00:00:00.000Z'));
  assert.equal(f.objects.size, 1); assert.deepEqual(f.item('2026-10').rooms, [{ id: room(1), date: '2026-10-31' }]);
  assert.equal(f.requests.filter(row => row.method === 'POST').length, 1);
});

test('the shared storage budget bounds a stuck token and response body and prevents a late token from sending a write', async () => {
  const budget = createStorageBudget({ timeoutMs: 10, deadline: Date.now() + 100, errorCode: 'fixture_storage_error' });
  let resolveToken, sent = 0;
  await assert.rejects(budget.request(async () => { sent++; return Response.json({}); },
    () => new Promise(resolve => { resolveToken = resolve; }), 'https://storage.googleapis.com/fixture', { method: 'POST' }),
  error => error.name === 'TimeoutError');
  resolveToken('fixture-private-adc'); await new Promise(resolve => setImmediate(resolve)); assert.equal(sent, 0);
  const response = new Response(new ReadableStream({ start() {}, cancel() {} }));
  await assert.rejects(budget.json(response), error => error.name === 'TimeoutError');
  assert.equal(isTransientStorageError(Object.assign(new Error(), { status: 503 })), true);
  assert.equal(isTransientStorageError(Object.assign(new Error(), { status: 403 })), false);
  assert.equal(isTransientStorageError(new SyntaxError()), false);
});


test('retained-ledger reads reject bodies beyond thirty-two KiB before any write',async()=>{
  const f=fixture();f.intercept(()=>new Response(' '.repeat(32*1024+1),{status:200}));
  await assert.rejects(f.make().reserve(room(1)),error=>error.code==='storage_response_limit');
  assert.equal(f.requests.filter(row=>row.method==='POST').length,0);
});


test('one dated twelve-room verification keeps all failed reservations charged and resets only ordinary next-month limits',async()=>{
  const qualification={date:'2026-10-22',extra_rooms:60,extra_monthly_rooms:10,completion_rooms:72,
    completion_date:'2026-10-23',verification_rooms:12,verification_date:'2026-10-24',reason:'final_carrier_qualification'};
  const prior=Array.from({length:146},(_,i)=>({id:room(i+1),date:i<136?'2026-10-23':'2026-10-24'}));
  const f=fixture();f.setClock(tick('2026-10-24'));f.store('2026-10',{schema:'pyai-carrier-allowance-v1',service_id:serviceId,month:'2026-10',rooms:prior,qualification});
  for(let i=147;i<=158;i++)await f.make().reserve(room(i));
  assert.deepEqual(f.item('2026-10').rooms.slice(0,146),prior);
  assert.deepEqual(f.item('2026-10').qualification,qualification);
  await f.make().reserve(room(1));assert.equal(f.item('2026-10').rooms.length,158);
  for(let i=159;i<=163;i++)await f.make().reserve(room(i));
  await assert.rejects(f.make().reserve(room(164)),/test_allowance_exhausted/);
  f.setClock(tick('2026-10-25'));for(let i=164;i<=169;i++)await f.make().reserve(room(i));
  await assert.rejects(f.make().reserve(room(170)),/test_allowance_exhausted/);
  f.setClock(tick('2026-11-01'));for(let i=200;i<215;i++)await f.make().reserve(room(i));
  await assert.rejects(f.make().reserve(room(215)),/test_allowance_exhausted/);assert.equal(f.item('2026-11').qualification,undefined);
  for(const delta of [{verification_rooms:13},{verification_date:'2026-10-25'},{completion_rooms:60},
    {verification_rooms:undefined},{verification_date:undefined}]){
    const bad=fixture();bad.setClock(tick('2026-10-24'));bad.store('2026-10',{schema:'pyai-carrier-allowance-v1',service_id:serviceId,month:'2026-10',rooms:prior,qualification:{...qualification,...delta}});
    await assert.rejects(bad.make().reserve(room(147)),/fleet_allowance_unavailable/);
    assert.equal(bad.requests.filter(x=>x.method==='POST').length,0);
  }
});


test('dated daily redistribution retains 156 charges and the unchanged 169 month ceiling',async()=>{
  const qualification={date:'2026-10-22',extra_rooms:60,extra_monthly_rooms:10,completion_rooms:72,
    completion_date:'2026-10-23',verification_rooms:12,verification_date:'2026-10-24',verification_daily_rooms:17,reason:'final_carrier_qualification'};
  const prior=Array.from({length:156},(_,i)=>({id:room(i+1),date:i<136?'2026-10-23':'2026-10-24'}));
  const f=fixture();f.setClock(tick('2026-10-24'));f.store('2026-10',{schema:'pyai-carrier-allowance-v1',service_id:serviceId,month:'2026-10',rooms:prior,qualification});
  for(let i=157;i<=168;i++)await f.make().reserve(room(i));
  assert.deepEqual(f.item('2026-10').rooms.slice(0,156),prior);
  await assert.rejects(f.make().reserve(room(169)),/test_allowance_exhausted/);
  f.setClock(tick('2026-10-25'));await f.make().reserve(room(169));
  await assert.rejects(f.make().reserve(room(170)),/test_allowance_exhausted/);
  for(const delta of [{verification_daily_rooms:18},{verification_daily_rooms:0},{verification_date:'2026-10-25'},{verification_rooms:undefined}]){
    const bad=fixture();bad.setClock(tick('2026-10-24'));bad.store('2026-10',{schema:'pyai-carrier-allowance-v1',service_id:serviceId,month:'2026-10',rooms:prior,qualification:{...qualification,...delta}});
    await assert.rejects(bad.make().reserve(room(157)),/fleet_allowance_unavailable/);assert.equal(bad.requests.filter(x=>x.method==='POST').length,0);
  }
});


test('finite qualification grants preserve all failed charges and restore ordinary next-month limits',async()=>{
 for(const [verificationRooms,dailyBonus,priorCount,monthlyLimit] of [[22,27,166,179],[32,37,176,189],[46,52,176,203],[56,62,186,213]]){
  const qualification={date:'2026-10-22',extra_rooms:60,extra_monthly_rooms:10,completion_rooms:72,completion_date:'2026-10-23',verification_rooms:verificationRooms,verification_date:'2026-10-24',verification_daily_rooms:dailyBonus,reason:'final_carrier_qualification'};
  const prior=Array.from({length:priorCount},(_,i)=>({id:room(i+1),date:i<136?'2026-10-23':'2026-10-24'}));
  const f=fixture();f.setClock(tick('2026-10-24'));f.store('2026-10',{schema:'pyai-carrier-allowance-v1',service_id:serviceId,month:'2026-10',rooms:prior,qualification});
  const lastDailyRoom=Math.min(monthlyLimit,136+15+dailyBonus);
  for(let i=priorCount+1;i<=lastDailyRoom;i++)await f.make().reserve(room(i));assert.deepEqual(f.item('2026-10').rooms.slice(0,priorCount),prior);await assert.rejects(f.make().reserve(room(lastDailyRoom+1)),/test_allowance_exhausted/);
  f.setClock(tick('2026-10-25'));for(let i=lastDailyRoom+1;i<=monthlyLimit;i++)await f.make().reserve(room(i));await assert.rejects(f.make().reserve(room(monthlyLimit+1)),/test_allowance_exhausted/);
  f.setClock(tick('2026-11-01'));for(let i=300;i<315;i++)await f.make().reserve(room(i));await assert.rejects(f.make().reserve(room(315)),/test_allowance_exhausted/);assert.equal(f.item('2026-11').qualification,undefined);
  for(const delta of [{verification_rooms:verificationRooms+1},{verification_daily_rooms:dailyBonus+1},{verification_daily_rooms:17},{verification_date:'2026-10-25'}]){
   const bad=fixture();bad.setClock(tick('2026-10-24'));bad.store('2026-10',{schema:'pyai-carrier-allowance-v1',service_id:serviceId,month:'2026-10',rooms:prior,qualification:{...qualification,...delta}});await assert.rejects(bad.make().reserve(room(priorCount+1)),/fleet_allowance_unavailable/);assert.equal(bad.requests.filter(x=>x.method==='POST').length,0);
  }
 }
});


test('dated recording qualification retains 211 charges, admits a preflight and ten calls, leaves two team rooms, and expires next month', async () => {
  const qualification={date:'2026-10-22',extra_rooms:60,extra_monthly_rooms:10,completion_rooms:72,
    completion_date:'2026-10-23',verification_rooms:56,verification_date:'2026-10-24',verification_daily_rooms:62,
    recording_rooms:11,recording_date:'2026-10-26',reason:'final_carrier_qualification'};
  const prior=Array.from({length:211},(_,i)=>({id:room(i+1),date:'2026-10-24'}));
  const f=fixture();f.setClock(tick('2026-10-26'));f.store('2026-10',{schema:'pyai-carrier-allowance-v1',service_id:serviceId,month:'2026-10',rooms:prior,qualification});
  for(let i=212;i<=224;i++)await f.make().reserve(room(i));
  assert.deepEqual(f.item('2026-10').rooms.slice(0,211),prior);
  assert.equal(f.item('2026-10').rooms.length-211,13);
  await assert.rejects(f.make().reserve(room(225)),/test_allowance_exhausted/);
  await f.make().reserve(room(224));
  f.setClock(tick('2026-11-01'));for(let i=300;i<315;i++)await f.make().reserve(room(i));
  await assert.rejects(f.make().reserve(room(315)),/test_allowance_exhausted/);
  assert.equal(f.item('2026-11').qualification,undefined);
  for(const delta of [{recording_rooms:12},{recording_rooms:undefined},{recording_date:undefined},
    {recording_date:'2026-10-27'},{verification_rooms:46}]){
    const bad=fixture();bad.setClock(tick('2026-10-26'));bad.store('2026-10',{schema:'pyai-carrier-allowance-v1',service_id:serviceId,month:'2026-10',rooms:prior,qualification:{...qualification,...delta}});
    await assert.rejects(bad.make().reserve(room(212)),/fleet_allowance_unavailable/);
    assert.equal(bad.requests.filter(x=>x.method==='POST').length,0);
  }
});


test('final recording retry retains all 224 charges, admits ten calls and fifteen team rooms within one finite October grant', async () => {
  const qualification={date:'2026-10-22',extra_rooms:60,extra_monthly_rooms:10,completion_rooms:72,
    completion_date:'2026-10-23',verification_rooms:56,verification_date:'2026-10-24',verification_daily_rooms:62,
    recording_rooms:36,recording_date:'2026-10-26',reason:'final_carrier_qualification'};
  const prior=Array.from({length:224},(_,i)=>({id:room(i+1),date:i<211?'2026-10-24':'2026-10-26'}));
  const f=fixture();f.setClock(tick('2026-10-26'));f.store('2026-10',{schema:'pyai-carrier-allowance-v1',service_id:serviceId,month:'2026-10',rooms:prior,qualification});
  for(let i=225;i<=249;i++)await f.make().reserve(room(i));
  assert.deepEqual(f.item('2026-10').rooms.slice(0,224),prior);await f.make().reserve(room(249));
  await assert.rejects(f.make().reserve(room(250)),/test_allowance_exhausted/);
  f.setClock(tick('2026-11-01'));for(let i=300;i<315;i++)await f.make().reserve(room(i));
  await assert.rejects(f.make().reserve(room(315)),/test_allowance_exhausted/);assert.equal(f.item('2026-11').qualification,undefined);
  for(const delta of [{recording_rooms:35},{recording_rooms:37},{recording_date:'2026-10-27'}]){
    const bad=fixture();bad.setClock(tick('2026-10-26'));bad.store('2026-10',{schema:'pyai-carrier-allowance-v1',service_id:serviceId,month:'2026-10',rooms:prior,qualification:{...qualification,...delta}});
    await assert.rejects(bad.make().reserve(room(225)),/fleet_allowance_unavailable/);assert.equal(bad.requests.filter(x=>x.method==='POST').length,0);
  }
});
