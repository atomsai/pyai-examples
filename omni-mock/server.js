// omni-mock, an offline PyAI Omni server you can build against before you have
// a key. It speaks the Omni wire protocol v2 (docs/OMNI_PROTOCOL_V2.md) with the
// engine's real BINARY, TYPE-PREFIXED framing so your client is correct on the
// day you swap in a real key:
//
//   server → client binary frames are tagged by their first byte:
//     0x01 = agent audio (PCM16)   0x02 = transcript body   0x03 = control/event JSON
//   client → server: control frames (configure/dtmf) are 0x03-prefixed JSON;
//   caller audio is 0x01-prefixed PCM16.
//
// Point your real Omni client at it:
//   wss://api.pyai.com/v1/omni  →  ws://localhost:8787/v1/omni
//
// It is NOT a model, the "agent" replies with a tone + a canned transcript. The
// point is the *protocol*: if your client treats every binary frame as audio (the
// classic bug), it will play the 0x03/0x02 frames as a glitch and never see the
// events, exactly as it would fail against prod. Demux on the first byte.
//
// Run: cp .env.example .env  &&  npm install  &&  npm start
import { WebSocketServer } from "ws";
import { parse } from "node:url";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8787);
const TURN_GAP_MS = Number(process.env.TURN_GAP_MS ?? 700);

// Frame type tags (first byte of every server→client binary frame).
const TAG = { AUDIO: 0x01, TRANSCRIPT: 0x02, CONTROL: 0x03 };
const frame = (tag, payload) =>
  Buffer.concat([Buffer.from([tag]), Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload))]);

const wss = new WebSocketServer({ port: PORT });

/** A short PCM16 LE sine tone at `rate` Hz, stand-in agent audio. */
function tone(rate, ms = 900, freq = 440) {
  const n = Math.floor((rate * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.sin((2 * Math.PI * freq * i) / rate) * 0.3;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
  }
  return buf;
}

const sendEvent = (ws, obj) => ws.readyState === ws.OPEN && ws.send(frame(TAG.CONTROL, obj)); // 0x03
const sendCallerTranscript = (ws, text) =>
  ws.readyState === ws.OPEN && ws.send(frame(TAG.TRANSCRIPT, Buffer.from(text, "utf8"))); // raw 0x02
const sendAssistantTranscript = (ws, text) =>
  sendEvent(ws, { event: "transcript", role: "assistant", text, final: true }); // exact 0x03 advisory

wss.on("connection", (ws, req) => {
  const { pathname, query } = parse(req.url ?? "", true);
  const format = query.format || "pcm16";
  const rate = query.rate === undefined ? 24000 : Number(query.rate);
  const outputRate = rate === 8000 ? 8000 : 24000;
  const callId = randomUUID();
  const label = query.session_label || null;

  console.log(`\n[conn] ${pathname}  format=${format} rate=${rate}${label ? ` session_label=${label}` : ""}`);
  if (pathname !== "/v1/omni") {
    ws.close(1008, "canonical_path_required");
    return;
  }

  if (format !== "pcm16" || ![8000, 16000, 24000].includes(rate)) {
    ws.close(1008, "pcm16 rate must be 8000, 16000, or 24000");
    return;
  }

  // Handshake (0x03 control frames).
  sendEvent(ws, { event: "hello", protocol: 2, call_id: callId, audio_in: `pcm16@${rate}`, audio_out: `pcm16@${outputRate}`, tags: { audio: 1, transcript: 2, control: 3 } });
  sendEvent(ws, { event: "session_started", call_id: callId, resumed: false });

  let configured = false;
  let turn = 0;

  let speaking = false;
  let playTimer = null;
  let turnTimer = null;
  const stopPlayback = () => {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    speaking = false;
  };

  // Agent turn: native turn_begin + assistant 0x03 advisory + 0x01 audio.
  const speak = () => {
    sendEvent(ws, { event: "turn_begin", call_id: callId, turn: ++turn });
    sendAssistantTranscript(ws, "This is omni-mock. A real Omni agent would answer here.");
    const pcm = tone(outputRate);
    const chunk = Math.floor(outputRate * 0.15) * 2;
    let off = 0;
    speaking = true;
    playTimer = setInterval(() => {
      if (!speaking || ws.readyState !== ws.OPEN || off >= pcm.length) return stopPlayback();
      ws.send(frame(TAG.AUDIO, pcm.subarray(off, off + chunk))); // 0x01
      off += chunk;
    }, 150);
  };

  const onCallerAudio = () => {
    if (speaking) {
      stopPlayback();
      sendEvent(ws, { event: "flush" });
      console.log("[turn] barge-in → flush");
    }
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(() => {
      sendCallerTranscript(ws, "(mock heard your audio)");
      speak();
    }, TURN_GAP_MS);
  };

  function handleControl(msg) {
    // Enforce the documented client envelope. Some engine versions accept an
    // event alias, but examples should send the canonical type field.
    if (msg.event && !msg.type) {
      sendEvent(ws, { event: "warning", code: "client_used_event_key", message: `Sent {"event":"${msg.event}"}; client→server frames are keyed on "type".` });
      console.error(`[BUG] client sent event-keyed frame {"event":"${msg.event}"}, use the documented client field instead. Use {"type":"${msg.event}"}.`);
      return;
    }
    switch (msg.type) {
      case "configure":
        if (!msg.persona) console.warn('[warn] configure had no "persona"');
        configured = true;
        sendEvent(ws, { event: "configured", call_id: callId, voice_id: msg.voice_id || "mock_voice", audio_out: `pcm16@${outputRate}`, playback_ack: false });
        console.log(`[cfg] configured voice_id=${msg.voice_id || "(default)"} persona=${msg.persona ? "set" : "MISSING"}`);
        break;
      case "dtmf":
        if (typeof msg.digit === "string" && /^[0-9*#a-d]$/i.test(msg.digit)) {
          sendEvent(ws, { event: "dtmf_received", call_id: callId, digit: msg.digit.toUpperCase() });
        }
        break;
      case "session_ending":
        sendEvent(ws, { event: "session_end" });
        ws.close(1000, "session_ending");
        break;
      default:
        console.warn(`[warn] unknown client frame type="${msg.type}"`);
    }
  }

  ws.on("message", (data, isBinary) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (isBinary && buf[0] === TAG.CONTROL) {
      // 0x03-prefixed client control frame (the engine's framing).
      try {
        handleControl(JSON.parse(buf.subarray(1).toString()));
      } catch {
        console.warn("[warn] 0x03 control frame had invalid JSON");
      }
      return;
    }
    if (!isBinary) {
      console.warn("[warn] ignored text frame; Omni requires binary type tags");
      return;
    }
    if (buf[0] === TAG.AUDIO) {
      if (!configured) {
        console.warn("[warn] ignored audio before configure");
        return;
      }
      onCallerAudio();
      return;
    }
    console.warn(`[warn] ignored unknown client binary tag 0x${(buf[0] ?? 0).toString(16).padStart(2, "0")}`);
  });

  ws.on("close", () => {
    stopPlayback();
    if (turnTimer) clearTimeout(turnTimer);
    console.log("[conn] closed");
  });
  ws.on("error", () => stopPlayback());
});

console.log(`omni-mock listening on ws://localhost:${PORT}/v1/omni`);
console.log("Faithful Omni v2 framing: server→client 0x01 audio / 0x02 transcript / 0x03 control. Demux on the first byte.");
