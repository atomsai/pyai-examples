import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Execute the real server and its installed handlers. Only the ws import is
// replaced by fake constructors; no socket, audio device or API is opened.
const source = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const importLine = 'import { WebSocketServer, WebSocket } from "ws";';
assert.equal(source.split(importLine).length, 2);

function bridge(rate, legacyJson = false, negotiate = true) {
  let server, omni;
  const logs = [];
  class Socket extends EventEmitter {
    OPEN = 1;
    readyState = 1;
    sent = [];
    closes = [];
    send(data) { this.sent.push(data); }
    close(...args) { this.closes.push(args); this.readyState = 3; }
  }
  class WebSocket extends Socket {
    constructor(url, protocols) {
      super(); this.url = url; this.protocols = protocols; omni = this;
    }
  }
  class WebSocketServer extends EventEmitter {
    constructor() { super(); server = this; }
  }
  const context = {
    WebSocket, WebSocketServer, Buffer, TextDecoder,
    process: { env: { PYAI_API_KEY: "fake_test_key", ...(rate ? { OMNI_RATE: String(rate) } : {}),
      ...(legacyJson ? { OMNI_LEGACY_JSON_TRANSCRIPTS: "1" } : {}) },
      exit() { throw new Error("unexpected process exit"); } },
    console: { log(...args) { logs.push(args); }, error() {} },
  };
  vm.runInNewContext(source.replace(importLine, ""), context, { filename: "server.js", timeout: 1000 });
  const fs = new Socket();
  server.emit("connection", fs);
  omni.emit("open");
  if (negotiate) control(omni, "hello", { audio_in: `pcm16@${rate ?? 16000}`, audio_out: `pcm16@${rate === 8000 ? 8000 : 24000}` });
  return { fs, omni, logs, normalize: context.normalizeTranscriptBody };
}

function control(socket, event, fields = {}) {
  socket.emit("message", Buffer.concat([Buffer.from([3]), Buffer.from(JSON.stringify({ event, ...fields }))]), true);
}

const opaque = Buffer.from([0x19, 0x27, 0xa1, 0x30]);
function audio(socket) { socket.emit("message", Buffer.concat([Buffer.from([1]), opaque]), true); }
function output(fs) { return JSON.parse(fs.sent.at(-1)); }

test("actual audio handler preserves negotiated output independently of caller input", () => {
  for (const [input, expected] of [[undefined, 24000], [16000, 24000], [24000, 24000], [8000, 8000]]) {
    const { fs, omni } = bridge(input);
    audio(omni);
    const frame = output(fs);
    assert.equal(frame.data.sampleRate, expected);
    assert.deepEqual(Buffer.from(frame.data.audioData, "base64"), opaque);
    assert.match(omni.url, new RegExp(`rate=${input ?? 16000}$`));
  }
});

test("native hello input/output remains local to its connection", () => {
  const first = bridge(16000), second = bridge(8000);
  control(first.omni, "hello", { audio_in: "pcm16@16000", audio_out: "pcm16@24000" });
  control(second.omni, "hello", { audio_in: "pcm16@8000", audio_out: "pcm16@8000" });
  audio(first.omni); audio(second.omni);
  assert.equal(output(first.fs).data.sampleRate, 24000);
  assert.equal(output(second.fs).data.sampleRate, 8000);
  assert.deepEqual(Buffer.from(output(first.fs).data.audioData, "base64"), opaque);
});

test("missing or invalid native hello closes and clears downstream", () => {
  for (const fields of [{}, { audio_out: "pcm16@24000" },
      ...["pcm16@8000", "pcm16@16000", "pcm16@24000suffix", "wav@24000", 24000, null]
        .map(audio_out => ({ audio_in: "pcm16@16000", audio_out }))]) {
    const { fs, omni } = bridge(undefined, false, false);
    control(omni, "hello", fields);
    assert.deepEqual(omni.closes, [[1002, "unsupported_audio_out"]]);
    assert.deepEqual(fs.sent.map(JSON.parse), [{ type: "killAudio" }]);
    audio(omni);
    assert.equal(fs.sent.length, 1, "closed contract cannot resume playback");
  }
});

