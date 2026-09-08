import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { evaluate } from "../src/scorers.js";
import { renderMarkdown } from "../src/scorecard.js";
import { normalizeFixture, loadFixture } from "../src/fixture.js";
import { runResultToFixture } from "../src/live-pack.js";
import { scorecardExitCode } from "../src/run.js";

const scenario = { id: "capture-probe", persona: "Say hello.",
  turns: [{ caller_says: "Hello", expect: [{ type: "contains", value: "hello" }] }] };
const cleanRun = () => ({ mode: "live-voice", captureIntegrity: { valid: true, issues: [] },
  turns: [{ callerText: "Hello", agentText: "Hello", asrHypothesis: "Hello", ttfbMs: 200,
    turnMs: 300, toolCalls: [] }] });

test("valid live capture retains shared quality scoring", () => {
  const score = evaluate(scenario, cleanRun());
  assert.equal(score.verdict, "PASS");
  assert.equal(score.qualityScored, true);
  assert.equal(scorecardExitCode(score), 0);
});

test("invalid live capture cannot pass shared metrics, rendering or CLI gating", () => {
  const run = cleanRun();
  run.captureIntegrity = { valid: false, issues: [{ code: "protocol_frame_error", severity: "error", turnIndex: 0 }] };
  let judgeCalls = 0;
  const score = evaluate(scenario, run, { judgeFn: () => { judgeCalls++; return { pass: true, score: 100 }; } });
  assert.equal(score.verdict, "INVALID_CAPTURE");
  assert.equal(score.qualityScored, false);
  assert.equal(scorecardExitCode(score), 2);
  assert.equal(judgeCalls, 0, "invalid evidence must not reach the model judge");
  assert.ok(Object.values(score.metrics).every((metric) => metric.verdict === "INVALID_CAPTURE" && metric.gatePass === null));
  const report = renderMarkdown(score);
  assert.match(report, /Capture integrity failed/);
  assert.match(report, /protocol_frame_error \(turn 1\)/);
  assert.doesNotMatch(report, /\bPASS\b|\bWARN\b|\bGOOD\b/);
});

test("missing live integrity and contradictory success metadata fail closed", () => {
  for (const metadata of [undefined, null, { valid: "true" },
    { valid: true, issues: [{ code: "turn_timeout", severity: "error" }] }]) {
    const run = cleanRun();
    if (metadata === undefined) delete run.captureIntegrity;
    else run.captureIntegrity = metadata;
    const score = evaluate(scenario, run);
    assert.equal(score.verdict, "INVALID_CAPTURE");
    assert.ok(score.counts.captureFailures > 0);
  }
});

test("live turn-count mismatch cannot hide behind success metadata", () => {
  const run = cleanRun();
  run.turns = [];
  const score = evaluate(scenario, run);
  assert.equal(score.verdict, "INVALID_CAPTURE");
  assert.ok(score.captureIntegrity.issues.some((issue) => issue.code === "capture_turn_count_mismatch"));
});

test("legacy offline replays keep behavior without invented integrity evidence", () => {
  const run = cleanRun();
  delete run.captureIntegrity;
  const fixture = runResultToFixture(run, scenario.id);
  assert.equal(Object.hasOwn(fixture, "capture_integrity"), false);
  const replay = normalizeFixture(fixture);
  assert.equal(replay.mode, "live-voice", "original recording mode is retained");
  assert.equal(Object.hasOwn(replay, "captureIntegrity"), false);
  const score = evaluate(scenario, replay);
  assert.equal(score.verdict, "PASS");
  assert.equal(score.captureIntegrity.valid, null);
  assert.match(renderMarkdown(score), /capture integrity was not recorded/);
});

test("explicit invalid evidence survives fixture export, disk load and replay", () => {
  const run = cleanRun();
  run.captureIntegrity = { valid: false, issues: [{ code: "turn_timeout", severity: "error", turnIndex: 0 }] };
  const fixture = runResultToFixture(run, scenario.id);
  const path = join(mkdtempSync(join(tmpdir(), "capture-roundtrip-")), "fixture.json");
  writeFileSync(path, JSON.stringify(fixture));
  const replay = loadFixture(path);
  assert.deepEqual(replay.captureIntegrity, run.captureIntegrity);
  assert.equal(evaluate(scenario, replay).verdict, "INVALID_CAPTURE");
  // Zero captured turns must also remain inspectable evidence of a failed call.
  fixture.turns = [];
  assert.equal(evaluate(scenario, normalizeFixture(fixture)).verdict, "INVALID_CAPTURE");
});

test("generic CLI writes invalid-capture scorecard and exits 2 for invalid replay", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-cli-"));
  const scenarioPath = join(root, "scenario.json");
  const fixturePath = join(root, "fixture.json");
  const out = join(root, "out");
  const run = cleanRun();
  run.captureIntegrity = { valid: false, issues: [{ code: "agent_transcription_failed", severity: "error" }] };
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  writeFileSync(fixturePath, JSON.stringify(runResultToFixture(run, scenario.id)));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/run.js", import.meta.url)),
    scenarioPath, "--fixture", fixturePath, "--out", out], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  const saved = JSON.parse(readFileSync(join(out, "capture-probe.scorecard.json"), "utf8"));
  assert.equal(saved.verdict, "INVALID_CAPTURE");
  assert.match(result.stdout, /Capture integrity failed/);
  assert.doesNotMatch(result.stdout, /\bPASS\b|\bWARN\b/);
});
