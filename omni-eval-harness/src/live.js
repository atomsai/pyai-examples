// LIVE runner, drives a real PyAI Omni session as a synthetic caller and
// captures a RunResult the scorers can grade. This path is DORMANT by default
// (run.js only loads it under `--live` with a key present).
//
// It REUSES the repo's own packages instead of re-implementing audio/transport:
//   @pyai/twilio  -> OmniClient (the Omni WS client + event demux), the
//                    anti-aliased resampler, and PCM16<->bytes helpers.
//   @pyai/sdk     -> Speak (TTS) to synthesize the caller, and Hear (REST) to
//                    transcribe caller audio (WER) and agent audio (reply text).
//
// Omni 0x02 frames are caller-text deltas only. Agent reply text is the Hear
// transcript of captured 0x01 PCM, not an assistant 0x02 event.
//
// Omni has no end-of-input control: after the caller utterance we keep sending
// realtime silence until the agent has spoken and settled.

import { writeCallTimelineWav } from "./call-audio.js";
import { newInterruptionCapture, prepareInterruptionCaller } from "./interruption-capture.js";
import {
  captureTiming, newAudioCapture, recordAudio, recordTurnBegin, REALTIME_GAP_LIMIT_MS,
  streamPcmRealtime, streamSilenceWhile, waitForAgentSettle, withTimeout,
} from "./live-timing.js";

