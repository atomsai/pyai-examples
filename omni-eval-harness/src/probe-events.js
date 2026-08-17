// One-call probe: dump every 0x03 control event with a timestamp, so we can
// see whether the deployed engine emits turn_begin. Not a scored run.

import { fileURLToPath } from "node:url";

async function main() {
  const { OmniClient } = await import("@pyai/twilio");
  const sdk = await import("@pyai/sdk");
  const PyAI = sdk.PyAI ?? sdk.default;
  const apiKey = process.env.PYAI_API_KEY;
  if (!apiKey) {
    console.error("PYAI_API_KEY not set");
    process.exit(2);
  }
  const pyai = new PyAI({ apiKey });
  const t0 = Date.now();
  const ms = () => Date.now() - t0;

  const omni = new OmniClient({
    apiKey,
    sessionLabel: `probe-${Date.now()}`,
    voice: process.env.PYAI_VOICE || "stock_sarah_style2",
    persona: "You are a phone support agent. Be brief.",
    onEvent: (evt) => {
      console.log(`[${ms()}ms] event=${evt.event ?? "?"}`, JSON.stringify(evt).slice(0, 160));
    },
    onAudio: () => {},
    onError: (e) => console.error("err", e.message),
  });
  await new Promise((res) => setTimeout(res, 1500));

  const buf = await pyai.audio.speech({
    input: "How much does the Pro plan cost?",
    voice: process.env.PYAI_VOICE || "stock_sarah_style2",
    response_format: "pcm",
    sample_rate: 24000,
  });
  const pcm = new Int16Array(buf.byteLength / 2);
  new DataView(buf).forEach?.call?.(null) ?? null;
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < pcm.length; i++) pcm[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);

  // Stream the caller in real time, then silence until the agent settles.
  const frame = 480; // 20ms at 24kHz
  for (let off = 0; off < pcm.length; off += frame) {
    omni.sendAudio(pcm.subarray(off, off + frame));
    await new Promise((r) => setTimeout(r, 20));
  }
  console.log(`[${ms()}ms] caller done`);
  const silence = new Int16Array(frame);
  const stop = Date.now() + 12000;
  while (Date.now() < stop) {
    omni.sendAudio(silence);
    await new Promise((r) => setTimeout(r, 20));
  }
  omni.close();
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
