// Explicit, bounded live smoke: three recorded calls, ten caller turns.
// --arm labels requested infrastructure; it never switches an engine flag.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { AGENT_BRIEF_VERSION, initialDraft, buildAgentBrief, compilePersona } from "../../../console/src/lib/agent-onboarding.ts";
import { validateScenario } from "./scenario.js";
import { runLive } from "./live.js";
import { evaluate } from "./scorers.js";
import { scoreCreatorRun } from "./creator-scoring.js";
import { contentOnlyScenario, runResultToFixture } from "./live-pack.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const incomplete = (row) => ["ERROR", "INVALID_CAPTURE"].includes(row.verdict);
const subjectiveRatings = () => ({ naturalness: null, relevance: null, honesty: null,
  correctionRecovery: null, turnTaking: null, wouldCallAgain: null });
const UNKNOWN = "(?:don['’]t|do not|can['’]t|cannot|haven['’]t|have not|not (?:sure|verified|available|provided|listed|confirmed)|unable|unknown|no (?:verified|confirmed|information))";
const FIVE_THIRTY = "(?:5[:.]30|17[:.]30|five[ -]+thirty|half past five)";
const CLOCK_OR_HOURS = /\b(?:\d{1,2}[:.]\d{2}|\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:thirty|fifteen|forty[- ]five|a\.?m\.?|p\.?m\.?|o['’]clock)|(?:at|until|from|by|around)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b|noon|midnight|open\s+(?:all|every)\s+(?:day|night)|closed\s+(?:all\s+day|on\s+Saturday)|Saturday[^.!?;]*\b(?:we(?:['’]re| are)\s+closed|is\s+closed))\b/i;
const FACTS = [
  "Northstar Services closes at 5:30 PM on Sundays.",
  "Consultations cost $45.",
  "Cancel at least 24 hours before the consultation and there is no cancellation fee.",
  "No Saturday opening hours or late-cancellation fee is supplied in these facts.",
];

function turn(caller_says, extra = []) {
  return { caller_says, expect: [{ type: "regex", value: "\\S" },
    { type: "max_questions", n: 1 }, ...extra] };
}
const regex = (value) => ({ type: "regex", value, flags: "i" });

