// Run a short live Omni pack, write fixture-shaped recordings, score them.
// Used for Layer C. Does not mint or print keys.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadScenario, resolveScenarioPath } from "./scenario.js";
import { loadFixture } from "./fixture.js";
import { evaluate } from "./scorers.js";
import { toSharedScenario } from "./bakeoff.js";
import { runLive } from "./live.js";

const BASE_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Short, mostly 1-turn scenarios that a persona-only live session can attempt. */
export const LIVE_C_PACK = [
  "reflect-specific",
  "sales-no-invented-price",
  "memory-asked-vs-stated",
  "tool-low-info-silence",
  "collections-cease",
  "kb-price-miss-honest",
  "transfer-promise-kept",
  "kb-price-hit",
];

export function runResultToFixture(run, scenarioId) {
  return {
    fixture: `${scenarioId}.live`,
    scenario: scenarioId,
    session_label: run.sessionLabel ?? null,
    mode: run.mode ?? "live-voice",
    recorded_at: run.recordedAt ?? new Date().toISOString(),
    ...(Object.hasOwn(run, "captureIntegrity") ? { capture_integrity: run.captureIntegrity } : {}),
    note: "Layer C live Omni recording. Do not tune prompts or guards on holdout copies.",
    turns: (run.turns || []).map((t) => ({
      caller_says: t.callerText ?? t.caller_says ?? "",
      caller_audio_ms: t.callerAudioMs ?? t.caller_audio_ms ?? null,
      asr_hypothesis: t.asrHypothesis ?? t.asr_hypothesis ?? null,
      agent_text: t.agentText ?? t.agent_text ?? "",
      agent_audio_ms: t.agentAudioMs ?? t.agent_audio_ms ?? null,
      ttfb_ms: t.ttfbMs ?? t.ttfb_ms ?? null,
      turn_ms: t.turnMs ?? t.turn_ms ?? null,
      eou_ms: t.sttFinalMs ?? t.eou_ms ?? null,
      brain_tts_ms: t.brainTtsMs ?? t.brain_tts_ms ?? null,
      tool_calls: t.toolCalls ?? t.tool_calls ?? [],
      barge_in: t.bargeIn ?? t.barge_in ?? null,
      kb: t.kb ?? null,
    })),
  };
}

/** Same assertions with transport gates opened so content is measured alone. */
export function contentOnlyScenario(scenario) {
  const shared = toSharedScenario(scenario);
  return {
    ...shared,
    thresholds: {
      ...(shared.thresholds || {}),
      werPct: Number.MAX_SAFE_INTEGER,
      ttfbMs: Number.MAX_SAFE_INTEGER,
      turnP95Ms: Number.MAX_SAFE_INTEGER,
      bargeRecoveryPct: 0,
      vaqi: 0,
    },
  };
}

export function scoreLiveRow(scenario, run, fixture) {
  const full = evaluate(toSharedScenario(scenario), run);
  const content = evaluate(contentOnlyScenario(scenario), run);
  return {
    id: scenario.id,
    verdict: full.verdict,
    content_verdict: content.verdict,
    tsr: content.metrics.tsr.value,
    ghr: content.metrics.ghr.value,
    ttfb_p95: full.metrics.ttfbP95.value,
    turn_p95: full.metrics.turnP95.value,
    agent: (fixture.turns || [])
      .map((t) => t.agent_text ?? t.agentText ?? "")
      .join(" | "),
    listen: listenRubric(scenario, run),
  };
}

