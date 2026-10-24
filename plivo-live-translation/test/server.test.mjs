import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

for (const mode of ['qualification', 'preview', 'permanent']) test(`Plivo host ${mode} denies untrusted requests and stops without carrier calls`,
  { timeout: 8000 }, async () => {
    const preview = mode === 'preview', permanent = mode === 'permanent';
    const child = spawn(process.execPath, ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, PUBLIC_ORIGIN: 'https://test.example.com', PLIVO_AUTH_ID: 'MAfixtureaccount12345',
      PLIVO_AUTH_TOKEN: 'fixture-account-token', PLIVO_APP_ID: '12345678901234567',
      PLIVO_CUSTOMER_USERNAME: 'pyaiCustomer1', PLIVO_AGENT_USERNAME: 'pyaiAgent2', PLIVO_REPLACEMENT_USERNAME: 'pyaiReplacement3',
      PYAI_API_KEY: 'fixture-api-key', ADMIN_TOKEN: 'fixture-operator-token-with-at-least-32-chars',
      JOURNAL_BUCKET: 'fixture-private-bucket', JOURNAL_PREFIX: 'qualification/fixture',
      TEST_DEADLINE: new Date(Date.now() + 60_000).toISOString(), PORT: '0',
      ...(preview ? { CONSOLE_PREVIEW: '1', PREVIEW_ID: 'plivo-preview-fixture', K_REVISION: 'pyai-plivo-preview-fixture-001' } : {}),
      ...(permanent ? { CONSOLE_PERMANENT: '1', SERVICE_ID: 'plivo-permanent-fixture', K_REVISION: 'pyai-plivo-permanent-001',
        SERVICE_REVISION: 'plivo-console-v1',
        PLIVO_ENDPOINT_POOL: JSON.stringify(Array.from({ length: 10 }, (_, index) => ({ slot_id: `slot-${String(index + 1).padStart(2, '0')}`,
          endpointUsernames: Object.fromEntries(['customer', 'agent', 'replacement'].map(role => [role, `P${index}${role}`])) }))) } : {}),
    } });
    let stderr = ''; child.stderr.on('data', value => { stderr += value.toString().slice(0, 4096); });
    const exit = once(child, 'exit');
    try {
      const lines = createInterface({ input: child.stdout });
      const [line] = await Promise.race([once(lines, 'line'), exit.then(() => { throw new Error(`startup_failed: ${stderr}`); })]);
      const base = `http://127.0.0.1:${JSON.parse(line).port}`;
      for (const path of ['/health', '/', '/browser.mjs', '/plivo-browser.js', '/plivobrowsersdk.js.LICENSE.txt']) {
        assert.equal((await fetch(base + path)).status, 200, path);
      }
      assert.equal((await fetch(base + '/room')).status, 401);
      if (permanent) {
        assert.equal((await fetch(base + '/capacity')).status, 401);
        const headers = { Authorization: 'Bearer fixture-operator-token-with-at-least-32-chars',
          'X-PyAI-Preview-Id': 'plivo-permanent-fixture', 'X-PyAI-Preview-Revision': 'plivo-console-v1' };
        assert.equal((await fetch(base + '/capacity', { headers: { ...headers, 'X-PyAI-Preview-Revision': 'pyai-plivo-permanent-001' } })).status, 401);
        const capacity = await fetch(base + '/capacity', { headers }); assert.equal(capacity.status, 200);
        assert.deepEqual(await capacity.json(), { available: true, admissions_paused: false, maximum_concurrent_rooms: 10, active_rooms: 0, cooldown_rooms: 0, recording_supported: true,language_pairs:"all_supported",recording_formats:["mixed-v1","party-v1"] });
        assert.equal((await fetch(base + '/room', { headers })).status, 404, 'permanent rooms require an exact room ID');
        assert.equal((await fetch(base + '/room?room_id=test-11111111-1111-4111-8111-111111111111', { headers })).status, 404,
          'an admin credential without the original owner tuple cannot read rooms');
        assert.equal((await fetch(base + '/end', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
          body: '{"room_id":"test-11111111-1111-4111-8111-111111111111"}' })).status, 404);
      }
      if (preview) {
        assert.equal((await fetch(base + '/join', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: '{"grant":"unknown"}' })).status, 401, 'fragment grants cannot bypass Console sign-in');
        assert.equal((await fetch(base + '/end', { method: 'POST', headers: { 'Content-Type': 'application/json',
          Authorization: 'Bearer fixture-operator-token-with-at-least-32-chars', 'X-PyAI-Preview-Id': 'plivo-preview-fixture',
          'X-PyAI-Preview-Revision': 'pyai-plivo-preview-fixture-001' }, body: '{"room_id":"stale-room"}' })).status, 409);
      }
      assert.equal((await fetch(base + '/join', { method: 'POST', headers: { Origin: 'https://attacker.example.com',
        'Content-Type': 'application/json' }, body: '{"grant":"unknown"}' })).status, 403);
      for (const path of ['/plivo/voice', '/plivo/status']) assert.equal((await fetch(base + path, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'CallUUID=untrusted' })).status, 400);
    } finally {
      child.kill('SIGTERM'); const result = await Promise.race([exit, delay(2000).then(() => null)]);
      if (!result) child.kill('SIGKILL');
      assert.ok(result, 'host must stop without waiting for its test deadline');
      const diagnostics = stderr.split('\n').filter(line => line.includes('carrier_webhook_rejected')).map(line => JSON.parse(line));
      assert.deepEqual(diagnostics, Array.from({ length: 2 }, () => ({ event: 'carrier_webhook_rejected', code: 'invalid_plivo_signature' })));
      assert.ok(!stderr.includes('untrusted') && !stderr.includes('fixture-account-token'), 'webhook diagnostics must not log payloads or credentials');
    }
  });

