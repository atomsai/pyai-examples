import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createCallRetirer } from '../retirement.mjs';

const callId = '11111111-1111-4111-8111-111111111111';
const config = { authId: 'MAfixtureaccount12345', authToken: 'fixture-account-token' };
const terminal = { call_uuid: callId, end_time: '2026-10-20 13:22:31+00:00', hangup_cause_name: 'Normal Hangup' };
const response = (status, record) => ({ ok: status >= 200 && status < 300, status, json: async () => record });
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };

test('one exact-call DELETE precedes cached or in-flight signed terminal evidence and aborts outstanding requests', async () => {
  for (const cached of [true, false]) {
    const signed = deferred(), requests = [];
    if (cached) signed.resolve();
    const retire = createCallRetirer({ ...config, budgetMs: 200, fetcher: async (url, options) => {
      requests.push({ url, ...options });
      if (!cached) signed.resolve();
      await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('private-url-token')), { once: true }));
    } });
    assert.equal(await retire(callId, { completed: signed.promise }), 'signed_completed');
    assert.equal(requests.length, 1); assert.equal(requests[0].method, 'DELETE');
    assert.equal(requests[0].url, `https://api.plivo.com/v1/Account/${config.authId}/Call/${callId}/`);
    assert.equal(requests[0].redirect, 'error'); assert.equal(requests[0].signal.aborted, true);
  }
});

test('terminal CDR may lag repeated 404/live records by more than the previous polling window', async () => {
  let deletes = 0, reads = 0; const started = performance.now();
  const retire = createCallRetirer({ ...config, budgetMs: 700, pollMs: 100, fetcher: async (_url, { method }) => {
    if (method === 'DELETE') { deletes++; return response(204); }
    reads++;
    return reads < 3 ? response(404) : reads === 3 ? response(200, { call_uuid: callId }) : response(200, terminal);
  } });
  assert.equal(await retire(callId), 'terminal_cdr');
  assert.equal(deletes, 1); assert.equal(reads, 4); assert.ok(performance.now() - started >= 250);
});

test('missing, foreign or malformed CDR evidence never confirms retirement and each attempt has one DELETE', async () => {
  for (const record of [null, { ...terminal, call_uuid: '22222222-2222-4222-8222-222222222222' },
    { ...terminal, end_time: '' }, { ...terminal, end_time: 'not-a-date' }, { ...terminal, hangup_cause_name: '' }]) {
    let deletes = 0; const started = performance.now();
    const retire = createCallRetirer({ ...config, budgetMs: 35, pollMs: 5, fetcher: async (_url, { method }) => {
      if (method === 'DELETE') { deletes++; return response(404); }
      return record ? response(200, record) : response(404);
    } });
    await assert.rejects(retire(callId), /call_not_terminal/);
    assert.equal(deletes, 1); assert.ok(performance.now() - started < 250);
  }
});

test('a REST failure still permits signed completion, otherwise exposes only its fixed failure code', async () => {
  for (const signedProof of [true, false]) {
    const signed = deferred(); let requests = 0;
    const retire = createCallRetirer({ ...config, budgetMs: 50, fetcher: async () => {
      requests++; throw new Error('Authorization: fixture-account-token private-response');
    } });
    const pending = retire(callId, { completed: signed.promise });
    if (signedProof) { await delay(5); signed.resolve(); assert.equal(await pending, 'signed_completed'); }
    else await assert.rejects(pending, error => error.message === 'carrier_hangup_failed');
    assert.equal(requests, 1);
  }
});

test('one shared deadline bounds slow DELETE or body reads below the SDK retirement budget', async () => {
  for (const phase of ['DELETE', 'body']) {
    let deletes = 0, activeSignal;
    const retire = createCallRetirer({ ...config, budgetMs: 40, fetcher: async (_url, { method, signal }) => {
      activeSignal = signal;
      if (method === 'DELETE') {
        deletes++;
        if (phase !== 'DELETE') return response(204);
      } else return { ok: true, status: 200, json: () => new Promise(() => {}) };
      return new Promise(() => {});
    } });
    const started = performance.now(); await assert.rejects(retire(callId), /call_not_terminal/);
    assert.equal(deletes, 1); assert.equal(activeSignal.aborted, true); assert.ok(performance.now() - started < 250);
  }
  assert.throws(() => createCallRetirer({ ...config, budgetMs: 5000 }), /invalid_retirement_config/);
  let requests = 0;
  const retire = createCallRetirer({ ...config, fetcher: async () => { requests++; } });
  for (const foreignPath of ['', '../Call/', callId + '/']) await assert.rejects(retire(foreignPath), /invalid_retired_call/);
  assert.equal(requests, 0);
});
