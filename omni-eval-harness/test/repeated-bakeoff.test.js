import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { pcm16ToWav } from "../src/call-audio.js";
import { summarizeRepeatedBakeoff } from "../src/repeated-bakeoff.js";


const FIXTURE = fileURLToPath(
  new URL("../fixtures/appointment-booking.offline.json", import.meta.url),
);


function makeRepeatedSystem(root, name, repeats = 2) {
  const systemRoot = join(root, name);
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const run = join(systemRoot, `run-${String(repeat).padStart(2, "0")}`);
    mkdirSync(run, { recursive: true });
    copyFileSync(FIXTURE, join(run, "appointment-booking.offline.json"));
    writeFileSync(
      join(run, "appointment-booking.wav"),
      pcm16ToWav(new Int16Array([1, 2, 3]), 24000),
    );
  }
  return systemRoot;
}


test("repeated bake-off aggregates identical complete run matrices", () => {
  const root = mkdtempSync(join(tmpdir(), "pyai-repeated-bakeoff-"));
  const omni = makeRepeatedSystem(root, "omni");
  const pipecat = makeRepeatedSystem(root, "pipecat");
  const summary = summarizeRepeatedBakeoff([
    `omni=${omni}`,
    `pipecat=${pipecat}`,
  ], ["appointment-booking"]);

  assert.deepEqual(summary.scenarios, ["appointment-booking"]);
  assert.equal(summary.systems.omni.repeats, 2);
  assert.equal(summary.systems.omni.recorded_calls, 2);
  assert.equal(summary.systems.omni.ttfb.samples, 6);
  assert.equal(summary.systems.omni.ttfb.p50_ms, 300);
  assert.equal(summary.systems.pipecat.content_verdicts.PASS, 2);
});


test("repeated bake-off refuses a missing scenario", () => {
  const root = mkdtempSync(join(tmpdir(), "pyai-repeated-bakeoff-missing-"));
  const omni = makeRepeatedSystem(root, "omni");
  const livekit = makeRepeatedSystem(root, "livekit");
  const extra = join(livekit, "run-02", "reflect-specific.offline.json");
  copyFileSync(FIXTURE, extra);
  writeFileSync(
    join(livekit, "run-02", "reflect-specific.wav"),
    pcm16ToWav(new Int16Array([1]), 24000),
  );

  assert.throws(
    () => summarizeRepeatedBakeoff(
      [`omni=${omni}`, `livekit=${livekit}`],
      ["appointment-booking"],
    ),
    /scenario set differs/,
  );
});
