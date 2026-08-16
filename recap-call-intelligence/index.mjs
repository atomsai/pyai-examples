// Recap: enable, submit a conversation, read the typed recap.call.
//
// Default path posts speaker-labelled utterances (no Hear, no DIY LLM).
// Bring a recording with AUDIO_FILE=./call.wav or AUDIO_URL=https://… and
// Recap fires after the Hear job completes.
//
// Run: cp .env.example .env  &&  edit it  &&  npm start
import { readFile } from "node:fs/promises";

const BASE = (process.env.PYAI_BASE_URL ?? "https://api.pyai.com").replace(/\/$/, "");
const KEY = process.env.PYAI_API_KEY;
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 120_000);
const CALL_ID = process.env.CALL_ID ?? `call_demo_${Date.now()}`;

if (!KEY) {
  console.error("Missing PYAI_API_KEY (sandbox keys include recap:configure + recap:read). Copy .env.example to .env.");
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

const UTTERANCES = [
  { speaker_role: "agent", text: "Thanks for calling Acme, this is the front desk. How can I help?", offset_s: 0, duration_s: 3.2 },
  { speaker_role: "customer", text: "Hi, I need to reschedule my appointment that's on Tuesday.", offset_s: 3.5, duration_s: 2.8 },
  { speaker_role: "agent", text: "No problem. I can move that Tuesday appointment. What day works better?", offset_s: 6.6, duration_s: 3.0 },
  { speaker_role: "customer", text: "Could we do Thursday afternoon instead?", offset_s: 9.8, duration_s: 2.1 },
  { speaker_role: "agent", text: "Thursday at two o'clock is open. I'll confirm that and send a reminder.", offset_s: 12.1, duration_s: 3.4 },
  { speaker_role: "customer", text: "Great, thank you so much for your help.", offset_s: 15.7, duration_s: 1.8 },
];

async function enableRecap() {
  const res = await fetch(`${BASE}/v1/recap/config`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true, default_pack_id: "sales_outbound" }),
  });
  if (!res.ok) throw await apiError("Enable Recap", res);
  return res.json();
}

async function submitUtterances() {
  const res = await fetch(`${BASE}/v1/recap/calls/${encodeURIComponent(CALL_ID)}`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      call_direction: "inbound",
      customer_name: "Acme",
      utterances: UTTERANCES,
    }),
  });
  if (!res.ok) throw await apiError("Create Recap", res);
  return res.json();
}

async function submitHearJob({ wav, audioUrl }) {
  const form = new FormData();
  form.set("model", "pyai-hear");
  form.set("diarize", "true");
  form.set("call_id", CALL_ID);
  form.set("call_direction", "inbound");
  form.set("customer_name", "Acme");
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
    if (job.status === "completed") return job;
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(`Job ${jobId} ${job.status}: ${job.error ?? "no detail"}`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 5000);
  }
  throw new Error(`Job ${jobId} not complete within ${timeoutMs / 1000}s.`);
}

async function waitRecap(timeoutMs) {
  const started = Date.now();
  let delay = 1000;
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${BASE}/v1/recap/calls/${encodeURIComponent(CALL_ID)}`, { headers: auth });
    if (res.status === 404) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 5000);
      continue;
    }
    if (!res.ok) throw await apiError("Get Recap", res);
    const recap = await res.json();
    if (recap.status === "complete") return recap;
    if (recap.status === "failed") {
      throw new Error(`Recap ${CALL_ID} failed: ${recap.error ?? "no detail"}`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 5000);
  }
  throw new Error(`Recap ${CALL_ID} not complete within ${timeoutMs / 1000}s.`);
}

function printRecap(recap) {
  const record = recap.record ?? {};
  console.log(`[3/3] recap:   ${recap.call_id}  ${recap.status}\n`);
  console.log(`  tldr          ${record.tldr ?? recap.headline ?? "(none)"}`);
  console.log(`  summary       ${record.summary ?? "(none)"}`);
  console.log(`  next_steps    ${record.next_steps ?? "(none)"}`);
  console.log(`  disposition   ${record.disposition ?? "(none)"}`);
  const items = Array.isArray(record.action_items) ? record.action_items : [];
  console.log("  action_items");
  if (items.length === 0) console.log("    (none)");
  for (const item of items) {
    const owner = item.owner ? `${item.owner}: ` : "";
    const due = item.due ? `  (due ${item.due})` : "";
    console.log(`    - ${owner}${item.task ?? item}${due}`);
  }
  if (record.talk_ratio) {
    const agent = Math.round((record.talk_ratio.agent ?? 0) * 100);
    const customer = Math.round((record.talk_ratio.customer ?? 0) * 100);
    console.log(`  talk_ratio    agent ${agent}%  customer ${customer}%`);
  }
}

async function main() {
  const cfg = await enableRecap();
  console.log(`[1/3] config:  Recap enabled (pack ${cfg.default_pack_id})`);

  if (process.env.AUDIO_URL) {
    const submitted = await submitHearJob({ audioUrl: process.env.AUDIO_URL });
    console.log(`[2/3] hear:    ${submitted.job_id} queued (call_id=${CALL_ID})`);
    await waitJob(submitted.job_id, POLL_TIMEOUT_MS);
  } else if (process.env.AUDIO_FILE) {
    const wav = await readFile(process.env.AUDIO_FILE);
    const submitted = await submitHearJob({ wav });
    console.log(`[2/3] hear:    ${submitted.job_id} from ${process.env.AUDIO_FILE} (call_id=${CALL_ID})`);
    await waitJob(submitted.job_id, POLL_TIMEOUT_MS);
  } else {
    const accepted = await submitUtterances();
    console.log(`[2/3] submit:  ${accepted.call_id} ${accepted.status}`);
  }

  const recap = await waitRecap(POLL_TIMEOUT_MS);
  printRecap(recap);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
