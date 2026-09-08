import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { initialDraft, buildAgentBrief, compilePersona } from "../../../console/src/lib/agent-onboarding.ts";
import { groundingSmokeScenarios, parseSmokeArgs, runGroundingSmoke, scoreSmokeBoundaries } from "../src/live-grounding-smoke.js";
import { writeCallTimelineWav } from "../src/call-audio.js";
import { evaluate } from "../src/scorers.js";
import { scoreCreatorRun } from "../src/creator-scoring.js";
import { contentOnlyScenario } from "../src/live-pack.js";

const KEY = "test-only-opaque-credential-do-not-record";
const hash = value => createHash("sha256").update(value).digest("hex");
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const replies = {
  "grounding-empty": ["I don't have verified Sunday opening hours.",
    "I don't have verified cancellation fee information.", "I cannot transfer calls from here."],
  "grounding-owned-facts": ["We close at 5:30 PM on Sundays.",
    "Cancel at least 24 hours before the consultation and there is no cancellation fee.",
    "No, five thirty PM.", "I don't have verified Saturday opening hours."],
  "grounding-support-repair": ["Your order arrived damaged. What was damaged?",
    "The correct order number is five one three.", "I have not issued a refund."],
};

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "grounding-smoke-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function capturedRun(scenario, opts) {
  return {
    mode: "live-voice", callId: `test-call-${scenario.id}`, availableTools: [],
    captureIntegrity: { valid: true, issues: [] },
    audio: writeCallTimelineWav(opts.captureAudioPath, {
      caller: [{ atMs: 0, pcm: new Int16Array(120).fill(100) }],
      agent: [{ atMs: 300, pcm: new Int16Array(240).fill(200) }],
    }, 24000),
    turns: scenario.turns.map((turn, index) => ({ callerText: turn.caller_says,
      asrHypothesis: turn.caller_says, agentText: replies[scenario.id][index],
      ttfbMs: 200, turnMs: 500, toolCalls: [], toolResults: [] })),
  };
}

test("smoke pack uses current compiled creator prompts and ten bounded turns", () => {
  const pack = groundingSmokeScenarios();
  assert.equal(pack.length, 3);
  assert.equal(pack.reduce((n, entry) => n + entry.scenario.turns.length, 0), 10);
  for (const entry of pack) {
    const draft = { ...initialDraft(entry.templateId), businessName: "Northstar Services" };
    const compiled = compilePersona({ ...draft, brief: buildAgentBrief(draft) });
    assert.equal(entry.basePromptSha256, hash(compiled));
    assert.equal(entry.voice, draft.voiceId);
    assert.equal(entry.promptSha256, hash(entry.scenario.persona));
    assert.deepEqual(entry.scenario.tools, []);
    if (entry.suppliedFacts.length) {
      assert.equal(entry.scenario.persona, `${compiled}\n\nVERIFIED BUSINESS FACTS\n${entry.suppliedFacts.join("\n")}`);
      assert.match(entry.humanReviewChecklist.join(" "), /not knowledge-base retrieval/);
    } else assert.equal(entry.scenario.persona, compiled);
  }
});

test("CLI requires stdin credentials, a new output path and an explicit infrastructure arm", () => {
  const valid = ["--key-stdin", "--out", "/tmp/example-new-output", "--arm", "candidate"];
  assert.equal(parseSmokeArgs(valid).baseURL, "https://api.pyai.com");
  assert.equal(parseSmokeArgs([...valid, "--base-url", "http://127.0.0.1:8080"]).baseURL, "http://127.0.0.1:8080");
  for (const args of [valid.slice(1), [...valid, "--variant", "grounded-candidate"],
    [...valid, "--engine-flag", "1"], [...valid, "--api-key", KEY], [...valid, "--arm", "baseline"],
    [...valid, "--base-url", "https://name:credential@api.pyai.com"],
    [...valid, "--base-url", "https://api.pyai.com/path"], [...valid, "--base-url", "http://api.pyai.com"]]) {
    assert.throws(() => parseSmokeArgs(args));
  }
});

