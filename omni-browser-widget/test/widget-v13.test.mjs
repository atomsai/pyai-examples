import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  AGENT_AUDIO_END_GRACE_MS,
  AGENT_BARGE_ARM_DELAY_MS as SHARED_AGENT_BARGE_ARM_DELAY_MS,
  STARTUP_AUDIO_WAIT_MS,
  beginStartupAudioPhase,
  completeStartupAudioPhase,
  shouldZeroCallerSamples,
} from "../../../marketing/src/lib/eva-audio-policy.mjs";

// The hosted widget deliberately keeps a bounded browser-side mic warm-up on
// later agent replies. #845 (9c322c30) moved that gate into the engine for the
// marketing Eva page (shared AGENT_BARGE_ARM_DELAY_MS 1200 -> 0, trailing
// clause of shouldZeroCallerSamples removed) WITHOUT touching the widget copies.
// Mirroring #845 into the widgets was tried (#1060) and reverted (#1061,
// 218f452b): it breaks the browser e2e
// (marketing/e2e/customer-browser-opening.spec.ts, "hosted-widget-v13 protects
// turn-0 audio and restores later barge-in") with protocol errors, because the
// hosted-widget path does not carry the engine-side gate. So the widget's own
// value is the contract here; only the OPENING protection is asserted against
// the shared module. Porting the engine gate and dropping this to 0 is a
// separate Omni audio-policy change (option 1 on #1060), not a test edit.
const WIDGET_AGENT_BARGE_ARM_DELAY_MS = 350;

const source = readFileSync(
  new URL("../public/v13/pyai-widget.js", import.meta.url),
  "utf8",
);
const historicalV8 = readFileSync(
  new URL("../public/v8/pyai-widget.js", import.meta.url),
  "utf8",
);

function runtime({ permission, resumeError, socketError, sessionFetch, deferResume = false, currentScriptAvailable = true, negotiateOutput = true } = {}) {
  const events = [];
  const requests = [];
  const timers = new Map();
  const sources = [];
  const processors = [];
  const contexts = [];
  const sockets = [];
  const resumeResolvers = [];
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
    for (const context of contexts) context.currentTime = clock / 1000;
    let ran = true;
    while (ran) {
      ran = false;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= clock) {
          timers.delete(id);
          timer.callback();
          ran = true;
        }
      }
    }
  }

  class FakeDate extends Date {
    static now() {
      return clock;
    }
  }
  const script = {
    nonce: "",
    isConnected: true,
    parentNode: { insertBefore() {} },
    getAttribute(name) {
      if (name === "data-widget") {
        return "wdgt_12345678901234567890123456789012";
      }
      return null;
    },
  };
  const parent = { appendChild() {} };
  const document = {
    currentScript: currentScriptAvailable ? script : null,
    documentElement: {},
    head: parent,
    body: parent,
    activeElement: null,
    querySelectorAll(selector) {
      return selector === 'script[src*="/widget/v13/pyai-widget.js"]' ? [script] : [];
    },
    getElementById() { return null; },
    createElement() {
      return {
        className: "",
        classList: { add() {} },
        style: { setProperty() {} },
        setAttribute() {},
        appendChild() {},
        addEventListener() {},
        focus() {},
        remove() {},
      };
    },
  };
  class AudioContext {
    constructor() {
      this.currentTime = clock / 1000;
      this.destination = {};
      this.sampleRate = 24_000;
      this.state = deferResume ? "suspended" : "running";
      contexts.push(this);
    }
    createBuffer(_channels, count, rate) {
      return {
        duration: count / rate,
        getChannelData() { return new Float32Array(count); },
      };
    }
    createBufferSource() {
      const audioSource = {
        connect() {},
        start() {},
        stop() {},
        onended: null,
      };
      sources.push(audioSource);
      return audioSource;
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
    resume() {
      if (resumeError) return Promise.reject(resumeError);
      if (this.state === "running") return Promise.resolve();
      return new Promise((resolve) => {
        resumeResolvers.push(() => {
          this.state = "running";
          resolve();
        });
      });
    }
    close() {
      this.state = "closed";
      return Promise.resolve();
    }
  }
  class WebSocket {
    static OPEN = 1;
    constructor() {
      if (socketError) throw socketError;
      this.readyState = 0; sockets.push(this);
    }
    close() { this.readyState = 3; }
    send() {}
  }
  const window = {
    __PYAI_WIDGET_TEST__: {},
    URL,
    AudioContext,
    WebSocket,
    fetch(url) { requests.push(url); return sessionFetch ? sessionFetch(url) : new Promise(() => {}); },
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
          return permission ? permission() : Promise.resolve({ getTracks() { return []; } });
        },
      },
    },
    console: { warn() {} },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init.detail;
      }
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
    Date: FakeDate,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
  };
  vm.runInNewContext(source, context, { filename: "pyai-widget-v13.js" });
  if (negotiateOutput) window.__PYAI_WIDGET_TEST__.helpers.handleFrame(taggedControl({
    event: "hello", protocol: 2, audio_in: "pcm16@24000", audio_out: "pcm16@24000",
  }));
  return {
    helpers: window.__PYAI_WIDGET_TEST__.helpers,
    requests,
    events,
    sources,
    processors,
    contexts,
    sockets,
    advance,
    resolveResume() {
      for (const resolve of resumeResolvers.splice(0)) resolve();
    },
  };
}

