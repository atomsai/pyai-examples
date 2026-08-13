// One server-side PyAI Omni realtime session, the upstream half of the BROKER
// pattern (CONNECT_MODE=broker). This server holds the pyai_live_ key and opens
// the Omni socket on the visitor's behalf, relaying audio + events.
//
// In the preferred DIRECT pattern (CONNECT_MODE=direct) this file is unused: the
// browser mints a short-lived session token via POST /session and opens its own
// Omni socket (see public/app.js). The configure/audio protocol below is the
// same one the browser performs directly in that mode.
//
// Wire protocol (docs/OMNI_PROTOCOL_V2.md, mirrored from sdk/twilio/src/omni.ts):
//   - Connect to wss://api.pyai.com/v1/omni?format=pcm16&rate=24000 (with an
//     optional opaque session_label=<tag>).
//   - Auth on the upgrade via the subprotocol `pyai-key.<key>` (key is opaque).
//   - Right after open, send ONE 0x03-prefixed `configure` control frame:
//       { type:"configure", voice_id?, persona?, kb_endpoint?, kb_token? }
//     This example sends only voice_id/persona/kb_*; roadmap fields
//     (language/model_tier) are no-ops today and omitted.
//   - Audio is BINARY PCM16 little-endian in both directions, each frame
//     prefixed with the 0x01 type tag. The engine demuxes client frames on the
//     first byte and has no default branch, so an untagged frame is dropped
//     silently: a clean handshake, no transcripts, a deaf agent.
//   - Server frames are binary: 0x01 audio, 0x02 transcript body, 0x03 control.

import WebSocket from "ws";

const DEFAULT_BASE = "https://api.pyai.com";
const TAG_AUDIO = Buffer.from([0x01]);
const TAG_CONTROL = Buffer.from([0x03]);
const MAX_TRANSCRIPT_BYTES = 16_384;
const MAX_TRANSCRIPT_CHARS = 4_000;

function transcriptText(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TRANSCRIPT_CHARS &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    ? value
    : null;
}

/** The sole parser for the exact event-keyed JSON body carried by 0x02. */
export function normalizeOmniTranscriptBody(body) {
  if (!body?.length || body.length > MAX_TRANSCRIPT_BYTES) return null;
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  let value;
  try {
    value = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 4 || !["event", "role", "text", "final"].every((key) => keys.includes(key))) return null;
  if (value.event !== "transcript") return null;
  if (value.role !== "user" && value.role !== "assistant") return null;
  const text = transcriptText(value.text);
  if (!text || typeof value.final !== "boolean") return null;
  return {
    event: "transcript",
    role: value.role,
    text,
    final: value.final,
  };
}

/**
 * @typedef {Object} OmniSessionOptions
 * @property {string}  apiKey        pyai_live_ / pyai_test_ key (server-side only).
 * @property {string}  [sessionLabel] Optional opaque tag echoed to your kb_endpoint.
 * @property {string}  [baseURL]     Defaults to https://api.pyai.com.
 * @property {number}  [rate]        Sample rate (Hz). Default 24000.
 * @property {string}  [voice]       voice_id for the configure frame.
 * @property {string}  [persona]     System prompt for the brain.
 * @property {string}  [greeting]    Turn-0 line the agent speaks first.
 * @property {string}  [kbEndpoint]  Customer-hosted grounding URL (this server's /kb).
 * @property {string}  [kbToken]     Bearer the engine presents to kbEndpoint.
 * @property {() => void}                         [onReady]
 * @property {(pcm: Buffer) => void}              [onAudio]      Raw PCM16 LE bytes from the agent.
 * @property {(evt: Record<string, unknown>) => void} [onEvent]  Any JSON event frame.
 * @property {() => void}                         [onBargeIn]
 * @property {(code: number, reason: string) => void} [onClose]
 * @property {(err: Error) => void}               [onError]
 */

