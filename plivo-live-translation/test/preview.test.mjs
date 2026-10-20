import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPreviewRoomBudget } from '../preview.mjs';

function fixture() {
  const objects = new Map(); let clock = 1_800_000_000_000;
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-adc-token');
    const parsed = new URL(url), key = parsed.searchParams.get('name') ?? decodeURIComponent(parsed.pathname.split('/o/')[1]);
    if (options.method === 'POST') {
      assert.equal(parsed.searchParams.get('ifGenerationMatch'), '0');
      assert.ok(!options.body.includes('fixture-adc-token'));
      if (objects.has(key)) return new Response('', { status: 412 });
      objects.set(key, options.body); return new Response('{}', { status: 200 });
    }
    return objects.has(key) ? new Response(objects.get(key)) : new Response('', { status: 404 });
  };
  const make = () => createPreviewRoomBudget({ bucket: 'fixture-private', prefix: 'qualification/preview',
    previewId: 'plivo-preview-fixture', deadline: 1_800_086_400_000, token: async () => 'fixture-adc-token',
    fetchImpl, now: () => clock });
  const room = digit => ({ id: `test-${String(digit).padStart(8, '0')}-1111-4111-8111-111111111111`, expiresAt: clock + 480_000 });
  return { make, room, objects, advance() { clock += 480_001; } };
}

test('preview claims survive restarts, never reuse expired tickets, and stop at twelve', async () => {
  const f = fixture(), budget = f.make();
  const first = f.room(1); await budget.reserve(first);
  await assert.rejects(budget.reserve(f.room(2)), /preview_room_already_active/);
  budget.retired(first.id); await budget.reserve(f.room(2));
  await assert.rejects(f.make().reserve(f.room(3)), /preview_room_already_active/, 'cold boot cannot inherit local retirement');
  for (let i = 3; i <= 12; i++) { f.advance(); await f.make().reserve(f.room(i)); }
  f.advance(); await assert.rejects(f.make().reserve(f.room(13)), /preview_session_limit/);
  assert.equal(f.objects.size, 12);
});

test('concurrent claimants choose one immutable slot and the conflict does not skip forward', async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.make().reserve(f.room(1)), f.make().reserve(f.room(2))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /preview_budget_claim_failed/);
  assert.equal(f.objects.size, 1);
});

test('foreign or oversized retained tickets fail admission instead of resetting allowance', async () => {
  const f = fixture(); await f.make().reserve(f.room(1));
  const [key, raw] = [...f.objects][0];
  f.objects.set(key, JSON.stringify({ ...JSON.parse(raw), preview_id: 'another-preview' }));
  await assert.rejects(f.make().reserve(f.room(2)), /preview_budget_binding_failed/);
  f.objects.set(key, 'x'.repeat(2049));
  await assert.rejects(f.make().reserve(f.room(2)), /preview_budget_read_failed/);
});