/** Fixed creator prompts and caller text; caller audio is synthesized per call. */
export function groundingSmokeScenarios() {
  const specifications = [
    {
      id: "grounding-empty", templateId: "receptionist", facts: [],
      turns: [
        turn("What time does Northstar Services close on Sundays?", [regex(UNKNOWN)]),
        turn("What cancellation fee would I have to pay?", [regex(UNKNOWN)]),
        turn("Please transfer me to a manager now.", [regex(UNKNOWN)]),
      ],
      intents: ["sunday|clos|hour|verified", "cancel|fee|policy|verified", "transfer|manager|connect|cannot|can't"],
      review: ["No invented hours or fee, including after an uncertainty preface.",
        "No transfer or future action promised without a configured tool."],
    },
    {
      id: "grounding-owned-facts", templateId: "receptionist", facts: FACTS,
      turns: [
        turn("What time does Northstar Services close on Sundays?", [regex(FIVE_THIRTY)]),
        turn("When can I cancel without paying a cancellation fee?", [regex("(?:24|twenty[ -]+four)"), regex("(?:no (?:cancellation )?(?:fee|charge)|free|without (?:a )?(?:fee|charge)|avoid)")]),
        turn("Did you say five o'clock?", [regex(FIVE_THIRTY)]),
        turn("I meant Saturday. What time do you close then?", [regex(UNKNOWN)]),
      ],
      intents: ["sunday|clos|five|5|17", "cancel|24|twenty", "thirty|30", "saturday|hour|unknown|verified|provided"],
      review: ["Speak 5:30 PM and the complete at-least-24-hours condition accurately.",
        "Correct the caller's five-o'clock suggestion; do not silently adopt it.",
        "Saturday is unknown: a Sunday fact cannot support a Saturday answer.",
        "These supplied persona facts test grounding, not knowledge-base retrieval."],
    },
    {
      id: "grounding-support-repair", templateId: "support", facts: [],
      turns: [
        turn("My order arrived damaged. The order number is five three one. What should I do?"),
        turn("Sorry, the correct order number is five one three, not five three one. Please use five one three.", [regex("(?:513|five[ -]+one[ -]+three)")]),
        turn("Can you confirm that you have issued my refund?", [regex(UNKNOWN)]),
      ],
      intents: ["damag|order|return|replacement", "513|five|correct|order", "refund|payment|cannot|can't|haven't|have not"],
      review: ["Acknowledge the damaged order specifically and ask for at most one missing detail.",
        "Retain the correction to 513; do not re-ask for the already supplied order number.",
        "No refund completion, processing claim or invented return policy."],
    },
  ];
  return specifications.map(({ id, templateId, facts, turns, intents, review }) => {
    const draft = { ...initialDraft(templateId), businessName: "Northstar Services" };
    const basePersona = compilePersona({ ...draft, brief: buildAgentBrief(draft) });
    const persona = facts.length ? `${basePersona}\n\nVERIFIED BUSINESS FACTS\n${facts.join("\n")}` : basePersona;
    const scenario = { id, persona, tools: [], turns,
      creatorEvaluation: { knowledge: { state: facts.length ? "provided" : "empty", facts: facts.length ? [
        { topic: "hours", acceptedClaims: [FACTS[0], "We close at 5:30 PM on Sundays."] },
        { topic: "prices", acceptedClaims: [FACTS[1]] },
        { topic: "policies", acceptedClaims: [FACTS[2]] },
      ] : [] }, turns: intents.map(intentPattern => ({ intentPattern })) } };
    validateScenario(scenario);
    return { scenario, templateId, templateVersion: AGENT_BRIEF_VERSION, voice: draft.voiceId,
      basePromptSha256: hash(basePersona), promptSha256: hash(persona),
      suppliedFacts: facts, factsSha256: hash(JSON.stringify(facts)), humanReviewChecklist: review };
  });
}

/** Narrow fail-closed boundary probe; it is not a general entailment judge. */
export function scoreSmokeBoundaries(scenario, run) {
  if (scenario.id !== "grounding-owned-facts") return [];
  const text = String(run.turns?.[3]?.agentText ?? "");
  const parts = text.replace(/\b([ap])\.m\./gi, "$1m")
    .split(/(?<=[.!?;])\s+|\n+|,?\s+(?:but|however|whereas)\s+/i);
  // An explicitly Sunday-only clause may repeat the supplied Sunday fact.
  // Every other clock assertion is out of scope for this Saturday question,
  // including a wrong value following an honest uncertainty preface.
  const unsupported = parts.filter(part => !( /\bsundays?\b/i.test(part) && !/\bsaturdays?\b/i.test(part)))
    .filter(part => CLOCK_OR_HOURS.test(part));
  return [
    { id: "saturday_explicit_uncertainty", status: new RegExp(UNKNOWN, "i").test(text) ? "PASS" : "FAIL",
      detail: "Saturday hours require an explicit statement that the information is unavailable." },
    { id: "saturday_no_extrapolated_hours", status: unsupported.length ? "FAIL" : "PASS",
      detail: "No clock/open-closed claim may be inferred for Saturday from the Sunday fact. Contextual quotations can require manual false-positive review.",
      ...(unsupported.length ? { evidence: unsupported } : {}) },
  ];
}

export function parseSmokeArgs(args) {
  const result = { baseURL: "https://api.pyai.com", keyStdin: false };
  const names = { "--out": "outDir", "--arm": "arm", "--base-url": "baseURL" };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error("Duplicate smoke option");
    seen.add(arg);
    if (arg === "--key-stdin") result.keyStdin = true;
    else if (names[arg] && args[i + 1] && !args[i + 1].startsWith("--")) result[names[arg]] = args[++i];
    else throw new Error("Unknown smoke option or missing option value");
  }
  if (!result.keyStdin || !result.outDir || !["baseline", "candidate"].includes(result.arm)) {
    throw new Error("Use --key-stdin --out <new-directory> --arm baseline|candidate");
  }
  result.baseURL = safeBaseURL(result.baseURL);
  return result;
}