function taggedAudio(samples = [1000, -1000]) {
  const frame = new Uint8Array(1 + samples.length * 2);
  frame[0] = 0x01;
  const view = new DataView(frame.buffer);
  samples.forEach((sample, index) => {
    view.setInt16(1 + index * 2, sample, true);
  });
  return frame.buffer;
}

function taggedControl(payload) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return Uint8Array.from([0x03, ...body]).buffer;
}

function captureEvent(samples) {
  return {
    inputBuffer: {
      getChannelData() { return samples; },
    },
  };
}

test("v13 matches the canonical protected-opening state machine", () => {
  const { helpers } = runtime();
  assert.match(source, /VERSION = "13\.0\.0"/);
  assert.match(source, /OPENING_AUDIO_POLICY_VERSION = "omni-opening-v1"/);
  assert.equal(helpers.startupAudioWaitMs, STARTUP_AUDIO_WAIT_MS);
  assert.equal(helpers.agentBargeArmDelayMs, WIDGET_AGENT_BARGE_ARM_DELAY_MS);
  assert.equal(
    SHARED_AGENT_BARGE_ARM_DELAY_MS,
    0,
    "shared policy gates later replies engine-side; if it grows a browser-side warm-up again, re-decide the widget divergence",
  );
  assert.equal(helpers.agentAudioEndGraceMs, AGENT_AUDIO_END_GRACE_MS);

  for (const [phase, now, connectedAt] of [
    ["waiting", 3999, 0],
    ["waiting", 4000, 0],
    ["playing", 20_000, 0],
    ["complete", 20_000, 0],
  ]) {
    assert.equal(
      helpers.beginStartupAudioPhase(phase, now, connectedAt),
      beginStartupAudioPhase(phase, now, connectedAt),
    );
    assert.equal(
      helpers.completeStartupAudioPhase(phase),
      completeStartupAudioPhase(phase),
    );
  }

  // Opening protection: identical to the shared policy.
  const openingCases = [
    [{ startupAudioPhase: "waiting", connectedAt: 0, responseAudioActive: false, agentPlayStartedAt: 0 }, 3999],
    [{ startupAudioPhase: "waiting", connectedAt: 0, responseAudioActive: false, agentPlayStartedAt: 0 }, 4000],
    [{ startupAudioPhase: "playing", connectedAt: 0, responseAudioActive: true, agentPlayStartedAt: 1000 }, 9000],
  ];
  for (const [state, now] of openingCases) {
    assert.equal(
      helpers.shouldZeroCallerSamples(state, now),
      shouldZeroCallerSamples(state, now),
    );
  }

  // Later replies: the widget's bounded browser-side warm-up (see
  // WIDGET_AGENT_BARGE_ARM_DELAY_MS above). The shared policy returns false
  // for both because its gate lives in the engine.
  const laterReply = { startupAudioPhase: "complete", connectedAt: 0, responseAudioActive: true, agentPlayStartedAt: 1000 };
  assert.equal(helpers.shouldZeroCallerSamples(laterReply, 1000 + WIDGET_AGENT_BARGE_ARM_DELAY_MS - 1), true);
  assert.equal(helpers.shouldZeroCallerSamples(laterReply, 1000 + WIDGET_AGENT_BARGE_ARM_DELAY_MS), false);
  assert.equal(shouldZeroCallerSamples(laterReply, 1200), false);
  assert.equal(shouldZeroCallerSamples(laterReply, 1350), false);

  assert.match(historicalV8, /heardAgent/);
  assert.doesNotMatch(historicalV8, /startupAudioPhase/);
});

