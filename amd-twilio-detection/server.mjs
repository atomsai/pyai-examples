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
    const route = routeCall(event);
    console.log(
      `[AMD] call=${event.call_id} answered_by=${event.answered_by} ` +
        `(twilio=${event.answered_by_twilio}) in ${event.decision_ms}ms, ${event.reason ?? ""}` +
        ` -> ${route.action}`,
    );
    // `route.action` is where your dialer takes over: connect the agent, start a
    // voicemail drop, navigate the menu, scrub the number. Everything above this
    // line is PyAI; everything below it is your business logic.
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found. Point your Twilio number's Voice webhook at /twiml.");
});

/**
 * Decide what the dialer should DO with a decision.
 *
 * NOTE the field: on THIS webhook `answered_by` carries the machine SUBTYPE
 * (`voicemail` / `ivr` / `screening` / `music`), while the event pushed on the
 * WebSocket carries only the coarse class (`human` / `machine` / `sit_invalid` /
 * `unknown`). Same field name, different value space, so branch on the webhook if
 * you need the subtype -- that is the whole reason this example uses it.
 *
 * The expensive mistake this function exists to prevent: treating every `machine`
 * as a voicemail. `voicemail`, `ivr` and `screening` are all machines, but a
 * message dropped into a phone tree or an AI screener is simply lost.
 */
function routeCall(event) {
  switch (event.answered_by) {
    case "human":
      // A person. Connect the agent.
      return { action: "connect_agent" };

    case "voicemail":
      // The only case where dropping a message is correct. Wait for the record
      // tone rather than assuming one -- some systems never emit a beep, and
      // talking over the greeting loses the start of your message.
      return { action: "drop_voicemail", waitForBeep: true };

    case "ivr":
      // A phone tree. DO NOT drop a message: nobody will ever hear it. Either
      // navigate the menu (DTMF) or abandon and retry.
      return { action: "navigate_or_abandon" };

    case "screening":
      // An AI screener (iPhone Live Voicemail / Google Call Screen) is relaying
      // to a real person who may still pick up. Treat it as a live-ish path, not
      // as voicemail -- a two-way agent can answer the screener's question.
      return { action: "engage_screener" };

    case "music":
      // Hold music or ringback: nothing has been said yet. Keep waiting.
      return { action: "keep_waiting" };

    case "sit_invalid":
      // Carrier intercept -- the number is dead. Scrub it; retrying burns spend
      // and hurts your dialing reputation.
      return { action: "scrub_number" };

    case "unknown":
      // No decisive evidence inside the window. `silence` means the call was
      // answered but nothing came down the line at all: retry later rather than
      // burning an agent slot on dead air. Everything else falls back to your own
      // default -- see `aggressiveness` in the README for which way to lean.
      return event.subtype === "silence"
        ? { action: "retry_later" }
        : { action: "apply_default" };

    default:
      // Unrecognised value: fail SAFE for a live-agent dialer. Never assume a
      // machine on a value you do not understand -- that is the one error a
      // person actually experiences.
      return { action: "apply_default" };
  }
}

const cfg = await configureAmd();
console.log(`AMD configured: aggressiveness=${cfg.aggressiveness}, webhook=${BASE_URL}/amd-events`);
server.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log(`Point your Twilio number's Voice webhook at: ${BASE_URL}/twiml`);
  console.log(`PyAI will POST answering-machine decisions to: ${BASE_URL}/amd-events`);
});
