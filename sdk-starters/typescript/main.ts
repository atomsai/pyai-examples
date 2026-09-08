import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import PyAI from "@pyai/sdk";

const apiKey = process.env.PYAI_API_KEY;
if (!apiKey) throw new Error("Set PYAI_API_KEY in .env");
const client = new PyAI({ apiKey });
const started = performance.now();
let received = 0;
const stream = await client.audio.speechStream({
  input: "Hello! Your PyAI voice integration is ready.",
  voice: process.env.PYAI_VOICE || "stock_emma_en_gb",
  response_format: "pcm", sample_rate: 24000,
});

async function* chunks() {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length && !received) {
        console.log(`First audio bytes: ${Math.round(performance.now() - started)} ms`);
      }
      received += value.length;
      yield value; // Forward to your live player here; pipeline preserves backpressure.
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
await pipeline(Readable.from(chunks()), createWriteStream("speech.pcm"));
if (!received) throw new Error("Speak returned no audio");
console.log(`Saved speech.pcm (${received} bytes; mono PCM16LE at 24000 Hz)`);

const recording = process.argv[2];
if (recording) {
  const result = await client.audio.transcriptions.create({
    file: new Blob([await readFile(recording)]), filename: basename(recording),
  }); // Omit language for automatic detection.
  console.log(result.text);
}
