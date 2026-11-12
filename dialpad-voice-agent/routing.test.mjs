import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { configuration, routingResponse } from './routing.mjs';
import { createRoutingServer } from './server.mjs';

const secret = 'local-fixture-only-not-a-provider-secret';
const env = {
  DIALPAD_ROUTER_SECRET: secret, DIALPAD_INBOUND_NUMBERS: '+12025550101',
  PYAI_AGENT_NUMBER: '+12025550102', DIALPAD_HUMAN_TARGET_ID: '123456',
  DIALPAD_HUMAN_TARGET_TYPE: 'department', PYAI_ROUTING_ENABLED: 'true',
};
const human = { action: 'route', target_id: 123456, target_type: 'department' };
const agent = { action: 'forward', forward_to: '+12025550102' };
function signed(at, extra = {}, header = { alg: 'HS256', typ: 'JWT' }) {
  const head = Buffer.from(JSON.stringify(header)).toString('base64url');
  const body = Buffer.from(JSON.stringify({ date_started: at, call_id: 'fixture-call-1', external_number: '+12025550103', internal_number: '+12025550101', ...extra })).toString('base64url');
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}
const config = configuration(env);

test('signed documented callbacks route by Los Angeles business hours, including DST and closing boundary', () => {
  for (const [date, expected] of [
    ['2026-11-06T16:59:00Z', agent], // 08:59 PST
    ['2026-11-06T17:00:00Z', human],
    ['2026-11-07T00:59:00Z', human],
    ['2026-11-07T01:00:00Z', agent],
    ['2026-11-07T18:00:00Z', agent], // Saturday
    ['2026-07-06T16:00:00Z', human], // 09:00 PDT
  ]) {
    const at = Date.parse(date);
    assert.deepEqual(routingResponse(signed(at), config, at), expected, date);
  }
});

test('kill switch, return-source guard and explicit all-calls mode', () => {
  const at = Date.parse('2026-11-06T18:00:00Z');
  assert.deepEqual(routingResponse(signed(at), configuration({ ...env, ROUTING_MODE: 'all_calls' }), at), agent);
  assert.deepEqual(routingResponse(signed(at), configuration({ ...env, PYAI_ROUTING_ENABLED: 'false' }), at), human);
  assert.deepEqual(routingResponse(signed(at, { external_number: env.PYAI_AGENT_NUMBER }), configuration({ ...env, ROUTING_MODE: 'all_calls' }), at), human);
});

test('retry crossing opening time keeps the original signed call decision; client route hints cannot choose a destination', () => {
  const at = Date.parse('2026-11-06T16:59:00Z');
  assert.deepEqual(routingResponse(signed(at, { forward_to: '+12025550999', target_id: 999, action: 'hangup' }), config, at + 120000), agent);
});

test('reject unsigned, altered, wrong algorithm, expired, premature and stale requests', () => {
  const at = Date.parse('2026-11-06T18:00:00Z');
  for (const raw of [
    '{}', signed(at).replace(/.$/, c => c === 'A' ? 'B' : 'A'),
    signed(at, {}, { alg: 'none' }), signed(at, {}, { alg: 'HS256', crit: ['custom'] }),
    signed(at, { exp: at / 1000 }), signed(at, { nbf: at / 1000 + 1 }),
    signed(at, { date_started: at - 300001 }), signed(at, { date_started: at + 300001 }),
    signed(at, { date_started: String(at) }), signed(at, { iat: 'today' }),
  ]) assert.throws(() => routingResponse(raw, config, at), error => error.status === 401);
  assert.throws(() => routingResponse(signed(at, { internal_number: '+12025550999' }), config, at), error => error.status === 403);
  assert.deepEqual(routingResponse(JSON.stringify(signed(at)), config, at), human);
});

test('invalid configuration fails closed before a server listens', () => {
  for (const overrides of [
    { DIALPAD_ROUTER_SECRET: '' }, { PYAI_AGENT_NUMBER: env.DIALPAD_INBOUND_NUMBERS },
    { DIALPAD_INBOUND_NUMBERS: '2025550101' }, { BUSINESS_TIME_ZONE: 'not-a-timezone' },
    { DIALPAD_HUMAN_TARGET_ID: '0' }, { BUSINESS_OPEN: '17:00', BUSINESS_CLOSE: '09:00' },
    { PYAI_ROUTING_ENABLED: 'yes' }, { BUSINESS_DAYS: '9' },
  ]) assert.throws(() => configuration({ ...env, ...overrides }));
});

test('HTTP boundary accepts signed callbacks, rejects hostile input, and reveals no caller data', async t => {
  const at = Date.parse('2026-11-07T03:00:00Z');
  const server = createRoutingServer(config, { clock: () => at });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const invoke = (body, type = 'application/jwt') => fetch(base + '/dialpad/route', { method: 'POST', headers: { 'Content-Type': type }, body });
  const success = await invoke(signed(at));
  assert.equal(success.status, 200);
  assert.equal(success.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await success.json(), agent);
  for (const [body, type, status] of [['{}', 'application/json', 401], [signed(at), 'text/html', 415], ['x'.repeat(8193), 'text/plain', 413]]) {
    const response = await invoke(body, type);
    assert.equal(response.status, status);
    const text = await response.text();
    assert.ok(!text.includes(secret) && !text.includes('+12025550103'));
  }
  assert.equal((await fetch(base + '/dialpad/route')).status, 405);
  assert.equal((await fetch(base + '/missing')).status, 404);
  assert.deepEqual(await (await fetch(base + '/healthz')).json(), { status: 'ok', routing_enabled: true });
});