const GREETING_DRAIN_MS = 15000;
const CONNECT_TIMEOUT_MS = 10000;
const CONFIGURED_TIMEOUT_MS = 5000;
const HEAR_RATE = 16000;
const realClock = {
  now: () => Number(process.hrtime.bigint() / 1000n) / 1000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

async function loadDeps() {
  let twilio;
  let sdk;
  try {
    twilio = await import("@pyai/twilio");
  } catch (err) {
    throw buildHint("@pyai/twilio", "sdk/twilio", err);
  }
  try {
    sdk = await import("@pyai/sdk");
  } catch (err) {
    throw buildHint("@pyai/sdk", "sdk/typescript", err);
  }
  return { twilio, sdk };
}

function buildHint(pkg, dir, err) {
  return new Error(
    `live mode needs ${pkg}, which is consumed from its build output. ` +
      `Build it once:\n  (cd ../../${dir} && npm install && npm run build)\n` +
      `then re-run with --live. Original error: ${err.message}`,
  );
}

export function safeConfiguredMetadata(ack) {
  const result = {};
  const fields = {
    voice_id: (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value),
    voice_tier: (value) => typeof value === "string" && /^[a-z_]{1,32}$/.test(value),
    language: (value) => typeof value === "string" && /^[a-z-]{2,12}$/.test(value),
    language_active: (value) => typeof value === "string" && /^[a-z-]{2,12}$/.test(value),
    language_fallback: (value) => typeof value === "boolean",
    greeting: (value) => typeof value === "boolean",
    kb: (value) => typeof value === "boolean",
    tools: (value) => Number.isSafeInteger(value) && value >= 0,
    endpointing_ms: (value) => Number.isFinite(value) && value >= 0,
    audio_out: (value) => typeof value === "string" && /^pcm16@(8000|24000)$/.test(value),
  };
  for (const [key, accepts] of Object.entries(fields)) {
    if (accepts(ack?.[key])) result[key] = ack[key];
  }
  return result;
}

/** PCM16 LE mono WAV, for Hear REST. */
export function pcm16ToWav(pcm, sampleRate) {
  const n = pcm.length;
  const dataSize = n * 2;
  const out = new Uint8Array(44 + dataSize);
  const dv = new DataView(out.buffer);
  const ascii = (off, s) => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  dv.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  ascii(36, "data");
  dv.setUint32(40, dataSize, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, pcm[i], true);
  return out;
}

export function concatPcm(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Int16Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Enable engine tools the scenario actually asserts on. */
export function toolsForScenario(scenario) {
  if (Array.isArray(scenario.tools) && scenario.tools.length) return scenario.tools;
  const names = new Set();
  for (const turn of scenario.turns || []) {
    for (const assertion of turn.expect || []) {
      if (
        (assertion.type === "tool_called" || assertion.type === "tool_not_called")
        && typeof assertion.name === "string"
        && assertion.name === "transfer_to_human"
      ) {
        names.add(assertion.name);
      }
    }
  }
  return [...names].map((name) => ({
    name,
    description: "Warm-transfer the caller to a human agent.",
  }));
}

export function kbFromQueryEvent(evt) {
  if (!evt || evt.event !== "kb_query") return null;
  if (evt.none === true) {
    const reason = typeof evt.reason === "string" ? evt.reason : "empty";
    return reason === "no_kb" ? "empty" : reason;
  }
  const ids = Array.isArray(evt.top_ids) ? evt.top_ids : [];
  return ids.some((id) => String(id || "").trim()) ? "hit" : "empty";
}

/**
 * Run a scenario live against Omni. Returns a normalized RunResult.
 * @param {object} scenario validated scenario
 * @param {object} opts { apiKey, sessionLabel, mode, voice, baseURL, omniRate, tools, callerKey, captureAudioPath }
 */
export async function runLive(scenario, opts, runtime = {}) {
  // The explicit dependency seam keeps transport/timing regression tests offline.
  const { twilio, sdk } = runtime.dependencies ?? await loadDeps();
  const clock = runtime.clock ?? realClock;
  const { OmniClient, makeResampler } = twilio;
  const PyAI = sdk.PyAI ?? sdk.default;
  const omniRate = opts.omniRate ?? 24000;
  const mode = opts.mode === "text" ? "text" : "voice";
  // Dormant profile used only by the standalone interruption pack. Ordinary
  // callers retain the existing capture rules and whole-utterance synthesis.
  const interruption = runtime.interruptionCapture === true ? newInterruptionCapture(omniRate) : null;
  if (interruption && (mode !== "voice" || scenario.turns.length !== 1)) {
    throw new Error("Interruption capture requires one voice utterance per call");
  }
  if (opts.captureAudioPath && mode !== "voice") {
    throw new Error("call audio capture requires live voice mode");
  }
  const pyai = new PyAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  const tools = opts.tools ?? toolsForScenario(scenario);
  const issues = [];
  const addIssue = (code, turnIndex = null, severity = "error") => {
    if (!issues.some((i) => i.code === code && i.turnIndex === turnIndex)) {
      issues.push({ code, turnIndex, severity });
    }
  };

  // All caller synthesis and WER transcription happens BEFORE connecting.
  const prepared = [];
  for (let index = 0; index < scenario.turns.length; index++) {
    const callerText = scenario.turns[index].caller_says;
    let callerPcm = null;
    let callerAudioMs = null;
    let asrHypothesis = null;
    let callerAudioPlan;
    if (mode === "voice") {
      if (interruption) {
        const plan = await prepareInterruptionCaller(scenario.turns[index].caller_segments, omniRate, async (text) => {
          const buf = await pyai.audio.speech({ input: text, voice: opts.voice,
            response_format: "pcm", sample_rate: omniRate });
          return twilio.bytesToPcm16(new Uint8Array(buf));
        });
        callerPcm = plan.pcm;
        callerAudioPlan = { layout: plan.layout, pcmSha256: plan.pcmSha256 };
      } else if (isNonSpeechCaller(callerText)) {
        callerPcm = quietStaticPcm(omniRate, 1200);
      } else {
        const buf = await pyai.audio.speech({
          input: callerText, voice: opts.voice,
          response_format: "pcm", sample_rate: omniRate,
        });
        callerPcm = twilio.bytesToPcm16(new Uint8Array(buf));
      }
      callerAudioMs = Math.round((callerPcm.length / omniRate) * 1000);
      // Resamplers carry filter state; each separate utterance needs a fresh one.
      const toHear = makeResampler(omniRate, HEAR_RATE);
      const forHear = toHear ? toHear.process(callerPcm) : callerPcm;
      try {
        asrHypothesis = await transcribePcm(pyai, forHear, HEAR_RATE, "caller.wav");
      } catch {
        addIssue("caller_transcription_failed", index);
      }
      if (!isNonSpeechCaller(callerText) && !asrHypothesis) {
        addIssue("caller_transcription_missing", index);
      }
    }
    prepared.push({ callerText, callerPcm, callerAudioMs, asrHypothesis,
      ...(callerAudioPlan ? { callerAudioPlan } : {}) });
  }

  const sessionStartedAt = clock.now();
  let turnIndex = null;
  let turnCtx = newAudioCapture(sessionStartedAt);
  const openingCtx = turnCtx;
  const timeline = { caller: [], agent: [] };
  const engineCallerTranscriptEvents = [];
  let outputRate = omniRate === 8000 ? 8000 : 24000;
  let rateConfirmed = false;
  let callId = null;
  let closed = false;
  let closing = false;
  let keepSilence = false;
  let silencer = null;
  let lastInputFrameEnd = null;
  let maxInputGapMs = 0;
  let resolveReady;
  let resolveConfigured;
  let resolveClosed;
  let configuredEvents = 0;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const configured = new Promise((resolve) => { resolveConfigured = resolve; });
  const closeComplete = new Promise((resolve) => { resolveClosed = resolve; });
  const configuredEventsNeeded = opts.callerKey ? 2 : 1;

  function acceptOutputRate(value) {
    if (typeof value !== "string") return;
    const match = /^pcm16@(8000|24000)$/.exec(value);
    if (!match) { addIssue("unsupported_output_format", turnIndex); return; }
    const rate = Number(match[1]);
    if (rate !== outputRate && timeline.agent.length) addIssue("output_rate_changed", turnIndex);
    outputRate = rate;
    rateConfirmed = true;
  }
  function observeInputFrame(pcm, at) {
    if (lastInputFrameEnd != null) {
      const gap = at - lastInputFrameEnd;
      maxInputGapMs = Math.max(maxInputGapMs, gap);
      if (gap > REALTIME_GAP_LIMIT_MS) addIssue("realtime_input_gap", turnIndex);
    }
    lastInputFrameEnd = at + (pcm.length / omniRate) * 1000;
  }
  function startSilence() {
    keepSilence = true;
    silencer = streamSilenceWhile(omni, omniRate, () => keepSilence && !closed, clock, observeInputFrame);
  }
  async function stopSilence() {
    keepSilence = false;
    await silencer;
    silencer = null;
  }

  const omni = new OmniClient({
    apiKey: opts.apiKey, sessionLabel: opts.sessionLabel, baseURL: opts.baseURL,
    rate: omniRate, voice: opts.voice, persona: scenario.persona, tools,
    onReady: () => {
      if (opts.callerKey) omni.sendControl({ type: "configure", caller_key: opts.callerKey });
      resolveReady();
    },
    onHello: (audioOut) => acceptOutputRate(audioOut),
    onAudio: (pcm) => {
      const at = clock.now();
      const chunk = recordAudio(turnCtx, pcm, at, outputRate);
      if (chunk) {
        timeline.agent.push({ atMs: chunk.playbackAt - sessionStartedAt, pcm: chunk.pcm });
        interruption?.agentPacket(chunk.pcm, at - sessionStartedAt,
          chunk.playbackAt - sessionStartedAt, outputRate, turnIndex);
      }
    },
    onTranscript: (tr) => {
      // Engine text is useful telemetry, but only Hear of captured PCM is the
      // speech actually graded. Do not substitute intended text for spoken audio.
      if (tr.final && tr.role === "assistant" && tr.text) {
        const at = clock.now();
        turnCtx.lastAssistantTranscriptAt = at;
        (turnCtx.assistantText ??= []).push(tr.text);
        turnCtx.assistantTranscriptEvents.push({ atMs: Math.round(at - sessionStartedAt),
          text: tr.text, final: true, mode: tr.mode ?? "replace" });
      }
      if (tr.role === "user" && typeof tr.text === "string" && tr.text) {
        // These are the serving engine's observed caller deltas, not the
        // standalone Hear hypothesis prepared before this call. Keep raw
        // timing/mode so late pieces and replacements remain inspectable.
        const event = { atMs: Math.round(clock.now() - sessionStartedAt),
          clientTurnIndex: turnIndex, text: tr.text, final: tr.final === true,
          mode: tr.mode === "replace" ? "replace" : "delta",
          ...(Number.isSafeInteger(tr.sequence) ? { sequence: tr.sequence } : {}) };
        engineCallerTranscriptEvents.push(event);
        turnCtx.callerTranscriptEvents.push(event);
      }
    },
    onTransfer: (evt) => {
      turnCtx.tools.push({ name: "transfer_to_human", args: evt ?? null });
    },
    onEvent: (evt) => {
      const event = typeof evt.event === "string" ? evt.event : "";
      if (!callId && typeof evt.call_id === "string") callId = evt.call_id;
      if (event === "hello") acceptOutputRate(evt.audio_out);
      if (event === "configured") {
        acceptOutputRate(evt.audio_out);
        configuredEvents += 1;
        if (configuredEvents >= configuredEventsNeeded) resolveConfigured(evt);
      }
      if (event === "tool_call") {
        const name = evt.name ?? evt.tool ?? evt.function?.name;
        if (name) turnCtx.tools.push({ name, callId: evt.call_id ?? null,
          args: evt.arguments ?? evt.args ?? null });
      }
      if (event === "kb_query") turnCtx.kb = kbFromQueryEvent(evt);
      if (event === "turn_begin") {
        const at = clock.now();
        recordTurnBegin(turnCtx, at, evt.turn, sessionStartedAt);
        if (turnCtx.eouMs == null && typeof evt.since_caller_end_ms === "number") {
          turnCtx.eouMs = evt.since_caller_end_ms;
        }
      }
      if (["idle_prompt", "flush", "barge_in", "end_call", "session_end"].includes(event)) {
        turnCtx.events.push({ event, atMs: Math.round(clock.now() - sessionStartedAt) });
      }
      if (event === "error") addIssue("server_error_event", turnIndex);
    },
    onError: (err) => {
      const message = err?.message ?? String(err);
      // Stable, credential-free flags; malformed frames are never suppressed.
      addIssue(/frame|transcript|event key/i.test(message) ? "protocol_frame_error" : "transport_error", turnIndex);
    },
    onClose: () => {
      closed = true;
      resolveClosed();
      if (!closing) addIssue("unexpected_session_close", turnIndex);
    },
  });

  const captures = [];
  let configuredAck;
  try {
    await withTimeout(ready, CONNECT_TIMEOUT_MS, "Omni connect timed out", clock);
    startSilence(); // Keep real-time input alive during configure AND the opening.
    configuredAck = await withTimeout(configured, CONFIGURED_TIMEOUT_MS, "Omni configured ack timed out", clock);
    if (!rateConfirmed) addIssue("output_rate_unconfirmed");
    if (configuredAck.language_fallback === true) addIssue("configured_language_fallback");
    if (typeof configuredAck.tools === "number" && configuredAck.tools !== tools.length) {
      addIssue("configured_tools_mismatch");
    }
    // Keep the context created BEFORE configure: greeting chunks may precede
    // its ack. Wait for audible playback to finish, not merely packet quiet.
    const opening = await waitForAgentSettle(() => openingCtx, clock, {
      allowEmpty: configuredAck.greeting === false,
      timeoutMs: GREETING_DRAIN_MS,
      isClosed: () => closed,
    });
    if (!["settled", "empty"].includes(opening.reason)) {
      addIssue(`greeting_${opening.reason}`);
    } else {
      await stopSilence();
      for (let i = 0; i < prepared.length && !closed; i++) {
        turnIndex = i;
        turnCtx = newAudioCapture(clock.now());
        const preparedTurn = prepared[i];
        let caller;
        if (mode === "voice" && preparedTurn.callerPcm) {
          caller = await streamPcmRealtime(omni, preparedTurn.callerPcm, omniRate, clock, (pcm, at) => {
            observeInputFrame(pcm, at);
            timeline.caller.push({ atMs: at - sessionStartedAt, pcm: pcm.slice() });
            interruption?.callerFrame(pcm, at - sessionStartedAt, i);
          });
          if (caller.maxFrameGapMs > REALTIME_GAP_LIMIT_MS) addIssue("caller_stream_gap", i);
          if (!isNonSpeechCaller(preparedTurn.callerText) && caller.speechOffsetAt == null) {
            addIssue("caller_audio_inaudible", i);
          }
          // Non-speech probes intentionally have no audible offset. Latency is
          // measured from the end of that probe, explicitly labeled below.
          if (caller.speechOffsetAt == null && isNonSpeechCaller(preparedTurn.callerText)) {
            caller.speechOffsetAt = caller.streamEndAt;
            caller.offsetBasis = "non-speech-probe-end";
          }
        } else {
          const at = clock.now();
          omni.sendControl({ type: "input_text", text: preparedTurn.callerText });
          caller = { startedAt: at, speechOnsetAt: at, speechOffsetAt: at, streamEndAt: at,
            maxFrameGapMs: 0, offsetBasis: "text-submit" };
        }
        startSilence(); // Continue through ALL agent playback and pauses.
        const requireTurnBegin = !isNonSpeechCaller(preparedTurn.callerText);
        const settled = await waitForAgentSettle(() => turnCtx, clock, {
          isClosed: () => closed, requireTurnBegin,
        });
        await stopSilence();
        if (settled.reason !== "settled") addIssue(`turn_${settled.reason}`, i);
        if (turnCtx.firstAudioAt == null) addIssue("agent_audio_inaudible", i);
        if (requireTurnBegin && turnCtx.latestTurnBeginAt == null) addIssue("response_turn_begin_missing", i);
        else if (requireTurnBegin && turnCtx.postTurnBeginFirstAudioAt == null) addIssue("response_audio_missing_after_turn_begin", i);
        if (turnCtx.turnBegins.length > 1) addIssue("multiple_response_turns", i, interruption ? "warning" : "error");
        if (turnCtx.events.some((e) => e.event === "flush" || e.event === "barge_in")) {
          // The interruption profile scores received output while preserving
          // cancellations. It never certifies the estimated playback lane.
          addIssue("output_playback_interrupted", i, interruption ? "warning" : "error");
        }
        captures.push({ preparedTurn, ctx: turnCtx, caller, settled });
        // A timeout cannot define a reliable boundary for the next reply.
        if (settled.reason !== "settled") break;
      }
    }
  } finally {
    try {
      await stopSilence();
    } finally {
      closing = true;
      omni.close(); // Always close, including configure/transport/stream errors.
      try {
        await withTimeout(closeComplete, 3000, "Omni close timed out", clock);
      } catch {
        addIssue("session_close_unconfirmed");
      }
    }
  }

  if (captures.length !== prepared.length) addIssue("incomplete_turn_capture");
  // Offline processing starts only once the socket is closed. REST latency can
  // no longer create dead air, trigger idle check-ins or bleed into the next turn.
  const turns = [];
  for (let i = 0; i < captures.length; i++) {
    const { preparedTurn, ctx, caller, settled } = captures[i];
    const agentPcm = concatPcm(ctx.pcm);
    let agentText = "";
    try {
      agentText = await transcribePcm(pyai, agentPcm, outputRate, "agent.wav") ?? "";
    } catch {
      addIssue("agent_transcription_failed", i);
    }
    if (!agentText) addIssue("agent_transcription_missing", i);
    const timing = captureTiming(ctx, caller, sessionStartedAt);
    timing.callerOffsetBasis = caller.offsetBasis ?? "energy-bound";
    timing.settleReason = settled.reason;
    const { callerPcm: _callerPcm, ...callerFields } = preparedTurn;
    turns.push({
      index: i, ...callerFields, agentText,
      agentAudioMs: Math.round((agentPcm.length / outputRate) * 1000),
      ttfbMs: timing.ttfbMs, turnMs: timing.turnMs,
      anyAudioTtfbMs: timing.anyAudioTtfbMs,
      postTurnBeginTtfbMs: timing.postTurnBeginTtfbMs,
      replyStartedAtMs: timing.agentSpeechOnsetMs,
      sttFinalMs: ctx.eouMs,
      brainTtsMs: ctx.turnBeginAt != null && ctx.firstPacketAt != null
        ? Math.round(ctx.firstPacketAt - ctx.turnBeginAt) : null,
      toolCalls: ctx.tools, toolResults: ctx.toolResults,
      bargeIn: null, kb: ctx.kb, timing,
      engineAssistantText: (ctx.assistantText ?? []).join(" "),
      engineAssistantTranscriptEvents: ctx.assistantTranscriptEvents,
      engineCallerText: ctx.callerTranscriptEvents.reduce((text, event) =>
        event.mode === "replace" ? event.text : text + event.text, ""),
      engineCallerTranscriptEvents: ctx.callerTranscriptEvents,
      turnBegins: ctx.turnBegins, events: ctx.events,
    });
  }

  // Mixed input/output rates are normalized for the audio artifact only;
  // capture timings and ASR retain their native negotiated rates.
  if (omniRate !== outputRate) {
    const resampler = makeResampler(omniRate, outputRate);
    for (const chunk of timeline.caller) chunk.pcm = resampler.process(chunk.pcm);
  }
  const audio = opts.captureAudioPath && (timeline.caller.length || timeline.agent.length)
    ? writeCallTimelineWav(opts.captureAudioPath, timeline, outputRate) : null;
  const safeConfigured = safeConfiguredMetadata(configuredAck);
  const toolsMatch = configuredAck?.tools === tools.length;
  const interruptionEvidence = interruption?.finish();
  for (const code of interruptionEvidence?.issues ?? []) addIssue(`interruption_${code}`);
  return {
    scenarioId: scenario.id, callId, sessionLabel: opts.sessionLabel,
    mode: mode === "voice" ? "live-voice" : "live-text",
    source: opts.baseURL ?? "api.pyai.com", recordedAt: new Date().toISOString(),
    audio, turns, configured: safeConfigured, engineCallerTranscriptEvents,
    availableTools: toolsMatch ? tools.map((tool) => tool.name ?? tool.function?.name).filter(Boolean) : null,
    availableToolsProvenance: toolsMatch ? "requested-declarations-and-configured-count" : "unverified",
    captureIntegrity: { valid: !issues.some((issue) => issue.severity === "error"), issues },
    ...(interruptionEvidence ? { interruptionCapture: interruptionEvidence } : {}),
    captureMethod: { inputRate: omniRate, outputRate, agentTranscription: "post-session-hear",
      callerTranscription: "pre-session-hear",
      engineCallerTranscription: "server-0x02-observed-deltas-with-client-turn-timestamps",
      timing: "client-monotonic-queued-playback-energy-bounds", settleQuietMs: 2000,
      turnBoundary: "audio-after-latest-turn-begin-plus-playout-and-advisory-quiet",
      postTurnBeginTiming: "First audible PCM received after latest turn_begin; not a semantic claim that the audio is substantive.",
      completionLimitation: "No server reply-end marker; an intra-reply silence longer than the quiet window can still be mistaken for completion.",
      maxInputGapMs: Math.round(maxInputGapMs) },
  };
}

export function isNonSpeechCaller(text) {
  return !/\p{L}|\p{N}/u.test(String(text || ""));
}

function quietStaticPcm(rate, durationMs) {
  const n = Math.max(1, Math.round((rate * durationMs) / 1000));
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = ((Math.random() * 120) | 0) - 60;
  return pcm;
}

async function transcribePcm(pyai, pcm, sampleRate, filename) {
  if (!pcm || pcm.length < Math.round((sampleRate * 80) / 1000)) return null;
  const wav = pcm16ToWav(pcm, sampleRate);
  const result = await pyai.audio.transcriptions.create({
    file: new Blob([wav], { type: "audio/wav" }),
    filename: filename ?? "audio.wav",
    language: "en",
  });
  const text = typeof result?.text === "string" ? result.text.trim() : "";
  return text || null;
}
