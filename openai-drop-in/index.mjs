// OpenAI drop-in — your OpenAI audio code, served by PyAI.
//
// The ONLY structural change from an OpenAI integration is the client below:
// set `baseURL` to PyAI and use your PyAI key. The two `client.audio.*` calls
// are the same ones you already wrote against OpenAI; only the model names
// differ (pyai-voice / pyai-hear instead of tts-1 / whisper-1).
//
// Self-contained: with just a key it synthesizes a line, writes hello.mp3, then
// transcribes that file back — exercising Speak + Hear through the OpenAI SDK.
//
// Run: cp .env.example .env  &&  npm install  &&  npm start
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import OpenAI from "openai";

const apiKey = process.env.PYAI_API_KEY;
if (!apiKey) {
  console.error("Set PYAI_API_KEY (copy .env.example to .env). A pyai_test_ key is fine.");
  process.exit(1);
}

// ── The whole migration: point the official OpenAI SDK at PyAI. ──────────────
const client = new OpenAI({
  apiKey,
  baseURL: `${(process.env.PYAI_BASE_URL ?? "https://api.pyai.com").replace(/\/$/, "")}/v1`,
});
// ─────────────────────────────────────────────────────────────────────────────

const VOICE = process.env.PYAI_VOICE ?? "alloy"; // an OpenAI preset name — works unchanged
const TEXT = "The fastest migration is the one where you change a single line.";

// Speak (TTS): identical to OpenAI's client.audio.speech.create, model renamed.
const speech = await client.audio.speech.create({
  model: "pyai-voice", // was: "tts-1" / "gpt-4o-mini-tts"
  voice: VOICE,
  input: TEXT,
  response_format: "mp3",
});
await writeFile("hello.mp3", Buffer.from(await speech.arrayBuffer()));
console.log(`[Speak] wrote hello.mp3 via OpenAI SDK → PyAI (voice "${VOICE}")`);

// Hear (STT): identical to OpenAI's client.audio.transcriptions.create.
const transcription = await client.audio.transcriptions.create({
  model: "pyai-hear", // was: "whisper-1"
  file: createReadStream("hello.mp3"),
});
console.log(`[Hear]  transcript: ${transcription.text}`);
console.log("✓ Round-trip through the OpenAI SDK, served by PyAI.");
