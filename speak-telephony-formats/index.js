// One bounded streaming request. No carrier connection or automatic retries.
import { open, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

export const TEXT = "Your appointment is confirmed for Tuesday at ten.";

export async function streamGreeting({ apiKey, projectId, voice = "stock_emma_en_gb",
  baseURL = "https://api.pyai.com", fetchImpl = fetch, sink,
  signal = AbortSignal.timeout(30_000), report = console.log }) {
  if (!apiKey || !projectId) throw new Error("Set PYAI_API_KEY and PYAI_PROJECT_ID for the intended test project.");
  const headers = { Authorization: `Bearer ${apiKey}` };
  const base = baseURL.replace(/\/$/, "");
  const identity = await fetchImpl(`${base}/v1/me`, { headers, signal });
  if (!identity.ok) throw new Error(`Identity check failed: HTTP ${identity.status}; no synthesis requested.`);
  const me = await identity.json();
  report(JSON.stringify({ org_id: me.org_id, project_id: me.project_id, env: me.env,
    limits: me.limits, credit: me.credit, key_budget_cents: me.key_budget_cents }));
  if (me.project_id !== projectId || me.env !== "test") {
    throw new Error("Expected test project does not match /v1/me; no synthesis requested.");
  }
  if (!me.scopes?.includes("speak:synthesize")) throw new Error("Test key lacks speak:synthesize.");
  const cap = me.limits?.daily_unit_cap;
  if (!me.limits || typeof me.limits !== "object" || Array.isArray(me.limits)
      || (cap != null && (!Number.isFinite(cap) || cap <= 0))) {
    throw new Error("Invalid or zero test daily cap; no synthesis requested.");
  }
  // The identity contract defines absent/null as no provider-enforced daily cap.
  if (cap == null) report("No daily cap enforced; this run is still bounded to one 49-character request.");
  const response = await fetchImpl(`${base}/v1/audio/speech`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ model: "pyai-speak", input: TEXT, voice,
      response_format: "g711_ulaw", sample_rate: 8000, stream: true }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Speech request failed: HTTP ${response.status}; do not retry automatically.`);
  }
  if (!response.body || response.headers.get("content-type")?.split(";")[0] !== "audio/basic") {
    await response.body?.cancel();
    throw new Error("Expected raw G.711 audio/basic response.");
  }
  // pipeline preserves sink backpressure and cancels upstream on abort/failure.
  await pipeline(Readable.fromWeb(response.body), sink, { signal });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = "out.ulaw";
  let sink;
  let owned = false;
  try {
    const file = await open(output, "wx");
    owned = true;
    sink = file.createWriteStream();
    sink.on("error", () => {});
    await streamGreeting({ apiKey: process.env.PYAI_API_KEY, projectId: process.env.PYAI_PROJECT_ID,
      voice: process.env.PYAI_VOICE, baseURL: process.env.PYAI_BASE_URL, sink });
    console.log(`Wrote ${output}: raw 8 kHz mono μ-law. No call was placed.`);
  } catch (error) {
    sink?.destroy();
    // Preserve an existing file; remove only a file opened by this invocation.
    if (owned) await rm(output, { force: true });
    console.error(error.message);
    process.exitCode = 1;
  }
}
