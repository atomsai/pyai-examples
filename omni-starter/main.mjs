import PyAI from "@pyai/sdk";
import WebSocket from "ws"; // Explicit transport makes this work on Node 20 too.
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { runSession } from "./session.mjs";
import { readWav, writeWav, assessAnswer } from "./audio.mjs";

async function main() {
  const [callerPath, interruptionPath, extra] = process.argv.slice(2);
  if (!callerPath || extra) throw new Error("Usage: node main.mjs caller.wav [interruption.wav]");
  if (!process.env.PYAI_API_KEY) throw new Error("Inject PYAI_API_KEY through your environment first");
  const caller = readWav(await readFile(callerPath));
  const interruption = interruptionPath ? readWav(await readFile(interruptionPath)) : undefined;
  const pyai = new PyAI({ apiKey: process.env.PYAI_API_KEY, maxRetries: 0,
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(30000) }),
  });
  const { report, audio, replyAudio } = await runSession({ pyai, webSocket: WebSocket, caller, interruption });
  const directory = await mkdtemp(join(process.cwd(), "omni-run-"));
  const save = (name, data) => writeFile(join(directory, name), data, { mode: 0o600, flag: "wx" });
  await save("session.wav", writeWav(audio, report.output_rate ?? 24000));
  const reply = writeWav(replyAudio, report.output_rate ?? 24000);
  await save("reply.wav", reply);
  // Hear the captured bytes, rather than trusting synthesis-advisory text.
  let capturedTranscript = "";
  if (report.reply_audio_bytes) {
    try {
      const heard = await pyai.audio.transcriptions.create({ file: new File([reply], "reply.wav", { type: "audio/wav" }), model: "pyai-hear" });
      capturedTranscript = heard.text;
    } catch { report.hear_error = "Captured audio saved; Hear verification failed"; }
  }
  const result = { ...report, captured_transcript: capturedTranscript, evidence: assessAnswer(report, capturedTranscript) };
  await save("report.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ directory, ...result }, null, 2));
  if (result.evidence.captured_answer !== "verified_by_hear" || (interruption && result.evidence.interruption !== "simulated_queue_cleared")) process.exitCode = 1;
}

main().catch(error => {
  const message = String(error.message).replaceAll(process.env.PYAI_API_KEY || "\0", "[REDACTED]");
  console.error(JSON.stringify({ error: message })); process.exitCode = 1;
});
