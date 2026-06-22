// LIVE runner — drives a real PyAI Omni session as a synthetic caller and
// captures a RunResult the scorers can grade. This path is DORMANT by default
// (run.js only loads it under `--live` with a key present).
//
// It REUSES the repo's own packages instead of re-implementing audio/transport:
//   @pyai/twilio  -> OmniClient (the Omni WS client + event demux), the
//                    anti-aliased resampler, and PCM16<->bytes helpers.
//   @pyai/sdk     -> Speak (TTS) to synthesize the caller, and the Hear stream
//                    to transcribe the synthetic caller audio for a real WER.
//
// Those packages ship as TypeScript and are consumed from their build output
// (dist/). If they aren't built yet, we throw a clear, actionable error rather
// than a cryptic module-not-found — the deterministic offline path never needs
// them, so OFFLINE mode and the test suite are unaffected.
//
// What's fully functional here: connect + configure, voice-mode Speak->PCM->Omni
// playback, agent transcript capture, TTFB + per-turn latency, and Hear-stream
// WER of the caller audio. What's engine-roadmap-dependent: text-mode input and
// mid-call tool calls (the protocol marks both as not-yet-honored) — we send
// them forward-compatibly and capture whatever the engine returns.

const SETTLE_MS = 600; // silence after agent audio that marks the turn complete
const TURN_TIMEOUT_MS = 15000; // hard cap so a stuck turn can't hang the run
const CONNECT_TIMEOUT_MS = 10000;
const FRAME_MS = 20; // ~20ms PCM frames, paced in real time toward the engine
const HEAR_RATE = 16000; // Hear stream input rate; caller audio is resampled to it
const HEAR_TIMEOUT_MS = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, monotonic

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

/**
 * Run a scenario live against Omni. Returns a normalized RunResult.
 * @param {object} scenario validated scenario
 * @param {object} opts { apiKey, agentId, mode, voice, baseURL, omniRate }
 */
