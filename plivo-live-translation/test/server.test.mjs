import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

for (const preview of [false, true]) test(`Plivo host ${preview ? 'Console preview' : 'qualification'} denies untrusted requests and stops without carrier calls`,
  { timeout: 8000 }, async () => {
    const child = spawn(process.execPath, ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, PUBLIC_ORIGIN: 'https://test.example.com', PLIVO_AUTH_ID: 'MAfixtureaccount12345',
      PLIVO_AUTH_TOKEN: 'fixture-account-token', PLIVO_APP_ID: '12345678901234567',
      PLIVO_CUSTOMER_USERNAME: 'pyaiCustomer1', PLIVO_AGENT_USERNAME: 'pyaiAgent2', PLIVO_REPLACEMENT_USERNAME: 'pyaiReplacement3',
      PYAI_API_KEY: 'fixture-api-key', ADMIN_TOKEN: 'fixture-operator-token-with-at-least-32-chars',
      JOURNAL_BUCKET: 'fixture-private-bucket', JOURNAL_PREFIX: 'qualification/fixture',
      TEST_DEADLINE: new Date(Date.now() + 60_000).toISOString(), PORT: '0',
      ...(preview ? { CONSOLE_PREVIEW: '1', PREVIEW_ID: 'plivo-preview-fixture', K_REVISION: 'pyai-plivo-preview-fixture-001' } : {}),
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
