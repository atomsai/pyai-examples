import http from "node:http";
import { WebSocketServer } from "ws";
import twilio from "twilio";
import { OmniAgent, connectStreamTwiML } from "@pyai/twilio";

const { PYAI_API_KEY, TWILIO_AUTH_TOKEN, PUBLIC_ORIGIN, PORT = "8080" } = process.env;
if (!PYAI_API_KEY || !TWILIO_AUTH_TOKEN || !PUBLIC_ORIGIN) {
  throw new Error("Set PYAI_API_KEY, TWILIO_AUTH_TOKEN and PUBLIC_ORIGIN in .env");
}
const origin = new URL(PUBLIC_ORIGIN);
if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
  throw new Error("PUBLIC_ORIGIN must be an HTTPS origin, for example https://your-tunnel.example");
}
function authorized(req, params = {}) {
  // Use the configured public URL, never the untrusted Host header.
  return twilio.validateRequest(TWILIO_AUTH_TOKEN,
    req.headers["x-twilio-signature"] || "", `${origin.origin}${req.url}`, params);
}
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") { res.writeHead(200).end("ok"); return; }
  if (req.method !== "POST" || req.url !== "/voice") { res.writeHead(404).end(); return; }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const params = {};
    for (const name of new Set(fields.keys())) {
      const values = fields.getAll(name);
      params[name] = values.length === 1 ? values[0] : values;
    }
    if (!authorized(req, params)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { "Content-Type": "text/xml" }).end(
      connectStreamTwiML(`wss://${origin.host}/media`),
    );
  } catch { res.writeHead(400).end(); }
});
const sockets = new WebSocketServer({ noServer: true, maxPayload: 65536 });
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/media" || !authorized(req)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws));
});
sockets.on("connection", (ws) => {
  OmniAgent.bridge(ws, {
    apiKey: PYAI_API_KEY,
    voice: process.env.PYAI_VOICE || "stock_emma_en_gb",
    persona: "You are a friendly support assistant. Keep spoken replies brief.",
    onError: () => console.error("Voice session failed; inspect your PyAI session in the console."),
  });
});
server.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Twilio incoming voice webhook: ${origin.origin}/voice (POST)`);
});
