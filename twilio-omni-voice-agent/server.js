// A complete phone voice agent: a real Twilio call <-> a PyAI Omni agent.
//
// Twilio fetches TwiML from POST /voice, which opens a bidirectional Media
// Streams socket to GET /media. `OmniAgent.bridge` does everything else:
// mu-law<->PCM16 transcode + resampling, the Omni handshake, barge-in, and DTMF.
//
// Run:  cp .env.example .env  &&  edit it  &&  npm start
// Then expose it (e.g. `ngrok http 8080`) and point your Twilio number's
// "A call comes in" webhook at  https://<public-host>/voice

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { OmniAgent, connectStreamTwiML } from "@pyai/twilio";

const {
  PYAI_API_KEY,
  PYAI_AGENT_ID = "support-bot",
  PYAI_VOICE,
  PYAI_BASE_URL,
  PUBLIC_HOST,
  PORT = "8080",
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  HUMAN_NUMBER,
} = process.env;

if (!PYAI_API_KEY) {
  console.error("Missing PYAI_API_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const app = Fastify({ logger: true });
await app.register(websocket);

// 1) Twilio hits this when a call comes in. Return TwiML that opens a two-way
//    stream back to us. (Use the public host Twilio can reach, e.g. your tunnel.)
app.post("/voice", (req, reply) => {
  const host = PUBLIC_HOST || req.headers.host;
  reply
    .type("text/xml")
    .send(connectStreamTwiML(`wss://${host}/media`, { greeting: "Connecting you to our assistant." }));
});

// 2) Twilio opens the media WebSocket here. One line bridges it to Omni.
app.get("/media", { websocket: true }, (twilioWS) => {
  const bridge = OmniAgent.bridge(twilioWS, {
    apiKey: PYAI_API_KEY,
    agentId: PYAI_AGENT_ID,
    voice: PYAI_VOICE,
    baseURL: PYAI_BASE_URL, // omit in prod; defaults to https://api.pyai.com
    persona: "You are a warm, concise phone support agent for Acme Co. Keep replies short.",

    // Optional per-turn grounding. Swap this stub for your real KB / vector
    // search; whatever you return is forwarded to the agent for the turn.
    knowledge: async (query) => {
      // const hits = await myVectorDB.search(query, { k: 3 });
      // return hits.map((h) => h.text).join("\n");
      return `No knowledge base wired up yet. The caller asked: ${query}`;
    },

    onTranscript: (t) => {
      if (t.final) app.log.info(`[${t.role ?? "caller"}] ${t.text}`);
    },
    // Omni asks to hand off to a human -> redirect the live Twilio call.
    onTransfer: (info) => transferToHuman(bridge.callSid, info),
    onError: (err) => app.log.error(err),
  });
});

// Replace the live call's TwiML with a <Dial> to a human, via Twilio's REST API.
// Uses plain fetch + Basic auth so this example needs no extra dependency.
async function transferToHuman(callSid, info) {
  if (!callSid || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !HUMAN_NUMBER) {
    app.log.warn({ info }, "transfer requested, but Twilio creds / HUMAN_NUMBER are not set");
    return;
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Twiml: `<Response><Dial>${HUMAN_NUMBER}</Dial></Response>` }),
  });
  if (!res.ok) app.log.error(`transfer failed: ${res.status} ${await res.text()}`);
}

await app.listen({ port: Number(PORT), host: "0.0.0.0" });
app.log.info(`Set your Twilio number's voice webhook to https://<public-host>/voice (POST)`);
