// Drop-in Omni voice widget — the tiny backend.
//
// This is the *minimal* browser-voice recipe: a single <script> tag adds a
// floating "Talk" button to ANY existing page (see public/pyai-widget.js), and
// this ~80-line, zero-dependency Node server does exactly one job that has to
// live server-side: mint a short-lived Omni SESSION TOKEN so your real
// pyai_live_ key never ships to the browser.
//
//   browser ──POST /token──▶ this server ──POST /v1/omni/sessions──▶ PyAI
//   browser ──wss /v1/omni (pyai-key.<ephemeral token>)──────────────▶ PyAI
//
// The browser then talks to PyAI DIRECTLY — this server is never in the audio
// path. For a fuller standalone app (broker mode + per-turn kb_endpoint
// grounding + one-click deploy) see ../pyai-site-voice-concierge.
//
// Run:  cp .env.example .env  &&  edit it  &&  npm start

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const {
  PYAI_API_KEY,
  PYAI_BASE_URL = "https://api.pyai.com",
  PYAI_VOICE = "",
  PORT = "8080",
  // Comma-separated origins allowed to mint a token (and that the token is
  // locked to). Empty in local dev → the request Origin / localhost is used.
  ALLOWED_ORIGINS = "",
  SESSION_TTL_SECONDS = "60",
  // The agent's behavior. Stateless on PyAI: it travels in the configure frame.
  PERSONA = "You are a friendly assistant for this website. Keep answers short and spoken-friendly, and offer to help the visitor.",
} = process.env;

if (!PYAI_API_KEY) {
  console.error("Missing PYAI_API_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const ttl = Math.max(15, Math.min(600, Number(SESSION_TTL_SECONDS) || 60));
const allowedOrigins = ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/pyai-widget.js": ["pyai-widget.js", "text/javascript; charset=utf-8"],
};

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/token") return await mintToken(req, res);

    const entry = STATIC[req.url ?? "/"];
    if (req.method === "GET" && entry) {
      const [file, type] = entry;
      const body = await readFile(join(here, "public", normalize(file)));
      res.writeHead(200, { "content-type": type });
      return res.end(body);
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "server_error" }));
  }
});

// Mint an ephemeral, origin-locked Omni token. The browser connects to PyAI
// with it directly; it's useless after ~60s or from any other origin. Lock this
// route down (auth / CAPTCHA / rate-limit) before shipping a public page.
async function mintToken(req, res) {
  const origin = (req.headers.origin || "").trim();
  if (allowedOrigins.length > 0 && origin && !allowedOrigins.includes(origin)) {
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "origin_not_allowed" }));
  }
  const lockedOrigins =
    allowedOrigins.length > 0 ? allowedOrigins : origin ? [origin] : [`http://localhost:${PORT}`];

  const upstream = await fetch(`${PYAI_BASE_URL.replace(/\/$/, "")}/v1/omni/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PYAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ allowed_origins: lockedOrigins, ttl_seconds: ttl, session_label: "omni-browser-widget" }),
  });
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    console.error("mint /v1/omni/sessions failed", upstream.status, detail);
    res.writeHead(502, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "mint_failed" }));
  }
  const session = await upstream.json();
  res.writeHead(200, { "content-type": "application/json" });
  // Hand the browser the token + the connect URL + the configure frame to send.
  res.end(
    JSON.stringify({
      token: session.token,
      url: session.url,
      expires_at: session.expires_at,
      configure: { type: "configure", persona: PERSONA, ...(PYAI_VOICE ? { voice_id: PYAI_VOICE } : {}) },
    }),
  );
}

server.listen(Number(PORT), () => {
  console.log(`Omni widget demo on http://localhost:${PORT}`);
  console.log(`Tokens mint via POST /v1/omni/sessions (ttl ${ttl}s); the browser then connects to PyAI directly.`);
});
