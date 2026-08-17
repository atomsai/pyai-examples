// Print the Layer D shared-pack table.
//
// Default: score the offline Omni contract fixtures.
// A LiveKit / Pipecat / live-Omni drop-in is a directory of the same fixture
// shape, one file per scenario id (`<id>.offline.json` or `<id>.json`).

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFixture } from "./fixture.js";
import { SHARED_PACK, scoreSharedPack } from "./bakeoff.js";

const BASE_DIR = fileURLToPath(new URL("..", import.meta.url));

function parseArgs(argv) {
  const opts = { system: "omni-offline", runsDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--system") opts.system = argv[++i];
    else if (a === "--runs-dir") opts.runsDir = argv[++i];
    else throw new Error(`unknown flag: ${a}`);
  }
  return opts;
}

function loadRuns(runsDir) {
  if (!runsDir) return {};
  const root = runsDir.startsWith("/") ? runsDir : resolve(BASE_DIR, runsDir);
  const runs = {};
  for (const { id } of SHARED_PACK) {
    const candidates = [
      resolve(root, `${id}.offline.json`),
      resolve(root, `${id}.json`),
    ];
    const path = candidates.find((p) => existsSync(p));
    if (path) runs[id] = loadFixture(path);
  }
  return runs;
}

const opts = parseArgs(process.argv.slice(2));
const runs = loadRuns(opts.runsDir);
const rows = scoreSharedPack(BASE_DIR, runs, { requireRuns: Boolean(opts.runsDir) });
const failed = rows.filter((r) => r.verdict !== "SKIP" && !r.ok);
const missing = rows.filter((r) => r.verdict === "SKIP").map((r) => r.id);

console.log("system\tscenario\tintended\tverdict\tTSR\tQ-rate\tCRR\tRAR\tGHR\tHPS");
for (const r of rows) {
  const n = (v) => (v == null ? "n/a" : String(v));
  console.log(
    [opts.system, r.id, r.intended, r.verdict, n(r.tsr), n(r.qRate), n(r.crr), n(r.rar), n(r.ghr), n(r.hps)].join("\t"),
  );
}
if (missing.length) {
  console.error(`\n${missing.length} shared-pack id(s) missing from ${opts.runsDir}: ${missing.join(", ")}`);
}
if (failed.length) {
  console.error(`\n${failed.length} shared-pack row(s) missed intended verdict`);
  process.exit(1);
}
console.error(`\n${rows.length} shared-pack rows matched intended verdict`);
