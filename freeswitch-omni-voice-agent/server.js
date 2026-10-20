// FreeSWITCH (mod_audio_stream) <-> PyAI Omni bridge.
//
// FreeSWITCH forks call audio as L16 mono @ 16 kHz over a WebSocket; we relay it
// to Omni at rate=16000 (PCM16). Omni returns 24 kHz PCM16 for this input;
// playback carries its actual output rate so FreeSWITCH can adapt to the call.
//
// The Omni side is exact (docs/OMNI_PROTOCOL_V2.md). The FreeSWITCH side speaks
// the mod_audio_stream JSON protocol, which varies by module build, it is
// isolated in FS_PROTOCOL below so you can match it to yours.
//
// Run: cp .env.example .env  &&  npm install  &&  npm start
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT ?? 8080);
const KEY = process.env.PYAI_API_KEY;
// Accept http(s) or ws(s) base; normalize to a ws(s) origin.
const BASE = (process.env.PYAI_BASE_URL ?? "wss://api.pyai.com").replace(/^http/, "ws").replace(/\/$/, "");
const RATE = Number(process.env.OMNI_RATE ?? 16000); // caller-input PCM16 rate, independent of agent output
const LEGACY_JSON_TRANSCRIPTS = process.env.OMNI_LEGACY_JSON_TRANSCRIPTS === "1";
const VOICE = process.env.PYAI_VOICE; // optional voice_id from GET /v1/voices
const PERSONA =
  process.env.PERSONA ?? "You are a warm, concise front-desk agent for Acme. Keep replies short and ask one question at a time.";

if (!KEY) {
  console.error("Missing PYAI_API_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

// ── FreeSWITCH-facing protocol adapter, MATCH TO YOUR mod_audio_stream BUILD ──
// Reference: https://github.com/amigniter/mod_audio_stream
const FS_PROTOCOL = {
  // Parse an inbound text frame (connect metadata / events). Return an object.
  parseControl: (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  },
  // Preserve the PCM bytes and label their actual source rate, not caller RATE.
  playAudio: (pcm, sampleRate) =>
    JSON.stringify({ type: "streamAudio", data: { audioDataType: "raw", sampleRate, audioData: pcm.toString("base64") } }),
  // Frame that flushes current playback immediately (barge-in).
  killAudio: () => JSON.stringify({ type: "killAudio" }),
};
// ──────────────────────────────────────────────────────────────────────────────

// Optional: wire your Event Socket (ESL) client here to drive the call by uuid.
// e.g. with `esl`/`modesl`: conn.api(`uuid_transfer ${uuid} ${dest}`). These are
// the engine-native call-control verbs (execution: "engine" in GET /v1/tools):
// the engine emits a 0x03 frame {"event":"<verb>", ...args} and the TRANSPORT
// (this bridge) performs the media/SIP action. The engine spreads tool args
// verbatim, so the arg names below match the tool input_schema.
const esl = {
  transfer: (uuid, dest) => {
    if (!uuid) return;
    console.log(`[esl] would: uuid_transfer ${uuid} ${dest ?? "<dest>"}  (wire an ESL client to do this)`);
  },
  sendDtmf: (uuid, digits) => {
    if (!uuid || !digits) return;
    console.log(`[esl] would: uuid_send_dtmf ${uuid} ${digits}`);
  },
  playHold: (uuid, seconds) => {
    if (!uuid) return;
    console.log(`[esl] would: uuid_broadcast ${uuid} <hold-music>  (~${seconds ?? "until next turn"}s)`);
  },
  hangup: (uuid, reason) => {
    if (!uuid) return;
    console.log(`[esl] would: uuid_kill ${uuid} ${reason ?? "NORMAL_CLEARING"}`);
  },
};

// Engine control frames are 0x03-prefixed JSON (OMNI_PROTOCOL_V2.md §2/§3).
const b03 = (obj) => Buffer.concat([Buffer.from([0x03]), Buffer.from(JSON.stringify(obj))]);

// Caller audio is 0x01-prefixed PCM16 (OMNI_PROTOCOL_V2.md §2). The engine
// demuxes on the first byte with no default branch: untagged audio is dropped
// silently and the agent never hears the caller.
const b01 = (pcm) => Buffer.concat([Buffer.from([0x01]), pcm]);

function transcriptText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4_000 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? value : null;
}

// Native frames are caller text regardless of content. JSON transcript objects
// require explicit legacy mode; braces in caller speech cannot choose a role.
function normalizeTranscriptBody(body) {
  if (!body.length || body.length > 16_384) return null;
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  if (!LEGACY_JSON_TRANSCRIPTS) {
    const text = transcriptText(decoded);
    return text ? { event: "transcript", role: "user", text, final: false, mode: "delta" } : null;
  }
  try {
    const value = JSON.parse(decoded);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.type !== undefined || (value.event !== undefined && value.event !== "transcript")) return null;
    const speaker = value.role ?? value.speaker;
    const role = ["user", "caller", "human"].includes(speaker) ? "user" :
      ["assistant", "agent"].includes(speaker) ? "assistant" : null;
    const mode = typeof value.delta === "string" ? "delta" : "replace";
    const text = transcriptText(mode === "delta" ? value.delta : typeof value.text === "string" ? value.text : value.transcript);
    if (!role || !text || (value.final !== undefined && typeof value.final !== "boolean")) return null;
    if (value.sequence !== undefined && (!Number.isSafeInteger(value.sequence) || value.sequence < 0)) return null;
    return { event: "transcript", role, text, final: value.final === true, mode,
      ...(value.sequence === undefined ? {} : { sequence: value.sequence }) };
  } catch {
    return null;
  }
}

