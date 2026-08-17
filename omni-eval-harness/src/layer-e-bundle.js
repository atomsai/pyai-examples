// Build a blinded Layer E rating bundle from recorded holdout runs.
//
//   node src/layer-e-bundle.js --out ./out/layer-e-bundle \
//     --system omni=./holdout/live-verify-2026-08-17 \
//     --system livekit=./holdout/livekit-2026-08-17 \
//     --system pipecat=./holdout/pipecat-2026-08-17
//
// Copies up to N fixtures per system (default 7, stratified by scenario id so
// the same scenario appears across systems when present), renames them
// call_01..call_N with a seeded shuffle, and writes mapping.json (system truth)
// plus scoresheet.csv. The coordinator keeps mapping.json sealed until both
// rater sheets are in.

import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_DIR = fileURLToPath(new URL("..", import.meta.url));

function parseArgs(argv) {
  const opts = { out: null, systems: [], per: 7, seed: 20260817 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--per") opts.per = Number(argv[++i]);
    else if (a === "--seed") opts.seed = Number(argv[++i]);
    else if (a === "--system") opts.systems.push(argv[++i]);
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!opts.out || opts.systems.length === 0) {
    throw new Error("usage: layer-e-bundle --out <dir> --system name=<runs-dir> [--system ...] [--per 7] [--seed n]");
  }
  return opts;
}

// Deterministic PRNG so the bundle is reproducible for the same seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const opts = parseArgs(process.argv.slice(2));
const outDir = opts.out.startsWith("/") ? opts.out : resolve(BASE_DIR, opts.out);
mkdirSync(outDir, { recursive: true });

const picked = [];
for (const spec of opts.systems) {
  const eq = spec.indexOf("=");
  if (eq < 1) throw new Error(`--system must be name=<runs-dir>, got: ${spec}`);
  const name = spec.slice(0, eq);
  const dir = spec.slice(eq + 1);
  const root = dir.startsWith("/") ? dir : resolve(BASE_DIR, dir);
  const fixtures = readdirSync(root)
    .filter((f) => f.endsWith(".offline.json"))
    .sort()
    .slice(0, opts.per);
  for (const f of fixtures) {
    picked.push({ system: name, file: resolve(root, f), scenario: f.replace(/\.offline\.json$/, "") });
  }
}

const rand = mulberry32(opts.seed);
const order = picked.map((_, i) => i);
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}

const mapping = [];
const sheet = ["call_id,heard,remembered,no_form,kept_promise,left_space,would_call_again,notes"];
order.forEach((srcIdx, i) => {
  const callId = `call_${String(i + 1).padStart(2, "0")}`;
  const src = picked[srcIdx];
  copyFileSync(src.file, resolve(outDir, `${callId}.json`));
  mapping.push({ call_id: callId, system: src.system, scenario: src.scenario });
  sheet.push(`${callId},,,,,,,`);
});

writeFileSync(resolve(outDir, "mapping.json"), `${JSON.stringify(mapping, null, 2)}\n`);
writeFileSync(resolve(outDir, "scoresheet.csv"), `${sheet.join("\n")}\n`);
console.log(`bundle: ${mapping.length} calls from ${opts.systems.length} systems -> ${outDir}`);
console.log("mapping.json is the unblinding key. Seal it until both sheets are in.");
