// Static local host for the canonical hosted Omni widget v7 showcase.
// In production the asset is served by cdn.pyai.com and sessions are brokered
// by PyAI; customer pages contain neither an API key nor a token endpoint.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const { PORT = "8080" } = process.env;

const here = dirname(fileURLToPath(import.meta.url));

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/showcase": ["showcase.html", "text/html; charset=utf-8"],
  "/showcase.html": ["showcase.html", "text/html; charset=utf-8"],
  "/hosted": ["hosted.html", "text/html; charset=utf-8"],
  "/hosted.html": ["hosted.html", "text/html; charset=utf-8"],
  "/widget/v7/pyai-widget.js": ["v7/pyai-widget.js", "text/javascript; charset=utf-8"],
};

const server = createServer(async (req, res) => {
  try {
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

server.listen(Number(PORT), () => {
  console.log(`Omni widget v7 showcase on http://localhost:${PORT}`);
});