function connectOmni() {
  // Offer the `pyai.v1` marker with the credential: the edge echoes only the
  // marker, never the key, and `ws` rejects a 101 that selects nothing.
  const ws = new WebSocket(`${BASE}/v1/omni?format=pcm16&rate=${RATE}`, ["pyai.v1", `pyai-key.${KEY}`]);
  ws.binaryType = "nodebuffer";
  return ws;
}

const wss = new WebSocketServer({ port: PORT, path: "/fs" });

wss.on("connection", (fs) => {
  let channelUuid = null;
  let omniReady = false;
  // Required native hello: 8 kHz input gets 8 kHz output; 16/24 kHz
  // input gets 24 kHz output. Any server declaration must match this contract.
  const outputRate = RATE === 8000 ? 8000 : 24000;
  let audioFailed = false;
  let audioContractReady = false;
  const pending = []; // caller audio buffered until Omni is ready
  const omni = connectOmni();

  function failAudioContract(reason) {
    if (audioFailed) return;
    audioFailed = true;
    audioContractReady = false;
    omniReady = false;
    pending.length = 0;
    try {
      if (fs.readyState === fs.OPEN) fs.send(FS_PROTOCOL.killAudio());
    } catch { /* a failed clear cannot keep a rejected call open */ }
    try {
      omni.close(1002, reason);
    } finally {
      if (fs.readyState <= 1) fs.close(1002, reason);
    }
  }

  omni.on("open", () => {
    if (audioFailed) return;
    // Stateless on PyAI: the agent's whole behavior travels in this frame.
    omni.send(b03({ type: "configure", persona: PERSONA, ...(VOICE ? { voice_id: VOICE } : {}) }));
    omniReady = true;
    for (const buf of pending) omni.send(buf);
    pending.length = 0;
  });

  omni.on("message", (data, isBinary) => {
    if (audioFailed) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!isBinary) {
      omni.close(1002, "binary_frames_required");
      return;
    }
    // Engine binary frames are type-tagged: 0x01 audio · 0x02 transcript ·
    // 0x03 control JSON. Demux on the first byte.
    const tag = buf[0];
    if (tag === 0x01) {
      if (!audioContractReady || buf.length <= 1 || (buf.length - 1) % 2) { failAudioContract("unaligned_pcm16"); return; }
      if (fs.readyState === fs.OPEN) fs.send(FS_PROTOCOL.playAudio(buf.subarray(1), outputRate)); // PCM16 into the call
      return;
    }
    if (tag === 0x02) {
      const transcript = normalizeTranscriptBody(buf.subarray(1));
      if (!transcript) omni.close(1002, "invalid_transcript_frame");
      else if (transcript.final) console.log(`[omni][${transcript.role}] ${transcript.text}`);
      return;
    }
    if (tag !== 0x03) {
      omni.close(1002, "unknown_binary_tag");
      return;
    }
    let evt;
    try {
      evt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(1)));
      if (!evt || typeof evt !== "object" || Array.isArray(evt) ||
          typeof evt.event !== "string" || !evt.event) throw new Error();
      if (evt.event === "transcript") {
        // This exact assistant advisory describes synthesis input. It does not
        // mean the downstream call has played or heard the text.
        const keys = Object.keys(evt);
        const text = transcriptText(evt.text);
        if (buf.length - 1 > 16_384 || evt.role !== "assistant" || evt.final !== true || !text?.trim() ||
            keys.length !== 4 || !keys.every((key) => ["event", "role", "text", "final"].includes(key))) throw new Error();
        console.log(`[omni][assistant] ${text}`);
        return;
      }
    } catch {
      omni.close(1002, "invalid_control_frame");
      return;
    }
    const kind = evt.event;
    if (["hello", "configured", "audio_segment_start"].includes(kind)) {
      const declarations = {
        audio_in: `pcm16@${RATE}`, audio_out: `pcm16@${outputRate}`,
        format: "pcm16", audio_format: "pcm16", audio_out_format: "pcm16",
        sample_rate: outputRate, audio_out_sample_rate: outputRate,
        channels: 1, audio_channels: 1, audio_out_channels: 1,
      };
      if ((kind === "hello" ? evt.audio_in !== declarations.audio_in || evt.audio_out !== declarations.audio_out : !audioContractReady)
          || Object.entries(declarations).some(([key, expected]) => key in evt && evt[key] !== expected)) {
        failAudioContract("unsupported_audio_out");
        return;
      }
      if (kind === "hello") audioContractReady = true;
    } else if (kind === "flush" || kind === "barge_in" || kind === "reply_interrupted" || kind === "reply_failed") {
      if (fs.readyState === fs.OPEN) fs.send(FS_PROTOCOL.killAudio()); // discard queued cancelled speech
    } else if (kind === "transfer_to_human") {
      esl.transfer(channelUuid, evt.destination || evt.to); // destination folded in from the agent's tool config
    } else if (kind === "send_dtmf") {
      esl.sendDtmf(channelUuid, evt.digits);
    } else if (kind === "play_hold") {
      esl.playHold(channelUuid, evt.seconds);
    } else if (kind === "end_call") {
      esl.hangup(channelUuid, evt.reason);
    } else if (kind === "collect") {
      // Fire-and-forget: the value reaches the brain via existing channels, // caller speech (STT transcript) or caller DTMF (the inbound 0x03 {"event":
      // "dtmf"} frame this bridge already forwards). Nothing to do unless you want
      // to ensure DTMF capture is on for evt.kind === "dtmf".
      console.log(`[omni] collect requested: field=${evt.field} kind=${evt.kind ?? "speech"}`);
    }
    // Other frames (session_started / turn / session_end …): log/forward as needed.
  });

  omni.on("close", () => {
    if (fs.readyState <= 1) fs.close();
  });
  omni.on("error", (err) => console.error("omni error:", err?.message ?? err));

  fs.on("message", (data, isBinary) => {
    if (audioFailed) return;
    if (isBinary) {
      // Caller audio (L16/16k) -> Omni (0x01 + PCM16). No conversion when rates
      // match. Tag here, once: `pending` is flushed verbatim on open.
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!bytes.length || bytes.length % 2) { failAudioContract("unaligned_pcm16"); return; }
      const frame = b01(bytes);
      if (omniReady && omni.readyState === omni.OPEN) omni.send(frame);
      else pending.push(frame);
      return;
    }
    const ctrl = FS_PROTOCOL.parseControl(data.toString());
    if (!ctrl) return;
    if (ctrl.uuid && !channelUuid) channelUuid = ctrl.uuid; // captured from start metadata
    // If you forward FreeSWITCH DTMF events as control frames, pass them to Omni:
    if (ctrl.type === "dtmf" && ctrl.digit && omni.readyState === omni.OPEN) {
      omni.send(b03({ type: "dtmf", digit: String(ctrl.digit) }));
    }
  });

  const cleanup = () => {
    try {
      omni.close();
    } catch {
      /* already closing */
    }
  };
  fs.on("close", cleanup);
  fs.on("error", cleanup);
});

console.log(`FreeSWITCH↔Omni bridge listening on ws://0.0.0.0:${PORT}/fs (Omni rate=${RATE})`);