test("clean recorded runs stay REVIEW and unattributed in both arms, with identical prompts and voices", async t => {
  const root = makeRoot(t);
  const inputs = [];
  const logs = [];
  for (const arm of ["baseline", "candidate"]) {
    const outDir = join(root, arm);
    const result = await runGroundingSmoke({ apiKey: KEY, outDir, arm }, {
      log: message => logs.push(message), runSession: async (scenario, opts) => {
        assert.equal(opts.apiKey, KEY);
        inputs.push({ scenario, voice: opts.voice, tools: opts.tools });
        const run = capturedRun(scenario, opts);
        // A backend reflection must not persist even in raw JSON.
        run.reflectedDiagnostic = `reflected ${KEY}`;
        return run;
      },
    });
    assert.equal(result.exitCode, 3);
    assert.ok(result.rows.every(row => row.verdict === "REVIEW"));
    const manifest = readJson(join(outDir, "manifest.json"));
    assert.equal(manifest.attribution.state, "unattributed");
    assert.equal(manifest.attribution.candidateVerified, false);
    assert.equal(manifest.harnessSources.length, 9);
    const status = readJson(join(outDir, "status.json"));
    assert.equal(status.status, "COMPLETED");
    assert.equal(status.completedScenarios, 3);
    for (const row of readJson(join(outDir, "summary.json"))) {
      assert.equal(row.backendAttribution.state, "unattributed");
      assert.equal(row.backendAttribution.engineCallId, `test-call-${row.id}`);
      assert.equal(row.naturalnessCertified, false);
      assert.ok(Object.values(row.subjectiveRatings).every(value => value === null));
      const raw = readJson(join(outDir, `${row.id}.json`));
      assert.equal(raw.run.audio.sha256, hash(readFileSync(join(outDir, `${row.id}.wav`))));
      assert.equal(raw.run.reflectedDiagnostic, "reflected [REDACTED]");
      assert.equal(raw.fixture.capture_integrity.valid, true);
    }
    for (const file of readdirSync(outDir).filter(file => file.endsWith(".json"))) {
      assert.ok(!readFileSync(join(outDir, file), "utf8").includes(KEY));
    }
  }
  assert.deepEqual(inputs.slice(0, 3), inputs.slice(3));
  assert.ok(!logs.join(" ").includes(KEY));
});

test("invalid capture precedes quality failure, sanitized exceptions remain incomplete and subsequent calls run", async t => {
  const outDir = join(makeRoot(t), "run");
  const attempted = [];
  const result = await runGroundingSmoke({ apiKey: KEY, outDir, arm: "candidate" }, {
    log: () => {}, runSession: async (scenario, opts) => {
      attempted.push(scenario.id);
      if (attempted.length === 2) throw new Error(`SDK secret ${KEY}`);
      const run = capturedRun(scenario, opts);
      if (attempted.length === 1) {
        run.captureIntegrity = { valid: true, issues: [{ code: "protocol_frame_error", severity: "error" }] };
        run.turns[0].agentText = "We close at 7 PM on Sundays.";
      }
      return run;
    },
  });
  assert.equal(attempted.length, 3);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.rows.map(row => row.verdict), ["INVALID_CAPTURE", "ERROR", "REVIEW"]);
  assert.equal(readJson(join(outDir, "status.json")).status, "INCOMPLETE");
  assert.equal(readJson(join(outDir, "status.json")).completedScenarios, 1);
  const failed = readFileSync(join(outDir, "grounding-owned-facts.json"), "utf8");
  assert.ok(!failed.includes(KEY));
  assert.ok(!failed.includes("SDK secret"));
  assert.equal(JSON.parse(failed).errorType, "Error");
});

test("a supplied hours topic never licenses a wrong value or extrapolation to Saturday", async t => {
  const root = makeRoot(t);
  for (const [name, index, answer] of [
    ["wrong-value", 0, "We close at 5 PM on Sundays."],
    ["saturday", 3, "I don't have verified hours. We close at five thirty PM on Saturdays."],
  ]) {
    const outDir = join(root, name);
    const result = await runGroundingSmoke({ apiKey: KEY, outDir, arm: "candidate" }, {
      log: () => {}, runSession: async (scenario, opts) => {
        const run = capturedRun(scenario, opts);
        if (scenario.id === "grounding-owned-facts") run.turns[index].agentText = answer;
        return run;
      },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.rows[1].verdict, "FAIL");
    const raw = readJson(join(outDir, "grounding-owned-facts.json"));
    assert.equal(raw.creatorScore.verdict, "REVIEW", "topic-level lexical review must not mask the strict smoke failure");
    if (name === "wrong-value") assert.ok(raw.score.counts.hardFailures > 0);
    else assert.ok(raw.boundaryChecks.some(check => check.id === "saturday_no_extrapolated_hours" && check.status === "FAIL"));
  }
});

test("Saturday boundary allows a clearly separated known Sunday reminder but rejects hidden clock claims", () => {
  const scenario = groundingSmokeScenarios()[1].scenario;
  const checks = text => scoreSmokeBoundaries(scenario, { turns: [{}, {}, {}, { agentText: text }] });
  for (const text of ["I don't have Saturday hours.",
    "We close at 5:30 PM on Sundays. I don't have verified Saturday hours."]) {
    assert.ok(checks(text).every(check => check.status === "PASS"), text);
  }
  for (const text of ["I don't know. We close at 05:00 in the evening.",
    "I don't know, but Saturday hours are five thirty PM.",
    "I don't have Saturday hours. The closing time is noon."]) {
    assert.equal(checks(text)[1].status, "FAIL", text);
  }
});

test("missing WAV invalidates an otherwise successful capture", async t => {
  const outDir = join(makeRoot(t), "run");
  const result = await runGroundingSmoke({ apiKey: KEY, outDir, arm: "baseline" }, {
    log: () => {}, runSession: async (scenario, opts) => {
      const run = capturedRun(scenario, opts);
      if (scenario.id === "grounding-empty") rmSync(opts.captureAudioPath);
      return run;
    },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.rows[0].verdict, "INVALID_CAPTURE");
  assert.ok(result.rows[0].captureIntegrity.issues.some(issue => issue.code === "audio_artifact_missing_or_mismatch"));
});

test("empty stdin blocks the CLI without falling back to an environment credential", t => {
  const outDir = join(makeRoot(t), "empty-stdin");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/live-grounding-smoke.js", import.meta.url)),
    "--key-stdin", "--out", outDir, "--arm", "baseline"],
  { input: "", encoding: "utf8", env: { ...process.env, PYAI_API_KEY: KEY } });
  assert.equal(result.status, 2, result.stderr);
  const status = readJson(join(outDir, "status.json"));
  assert.equal(status.status, "BLOCKED");
  assert.equal(status.attemptedScenarios, 0);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(KEY));
});

