// The classic cascade: PyAI Hear (STT) -> your LLM -> PyAI Speak (TTS).
//
// This runs end to end with only an API key — no input file required. It first
// SYNTHESIZES a sample question (so we have audio to transcribe), then:
//
//   1. Hear  : transcribe the audio  -> text
//   2. LLM   : text -> reply text    (stubbed; swap in OpenAI/Anthropic/etc.)
//   3. Speak : reply text -> reply.wav
//
// Set INPUT_AUDIO=/path/to/call.wav to transcribe your own audio instead.
//
// Run:  cp .env.example .env  &&  edit it  &&  npm start

import { writeFile, readFile } from "node:fs/promises";

const BASE = (process.env.PYAI_BASE_URL ?? "https://api.pyai.com").replace(/\/$/, "");
const KEY = process.env.PYAI_API_KEY;
const VOICE = process.env.PYAI_VOICE ?? "stock_emma_en_gb";
const SAMPLE_QUESTION = process.env.SAMPLE_QUESTION ?? "Hi, what are your opening hours this weekend?";

if (!KEY) {
  console.error("Missing PYAI_API_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const auth = { Authorization: `Bearer ${KEY}` };

/** PyAI Speak (TTS): text -> audio bytes (WAV by default). */
async function speak(input, { format = "wav" } = {}) {
  const res = await fetch(`${BASE}/v1/audio/speech`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "pyai-voice", input, voice: VOICE, response_format: format }),
  });
  if (!res.ok) throw await apiError("Speak", res);
  return Buffer.from(await res.arrayBuffer());
}

/** PyAI Hear (STT): audio bytes -> transcript text. */
async function hear(audioBytes, filename = "audio.wav") {
  const form = new FormData();
  form.set("file", new Blob([audioBytes]), filename);
  form.set("model", "pyai-hear");
  const res = await fetch(`${BASE}/v1/audio/transcriptions`, { method: "POST", headers: auth, body: form });
  if (!res.ok) throw await apiError("Hear", res);
  const json = await res.json();
  return json.text ?? "";
}

/**
 * Your LLM goes here. Stubbed with a canned reply so the example runs with no
 * extra credentials. To use a real model, call it here and return its text.
 */
async function llm(userText) {
  // Example with another provider (pseudo-code):
  //   const r = await fetch("https://api.openai.com/v1/chat/completions", { ... });
  //   return (await r.json()).choices[0].message.content;
  return `Thanks for asking! You said: "${userText}". We're open 9am to 6pm, Saturday and Sunday.`;
}

async function apiError(stage, res) {
  let detail = "";
  try {
    detail = JSON.stringify(await res.json());
  } catch {
    detail = await res.text().catch(() => "");
  }
  return new Error(`${stage} failed: HTTP ${res.status} ${detail}`);
}

async function main() {
  // 0) Get some audio to transcribe: a file you provide, or a synthesized one.
  let userAudio;
  if (process.env.INPUT_AUDIO) {
    console.log(`Reading ${process.env.INPUT_AUDIO} ...`);
    userAudio = await readFile(process.env.INPUT_AUDIO);
  } else {
    console.log(`Synthesizing a sample question: "${SAMPLE_QUESTION}"`);
    userAudio = await speak(SAMPLE_QUESTION);
    await writeFile("question.wav", userAudio);
  }

  // 1) Hear: speech -> text
  const transcript = await hear(userAudio);
  console.log(`\n[Hear]  transcript: ${transcript}`);

  // 2) LLM: text -> reply
  const reply = await llm(transcript);
  console.log(`[LLM]   reply:      ${reply}`);

  // 3) Speak: reply -> audio file
  const replyAudio = await speak(reply, { format: "wav" });
  await writeFile("reply.wav", replyAudio);
  console.log(`[Speak] wrote reply.wav (${replyAudio.length} bytes)\n`);
  console.log("Done. Play reply.wav to hear the agent's response.");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
