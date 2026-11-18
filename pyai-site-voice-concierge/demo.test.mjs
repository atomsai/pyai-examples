import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemo, validateIdentity, toolArguments } from './demo.mjs';
import { executeDemoTool } from './public/tool-client.mjs';
const me = { project_id: 'proj_test', env: 'test', status: 'active', org_status: 'active', credit: { gated: false, available_cents: 0 }, scopes: ['omni:session'] };
test('actual native JSON-text arguments and object clients normalize without accepting malformed shapes', () => {
  const args = { needs_reminders: true, team_size: 4 };
  assert.deepEqual(toolArguments('{"needs_reminders":true,"team_size":4}'), args);
  assert.equal(toolArguments(args), args);
  for (const invalid of ['{', 'null', '[]', '"string"', 'true', 4, [], null, ' '.repeat(2049)]) assert.throws(() => toolArguments(invalid));
});
test('identity requires the authorized nonbillable test project and scope', () => {
  validateIdentity(me, 'proj_test');
  for (const changed of [{ env: 'live' }, { project_id: 'wrong' }, { status: 'disabled' }, { credit: {} }, { credit: { gated: true, available_cents: 0 } }, { scopes: [] }]) assert.throws(() => validateIdentity({ ...me, ...changed }, 'proj_test'));
});
test('broker rejects unauthenticated and wrong-origin requests; writes once and never exposes the key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pyai-demo-'));
  let calls = 0;
  const apiKey = 'PRIVATE_TEST_KEY_NOT_REAL';
  const password = 'a'.repeat(32);
  const { server, origin } = await startDemo({ apiKey, projectId: 'proj_test', password, port: 18787, resultsDir: dir,
    fetchImpl: async url => { calls++; return Response.json(url.endsWith('/me') ? me : { token: 'ephemeral-only', url: 'wss://api.pyai.com/v1/omni', expires_at: '2030-01-01' }); } });
  try {
    const headers = { Authorization: 'Basic ' + Buffer.from(`demo:${password}`).toString('base64'), Origin: origin, 'Content-Type': 'application/json' };
    assert.equal((await fetch(origin + '/session', { method: 'POST' })).status, 401);
    assert.equal((await fetch(origin + '/session', { method: 'POST', headers: { ...headers, Origin: 'https://wrong.example' } })).status, 403);
    assert.equal(calls, 0);
    const session = await fetch(origin + '/session', { method: 'POST', headers });
    assert.equal(session.status, 200); assert.equal((await session.text()).includes(apiKey), false);
    assert.equal((await fetch(origin + '/session', { method: 'POST', headers })).status, 429);
    assert.equal(calls, 2);
    const call = { name: 'save_demo_enquiry', call_id: 'call_1', arguments: { team_size: 4, needs_reminders: true } };
    const action = () => fetch(origin + '/demo-action', { method: 'POST', headers, body: JSON.stringify(call) });
    assert.equal((await action()).status, 200);
    const expected = call.arguments;
    call.arguments = '{"needs_reminders":true,"team_size":4}';
    assert.equal((await action()).status, 200);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'enquiry.json'), 'utf8')).data, expected);
    call.call_id = 'call_2'; assert.equal((await action()).status, 409);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true }); }
});
test('exhausted-credit upstream response remains an error with no token or retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pyai-demo-'));
  let calls = 0;
  const password = 'b'.repeat(32);
  const { server, origin } = await startDemo({ apiKey: 'PRIVATE', projectId: 'proj_test', password, port: 18788, resultsDir: dir,
    fetchImpl: async url => { calls++; return url.endsWith('/me') ? Response.json(me) : Response.json({ error: 'credit_exhausted' }, { status: 402 }); } });
  try {
    const response = await fetch(origin + '/session', { method: 'POST', headers: { Origin: origin, Authorization: 'Basic ' + Buffer.from(`demo:${password}`).toString('base64') } });
    assert.equal(response.status, 402); assert.deepEqual(await response.json(), { error: 'credit_exhausted' }); assert.equal(calls, 2);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true }); }
});
test('action transport failure never reports success or resubmits', async () => {
  let calls = 0;
  const result = await executeDemoTool({ name: 'save_demo_enquiry', call_id: 'call_1' }, async () => { calls++; throw new Error('lost response'); });
  assert.equal(calls, 1); assert.match(result.error, /unconfirmed/); assert.equal(result.result, undefined);
});
