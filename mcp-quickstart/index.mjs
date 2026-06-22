#!/usr/bin/env node
/**
 * MCP quickstart — drive the PyAI MCP server (@pyai/mcp) over stdio.
 *
 * Spawns `npx -y @pyai/mcp`, performs the MCP handshake, lists the tools, mints a
 * free sandbox key (no human steps) unless PYAI_API_KEY is already set, then
 * synthesizes speech to hello.mp3 — proving "MCP -> working PyAI call" end to end.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport).
 * Zero dependencies — Node >= 22 only.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const haveKey = Boolean(process.env.PYAI_API_KEY);

// Start the PyAI MCP server. It speaks JSON-RPC on stdout; diagnostics on stderr
// (inherited so you can see them — they never corrupt the protocol stream).
const server = spawn("npx", ["-y", "@pyai/mcp"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});
server.on("error", (err) => {
  console.error(`Could not start @pyai/mcp via npx: ${err.message}`);
  process.exit(1);
});

const rl = createInterface({ input: server.stdout });
const pending = new Map();
let nextId = 1;

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // not a JSON-RPC line
  }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params) {
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

// MCP tool results arrive as { content: [{ type: "text", text }] }. Parse JSON
// payloads when the tool returned them as text.
function toolResult(result) {
  const text = (result?.content ?? []).map((c) => c.text).join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  // 1. Handshake.
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "pyai-mcp-quickstart", version: "1.0.0" },
  });
  console.log(`Connected to ${init.serverInfo?.name ?? "server"} (protocol ${init.protocolVersion}).`);
  notify("notifications/initialized");

  // 2. Discover the tools the server exposes.
  const { tools } = await request("tools/list");
  console.log(`Tools: ${tools.map((t) => t.name).join(", ")}`);

  // 3. Get a key with no human steps (skip if one is already in the env). The
  //    server adopts the minted key for the rest of this session.
  if (haveKey) {
    console.log("Using PYAI_API_KEY from the environment.");
  } else {
    const key = toolResult(await request("tools/call", {
      name: "create_sandbox_key",
      arguments: { label: "mcp-quickstart" },
    }));
    if (key?.api_key) {
      console.log(`Minted sandbox key ${String(key.api_key).slice(0, 12)}… (org ${key.org_id ?? "?"}); adopted for this session.`);
    } else {
      console.log("create_sandbox_key returned:", key);
    }
  }

  // 4. Synthesize speech. The MCP server writes the audio to output_path on this
  //    machine (the server runs locally via npx).
  const outPath = join(here, "hello.mp3");
  const tts = toolResult(await request("tools/call", {
    name: "synthesize_speech",
    arguments: {
      input: "Hello from the PyAI MCP server.",
      voice: "nova",
      response_format: "mp3",
      output_path: outPath,
    },
  }));
  console.log("synthesize_speech:", tts);
  console.log(`\nDone — play ${outPath}`);
}

main()
  .catch((err) => {
    console.error("Error:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      server.stdin.end();
      server.kill();
    } catch {
      /* already gone */
    }
  });
