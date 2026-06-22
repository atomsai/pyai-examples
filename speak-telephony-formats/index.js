// Speak telephony formats — "120 lines of DSP" vs "one param".
//
// AFTER (the win): ask Speak for response_format: "g711_ulaw" and the server
// returns 8 kHz mono μ-law — the exact bytes a Twilio Media Stream wants. No
// client-side resampler, no μ-law encoder.
//
// BEFORE (what you used to write): request wav@24k, then resample 24k→8k and
// μ-law-encode it yourself. This file shows that path too, using the audio
// helpers from @pyai/twilio (muLawEncode + makeResampler), so you can see
// exactly how much code the one param replaces — and verify both produce the
// same μ-law length.
//
// Run: cp .env.example .env  &&  npm install  &&  npm start
import { writeFile } from "node:fs/promises";
import PyAI from "@pyai/sdk";
import { bytesToPcm16, makeResampler, muLawEncode } from "@pyai/twilio";

const apiKey = process.env.PYAI_API_KEY;
if (!apiKey) {
  console.error("Set PYAI_API_KEY (copy .env.example to .env). A pyai_test_ key is fine.");
  process.exit(1);
}

const pyai = new PyAI({ apiKey, baseURL: process.env.PYAI_BASE_URL ?? "https://api.pyai.com" });
const TEXT = "Your appointment is confirmed for Tuesday at ten.";
const VOICE = process.env.PYAI_VOICE ?? "stock_emma_en_gb";

// --- AFTER: one param. The server hands back μ-law@8k. -----------------------
async function after() {
  const buf = await pyai.audio.speech({ input: TEXT, voice: VOICE, response_format: "g711_ulaw" });
  const ulaw = new Uint8Array(buf);
  await writeFile("out.ulaw", ulaw);
  // For Twilio's <Connect><Stream>, this is the whole encode step:
  const twilioMediaPayload = Buffer.from(ulaw).toString("base64");
  console.log(`AFTER  one param   → ${ulaw.length} bytes μ-law (wrote out.ulaw)`);
  console.log(`       twilio media payload (base64, first 32): ${twilioMediaPayload.slice(0, 32)}…`);
  return ulaw.length;
}

// --- BEFORE: request wav@24k, resample to 8k, μ-law-encode by hand. -----------
async function before() {
  // The old way: only WAV@24k came back, so you owned the DSP.
  const wav = new Uint8Array(await pyai.audio.speech({ input: TEXT, voice: VOICE, response_format: "wav" }));
  const pcm24k = bytesToPcm16(wav.subarray(44)); // skip the 44-byte RIFF header
  const resampler = makeResampler(24000, 8000); // anti-aliased 3:1 polyphase
  const pcm8k = resampler ? resampler.process(pcm24k) : pcm24k;
  const ulaw = muLawEncode(pcm8k);
  console.log(`BEFORE resample+μlaw → ${ulaw.length} bytes μ-law (you maintain this codec path)`);
  return ulaw.length;
}

const afterLen = await after();
const beforeLen = await before();
console.log(
  `\nSame audio, both ~${Math.round((afterLen / Math.max(beforeLen, 1)) * 100)}% of the hand-rolled length — ` +
    `the server-side path drops the client DSP entirely.`,
);