test("v13 buffers every early PCM frame until playback is ready", async () => {
  const { helpers, sources, resolveResume } = runtime({ deferResume: true });
  helpers.state.connectedAt = 0;
  helpers.handleFrame(taggedAudio([1000, -1000]));
  helpers.handleFrame(taggedAudio([2000, -2000]));
  helpers.handleFrame(taggedAudio([3000, -3000]));
  assert.equal(helpers.state.pendingAudio.length, 3);
  assert.equal(sources.length, 0);

  const starting = helpers.startMicrophone();
  for (let attempt = 0; attempt < 10 && !helpers.state.inputContext; attempt += 1) {
    await Promise.resolve();
  }
  assert.ok(helpers.state.inputContext);
  assert.equal(helpers.state.playbackReady, false);
  assert.equal(sources.length, 0);

  resolveResume();
  await starting;
  assert.equal(helpers.state.playbackReady, true);
  assert.equal(helpers.state.pendingAudio.length, 0);
  assert.equal(sources.length, 3);
});

test("v13 protects the full opening drain and then preserves later barge-in", async () => {
  const { helpers, processors, sources, advance } = runtime();
  const sent = [];
  await helpers.startMicrophone();
  helpers.state.ws = {
    readyState: 1,
    send(frame) { sent.push(frame); },
  };
  helpers.state.connectedAt = 0;
  helpers.state.startupAudioPhase = "waiting";
  const input = new Float32Array([0.5, -0.5, 0.25, -0.25]);
  const event = captureEvent(input);

  helpers.handleFrame(taggedAudio());
  assert.equal(helpers.state.startupAudioPhase, "playing");
  advance(2000);
  processors[0].onaudioprocess(event);
  assert.equal(
    helpers.pcm16FramePeak(sent.at(-1)),
    0,
    "opening speaker energy must not be sent as caller audio",
  );

  sources[0].onended();
  advance(AGENT_AUDIO_END_GRACE_MS);
  assert.equal(helpers.state.startupAudioPhase, "complete");
  processors[0].onaudioprocess(event);
  assert.ok(helpers.pcm16FramePeak(sent.at(-1)) > 1000);

  helpers.handleFrame(taggedAudio());
  advance(200);
  processors[0].onaudioprocess(event);
  assert.equal(helpers.pcm16FramePeak(sent.at(-1)), 0);
  advance(151);
  processors[0].onaudioprocess(event);
  assert.ok(
    helpers.pcm16FramePeak(sent.at(-1)) > 1000,
    "later replies remain interruptible after the bounded warm-up",
  );
});

test("v13 startup flush clears playback and fail-opens microphone capture", async () => {
  const { helpers, processors } = runtime();
  const sent = [];
  await helpers.startMicrophone();
  helpers.state.ws = {
    readyState: 1,
    send(frame) { sent.push(frame); },
  };
  helpers.state.connectedAt = 0;
  helpers.handleFrame(taggedAudio());
  assert.equal(helpers.state.startupAudioPhase, "playing");
  helpers.handleFrame(taggedControl({ event: "flush", reason: "energy" }));
  assert.equal(helpers.state.startupAudioPhase, "complete");
  assert.equal(helpers.state.pendingAudio.length, 0);
  assert.equal(helpers.state.responseAudioActive, false);

  processors[0].onaudioprocess(
    captureEvent(new Float32Array([0.5, -0.5])),
  );
  assert.ok(helpers.pcm16FramePeak(sent.at(-1)) > 1000);
});

test("v13 narrowly normalizes legacy audio_position telemetry", () => {
  const { helpers } = runtime();
  const legacy = {
    type: "audio_position",
    call_id: "call_test",
    sent_ms: 1280,
    realtime_ms: 640,
  };
  const decoded = helpers.decodeTaggedFrame(taggedControl(legacy));
  assert.equal(decoded.kind, "control");
  assert.equal(decoded.payload.event, "audio_position");
  assert.equal(decoded.payload.type, "audio_position");
  assert.equal(decoded.payload.sent_ms, 1280);

  const canonical = helpers.decodeTaggedFrame(taggedControl({
    event: "audio_position",
    call_id: "call_test",
    sent_ms: 1280,
    realtime_ms: 640,
  }));
  assert.equal(canonical.kind, "control");
  assert.equal(canonical.payload.event, "audio_position");
});

