import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";


const BASE_DIR = fileURLToPath(new URL("..", import.meta.url));
export const RATING_FIELDS = [
  "heard",
  "remembered",
  "no_form",
  "kept_promise",
  "left_space",
  "would_call_again",
];
const HPS_FIELDS = RATING_FIELDS.slice(0, 5);


function parseArgs(argv) {
  const opts = { mapping: null, raters: [], out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mapping") opts.mapping = argv[++i];
    else if (arg === "--rater") opts.raters.push(argv[++i]);
    else if (arg === "--out") opts.out = argv[++i];
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (!opts.mapping || opts.raters.length < 2 || opts.raters.length > 3) {
    throw new Error(
      "usage: layer-e-score --mapping <mapping.json> --rater <one.csv> " +
        "--rater <two.csv> [--rater <adjudication.csv>] [--out <result.json>]",
    );
  }
  return opts;
}


function absolute(path) {
  return path.startsWith("/") ? path : resolve(BASE_DIR, path);
}


export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === "\"" && text[i + 1] === "\"") {
        field += "\"";
        i += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("unterminated quoted CSV field");
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    if (row.some((value) => value !== "")) rows.push(row);
  }
  return rows;
}


function parseRating(value, { optional = false } = {}) {
  const normalized = String(value || "").trim().toLowerCase();
  if (optional && !normalized) return undefined;
  if (normalized === "yes") return 1;
  if (normalized === "no") return 0;
  if (normalized === "n/a" || normalized === "na") return null;
  throw new Error(`rating must be yes, no, or n/a, got ${JSON.stringify(value)}`);
}


function loadSheet(path, expectedCallIds, { optional = false } = {}) {
  const rows = parseCsv(readFileSync(absolute(path), "utf8"));
  if (!rows.length) throw new Error(`empty rater sheet: ${path}`);
  const header = rows[0];
  const required = ["call_id", ...RATING_FIELDS];
  for (const field of required) {
    if (!header.includes(field)) throw new Error(`${path} is missing column ${field}`);
  }

  const ratings = new Map();
  for (const row of rows.slice(1)) {
    const record = Object.fromEntries(header.map((field, index) => [field, row[index] ?? ""]));
    const callId = String(record.call_id || "").trim();
    if (!callId) continue;
    if (!expectedCallIds.has(callId)) throw new Error(`${path} has unknown call_id ${callId}`);
    if (ratings.has(callId)) throw new Error(`${path} repeats call_id ${callId}`);
    const values = {};
    for (const field of RATING_FIELDS) {
      values[field] = parseRating(record[field], { optional });
    }
    ratings.set(callId, values);
  }
  if (!optional) {
    for (const callId of expectedCallIds) {
      if (!ratings.has(callId)) throw new Error(`${path} is missing call_id ${callId}`);
    }
  }
  return ratings;
}


function round(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}


function agreementStats(first, second, mapping) {
  let agreements = 0;
  let total = 0;
  let firstYes = 0;
  let secondYes = 0;
  let binaryItems = 0;
  for (const { call_id: callId } of mapping) {
    for (const field of RATING_FIELDS) {
      const a = first.get(callId)[field];
      const b = second.get(callId)[field];
      agreements += Number(Object.is(a, b));
      if (a != null && b != null) {
        firstYes += a;
        secondYes += b;
        binaryItems += 1;
      }
      total += 1;
    }
  }
  const observed = agreements / total;
  const firstRate = binaryItems ? firstYes / binaryItems : null;
  const secondRate = binaryItems ? secondYes / binaryItems : null;
  const binaryAgreement = binaryItems
    ? mapping.reduce((count, { call_id: callId }) => (
        count +
        RATING_FIELDS.filter((field) => {
          const a = first.get(callId)[field];
          const b = second.get(callId)[field];
          return a != null && b != null && a === b;
        }).length
      ), 0) / binaryItems
    : null;
  const expected =
    binaryItems
      ? firstRate * secondRate + (1 - firstRate) * (1 - secondRate)
      : null;
  const kappa =
    expected == null || expected === 1
      ? null
      : (binaryAgreement - expected) / (1 - expected);
  return {
    items: total,
    percent_agreement: round(observed * 100),
    binary_items: binaryItems,
    cohens_kappa: kappa == null ? null : round(kappa, 3),
  };
}


export function scoreLayerE(mapping, first, second, adjudication = new Map()) {
  const needsAdjudication = [];
  const finalByCall = new Map();
  for (const { call_id: callId } of mapping) {
    const a = first.get(callId);
    const b = second.get(callId);
    const third = adjudication.get(callId) || {};
    const disagreements = RATING_FIELDS.filter(
      (field) => !Object.is(a[field], b[field]),
    );
    const missingThird = disagreements.filter((field) => third[field] === undefined);
    if (disagreements.length >= 2 && missingThird.length) {
      needsAdjudication.push({
        call_id: callId,
        fields: disagreements,
      });
    }
    const values = {};
    for (const field of RATING_FIELDS) {
      values[field] =
        Object.is(a[field], b[field])
          ? a[field]
          : third[field] !== undefined
            ? third[field]
            : a[field] != null && b[field] != null
              ? 0.5
              : null;
    }
    finalByCall.set(callId, values);
  }

  const grouped = new Map();
  for (const item of mapping) {
    if (!grouped.has(item.system)) grouped.set(item.system, []);
    grouped.get(item.system).push(item.call_id);
  }
  const systems = {};
  for (const [system, callIds] of grouped) {
    const dimensions = {};
    const dimensionCalls = {};
    for (const field of RATING_FIELDS) {
      const values = callIds
        .map((callId) => finalByCall.get(callId)[field])
        .filter((value) => value != null);
      dimensionCalls[field] = values.length;
      dimensions[field] = values.length
        ? round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100)
        : null;
    }
    const hpsDimensions = HPS_FIELDS
      .map((field) => dimensions[field])
      .filter((value) => value != null);
    systems[system] = {
      calls: callIds.length,
      hps: hpsDimensions.length
        ? round(
            hpsDimensions.reduce((sum, value) => sum + value, 0) /
              hpsDimensions.length,
          )
        : null,
      would_call_again: dimensions.would_call_again,
      dimensions,
      dimension_calls: dimensionCalls,
    };
  }

  return {
    status: needsAdjudication.length ? "needs_adjudication" : "complete",
    calls: mapping.length,
    agreement: agreementStats(first, second, mapping),
    needs_adjudication: needsAdjudication,
    systems,
  };
}


function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mapping = JSON.parse(readFileSync(absolute(opts.mapping), "utf8"));
  if (!Array.isArray(mapping) || !mapping.length) {
    throw new Error("mapping must be a non-empty array");
  }
  const callIds = new Set(mapping.map((row) => row.call_id));
  if (callIds.size !== mapping.length || mapping.some((row) => !row.system)) {
    throw new Error("mapping needs unique call_id values and a system for every row");
  }
  const first = loadSheet(opts.raters[0], callIds);
  const second = loadSheet(opts.raters[1], callIds);
  const adjudication =
    opts.raters.length === 3
      ? loadSheet(opts.raters[2], callIds, { optional: true })
      : new Map();
  const result = scoreLayerE(mapping, first, second, adjudication);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (opts.out) writeFileSync(absolute(opts.out), json);
  process.stdout.write(json);
  if (result.status !== "complete") process.exitCode = 1;
}


if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
