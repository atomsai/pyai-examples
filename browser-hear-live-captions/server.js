// Local-only, one-session Hear proxy. The API key never reaches the browser.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

export async function verifyProject({ apiKey, projectId, fetchImpl = fetch }) {
  if (!apiKey || !projectId) throw new Error("Set PYAI_API_KEY and PYAI_PROJECT_ID for the confirmed test project.");
  const response = await fetchImpl("https://api.pyai.com/v1/me", {
    headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Identity check failed: HTTP ${response.status}.`);
  const me = await response.json();
  if (me.project_id !== projectId || me.env !== "test") throw new Error("Expected test project does not match /v1/me.");
  if (!me.scopes?.includes("hear:stream")) throw new Error("Test key lacks hear:stream.");
  const cap = me.limits?.daily_unit_cap;
  if (!me.limits || typeof me.limits !== "object" || Array.isArray(me.limits)
      || (cap != null && (!Number.isFinite(cap) || cap <= 0))) throw new Error("Invalid or zero daily cap.");
  return { org_id: me.org_id, project_id: me.project_id, env: me.env,
    limits: me.limits, credit: me.credit, key_budget_cents: me.key_budget_cents };
}

export function createDemo({ apiKey, identity, durationMs = 60_000,
  connect = () => new WebSocket(
    "wss://api.pyai.com/v1/audio/transcriptions/stream?protocol=pyai-hear-v1&sample_rate=16000&encoding=pcm16&interim_results=true",
    ["pyai.v1", `pyai-key.${apiKey}`], { handshakeTimeout: 10_000, maxPayload: 64 * 1024 }),
}) {
  const files = new Map([["/", "index.html"], ["/client.js", "client.js"]]);
  const server = createServer(async (req, res) => {
    const authority = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== authority || req.method !== "GET") return res.writeHead(403).end();
    res.setHeader("Cache-Control", "no-store");
    if (req.url === "/identity") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(identity));
    const file = files.get(req.url);
    if (!file) return res.writeHead(404).end();
    try {
      const body = await readFile(new URL(`./public/${file}`, import.meta.url));
      res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : "text/html",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" }).end(body);
    } catch { res.writeHead(500).end("Cannot load demo."); }
  });
  const browser = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  let used = false;
  server.on("upgrade", (req, socket, head) => {
    const authority = `127.0.0.1:${server.address().port}`;
    if (req.url !== "/stream" || req.headers.host !== authority || req.headers.origin !== `http://${authority}` || used) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    used = true; // One attempt per invocation, including failed attempts.
    browser.handleUpgrade(req, socket, head, (client) => {
      let upstream;
      let bytes = 0;
      const stop = () => { client.terminate(); upstream?.terminate(); clearTimeout(timer); };
      const timer = setTimeout(stop, durationMs);
      client.on("error", stop);
      client.on("close", stop);
      try { upstream = connect(); } catch { stop(); return; }
      upstream.on("error", stop);
      upstream.on("close", stop);
      upstream.on("open", () => client.send(JSON.stringify({ type: "ready" })));
      upstream.on("message", (data, binary) => {
        if (binary || client.bufferedAmount > 64 * 1024) return stop();
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: false });
      });
      client.on("message", (data, binary) => {
        // Only PCM16 from this 16 kHz demo; no caller-selected endpoint or controls.
        bytes += data.length;
        if (!binary || data.length % 2 || bytes > 60 * 16_000 * 2
            || upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > 64 * 1024) return stop();
        upstream.send(data, { binary: true });
      });
    });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const apiKey = process.env.PYAI_API_KEY;
    const identity = await verifyProject({ apiKey, projectId: process.env.PYAI_PROJECT_ID });
    console.log(JSON.stringify(identity));
    console.log("One session, at most 60 seconds; no retries. Review the project limits and billing before starting.");
    createDemo({ apiKey, identity }).listen(Number(process.env.PORT ?? 5173), "127.0.0.1", function () {
      console.log(`Live captions: http://127.0.0.1:${this.address().port}`);
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