for (const [scenario, code, expectedStatus, expectedError] of [
  ['lease-failure', 'fleet_lease_storage_failed', 503, 'test_unavailable'],
  ['lease-throttled', 'fleet_lease_storage_failed', 503, 'test_unavailable'],
  ['allowance-failure', 'fleet_allowance_unavailable', 503, 'test_unavailable'],
  ['allowance-exhausted', 'test_allowance_exhausted', 429, 'test_allowance_exhausted'],
]) test(`permanent room HTTP admission safely reports ${scenario}`, { timeout: 8000 }, async () => {
  const child = spawn(process.execPath, ['--import', './test/server-storage-fixture.mjs', 'server.mjs'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, PUBLIC_ORIGIN: 'https://test.example.com', PLIVO_AUTH_ID: 'MAfixtureaccount12345',
      PLIVO_AUTH_TOKEN: 'fixture-account-token', PLIVO_APP_ID: '12345678901234567',
      PLIVO_CUSTOMER_USERNAME: 'pyaiCustomer1', PLIVO_AGENT_USERNAME: 'pyaiAgent2', PLIVO_REPLACEMENT_USERNAME: 'pyaiReplacement3',
      PYAI_API_KEY: 'fixture-api-key', ADMIN_TOKEN: 'fixture-operator-token-with-at-least-32-chars',
      JOURNAL_BUCKET: 'fixture-private-bucket', JOURNAL_PREFIX: 'qualification/fixture', PORT: '0',
      CONSOLE_PERMANENT: '1', SERVICE_ID: 'plivo-permanent-fixture', K_REVISION: 'pyai-plivo-permanent-001',
      SERVICE_REVISION: 'plivo-console-v1', MOCK_STORAGE_SCENARIO: scenario,
      PLIVO_ENDPOINT_POOL: JSON.stringify(Array.from({ length: 10 }, (_, index) => ({ slot_id: `slot-${String(index + 1).padStart(2, '0')}`,
        endpointUsernames: Object.fromEntries(['customer', 'agent', 'replacement'].map(role => [role, `P${index}${role}`])) }))),
    },
  });
  let stderr = ''; child.stderr.on('data', value => { stderr += value.toString().slice(0, 8192); });
  const exit = once(child, 'exit');
  try {
    const lines = createInterface({ input: child.stdout });
    const [line] = await Promise.race([once(lines, 'line'), exit.then(() => { throw new Error(`startup_failed: ${stderr}`); })]);
    const base = `http://127.0.0.1:${JSON.parse(line).port}`;
    const headers = { Authorization: 'Bearer fixture-operator-token-with-at-least-32-chars',
      'X-PyAI-Preview-Id': 'plivo-permanent-fixture', 'X-PyAI-Preview-Revision': 'plivo-console-v1',
      'X-PyAI-Room-Project': 'private-project-marker', 'X-PyAI-Room-Owner': 'private-owner-marker', 'Content-Type': 'application/json' };
    const input = { language: 'hi', customerVoice: 'hi1', agentVoice: 'en1', sensitive: 'private-request-marker' };
    assert.equal((await fetch(base + '/rooms', { method: 'POST', body: JSON.stringify(input) })).status, 401);
    assert.equal((await fetch(base + '/rooms', { method: 'POST', headers: { ...headers, 'X-PyAI-Room-Owner': '' },
      body: JSON.stringify(input) })).status, 404, 'the trusted owner scope remains mandatory');
    assert.equal((await fetch(base + '/rooms', { method: 'POST', headers, body: JSON.stringify({ ...input, language: 'invalid' }) })).status,
      400, 'invalid inputs retain the existing rejection');
    const response = await fetch(base + '/rooms', { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(response.status, expectedStatus); assert.deepEqual(await response.json(), { error: expectedError });
    assert.equal(response.headers.get('retry-after'), expectedStatus === 503 ? '1' : null);
  } finally {
    child.kill('SIGTERM'); const result = await Promise.race([exit, delay(2000).then(() => null)]);
    if (!result) child.kill('SIGKILL');
    assert.ok(result, 'the fixture must close the actual server without external cleanup');
    const diagnostics = stderr.split('\n').filter(line => line.includes('room_admission_rejected')).map(line => JSON.parse(line));
    assert.deepEqual(diagnostics, [
      { event: 'room_admission_rejected', code: 'invalid_room_binding', http_status: 404 },
      { event: 'room_admission_rejected', code: 'invalid_room', http_status: 400 },
      { event: 'room_admission_rejected', code, http_status: expectedStatus,
        ...(scenario === 'lease-throttled' ? { retry_status: 429 } : {}) },
    ]);
    const fixture = stderr.split('\n').filter(line => line.includes('storage_fixture_complete')).map(line => JSON.parse(line));
    assert.deepEqual(fixture, [{ event: 'storage_fixture_complete', denied_external_requests: 0,
      allowance_reached: !scenario.startsWith('lease-') }]);
    for (const marker of ['private-project-marker', 'private-owner-marker', 'private-request-marker', 'private-upstream-response',
      'fixture-private-adc', 'fixture-account-token', 'fixture-api-key', 'fixture-operator-token', 'https://private.example']) {
      assert.ok(!stderr.includes(marker), `diagnostics must not expose ${marker}`);
    }
  }
});
