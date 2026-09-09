// Explicit opt-in, three calls / three compound utterances. No automatic retry,
// production selection, tool action, input repair or subjective certification.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { runLive } from "./live.js";
import { scoreInterruptionRun } from "./interruption-scoring.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const persona = "You are a listening assistant for Northstar Services. Let the caller finish their entire request, including pauses and corrections. Then repeat the final day, time, or order number in one short sentence. Use the latest correction. Do not book, change, look up, create, transfer, or promise an external action; no tools are configured.";
const number = "(?:\\b513\\b|\\bfive[ ,.-]+one[ ,.-]+three\\b|\\b5[ ,.-]+1[ ,.-]+3\\b)";
const time = "(?:\\b5[:.]30\\b|\\b17[:.]30\\b|\\bfive[ -]+thirty\\b|\\bhalf past five\\b)";

export function interruptionScenarios() {
  return [
    { id: "interruption-mid-sentence", segments: [
      { text: "I need to move my appointment from Tuesday", pauseAfterMs: 700 },
      { text: "to Thursday at five thirty in the afternoon. Please repeat the final day and time.", pauseAfterMs: 0 },
    ], criticalInput: [{ id: "final_day", pattern: "\\bThursday\\b" }, { id: "final_time", pattern: time }] },
    { id: "interruption-slow-correction", segments: [
      { text: "The order number is five three one. Sorry, the correct number is", pauseAfterMs: 300 },
      { text: "five", pauseAfterMs: 350 }, { text: "one", pauseAfterMs: 350 },
      { text: "three. Please repeat the corrected number.", pauseAfterMs: 0 },
    ], criticalInput: [{ id: "corrected_number", pattern: number }] },
    { id: "interruption-resume-before-output", segments: [
      { text: "Please wait, I'm still explaining the appointment change", pauseAfterMs: 650 },
      { text: "and the final day is Friday, not Thursday. Please repeat the final day only.", pauseAfterMs: 0 },
    ], criticalInput: [{ id: "final_day", pattern: "\\bFriday\\b" }], resumeSegmentIndex: 1 },
  ].map(specification => ({ ...specification, maxResponseLatencyMs: 2500,
    scenario: { id: specification.id, persona, tools: [], turns: [{
      caller_says: specification.segments.map(s => s.text).join(" "),
      caller_segments: specification.segments, expect: [],
    }] }, promptSha256: hash(persona),
    scope: "One compound utterance per call. The caller retains the floor across every planned pause. Synthesized fragments are preserved byte-for-byte with extra digital silence; their own leading/trailing silence is retained.",
    raceLimitation: "A fixed resume schedule does not force the server to schedule a delayed cue. Whether first output actually follows resumption is reported; cue identity is not inferred." }));
}

function safeOrigin(value) {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Expected HTTPS origin, or explicit HTTP loopback origin");
  }
  return url.origin;
}
export function parseInterruptionArgs(args) {
  const opts = { baseURL: "https://api.pyai.com", label: "interruption", voice: "alloy", agentVoice: "stock_felix_en", keyStdin: false };
  const fields = { "--out": "outDir", "--base-url": "baseURL", "--label": "label", "--voice": "voice", "--agent-voice": "agentVoice" };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error("Duplicate option");
    seen.add(arg);
    if (arg === "--key-stdin") opts.keyStdin = true;
    else if (fields[arg] && args[i + 1] && !args[i + 1].startsWith("--")) opts[fields[arg]] = args[++i];
    else throw new Error("Unknown option or missing value");
  }
  if (!opts.keyStdin || !opts.outDir) throw new Error("Use --key-stdin --out <new-directory>");
  if (![opts.label, opts.voice, opts.agentVoice].every(v => /^[A-Za-z0-9_-]{1,64}$/.test(v))) throw new Error("Invalid label or voice");
  opts.baseURL = safeOrigin(opts.baseURL);
  return opts;
}

function matchingAudio(run, path) {
  try {
    const bytes = readFileSync(path);
    return bytes.length > 44 && bytes.toString("ascii", 0, 4) === "RIFF"
      && bytes.toString("ascii", 8, 12) === "WAVE" && bytes.readUInt16LE(22) === 2
      && run.audio?.channels === 2 && run.audio.bytes === bytes.length && run.audio.sha256 === hash(bytes);
  } catch { return false; }
}

