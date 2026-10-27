import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

for (const mode of ['acceptance', 'Console rehearsal', 'ten-room']) test(`real server (${mode}) packages assets, denies untrusted controls, and shuts down cleanly`,
  { timeout: 8000 }, async () => {
    const consolePreview = mode === 'Console rehearsal', concurrent = mode === 'ten-room';
    const child = spawn(process.execPath, ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, PUBLIC_ORIGIN: 'https://test.example.com',
      TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'fixture-account-token',
      TWILIO_APPLICATION_SID: `AP${'b'.repeat(32)}`, TWILIO_API_KEY_SID: `SK${'c'.repeat(32)}`,
      TWILIO_API_KEY_SECRET: 'fixture-signing-secret', PYAI_API_KEY: 'fixture-api-key',
      ADMIN_TOKEN: 'fixture-operator-token-with-at-least-32-chars', JOURNAL_BUCKET: 'fixture-private-bucket',
      JOURNAL_PREFIX: 'qualification/fixture', TEST_DEADLINE: new Date(Date.now() + 60_000).toISOString(), PORT: '0',
      CONSOLE_PREVIEW: consolePreview ? '1' : '0', PREVIEW_ID: 'twilio-preview-fixture', K_REVISION: 'twilio-preview-fixture-001',
      PREVIEW_OWNER: 'a'.repeat(20), ...(concurrent ? { CONCURRENT_ROOMS: '10' } : {}),
    } });
    let stderr = ''; child.stderr.on('data', value => { stderr += value.toString().slice(0, 4096); });
    const exit = once(child, 'exit');
    try {
      const lines = createInterface({ input: child.stdout });
      const [line] = await Promise.race([once(lines, 'line'), exit.then(() => { throw new Error(`startup_failed: ${stderr}`); })]);
      const base = `http://127.0.0.1:${JSON.parse(line).port}`;
      for (const path of ['/health', '/', '/browser.mjs', '/twilio.min.js']) assert.equal((await fetch(base + path)).status, 200, path);
      assert.equal((await fetch(base + '/room')).status, 401);
      const operatorHeaders = { 'Content-Type': 'application/json',
        Authorization: 'Bearer fixture-operator-token-with-at-least-32-chars',
        ...(consolePreview ? { 'X-PyAI-Preview-Id': 'twilio-preview-fixture',
          'X-PyAI-Preview-Revision': 'twilio-preview-fixture-001' } : {}) };
      assert.equal((await fetch(base + '/end', { method: 'POST', headers: operatorHeaders,
        body: JSON.stringify({ room_id: 'test-stale-conversation' }) })).status, concurrent ? 404 : 409,
      'a stale operator cannot end whichever room is current');
      if (concurrent) {
        const capacity = await (await fetch(base + '/capacity', { headers: operatorHeaders })).json();
        assert.equal(capacity.maximum_concurrent_rooms, 10); assert.equal(capacity.admitted_rooms, 0);
        assert.equal((await fetch(base + '/room?room_id=test-00000000-0000-0000-0000-000000000000', { headers: operatorHeaders })).status, 404);
      }
      if (consolePreview) assert.equal((await fetch(base + '/end', { method: 'POST', headers: operatorHeaders,
        body: '{}' })).status, 409, 'Console termination requires its exact room identity');
      assert.equal((await fetch(base + '/join', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: '{"grant":"unknown"}' })).status, consolePreview || concurrent ? 401 : 400);
      assert.equal((await fetch(base + '/join', { method: 'POST', headers: { Origin: 'https://attacker.example.com',
        'Content-Type': 'application/json' }, body: '{"grant":"unknown"}' })).status, 403);
      assert.equal((await fetch(base + '/twilio/voice', { method: 'POST', headers: {
        'Content-Type': 'application/x-www-form-urlencoded' }, body: 'JoinGrant=unknown' })).status, 400);
    } finally {
      child.kill('SIGTERM');
      const result = await Promise.race([exit, delay(2000).then(() => null)]);
      if (!result) child.kill('SIGKILL');
      assert.ok(result, 'server must stop without waiting for the test deadline');
    }
  });
