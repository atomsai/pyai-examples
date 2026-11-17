import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { run, review } from './review-call.mjs';

const sample = JSON.parse(await readFile(new URL('./sample-call.json', import.meta.url)));
const identity = { project_id: 'project-a', org_id: 'org-a', status: 'active', org_status: 'active', scopes: ['trace:read'], env: 'test', key_budget_cents: null };
function fixture(me = identity, payload = sample, status = 200) {
  const requests = [];
  return { requests, deps: { env: { PYAI_API_KEY: 'fixture-key' }, log() {}, fetchImpl: async (url, options) => {
    requests.push(url);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    assert.equal(options.headers.Authorization, 'Bearer fixture-key');
    return Response.json(url.endsWith('/me') ? me : payload, { status: url.endsWith('/me') ? 200 : status });
  } } };
}
test('default sample never requests the API, even with an existing live key', async () => {
  const { result } = await run([], { env: { PYAI_API_KEY: 'unused-live-key' }, fetchImpl() { throw Error('Unexpected network'); } });
  assert.equal(result.sample, true); assert.equal(result.audit_chain_verified, false);
  assert.equal(result.findings[0].at_t, null);
});
test('missing credentials, malformed options and unexpected identity fail before Trace reads', async () => {
  await assert.rejects(run(['--live', '--project', 'project-a'], { env: {} }), /require/);
  for (const args of [['--call', 'x'], ['--live', '--project'], ['--unknown'], ['--live', '--live']]) await assert.rejects(run(args), /Use|Missing/);
  for (const change of [{ project_id: 'other' }, { org_id: null }, { status: 'revoked' }, { org_status: 'suspended' }, { scopes: [] }]) {
    const f = fixture({ ...identity, ...change });
    await assert.rejects(run(['--live', '--project', 'project-a', '--call', sample.id], f.deps), /no Trace data/);
    assert.equal(f.requests.length, 1);
  }
});
test('live read returns reported evidence unchanged without claiming a new scan or verified audit chain', async () => {
  const f = fixture(); const logs = []; f.deps.log = message => logs.push(JSON.parse(message));
  const { result } = await run(['--live', '--project', 'project-a', '--call', sample.id], f.deps);
  assert.equal(logs[0].environment, 'test'); assert.equal(logs[0].key_budget_cents, null);
  assert.deepEqual(result.findings, sample.scorecard.findings);
  assert.deepEqual(result.scorecard, sample.scorecard);
  assert.equal(result.sample, false); assert.equal(result.audit_chain_verified, false); assert.equal(f.requests.length, 2);
});
test('empty list is not PASS; no automatic selection or submission', async () => {
  const f = fixture(identity, { data: [], has_more: false });
  const { result } = await run(['--live', '--project', 'project-a'], f.deps);
  assert.match(result.next_step, /not a compliance PASS/); assert.equal(f.requests.length, 2);
});
test('HTTP and malformed responses stop without retries', async () => {
  for (const [payload, status] of [[{}, 404], [sample, 429], [{ ...sample, id: 'wrong-call' }, 200], [{ ...sample, scorecard: {} }, 200]]) {
    const f = fixture(identity, payload, status);
    await assert.rejects(run(['--live', '--project', 'project-a', '--call', sample.id], f.deps)); assert.equal(f.requests.length, 2);
  }
  assert.throws(() => review({ ...sample, verdict: 'UNKNOWN' }), /Invalid/);
  const clear = structuredClone(sample); clear.scorecard.findings = []; delete clear.scorecard.gate_health;
  assert.equal(review(clear).gate_health, null);
});
