import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/v8/pyai-widget.js", import.meta.url), "utf8");
const transcriptFixtures = JSON.parse(readFileSync(
  new URL("./fixtures/widget-v8-transcript-shapes.json", import.meta.url),
  "utf8",
));
function runtime() {
  const events = [];
  const listeners = new Map();
  const timers = new Map();
  const sources = [];
  const processors = [];
  let timerId = 0;
  let clock = 0;
  function setTimeoutFake(callback, delay) {
    const id = ++timerId;
    timers.set(id, { callback, at: clock + delay });
    return id;
  }
  function clearTimeoutFake(id) {
    timers.delete(id);
  }
  function advance(ms) {
    clock += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= clock) {
        timers.delete(id);
        timer.callback();
      }
    }
  }
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
    constructor() {
      this.currentTime = 0;
      this.destination = {};
      this.sampleRate = 24000;
      this.state = "running";
    }
    createBuffer(_channels, count, rate) {
      return {
        duration: count / rate,
        getChannelData() { return new Float32Array(count); },
      };
    }
    createBufferSource() {
      const source = {
        connect() {},
        start() {},
        stop() {},
        onended: null,
      };
      sources.push(source);
      return source;
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createScriptProcessor() {
      const processor = {
        onaudioprocess: null,
        connect() {},
        disconnect() {},
      };
      processors.push(processor);
      return processor;
    }
    createGain() {
      return {
        gain: { value: 1 },
        connect() {},
        disconnect() {},
      };
    }
    resume() { return Promise.resolve(); }
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
    navigator: {
      mediaDevices: {
        getUserMedia() {
          return Promise.resolve({ getTracks() { return []; } });
        },
      },
    },
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
    Date,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
  };
  vm.runInNewContext(source, context, { filename: "pyai-widget-v8.js" });
  return {
    helpers: window.__PYAI_WIDGET_TEST__.helpers,
    events,
    listeners,
    sources,
    processors,
    advance,
  };
}