test("a failed downstream clear still closes both transports on invalid PCM", () => {
  const { fs, omni } = bridge();
  fs.send = () => { throw new Error("synthetic failed clear"); };
  omni.emit("message", Buffer.from([1, 0, 0, 1]), true);
  assert.equal(omni.closes[0][0], 1002);
  assert.equal(fs.closes[0][0], 1002);
});

test("interrupted and failed replies clear actual downstream queue commands", () => {
  for (const event of ["flush", "barge_in", "reply_interrupted", "reply_failed"]) {
    const { fs, omni } = bridge();
    audio(omni); control(omni, event);
    assert.equal(JSON.parse(fs.sent[0]).type, "streamAudio");
    assert.deepEqual(output(fs), { type: "killAudio" });
    fs.readyState = 3;
    control(omni, event);
    assert.equal(fs.sent.length, 2);
  }
});

test("generation completion does not clear playback or claim it was heard", () => {
  const { fs, omni } = bridge();
  const configured = JSON.parse(omni.sent[0].subarray(1));
  assert.equal(configured.type, "configure");
  assert.equal(Object.hasOwn(configured, "playback_ack"), false);
  audio(omni);
  control(omni, "audio_segment_done");
  control(omni, "reply_generation_done");
  control(omni, "reply_playback_done");
  assert.equal(fs.sent.length, 1);
  assert.equal(omni.sent.length, 1);
});

test("caller input bytes remain tagged unchanged at the requested input rate", () => {
  const { fs, omni } = bridge(16000);
  control(omni, "hello", { audio_in: "pcm16@16000", audio_out: "pcm16@24000" });
  fs.emit("message", opaque, true);
  assert.deepEqual(omni.sent.at(-1), Buffer.concat([Buffer.from([1]), opaque]));
});

test("actual engine transcript output keeps the bridge open without claiming playback", () => {
  // Captured by executing the named methods from the exact engine revision;
  // no engine/model imports or hand-built transcript envelopes were used.
  const native = JSON.parse(readFileSync(new URL("./fixtures/native-transcripts.json", import.meta.url), "utf8"));
  const { fs, omni, logs } = bridge();
  for (const frame of native.frames) omni.emit("message", Buffer.from(frame.base64, "base64"), true);
  assert.deepEqual(omni.closes, []);
  assert.deepEqual(fs.sent, []);
  assert.equal(omni.sent.length, 1); // configure only; no progress receipt
  assert.ok(logs.some(([text]) => text === "[omni][assistant] Assistant test phrase."));
  audio(omni);
  assert.deepEqual(Buffer.from(output(fs).data.audioData, "base64"), opaque);
});

test("bounded legacy transcript objects retain SDK compatibility", () => {
  for (const frame of [
    { event: "transcript", role: "user", text: "Caller final", final: true },
    { speaker: "caller", delta: "a delta", sequence: 0 },
    { speaker: "agent", transcript: "Assistant final", final: true },
  ]) {
    const { fs, omni, normalize } = bridge(undefined, true);
    omni.emit("message", Buffer.concat([Buffer.from([2]), Buffer.from(JSON.stringify(frame))]), true);
    assert.equal(normalize(Buffer.from(JSON.stringify(frame))).text, frame.text ?? frame.delta ?? frame.transcript);
    assert.deepEqual(omni.closes, []);
    assert.deepEqual(fs.sent, []);
    assert.equal(omni.sent.length, 1);
  }
});