export function listenRubric(scenario, run) {
  const turns = run.turns || [];
  const last = turns[turns.length - 1] || {};
  const agent = String(last.agentText ?? last.agent_text ?? "");
  const caller = String(last.callerText ?? last.caller_says ?? "");
  const tools = last.toolCalls ?? last.tool_calls ?? [];
  const generic = /\b(i understand|i hear you|that makes sense|that'?s completely understandable)\b/i.test(agent);
  const contentHit = caller
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3)
    .some((w) => agent.toLowerCase().includes(w));
  return {
    heard: null,
    remembered: null,
    no_form: null,
    kept_promise: null,
    left_space: null,
    would_call_again: null,
    rater: "automated-transcript-heuristic",
    humanRaters: 0,
    humanReviewRequired: true,
    basis: "last-turn-transcript-only",
    observations: {
      nonemptyTranscript: Boolean(agent.trim()),
      genericValidationPhrase: generic,
      callerWordOverlap: contentHit,
      questionMarkCount: (agent.match(/\?/g) || []).length,
      toolCallCount: tools.length,
      idleCheckInPhrase: /\b(are you still there|still there\?)\b/i.test(agent),
    },
    note: "No human has rated this recording. Transcript observations do not establish listening quality or completed actions; tool calls alone do not prove success. Use blinded human review for Layer E.",
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function writeSummary(outDir, holdoutDir, rows) {
  const summary = {
    system: "omni-live",
    recorded_at: new Date().toISOString(),
    note: "verdict includes production TTFB/turn gates. content_verdict is the same assertions with latency opened. listenRubric is not Layer E.",
    rows,
  };
  writeFileSync(resolve(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(resolve(holdoutDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(
    resolve(holdoutDir, "DO_NOT_TUNE"),
    "Frozen holdout. Do not tune prompts, guards, or fixtures against these recordings.\n",
  );
  return summary;
}

function rowFromHoldout(id, holdoutDir) {
  const path = resolve(holdoutDir, `${id}.offline.json`);
  if (!existsSync(path)) return { id, verdict: "ERROR", error: "missing recording" };
  const scenario = loadScenario(resolveScenarioPath(id, BASE_DIR));
  const run = loadFixture(path);
  return scoreLiveRow(scenario, run, runResultToFixture(run, id));
}

async function runOne(id, apiKey) {
  const scenario = loadScenario(resolveScenarioPath(id, BASE_DIR));
  const run = await runLive(scenario, {
    apiKey,
    sessionLabel: scenario.session_label ?? `eval-${id}`,
    mode: "voice",
    voice: process.env.PYAI_VOICE || "stock_sarah_style2",
    baseURL: process.env.PYAI_BASE_URL,
  });
  return { scenario, run, fixture: runResultToFixture(run, id) };
}

async function main() {
  const apiKey = process.env.PYAI_API_KEY;
  if (!apiKey) {
    console.error("[live-pack] PYAI_API_KEY not set");
    process.exit(2);
  }
  const only = process.argv.slice(2).filter((a) => a && !a.startsWith("--"));
  const pack = only.length ? only : LIVE_C_PACK;
  const outDir = resolve(BASE_DIR, "out/live-omni");
  const holdoutDir = resolve(BASE_DIR, "holdout/live-2026-08-17");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(holdoutDir, { recursive: true });

  const failedIds = new Set();
  for (const id of pack) {
    console.error(`[live-pack] starting ${id}`);
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { scenario, run, fixture } = await runOne(id, apiKey);
        const json = `${JSON.stringify(fixture, null, 2)}\n`;
        writeFileSync(resolve(outDir, `${id}.offline.json`), json);
        writeFileSync(resolve(holdoutDir, `${id}.offline.json`), json);
        const row = scoreLiveRow(scenario, run, fixture);
        console.error(`[live-pack] ${id} ${row.verdict} content=${row.content_verdict} ttfb=${row.ttfb_p95}`);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        console.error(`[live-pack] ${id} attempt ${attempt} failed: ${err.message}`);
        await sleep(attempt === 1 ? 8000 : 20000);
      }
    }
    if (lastErr) {
      failedIds.add(id);
      writeFileSync(
        resolve(holdoutDir, `${id}.error.json`),
        `${JSON.stringify({ id, error: lastErr.message, at: new Date().toISOString() }, null, 2)}\n`,
      );
    }
    await sleep(2500);
  }

  const rows = pack.map((id) => failedIds.has(id)
    ? { id, verdict: "ERROR", error: "capture failed during this invocation" }
    : rowFromHoldout(id, holdoutDir));
  const summary = writeSummary(outDir, holdoutDir, rows);
  console.log(JSON.stringify(summary, null, 2));
  if (rows.some((r) => ["ERROR", "INVALID_CAPTURE"].includes(r.verdict))) process.exit(2);
  if (rows.some((r) => r.verdict === "FAIL")) process.exit(1);
  process.exit(3); // Automated checks complete; human listening review remains.
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exit(2);
  });
}