test("v13 rejects malformed or arbitrary type-keyed server controls once", () => {
  for (const payload of [
    { type: "audio_position", sent_ms: -1, realtime_ms: 10 },
    { type: "audio_position", sent_ms: 10, realtime_ms: "10" },
    { type: "audio_position", sent_ms: 10, realtime_ms: 5, extra: true },
    { type: "flush", reason: "energy" },
    { type: "session_ending" },
  ]) {
    const { helpers } = runtime();
    const closes = [];
    helpers.state.ws = {
      readyState: 1,
      close(code, reason) { closes.push({ code, reason }); },
    };
    helpers.handleFrame(taggedControl(payload));
    helpers.handleFrame(taggedControl(payload));
    assert.deepEqual(closes, [{
      code: 4002,
      reason: "invalid_binary_frame",
    }]);
    assert.equal(helpers.state.protocolCloseAttempts, 1);
  }
});

test("v13 closes browser protocol violations with one private-use code", () => {
  const { helpers } = runtime();
  const closes = [];
  helpers.state.ws = {
    readyState: 1,
    close(code, reason) { closes.push({ code, reason }); },
  };

  helpers.handleFrame(Uint8Array.from([0x7f, 0x00]).buffer);
  helpers.handleFrame(Uint8Array.from([0x7f, 0x00]).buffer);
  assert.deepEqual(closes, [{ code: 4002, reason: "invalid_binary_frame" }]);
  assert.equal(helpers.state.protocolCloseRequested, true);
  assert.equal(helpers.state.protocolCloseAttempts, 1);
  assert.equal(helpers.protocolViolationCloseCode, 4002);
  assert.ok(Buffer.byteLength(closes[0].reason, "utf8") <= 123);
});