export class OmniSession {
  /** @param {OmniSessionOptions} opts */
  constructor(opts) {
    if (!opts.apiKey) throw new Error("OmniSession: apiKey is required");
    this.opts = opts;
    this.rate = opts.rate ?? 24000;
    this.open = false;
    this.closed = false;
    /** @type {Buffer[]} audio that arrived before the socket opened */
    this.backlog = [];

    const base = (opts.baseURL ?? DEFAULT_BASE).replace(/\/$/, "").replace(/^http/, "ws");
    const q = new URLSearchParams({
      format: "pcm16",
      rate: String(this.rate),
    });
    // session_label is optional, only attach it if we were given one.
    if (opts.sessionLabel) q.set("session_label", opts.sessionLabel);
    const url = `${base}/v1/omni?${q.toString()}`;

    this.ws = new WebSocket(url, [`pyai-key.${opts.apiKey}`]);
    this.ws.binaryType = "nodebuffer";
    this.ws.on("open", () => this.#handleOpen());
    this.ws.on("message", (data, isBinary) => this.#handleMessage(data, isBinary));
    this.ws.on("close", (code, reason) => {
      this.open = false;
      this.closed = true;
      this.opts.onClose?.(code, reason?.toString?.() ?? "");
    });
    this.ws.on("error", (err) => this.opts.onError?.(err));
  }

  #handleOpen() {
    this.open = true;
    // Supply the agent's behavior for THIS session. Stateless on PyAI: nothing
    // is stored, so everything the agent needs is in this one frame.
    // Client control is keyed on `type`; server control is keyed on `event`.
    const configure = { type: "configure" };
    if (this.opts.voice) configure.voice_id = this.opts.voice;
    if (this.opts.persona) configure.persona = this.opts.persona;
    if (this.opts.greeting) configure.greeting = this.opts.greeting;
    if (this.opts.kbEndpoint) configure.kb_endpoint = this.opts.kbEndpoint;
    if (this.opts.kbToken) configure.kb_token = this.opts.kbToken;
    this.#sendControl(configure);

    for (const chunk of this.backlog) this.ws.send(chunk);
    this.backlog.length = 0;
    this.opts.onReady?.();
  }

  #handleMessage(data, isBinary) {
    if (!isBinary) {
      this.opts.onError?.(new Error("Unexpected Omni text frame"));
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!buf.length) {
      this.opts.onError?.(new Error("Empty Omni binary frame"));
      return;
    }
    const tag = buf[0];
    if (tag === 0x01) {
      if (buf.length > 1) this.opts.onAudio?.(buf.subarray(1));
      return;
    }
    let evt;
    if (tag === 0x02) {
      evt = normalizeOmniTranscriptBody(buf.subarray(1));
      if (!evt) {
        this.opts.onError?.(new Error("Unparseable Omni transcript frame"));
        return;
      }
    } else if (tag === 0x03) {
      try {
        evt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(1)));
        if (!evt || typeof evt !== "object" || Array.isArray(evt)) throw new Error();
      } catch {
        this.opts.onError?.(new Error("Unparseable Omni control frame"));
        return;
      }
    } else {
      this.opts.onError?.(new Error(`Unknown Omni binary frame tag 0x${tag.toString(16).padStart(2, "0")}`));
      return;
    }
    if (typeof evt.event !== "string" || !evt.event) {
      this.opts.onError?.(new Error("Omni server control frame is missing its event key"));
      return;
    }
    if (tag === 0x03 && evt.event === "transcript") {
      this.opts.onError?.(new Error("Omni transcript events must use a binary 0x02 frame"));
      return;
    }
    this.opts.onEvent?.(evt);
    const event = evt.event;
    if (event === "barge_in" || event === "flush") this.opts.onBargeIn?.();
    else if (event === "session_end") this.close();
  }

  #sendControl(obj) {
    if (this.closed) return;
    try {
      this.ws.send(Buffer.concat([TAG_CONTROL, Buffer.from(JSON.stringify(obj))]));
    } catch {
      /* socket not ready / closing */
    }
  }

  /** Forward one chunk of caller PCM16 LE audio upstream as a 0x01-prefixed
   *  frame (buffers until open). */
  sendAudio(bytes) {
    if (this.closed || !bytes?.length) return;
    // Tag here, once: the backlog is flushed verbatim in #handleOpen().
    const frame = Buffer.concat([TAG_AUDIO, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)]);
    if (this.open) this.ws.send(frame);
    else this.backlog.push(frame);
  }

  /** Forward a DTMF digit (e.g. from an on-screen keypad). */
  sendDtmf(digit) {
    this.#sendControl({ type: "dtmf", digits: digit });
  }

  close(code = 1000, reason = "client_closed") {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    try {
      this.ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }
}
