import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/v6/pyai-widget.js", import.meta.url), "utf8");
const transcriptFixtures = JSON.parse(readFileSync(
  new URL("./fixtures/widget-v6-transcript-shapes.json", import.meta.url),
  "utf8",
));
const immutable = [
  ["v1", readFileSync(new URL("../public/pyai-widget.js", import.meta.url)), "37801a06a5ad0af16888877b4e12bbcaa32b7ac77700ebcb8326c8893b99e512"],
  ["v2", readFileSync(new URL("../public/v2/pyai-widget.js", import.meta.url)), "b00a23c0b1709c6e0c0415ab48c5bd30a505ea063bdde63540038a32d20fd950"],
  ["v3", readFileSync(new URL("../public/v3/pyai-widget.js", import.meta.url)), "9dd90a74eb8fcfee3524d29176c12aea5a12c41020dbe5a21938133e9090d3ae"],
  ["v4", readFileSync(new URL("../public/v4/pyai-widget.js", import.meta.url)), "b9c6be7ccb6d11f83087117ec42bc1c4f730f84c27eca9e5624a31b6346ac271"],
  ["v5", readFileSync(new URL("../public/v5/pyai-widget.js", import.meta.url)), "1f2897934e3dc167dd224ceaa8ca7a8b68da1e00d8cc75888a60195253bf295d"],
];

function runtime() {
  const events = [];
  const listeners = new Map();
  const script = {
    nonce: "",
    isConnected: true,
    parentNode: { insertBefore() {} },
    getAttribute(name) {
      if (name === "data-widget") return "wdgt_12345678901234567890123456789012";
      return null;
    },
  };
  const parent = { appendChild() {} };
  const document = {
    currentScript: script,
    documentElement: {},
    head: parent,
    body: parent,
    activeElement: null,
    querySelectorAll() { return [script]; },
    getElementById() { return null; },
    createElement() {
      return {
        className: "",
        classList: { add() {} },
        style: { setProperty() {} },
        setAttribute() {},
        appendChild() {},
        addEventListener(type, listener) { listeners.set(type, listener); },
        focus() {},
        remove() {},
      };
    },
  };
  class AudioContext {
    close() { return Promise.resolve(); }
  }
  class WebSocket {
    static OPEN = 1;
  }
  const window = {
    __PYAI_WIDGET_TEST__: {},
    URL,
    AudioContext,
    WebSocket,
    fetch() { return new Promise(() => {}); },
    dispatchEvent(event) { events.push(event); },
    addEventListener() {},
  };
  window.window = window;
  const context = {
    window,
    document,
    navigator: { mediaDevices: { getUserMedia() { return Promise.resolve({}); } } },
    console: { warn() {} },
    CustomEvent: class {
      constructor(type, init) { this.type = type; this.detail = init.detail; }
    },
    URL,
    WebSocket,
    AudioContext,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Float32Array,
    DataView,
    ArrayBuffer,
    Blob,
    Math,
    Promise,
  };
  vm.runInNewContext(source, context, { filename: "pyai-widget-v6.js" });
  return { helpers: window.__PYAI_WIDGET_TEST__.helpers, events, listeners };
}

test("v6 has a sanitized stable error contract for every public code", () => {
  const { helpers, events } = runtime();
  const expected = {
    mic_permission_denied: false,
    unsupported_browser: false,
    origin_not_allowed: false,
    credit_exhausted: false,
    daily_cap_exceeded: false,
    session_unavailable: true,
    websocket_failed: true,
    config_unavailable: false,
    consent_required: false,
  };
  const status = { textContent: "" };
  helpers.state.panel = { querySelector() { return status; } };
  for (const [code, retryable] of Object.entries(expected)) {
    const detail = helpers.errorDetail(code, "req_safe");
    assert.equal(detail.code, code);
    assert.equal(detail.retryable, retryable);
    assert.equal(detail.request_id, "req_safe");
    helpers.sessionError({ ...detail, token: "must-not-leak", internal_id: "must-not-leak" });
    assert.equal(status.textContent, detail.message);
    const emitted = events.at(-1);
    assert.equal(emitted.type, "pyai:widget-error");
    assert.deepEqual(
      JSON.parse(JSON.stringify(emitted.detail)),
      { code, message: detail.message, retryable, request_id: "req_safe" },
    );
    assert.doesNotMatch(JSON.stringify(emitted.detail), /token|internal|must-not-leak/i);
  }
  assert.equal(helpers.errorDetail("origin_not_allowed", "bad\nid").request_id, undefined);
  const terminalSocket = helpers.emitWebSocketError(false);
  assert.equal(terminalSocket.code, "websocket_failed");
  assert.equal(terminalSocket.retryable, false);
  assert.doesNotMatch(terminalSocket.message, /try connecting again/i);
});

