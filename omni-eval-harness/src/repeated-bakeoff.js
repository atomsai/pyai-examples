import {
  existsSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFixture } from "./fixture.js";
import {
  LIVE_C_PACK,
  runResultToFixture,
  scoreLiveRow,
} from "./live-pack.js";
import { percentile } from "./scorers.js";
import { loadScenario, resolveScenarioPath } from "./scenario.js";


const BASE_DIR = fileURLToPath(new URL("..", import.meta.url));


function parseArgs(argv) {
  const opts = { systems: [], out: null, scenarios: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--system") opts.systems.push(argv[++i]);
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg === "--scenario") opts.scenarios.push(argv[++i]);
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (opts.systems.length < 2 || !opts.out) {
    throw new Error(
      "usage: repeated-bakeoff --system name=<runs-root> --system ... --out <summary.json>",
    );
  }
  return opts;
}


function absolute(path) {
  return path.startsWith("/") ? path : resolve(BASE_DIR, path);
}


function parseSystem(spec) {
  const eq = spec.indexOf("=");
  if (eq < 1) throw new Error(`--system must be name=<runs-root>, got ${spec}`);
  const name = spec.slice(0, eq);
  const root = absolute(spec.slice(eq + 1));
  const runs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^run-\d+$/.test(entry.name))
    .map((entry) => resolve(root, entry.name))
    .sort();
  if (runs.length < 2) throw new Error(`${name} needs at least two repeated run directories`);
  return { name, root, runs };
}


function fixtureIds(runDir) {
  const errors = readdirSync(runDir).filter((file) => file.endsWith(".error.json"));
  if (errors.length) throw new Error(`${runDir} contains failed recordings: ${errors.join(", ")}`);
  return readdirSync(runDir)
    .filter((file) => file.endsWith(".offline.json"))
    .map((file) => file.replace(/\.offline\.json$/, ""))
    .sort();
}


function sameValues(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}


function counts(rows, field) {
  const out = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const row of rows) {
    const value = row[field];
    if (!(value in out)) throw new Error(`unexpected ${field}: ${value}`);
    out[value] += 1;
  }
  return out;
}


function mean(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  return usable.length
    ? Math.round((usable.reduce((sum, value) => sum + value, 0) / usable.length) * 10) / 10
    : null;
}


function latencySummary(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  return {
    samples: usable.length,
    p50_ms: percentile(usable, 0.5),
    p95_ms: percentile(usable, 0.95),
  };
}


export function summarizeRepeatedBakeoff(systemSpecs, requiredIds = null) {
  const systems = systemSpecs.map(parseSystem);
  if (new Set(systems.map((system) => system.name)).size !== systems.length) {
    throw new Error("system names must be unique");
  }
  const expectedIds = requiredIds ? [...requiredIds].sort() : fixtureIds(systems[0].runs[0]);
  if (!expectedIds.length) throw new Error("repeated bake-off has no fixtures");
  for (const system of systems) {
    for (const runDir of system.runs) {
      const ids = fixtureIds(runDir);
      if (!sameValues(ids, expectedIds)) {
        throw new Error(
          `${runDir} scenario set differs; missing failures may not be dropped from a bake-off`,
        );
      }
      for (const id of ids) {
        if (!existsSync(resolve(runDir, `${id}.wav`))) {
          throw new Error(`${runDir}/${id}.wav is missing`);
        }
      }
    }
  }

  const result = {
    recorded_at: new Date().toISOString(),
    scenarios: expectedIds,
    systems: {},
  };
  for (const system of systems) {
    const rows = [];
    const ttfb = [];
    const turn = [];
    const runs = [];
    for (const runDir of system.runs) {
      const runRows = [];
      for (const id of expectedIds) {
        const fixture = loadFixture(resolve(runDir, `${id}.offline.json`));
        const scenario = loadScenario(resolveScenarioPath(id, BASE_DIR));
        const row = scoreLiveRow(
          scenario,
          fixture,
          runResultToFixture(fixture, id),
        );
        rows.push(row);
        runRows.push(row);
        for (const recordedTurn of fixture.turns || []) {
          if (Number.isFinite(recordedTurn.ttfbMs)) ttfb.push(recordedTurn.ttfbMs);
          if (Number.isFinite(recordedTurn.turnMs)) turn.push(recordedTurn.turnMs);
        }
      }
      runs.push({
        run: runDir.split("/").at(-1),
        full_verdicts: counts(runRows, "verdict"),
        content_verdicts: counts(runRows, "content_verdict"),
        mean_tsr: mean(runRows.map((row) => row.tsr)),
      });
    }
    result.systems[system.name] = {
      repeats: system.runs.length,
      recorded_calls: rows.length,
      full_verdicts: counts(rows, "verdict"),
      content_verdicts: counts(rows, "content_verdict"),
      mean_tsr: mean(rows.map((row) => row.tsr)),
      mean_ghr: mean(rows.map((row) => row.ghr)),
      ttfb: latencySummary(ttfb),
      turn_latency: latencySummary(turn),
      runs,
    };
  }
  return result;
}


function main() {
  const opts = parseArgs(process.argv.slice(2));
  const summary = summarizeRepeatedBakeoff(
    opts.systems,
    opts.scenarios.length ? opts.scenarios : LIVE_C_PACK,
  );
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(absolute(opts.out), json);
  process.stdout.write(json);
}


if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
