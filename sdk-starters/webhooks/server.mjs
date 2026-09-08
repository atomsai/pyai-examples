import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { verify } from "./verify.mjs";

const secret = process.env.PYAI_WEBHOOK_SECRET;
if (!secret) throw new Error("Set PYAI_WEBHOOK_SECRET in .env");
await mkdir("inbox", { recursive: true, mode: 0o700 });
http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/webhooks/pyai") { res.writeHead(404).end(); return; }
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (!verify(body, req.headers["x-pyai-signature"], secret)) { res.writeHead(401).end(); return; }
    JSON.parse(body.toString("utf8")); // Reject invalid JSON; retain the signed bytes.
    // Local demo inbox: hash the signed body so retries of it are idempotent.
    // A production queue should deduplicate using the documented event/job identity.
    const id = createHash("sha256").update(body).digest("hex");
    try { await writeFile(`inbox/${id}.json`, body, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    res.writeHead(204).end(); // Acknowledge only after storing the event.
  } catch { res.writeHead(500).end(); }
}).listen(Number(process.env.PORT || 8080), "0.0.0.0", () => {
  console.log("Listening on /webhooks/pyai; verified events are saved in inbox/");
});
