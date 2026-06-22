// omni-mock — an offline PyAI Omni server you can build against before you have
// a key. It speaks the Omni wire protocol v2 (docs/OMNI_PROTOCOL_V2.md) with the
// engine's real BINARY, TYPE-PREFIXED framing so your client is correct on the
// day you swap in a real key:
//
//   server → client binary frames are tagged by their first byte:
//     0x01 = agent audio (PCM16)   0x02 = transcript (JSON)   0x03 = control/event JSON
//   client → server: control frames (configure/dtmf) are 0x03-prefixed JSON;
//   caller audio is PCM16 (raw, or 0x01-tagged — both accepted here).
//
// Point your real Omni client at it:
//   wss://api.pyai.com/v1/omni  →  ws://localhost:8787/v1/omni
//
// It is NOT a model — the "agent" replies with a tone + a canned transcript. The
// point is the *protocol*: if your client treats every binary frame as audio (the
// classic bug), it will play the 0x03/0x02 frames as a glitch and never see the
// events — exactly as it would fail against prod. Demux on the first byte.
//
// Run: cp .env.example .env  &&  npm install  &&  npm start
import { WebSocketServer } from "ws";
import { parse } from "node:url";

const PORT = Number(process.env.PORT ?? 8787);
const TURN_GAP_MS = Number(process.env.TURN_GAP_MS ?? 700);

// Frame type tags (first byte of every server→client binary frame).
const TAG = { AUDIO: 0x01, TRANSCRIPT: 0x02, CONTROL: 0x03 };
const frame = (tag, payload) =>
  Buffer.concat([Buffer.from([tag]), Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload))]);

const wss = new WebSocketServer({ port: PORT });

/** A short PCM16 LE sine tone at `rate` Hz — stand-in agent audio. */
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
const sendTranscript = (ws, obj) => ws.readyState === ws.OPEN && ws.send(frame(TAG.TRANSCRIPT, obj)); // 0x02

wss.on("connection", (ws, req) => {
  const { pathname, query } = parse(req.url ?? "", true);
  const format = query.format || "pcm16";
  const rate = Number(query.rate) || 24000;
  const label = query.session_label || query.agent_id || null;

  console.log(`\n[conn] ${pathname}  format=${format} rate=${rate}${label ? ` session_label=${label}` : ""}`);
  if (pathname !== "/v1/omni" && pathname !== "/v2/omni/chat")
    console.warn(`[warn] path "${pathname}" — the real endpoint is wss://api.pyai.com/v1/omni`);

  // Handshake (0x03 control frames).
  sendEvent(ws, { event: "hello", protocol: 2, audio_in: `${format}@${rate}`, audio_out: `${format}@${rate}`, server: "omni-mock" });
  sendEvent(ws, { event: "session_started", agent_id: label, audio_in: format, audio_out: format });

  let speaking = false;
  let playTimer = null;
  let turnTimer = null;
  const stopPlayback = () => {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    speaking = false;
  };

  // Agent turn: turn event + a 0x02 transcript + 0x01 audio streamed in 150ms chunks.
  const speak = () => {
    sendEvent(ws, { event: "turn", role: "assistant" });
    sendTranscript(ws, { role: "assistant", final: true, text: "This is omni-mock. A real Omni agent would answer here." });
    const pcm = tone(rate);
    const chunk = Math.floor(rate * 0.15) * 2;
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
      sendTranscript(ws, { role: "user", final: true, text: "(mock heard your audio)" });
      speak();
    }, TURN_GAP_MS);
  };

  function handleControl(msg) {
    // CONFORMANCE: client → server frames are keyed on `type`. Catch the classic
    // event-keyed configure the real engine ACKs and then silently drops.
    if (msg.event && !msg.type) {
      sendEvent(ws, { event: "warning", code: "client_used_event_key", message: `Sent {"event":"${msg.event}"}; client→server frames are keyed on "type".` });
      console.error(`[BUG] client sent event-keyed frame {"event":"${msg.event}"} — real engine drops this. Use {"type":"${msg.event}"}.`);
      return;
    }
    switch (msg.type) {
      case "configure":
        if (!msg.persona) console.warn('[warn] configure had no "persona"');
        sendEvent(ws, { event: "config_ack", voice_id: msg.voice_id || "mock_voice", honored: Object.keys(msg).filter((k) => k !== "type"), ignored: [] });
        console.log(`[cfg] config_ack voice_id=${msg.voice_id || "(default)"} persona=${msg.persona ? "set" : "MISSING"}`);
        break;
      case "dtmf":
        sendEvent(ws, { event: "dtmf", digit: String(msg.digit ?? "") });
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
      // Legacy text control frame — tolerated, but nudge toward 0x03.
      try {
        const msg = JSON.parse(buf.toString());
        console.warn('[warn] control sent as a TEXT frame; the engine expects a 0x03-prefixed binary frame');
        handleControl(msg);
      } catch {
        /* ignore */
      }
      return;
    }
    // Otherwise: caller audio — PCM16, raw or 0x01-tagged.
    onCallerAudio();
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
