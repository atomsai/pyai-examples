// Production multi-call probe for the trust-typed caller continuity card.
// Uses a synthetic caller key and a managed Agent with continuity enabled.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runLive } from "./live.js";
import { runResultToFixture } from "./live-pack.js";

const BASE_DIR = fileURLToPath(new URL("..", import.meta.url));
const PERSONA =
  "You are a concise support agent. Treat recalled caller facts as advisory. " +
  "Never claim an appointment or other action happened unless a tool result confirms it. " +
  "If identity matters, ask the caller to confirm it.";
const VOICE = process.env.PYAI_VOICE || "stock_sarah_style2";
// A disconnected session remains resumable before its terminal record is
// ingested. A follow-up call inside that window may see the previous card, so
// the normal continuity probe waits beyond it. Override SETTLE_MS below the
// resume TTL only when intentionally testing that bounded stale window.
const RESUME_TTL_MS = Number(
  process.env.PYAI_EVAL_CONTINUITY_RESUME_TTL_MS || 30_000,
);
const SETTLE_MS = Number(
  process.env.PYAI_EVAL_CONTINUITY_SETTLE_MS || RESUME_TTL_MS + 10_000,
);

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function apiBase() {
  return (process.env.PYAI_BASE_URL || "https://api.pyai.com").replace(/\/$/, "");
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.PYAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return data;
}

async function ensureAgent() {
  const name = "omni-eval-trust-continuity";
  const list = await api("/v1/agents");
  const existing = (list?.data || []).find((agent) => agent.name === name);
  const body = {
    name,
    persona_system_prompt: PERSONA,
    voice_id: VOICE,
    role: "support",
    continuity: true,
    tools: [],
  };
  if (existing) {
    await api(`/v1/agents/${encodeURIComponent(existing.agent_id)}`, {
      method: "POST",
      body,
    });
    return existing.agent_id;
  }
  const created = await api("/v1/agents", { method: "POST", body });
  return created?.agent_id ?? created?.id;
}

async function call(agentId, callerKey, id, callerText) {
  const scenario = {
    id,
    persona: PERSONA,
    turns: [{ caller_says: callerText, expect: [] }],
  };
  const run = await runLive(scenario, {
    apiKey: process.env.PYAI_API_KEY,
    sessionLabel: agentId,
    callerKey,
    mode: "voice",
    voice: VOICE,
    baseURL: process.env.PYAI_BASE_URL,
  });
  const fixture = runResultToFixture(run, id);
  fixture.call_id = run.callId;
  const reply = fixture.turns?.[0]?.agent_text || "";
  console.error(`[live-continuity] ${id} reply=${JSON.stringify(reply)}`);
  return fixture;
}

async function main() {
  if (!process.env.PYAI_API_KEY) throw new Error("PYAI_API_KEY not set");
  const agentId = await ensureAgent();
  if (!agentId) throw new Error("agent create/update returned no id");

  const callerKey =
    process.env.PYAI_EVAL_CALLER_KEY || `eval-trust-${Date.now().toString(36)}`;
  const outDir = process.env.PYAI_EVAL_CONTINUITY_DIR
    ? resolve(BASE_DIR, process.env.PYAI_EVAL_CONTINUITY_DIR)
    : resolve(BASE_DIR, "out/live-continuity");
  mkdirSync(outDir, { recursive: true });

  const allPhases = [
    [
      "continuity-seed",
      "My name is Daniel. I might want a Thursday afternoon appointment, but I have not booked anything.",
    ],
    [
      "continuity-corroborate",
      "My name is Daniel again. Please remember that I still do not have an appointment.",
    ],
    ["continuity-correct", "Correction: my name is Victoria, not Daniel."],
    ["continuity-name-recall", "What name do you have for me?"],
    ["continuity-status-recall", "Have I booked any appointment with you?"],
  ];
  const only = new Set(
    String(process.env.PYAI_EVAL_CONTINUITY_ONLY || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  let phases = only.size
    ? allPhases.filter(([id]) => only.has(id))
    : allPhases;
  const stopAfter = process.env.PYAI_EVAL_CONTINUITY_STOP_AFTER;
  if (stopAfter) {
    const index = phases.findIndex(([id]) => id === stopAfter);
    if (index < 0) throw new Error(`unknown continuity stop phase: ${stopAfter}`);
    phases = phases.slice(0, index + 1);
  }
  if (!phases.length) throw new Error("no continuity phases selected");

  const fixtures = [];
  for (const [id, text] of phases) {
    fixtures.push(await call(agentId, callerKey, id, text));
    // Terminal ingest feeds the next call's card only after the reconnect hold.
    // Wait after the final phase too so a selected one-phase probe leaves an
    // immediately inspectable durable card.
    await sleep(SETTLE_MS);
  }

  const summary = {
    system: "omni-live-continuity",
    recorded_at: new Date().toISOString(),
    agent_id: agentId,
    caller_key: callerKey,
    resume_ttl_ms: RESUME_TTL_MS,
    settle_ms: SETTLE_MS,
    expected_final_name: "Victoria",
    expected_appointment_status: "not booked",
    fixtures,
  };
  writeFileSync(resolve(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exit(2);
  });
}
