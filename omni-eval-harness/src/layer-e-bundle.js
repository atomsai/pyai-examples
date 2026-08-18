// Build a blinded Layer E rating bundle from recorded holdout runs.
//
//   node src/layer-e-bundle.js --out ./out/layer-e-bundle \
//     --system omni=./holdout/live-verify-2026-08-17 \
//     --system livekit=./holdout/livekit-2026-08-17 \
//     --system pipecat=./holdout/pipecat-2026-08-17
//
// Selects N common scenarios per system (default 7), requires a real WAV beside
// every fixture, renames the audio call_01..call_N with a seeded shuffle, and
// writes mapping.json (system truth) plus scoresheet.csv. The coordinator keeps
// mapping.json sealed until both rater sheets are in.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_DIR = fileURLToPath(new URL("..", import.meta.url));

export function parseArgs(argv) {
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
  if (!Number.isInteger(opts.per) || opts.per <= 0) {
    throw new Error("--per must be a positive integer");
  }
  if (!Number.isInteger(opts.seed)) {
    throw new Error("--seed must be an integer");
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


function parseSystem(spec) {
  const eq = spec.indexOf("=");
  if (eq < 1) throw new Error(`--system must be name=<runs-dir>, got: ${spec}`);
  const name = spec.slice(0, eq);
  const dir = spec.slice(eq + 1);
  const root = dir.startsWith("/") ? dir : resolve(BASE_DIR, dir);
  const fixtures = new Map();
  for (const file of readdirSync(root).filter((value) => value.endsWith(".offline.json"))) {
    const scenario = file.replace(/\.offline\.json$/, "");
    fixtures.set(scenario, {
      fixture: resolve(root, file),
      audio: resolve(root, `${scenario}.wav`),
    });
  }
  return { name, root, fixtures };
}


function shuffle(values, rand) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}


function audioSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}


function assertListenableWav(path, system, scenario) {
  if (!existsSync(path) || statSync(path).size <= 44) {
    throw new Error(`missing listenable WAV for ${system}/${scenario}: ${path}`);
  }
  const header = Buffer.alloc(12);
  const fd = openSync(path, "r");
  try {
    readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`invalid WAV for ${system}/${scenario}: ${path}`);
  }
}


export function buildLayerEBundle(opts) {
  const outDir = opts.out.startsWith("/") ? opts.out : resolve(BASE_DIR, opts.out);
  if (existsSync(outDir) && readdirSync(outDir).length) {
    throw new Error(`refusing to overwrite non-empty Layer E bundle: ${outDir}`);
  }
  const systems = opts.systems.map(parseSystem);
  if (systems.length < 2) throw new Error("Layer E needs at least two systems");
  if (new Set(systems.map((system) => system.name)).size !== systems.length) {
    throw new Error("Layer E system names must be unique");
  }

  const common = [...systems[0].fixtures.keys()]
    .filter((scenario) => systems.every((system) => system.fixtures.has(scenario)))
    .sort();
  if (common.length < opts.per) {
    throw new Error(
      `only ${common.length} common scenario(s) have fixtures; ${opts.per} required per system`,
    );
  }

  const rand = mulberry32(opts.seed);
  const scenarios = shuffle(common, rand).slice(0, opts.per);
  const picked = [];
  for (const system of systems) {
    for (const scenario of scenarios) {
      const files = system.fixtures.get(scenario);
      assertListenableWav(files.audio, system.name, scenario);
      picked.push({
        system: system.name,
        scenario,
        fixture: files.fixture,
        audio: files.audio,
      });
    }
  }

  const raterDir = resolve(outDir, "rater");
  const coordinatorDir = resolve(outDir, "coordinator");
  mkdirSync(raterDir, { recursive: true });
  mkdirSync(coordinatorDir, { recursive: true });
  const order = shuffle(picked, rand);
  const mapping = [];
  const sheet = [
    "call_id,heard,remembered,no_form,kept_promise,left_space,would_call_again,notes",
  ];
  order.forEach((src, i) => {
    const callId = `call_${String(i + 1).padStart(2, "0")}`;
    const destination = resolve(raterDir, `${callId}.wav`);
    copyFileSync(src.audio, destination);
    mapping.push({
      call_id: callId,
      system: src.system,
      scenario: src.scenario,
      audio_sha256: audioSha256(destination),
    });
    sheet.push(`${callId},,,,,,,`);
  });

  const instructions = readFileSync(
    resolve(BASE_DIR, "layer-e/RATER_PACKET.md"),
    "utf8",
  );
  writeFileSync(
    resolve(raterDir, "INSTRUCTIONS.md"),
    instructions.replaceAll("{{CALL_COUNT}}", String(mapping.length)),
  );
  writeFileSync(resolve(raterDir, "scoresheet.csv"), `${sheet.join("\n")}\n`);
  writeFileSync(
    resolve(coordinatorDir, "mapping.json"),
    `${JSON.stringify(mapping, null, 2)}\n`,
  );
  console.log(`bundle: ${mapping.length} calls from ${systems.length} systems -> ${outDir}`);
  console.log("Share only rater/. Keep coordinator/mapping.json sealed until both sheets are in.");
  return { outDir, raterDir, coordinatorDir, mapping, scenarios };
}


if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildLayerEBundle(parseArgs(process.argv.slice(2)));
}