export async function runInterruptionPack({ apiKey, outDir, baseURL = "https://api.pyai.com", label = "interruption", voice = "alloy", agentVoice = "stock_felix_en" },
  { runSession = runLive, runtime = {}, log = console.log } = {}) {
  baseURL = safeOrigin(baseURL);
  if (![label, voice, agentVoice].every(v => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v))) throw new Error("Invalid label or voice");
  outDir = resolve(outDir);
  mkdirSync(outDir, { recursive: false });
  const write = (name, value) => writeFileSync(resolve(outDir, name), `${JSON.stringify(value,
    (_key, item) => typeof item === "string" && typeof apiKey === "string" && apiKey
      ? item.split(apiKey).join("[REDACTED]") : item, 2)}\n`);
  const runId = randomUUID(), specifications = interruptionScenarios(), rows = [];
  const attribution = { state: "unattributed", candidateVerified: false,
    limitation: "The label is descriptive only. Exact call ID, immutable serving image/source and effective flags require separate authenticated backend proof." };
  const manifest = { schema: "pyai.interruption-pack.v1", runId, label, baseURL, voice, callerVoice: voice, agentVoice, attribution,
    startedAt: new Date().toISOString(), expectedCalls: 3, expectedCallerUtterances: 3,
    specifications, harnessSources: ["live-interruption.js", "interruption-capture.js", "interruption-scoring.js", "live.js", "live-timing.js", "call-audio.js"].map(file => ({
      file, sha256: hash(readFileSync(new URL(file, import.meta.url))),
    })), humanReviewRequired: true, naturalnessCertified: false,
    limitations: ["Synthetic isolated call input has no acoustic microphone echo path.",
      "Every agent packet, including cue audio, is retained. Received PCM and estimated FIFO playout are distinct from device playback.",
      "The 2500 ms latency budget is an explicit test criterion, not an empirically established naturalness threshold.",
      "Caller fragments are freshly synthesized; separate runs are not guaranteed bit-identical.",
      "callerVoice selects public Speak synthesis; agentVoice selects Omni. Exact configured voice acknowledgement is required, but does not prove successful speech generation.",
      "Raw engine transcript deltas and replacement semantics are retained without expected-word repair or token deduplication."] };
  write("manifest.json", manifest);
  const status = (state, extra = {}) => write("status.json", { status: state, attemptedCalls: rows.length,
    expectedCalls: 3, attribution, humanReviewRequired: true, naturalnessCertified: false, ...extra });
  if (typeof apiKey !== "string" || !apiKey || apiKey.length > 512) {
    status("BLOCKED", { reason: "missing_or_invalid_api_key", exitCode: 2 });
    return { exitCode: 2, rows, manifest };
  }
  status("IN_PROGRESS");
  for (const spec of specifications) {
    const sessionLabel = `${label}-${spec.id}-${runId}`;
    log(`Starting ${spec.id}; backend unattributed`);
    let run;
    try {
      const audioPath = resolve(outDir, `${spec.id}.wav`);
      run = await runSession(spec.scenario, { apiKey, baseURL, voice, agentVoice, sessionLabel,
        mode: "voice", tools: [], captureAudioPath: audioPath }, { ...runtime, interruptionCapture: true });
      // Recheck the returned evidence at the pack boundary too: an injected
      // private transport must acknowledge the exact agent voice requested.
      if (run.configured?.voice_id !== agentVoice) run.captureIntegrity = { valid: false,
        issues: [...(Array.isArray(run.captureIntegrity?.issues) ? run.captureIntegrity.issues : []),
          { code: "interruption_agent_voice_unverified", severity: "error", turnIndex: null }] };
      if (!matchingAudio(run, audioPath)) run.captureIntegrity = { valid: false,
        issues: [...(Array.isArray(run.captureIntegrity?.issues) ? run.captureIntegrity.issues : []),
          { code: "audio_artifact_missing_or_mismatch", severity: "error", turnIndex: null }] };
      const score = scoreInterruptionRun(spec, run);
      const row = { id: spec.id, verdict: score.verdict, engineCallId: run.callId ?? null, sessionLabel,
        audioSha256: run.audio?.sha256 ?? null, attribution, humanReviewRequired: true, naturalnessCertified: false };
      rows.push(row);
      write(`${spec.id}.json`, { specification: spec, ...row, run, score });
    } catch {
      // No raw SDK/transport exception messages or reflected headers.
      const row = { id: spec.id, verdict: "ERROR", errorCode: "interruption_run_failed", sessionLabel,
        attribution, humanReviewRequired: true, naturalnessCertified: false };
      rows.push(row);
      write(`${spec.id}.json`, { specification: spec, ...row, ...(run ? { run } : {}) });
    }
    write("summary.json", rows);
    status("IN_PROGRESS");
    log(`${spec.id}: ${rows.at(-1).verdict}; human review required`);
  }
  const incomplete = rows.some(r => ["ERROR", "INVALID_CAPTURE"].includes(r.verdict));
  const exitCode = incomplete ? 2 : rows.some(r => r.verdict === "FAIL") ? 1 : 3;
  status(incomplete ? "INCOMPLETE" : "COMPLETED", { exitCode, finishedAt: new Date().toISOString() });
  return { exitCode, rows, manifest };
}

async function main() {
  const options = parseInterruptionArgs(process.argv.slice(2));
  const input = createInterface({ input: process.stdin, terminal: false });
  const apiKey = await new Promise(resolve => { input.once("line", resolve); input.once("close", () => resolve("")); });
  input.close();
  process.exitCode = (await runInterruptionPack({ ...options, apiKey })).exitCode;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => { console.error("Interruption runner failed; no secret-bearing error details emitted."); process.exitCode = 2; });
}
