import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { streamGreeting, TEXT } from "./index.js";

const identity = { org_id: "org_fixture", project_id: "proj_fixture", env: "test",
  scopes: ["speak:synthesize"], limits: { daily_unit_cap: 10 } };
const options = { apiKey: "fixture", projectId: identity.project_id, report: () => {} };
function transport(me, speech) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => {
    calls.push({ url, ...init });
    return url.endsWith("/me") ? Response.json(me) : speech(init);
  } };
}
const audio = (body) => new Response(body, { headers: { "content-type": "audio/basic" } });

test("first chunk reaches sink before upstream closes; exactly one bounded speech request", async () => {
  let controller, received;
  const first = new Promise((resolve) => { received = resolve; });
  const body = new ReadableStream({ start(c) { controller = c; c.enqueue(new Uint8Array([1, 2])); } });
  const chunks = [];
  const sink = new Writable({ write(chunk, _, done) { chunks.push([...chunk]); received(); done(); } });
  const mock = transport(identity, () => audio(body));
  const running = streamGreeting({ ...options, ...mock, sink });
  await first;
  assert.deepEqual(chunks, [[1, 2]]);
  controller.enqueue(new Uint8Array([3])); controller.close();
  await running;
  assert.deepEqual(chunks.flat(), [1, 2, 3]);
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[1].method, "POST");
  assert.deepEqual(JSON.parse(mock.calls[1].body), { model: "pyai-speak", input: TEXT,
    voice: "stock_emma_en_gb", response_format: "g711_ulaw", sample_rate: 8000, stream: true });
});

for (const me of [{ ...identity, project_id: "wrong" }, { ...identity, env: "live" },
  { ...identity, scopes: [] }, { ...identity, limits: undefined },
  { ...identity, limits: { daily_unit_cap: 0 } }, { ...identity, limits: { daily_unit_cap: "10" } }]) {
  test(`preflight prevents generation: ${JSON.stringify(me)}`, async () => {
    const mock = transport(me, () => { throw new Error("must not generate"); });
    await assert.rejects(streamGreeting({ ...options, ...mock, sink: new Writable() }));
    assert.equal(mock.calls.length, 1);
  });
}

test("failed submission is not retried", async () => {
  const mock = transport(identity, () => new Response("unavailable", { status: 503 }));
  await assert.rejects(streamGreeting({ ...options, ...mock, sink: new Writable() }), /503/);
  assert.equal(mock.calls.length, 2);
});

for (const reason of ["abort", "sink"]) {
  test(`${reason} failure cancels upstream without retrying`, async () => {
    let cancelled = false;
    const abort = new AbortController();
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; } });
    const sink = new Writable({ write(_, __, done) {
      if (reason === "abort") { abort.abort(); done(); }
      else done(new Error("sink failed"));
    } });
    const mock = transport(identity, () => audio(body));
    await assert.rejects(streamGreeting({ ...options, ...mock, sink, signal: abort.signal }));
    assert.equal(cancelled, true);
    assert.equal(mock.calls.length, 2);
  });
}

for (const limits of [{ concurrency: 1000, monthly_units: null }, { daily_unit_cap: null }]) {
  test(`exempt test project remains bounded with limits ${JSON.stringify(limits)}`, async () => {
    const mock = transport({ ...identity, limits }, () => audio(new Uint8Array([1])));
    const sink = new Writable({ write(_, __, done) { done(); } });
    await streamGreeting({ ...options, ...mock, sink });
    assert.equal(mock.calls.filter(c => c.method === "POST").length, 1);
    assert.equal(JSON.parse(mock.calls[1].body).input.length, 49);
  });
}