test("v8 has a sanitized stable error contract for every public code", () => {
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

test("v8 maps broker HTTP and stable API codes without generic collapse", () => {
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

test("v8 demultiplexes live text transcripts, legacy JSON, and event controls", () => {
  const { helpers } = runtime();
  const audio = helpers.decodeTaggedFrame(Uint8Array.from([0x01, 1, 2]).buffer);
  assert.equal(audio.kind, "audio");
  assert.deepEqual(Array.from(audio.bytes), [1, 2]);

  const transcriptPayload = new TextEncoder().encode(transcriptFixtures.live_delta);
  const transcript = helpers.decodeTaggedFrame(Uint8Array.from([0x02, ...transcriptPayload]).buffer);
  assert.equal(transcript.kind, "transcript");
  assert.deepEqual(
    JSON.parse(JSON.stringify(transcript.payload)),
    {
      event: "transcript",
      role: "user",
      text: transcriptFixtures.live_delta,
      final: false,
      mode: "delta",
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.normalizeTranscriptBody(
      new TextEncoder().encode(JSON.stringify(transcriptFixtures.canonical)),
    ))),
    { ...transcriptFixtures.canonical, mode: "replace" },
  );

  const controlPayload = new TextEncoder().encode(JSON.stringify({ event: "flush" }));
  const control = helpers.decodeTaggedFrame(Uint8Array.from([0x03, ...controlPayload]).buffer);
  assert.equal(control.kind, "control");
  assert.equal(control.payload.event, "flush");

  const typeKeyed = new TextEncoder().encode(JSON.stringify({ type: "flush" }));
  assert.equal(
    helpers.decodeTaggedFrame(Uint8Array.from([0x03, ...typeKeyed]).buffer).kind,
    "unknown",
  );
  const transcriptControl = new TextEncoder().encode(JSON.stringify({
    event: "transcript", role: "user", text: "wrong carrier", final: false,
  }));
  assert.equal(
    helpers.decodeTaggedFrame(Uint8Array.from([0x03, ...transcriptControl]).buffer).kind,
    "unknown",
  );
  assert.equal(helpers.state.transcriptHistory.length, 0);
});

test("v8 rejects malformed, nested, unsafe, and oversized transcript bodies", () => {
  const { helpers } = runtime();
  const encode = (value) => new TextEncoder().encode(value);
  for (const body of transcriptFixtures.rejected) {
    const encoded = typeof body === "string" ? body : JSON.stringify(body);
    assert.equal(helpers.normalizeTranscriptBody(encode(encoded)), null);
  }
  for (const body of [
    "",
    "{\"role\":\"user\"",
    JSON.stringify({ transcript: { role: "user", text: "nested" } }),
    JSON.stringify({ event: "transcript", role: "tool", text: "unsafe role", final: false }),
    JSON.stringify({ event: "transcript", role: "user", text: "bad\u0000text", final: false }),
    JSON.stringify({ event: "transcript", role: "user", text: "safe", final: "yes" }),
    "x".repeat(16_385),
  ]) {
    assert.equal(helpers.normalizeTranscriptBody(encode(body)), null);
  }
  assert.equal(
    helpers.normalizeTranscriptBody(Uint8Array.from([0xff, 0xfe])),
    null,
  );
});

test("v8 replaces partials, deduplicates retransmits, and bounds history", () => {
  const { helpers } = runtime();
  const tx = (overrides) => ({
    event: "transcript",
    role: "user",
    text: "one",
    final: false,
    mode: "replace",
    ...overrides,
  });
  assert.equal(helpers.applyTranscript(tx({ text: "one" })), true);
  assert.equal(
    helpers.applyTranscript(tx({ text: "one" })),
    false,
    "exact replacement duplicate",
  );
  assert.equal(helpers.applyTranscript(tx({ text: " two", mode: "delta" })), true);
  assert.equal(helpers.applyTranscript(tx({ text: "one two" })), false);
  assert.equal(helpers.state.transcriptHistory.length, 1);
  assert.equal(helpers.state.transcriptHistory[0].text, "one two");
  assert.equal(helpers.applyTranscript(tx({ text: "final text", final: true })), true);
  assert.equal(helpers.state.transcriptHistory[0].text, "final text");
  assert.equal(helpers.state.transcriptHistory[0].final, true);

  assert.equal(helpers.applyTranscript(tx({ role: "assistant", text: "reply" })), true);
  for (let i = 0; i < 110; i += 1) {
    helpers.applyTranscript(tx({
      role: i % 2 ? "assistant" : "user",
      text: `row-${i}`,
      final: true,
    }));
  }
  assert.equal(helpers.state.transcriptHistory.length, 100);
});

test("v8 canonical partial replacements yield exactly two final caller turns", () => {
  const { helpers, events, sources, advance } = runtime();
  const tx = (text, final = false) => ({
    event: "transcript", role: "user", text, final,
  });
  const audio = Uint8Array.from([0x01, 0, 0]).buffer;

  for (const text of ["Synthetic", "Synthetic caller", "Synthetic caller turn"]) {
    assert.equal(helpers.applyTranscript(tx(text)), true);
  }
  assert.equal(helpers.applyTranscript(tx("Synthetic caller turn", true)), true);
  for (let i = 0; i < 40; i += 1) helpers.handleFrame(audio);
  assert.equal(helpers.state.transcriptHistory.length, 1);
  assert.equal(helpers.state.transcriptHistory[0].final, true);
  advance(100);
  assert.equal(
    events.filter((event) => event.type === "pyai:widget:state").map((event) => event.detail.state).join(","),
    "thinking,agent_speaking",
  );

  for (const source of sources.splice(0)) source.onended?.();
  advance(181);
  for (const text of ["Another", "Another caller", "Another caller turn"]) {
    assert.equal(helpers.applyTranscript(tx(text)), true);
  }
  assert.equal(helpers.applyTranscript(tx("Another caller turn", true)), true);
  helpers.handleFrame(audio);
  assert.equal(helpers.state.transcriptHistory.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.state.transcriptHistory.map((row) => [row.role, row.final]))),
    [["user", true], ["user", true]],
  );
});

test("v8 preserves server final flags across controls and bounded replacements", () => {
  const { helpers } = runtime();
  const tx = (text, final = false) => ({
    event: "transcript", role: "user", text, final,
  });
  assert.equal(helpers.applyTranscript(tx("synthetic ")), true);
  assert.equal(helpers.applyTranscript(tx("synthetic caller")), true);
  assert.equal(helpers.state.transcriptHistory.length, 1);
  assert.equal(helpers.state.transcriptHistory[0].final, false);
  helpers.handleFrame(Uint8Array.from([
    0x03, ...new TextEncoder().encode('{"event":"barge_in"}'),
  ]).buffer);
  assert.equal(helpers.state.transcriptHistory[0].final, false, "control events do not invent finality");
  assert.equal(helpers.applyTranscript(tx("synthetic caller", true)), true);
  assert.equal(helpers.state.transcriptHistory[0].final, true);
  assert.equal(helpers.applyTranscript(tx("new caller turn")), true);
  assert.equal(helpers.state.transcriptHistory.length, 2);
  assert.equal(helpers.state.transcriptHistory[1].final, false);

  const oversized = "x".repeat(3999);
  assert.equal(helpers.applyTranscript(tx(oversized)), true);
  assert.equal(helpers.applyTranscript(tx("replacement")), true);
  assert.equal(helpers.state.transcriptHistory.at(-1).text, "replacement");
});

test("v8 transcript host event and capability are caller-honest and versioned", () => {
  const { helpers } = runtime();
  assert.match(source, /emit\("transcript", \{\s*version: 1,\s*role: row\.role/);
  assert.doesNotMatch(source, /emit\("transcript", \{ transcript:/);
  assert.match(source, /payload\.event !== "transcript"/);
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.normalizePublic({}).capabilities)),
    { transcript: "caller", transcriptEventVersion: 1, agentState: true },
  );
});

test("v8 consent gates session and microphone work behind explicit acceptance", () => {
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

test("v8 teardown releases socket, mic, audio, processor, and panel", () => {
  const { helpers } = runtime();
  const calls = [];
  helpers.state.ws = {
    readyState: 1,
    send() { calls.push("send"); },
    close() { calls.push("socket"); },
  };
  helpers.state.stream = { getTracks() { return [{ stop() { calls.push("track"); } }]; } };
  helpers.state.processor = { disconnect() { calls.push("processor"); } };
  helpers.state.captureMute = { disconnect() { calls.push("capture-mute"); } };
  helpers.state.inputContext = { close() { calls.push("input"); return Promise.resolve(); } };
  helpers.state.panel = { remove() { calls.push("panel"); } };
  helpers.end();
  for (const expected of ["send", "socket", "track", "processor", "capture-mute", "input", "panel"]) {
    assert.ok(calls.includes(expected), `${expected} cleanup missing`);
  }
  assert.equal(helpers.state.ws, null);
  assert.equal(helpers.state.stream, null);
});

test("v8 is CSP-aware and rejects executable or unsafe configuration surfaces", () => {
  assert.match(source, /script\.nonce/);
  assert.match(source, /credentials: "omit"/);
  assert.match(source, /PUBLIC_ID_RE/);
  assert.match(source, /safeReferral/);
  assert.doesNotMatch(source, /data-token-url|innerHTML\s*=|\beval\s*\(|new\s+Function\b|\.onclick\s*=/);
  assert.match(source, /window\.addEventListener\("pagehide", destroy\)/);
  assert.match(source, /MutationObserver/);
});

test("v8 rejects WebSocket text frames and exposes one transcript-body parser", () => {
  assert.match(source, /state\.ws\.close\(1002, "binary_frames_required"\)/);
  assert.match(source, /state\.ws\.close\(1002, "invalid_binary_frame"\)/);
  assert.doesNotMatch(source, /JSON\.parse\(event\.data\)/);
  assert.doesNotMatch(source, /normalizeTranscriptPayload|data-size|transcriptSequence|callerFinalize|CALLER_INACTIVITY|finalizeCallerTurn|payload\.delta|payload\.speaker|payload\.sequence/);
});

test("v8 chooses readable text for light and dark accent colors", () => {
  assert.match(source, /function accentText\(accent\)/);
  assert.match(source, /luminance > 0\.179 \? "#171411" : "#fff"/);
  assert.match(source, /color:var\(--pa-text\)/);
  assert.match(source, /setProperty\("--pa-text", accentText\(config\.accent\)\)/);
});

test("v8 sends real caller PCM during a long agent reply after bounded AEC warm-up", () => {
  const { helpers } = runtime();
  const input = new Float32Array([0.5, -0.5, 0.25, -0.25]);
  const captureState = {
    heardAgent: true,
    connectedAt: 0,
    responseAudioActive: true,
    agentPlayStartedAt: 1000,
  };

  const warmup = helpers.selectCallerSamples(input, captureState, 1200);
  assert.notEqual(warmup, input);
  assert.equal(helpers.pcm16FramePeak(helpers.pcm16Frame(warmup, 24000)), 0);

  const armed = helpers.selectCallerSamples(input, captureState, 1400);
  assert.equal(armed, input);
  assert.ok(
    helpers.pcm16FramePeak(helpers.pcm16Frame(armed, 24000)) > 1000,
  );

  const midReply = helpers.selectCallerSamples(input, captureState, 3000);
  assert.equal(midReply, input, "caller audio must never be muted for the whole reply");
});

test("v8 greeting hold is bounded even when no agent audio arrives", () => {
  const { helpers } = runtime();
  const input = new Float32Array([0.5, -0.5]);
  const captureState = {
    heardAgent: false,
    connectedAt: 5000,
    responseAudioActive: false,
    agentPlayStartedAt: 0,
  };

  assert.equal(
    helpers.pcm16FramePeak(
      helpers.pcm16Frame(
        helpers.selectCallerSamples(input, captureState, 8999),
        24000,
      ),
    ),
    0,
  );
  assert.ok(
    helpers.pcm16FramePeak(
      helpers.pcm16Frame(
        helpers.selectCallerSamples(input, captureState, 9000),
        24000,
      ),
    ) > 1000,
  );
});

test("v8 capture callback sends nonzero caller PCM during active playback after warm-up", async () => {
  const { helpers, processors } = runtime();
  const sent = [];
  helpers.state.ws = {
    readyState: 1,
    send(frame) { sent.push(frame); },
  };
  await helpers.startMicrophone();
  const processor = processors[0];
  assert.equal(typeof processor?.onaudioprocess, "function");

  const input = new Float32Array([0.5, -0.5, 0.25, -0.25]);
  const event = {
    inputBuffer: {
      getChannelData() { return input; },
    },
  };
  helpers.state.heardAgent = true;
  helpers.state.responseAudioActive = true;

  helpers.state.agentPlayStartedAt = Date.now();
  processor.onaudioprocess(event);
  assert.equal(helpers.pcm16FramePeak(sent.at(-1)), 0);

  helpers.state.agentPlayStartedAt = Date.now() - 400;
  processor.onaudioprocess(event);
  assert.ok(helpers.pcm16FramePeak(sent.at(-1)) > 1000);
});
