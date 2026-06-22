// Recap — mine your calls: batch transcribe (diarized) → talk-ratio + keywords
// + summary. Built on PyAI Hear batch jobs (/v1/transcription/jobs).
//
// Runs with ONLY a key: it synthesizes a short two-voice support call so the
// diarizer has two speakers to separate. Bring your own with AUDIO_FILE=./call.wav
// or AUDIO_URL=https://… .
//
// Run: cp .env.example .env  &&  edit it  &&  npm start
import { writeFile, readFile } from "node:fs/promises";

const BASE = (process.env.PYAI_BASE_URL ?? "https://api.pyai.com").replace(/\/$/, "");
const KEY = process.env.PYAI_API_KEY;
const RATE = 24000;
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 120_000);

if (!KEY) {
  console.error("Missing PYAI_API_KEY (scopes: hear:transcribe + transcribe:jobs). Copy .env.example to .env.");
  process.exit(1);
}
const auth = { Authorization: `Bearer ${KEY}` };

async function apiError(stage, res) {
  let detail = "";
  try {
    detail = JSON.stringify(await res.json());
  } catch {
    detail = await res.text().catch(() => "");
  }
  return new Error(`${stage} failed: HTTP ${res.status} ${detail}`);
}

// --- Build a self-contained two-voice call (only used when no audio supplied) ---
const DIALOG = [
  { who: 0, text: "Thanks for calling Acme, this is the front desk. How can I help?" },
  { who: 1, text: "Hi, I need to reschedule my appointment that's on Tuesday." },
  { who: 0, text: "No problem. I can move that Tuesday appointment. What day works better?" },
  { who: 1, text: "Could we do Thursday afternoon instead?" },
  { who: 0, text: "Thursday at two o'clock is open. I'll confirm that and send a reminder." },
  { who: 1, text: "Great, thank you so much for your help." },
];

async function listVoiceIds() {
  const res = await fetch(`${BASE}/v1/voices`, { headers: auth });
  if (!res.ok) throw await apiError("List voices", res);
  const { data = [] } = await res.json();
  return data.map((v) => v.id).filter(Boolean);
}

async function speakPcm(input, voice) {
  const res = await fetch(`${BASE}/v1/audio/speech`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "pyai-voice", input, voice, response_format: "pcm", sample_rate: RATE }),
  });
  if (!res.ok) throw await apiError("Speak", res);
  return Buffer.from(await res.arrayBuffer());
}

function wrapWav(pcm, sampleRate = RATE, channels = 1) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function synthesizeCall() {
  const ids = await listVoiceIds();
  const voiceA = process.env.PYAI_VOICE_A ?? ids[0];
  const voiceB = process.env.PYAI_VOICE_B ?? ids[1] ?? ids[0];
  if (!voiceA) throw new Error("No voices available from GET /v1/voices.");
  const gap = Buffer.alloc(Math.round(RATE * 0.35) * 2); // 350 ms silence between turns
  const parts = [];
  for (const line of DIALOG) {
    parts.push(await speakPcm(line.text, line.who === 0 ? voiceA : voiceB), gap);
  }
  const pcm = Buffer.concat(parts);
  const seconds = pcm.length / 2 / RATE;
  return { wav: wrapWav(pcm), seconds };
}

// --- Submit + poll the batch job -------------------------------------------
async function submitJob({ wav, audioUrl }) {
  const form = new FormData();
  form.set("model", "pyai-hear");
  form.set("diarize", "true");
  if (audioUrl) form.set("audio_url", audioUrl);
  else form.set("audio", new Blob([wav]), "call.wav");
  const res = await fetch(`${BASE}/v1/transcription/jobs`, { method: "POST", headers: auth, body: form });
  if (!res.ok) throw await apiError("Submit job", res);
  return res.json();
}

