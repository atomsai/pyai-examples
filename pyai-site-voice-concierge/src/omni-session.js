// One server-side PyAI Omni realtime session — the upstream half of the BROKER
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
//     optional opaque session_label=<tag>; agent_id is a deprecated alias).
//   - Auth on the upgrade via the subprotocol `pyai-key.<key>` (key is opaque).
//   - Right after open, send ONE `configure` control frame as JSON TEXT:
//       { type:"configure", voice_id?, persona?, kb_endpoint?, kb_token? }
//     This example sends only voice_id/persona/kb_*; roadmap fields
//     (language/model_tier) are no-ops today and omitted.
//   - Audio is BINARY PCM16 little-endian in both directions.
//   - Session events (session_started, transcript, barge_in, …) are TEXT JSON.

import WebSocket from "ws";

const DEFAULT_BASE = "https://api.pyai.com";

/**
 * @typedef {Object} OmniSessionOptions
 * @property {string}  apiKey        pyai_live_ / pyai_test_ key (server-side only).
 * @property {string}  [sessionLabel] Optional opaque tag echoed to your kb_endpoint.
 * @property {string}  [baseURL]     Defaults to https://api.pyai.com.
 * @property {number}  [rate]        Sample rate (Hz). Default 24000.
 * @property {string}  [voice]       voice_id for the configure frame.
 * @property {string}  [persona]     System prompt for the brain.
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
    // session_label is optional — only attach it if we were given one.
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
    const configure = { type: "configure" };
    if (this.opts.voice) configure.voice_id = this.opts.voice;
    if (this.opts.persona) configure.persona = this.opts.persona;
    if (this.opts.kbEndpoint) configure.kb_endpoint = this.opts.kbEndpoint;
    if (this.opts.kbToken) configure.kb_token = this.opts.kbToken;
    this.#sendText(configure);

    for (const chunk of this.backlog) this.ws.send(chunk);
    this.backlog.length = 0;
    this.opts.onReady?.();
  }

  #handleMessage(data, isBinary) {
    if (isBinary) {
      // Agent speech: PCM16 LE bytes, ready to relay straight to the browser.
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length) this.opts.onAudio?.(buf);
      return;
    }
    let evt;
    try {
      evt = JSON.parse(data.toString());
    } catch {
      return; // ignore non-JSON keepalives
    }
    this.opts.onEvent?.(evt);
    const type = typeof evt.type === "string" ? evt.type : "";
    if (type === "barge_in" || type === "flush") this.opts.onBargeIn?.();
    else if (type === "session_end" || type === "session_ending") this.close();
  }

  #sendText(obj) {
    if (this.closed) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {
      /* socket not ready / closing */
    }
  }

  /** Forward one chunk of caller PCM16 LE audio upstream (buffers until open). */
  sendAudio(bytes) {
    if (this.closed || !bytes?.length) return;
    if (this.open) this.ws.send(bytes);
    else this.backlog.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  }

  /** Forward a DTMF digit (e.g. from an on-screen keypad). */
  sendDtmf(digit) {
    this.#sendText({ type: "dtmf", digit });
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
