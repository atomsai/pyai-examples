// Layer C on the product surface: same 8 scripts, but against a real
// /v1/agents profile (role -> mode, bound KB) instead of a bare persona.
// Does not mint or print keys. Does not tune the holdout.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadScenario } from "./scenario.js";
import { loadFixture } from "./fixture.js";
import { runLive } from "./live.js";
import { runResultToFixture, scoreLiveRow } from "./live-pack.js";

const BASE_DIR = fileURLToPath(new URL("..", import.meta.url));
const SCENARIOS_DIR = process.env.PYAI_EVAL_SCENARIOS_DIR
  ? resolve(BASE_DIR, process.env.PYAI_EVAL_SCENARIOS_DIR)
  : resolve(BASE_DIR, "scenarios");

function scenarioPath(id) {
  return resolve(SCENARIOS_DIR, `${id}.json`);
}

// Role is a public agent field. Keep the mapping structural (scenario class,
// never outcome) so the product run exercises the same deterministic sales /
// collections policy a customer gets without tuning against holdout replies.
export function roleForScenario(id) {
  const value = String(id || "").toLowerCase();
  if (value.includes("collections")) return "collections";
  if (value.includes("sales")) return "sales";
  return "support";
}

const KB_SCENARIOS = new Set(["kb-price-hit", "kb-price-miss-honest"]);
const KB_TEXT =
  "Pro plan pricing: the Pro plan costs forty-nine dollars per month. " +
  "Do not quote any other figure for the Pro plan.";
// Sandbox keys (pyai_test_...) do not have kb:manage. KB setup will 403; the
// run proceeds without a bound KB and the results say so.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function apiBase() {
  return (process.env.PYAI_BASE_URL || "https://api.pyai.com").replace(/\/$/, "");
}