async function waitJob(jobId, timeoutMs) {
  const started = Date.now();
  let delay = 1000;
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${BASE}/v1/transcription/jobs/${jobId}`, { headers: auth });
    if (!res.ok) throw await apiError("Get job", res);
    const job = await res.json();
    if (job.status === "completed") return { job, secs: (Date.now() - started) / 1000 };
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(`Job ${jobId} ${job.status}: ${job.error ?? "no detail"}`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 5000);
  }
  throw new Error(`Job ${jobId} not complete within ${timeoutMs / 1000}s.`);
}

/** Large results are offloaded to a signed result_url; fetch it if needed. */
async function resolveResult(job) {
  if (job.result) return job.result;
  if (job.result_url) {
    const res = await fetch(job.result_url);
    if (!res.ok) throw await apiError("Fetch result_url", res);
    return res.json();
  }
  throw new Error("Completed job had neither result nor result_url.");
}

// --- Analytics --------------------------------------------------------------
function talkRatio(segments) {
  const bySpeaker = new Map();
  for (const s of segments) {
    const dur = Math.max(0, (s.end ?? 0) - (s.start ?? 0));
    const key = s.speaker ?? "speaker_0";
    bySpeaker.set(key, (bySpeaker.get(key) ?? 0) + dur);
  }
  const total = [...bySpeaker.values()].reduce((a, b) => a + b, 0) || 1;
  return [...bySpeaker.entries()]
    .map(([speaker, secs]) => ({ speaker, secs, pct: Math.round((secs / total) * 100) }))
    .sort((a, b) => b.secs - a.secs);
}

const STOP = new Set(
  ("a an and the of to for in on at is are was were be been i you he she it we they this that with my your " +
    "me so can could would will just need help how what when okay ok hi hello thanks thank yeah yes no")
    .split(" "),
);
function keywords(text, n = 8) {
  const counts = new Map();
  for (const w of (text.toLowerCase().match(/[a-z']+/g) ?? [])) {
    if (w.length < 3 || STOP.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/**
 * Your LLM goes here. Stubbed (extractive) so the example runs with no extra
 * credentials. Swap in OpenAI/Anthropic/etc.: feed it the diarized transcript
 * and ask for a summary + action items.
 */
function llmSummary(segments) {
  const lines = segments.map((s) => `${s.speaker}: ${s.text}`).join("\n");
  const firstCustomer = segments.find((s) => /resched|cancel|book|change|move|order|status/i.test(s.text || ""));
  const intent = firstCustomer ? firstCustomer.text.trim() : segments[0]?.text?.trim() ?? "";
  return (
    `Intent: ${intent}\n` +
    `    (Stub summary from ${segments.length} segments. Replace llmSummary() with a real model:\n` +
    `     prompt it with the diarized transcript below for a true summary + action items.)\n` +
    `    --- transcript ---\n    ${lines.replace(/\n/g, "\n    ")}`
  );
}

function bar(pct) {
  return "█".repeat(Math.max(1, Math.round(pct / 4)));
}

async function main() {
  // 1) Get audio: your file/URL, or a synthesized two-voice call.
  let source;
  if (process.env.AUDIO_URL) {
    source = { audioUrl: process.env.AUDIO_URL };
    console.log(`[1/3] audio:   using AUDIO_URL (${process.env.AUDIO_URL})`);
  } else if (process.env.AUDIO_FILE) {
    const wav = await readFile(process.env.AUDIO_FILE);
    source = { wav };
    console.log(`[1/3] audio:   read ${process.env.AUDIO_FILE} (${wav.length} bytes)`);
  } else {
    const { wav, seconds } = await synthesizeCall();
    await writeFile("call.wav", wav);
    source = { wav };
    console.log(`[1/3] audio:   synthesized a 2-voice call → call.wav (${seconds.toFixed(1)}s)`);
  }

  // 2) Submit + poll.
  const submitted = await submitJob(source);
  const { job, secs } = await waitJob(submitted.job_id, POLL_TIMEOUT_MS);
  const result = await resolveResult(job);
  const segments = result.segments ?? [];
  console.log(`[2/3] job:     ${submitted.job_id} → completed in ${secs.toFixed(1)}s (${result.speakers ?? "?"} speakers)`);

  // 3) Recap.
  console.log(`[3/3] recap:\n`);
  console.log("  Talk ratio");
  for (const r of talkRatio(segments)) {
    console.log(`    ${r.speaker.padEnd(10)} ${String(r.pct).padStart(3)}%  ${bar(r.pct)}`);
  }
  console.log("\n  Top keywords");
  console.log("    " + keywords(result.text ?? "").map(([w, c]) => `${w}(${c})`).join("  "));
  console.log("\n  Summary");
  console.log("    " + llmSummary(segments).replace(/\n/g, "\n    "));
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
