import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";

// The release workflow installs the same browser used by the customer browser gate.
const require = createRequire(new URL("../../../marketing/package.json", import.meta.url));
const { chromium } = require("playwright");
const widgetId = "wdgt_" + "a".repeat(32);
const marker = "pyai.v1";
const fixtureToken = "local-fixture";
const assetPath = "/widget/v12.1/pyai-widget.js";

test("the managed embed opens a real browser socket with a public selected protocol", async (t) => {
  const bundle = await readFile(new URL("../public/v12.1/pyai-widget.js", import.meta.url));
  let origin;
  let offered;
  let sessionCount = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<script src="${assetPath}" data-widget="${widgetId}" data-api-origin="${origin}" defer></script>`);
    } else if (request.url === assetPath) {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end(bundle);
    } else if (request.url === `/public/widgets/${widgetId}`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ config: { label: "Talk to us", action: { type: "voice" } }, profile: {} }));
    } else if (request.method === "POST" && request.url === `/public/widgets/${widgetId}/session`) {
      sessionCount++;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ token: fixtureToken, session_label: "test", url: origin.replace("http:", "ws:") + "/v1/omni" }));
    } else {
      response.writeHead(404).end();
    }
  });
  const sockets = new Set();
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    offered = request.headers["sec-websocket-protocol"]?.split(",").map(p => p.trim()) ?? [];
    const accept = createHash("sha1")
      .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    // Match the public gateway: echo the marker only when offered. Never echo
    // the credential. Chromium rejects a missing selection for a nonempty offer.
    const headers = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Accept: " + accept];
    if (offered.includes(marker)) headers.push("Sec-WebSocket-Protocol: " + marker);
    socket.on("error", () => socket.destroy());
    socket.write(headers.join("\r\n") + "\r\n\r\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream;
      window.addEventListener("pyai:widget:connected", () => { document.body.dataset.widgetConnection = "connected"; });
      window.addEventListener("pyai:widget:error", event => { document.body.dataset.widgetConnection = event.detail.code; });
    });
    await page.goto(origin);
    await page.getByRole("button", { name: "Talk to us" }).click();
    await page.waitForFunction(() => document.body.dataset.widgetConnection, undefined, { timeout: 5000 });
    assert.deepEqual(offered, [marker, "pyai-key." + fixtureToken]);
    assert.equal(await page.getAttribute("body", "data-widget-connection"), "connected");
    assert.equal(sessionCount, 1);
  } finally {
    await browser.close();
  }
});
