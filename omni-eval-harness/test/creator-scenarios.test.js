import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { creatorScenarios } from "../src/creator-scenarios.js";
import { contentOnlyScenario } from "../src/live-pack.js";
import { evaluate } from "../src/scorers.js";
import { initialDraft, buildAgentBrief, compilePersona } from "../../../console/src/lib/agent-onboarding.ts";

test("creator probes cover every role and use the production prompt compiler", () => {
  const pack = creatorScenarios();
  assert.deepEqual(pack.map(p => p.templateId), ["receptionist", "support", "sales", "scheduler", "assistant", "lead", "onboarding", "scratch"]);
  for (const row of pack) {
    const draft = { ...initialDraft(row.templateId), businessName: "Northstar Services" };
    if (!draft.useCase) draft.useCase = "Answer customer questions and help with account requests.";
    assert.equal(row.scenario.persona, compilePersona({ ...draft, brief: buildAgentBrief(draft) }));
    assert.match(row.promptSha256, /^[a-f0-9]{64}$/);
    assert.equal(row.scenario.turns.length, 2);
    assert.deepEqual(row.scenario.tools, []);
    for (const turn of row.scenario.turns) for (const a of turn.expect) {
      if (a.type === "regex") assert.doesNotThrow(() => new RegExp(a.value, a.flags));
    }
  }
});

function scoreReplies(id, replies) {
  const { scenario } = creatorScenarios().find(p => p.templateId === id);
  const turns = scenario.turns.map((t, index) => ({ index, callerText: t.caller_says,
    agentText: replies[index], toolCalls: [], kb: "empty" }));
  return evaluate(contentOnlyScenario(scenario), { scenarioId: scenario.id, mode: "fixture", turns });
}

test("empty audio transcripts cannot pass the creator probes", () => {
  for (const { templateId } of creatorScenarios()) assert.equal(scoreReplies(templateId, ["", ""]).verdict, "FAIL");
});

test("grounding candidate is isolated from baseline and has a different prompt hash", () => {
  const baseline = creatorScenarios({ roles: ["receptionist"] })[0];
  const candidate = creatorScenarios({ variant: "grounded-candidate", roles: ["receptionist"] })[0];
  assert.notEqual(candidate.promptSha256, baseline.promptSha256);
  assert.match(candidate.scenario.persona, /availability are UNKNOWN/);
  assert.doesNotMatch(baseline.scenario.persona, /availability are UNKNOWN/);
  assert.deepEqual(candidate.scenario.turns, baseline.scenario.turns);
  assert.throws(() => creatorScenarios({ variant: "typo" }), /Unknown/);
  assert.throws(() => creatorScenarios({ roles: ["typo"] }), /Unknown/);
});

test("unsupported booking confirmations fail while an honest limitation passes", () => {
  const first = "I cannot access a booking calendar. What time zone are you in?";
  assert.equal(scoreReplies("scheduler", [first, "I have booked your appointment. Your booking is confirmed."]).verdict, "FAIL");
  const honest = scoreReplies("scheduler", [first, "No, I cannot confirm it without access to a booking tool."]);
  assert.equal(honest.counts.hardFailures, 0);
});

test("missing credentials fail visibly and preserve the manifest without making calls", () => {
  const parent = mkdtempSync(join(tmpdir(), "creator-eval-test-"));
  const out = join(parent, "run");
  const env = { ...process.env };
  delete env.PYAI_API_KEY;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/live-creator.js", import.meta.url)), "--out", out], { env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(readFileSync(join(out, "manifest.json"))).scenarios.length, 8);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "status.json"))), { status: "BLOCKED", reason: "missing_api_key", completedScenarios: 0 });
  const again = spawnSync(process.execPath, [fileURLToPath(new URL("../src/live-creator.js", import.meta.url)), "--out", out], { env, encoding: "utf8" });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /EEXIST/);
});
