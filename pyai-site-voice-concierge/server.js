// "Talk to PyAI" — the voice concierge for pyai.com.
//
// One small Fastify server, two supported web patterns (set CONNECT_MODE):
//
//   • CONNECT_MODE=direct (preferred) — the browser connects to PyAI DIRECTLY
//     using a short-lived, origin-locked SESSION TOKEN this server mints. The
//     server stays out of the media path; the pyai_live_ key never leaves it.
//
//       browser ──POST /session──▶ this server ──POST /v1/omni/sessions──▶ PyAI
//       browser ──wss /v1/omni (pyai-key.<ephemeral token>)─────────────▶ PyAI
//
//   • CONNECT_MODE=broker (fallback) — the browser opens a WebSocket to /voice
//     on THIS server, which relays audio + events to an Omni socket opened with
//     the server-side key. Heavier (server is in the media path), but useful if
//     you want to inspect/transform the stream.
//
//       browser ──ws /voice──▶ this server ──wss /v1/omni (pyai-key.<key>)──▶ PyAI
//
// In BOTH modes this server is also the kb_endpoint: the PyAI engine POSTs
// { session_label, query } to /kb each turn for grounding (publicly reachable,
// authed by the kb_token). See docs/OMNI_EPHEMERAL_SESSION_TOKENS.md.
//
// Run:  cp .env.example .env  &&  edit it  &&  npm start

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";

import { OmniSession } from "./src/omni-session.js";
import { retrieve } from "./src/knowledge.js";
import { PERSONA, GREETING } from "./src/persona.js";

const {
  PYAI_API_KEY,
  // Optional opaque tag echoed to our kb_endpoint. PYAI_AGENT_ID is the legacy
  // alias; prefer PYAI_SESSION_LABEL.
  PYAI_SESSION_LABEL = process.env.PYAI_AGENT_ID ?? "pyai-site-concierge",
  PYAI_VOICE,
  PYAI_BASE_URL = "https://api.pyai.com",
  PORT = "8787",
  KB_PUBLIC_URL = "",
  KB_TOKEN = "",
  ALLOWED_ORIGINS = "",
  MAX_CONCURRENT_SESSIONS = "25",
  // "direct" (preferred: mint a token, browser connects to PyAI directly) or
  // "broker" (relay through this server). Default direct.
  CONNECT_MODE = "direct",
  // Lifetime of a minted browser session token (seconds). Short by design.
  SESSION_TTL_SECONDS = "60",
} = process.env;

if (!PYAI_API_KEY) {
  console.error("Missing PYAI_API_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const connectMode = CONNECT_MODE === "broker" ? "broker" : "direct";
const sessionTtl = Math.max(15, Math.min(600, Number(SESSION_TTL_SECONDS) || 60));
const allowedOrigins = ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);

// The engine's grounding callback must hit a PUBLIC url. On a one-click cloud
// deploy (Render/Railway/Fly set RENDER_EXTERNAL_URL or PUBLIC_URL), derive
// /kb from it so grounding works with zero extra config — no ngrok. An explicit
// KB_PUBLIC_URL always wins.
const publicBase = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || "").replace(/\/$/, "");
const kbPublicUrl = KB_PUBLIC_URL || (publicBase ? `${publicBase}/kb` : "");
const maxSessions = Number(MAX_CONCURRENT_SESSIONS) || 25;
let liveSessions = 0;

const here = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true });
await app.register(fastifyWebsocket);
await app.register(fastifyStatic, { root: join(here, "public") });

// --- 1. Health -------------------------------------------------------------
app.get("/health", async () => ({
  ok: true,
  mode: connectMode,
  session_label: PYAI_SESSION_LABEL,
  grounding: Boolean(kbPublicUrl && KB_TOKEN),
  live_sessions: liveSessions,
}));

// The browser reads this on load to learn which connect pattern to use.
app.get("/config", async () => ({ mode: connectMode }));