test("v13 keeps the v9 public security and lifecycle boundaries", () => {
  assert.match(source, /script\.nonce/);
  assert.match(source, /credentials: "omit"/);
  assert.match(source, /PUBLIC_ID_RE/);
  assert.match(source, /state\.ws\.send\(controlFrame\(\{ type: "session_ending" \}\)\)/);
  assert.match(source, /closeForProtocolViolation\("binary_frames_required"\)/);
  assert.match(source, /closeForProtocolViolation\("invalid_binary_frame"\)/);
  assert.doesNotMatch(source, /\.close\(1002,/);
  assert.doesNotMatch(
    source,
    /data-token-url|innerHTML\s*=|\beval\s*\(|new\s+Function\b/,
  );
});

test("v13 accepts native assistant controls and retains plain caller deltas", () => {
  const { helpers } = runtime();
  const assistant = { event: "transcript", role: "assistant", text: "Hello there.", final: true };
  assert.equal(helpers.decodeTaggedFrame(taggedControl(assistant)).payload.text, assistant.text);
  const caller = Uint8Array.from([2, ...new TextEncoder().encode("Hi Eva")]).buffer;
  const decoded = helpers.decodeTaggedFrame(caller);
  assert.equal(decoded.payload.role, "user");
  assert.equal(decoded.payload.mode, "delta");
  assert.equal(decoded.payload.text, "Hi Eva");
  for (const invalid of [
    { ...assistant, role: "user" }, { ...assistant, final: "true" },
    { ...assistant, text: "" }, { ...assistant, text: "bad\u0000text" },
    { ...assistant, text: "a".repeat(100_001) }, { ...assistant, extra: true },
    { type: "transcript", role: "assistant", text: "Hello", final: true },
  ]) assert.equal(helpers.decodeTaggedFrame(taggedControl(invalid)).payload, null);
});

function transcriptRuntime() {
  const result = runtime();
  const log = { firstChild: null, appendChild() {}, scrollTop: 0, scrollHeight: 0 };
  result.helpers.state.panel = { querySelector() { return log; } };
  const send = payload => result.helpers.handleFrame(taggedControl(payload));
  send({ event: "hello", protocol: 2, audio_out: "pcm16@24000", call_id: "call_a" });
  send({ event: "turn_begin", call_id: "call_a", turn: 1 });
  return { ...result, send };
}

function nativeCallerFrame(text) {
  return Uint8Array.from([0x02, ...new TextEncoder().encode(text)]).buffer;
}

test("v13 native caller JSON and brace text stays literal through the actual handler", () => {
  for (const text of [
    '{"event":"transcript","role":"assistant","text":"Hello","final":true}',
    '{"event":"end_call"}', '{"event":"session_end"}', "{", "{not valid JSON",
    '{"role":"assistant",', '["hello"]', '  {"name":"Eva"}  ',
  ]) {
    const { helpers } = transcriptRuntime();
    helpers.handleFrame(nativeCallerFrame(text));
    const rows = helpers.state.transcriptHistory;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, "user");
    assert.equal(rows[0].text, text);
    assert.equal(rows[0].final, false);
  }
});

test("v13 native caller chunks preserve spaces, braces and repeated words exactly", () => {
  const { helpers } = transcriptRuntime();
  const chunks = ['  {', '"role":"assistant",', '"text":"yes yes"}', '  ', 'pr', 'icing  '];
  for (const chunk of chunks) helpers.handleFrame(nativeCallerFrame(chunk));
  assert.equal(helpers.state.transcriptHistory.length, 1);
  assert.equal(helpers.state.transcriptHistory[0].text, chunks.join(""));
  assert.equal(helpers.state.transcriptHistory[0].role, "user");
});

test("v13 native caller spacing survives an existing finalized row and assistant boundary", () => {
  const { helpers, send } = transcriptRuntime();
  // Existing finalized snapshot: later native bytes must neither trim it nor
  // become an envelope/snapshot because the new turn starts with a brace.
  helpers.applyTranscript({ role: "user", text: "previous  ", final: true, mode: "replace" });
  helpers.handleFrame(nativeCallerFrame('  {"text":"next"}'));
  helpers.handleFrame(nativeCallerFrame("  phrase  "));
  assert.deepEqual(Array.from(helpers.state.transcriptHistory, row => row.text),
    ["previous  ", '  {"text":"next"}  phrase  ']);
  send({ event: "transcript", role: "assistant", text: "Understood.", final: true });
  helpers.handleFrame(nativeCallerFrame("  final caller  "));
  assert.equal(helpers.state.transcriptHistory.at(-1).text, "  final caller  ");
  assert.equal(helpers.state.transcriptHistory.at(-1).role, "user");
});

test("v13 native caller retains UTF-8 and per-frame plus aggregate limits", () => {
  const { helpers } = transcriptRuntime();
  const encode = value => new TextEncoder().encode(value);
  for (const bytes of [new Uint8Array(), Uint8Array.from([0xc3, 0x28]),
    encode("bad\u0000text"), encode("bad\u007ftext"), encode("x".repeat(4001)),
    new Uint8Array(16385).fill(0x61)]) {
    assert.equal(helpers.normalizeTranscriptBody(bytes), null);
  }
  assert.equal(helpers.normalizeTranscriptBody(encode("नमस्ते {你好}")).text, "नमस्ते {你好}");
  helpers.handleFrame(nativeCallerFrame("x".repeat(4000)));
  helpers.handleFrame(nativeCallerFrame("y"));
  assert.equal(helpers.state.transcriptHistory[0].text, "x".repeat(4000), "overflow cannot grow the stored row");
});

test("v13 actual native emitter fixture preserves caller02 and assistant03 roles", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/native-engine-transcripts.json", import.meta.url), "utf8"));
  const { helpers } = transcriptRuntime();
  assert.equal(fixture.frames.length, 2);
  for (const emitted of fixture.frames) {
    const frame = Uint8Array.from(Buffer.from(emitted.base64, "base64"));
    assert.equal(frame[0], emitted.tag);
    assert.equal(new TextDecoder().decode(frame.subarray(1)), emitted.payload);
    helpers.handleFrame(frame.buffer);
  }
  assert.deepEqual(Array.from(helpers.state.transcriptHistory, row => [row.role, row.text, row.final]), [
    ["user", "Caller test phrase.", false], ["assistant", "Assistant test phrase.", true],
  ]);
});

test("v13 corrects the matching assistant while preserving the caller and next reply", () => {
  const { helpers, send } = transcriptRuntime();
  send({ event: "transcript", role: "assistant", text: "Try the console. I can arrange a sales call.", final: true });
  helpers.applyTranscript({ role: "user", text: "Wait", final: true, mode: "replace" });
  send({ event: "assistant_interrupted", call_id: "call_a", reply: "Try the console." });
  assert.deepEqual(Array.from(helpers.state.transcriptHistory, row => row.text), ["Try the console.", "Wait"]);
  assert.equal(helpers.state.assistantTranscript.interrupted, true);
  send({ event: "transcript", role: "assistant", text: "Unheard tail", final: true });
  assert.equal(helpers.state.transcriptHistory.length, 2);
  send({ event: "turn_begin", call_id: "call_a", turn: 2 });
  send({ event: "transcript", role: "assistant", text: "console.pyai.com", final: true });
  assert.equal(helpers.state.transcriptHistory.at(-1).text, "console.pyai.com");
});

