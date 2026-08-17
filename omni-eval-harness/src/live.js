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

const SETTLE_MS = 2000; // quiet after last agent audio before the turn is done
const MIN_AGENT_AUDIO_MS = 350; // ignore a click / first-chunk blip
const GREETING_DRAIN_MS = 4000;
const TURN_TIMEOUT_MS = 25000;
const CONNECT_TIMEOUT_MS = 10000;
const CONFIGURED_TIMEOUT_MS = 5000;
const FRAME_MS = 20;
const HEAR_RATE = 16000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

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
 * @param {object} opts { apiKey, sessionLabel, mode, voice, baseURL, omniRate, tools }
 */
export async function runLive(scenario, opts) {
  const { twilio, sdk } = await loadDeps();
  const { OmniClient, makeResampler } = twilio;
  const PyAI = sdk.PyAI ?? sdk.default;

  const omniRate = opts.omniRate ?? 24000;
  const mode = opts.mode === "text" ? "text" : "voice";
  const pyai = new PyAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  const toHear = makeResampler(omniRate, HEAR_RATE);
  const tools = opts.tools ?? toolsForScenario(scenario);

  const prepared = [];
  for (const spec of scenario.turns) {
    const callerText = spec.caller_says;
    let callerPcm = null;
    let callerAudioMs = null;
    let asrHypothesis = null;
    if (mode === "voice") {
      if (isNonSpeechCaller(callerText)) {
        callerPcm = quietStaticPcm(omniRate, 1200);
      } else {
        const buf = await pyai.audio.speech({
          input: callerText,
          voice: opts.voice,
          response_format: "pcm",
          sample_rate: omniRate,
        });
        callerPcm = twilio.bytesToPcm16(new Uint8Array(buf));
      }
      callerAudioMs = Math.round((callerPcm.length / omniRate) * 1000);
      const forHear = toHear ? toHear.process(callerPcm) : callerPcm;
      asrHypothesis = await transcribePcm(pyai, forHear, HEAR_RATE, "caller.wav").catch((err) => {
        console.error(`[live][hear] caller: ${err.message}`);
        return null;
      });
    }
    prepared.push({ callerText, callerPcm, callerAudioMs, asrHypothesis });
  }

  let turnCtx = newTurnCtx();
  function newTurnCtx() {
    return {
      firstAudioAt: null,
      lastAudioAt: null,
      pcm: [],
      finals: [],
      tools: [],
      kb: null,
      started: now(),
    };
  }

  let onReadyResolve;
  const ready = new Promise((res) => {
    onReadyResolve = res;
  });
  let latestConfigured = null;
  let onConfiguredResolve;
  const configured = new Promise((res) => {
    onConfiguredResolve = res;
  });

  const omni = new OmniClient({
    apiKey: opts.apiKey,
    sessionLabel: opts.sessionLabel,
    baseURL: opts.baseURL,
    rate: omniRate,
    voice: opts.voice,
    persona: scenario.persona,
    tools,
    onReady: () => onReadyResolve(),
    onAudio: (pcm) => {
      const t = now();
      if (turnCtx.firstAudioAt == null) turnCtx.firstAudioAt = t;
      turnCtx.lastAudioAt = t;
      if (pcm && pcm.length) turnCtx.pcm.push(pcm);
    },
    onTranscript: (tr) => {
      if (tr.final && tr.role === "assistant" && tr.text) turnCtx.finals.push(tr.text);
    },
    onTransfer: (evt) => {
      turnCtx.tools.push({ name: "transfer_to_human", args: evt ?? null });
    },
    onEvent: (evt) => {
      const event = typeof evt.event === "string" ? evt.event : "";
      if (event === "configured") {
        latestConfigured = evt;
        onConfiguredResolve(evt);
      }
      if (event === "tool_call") {
        const name = evt.name ?? evt.tool ?? evt.function?.name;
        if (name) turnCtx.tools.push({ name, args: evt.arguments ?? evt.args ?? null });
      }
      if (event === "kb_query") {
        turnCtx.kb = kbFromQueryEvent(evt);
      }
    },
    onError: (err) => {
      const msg = err?.message ?? String(err);
      if (msg.includes("missing its event key")) return;
      console.error(`[live][omni] ${msg}`);
    },
  });

  await withTimeout(ready, CONNECT_TIMEOUT_MS, "Omni connect timed out");
  const configuredAck = await withTimeout(
    configured,
    CONFIGURED_TIMEOUT_MS,
    "Omni configured ack timed out",
  ).catch((err) => {
    console.error(`[live][omni] ${err.message}`);
    return latestConfigured;
  });
  if (configuredAck) {
    console.error(
      `[live] configured tools=${configuredAck.tools ?? "?"} greeting=${configuredAck.greeting ?? "?"}`,
    );
  }

  // Drain turn-0 greeting so it is not scored as the first reply.
  turnCtx = newTurnCtx();
  await waitForAgentSettle(() => turnCtx, {
    allowEmpty: true,
    timeoutMs: GREETING_DRAIN_MS,
    minAudioMs: MIN_AGENT_AUDIO_MS,
  });

  const turns = [];
  for (let i = 0; i < prepared.length; i++) {
    const { callerText, callerPcm, callerAudioMs, asrHypothesis } = prepared[i];
    turnCtx = newTurnCtx();

    let tCallerDone;
    if (mode === "voice" && callerPcm) {
      tCallerDone = await streamPcmRealtime(omni, callerPcm, omniRate);
    } else {
      omni.sendControl({ type: "input_text", text: callerText });
      tCallerDone = now();
    }
    let keepSilence = true;
    const silencer = streamSilenceWhile(
      omni,
      omniRate,
      () => keepSilence && turnCtx.firstAudioAt == null,
    );
    await waitForAgentSettle(() => turnCtx);
    keepSilence = false;
    await silencer;

    const agentPcm = concatPcm(turnCtx.pcm);
    const agentAudioMs =
      turnCtx.firstAudioAt != null && turnCtx.lastAudioAt != null
        ? Math.round(turnCtx.lastAudioAt - turnCtx.firstAudioAt)
        : null;
    let agentText = turnCtx.finals.join(" ").trim();
    if (!agentText && agentPcm.length >= Math.round((omniRate * 80) / 1000)) {
      agentText = await transcribePcm(pyai, agentPcm, omniRate, "agent.wav").catch((err) => {
        console.error(`[live][hear] agent: ${err.message}`);
        return "";
      }) ?? "";
    }

    const ttfbRaw = turnCtx.firstAudioAt != null ? Math.round(turnCtx.firstAudioAt - tCallerDone) : null;
    const turnRaw = turnCtx.lastAudioAt != null ? Math.round(turnCtx.lastAudioAt - tCallerDone) : null;
    const ttfbMs = ttfbRaw != null && ttfbRaw >= 0 ? ttfbRaw : null;
    const turnMs = turnRaw != null && turnRaw >= 0 ? turnRaw : null;

    turns.push({
      index: i,
      callerText,
      callerAudioMs,
      asrHypothesis,
      agentText,
      agentAudioMs,
      ttfbMs,
      turnMs,
      toolCalls: turnCtx.tools,
      bargeIn: null,
      kb: turnCtx.kb,
    });
  }

  omni.close();

  return {
    scenarioId: scenario.id,
    sessionLabel: opts.sessionLabel,
    mode: mode === "voice" ? "live-voice" : "live-text",
    source: opts.baseURL ?? "api.pyai.com",
    recordedAt: new Date().toISOString(),
    turns,
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

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/** Stream PCM to Omni in real-time ~20ms frames; resolve at the last speech frame. */
async function streamPcmRealtime(omni, pcm, rate) {
  const frame = Math.max(1, Math.round((rate * FRAME_MS) / 1000));
  for (let off = 0; off < pcm.length; off += frame) {
    omni.sendAudio(pcm.subarray(off, Math.min(off + frame, pcm.length)));
    await sleep(FRAME_MS);
  }
  return now();
}

/** Keep the engine's endpointer alive. Omni has no explicit end-of-input. */
async function streamSilenceWhile(omni, rate, shouldContinue) {
  const frame = Math.max(1, Math.round((rate * FRAME_MS) / 1000));
  const silence = new Int16Array(frame);
  while (shouldContinue()) {
    omni.sendAudio(silence);
    await sleep(FRAME_MS);
  }
}

function waitForAgentSettle(getCtx, opts = {}) {
  const settleMs = opts.settleMs ?? SETTLE_MS;
  const timeoutMs = opts.timeoutMs ?? TURN_TIMEOUT_MS;
  const minAudioMs = opts.minAudioMs ?? MIN_AGENT_AUDIO_MS;
  const allowEmpty = opts.allowEmpty ?? false;
  return new Promise((resolve) => {
    const start = now();
    const tick = () => {
      const ctx = getCtx();
      const elapsed = now() - start;
      const audioMs =
        ctx.firstAudioAt != null && ctx.lastAudioAt != null
          ? ctx.lastAudioAt - ctx.firstAudioAt
          : 0;
      const quietFor = ctx.lastAudioAt != null ? now() - ctx.lastAudioAt : 0;
      if (audioMs >= minAudioMs && quietFor >= settleMs) return resolve();
      if (allowEmpty && ctx.firstAudioAt == null && elapsed >= 800) return resolve();
      if (elapsed >= timeoutMs) return resolve();
      setTimeout(tick, 50);
    };
    tick();
  });
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
