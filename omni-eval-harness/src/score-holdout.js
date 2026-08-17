// Score a holdout directory of fixture-shaped recordings with the Layer C row shape.

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadScenario, resolveScenarioPath } from "./scenario.js";
import { loadFixture } from "./fixture.js";
import { LIVE_C_PACK, runResultToFixture, scoreLiveRow } from "./live-pack.js";

const BASE_DIR = fileURLToPath(new URL("..", import.meta.url));

function parseArgs(argv) {
  const opts = { system: "holdout", runsDir: null, ids: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--system") opts.system = argv[++i];
    else if (a === "--runs-dir") opts.runsDir = argv[++i];
    else if (!a.startsWith("--")) opts.ids.push(a);
    else throw new Error(`unknown flag: ${a}`);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.runsDir) {
  console.error("usage: node src/score-holdout.js --system livekit --runs-dir ./holdout/livekit-2026-08-17");
  process.exit(2);
}
const root = opts.runsDir.startsWith("/") ? opts.runsDir : resolve(BASE_DIR, opts.runsDir);
const ids = opts.ids.length ? opts.ids : LIVE_C_PACK;
const rows = ids.map((id) => {
  const path = [resolve(root, `${id}.offline.json`), resolve(root, `${id}.json`)].find((p) =>
    existsSync(p),
  );
  if (!path) return { id, verdict: "ERROR", error: "missing recording" };
  const scenario = loadScenario(resolveScenarioPath(id, BASE_DIR));
  const run = loadFixture(path);
  return scoreLiveRow(scenario, run, runResultToFixture(run, id));
});
const summary = {
  system: opts.system,
  recorded_at: new Date().toISOString(),
  note: "verdict includes production TTFB/turn gates. content_verdict opens those gates. listenRubric is not Layer E.",
  rows,
};
writeFileSync(resolve(root, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
