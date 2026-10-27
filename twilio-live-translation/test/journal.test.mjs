import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventJournal } from '../journal.mjs';

function fixture() {
  const objects = new Map(), calls = []; let pending; let mode = '', generation = 0, clock = 1_800_000_000_000;
  const fetchImpl = async (target, options) => {
    const u = new URL(target), name = u.searchParams.get('name') ?? decodeURIComponent(u.pathname.split('/o/')[1]);
    calls.push({ method: options.method ?? 'GET', name, generation: u.searchParams.get('generation') });
    assert.equal(options.headers.Authorization, 'Bearer fixture-private'); assert.equal(options.redirect, 'error');
    if (options.method === 'POST') {
      assert.equal(u.searchParams.get('ifGenerationMatch'), '0');
      if (mode === 'uncommitted-transient') { mode = ''; return new Response('', { status: 503 }); }
      if (objects.has(name)) return new Response('', { status: 412 });
      const value = { name, generation: String(++generation), body: JSON.parse(options.body) };
      if (mode === 'late-commit') { pending = value; mode = 'commit-after-missing-read'; throw Object.assign(new Error('lost reply'), { name: 'TimeoutError' }); }
      objects.set(name, value);
      if (mode === 'committed-lost-reply') { mode = ''; throw Object.assign(new Error('private response'), { name: 'TimeoutError' }); }
      return Response.json({ name, generation: value.generation });
    }
    if (mode === 'commit-after-missing-read') { mode = ''; objects.set(pending.name, pending); return new Response('', { status: 404 }); }
    const item = objects.get(name); if (!item) return new Response('', { status: 404 });
    if (u.searchParams.get('alt') === 'media') { assert.equal(u.searchParams.get('generation'), item.generation); return Response.json(item.body); }
    return Response.json({ name, generation: item.generation });
  };
  const write = createEventJournal({ bucket: 'fixture-private', prefix: 'production/journal', token: async () => 'fixture-private',
    fetchImpl, now: () => clock, sleep: async ms => { clock += ms; } });
  const entry = n => ({ event: 'input.gated', host_room_id: `test-${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`, host_sequence: 62, leg: 'agent' });
  return { write, entry, objects, calls, mode(value) { mode = value; } };
}

test('a committed event with a lost write reply is read by exact generation without a duplicate write', async () => {
  const f = fixture(); f.mode('committed-lost-reply'); await f.write(f.entry(1));
  assert.equal(f.objects.size, 1); assert.equal(f.calls.filter(x => x.method === 'POST').length, 1);
  assert.ok(f.calls.some(x => x.generation === '1'));
});

test('create-only replay accepts the same event and rejects conflicting existing content', async () => {
  const f = fixture(), event = f.entry(1); await f.write(event); await f.write(event);
  await assert.rejects(f.write({ ...event, leg: 'customer' }), /^Error: journal_write_failed$/);
  assert.deepEqual([...f.objects.values()][0].body, event);
});

test('an uncommitted transient write retries within its budget and ten rooms retain distinct events', async () => {
  const f = fixture(); f.mode('uncommitted-transient'); await f.write(f.entry(1));
  assert.equal(f.calls.filter(x => x.method === 'POST').length, 2);
  await Promise.all(Array.from({ length: 9 }, (_, i) => f.write(f.entry(i + 2))));
  assert.equal(f.objects.size, 10);
  assert.equal(new Set([...f.objects.values()].map(x => x.body.host_room_id)).size, 10);
});

test('a late commit after the first missing read reconciles the conditional retry without overwriting', async () => {
  const f=fixture();f.mode('late-commit');await f.write(f.entry(1));
  assert.equal(f.objects.size,1);assert.equal(f.calls.filter(x=>x.method==='POST').length,2);
  assert.deepEqual([...f.objects.values()][0].body,f.entry(1));
  assert.ok(f.calls.some(x=>x.generation==='1'));
});
