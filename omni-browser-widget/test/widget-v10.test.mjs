import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  AGENT_AUDIO_END_GRACE_MS,
  AGENT_BARGE_ARM_DELAY_MS,
  STARTUP_AUDIO_WAIT_MS,
  beginStartupAudioPhase,
  completeStartupAudioPhase,
  shouldZeroCallerSamples,
} from "../../../marketing/src/lib/eva-audio-policy.mjs";

const source = readFileSync(
  new URL("../public/v10/pyai-widget.js", import.meta.url),
  "utf8",
);
const historicalV8 = readFileSync(
  new URL("../public/v8/pyai-widget.js", import.meta.url),
  "utf8",
);

function runtime({ deferResume = false } = {}) {
  const events = [];
  const timers = new Map();
  const sources = [];
  const processors = [];
  const contexts = [];
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
  vm.runInNewContext(source, context, { filename: "pyai-widget-v10.js" });
  return {
    helpers: window.__PYAI_WIDGET_TEST__.helpers,
    events,
    sources,
    processors,
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

test("v10 matches the canonical protected-opening state machine", () => {
  const { helpers } = runtime();
  assert.match(source, /VERSION = "10\.0\.0"/);
  assert.match(source, /OPENING_AUDIO_POLICY_VERSION = "omni-opening-v1"/);
  assert.equal(helpers.startupAudioWaitMs, STARTUP_AUDIO_WAIT_MS);
  assert.equal(helpers.agentBargeArmDelayMs, AGENT_BARGE_ARM_DELAY_MS);
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

  const cases = [
    [{ startupAudioPhase: "waiting", connectedAt: 0, responseAudioActive: false, agentPlayStartedAt: 0 }, 3999],
    [{ startupAudioPhase: "waiting", connectedAt: 0, responseAudioActive: false, agentPlayStartedAt: 0 }, 4000],
    [{ startupAudioPhase: "playing", connectedAt: 0, responseAudioActive: true, agentPlayStartedAt: 1000 }, 9000],
    [{ startupAudioPhase: "complete", connectedAt: 0, responseAudioActive: true, agentPlayStartedAt: 1000 }, 1200],
    [{ startupAudioPhase: "complete", connectedAt: 0, responseAudioActive: true, agentPlayStartedAt: 1000 }, 1350],
  ];
  for (const [state, now] of cases) {
    assert.equal(
      helpers.shouldZeroCallerSamples(state, now),
      shouldZeroCallerSamples(state, now),
    );
  }

  assert.match(historicalV8, /heardAgent/);
  assert.doesNotMatch(historicalV8, /startupAudioPhase/);
});

test("v10 buffers every early PCM frame until playback is ready", async () => {
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

test("v10 protects the full opening drain and then preserves later barge-in", async () => {
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

test("v10 startup flush clears playback and fail-opens microphone capture", async () => {
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

test("v10 closes browser protocol violations with one private-use code", () => {
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

test("v10 keeps the v9 public security and lifecycle boundaries", () => {
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
