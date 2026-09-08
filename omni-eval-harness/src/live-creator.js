import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { creatorScenarios } from "./creator-scenarios.js";
import { runLive } from "./live.js";
import { contentOnlyScenario, runResultToFixture } from "./live-pack.js";
import { evaluate } from "./scorers.js";
import { scoreCreatorRun } from "./creator-scoring.js";

// Explicit invocation only. No credentials or customer records are saved.
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (["--out", "--roles", "--variant"].includes(args[i])) {
    if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("A value is required after each output, roles or variant option");
    i++;
  } else if (!["--key-stdin", "--sandbox"].includes(args[i])) throw new Error("Unknown creator evaluation option");
}
if (args.includes("--sandbox") && args.includes("--key-stdin")) throw new Error("Choose one credential source");
const outIndex = args.indexOf("--out");
if (outIndex < 0 || !args[outIndex + 1]) throw new Error("Pass --out <new-directory>");
const out = resolve(args[outIndex + 1]);
mkdirSync(out, { recursive: false }); // Never overwrite prior evidence.
const baseURL = process.env.PYAI_BASE_URL || "https://api.pyai.com";
const variantIndex = args.indexOf("--variant");
const rolesIndex = args.indexOf("--roles");
const pack = creatorScenarios({ variant: variantIndex < 0 ? "baseline" : args[variantIndex + 1],
  roles: rolesIndex < 0 ? undefined : args[rolesIndex + 1]?.split(",") });
writeFileSync(resolve(out, "manifest.json"), JSON.stringify({
  startedAt: new Date().toISOString(), baseURL,
  harnessSources: ["live-creator.js", "creator-scenarios.js", "creator-scoring.js", "live.js", "live-timing.js", "call-audio.js", "scorers.js", "humanness.js"].map(file => ({ file,
    sha256: createHash("sha256").update(readFileSync(new URL(file, import.meta.url))).digest("hex") })),
  scope: "Development probes: inline creator prompts, default voice, no connected KB/tools. Greeting, voice guidance, managed profile persistence and human listening quality are not scored.",
  scenarios: pack,
}, null, 2));
let apiKey = process.env.PYAI_API_KEY;
if (args.includes("--key-stdin")) {
  const input = createInterface({ input: process.stdin });
  apiKey = await new Promise(resolve => { input.once("line", resolve); input.once("close", () => resolve("")); });
  input.close();
}
if (args.includes("--sandbox")) {
  const response = await fetch(`${baseURL}/v1/sandbox/keys`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "agent-creator-development-evaluation" }),
  });
  if (!response.ok) {
    writeFileSync(resolve(out, "status.json"), JSON.stringify({ status: "BLOCKED", reason: "sandbox_key_request_failed", httpStatus: response.status, completedScenarios: 0 }));
    throw new Error(`Sandbox key request failed: HTTP ${response.status}`);
  }
  apiKey = (await response.json()).api_key;
}
if (!apiKey) {
  writeFileSync(resolve(out, "status.json"), JSON.stringify({ status: "BLOCKED", reason: "missing_api_key", completedScenarios: 0 }));
  throw new Error("Set PYAI_API_KEY or explicitly pass --sandbox");
}
const rows = [];
writeFileSync(resolve(out, "status.json"), JSON.stringify({ status: "IN_PROGRESS", completedScenarios: 0, expectedScenarios: pack.length }));
for (const { scenario, templateId, templateVersion, voice, promptSha256 } of pack) {
  console.log(`Starting ${scenario.id}`);
  try {
    const run = await runLive(scenario, { apiKey, baseURL, voice, mode: "voice", tools: [],
      sessionLabel: `${scenario.id}-${Date.now()}`, captureAudioPath: resolve(out, `${scenario.id}.wav`) });
    const score = evaluate(contentOnlyScenario(scenario), run);
    const creatorScore = scoreCreatorRun(scenario, run);
    const fixture = runResultToFixture(run, scenario.id);
    fixture.note = "Live creator development probe; not a frozen holdout or quality certification.";
    writeFileSync(resolve(out, `${scenario.id}.json`), JSON.stringify({ templateId, templateVersion, promptSha256, run, fixture, score, creatorScore }, null, 2));
    const contentVerdict = score.counts.hardFailures > 0 || creatorScore.verdict === "FAIL" ? "FAIL" : "REVIEW";
    rows.push({ id: scenario.id, verdict: run.captureIntegrity?.valid === true ? contentVerdict : "INVALID_CAPTURE",
      checksVerdict: creatorScore.checksVerdict, failedChecks: creatorScore.counts.failedChecks, reviewChecks: creatorScore.counts.reviewChecks,
      aggregateVerdict: score.verdict, hardFailures: score.counts.hardFailures,
      humanReviewRequired: true, captureIntegrity: run.captureIntegrity,
      timingReviewRequired: run.turns.some(t => t.ttfbMs == null || t.ttfbMs < 0),
      replies: run.turns.map(t => t.agentText), ttfbMs: run.turns.map(t => t.ttfbMs) });
    console.log(`${scenario.id}: ${rows.at(-1).verdict} (aggregate: ${score.verdict})`);
  } catch (error) {
    // Keep failures in the denominator. Avoid raw SDK errors that may embed URLs/auth.
    rows.push({ id: scenario.id, verdict: "ERROR", errorType: error.name });
    console.error(`${scenario.id}: ERROR (${error.name})`);
  }
  writeFileSync(resolve(out, "summary.json"), JSON.stringify(rows, null, 2));
  writeFileSync(resolve(out, "status.json"), JSON.stringify({ status: "IN_PROGRESS", completedScenarios: rows.filter(r => !["ERROR", "INVALID_CAPTURE"].includes(r.verdict)).length, attemptedScenarios: rows.length, expectedScenarios: pack.length }));
}
writeFileSync(resolve(out, "status.json"), JSON.stringify({ status: rows.some(r => ["ERROR", "INVALID_CAPTURE"].includes(r.verdict)) ? "INCOMPLETE" : "COMPLETED", completedScenarios: rows.filter(r => !["ERROR", "INVALID_CAPTURE"].includes(r.verdict)).length, expectedScenarios: pack.length, humanReviewRequired: true }));
console.log(`Saved ${rows.length} scenario results to ${out}`);
// REVIEW is not an automated promotion pass. 2 = incomplete capture/transport;
// 1 = content failure; 3 = checks finished but human review remains.
process.exit(rows.some(r => ["ERROR", "INVALID_CAPTURE"].includes(r.verdict)) ? 2 : rows.some(r => r.verdict === "FAIL") ? 1 : 3);
