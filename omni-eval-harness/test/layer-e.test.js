import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pcm16ToWav } from "../src/call-audio.js";
import { buildLayerEBundle } from "../src/layer-e-bundle.js";
import {
  RATING_FIELDS,
  parseCsv,
  scoreLayerE,
} from "../src/layer-e-score.js";


function makeRuns(root, name, scenarios) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const scenario of scenarios) {
    writeFileSync(
      join(dir, `${scenario}.offline.json`),
      `${JSON.stringify({ scenario, turns: [] })}\n`,
    );
    writeFileSync(
      join(dir, `${scenario}.wav`),
      pcm16ToWav(new Int16Array([1, 2, 3, 4]), 24000),
    );
  }
  return dir;
}


function ratings(value) {
  return Object.fromEntries(RATING_FIELDS.map((field) => [field, value]));
}


test("Layer E bundle contains audio only and seals system mapping separately", () => {
  const root = mkdtempSync(join(tmpdir(), "pyai-layer-e-"));
  const omni = makeRuns(root, "omni", ["a", "b", "c"]);
  const livekit = makeRuns(root, "livekit", ["a", "b", "c"]);
  const out = join(root, "bundle");
  const result = buildLayerEBundle({
    out,
    systems: [`omni=${omni}`, `livekit=${livekit}`],
    per: 2,
    seed: 17,
  });

  const raterFiles = readdirSync(result.raterDir).sort();
  assert.equal(raterFiles.filter((file) => file.endsWith(".wav")).length, 4);
  assert(raterFiles.includes("INSTRUCTIONS.md"));
  assert(raterFiles.includes("scoresheet.csv"));
  assert(!raterFiles.includes("mapping.json"));
  assert.match(
    readFileSync(join(result.raterDir, "INSTRUCTIONS.md"), "utf8"),
    /4 short phone-call recordings/,
  );
  assert(existsSync(join(result.coordinatorDir, "mapping.json")));
  assert.equal(new Set(result.mapping.map((row) => row.scenario)).size, 2);
  assert.equal(new Set(result.mapping.map((row) => row.system)).size, 2);
  assert(result.mapping.every((row) => /^[0-9a-f]{64}$/.test(row.audio_sha256)));
});


test("Layer E bundle refuses transcript-only evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "pyai-layer-e-no-audio-"));
  const first = makeRuns(root, "first", ["a"]);
  const second = makeRuns(root, "second", ["a"]);
  writeFileSync(join(second, "a.wav"), Buffer.alloc(44));
  assert.throws(
    () =>
      buildLayerEBundle({
        out: join(root, "bundle"),
        systems: [`first=${first}`, `second=${second}`],
        per: 1,
        seed: 1,
      }),
    /missing listenable WAV/,
  );
});


test("Layer E scoring requires adjudication for multi-item disagreement", () => {
  const mapping = [
    { call_id: "call_01", system: "omni", scenario: "a" },
    { call_id: "call_02", system: "livekit", scenario: "a" },
  ];
  const first = new Map([
    ["call_01", ratings(1)],
    ["call_02", ratings(1)],
  ]);
  const secondCall = ratings(1);
  secondCall.heard = 0;
  secondCall.remembered = 0;
  const second = new Map([
    ["call_01", ratings(1)],
    ["call_02", secondCall],
  ]);

  const pending = scoreLayerE(mapping, first, second);
  assert.equal(pending.status, "needs_adjudication");
  assert.deepEqual(pending.needs_adjudication, [{
    call_id: "call_02",
    fields: ["heard", "remembered"],
  }]);

  const adjudication = new Map([[
    "call_02",
    { ...ratings(null), heard: 0, remembered: 1 },
  ]]);
  const complete = scoreLayerE(mapping, first, second, adjudication);
  assert.equal(complete.status, "complete");
  assert.equal(complete.systems.omni.hps, 100);
  assert.equal(complete.systems.livekit.dimensions.heard, 0);
  assert.equal(complete.systems.livekit.dimensions.remembered, 100);
});


test("Layer E scoring excludes truly inapplicable dimensions", () => {
  const mapping = [{ call_id: "call_01", system: "omni", scenario: "a" }];
  const row = ratings(1);
  row.remembered = null;
  const result = scoreLayerE(
    mapping,
    new Map([["call_01", row]]),
    new Map([["call_01", { ...row }]]),
  );
  assert.equal(result.status, "complete");
  assert.equal(result.systems.omni.dimensions.remembered, null);
  assert.equal(result.systems.omni.dimension_calls.remembered, 0);
  assert.equal(result.systems.omni.hps, 100);
});


test("CSV parser preserves quoted notes with commas", () => {
  const rows = parseCsv(
    "call_id,heard,notes\ncall_01,yes,\"specific, calm reply\"\n",
  );
  assert.deepEqual(rows[1], ["call_01", "yes", "specific, calm reply"]);
});