test("v6 maps broker HTTP and stable API codes without generic collapse", () => {
  const { helpers } = runtime();
  const cases = [
    [403, { type: "https://api.pyai.com/problems/origin_not_allowed", request_id: "r1" }, "session", "origin_not_allowed", false],
    [402, { error: { code: "credit_exhausted" } }, "session", "credit_exhausted", false],
    [429, { code: "daily_cap_exceeded" }, "session", "daily_cap_exceeded", false],
    [503, {}, "session", "session_unavailable", true],
    [404, {}, "config", "config_unavailable", false],
  ];
  for (const [status, body, phase, code, retryable] of cases) {
    const detail = helpers.classifyBrokerError(status, body, phase);
    assert.equal(detail.code, code);
    assert.equal(detail.retryable, retryable);
  }
});

test("v6 demultiplexes live UTF-8 and compatible structured transcript frames", () => {
  const { helpers } = runtime();
  const audio = helpers.decodeTaggedFrame(Uint8Array.from([0x01, 1, 2]).buffer);
  assert.equal(audio.kind, "audio");
  assert.deepEqual(Array.from(audio.bytes), [1, 2]);

  const live = transcriptFixtures.capture.variants[0];
  assert.deepEqual(
    { frame_count: transcriptFixtures.capture.frame_count, body_type: live.body_type, json: live.json },
    { frame_count: 22, body_type: "string", json: false },
  );
  const transcriptPayload = new TextEncoder().encode(live.synthetic_body);
  const transcript = helpers.decodeTaggedFrame(Uint8Array.from([0x02, ...transcriptPayload]).buffer);
  assert.equal(transcript.kind, "transcript");
  assert.deepEqual(
    JSON.parse(JSON.stringify(transcript.payload)),
    {
      role: "user",
      text: "synthetic caller fragment",
      final: false,
      mode: "delta",
      sequence: null,
    },
  );

  const compatible = transcriptFixtures.backward_compatible[0].synthetic_body;
  const structuredPayload = new TextEncoder().encode(JSON.stringify(compatible));
  const structured = helpers.decodeTaggedFrame(
    Uint8Array.from([0x02, ...structuredPayload]).buffer,
  );
  assert.equal(structured.payload.role, "assistant");
  assert.equal(structured.payload.final, true);

  const controlPayload = new TextEncoder().encode(JSON.stringify({ event: "flush" }));
  const control = helpers.decodeTaggedFrame(Uint8Array.from([0x03, ...controlPayload]).buffer);
  assert.equal(control.kind, "control");
  assert.equal(control.payload.event, "flush");
});

test("v6 rejects malformed, nested, unsafe, and oversized transcript bodies", () => {
  const { helpers } = runtime();
  const encode = (value) => new TextEncoder().encode(value);
  for (const body of [
    "",
    "{\"role\":\"user\"",
    JSON.stringify({ transcript: { role: "user", text: "nested" } }),
    JSON.stringify({ role: "tool", text: "unsafe role" }),
    JSON.stringify({ role: "user", text: "bad\u0000text" }),
    JSON.stringify({ role: "user", text: "safe", final: "yes" }),
    JSON.stringify({ role: "user", text: "safe", sequence: -1 }),
    "x".repeat(16_385),
  ]) {
    assert.equal(helpers.normalizeTranscriptBody(encode(body)), null);
  }
  assert.equal(
    helpers.normalizeTranscriptBody(Uint8Array.from([0xff, 0xfe])),
    null,
  );
});