// --- Mint an ephemeral Omni session token (CONNECT_MODE=direct) ------------
// The browser POSTs here; we mint a short-lived, origin-locked token with our
// server-side key and hand it back. The browser then opens the Omni WebSocket
// DIRECTLY with `pyai-key.<token>` — our key never leaves this process, and the
// token is useless after ~60s or from any other origin. The grounding config
// (kb_endpoint/kb_token, persona, voice) travels in the browser's `configure`
// frame; the kb_token is a server secret, so we return it here only because
// this same server hosts /kb — lock /session down (auth/CAPTCHA/rate-limit) for
// a real public page.
app.post("/session", async (request, reply) => {
  const origin = (request.headers.origin || "").trim();
  if (allowedOrigins.length > 0 && origin && !allowedOrigins.includes(origin)) {
    return reply.code(403).send({ error: "origin_not_allowed" });
  }
  // The token must be locked to a real origin. Prefer the request Origin when it
  // is in our allow-list; otherwise fall back to the configured allow-list (or,
  // in local dev with no allow-list, the request Origin / localhost).
  const lockedOrigins =
    allowedOrigins.length > 0 ? allowedOrigins : origin ? [origin] : [`http://localhost:${PORT}`];

  const groundingOn = Boolean(kbPublicUrl && KB_TOKEN);
  try {
    const res = await fetch(`${PYAI_BASE_URL.replace(/\/$/, "")}/v1/omni/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PYAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        allowed_origins: lockedOrigins,
        ttl_seconds: sessionTtl,
        session_label: PYAI_SESSION_LABEL,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      app.log.error({ status: res.status, detail }, "mint /v1/omni/sessions failed");
      return reply.code(502).send({ error: "mint_failed" });
    }
    const session = await res.json();
    // The Omni engine derives the session's agent from the gateway-stamped
    // `x-pyai-agent` header, which the gateway sets from the connect URL's
    // `session_label`. The mint returns a label-less URL, so attach it here:
    // without a label the engine takes its keystore fallback path (and if that
    // keystore is unconfigured upstream, the socket closes 4401 immediately).
    const sep = session.url.includes("?") ? "&" : "?";
    const omniUrl = `${session.url}${sep}session_label=${encodeURIComponent(PYAI_SESSION_LABEL)}`;
    // Hand the browser everything it needs to connect + configure itself.
    return {
      token: session.token,
      url: omniUrl,
      expires_at: session.expires_at,
      configure: {
        // The Omni engine dispatches control frames on `event` (it ignores a
        // frame whose `event` it doesn't recognize), so a configure MUST carry
        // `event: "configure"`. `type` is kept for back-compat / other tooling.
        event: "configure",
        type: "configure",
        ...(PYAI_VOICE ? { voice_id: PYAI_VOICE } : {}),
        persona: PERSONA,
        greeting: GREETING,
        ...(groundingOn ? { kb_endpoint: kbPublicUrl, kb_token: KB_TOKEN } : {}),
      },
      grounding: groundingOn,
    };
  } catch (err) {
    app.log.error({ err: err?.message }, "mint /session error");
    return reply.code(502).send({ error: "mint_failed" });
  }
});

// --- 2. kb_endpoint: the engine's per-turn grounding callback --------------
// The engine presents `Authorization: Bearer <kb_token>` (the token we put in
// the configure frame). Keep this fast and fail-soft: it's on the turn hot path
// with a hard ~300 ms budget on the engine side.
app.post("/kb", async (request, reply) => {
  if (KB_TOKEN) {
    const auth = request.headers.authorization ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (presented !== KB_TOKEN) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  }
  const body = request.body ?? {};
  const query = typeof body.query === "string" ? body.query : "";
  // The engine echoes whatever connect-URL tag we used. Accept the new
  // session_label and the legacy agent_id; fall back to our configured label.
  const sessionLabel =
    typeof body.session_label === "string" ? body.session_label
    : typeof body.agent_id === "string" ? body.agent_id
    : PYAI_SESSION_LABEL;

  const results = retrieve(query, 3);
  // Return both a ready-to-inject `context` string and the structured passages,
  // plus echo the label/query, so the engine can use whichever shape it prefers.
  return {
    session_label: sessionLabel,
    query,
    context: results.map((r) => `- ${r.content}`).join("\n"),
    results,
  };
});

// --- 3. The voice broker: browser WebSocket <-> Omni -----------------------
app.get("/voice", { websocket: true }, (browser, request) => {
  // Origin allow-list (skip when none configured, e.g. local dev).
  const origin = request.headers.origin;
  if (allowedOrigins.length > 0 && origin && !allowedOrigins.includes(origin)) {
    app.log.warn({ origin }, "rejected voice connection: origin not allowed");
    browser.close(1008, "origin_not_allowed");
    return;
  }
  // Cost guard: cap concurrent live sessions this broker holds open.
  if (liveSessions >= maxSessions) {
    sendEvent(browser, { type: "error", code: "busy", message: "All lines are busy — try again in a moment." });
    browser.close(1013, "max_sessions");
    return;
  }
  liveSessions++;

  const groundingOn = Boolean(kbPublicUrl && KB_TOKEN);
  const omni = new OmniSession({
    apiKey: PYAI_API_KEY,
    sessionLabel: PYAI_SESSION_LABEL,
    baseURL: PYAI_BASE_URL,
    voice: PYAI_VOICE,
    persona: PERSONA,
    greeting: GREETING,
    kbEndpoint: groundingOn ? kbPublicUrl : undefined,
    kbToken: groundingOn ? KB_TOKEN : undefined,
    rate: 24000,

    onReady: () => sendEvent(browser, { type: "ready", grounding: groundingOn }),
    // Agent speech: forward the raw PCM16 bytes to the browser as a binary frame.
    onAudio: (pcm) => {
      if (browser.readyState === browser.OPEN) browser.send(pcm);
    },
    // Surface transcripts / turn / barge_in events to the browser UI verbatim.
    onEvent: (evt) => sendEvent(browser, evt),
    onClose: (code, reason) => {
      sendEvent(browser, { type: "session_end", code, reason });
      if (browser.readyState === browser.OPEN) browser.close(1000, "omni_closed");
    },
    onError: (err) => {
      app.log.error({ err: err?.message }, "omni session error");
      sendEvent(browser, { type: "error", code: "omni_error", message: "Voice service error." });
    },
  });

  // Browser -> Omni. Binary frames are mic PCM16; text frames are control
  // (e.g. {type:"dtmf"}). Audio is the overwhelmingly common case.
  browser.on("message", (data, isBinary) => {
    if (isBinary) {
      omni.sendAudio(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg?.type === "dtmf" && typeof msg.digit === "string") omni.sendDtmf(msg.digit);
    } catch {
      /* ignore malformed control frames */
    }
  });

  const cleanup = () => {
    omni.close();
    liveSessions = Math.max(0, liveSessions - 1);
  };
  browser.on("close", cleanup);
  browser.on("error", cleanup);
});

function sendEvent(socket, obj) {
  if (socket.readyState === socket.OPEN) {
    try {
      socket.send(JSON.stringify(obj));
    } catch {
      /* socket closing */
    }
  }
}

await app.listen({ port: Number(PORT), host: "0.0.0.0" });
app.log.info(`Voice concierge on http://localhost:${PORT} (mode: ${connectMode})`);
if (connectMode === "direct") {
  app.log.info(
    `CONNECT_MODE=direct: browser mints a ${sessionTtl}s token via POST /session and connects to PyAI directly. Set CONNECT_MODE=broker to relay through this server instead.`,
  );
}
if (!kbPublicUrl || !KB_TOKEN) {
  app.log.warn(
    "KB grounding is OFF (set KB_PUBLIC_URL + KB_TOKEN to enable). The agent will still answer from its persona, but without live per-turn retrieval.",
  );
}
