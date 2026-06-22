// A tiny static file server for the live-captions page — no dependencies.
// The browser talks to PyAI Hear directly over a WebSocket; this server only
// serves the HTML/JS, so it never sees your key.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 5173);
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "public");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};

const server = createServer(async (req, res) => {
  // Resolve the request path safely inside ./public.
  const rel = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
  const file = rel === "/" || rel === "" ? "index.html" : rel.replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const path = join(ROOT, file);
  if (!path.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Live captions demo:  http://localhost:${PORT}`);
  console.log("Open it, paste a pyai_test_ key, and click Start.");
});