test("v6 coalesces partials, deduplicates, orders, finalizes, and bounds history", () => {
  const { helpers } = runtime();
  const tx = (overrides) => ({
    role: "user",
    text: "one",
    final: false,
    mode: "delta",
    sequence: null,
    ...overrides,
  });
  assert.equal(helpers.applyTranscript(tx({ text: "one", mode: "replace" })), true);
  assert.equal(
    helpers.applyTranscript(tx({ text: "one", mode: "replace" })),
    false,
    "exact replacement duplicate",
  );
  assert.equal(helpers.applyTranscript(tx({ text: " two" })), true);
  assert.equal(helpers.state.transcriptHistory.length, 1);
  assert.equal(helpers.state.transcriptHistory[0].text, "one two");
  assert.equal(helpers.applyTranscript(tx({ text: "final text", final: true, mode: "replace" })), true);
  assert.equal(helpers.state.transcriptHistory[0].text, "final text");
  assert.equal(helpers.state.transcriptHistory[0].final, true);

  assert.equal(helpers.applyTranscript(tx({ role: "assistant", text: "reply", sequence: 4 })), true);
  assert.equal(
    helpers.applyTranscript(tx({ role: "assistant", text: "late", sequence: 3 })),
    false,
    "out-of-order sequence",
  );
  for (let i = 0; i < 110; i += 1) {
    helpers.applyTranscript(tx({
      role: i % 2 ? "assistant" : "user",
      text: `row-${i}`,
      final: true,
      sequence: null,
    }));
  }
  assert.equal(helpers.state.transcriptHistory.length, 100);
});

test("v6 transcript host event is versioned and contains sanitized fields only", () => {
  assert.match(source, /emit\("transcript", \{\s*version: 1,\s*role:/);
  assert.doesNotMatch(source, /emit\("transcript", \{ transcript:/);
});

test("v6 consent gates session and microphone work behind explicit acceptance", () => {
  const consentBranch = source.slice(
    source.indexOf("if (state.config.consentRequired)"),
    source.indexOf("function sessionError"),
  );
  const listener = consentBranch.indexOf('allow.addEventListener("click"');
  const fetchSession = consentBranch.indexOf("fetchSession()", listener);
  const connect = consentBranch.indexOf(".then(connect)", fetchSession);
  assert.ok(listener >= 0 && fetchSession > listener && connect > fetchSession);
  assert.doesNotMatch(consentBranch.slice(0, listener), /fetchSession\(\)|startMicrophone\(\)/);
  assert.match(source, /function connect\(session\)[\s\S]*startMicrophone\(\)/);
  assert.match(consentBranch, /emitError\("consent_required"\)/);
});

test("v6 teardown releases socket, mic, audio, processor, and panel", () => {
  const { helpers } = runtime();
  const calls = [];
  helpers.state.ws = {
    readyState: 1,
    send() { calls.push("send"); },
    close() { calls.push("socket"); },
  };
  helpers.state.stream = { getTracks() { return [{ stop() { calls.push("track"); } }]; } };
  helpers.state.processor = { disconnect() { calls.push("processor"); } };
  helpers.state.inputContext = { close() { calls.push("input"); return Promise.resolve(); } };
  helpers.state.outputContext = { close() { calls.push("output"); return Promise.resolve(); } };
  helpers.state.panel = { remove() { calls.push("panel"); } };
  helpers.end();
  for (const expected of ["send", "socket", "track", "processor", "input", "output", "panel"]) {
    assert.ok(calls.includes(expected), `${expected} cleanup missing`);
  }
  assert.equal(helpers.state.ws, null);
  assert.equal(helpers.state.stream, null);
});

test("v6 is CSP-aware and rejects executable or unsafe configuration surfaces", () => {
  assert.match(source, /script\.nonce/);
  assert.match(source, /credentials: "omit"/);
  assert.match(source, /PUBLIC_ID_RE/);
  assert.match(source, /safeReferral/);
  assert.doesNotMatch(source, /data-token-url|innerHTML\s*=|\beval\s*\(|new\s+Function\b|\.onclick\s*=/);
  assert.match(source, /window\.addEventListener\("pagehide", destroy\)/);
  assert.match(source, /MutationObserver/);
});

test("v1-v5 assets remain byte-for-byte immutable", () => {
  for (const [version, bytes, expected] of immutable) {
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, `${version} changed`);
  }
});