async function api(path, { method = "GET", body } = {}) {
  const key = process.env.PYAI_API_KEY;
  if (!key) throw new Error("PYAI_API_KEY not set");
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function ensureKb() {
  const name = process.env.PYAI_EVAL_KB_NAME || "omni-eval-harness-pricing";
  const list = await api("/v1/knowledgebases");
  const existing = (list?.data || []).find(
    (kb) => String(kb.name || "").toLowerCase() === name.toLowerCase(),
  );
  const kb = existing ?? (await api("/v1/knowledgebases", { method: "POST", body: { name } }));
  const kbId = kb?.id ?? kb?.kb_id;
  if (!kbId) throw new Error("knowledgebase create/list returned no id");

  const docs = await api(`/v1/knowledgebases/${encodeURIComponent(kbId)}/documents`);
  const hasDoc = (docs?.data || []).some((d) =>
    String(d.text || d.content || "").includes("forty-nine dollars"),
  );
  if (!hasDoc) {
    await api(`/v1/knowledgebases/${encodeURIComponent(kbId)}/documents`, {
      method: "POST",
      body: { text: KB_TEXT, title: "Pro plan pricing" },
    });
    // Poll until the pasted text is indexed (best-effort; fail-open).
    for (let i = 0; i < 30; i++) {
      const again = await api(`/v1/knowledgebases/${encodeURIComponent(kbId)}/documents`);
      const doc = (again?.data || []).find((d) =>
        String(d.text || d.content || "").includes("forty-nine dollars"),
      );
      if (doc && String(doc.status || "").toLowerCase() === "indexed") break;
      await sleep(1000);
    }
  }
  return kbId;
}

async function ensureAgent(scenario, kbId) {
  const name = `omni-eval-${scenario.id}`;
  const list = await api("/v1/agents");
  const existing = (list?.data || []).find((a) => a.name === name);
  const persona = scenario.persona || null;
  const voice = process.env.PYAI_VOICE || "stock_sarah_style2";
  const role = roleForScenario(scenario.id);

  if (existing) {
    await api(`/v1/agents/${encodeURIComponent(existing.agent_id)}`, {
      method: "POST",
      body: { persona_system_prompt: persona, voice_id: voice, role },
    });
    if (kbId && KB_SCENARIOS.has(scenario.id)) {
      await api(`/v1/agents/${encodeURIComponent(existing.agent_id)}/knowledgebases`, {
        method: "PUT",
        body: [{ kb_id: kbId, weight: 1 }],
      });
    }
    return existing.agent_id;
  }

  const created = await api("/v1/agents", {
    method: "POST",
    body: {
      name,
      persona_system_prompt: persona,
      voice_id: voice,
      role,
      tools: [],
    },
  });
  const agentId = created?.agent_id ?? created?.id;
  if (!agentId) throw new Error("agent create returned no id");
  if (kbId && KB_SCENARIOS.has(scenario.id)) {
    await api(`/v1/agents/${encodeURIComponent(agentId)}/knowledgebases`, {
      method: "PUT",
      body: [{ kb_id: kbId, weight: 1 }],
    });
  }
  return agentId;
}

async function runOne(id, apiKey, kbId, captureAudioPath) {
  const scenario = loadScenario(scenarioPath(id));
  const agentId = await ensureAgent(scenario, kbId);
  const run = await runLive(scenario, {
    apiKey,
    sessionLabel: agentId,
    mode: "voice",
    voice: process.env.PYAI_VOICE || "stock_sarah_style2",
    baseURL: process.env.PYAI_BASE_URL,
    captureAudioPath,
  });
  return { scenario, run, fixture: runResultToFixture(run, id) };
}

async function main() {
  const apiKey = process.env.PYAI_API_KEY;
  if (!apiKey) {
    console.error("[live-product] PYAI_API_KEY not set");
    process.exit(2);
  }
  const only = process.argv.slice(2).filter((a) => a && !a.startsWith("--"));
  const pack = only.length
    ? only
    : process.env.PYAI_EVAL_SCENARIOS_DIR
      ? readdirSync(SCENARIOS_DIR)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.slice(0, -5))
          .sort()
      : [
          "reflect-specific",
          "sales-no-invented-price",
          "memory-asked-vs-stated",
          "tool-low-info-silence",
          "collections-cease",
          "kb-price-miss-honest",
          "transfer-promise-kept",
          "kb-price-hit",
        ];
  const outDir = resolve(BASE_DIR, "out/live-omni-product");
  const holdoutDir = process.env.PYAI_EVAL_HOLDOUT_DIR
    ? resolve(BASE_DIR, process.env.PYAI_EVAL_HOLDOUT_DIR)
    : resolve(BASE_DIR, "holdout/live-product-2026-08-17");
  if (existsSync(resolve(holdoutDir, "DO_NOT_TUNE"))) {
    throw new Error(
      `refusing to overwrite frozen holdout ${holdoutDir}; set PYAI_EVAL_HOLDOUT_DIR to a new directory`,
    );
  }
  mkdirSync(outDir, { recursive: true });
  mkdirSync(holdoutDir, { recursive: true });

  const kbId = await ensureKb().catch((err) => {
    console.error(`[live-product] KB setup failed: ${err.message}`);
    return null;
  });

  for (const id of pack) {
    console.error(`[live-product] starting ${id}`);
    const audioPath = resolve(holdoutDir, `${id}.wav`);
    if (existsSync(audioPath)) unlinkSync(audioPath);
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { scenario, run, fixture } = await runOne(
          id,
          apiKey,
          kbId,
          audioPath,
        );
        fixture.audio = {
          file: `${id}.wav`,
          ...run.audio,
        };
        const json = `${JSON.stringify(fixture, null, 2)}\n`;
        writeFileSync(resolve(outDir, `${id}.offline.json`), json);
        writeFileSync(resolve(holdoutDir, `${id}.offline.json`), json);
        copyFileSync(audioPath, resolve(outDir, `${id}.wav`));
        const row = scoreLiveRow(scenario, run, fixture);
        console.error(
          `[live-product] ${id} ${row.verdict} content=${row.content_verdict} ttfb=${row.ttfb_p95}`,
        );
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        console.error(`[live-product] ${id} attempt ${attempt} failed: ${err.message}`);
        await sleep(attempt === 1 ? 8000 : 20000);
      }
    }
    if (lastErr) {
      writeFileSync(
        resolve(holdoutDir, `${id}.error.json`),
        `${JSON.stringify({ id, error: lastErr.message, at: new Date().toISOString() }, null, 2)}\n`,
      );
    }
    await sleep(2500);
  }

  const rows = [];
  for (const id of pack) {
    const path = resolve(holdoutDir, `${id}.offline.json`);
    if (!existsSync(path)) {
      rows.push({ id, verdict: "ERROR", error: "missing recording" });
      continue;
    }
    const scenario = loadScenario(scenarioPath(id));
    const run = loadFixture(path);
    rows.push(scoreLiveRow(scenario, run, runResultToFixture(run, id)));
  }
  const summary = {
    system: "omni-live-product",
    recorded_at: new Date().toISOString(),
    note: "verdict includes production TTFB/turn gates. content_verdict opens those gates. listenRubric is not Layer E. Agent profiles + bound KB; do not tune on this.",
    rows,
  };
  writeFileSync(resolve(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(resolve(holdoutDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(
    resolve(holdoutDir, "DO_NOT_TUNE"),
    "Frozen product-surface holdout. Do not tune prompts, guards, or fixtures against these recordings.\n",
  );
  console.log(JSON.stringify(summary, null, 2));
  if (rows.some((r) => r.verdict === "ERROR")) process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exit(2);
  });
}