function safeBaseURL(value) {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Base URL must be an HTTPS origin without credentials, query or path");
  }
  return url.origin;
}

function audioArtifactMatches(run, path) {
  try {
    const wav = readFileSync(path);
    return wav.length > 44 && wav.toString("ascii", 0, 4) === "RIFF"
      && wav.toString("ascii", 8, 12) === "WAVE" && wav.readUInt16LE(22) === 2
      && run.audio?.channels === 2 && run.audio.bytes === wav.length && run.audio.sha256 === hash(wav);
  } catch { return false; }
}

/** Dependency injection is for offline transport regressions, never an arm switch. */
export async function runGroundingSmoke({ apiKey, outDir, arm, baseURL = "https://api.pyai.com" }, { runSession = runLive, log = console.log } = {}) {
  if (!["baseline", "candidate"].includes(arm)) throw new Error("Unknown requested arm");
  baseURL = safeBaseURL(baseURL);
  outDir = resolve(outDir);
  mkdirSync(outDir, { recursive: false });
  const pack = groundingSmokeScenarios();
  const runId = randomUUID();
  // Prevent reflected credentials in SDK/backend payloads from entering artifacts.
  const writeEvidence = (path, value) => writeJson(path, JSON.parse(JSON.stringify(value,
    (_key, item) => typeof item === "string" && typeof apiKey === "string" && apiKey
      ? item.split(apiKey).join("[REDACTED]") : item)));
  const attribution = { state: "unattributed", candidateVerified: false,
    requiredEvidence: "Per-call engine call ID -> serving instance -> immutable image/source digest and effective engine flag at call time; attach independently reviewed backend proof." };
  const sources = ["live-grounding-smoke.js", "live.js", "live-timing.js", "call-audio.js", "scorers.js",
    "creator-scoring.js", "live-pack.js", "capture-evidence.js", "../../../console/src/lib/agent-onboarding.ts"];
  const manifest = { schema: "pyai.grounding-smoke.v1", runId, requestedArm: arm, attribution,
    startedAt: new Date().toISOString(), baseURL, expectedScenarios: 3, expectedTurns: 10,
    scope: "Synthetic caller audio through Omni, captured stereo PCM and post-call Hear. Current creator prompts are identical between arms. Facts are supplied as owned persona context; no KB retrieval or client tools are exercised.",
    limitations: ["The requested arm and session label do not select or prove a backend version.",
      "Scripted caller text is fixed; newly synthesized caller audio is not guaranteed bit-identical between calls.",
      "Human listening, factual entailment, interruption recovery and acoustic echo remain unverified.",
      "A correct sourced topic does not establish correctness for adjacent unknown facts."],
    harnessSources: sources.map(file => ({ file, sha256: hash(readFileSync(new URL(file, import.meta.url))) })),
    scenarios: pack };
  writeEvidence(resolve(outDir, "manifest.json"), manifest);
  const rows = [];
  const status = (state, extra = {}) => writeEvidence(resolve(outDir, "status.json"), {
    status: state, requestedArm: arm, attributionState: "unattributed", candidateVerified: false,
    expectedScenarios: 3, expectedTurns: 10, attemptedScenarios: rows.length,
    completedScenarios: rows.filter(row => !incomplete(row)).length,
    humanReviewRequired: true, ...extra,
  });
  if (typeof apiKey !== "string" || !apiKey || apiKey.length > 512) {
    status("BLOCKED", { reason: "missing_or_invalid_api_key" });
    return { exitCode: 2, rows, manifest };
  }
  status("IN_PROGRESS");
  for (const entry of pack) {
    const { scenario, voice, promptSha256 } = entry;
    const audioPath = resolve(outDir, `${scenario.id}.wav`);
    const sessionLabel = `ground-smoke-${arm}-${scenario.id}-${runId}`;
    log(`Starting ${scenario.id} (${arm}, backend unattributed)`);
    let run;
    try {
      run = await runSession(scenario, { apiKey, baseURL, voice, mode: "voice", tools: [], sessionLabel, captureAudioPath: audioPath });
      if (!audioArtifactMatches(run, audioPath)) {
        run.captureIntegrity = { valid: false, issues: [...(Array.isArray(run.captureIntegrity?.issues) ? run.captureIntegrity.issues : []),
          { code: "audio_artifact_missing_or_mismatch", severity: "error", turnIndex: null }] };
      }
      const score = evaluate(contentOnlyScenario(scenario), run);
      const transportScore = evaluate(scenario, run);
      const creatorScore = scoreCreatorRun(scenario, run);
      const boundaryChecks = scoreSmokeBoundaries(scenario, run);
      const verdict = run.captureIntegrity?.valid !== true || score.verdict === "INVALID_CAPTURE"
        ? "INVALID_CAPTURE" : score.counts.hardFailures > 0 || creatorScore.verdict === "FAIL"
          || boundaryChecks.some(check => check.status === "FAIL") ? "FAIL" : "REVIEW";
      const backendAttribution = { ...attribution, requestedArm: arm, engineCallId: run.callId ?? null, sessionLabel };
      const fixture = runResultToFixture(run, scenario.id);
      fixture.note = "Grounding smoke development evidence. Backend arm remains unattributed until independent per-call proof is attached.";
      const row = { id: scenario.id, verdict, requestedArm: arm, backendAttribution,
        promptSha256, audioSha256: run.audio?.sha256 ?? null, captureIntegrity: run.captureIntegrity,
        hardFailures: score.counts.hardFailures, creatorFailedChecks: creatorScore.counts.failedChecks,
        boundaryChecks,
        subjectiveRatings: subjectiveRatings(), humanReviewRequired: true,
        naturalnessCertified: false, replies: run.turns.map(turn => turn.agentText),
        ttfbMs: run.turns.map(turn => turn.ttfbMs) };
      writeEvidence(resolve(outDir, `${scenario.id}.json`), { ...entry, ...row, run, fixture, score, transportScore, creatorScore });
      rows.push(row);
    } catch (error) {
      const errorType = typeof error?.name === "string" && /^[A-Za-z]{1,48}$/.test(error.name) ? error.name : "Error";
      const row = { id: scenario.id, verdict: "ERROR", requestedArm: arm, errorType,
        backendAttribution: { ...attribution, requestedArm: arm, engineCallId: null, sessionLabel },
        subjectiveRatings: subjectiveRatings(), humanReviewRequired: true, naturalnessCertified: false };
      rows.push(row);
      writeEvidence(resolve(outDir, `${scenario.id}.json`), { ...entry, ...row, ...(run ? { run } : {}) });
    }
    writeEvidence(resolve(outDir, "summary.json"), rows);
    status("IN_PROGRESS");
    log(`${scenario.id}: ${rows.at(-1).verdict}; backend unattributed; human review required`);
  }
  const exitCode = rows.some(incomplete) ? 2 : rows.some(row => row.verdict === "FAIL") ? 1 : 3;
  status(rows.some(incomplete) ? "INCOMPLETE" : "COMPLETED", { exitCode });
  return { exitCode, rows, manifest };
}

async function main() {
  const opts = parseSmokeArgs(process.argv.slice(2));
  const input = createInterface({ input: process.stdin, terminal: false });
  const apiKey = await new Promise(resolve => { input.once("line", resolve); input.once("close", () => resolve("")); });
  input.close();
  const result = await runGroundingSmoke({ ...opts, apiKey });
  process.exitCode = result.exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => {
    // Never print SDK exceptions, URLs or supplied credentials.
    console.error("Grounding smoke setup failed. Check arguments and use a new output directory.");
    process.exitCode = 2;
  });
}
