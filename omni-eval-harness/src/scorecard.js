// Scorecard rendering: turn the structured evaluate() result into a human
// markdown report and a machine JSON file. Pure string/IO — no scoring logic
// lives here.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BAND_LABEL = { good: "GOOD", warn: "WARN", critical: "CRIT", na: "N/A" };

function fmtValue(m) {
  if (m.value == null) return "n/a";
  const rounded = m.unit === "%" || m.unit === "ms" ? Math.round(m.value * 10) / 10 : m.value;
  return `${rounded}${m.unit}`;
}

function gateCell(m) {
  if (m.value == null) return "n/a";
  const op = m.lowerIsBetter ? "<=" : ">=";
  return `${m.gatePass ? "PASS" : "FAIL"} (${op}${m.gateLine}${m.unit})`;
}

function assertionLine(a) {
  const tag = a.ok ? "PASS" : a.soft ? "WARN" : "FAIL";
  return `  - [${tag}] ${a.type}${a.soft ? " (soft)" : ""} — ${a.detail}`;
}

/** Render a full markdown scorecard from an evaluate() result. */
export function renderMarkdown(sc) {
  const lines = [];
  lines.push(`# Omni Eval Scorecard — ${sc.scenarioId}`);
  lines.push("");
  lines.push(`- **Verdict:** ${sc.verdict}`);
  lines.push(`- **Mode:** ${sc.mode}${sc.source ? ` (\`${sc.source}\`)` : ""}`);
  lines.push(`- **Agent:** ${sc.agentId ?? "n/a"}`);
  lines.push(`- **Generated:** ${sc.generatedAt}`);
  lines.push(
    `- **LLM-judge:** ${sc.judge.stub ? "STUB" : "custom"} (${sc.judge.name}) — ${
      sc.judge.stub ? "deterministic placeholder, NOT a real model" : "pluggable judge"
    }`,
  );
  lines.push("");

  lines.push("## Aggregate metrics");
  lines.push("");
  lines.push("| Dimension | Value | Band | Gate |");
  lines.push("|---|---|---|---|");
  for (const m of Object.values(sc.metrics)) {
    lines.push(`| ${m.label} | ${fmtValue(m)} | ${BAND_LABEL[m.band]} | ${gateCell(m)} |`);
  }
  lines.push("");
  lines.push(
    `> TTFB P50 ${msOrNa(sc.extra.ttfbP50)} · turn P50 ${msOrNa(sc.extra.turnP50)} · ` +
      `barge ${sc.extra.bargeRecovered}/${sc.extra.bargeAttempts} recovered · ` +
      `missed-response ${sc.extra.missedResponseRate}% · ` +
      `TSR ${sc.extra.turnsPassed}/${sc.extra.turnsTotal} turns`,
  );
  lines.push("");

  lines.push("## Turns");
  lines.push("");
  for (const t of sc.turns) {
    const verdict = !t.hardOk ? "FAIL" : !t.softOk ? "WARN" : "PASS";
    lines.push(`### Turn ${t.index + 1} — ${verdict}`);
    lines.push(`- caller: "${t.callerText}"`);
    lines.push(`- agent: "${t.agentText}"`);
    const bits = [`ttfb ${msOrNa(t.ttfbMs)}`, `turn ${msOrNa(t.turnMs)}`];
    if (t.werPct != null) bits.push(`WER ${t.werPct}%`);
    if (t.toolCalls.length) bits.push(`tools: ${t.toolCalls.map((c) => c.name).join(", ")}`);
    if (t.bargeIn?.attempted) bits.push(`barge: ${t.bargeIn.recovered ? "recovered" : "NOT recovered"}`);
    lines.push(`- ${bits.join(" · ")}`);
    if (t.assertions.length) {
      lines.push("- assertions:");
      for (const a of t.assertions) lines.push(assertionLine(a));
    }
    lines.push(`- judge ${t.judge.stub ? "[STUB]" : ""}: ${t.judge.pass ? "pass" : "fail"} score ${t.judge.score} — ${t.judge.rationale}`);
    lines.push("");
  }

  lines.push("## Summary");
  lines.push("");
  lines.push(`- Overall: **${sc.verdict}**`);
  lines.push(`- Turns: ${sc.counts.turns} (hard failures ${sc.counts.hardFailures}, soft misses ${sc.counts.softMisses})`);
  const failingGates = Object.values(sc.metrics).filter((m) => !m.gatePass).map((m) => m.label);
  lines.push(`- Failing gates: ${failingGates.length ? failingGates.join(", ") : "none"}`);
  lines.push("");

  return lines.join("\n");
}

function msOrNa(v) {
  return v == null ? "n/a" : `${Math.round(v)}ms`;
}

/**
 * Write both the markdown and JSON scorecard into `dir` (created if needed).
 * Returns the two paths.
 */
export function writeScorecard(sc, dir, baseName) {
  mkdirSync(dir, { recursive: true });
  const mdPath = resolve(dir, `${baseName}.scorecard.md`);
  const jsonPath = resolve(dir, `${baseName}.scorecard.json`);
  writeFileSync(mdPath, renderMarkdown(sc), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(sc, null, 2)}\n`, "utf8");
  return { mdPath, jsonPath };
}
