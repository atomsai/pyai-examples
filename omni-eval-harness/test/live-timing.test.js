import assert from "node:assert/strict";
import { test } from "node:test";
import { audibleBounds, captureTiming, newAudioCapture, recordAudio, recordTurnBegin,
  streamPcmRealtime, waitForAgentSettle } from "../src/live-timing.js";
import { runLive, safeConfiguredMetadata } from "../src/live.js";

function virtualClock() {
  let at = 0;
  let nextId = 1;
  const timers = new Map();
  const clock = {
    now: () => at,
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.set(id, { at: at + delay, fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    sleep(ms) { return new Promise((resolve) => clock.setTimeout(resolve, ms)); },
    async complete(promise) {
      let done = false;
      let result;
      let error;
      promise.then((value) => { result = value; done = true; }, (err) => { error = err; done = true; });
      for (let ticks = 0; !done && ticks < 100000; ticks++) {
        // Finish async work at this instant before advancing to the next timer.
        for (let i = 0; i < 20; i++) await Promise.resolve();
        if (done) break;
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        assert.ok(next, "operation is waiting with no timers");
        timers.delete(next[0]);
        at = next[1].at;
        next[1].fn();
      }
      assert.ok(done, "virtual call did not complete");
      if (error) throw error;
      return result;
    },
    pending: () => timers.size,
  };
  return clock;
}

function sound(rate, ms) { return new Int16Array(Math.round(rate * ms / 1000)).fill(1200); }

function transportFixture({ plans = [{}, {}], greetingMs = 0, ack = true,
  protocolError = false, agentAsrDelayMs = 0, inputRate = 24000, outputRate = 24000 } = {}) {
  const clock = virtualClock();
  const state = { frames: [], callerStarts: [], replies: [], closed: false, closeCalls: 0, asr: [], resamplers: 0 };
  const speechMs = 400;
  class PyAI {
    audio = {
      speech: async () => {
        const pcm = new Int16Array(inputRate * 0.62); // 20ms lead + 400ms speech + 200ms tail
        pcm.set(sound(inputRate, speechMs), inputRate * 0.02);
        return pcm.buffer;
      },
      transcriptions: { create: async ({ filename }) => {
        state.asr.push({ filename, closed: state.closed, at: clock.now() });
        if (filename === "agent.wav") {
          assert.equal(state.closed, true, "agent REST ASR must run after socket close");
          await clock.sleep(agentAsrDelayMs);
          return { text: "The actual spoken reply." };
        }
        return { text: "A caller question." };
      } },
    };
  }
  class OmniClient {
    constructor(options) {
      this.options = options;
      this.speaking = false;
      clock.setTimeout(() => {
        options.onReady();
        options.onHello(`pcm16@${outputRate}`);
      }, 10);
      if (greetingMs) clock.setTimeout(() => options.onAudio(sound(outputRate, greetingMs)), 15);
      if (ack) clock.setTimeout(() => options.onEvent({ event: "configured", greeting: Boolean(greetingMs),
        tools: 0, audio_out: `pcm16@${outputRate}`, voice_id: "fixture-voice", language_active: "en" }), 50);
    }
    sendAudio(pcm) {
      assert.equal(state.closed, false, "audio sent after close");
      const nonzero = pcm.some((sample) => Math.abs(sample) > 160);
      state.frames.push({ at: clock.now(), samples: pcm.length, nonzero });
      if (nonzero && !this.speaking) {
        const index = state.callerStarts.length;
        const plan = plans[index] ?? {};
        state.callerStarts.push(clock.now());
        if (plan.cueFromStartMs != null) clock.setTimeout(() => {
          this.options.onAudio(sound(outputRate, plan.cueDurationMs ?? 120));
        }, plan.cueFromStartMs);
        for (const item of plan.callerTranscripts ?? []) clock.setTimeout(() => {
          this.options.onTranscript({ role: "user", mode: "delta", final: false, ...item });
        }, item.fromStartMs);
        if (!plan.noAudio) {
          const delay = plan.responseFromStartMs ?? speechMs + 500;
          clock.setTimeout(() => this.options.onEvent({ event: "turn_begin", turn: index + 1,
            since_caller_end_ms: 450 }), plan.turnBeginFromStartMs ?? delay - 30);
          clock.setTimeout(() => {
            state.replies.push(clock.now());
            if (protocolError) this.options.onError(new Error("Omni server control frame is missing its event key"));
            this.options.onAudio(sound(outputRate, plan.durationMs ?? 120));
            this.options.onTranscript({ role: "assistant", final: true, text: "Different intended text." });
          }, delay);
        }
      }
      this.speaking = nonzero;
    }
    sendControl() {}
    close() { state.closeCalls++; state.closed = true; this.options.onClose(); }
  }
  return {
    clock, state,
    scenario: { id: "fake-transport", persona: "Fixture", turns: plans.map(() => ({ caller_says: "A caller question." })) },
    opts: { apiKey: "fixture-not-a-real-key", mode: "voice", tools: [], omniRate: inputRate },
    runtime: { clock, dependencies: { sdk: { PyAI }, twilio: {
      OmniClient, bytesToPcm16: (bytes) => new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
      makeResampler(from, to) {
        state.resamplers++;
        return from === to ? null : { process(pcm) {
          const result = new Int16Array(Math.round(pcm.length * to / from));
          for (let i = 0; i < result.length; i++) result[i] = pcm[Math.min(pcm.length - 1, Math.floor(i * from / to))];
          return result;
        } };
      },
    } } },
  };
}

test("audible caller bounds exclude TTS lead and tail silence", () => {
  const pcm = new Int16Array(1000);
  pcm.fill(1000, 200, 600);
  assert.deepEqual(audibleBounds(pcm, 1000), { first: 200, last: 600 });
  assert.deepEqual(audibleBounds(new Int16Array(1000).fill(60), 1000), { first: null, last: null });
});

test("configured evidence allows bounded scalar metadata only", () => {
  assert.deepEqual(safeConfiguredMetadata({
    voice_id: "stock_aria_en", voice_tier: "natural", language_active: "en", tools: 0,
    kb: { token: "private", endpoint: "https://private.invalid" }, greeting: true,
    audio_out: "pcm16@24000", language: "Bearer private token", endpointing_ms: Infinity,
    unknown: "private",
  }), { voice_id: "stock_aria_en", voice_tier: "natural", language_active: "en",
    greeting: true, tools: 0, audio_out: "pcm16@24000" });
});

test("packet bursts settle after queued playout and preserve signed overlap", async () => {
  const clock = virtualClock();
  const ctx = newAudioCapture(0);
  const a = sound(1000, 2000);
  recordAudio(ctx, a, 0, 1000);
  a.fill(0); // Transport-owned memory cannot mutate evidence.
  recordAudio(ctx, sound(1000, 500), 0, 1000);
  const settled = await clock.complete(waitForAgentSettle(() => ctx, clock));
  assert.equal(settled.at, 4500);
  assert.equal(ctx.samples, 2500);
  assert.equal(ctx.pcm[0][0], 1200);
  const timing = captureTiming(ctx, { startedAt: 0, speechOnsetAt: 0, speechOffsetAt: 300, streamEndAt: 500 });
  assert.equal(timing.ttfbMs, -300);
  assert.equal(timing.agentSpeechOffsetMs, 2500);
  assert.equal(timing.packetTtfbMs, -300);
});

test("caller stream timing uses audible offset and exact short last frame", async () => {
  const clock = virtualClock();
  const frames = [];
  const pcm = new Int16Array(125);
  pcm.fill(1200, 20, 80);
  const timing = await clock.complete(streamPcmRealtime({ sendAudio: (frame) => frames.push(frame.length) }, pcm, 1000, clock));
  assert.equal(timing.speechOnsetAt, 20);
  assert.equal(timing.speechOffsetAt, 80);
  assert.equal(timing.streamEndAt, 125);
  assert.deepEqual(frames, [20, 20, 20, 20, 20, 20, 5]);
});

test("fake call drains greeting received before ack and runs ASR only after close", async () => {
  const f = transportFixture({ greetingMs: 2500, agentAsrDelayMs: 30000 });
  const run = await f.clock.complete(runLive(f.scenario, f.opts, f.runtime));
  assert.ok(f.state.callerStarts[0] >= 4515, "greeting playback and quiet must finish before caller");
  assert.equal(run.captureIntegrity.valid, true);
  assert.equal(run.turns.length, 2);
  assert.equal(run.turns[0].agentAudioMs, 120, "one packet is real audio, not zero duration");
  assert.equal(run.turns[0].ttfbMs, 500, "latency excludes 200ms of caller TTS tail silence");
  assert.equal(run.turns[0].agentText, "The actual spoken reply.");
  assert.equal(run.turns[0].engineAssistantText, "Different intended text.");
  assert.deepEqual(run.availableTools, []);
  assert.ok(f.state.callerStarts[1] - f.state.callerStarts[0] < 4000, "slow REST ASR must not add an in-call gap");
  const replyAt = f.state.replies[0];
  assert.ok(f.state.frames.some((frame) => !frame.nonzero && frame.at > replyAt + 60), "silence continues after first response audio");
  assert.equal(f.state.closeCalls, 1);
  assert.equal(f.clock.pending(), 0, "timeout timers are cleared after success");
});

test("genuine agent overlap stays negative and is not rewritten to missing TTFB", async () => {
  const f = transportFixture({ plans: [{ responseFromStartMs: 200, durationMs: 500 }] });
  const run = await f.clock.complete(runLive(f.scenario, f.opts, f.runtime));
  assert.equal(run.turns[0].ttfbMs, -200);
  assert.equal(run.turns[0].timing.packetTtfbMs, -200);
  assert.equal(run.captureIntegrity.valid, true, "overlap is observed behavior, not corrupt capture");
});

test("recorded baseline cue timings cannot complete a pending real reply", async () => {
  for (const witness of [
    { name: "empty", cueAt: 5672, cueMs: 640, beginAt: 6496, replyAt: 8641, callerEnd: 5714, waitAt: 5735 },
    { name: "support", cueAt: 6154, cueMs: 400, beginAt: 7955, replyAt: 9482, callerEnd: 7553, waitAt: 7612 },
  ]) {
    const clock = virtualClock();
    const ctx = newAudioCapture(0);
    clock.setTimeout(() => recordAudio(ctx, sound(1000, witness.cueMs), clock.now(), 1000), witness.cueAt);
    clock.setTimeout(() => recordTurnBegin(ctx, clock.now(), 1), witness.beginAt);
    clock.setTimeout(() => recordAudio(ctx, sound(1000, 1000), clock.now(), 1000), witness.replyAt);
    const result = await clock.complete((async () => {
      await clock.sleep(witness.waitAt);
      return waitForAgentSettle(() => ctx, clock, { requireTurnBegin: true });
    })());
    assert.equal(result.reason, "settled");
    assert.ok(result.at >= witness.replyAt + 3000, `${witness.name}: full reply + quiet must precede next caller`);
    assert.equal(ctx.samples, witness.cueMs + 1000, "retain every cue and reply sample");
    const timing = captureTiming(ctx, { speechOffsetAt: witness.callerEnd });
    assert.equal(timing.anyAudioTtfbMs, witness.cueAt - witness.callerEnd);
    assert.equal(timing.postTurnBeginTtfbMs, witness.replyAt - witness.callerEnd);
  }
});

test("latest turn begin supersedes earlier response evidence while advisory extends quiet without pretending to be audio", async () => {
  const clock = virtualClock();
  const ctx = newAudioCapture(0);
  clock.setTimeout(() => recordTurnBegin(ctx, clock.now(), 1), 100);
  clock.setTimeout(() => recordAudio(ctx, sound(1000, 120), clock.now(), 1000), 200);
  clock.setTimeout(() => recordTurnBegin(ctx, clock.now(), 2), 1000);
  clock.setTimeout(() => recordAudio(ctx, sound(1000, 120), clock.now(), 1000), 4000);
  // A valid synthesis advisory can arrive after the final PCM packet. It
  // extends the observation window; requiring a subsequent packet is wrong.
  clock.setTimeout(() => { ctx.lastAssistantTranscriptAt = clock.now(); }, 5000);
  const settled = await clock.complete(waitForAgentSettle(() => ctx, clock, { requireTurnBegin: true }));
  assert.equal(settled.at, 7000);
  assert.equal(ctx.postTurnBeginFirstAudioAt, 4000);
  assert.equal(ctx.samples, 240);
});

test("cue-only output times out instead of certifying response completion", async () => {
  const clock = virtualClock();
  const ctx = newAudioCapture(0);
  recordAudio(ctx, sound(1000, 400), 0, 1000);
  clock.setTimeout(() => recordTurnBegin(ctx, clock.now(), 1), 1000);
  const settled = await clock.complete(waitForAgentSettle(() => ctx, clock, { requireTurnBegin: true, timeoutMs: 5000 }));
  assert.equal(settled.reason, "timeout");
  assert.equal(ctx.samples, 400);
  assert.equal(ctx.postTurnBeginFirstAudioAt, null);
});

test("fake transport retains pre-turn cues, waits for real response and records engine caller deltas separately from Hear", async () => {
  const f = transportFixture({ plans: [{ cueFromStartMs: 300, turnBeginFromStartMs: 800,
    responseFromStartMs: 2600, callerTranscripts: [
      { fromStartMs: 150, text: "The order is five" },
      { fromStartMs: 250, text: " one three." },
    ] }, {}] });
  const run = await f.clock.complete(runLive(f.scenario, f.opts, f.runtime));
  assert.equal(run.captureIntegrity.valid, true);
  assert.equal(run.turns[0].agentAudioMs, 240, "cue PCM is retained alongside reply PCM");
  assert.ok(f.state.callerStarts[1] >= f.state.replies[0] + 2120);
  assert.equal(run.turns[0].anyAudioTtfbMs, -100);
  assert.equal(run.turns[0].postTurnBeginTtfbMs, 2200);
  assert.equal(run.turns[0].engineCallerText, "The order is five one three.");
  assert.equal(run.turns[0].asrHypothesis, "A caller question.");
  assert.equal(run.engineCallerTranscriptEvents.length, 2);
  assert.deepEqual(run.engineCallerTranscriptEvents.map(event => event.mode), ["delta", "delta"]);
  assert.ok(run.engineCallerTranscriptEvents.every(event => Number.isFinite(event.atMs) && event.clientTurnIndex === 0 && event.final === false));
  assert.ok(run.turns[0].engineAssistantTranscriptEvents[0].atMs > run.turns[0].turnBegins[0].atMs);
  assert.match(run.captureMethod.completionLimitation, /No server reply-end marker/);
});

test("protocol errors invalidate capture instead of disappearing from results", async () => {
  const f = transportFixture({ plans: [{}], protocolError: true });
  const run = await f.clock.complete(runLive(f.scenario, f.opts, f.runtime));
  assert.equal(run.captureIntegrity.valid, false);
  assert.ok(run.captureIntegrity.issues.some((issue) => issue.code === "protocol_frame_error"));
  assert.equal(f.state.closeCalls, 1);
});

test("missing response invalidates capture and prevents ambiguous next-turn capture", async () => {
  const f = transportFixture({ plans: [{ noAudio: true }, {}] });
  const run = await f.clock.complete(runLive(f.scenario, f.opts, f.runtime));
  assert.equal(run.captureIntegrity.valid, false);
  assert.equal(run.turns.length, 1);
  assert.equal(f.state.callerStarts.length, 1);
  assert.ok(run.captureIntegrity.issues.some((issue) => issue.code === "turn_timeout"));
  assert.ok(run.captureIntegrity.issues.some((issue) => issue.code === "incomplete_turn_capture"));
  assert.equal(f.state.closeCalls, 1);
});

test("configure timeout closes transport and cancels deadline timers", async () => {
  const f = transportFixture({ plans: [{}], ack: false });
  await assert.rejects(f.clock.complete(runLive(f.scenario, f.opts, f.runtime)), /configured ack timed out/);
  assert.equal(f.state.closeCalls, 1);
  assert.equal(f.state.callerStarts.length, 0);
  assert.equal(f.clock.pending(), 0);
});

test("negotiated 24k output is measured independently of 16k input", async () => {
  const f = transportFixture({ plans: [{}], inputRate: 16000, outputRate: 24000 });
  const run = await f.clock.complete(runLive(f.scenario, f.opts, f.runtime));
  assert.equal(run.turns[0].agentAudioMs, 120);
  assert.equal(run.captureMethod.inputRate, 16000);
  assert.equal(run.captureMethod.outputRate, 24000);
  assert.equal(run.captureIntegrity.valid, true);
});
