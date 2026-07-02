/**
 * PyAI AMD, Twilio drop-in example (zero dependencies, Node >= 22).
 *
 * Two tiny endpoints:
 *   GET/POST /twiml       -> the ONE line of TwiML that forks the call's media to
 *                            PyAI AMD. Point your Twilio number's Voice webhook here.
 *   POST     /amd-events  -> receives the `amd.call.completed` decision PyAI posts
 *                            once it knows who/what answered.
 *
 * On boot it also sets the account-default operating point via POST /v1/amd/config.
 * There is nothing else to run: PyAI speaks Twilio's Media Streams protocol
 * natively, so the WebSocket detection happens between Twilio and PyAI directly.
 */

import { createServer } from "node:http";

const API_KEY = process.env.PYAI_API_KEY;
const BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const PORT = Number(process.env.PORT || 3000);
const AGGRESSIVENESS = Number(process.env.AMD_AGGRESSIVENESS ?? 0.25);
const PYAI_BASE = "https://api.pyai.com/v1";

if (!API_KEY) {
  console.error("Set PYAI_API_KEY (copy .env.example -> .env). Get one: curl -sX POST https://api.pyai.com/v1/sandbox/keys");
  process.exit(1);
}
if (!BASE_URL) {
  console.error("Set PUBLIC_BASE_URL to where Twilio + PyAI can reach this server (e.g. an ngrok/cloudflared URL).");
  process.exit(1);
}

/** Set the account default operating point + point AMD's webhook back at us. */
async function configureAmd() {
  const res = await fetch(`${PYAI_BASE}/amd/config`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ aggressiveness: AGGRESSIVENESS, webhook_url: `${BASE_URL}/amd-events` }),
  });
  if (!res.ok) {
    throw new Error(`POST /v1/amd/config failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * The whole integration: one <Stream> that points the call's media at PyAI AMD.
 * The per-call `aggressiveness` <Parameter> overrides the account default; the
 * `webhook` <Parameter> is where PyAI posts this call's decision.
 */
const escapeXml = (s) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

function twiml() {
  // Twilio cannot send auth headers, WS subprotocols, or even URL query params
  // on <Stream> (the query string is stripped before connecting). The key
  // travels as a <Parameter>: PyAI verifies it from the stream's `start` frame
  // before processing any audio, and drops connections that never present one.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://api.pyai.com/v1/amd/stream">
      <Parameter name="api_key" value="${escapeXml(API_KEY)}"/>
      <Parameter name="aggressiveness" value="${AGGRESSIVENESS}"/>
      <Parameter name="webhook" value="${BASE_URL}/amd-events"/>
    </Stream>
  </Connect>
</Response>`;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/twiml") {
    res.writeHead(200, { "content-type": "text/xml" });
    res.end(twiml());
    return;
  }

  if (url.pathname === "/amd-events" && req.method === "POST") {
    const body = await readBody(req);
    let event = {};
    try {
      event = JSON.parse(body);
    } catch {
      /* ignore non-JSON */
    }
    // event: { event: "amd.call.completed", call_id, answered_by,
    //          answered_by_twilio, confidence, decision_ms, reason, ... }
    console.log(
      `[AMD] call=${event.call_id} answered_by=${event.answered_by} ` +
        `(twilio=${event.answered_by_twilio}) in ${event.decision_ms}ms, ${event.reason ?? ""}`,
    );
    // Branch your dialer logic on event.answered_by here:
    //   human            -> connect the agent
    //   voicemail / fax  -> drop a message or hang up
    //   screening        -> your Omni agent can answer the screener
    //   sit_invalid      -> scrub the number from your list
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found. Point your Twilio number's Voice webhook at /twiml.");
});

const cfg = await configureAmd();
console.log(`AMD configured: aggressiveness=${cfg.aggressiveness}, webhook=${BASE_URL}/amd-events`);
server.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log(`Point your Twilio number's Voice webhook at: ${BASE_URL}/twiml`);
  console.log(`PyAI will POST answering-machine decisions to: ${BASE_URL}/amd-events`);
});