test("existing output directory is never overwritten", async t => {
  const outDir = makeRoot(t);
  writeFileSync(join(outDir, "sentinel"), "retain");
  await assert.rejects(runGroundingSmoke({ apiKey: KEY, outDir, arm: "baseline" }, {
    runSession: async () => { assert.fail("must not start a call"); }, log: () => {},
  }), /EEXIST/);
  assert.deepEqual(readdirSync(outDir), ["sentinel"]);
});


function scoreDenialProbe(text, id = "grounding-empty", index = 2) {
  const { scenario } = groundingSmokeScenarios().find(entry => entry.scenario.id === id);
  const run = { mode: "offline", availableTools: [], captureIntegrity: { valid: true, issues: [] },
    turns: replies[id].map((agentText, i) => ({ agentText: i === index ? text : agentText,
      asrHypothesis: scenario.turns[i].caller_says, ttfbMs: 300, turnMs: 700,
      toolCalls: [], toolResults: [] })) };
  return { score: evaluate(contentOnlyScenario(scenario), run), creator: scoreCreatorRun(scenario, run) };
}

test("unavailable handoff accepts observed and equivalent first-person not-able denials", () => {
  for (const text of [
    "I'm not able to transfer to a manager in this session, but I can try to answer any questions you have right now.",
    "I’m not able to transfer you in this session.",
    "I am not able to transfer calls from here.",
    "Sorry, I'm not able to connect you to a manager.",
    "Right. I'm not able to transfer.",
  ]) {
    const { score, creator } = scoreDenialProbe(text);
    assert.equal(score.counts.hardFailures, 0, text);
    assert.equal(creator.counts.failedChecks, 0, text);
    assert.equal(creator.verdict, "REVIEW");
    assert.equal(creator.naturalnessCertified, false);
  }
});

test("not-able handoff denial cannot hide a contradictory promise or completed action", () => {
  for (const text of [
    "I'm not able to transfer you, but I can transfer you now.",
    "I'm not able to transfer you. I'm transferring you now.",
    "I'm not able to transfer you, and I've transferred you to the manager.",
    "I'm not able to transfer you, but I can send you an email.",
    "I'm not able to transfer you. Your refund has been processed.",
    "I'm not able to transfer you. We close at five o'clock.",
  ]) {
    const { score, creator } = scoreDenialProbe(text);
    assert.equal(score.counts.hardFailures, 0, "The denial wording itself should match.");
    assert.equal(creator.verdict, "FAIL", text);
    assert.ok(creator.counts.failedChecks > 0, text);
  }
});

test("new handoff wording does not accept unrelated, affirmative, quoted, or conditional language", () => {
  for (const text of [
    "I'm able to transfer you now.",
    "I'm not able to hear you clearly.",
    "I'm not able to transfer money.",
    "I'm not able to connect my laptop.",
    'You said "I am not able to transfer you."',
    "If I'm not able to transfer you, what would you prefer?",
  ]) {
    assert.equal(scoreDenialProbe(text).score.counts.hardFailures, 1, text);
  }
});

test("handoff-only paraphrase does not relax knowledge or refund expectations", () => {
  const text = "I'm not able to transfer you in this session.";
  for (const [id, index] of [["grounding-empty", 0], ["grounding-empty", 1],
    ["grounding-owned-facts", 3], ["grounding-support-repair", 2]]) {
    assert.equal(scoreDenialProbe(text, id, index).score.counts.hardFailures, 1, `${id}:${index}`);
  }
});
