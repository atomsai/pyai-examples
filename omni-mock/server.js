// omni-mock — an offline PyAI Omni server you can build against before you have
// a key. It speaks the Omni wire protocol v2 (docs/OMNI_PROTOCOL_V2.md): the
// hello/session_started/configured handshake, binary PCM16 audio both ways,
// barge-in (flush), transcripts, and DTMF. Point your real Omni client at it:
//
//   wss://api.pyai.com/v1/omni   →   ws://localhost:8787/v1/omni
//
// It is NOT a model — the "agent" replies with a short tone and a canned
// transcript. Its real job is to let you wire and test your client (capture,
// framing, playback, barge-in, event parsing) with zero cost and zero key.
//
// CONFORMANCE AID: it catches the #1 Omni integration bug — sending an
// event-keyed configure ({"event":"configure"}) instead of a type-keyed one
// ({"type":"configure"}). The real gateway is transparent and would ACK it while
// the engine silently drops your persona (clean handshake, zero turns, no error).
// omni-mock tells you loudly instead.
//
// Run: cp .env.example .env  &&  npm install  &&  npm start
import { WebSocketServer } from "ws";
import { parse } from "node:url";

const PORT = Number(process.env.PORT ?? 8787);
const TURN_GAP_MS = Number(process.env.TURN_GAP_MS ?? 700); // silence that ends a user turn

const wss = new WebSocketServer({ port: PORT });

/** A short PCM16 little-endian sine tone at `rate` Hz — stand-in agent audio. */
function tone(rate, ms = 900, freq = 440) {
  const n = Math.floor((rate * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.sin((2 * Math.PI * freq * i) / rate) * 0.3;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
  }
  return buf;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws, req) => {
  const { pathname, query } = parse(req.url ?? "", true);
  const okPath = pathname === "/v1/omni" || pathname === "/v2/omni/chat";
  const format = query.format || "pcm16";
  const rate = Number(query.rate) || 24000;
  const label = query.session_label || query.agent_id || null;

  console.log(`\n[conn] ${pathname}  format=${format} rate=${rate}${label ? ` session_label=${label}` : ""}`);
  if (!okPath) console.warn(`[warn] path "${pathname}" is not /v1/omni — the real endpoint is wss://api.pyai.com/v1/omni`);
  if (format !== "pcm16") console.warn(`[warn] format="${format}" — Omni speaks pcm16; the SDK sets ?format=pcm16`);

  // Handshake: hello → session_started (server frames are keyed on `event`).
  send(ws, { event: "hello", protocol: "v2", audio_in: format, audio_out: format, server: "omni-mock" });
  send(ws, { event: "session_started", agent_id: label, audio_in: format, audio_out: format });

  let configured = false;
  let speaking = false;
  let playTimer = null;
  let turnTimer = null;

  const stopPlayback = () => {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    speaking = false;
  };

  // The "agent" speaks: a turn event, a transcript, then the tone streamed in
  // 150 ms chunks so a client can barge in mid-playback.
  const speak = () => {
    send(ws, { event: "turn", role: "assistant" });
    send(ws, {
      event: "transcript",
      role: "assistant",
      final: true,
      text: "This is omni-mock. A real Omni agent would answer here.",
    });
    const pcm = tone(rate);
    const chunk = Math.floor(rate * 0.15) * 2; // 150 ms
    let off = 0;
    speaking = true;
    playTimer = setInterval(() => {
      if (!speaking || ws.readyState !== ws.OPEN || off >= pcm.length) return stopPlayback();
      ws.send(pcm.subarray(off, off + chunk));
      off += chunk;
    }, 150);
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // Caller audio. If the agent is mid-utterance, this is a barge-in.
      if (speaking) {
        stopPlayback();
        send(ws, { event: "flush" });
        console.log("[turn] barge-in: caller spoke over the agent → flush");
      }
      // Debounce: a TURN_GAP_MS gap of no audio ends the user's turn.
      if (turnTimer) clearTimeout(turnTimer);
      turnTimer = setTimeout(() => {
        send(ws, { event: "transcript", role: "user", final: true, text: "(mock heard your audio)" });
        speak();
      }, TURN_GAP_MS);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.warn("[warn] non-JSON text frame ignored");
      return;
    }

    // CONFORMANCE: client → server frames MUST be keyed on `type`. Catch the
    // classic event-keyed configure that the real engine would silently drop.
    if (msg.event && !msg.type) {
      send(ws, {
        event: "warning",
        code: "client_used_event_key",
        message: `You sent {"event":"${msg.event}",…}. Client→server frames are keyed on "type" (e.g. {"type":"configure"}). The real engine would ACK and then silently drop your config — send "type".`,
      });
      console.error(`[BUG] client sent event-keyed frame {"event":"${msg.event}"} — real engine drops this silently. Use {"type":"${msg.event}"}.`);
      return;
    }

    switch (msg.type) {
      case "configure":
        configured = true;
        if (!msg.persona) console.warn('[warn] configure had no "persona" — the agent has no instructions');
        send(ws, { event: "configured", voice_id: msg.voice_id || "mock_voice" });
        console.log(`[cfg] configured voice_id=${msg.voice_id || "(default)"} persona=${msg.persona ? "set" : "MISSING"}`);
        break;
      case "dtmf":
        console.log(`[dtmf] ${msg.digit}`);
        send(ws, { event: "dtmf", digit: String(msg.digit ?? "") });
        break;
      case "session_ending":
        send(ws, { event: "session_end" });
        ws.close(1000, "session_ending");
        break;
      default:
        console.warn(`[warn] unknown client frame type="${msg.type}"`);
    }
    if (!configured) console.warn("[warn] sending audio before configure — send {type:'configure'} first");
  });

  ws.on("close", () => {
    stopPlayback();
    if (turnTimer) clearTimeout(turnTimer);
    console.log("[conn] closed");
  });
  ws.on("error", () => stopPlayback());
});

console.log(`omni-mock listening on ws://localhost:${PORT}/v1/omni  (point your Omni client here)`);
console.log("It speaks Omni protocol v2 offline: hello → session_started → configured, PCM16 both ways, barge-in, DTMF.");