export async function runLive(scenario, opts) {
  const { twilio, sdk } = await loadDeps();
  const { OmniClient, makeResampler, pcm16ToBytes, bytesToPcm16 } = twilio;
  const PyAI = sdk.PyAI ?? sdk.default;

  const omniRate = opts.omniRate ?? 24000;
  const mode = opts.mode === "text" ? "text" : "voice";
  const pyai = new PyAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  const toHear = makeResampler(omniRate, HEAR_RATE); // reuse the anti-aliased resampler

  // --- live Omni capture state, repointed per turn ---
  let turnCtx = newTurnCtx();
  function newTurnCtx() {
    return { firstAudioAt: null, lastAudioAt: null, finals: [], tools: [], started: now() };
  }

  // Resolve when the socket is open + the configure frame has been sent.
  let onReadyResolve;
  const ready = new Promise((res) => {
    onReadyResolve = res;
  });

  const omni = new OmniClient({
    apiKey: opts.apiKey,
    agentId: opts.agentId,
    baseURL: opts.baseURL,
    rate: omniRate,
    voice: opts.voice,
    persona: scenario.persona,
    onReady: () => onReadyResolve(),
    onAudio: () => {
      const t = now();
      if (turnCtx.firstAudioAt == null) turnCtx.firstAudioAt = t;
      turnCtx.lastAudioAt = t;
    },
    onTranscript: (tr) => {
      const role = tr.role ?? "";
      if (tr.final && role !== "user" && role !== "caller" && tr.text) turnCtx.finals.push(tr.text);
    },
    onEvent: (evt) => {
      const type = typeof evt.type === "string" ? evt.type : "";
      if (type === "tool_call" || type === "function_call" || type === "tool") {
        const name = evt.name ?? evt.tool ?? evt.function?.name;
        if (name) turnCtx.tools.push({ name, args: evt.arguments ?? evt.args ?? null });
      }
    },
    onError: (err) => console.error(`[live][omni] ${err.message}`),
  });

  await withTimeout(ready, CONNECT_TIMEOUT_MS, "Omni connect timed out");

  const turns = [];
  for (let i = 0; i < scenario.turns.length; i++) {
    const spec = scenario.turns[i];
    const callerText = spec.caller_says;
    turnCtx = newTurnCtx();

    // 1) Synthesize the caller's turn (voice mode) -> PCM16 @ omniRate.
    let callerPcm = null;
    let callerAudioMs = null;
    if (mode === "voice") {
      const buf = await pyai.audio.speech({
        input: callerText,
        voice: opts.voice,
        response_format: "pcm",
        sample_rate: omniRate,
      });
      callerPcm = bytesToPcm16(new Uint8Array(buf));
      callerAudioMs = Math.round((callerPcm.length / omniRate) * 1000);
    }

    // 2) Transcribe the caller audio via the Hear stream -> WER reference check.
    let asrHypothesis = null;
    if (mode === "voice" && callerPcm) {
      const forHear = toHear ? toHear.process(callerPcm) : callerPcm;
      asrHypothesis = await transcribeWithHear(pyai, pcm16ToBytes(forHear)).catch((err) => {
        console.error(`[live][hear] ${err.message}`);
        return null;
      });
    }

    // 3) Play the caller turn into Omni, then time the agent's response.
    let tCallerDone;
    if (mode === "voice" && callerPcm) {
      tCallerDone = await streamPcmRealtime(omni, callerPcm, omniRate);
    } else {
      // text mode: forward-compatible text-input frame (engine support is a
      // roadmap item; captured honestly either way).
      omni.sendControl({ type: "input_text", text: callerText });
      tCallerDone = now();
    }

    await waitForAgentSettle(() => turnCtx);

    const ttfbMs = turnCtx.firstAudioAt != null ? Math.round(turnCtx.firstAudioAt - tCallerDone) : null;
    const turnMs = turnCtx.lastAudioAt != null ? Math.round(turnCtx.lastAudioAt - tCallerDone) : null;
    const agentAudioMs =
      turnCtx.firstAudioAt != null && turnCtx.lastAudioAt != null
        ? Math.round(turnCtx.lastAudioAt - turnCtx.firstAudioAt)
        : null;

    turns.push({
      index: i,
      callerText,
      callerAudioMs,
      asrHypothesis,
      agentText: turnCtx.finals.join(" ").trim(),
      agentAudioMs,
      ttfbMs,
      turnMs,
      toolCalls: turnCtx.tools,
      bargeIn: null, // scripted sequential caller does not barge; see offline fixture
    });
  }

  omni.close();

  return {
    scenarioId: scenario.id,
    agentId: opts.agentId,
    mode: mode === "voice" ? "live-voice" : "live-text",
    source: opts.baseURL ?? "api.pyai.com",
    recordedAt: new Date().toISOString(),
    turns,
  };
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/** Stream PCM to Omni in real-time ~20ms frames; resolve with the end time. */
async function streamPcmRealtime(omni, pcm, rate) {
  const frame = Math.max(1, Math.round((rate * FRAME_MS) / 1000));
  for (let off = 0; off < pcm.length; off += frame) {
    omni.sendAudio(pcm.subarray(off, Math.min(off + frame, pcm.length)));
    await sleep(FRAME_MS);
  }
  const done = now();
  // A short silence tail helps the engine's endpointer close the caller turn.
  const silence = new Int16Array(frame * 8);
  omni.sendAudio(silence);
  return done;
}

/** Resolve once the agent has produced audio and then gone quiet for SETTLE_MS. */
function waitForAgentSettle(getCtx) {
  return new Promise((resolve) => {
    const start = now();
    const tick = () => {
      const ctx = getCtx();
      const elapsed = now() - start;
      const quietFor = ctx.lastAudioAt != null ? now() - ctx.lastAudioAt : 0;
      const settled = ctx.lastAudioAt != null && quietFor >= SETTLE_MS;
      if (settled || elapsed >= TURN_TIMEOUT_MS) return resolve();
      setTimeout(tick, 50);
    };
    tick();
  });
}

/** One-shot Hear streaming transcription of a PCM16 buffer. */
function transcribeWithHear(pyai, pcmBytes) {
  return new Promise((resolve, reject) => {
    let text = "";
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    const timer = setTimeout(() => finish(resolve, text || null), HEAR_TIMEOUT_MS);
    const hs = pyai.audio.transcriptions.stream({
      sampleRate: HEAR_RATE,
      encoding: "pcm16",
      onOpen: () => {
        try {
          hs.sendAudio(pcmBytes);
          hs.commit();
        } catch (err) {
          clearTimeout(timer);
          finish(reject, err);
        }
      },
      onFinal: (f) => {
        text = `${text} ${f.text ?? ""}`.trim();
      },
      onError: (err) => {
        clearTimeout(timer);
        finish(reject, err instanceof Error ? err : new Error(err?.message ?? "Hear error"));
      },
      onClose: () => {
        clearTimeout(timer);
        finish(resolve, text || null);
      },
    });
    // Give the engine a beat to flush its final, then close to trigger onClose.
    setTimeout(() => {
      try {
        hs.close();
      } catch {
        /* already closing */
      }
    }, 1200);
  });
}
