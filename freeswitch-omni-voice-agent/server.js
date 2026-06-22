// FreeSWITCH (mod_audio_stream) <-> PyAI Omni bridge.
//
// FreeSWITCH forks call audio as L16 mono @ 16 kHz over a WebSocket; we relay it
// to Omni at rate=16000 (PCM16) and play Omni's audio back into the call. With
// matched rates there is NO resampling and NO μ-law anywhere.
//
// The Omni side is exact (docs/OMNI_PROTOCOL_V2.md). The FreeSWITCH side speaks
// the mod_audio_stream JSON protocol, which varies by module build — it is
// isolated in FS_PROTOCOL below so you can match it to yours.
//
// Run: cp .env.example .env  &&  npm install  &&  npm start
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT ?? 8080);
const KEY = process.env.PYAI_API_KEY;
// Accept http(s) or ws(s) base; normalize to a ws(s) origin.
const BASE = (process.env.PYAI_BASE_URL ?? "wss://api.pyai.com").replace(/^http/, "ws").replace(/\/$/, "");
const RATE = Number(process.env.OMNI_RATE ?? 16000); // 16000 = L16 telephony; 8000 for a G.711 leg
const VOICE = process.env.PYAI_VOICE; // optional voice_id from GET /v1/voices
const PERSONA =
  process.env.PERSONA ?? "You are a warm, concise front-desk agent for Acme. Keep replies short and ask one question at a time.";

if (!KEY) {
  console.error("Missing PYAI_API_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

// ── FreeSWITCH-facing protocol adapter — MATCH TO YOUR mod_audio_stream BUILD ──
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
  // Frame that plays PCM16 audio back into the call (base64 raw L16 @ RATE).
  playAudio: (pcm) =>
    JSON.stringify({ type: "streamAudio", data: { audioDataType: "raw", sampleRate: RATE, audioData: pcm.toString("base64") } }),
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

function connectOmni() {
  const ws = new WebSocket(`${BASE}/v1/omni?format=pcm16&rate=${RATE}`, [`pyai-key.${KEY}`]);
  ws.binaryType = "nodebuffer";
  return ws;
}

const wss = new WebSocketServer({ port: PORT, path: "/fs" });

wss.on("connection", (fs) => {
  let channelUuid = null;
  let omniReady = false;
  const pending = []; // caller audio buffered until Omni is ready
  const omni = connectOmni();

  omni.on("open", () => {
    // Stateless on PyAI: the agent's whole behavior travels in this frame.
    omni.send(b03({ type: "configure", persona: PERSONA, ...(VOICE ? { voice_id: VOICE } : {}) }));
    omniReady = true;
    for (const buf of pending) omni.send(buf);
    pending.length = 0;
  });

  omni.on("message", (data, isBinary) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let evt = null;
    if (isBinary) {
      // Engine binary frames are type-tagged: 0x01 audio · 0x02 transcript ·
      // 0x03 control JSON. Demux on the first byte (treating all binary as audio
      // plays control frames as a glitch and drops every event).
      const tag = buf[0];
      if (tag === 0x01) {
        if (fs.readyState === fs.OPEN) fs.send(FS_PROTOCOL.playAudio(buf.subarray(1))); // PCM16 into the call
        return;
      }
      if (tag !== 0x03) return; // 0x02 transcript (log/forward as you like) / untagged
      try {
        evt = JSON.parse(buf.subarray(1).toString());
      } catch {
        return;
      }
    } else {
      try {
        evt = JSON.parse(buf.toString()); // legacy text control frame, tolerated
      } catch {
        return;
      }
    }
    // Read `event` first, then `type` (switching on `type` alone silently misses
    // every Omni server frame — the #1 integration bug).
    const kind = evt.event || evt.type;
    if (kind === "flush" || kind === "barge_in") {
      if (fs.readyState === fs.OPEN) fs.send(FS_PROTOCOL.killAudio()); // caller interrupted
    } else if (kind === "transfer_to_human") {
      esl.transfer(channelUuid, evt.destination || evt.to); // destination folded in from the agent's tool config
    } else if (kind === "send_dtmf") {
      esl.sendDtmf(channelUuid, evt.digits);
    } else if (kind === "play_hold") {
      esl.playHold(channelUuid, evt.seconds);
    } else if (kind === "end_call") {
      esl.hangup(channelUuid, evt.reason);
    } else if (kind === "collect") {
      // Fire-and-forget: the value reaches the brain via existing channels —
      // caller speech (STT transcript) or caller DTMF (the inbound 0x03 {"event":
      // "dtmf"} frame this bridge already forwards). Nothing to do unless you want
      // to ensure DTMF capture is on for evt.kind === "dtmf".
      console.log(`[omni] collect requested: field=${evt.field} kind=${evt.kind ?? "speech"}`);
    }
    // Other frames (session_started / transcript / session_ending …): log/forward as you like.
  });

  omni.on("close", () => {
    if (fs.readyState <= 1) fs.close();
  });
  omni.on("error", (err) => console.error("omni error:", err?.message ?? err));

  fs.on("message", (data, isBinary) => {
    if (isBinary) {
      // Caller audio (L16/16k) -> Omni (PCM16). No conversion when rates match.
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (omniReady && omni.readyState === omni.OPEN) omni.send(buf);
      else pending.push(buf);
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