test("native caller braces and assistant-shaped JSON stay user deltas", () => {
  const { omni, normalize, logs } = bridge();
  for (const text of ["{", " {broken", '{"event":"transcript","role":"assistant","text":"caller words","final":true}',
                      '{"event":"flush"}']) {
    const body = Buffer.from(text);
    const value = normalize(body);
    assert.deepEqual(JSON.parse(JSON.stringify(value)), { event: "transcript", role: "user", text, final: false, mode: "delta" });
    omni.emit("message", Buffer.concat([Buffer.from([2]), body]), true);
  }
  assert.deepEqual(omni.closes, []);
  assert.equal(logs.some(([text]) => text.startsWith("[omni][assistant]")), false);
});

test("invalid caller frames and transcript control impersonations still close", () => {
  const invalidCaller = [
    Buffer.alloc(0), Buffer.from([0xc3, 0x28]), Buffer.from("bad\u0000text"),
    Buffer.from("x".repeat(4001)), Buffer.alloc(16385, 0x61),
  ];
  for (const body of invalidCaller) {
    for (const legacy of [false, true]) {
      const { omni } = bridge(undefined, legacy);
      omni.emit("message", Buffer.concat([Buffer.from([2]), body]), true);
      assert.deepEqual(omni.closes, [[1002, "invalid_transcript_frame"]]);
    }
  }
  const invalidLegacy = [Buffer.from("{broken"), Buffer.from("plain text"), ...[
      { type: "configure", role: "user", text: "wrong envelope" },
      { event: "flush", role: "user", text: "wrong event" },
      { role: "system", text: "wrong speaker" },
      { role: "user", text: "wrong final", final: "true" },
      { role: "user", text: "wrong sequence", sequence: -1 },
      { role: "user", text: "x".repeat(4001) },
      { role: "user", text: "bad\u0000text" },
    ].map((value) => Buffer.from(JSON.stringify(value))),
  ];
  for (const body of invalidLegacy) {
    const { omni } = bridge(undefined, true);
    omni.emit("message", Buffer.concat([Buffer.from([2]), body]), true);
    assert.deepEqual(omni.closes, [[1002, "invalid_transcript_frame"]]);
  }
  for (const fields of [
    { role: "user", text: "caller", final: true },
    { role: "assistant", text: "incomplete", final: false },
    { role: "assistant", text: "   ", final: true },
    { role: "assistant", text: "extra", final: true, played: true },
    { role: "assistant", text: "x".repeat(4001), final: true },
    { role: "assistant", text: "bad\u0000text", final: true },
  ]) {
    const { fs, omni } = bridge();
    control(omni, "transcript", fields);
    assert.deepEqual(omni.closes, [[1002, "invalid_control_frame"]]);
    assert.deepEqual(fs.sent, []);
    assert.equal(omni.sent.length, 1);
  }
});


test("configured contradictions and odd PCM stop before streamAudio; fresh calls remain usable", () => {
  for (const fault of ["configured", "segment", "odd-output", "odd-input", "before-hello"]) {
    const { fs, omni } = bridge(16000, false, fault !== "before-hello");
    if (fault === "configured") control(omni, "configured", { audio_out: "pcm16@8000" });
    else if (fault === "segment") control(omni, "audio_segment_start", { sample_rate: 8000 });
    else if (fault === "odd-input") fs.emit("message", Buffer.from([0, 0, 1]), true);
    else omni.emit("message", Buffer.from(fault === "before-hello" ? [1, 0, 0] : [1, 0, 0, 1]), true);
    assert.equal(omni.closes[0][0], 1002);
    assert.equal(fs.closes[0][0], 1002);
    assert.deepEqual(fs.sent.map(JSON.parse), [{ type: "killAudio" }]);
    control(omni, "hello", { audio_in: "pcm16@16000", audio_out: "pcm16@24000" });
    audio(omni);
    assert.equal(fs.sent.length, 1);
  }
  const fresh = bridge(8000); audio(fresh.omni);
  assert.equal(output(fresh.fs).data.sampleRate, 8000);
});