for (const reply of ["Wrong prefix", "bad\u0000", "a".repeat(501)]) {
  test(`v13 invalid correction does not consume the valid correction (${reply.length} chars)`, () => {
    const { helpers, send } = transcriptRuntime();
    send({ event: "transcript", role: "assistant", text: "Try the console. Extra.", final: true });
    send({ event: "assistant_interrupted", call_id: "call_a", reply });
    assert.equal(helpers.state.assistantTranscript.interrupted, false);
    send({ event: "assistant_interrupted", call_id: "call_a", reply: "Try the console." });
    assert.equal(helpers.state.transcriptHistory[0].text, "Try the console.");
  });
}

test("v13 rejects foreign corrections, ignores duplicates, and removes only an empty-prefix assistant", () => {
  const { helpers, send } = transcriptRuntime();
  send({ event: "assistant_interrupted", call_id: "call_a", reply: "" });
  assert.equal(helpers.state.assistantTranscript.interrupted, false, "no row must not suppress future text");
  send({ event: "transcript", role: "assistant", text: "Not delivered", final: true });
  helpers.applyTranscript({ role: "user", text: "Wait", final: true, mode: "replace" });
  send({ event: "assistant_interrupted", call_id: "different", reply: "" });
  assert.equal(helpers.state.transcriptHistory.length, 2);
  send({ event: "assistant_interrupted", call_id: "call_a", reply: "" });
  send({ event: "assistant_interrupted", call_id: "call_a", reply: "" });
  assert.deepEqual(Array.from(helpers.state.transcriptHistory, row => row.text), ["Wait"]);
});

test("v13 keeps consecutive partial assistant responses separate by turn", () => {
  const { helpers, send } = transcriptRuntime();
  send({ event: "transcript", role: "assistant", text: "First partial", final: false });
  send({ event: "turn_begin", call_id: "call_a", turn: 2 });
  send({ event: "transcript", role: "assistant", text: "Next response", final: false });
  assert.deepEqual(Array.from(helpers.state.transcriptHistory, row => row.text), ["First partial", "Next response"]);
});

test("v13 embeds the shared reviewed interruption policy exactly", () => {
  const shared = readFileSync(new URL("../../../marketing/src/lib/eva-transcript-correction.mjs", import.meta.url), "utf8").replace(/^export /gm, "").trimEnd();
  const embedded = source.split("// BEGIN SHARED TRANSCRIPT CORRECTION\n")[1].split("  // END SHARED TRANSCRIPT CORRECTION")[0].split("\n").map(line => line.replace(/^  /, "")).join("\n").trimEnd();
  assert.equal(embedded, shared);
});


test("v13 finds its own script when document.currentScript is unavailable", () => {
  const { helpers, requests } = runtime({ currentScriptAvailable: false });
  assert.equal(typeof helpers?.handleFrame, "function");
  assert.deepEqual(requests, ["https://api.pyai.com/public/widgets/wdgt_12345678901234567890123456789012"]);
});


test("v13 receipt helper is byte-identical to the qualified website implementation", () => {
  const shared = readFileSync(new URL("../../../marketing/src/lib/omni-playback-receipts.mjs", import.meta.url), "utf8");
  const embedded = source.split("// BEGIN SHARED OMNI PLAYBACK RECEIPTS\n")[1]
    .split("  // END SHARED OMNI PLAYBACK RECEIPTS")[0]
    .split("\n").map(line => line.replace(/^  /, "")).join("\n");
  assert.equal(embedded.trim(), shared.replace("export class", "class").trim());
  assert.match(source, /\["pyai\.v1", "pyai-key\." \+ session\.token\]/);
});

for (const terminal of ["flush", "barge_in", "reply_interrupted", "reply_failed"]) {
  test(`v13 ${terminal} invalidates natural callbacks from queued segments`, async () => {
    const r = runtime({ deferResume: true }), frames = [], reply_id = "b".repeat(32);
    const started = r.helpers.startMicrophone();
    for (let i = 0; i < 10 && !r.helpers.state.inputContext; i++) await Promise.resolve();
    r.helpers.state.ws = { readyState: 1, send: b => frames.push(JSON.parse(new TextDecoder().decode(b.slice(1)))) };
    r.helpers.handleFrame(taggedControl({ event: "configured", playback_ack: true }));
    for (const segment_id of ["1", "2"]) {
      r.helpers.handleFrame(taggedControl({ event: "audio_segment_start", reply_id, segment_id, sample_rate: 24000 }));
      r.helpers.handleFrame(taggedAudio([1000, -1000]));
      r.helpers.handleFrame(taggedControl({ event: "audio_segment_done", reply_id, segment_id, sent_samples: 2 }));
    }
    assert.equal(r.sources.length, 0); assert.equal(frames.length, 0);
    r.resolveResume(); await started;
    assert.equal(r.sources.length, 2);
    r.sources[0].onended(); r.sources[1].onended();
    assert.deepEqual(frames.map(f => [f.segment_id, f.played_samples]), [["1", 2], ["2", 2]]);
    r.helpers.handleFrame(taggedControl({ event: "audio_segment_start", reply_id, segment_id: "3", sample_rate: 24000 }));
    r.helpers.handleFrame(taggedAudio([1000, -1000]));
    r.helpers.handleFrame(taggedControl({ event: terminal, reply_id }));
    r.sources[2].onended(); assert.equal(frames.length, 2);
  });
}

