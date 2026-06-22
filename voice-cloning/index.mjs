// Voice cloning end-to-end: enroll a reference clip, poll until ready, speak in
// the cloned voice, and (by default) clean up.
//
// Runs with ONLY a key: it synthesizes a ~12s genuine-24kHz reference so it
// clears the bandwidth gate. For a real clone, set REFERENCE_AUDIO=./me.wav
// (a real person, >=10s, recorded at >=24kHz full-band) and KEEP_CLONE=1.
//
// Run: cp .env.example .env  &&  edit it  &&  npm start
import { writeFile, readFile } from "node:fs/promises";

const BASE = (process.env.PYAI_BASE_URL ?? "https://api.pyai.com").replace(/\/$/, "");
const KEY = process.env.PYAI_API_KEY;
const NAME = process.env.CLONE_NAME ?? "PyAI example clone";
const KEEP = process.env.KEEP_CLONE === "1";
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 90_000);

if (!KEY) {
  console.error("Missing PYAI_API_KEY (needs the voice:clone scope). Copy .env.example to .env.");
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

/** Speak: text -> audio bytes. Native 24 kHz WAV by default. */
async function speak(input, { voice, format = "wav" } = {}) {
  const res = await fetch(`${BASE}/v1/audio/speech`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "pyai-voice", input, response_format: format, ...(voice ? { voice } : {}) }),
  });
  if (!res.ok) throw await apiError("Speak", res);
  return Buffer.from(await res.arrayBuffer());
}

/** Enroll a clone from reference bytes. Returns the created Voice ({ id, status }). */
async function createClone(name, bytes, filename = "reference.wav") {
  const form = new FormData();
  form.set("name", name);
  form.set("file", new Blob([bytes]), filename);
  const res = await fetch(`${BASE}/v1/voice/clones`, { method: "POST", headers: auth, body: form });
  if (!res.ok) throw await apiError("Create clone", res);
  return res.json();
}

/** Poll GET /v1/voice/clones until our id is ready (or failed / timeout). */
async function waitUntilReady(id, timeoutMs) {
  const started = Date.now();
  let delay = 1000;
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${BASE}/v1/voice/clones`, { headers: auth });
    if (!res.ok) throw await apiError("List clones", res);
    const { data = [] } = await res.json();
    const mine = data.find((v) => v.id === id);
    if (mine?.status === "ready") return (Date.now() - started) / 1000;
    if (mine?.status === "failed") {
      throw new Error(
        `Clone ${id} failed enrollment. Most common cause: the reference clip isn't a ` +
          `genuine >=24 kHz full-band recording (a phone-quality or upsampled clip is rejected), ` +
          `or it's shorter than ~10s. See the rejection table in README.md.`,
      );
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 5000);
  }
  throw new Error(`Clone ${id} not ready within ${timeoutMs / 1000}s (still pending).`);
}

async function deleteClone(id) {
  const res = await fetch(`${BASE}/v1/voice/clones/${id}`, { method: "DELETE", headers: auth });
  if (!res.ok && res.status !== 404) throw await apiError("Delete clone", res);
}

async function main() {
  // 1) Reference audio: your own file, or a synthesized genuine-24kHz clip.
  let reference;
  if (process.env.REFERENCE_AUDIO) {
    reference = await readFile(process.env.REFERENCE_AUDIO);
    console.log(`[1/4] reference: read ${process.env.REFERENCE_AUDIO} (${reference.length} bytes)`);
  } else {
    // ~12s of speech so we clear the >=10s minimum. Native 24 kHz WAV is genuine
    // full-band (not upsampled), so it passes the bandwidth gate.
    const script =
      "Thanks for calling Acme. I can help you book, reschedule, or cancel an appointment, " +
      "check your order status, or answer questions about our hours and locations. " +
      "Just tell me what you need and I'll take care of it right away.";
    reference = await speak(script, { format: "wav" });
    await writeFile("reference.wav", reference);
    console.log(`[1/4] reference: synthesized a clip → reference.wav (24 kHz, ${reference.length} bytes)`);
  }

  // 2) Enroll the clone.
  const created = await createClone(NAME, reference);
  console.log(`[2/4] enroll:    POST /v1/voice/clones → ${created.id} (status: ${created.status})`);

  // 3) Poll until ready.
  const secs = await waitUntilReady(created.id, POLL_TIMEOUT_MS);
  console.log(`[3/4] ready:     ${created.id} became ready in ${secs.toFixed(1)}s`);

  // 4) Speak a line in the cloned voice.
  const cloned = await speak("Hello — this line is spoken in the cloned voice.", { voice: created.id });
  await writeFile("cloned.wav", cloned);
  console.log(`[4/4] speak:     wrote cloned.wav in the cloned voice (${cloned.length} bytes)`);

  console.log(`\nUse it in Omni:  configure { voice_id: "${created.id}" }  (or PYAI_VOICE=${created.id})`);

  if (KEEP) {
    console.log(`kept ${created.id} (KEEP_CLONE=1). Delete later with DELETE /v1/voice/clones/${created.id}.`);
  } else {
    await deleteClone(created.id);
    console.log(`cleanup:         deleted ${created.id} (set KEEP_CLONE=1 to keep it)`);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
