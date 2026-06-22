// Scenario format + loader/validator.
//
// A scenario is a JSON file under scenarios/:
//
//   {
//     "id": "appointment-booking",
//     "persona": "You are the front-desk scheduler for ...",
//     "agent_id": "clinic-front-desk",
//     "opening": "Thanks for calling ...",
//     "turns": [
//       { "caller_says": "...", "expect": [ <Assertion>, ... ] }
//     ],
//     "thresholds": { "werPct": 10, "ttfbMs": 800, "turnP95Ms": 1500,
//                     "bargeRecoveryPct": 90, "tsrPct": 85, "vaqi": 70 }
//   }
//
// Assertions (the `expect` array):
//   { "type": "contains",       "value": "cleaning", "ignoreCase": true }
//   { "type": "not_contains",   "value": "sorry" }
//   { "type": "regex",          "value": "(mon|tue|wed)", "flags": "i" }
//   { "type": "tool_called",    "name": "book_appointment", "args": { "day": "Wednesday" } }
//   { "type": "latency_budget", "ttfbMs": 800, "turnMs": 1500 }
//
// Caller turns are plain text. In voice mode the runner synthesizes each
// `caller_says` to audio via Speak; in text mode it sends the text directly.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ASSERTION_TYPES = new Set([
  "contains",
  "not_contains",
  "regex",
  "tool_called",
  "latency_budget",
]);

/** Validate a parsed scenario object. Throws an Error listing every problem. */
export function validateScenario(s) {
  const errs = [];
  if (!s || typeof s !== "object") throw new Error("scenario must be a JSON object");
  if (typeof s.id !== "string" || s.id.trim() === "") errs.push("`id` (string) is required");
  if (!Array.isArray(s.turns) || s.turns.length === 0) errs.push("`turns` must be a non-empty array");

  if (Array.isArray(s.turns)) {
    s.turns.forEach((t, i) => {
      if (typeof t.caller_says !== "string" || t.caller_says.trim() === "") {
        errs.push(`turns[${i}].caller_says (string) is required`);
      }
      const expect = t.expect ?? [];
      if (!Array.isArray(expect)) {
        errs.push(`turns[${i}].expect must be an array`);
      } else {
        expect.forEach((a, j) => {
          if (!a || !ASSERTION_TYPES.has(a.type)) {
            errs.push(`turns[${i}].expect[${j}].type must be one of ${[...ASSERTION_TYPES].join("/")}`);
            return;
          }
          if ((a.type === "contains" || a.type === "not_contains" || a.type === "regex") && typeof a.value !== "string") {
            errs.push(`turns[${i}].expect[${j}] (${a.type}) requires a string \`value\``);
          }
          if (a.type === "tool_called" && typeof a.name !== "string") {
            errs.push(`turns[${i}].expect[${j}] (tool_called) requires a string \`name\``);
          }
          if (a.type === "latency_budget" && a.ttfbMs == null && a.turnMs == null) {
            errs.push(`turns[${i}].expect[${j}] (latency_budget) needs ttfbMs and/or turnMs`);
          }
        });
      }
    });
  }

  if (s.thresholds != null && typeof s.thresholds !== "object") {
    errs.push("`thresholds` must be an object when present");
  }

  if (errs.length > 0) throw new Error(`Invalid scenario "${s?.id ?? "?"}":\n  - ${errs.join("\n  - ")}`);
  return s;
}

/** Parse + validate a scenario from a JSON string. */
export function parseScenario(json) {
  let obj;
  try {
    obj = JSON.parse(json);
  } catch (err) {
    throw new Error(`scenario is not valid JSON: ${err.message}`);
  }
  return validateScenario(obj);
}

/** Load + validate a scenario from a file path. */
export function loadScenario(path) {
  return parseScenario(readFileSync(path, "utf8"));
}

/**
 * Resolve a scenario reference that may be a path ("scenarios/foo.json") or a
 * bare id ("foo", looked up as scenarios/foo.json relative to `baseDir`).
 */
export function resolveScenarioPath(ref, baseDir) {
  if (ref.endsWith(".json")) return resolve(baseDir, ref);
  return resolve(baseDir, "scenarios", `${ref}.json`);
}