test("v13 older configured response keeps receipts disabled", async () => {
  const r = runtime(), frames = [], reply_id = "c".repeat(32);
  await r.helpers.startMicrophone();
  r.helpers.state.ws = { readyState: 1, send: b => frames.push(b) };
  r.helpers.handleFrame(taggedControl({ event: "configured" }));
  r.helpers.handleFrame(taggedControl({ event: "audio_segment_start", reply_id, segment_id: "1", sample_rate: 24000 }));
  r.helpers.handleFrame(taggedAudio([1000, -1000]));
  r.sources[0].onended(); assert.equal(frames.length, 0);
});

const nativeHello = { event: "hello", protocol: 2, audio_in: "pcm16@24000", audio_out: "pcm16@24000" };

test("v13 audio contract rejects unsupported declarations and clears without false played receipts", () => {
  const faults = [null, "odd-EOF", {event:"hello"},
    ...["pcm16@8000","pcm16@16000","pcm16@48000","float32@24000"].map(audio_out=>({...nativeHello,audio_out})),
    {...nativeHello,audio_out:{format:"pcm16",sample_rate:24000}},
    {...nativeHello,audio_in:"pcm16@16000"}, {...nativeHello,channels:2},
    {...nativeHello,audio_out_channels:2}, {...nativeHello,format:"float32"},
    {event:"configured",audio_out:"pcm16@48000"},
    {event:"audio_segment_start",sample_rate:48000},
  ];
  for (const fault of faults) {
    const { helpers, events, sources } = runtime({ negotiateOutput: fault !== null });
    let closes=0, stopped=0, played=0;
    const status={textContent:""};
    helpers.state.panel={querySelector(){return status;},remove(){}};
    helpers.state.ws={readyState:1,send(){},close(){closes++;}};
    helpers.state.sources.push({stop(){stopped++;stale();}});
    helpers.state.pendingAudio.push({bytes:{byteLength:4}});
    helpers.state.playbackReceipts.control({event:"configured",playback_ack:true});
    helpers.state.playbackReceipts.control({event:"audio_segment_start",reply_id:"a".repeat(32),segment_id:"1",sample_rate:24000});
    const stale=helpers.state.playbackReceipts.chunk(2,()=>{played++;});
    // Invalid payloads fail before DataView/sample reads; no audio is processed.
    if(typeof fault === "object" && fault) helpers.handleFrame(taggedControl(fault));
    else helpers.handleFrame(Uint8Array.from(fault==="odd-EOF"?[1,0]:[1,0,0]).buffer);
    stale();
    assert.equal(closes,1); assert.equal(stopped,1); assert.equal(played,0);
    assert.equal(helpers.state.pendingAudio.length,0); assert.equal(sources.length,0);
    assert.equal(helpers.state.audioContract.ready,false);
    assert.match(status.textContent,/Unsupported audio format/);
    assert.ok(events.some(e=>e.type==="pyai:widget-error"));
  }
});

test("v13 audio contract needs hello but preserves legacy ack-disabled configured",()=>{
  const r=runtime({negotiateOutput:false});
  r.helpers.handleFrame(taggedControl({event:"ready"}));
  assert.equal(r.helpers.state.audioContract.ready,false);
  r.helpers.handleFrame(taggedControl(nativeHello));
  r.helpers.handleFrame(taggedControl({event:"configured"}));
  assert.equal(r.helpers.state.audioContract.ready,true);
  assert.equal(r.helpers.state.audioContract.pcm(4),true);
  let played=0;
  r.helpers.state.playbackReceipts.control({event:"audio_segment_start",reply_id:"b".repeat(32),segment_id:"1",sample_rate:24000});
  r.helpers.state.playbackReceipts.chunk(2,()=>{played++;})();
  assert.equal(played,0);
  r.helpers.end(); assert.equal(r.helpers.state.audioContract.ready,false);
});

