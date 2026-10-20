import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Script, createContext } from 'node:vm';

const source = await readFile(new URL('../browser.mjs', import.meta.url), 'utf8');
function browser({ login = true, call = true } = {}) {
  const nodes = Object.fromEntries(['#status', '#join', '#leave', '#role'].map(id => [id, { disabled: true, textContent: '' }]));
  const callbacks = new Map(), timers = new Map(), logins = [], calls = [];
  let hungUp = 0, loggedOut = 0, timerId = 0;
  const grant = 'a'.repeat(48), destination = '12345678901234567';
  class Plivo {
    constructor(config) {
      assert.equal(config.debug, 'OFF'); assert.equal(config.enableTracking, false);
      this.client = {
        on: (event, handler) => callbacks.set(event, handler),
        loginWithAccessToken: token => { logins.push(token); return login; },
        call: (...args) => { calls.push(args); return call; },
        hangup: () => { hungUp++; }, logout: () => { loggedOut++; },
      };
    }
  }
  const context = createContext({ window: { Plivo }, document: { querySelector: id => nodes[id] },
    location: { hash: '#' + grant, pathname: '/' }, history: { replaceState() {} },
    fetch: async (url, request) => {
      assert.equal(url, '/join'); assert.deepEqual(JSON.parse(request.body), { grant });
      return { ok: true, json: async () => ({ role: 'customer', token: 'carrier-signed-token', destination }) };
    },
    setTimeout: (callback, ms) => { assert.equal(ms, 20000); timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id) });
  new Script(source, { filename: 'browser.mjs' }).runInContext(context);
  return { nodes, callbacks, timers, calls, logins, grant, destination,
    counts: () => ({ hungUp, loggedOut }) };
}

test('browser registers the carrier-issued token and calls its fixed outgoing marker with a join capability', async () => {
  const f = browser(); await f.nodes['#join'].onclick();
  assert.deepEqual(f.logins, ['carrier-signed-token']); assert.equal(f.calls.length, 0);
  f.callbacks.get('onLogin')();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [[f.destination, { 'X-PH-JoinGrant': f.grant }]]);
  f.callbacks.get('onLogin')(); assert.equal(f.calls.length, 1, 'repeated login events never originate a second call');
  f.callbacks.get('onCallAnswered')(); assert.equal(f.timers.size, 0); assert.equal(f.nodes['#leave'].disabled, false);
  f.nodes['#leave'].onclick(); assert.deepEqual(f.counts(), { hungUp: 1, loggedOut: 1 });
});

test('browser handles synchronous SDK rejection and a bounded registration timeout', async () => {
  const login = browser({ login: false }); await login.nodes['#join'].onclick();
  assert.match(login.nodes['#status'].textContent, /Unable to register/); assert.equal(login.timers.size, 0);
  login.callbacks.get('onLogin')(); assert.equal(login.calls.length, 0, 'late login cannot start a retired browser');
  const call = browser({ call: false }); await call.nodes['#join'].onclick(); call.callbacks.get('onLogin')();
  assert.match(call.nodes['#status'].textContent, /Unable to start/); assert.equal(call.timers.size, 0);
  const timeout = browser(); await timeout.nodes['#join'].onclick();
  [...timeout.timers.values()][0](); assert.match(timeout.nodes['#status'].textContent, /timed out/);
  assert.deepEqual(timeout.counts(), { hungUp: 1, loggedOut: 1 });
});