function actualFunction(name) {
  const start=source.indexOf(`  function ${name}(`);
  assert.ok(start>=0);
  return source.slice(start,source.indexOf("\n  }",start)+4);
}

test("v13 audio contract preserves device48k capture conversion into native24k",()=>{
  const calls=[],input={opaque:true};
  const ctx=vm.createContext({input,downsample(...args){calls.push(args);return [];}});
  vm.runInContext(actualFunction("pcm16Frame"),ctx);
  vm.runInContext("pcm16Frame(input,48000)",ctx);
  assert.equal(calls.length,1);assert.equal(calls[0][0],input);
  assert.deepEqual(calls[0].slice(1),[48000,24000]);
});

test("v13 audio contract schedules native24k at a device48k without changing clock",()=>{
  const allocations=[];
  const ctx=vm.createContext({state:{playbackReady:true,inputContext:{sampleRate:48000,state:"running",createBuffer(...args){allocations.push(args);throw Error("before decoding");}}}});
  vm.runInContext(actualFunction("schedulePcm"),ctx);
  assert.throws(()=>vm.runInContext("schedulePcm({bytes:{byteLength:4}})",ctx),/before decoding/);
  assert.deepEqual(allocations,[[1,2,24000]]);
});

function deferredStartup() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function ownedStream() {
  const track = { stops: 0, stop() { this.stops++; } };
  return { track, getTracks() { return [track]; } };
}
const startupSession = { url: "wss://inert.invalid/stream", session_label: "test", token: "inert" };

test("End during permission stops the late stream and never constructs a socket", async () => {
  const permission = deferredStartup();
  const r = runtime({ permission: () => permission.promise });
  const startup = r.helpers.connect(startupSession); r.helpers.end();
  const stream = ownedStream(); permission.resolve(stream);
  await assert.rejects(startup, { name: "AbortError" });
  assert.equal(stream.track.stops, 1); assert.equal(r.sockets.length, 0);
  assert.equal(r.helpers.state.stream, null);
});
test("obsolete permission cannot replace a newer call or close its resources", async () => {
  const oldPermission = deferredStartup(), newPermission = deferredStartup(); let calls = 0;
  const r = runtime({ permission: () => (++calls === 1 ? oldPermission : newPermission).promise });
  const old = r.helpers.connect(startupSession); r.helpers.end();
  const next = r.helpers.connect(startupSession);
  const latest = ownedStream(); newPermission.resolve(latest); await next;
  const currentSocket = r.helpers.state.ws;
  const stale = ownedStream(); oldPermission.resolve(stale);
  await assert.rejects(old, { name: "AbortError" });
  assert.equal(stale.track.stops, 1); assert.equal(latest.track.stops, 0);
  assert.equal(r.helpers.state.stream, latest); assert.equal(r.helpers.state.ws, currentSocket);
  r.helpers.end(); assert.equal(latest.track.stops, 1);
});
test("End during AudioContext resume closes acquired resources and cancels connect", async () => {
  const stream = ownedStream();
  const r = runtime({ permission: () => Promise.resolve(stream), deferResume: true });
  const startup = r.helpers.connect(startupSession); await Promise.resolve(); r.helpers.end();
  assert.equal(stream.track.stops, 1); assert.equal(r.contexts[0].state, "closed");
  r.resolveResume(); await assert.rejects(startup, { name: "AbortError" });
  assert.equal(r.sockets.length, 0); assert.equal(r.helpers.state.inputContext, null);
});
test("resume and socket construction failure release the acquired microphone", async () => {
  for (const failure of [{ resumeError: new Error("resume failed") }, { socketError: new Error("socket failed") }]) {
    const stream = ownedStream(); const r = runtime({ permission: () => Promise.resolve(stream), ...failure });
    await assert.rejects(r.helpers.connect(startupSession));
    assert.equal(stream.track.stops, 1); assert.equal(r.contexts[0].state, "closed");
    assert.equal(r.helpers.state.stream, null);
  }
});
test("End while session fetch is pending never requests a microphone", async () => {
  const response = deferredStartup(); let microphones = 0;
  const r = runtime({ permission: () => { microphones++; return Promise.resolve(ownedStream()); }, sessionFetch: () => response.promise });
  const startup = r.helpers.startCall(); r.helpers.end();
  response.resolve({ ok: true, json: async () => startupSession });
  await assert.rejects(startup, { name: "AbortError" });
  assert.equal(microphones, 0); assert.equal(r.sockets.length, 0);
});
