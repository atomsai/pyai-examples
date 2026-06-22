// Offline fixture loader.
//
// A fixture is a RECORDED session: exactly the per-turn signals the live runner
// captures (caller text, the Hear-stream hypothesis of the caller audio, the
// agent transcript, TTFB + turn latency, tool calls, barge-in), serialized so
// the scorers can replay and score it with no network and no key. This is what
// makes the harness CI-safe and what `npm test` exercises end to end.
//
// Fixture JSON (snake_case, as recorded):
//
//   {
//     "fixture": "appointment-booking.offline",
//     "scenario": "appointment-booking",
//     "agent_id": "clinic-front-desk",
//     "mode": "live-voice",
//     "recorded_at": "2026-06-16T12:00:00Z",
//     "turns": [
//       {
//         "caller_says": "...",        // reference text the caller intended
//         "caller_audio_ms": 2300,     // synth duration (voice mode)
//         "asr_hypothesis": "...",     // Hear-stream transcript of caller audio
//         "agent_text": "...",         // agent reply transcript (Omni)
//         "agent_audio_ms": 4100,
//         "ttfb_ms": 320,              // caller-turn-end -> first agent word/byte
//         "turn_ms": 690,              // caller-turn-end -> agent turn complete
//         "tool_calls": [ { "name": "book_appointment", "args": {...} } ],
//         "barge_in": { "attempted": true, "recovered": true }
//       }
//     ]
//   }

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Normalize a parsed fixture object into the internal RunResult shape. */
export function normalizeFixture(obj, source = null) {
  if (!obj || typeof obj !== "object") throw new Error("fixture must be a JSON object");
  if (!Array.isArray(obj.turns) || obj.turns.length === 0) {
    throw new Error("fixture `turns` must be a non-empty array");
  }
  return {
    scenarioId: obj.scenario ?? null,
    agentId: obj.agent_id ?? null,
    mode: obj.mode ?? "offline",
    recordedAt: obj.recorded_at ?? null,
    source,
    turns: obj.turns.map((t, i) => ({
      index: i,
      callerText: t.caller_says ?? "",
      callerAudioMs: numOrNull(t.caller_audio_ms),
      asrHypothesis: t.asr_hypothesis ?? null,
      agentText: t.agent_text ?? "",
      agentAudioMs: numOrNull(t.agent_audio_ms),
      ttfbMs: numOrNull(t.ttfb_ms),
      turnMs: numOrNull(t.turn_ms),
      toolCalls: Array.isArray(t.tool_calls)
        ? t.tool_calls.map((c) => ({ name: c.name, args: c.args ?? null }))
        : [],
      bargeIn: t.barge_in
        ? { attempted: !!t.barge_in.attempted, recovered: !!t.barge_in.recovered }
        : null,
    })),
  };
}

function numOrNull(v) {
  return typeof v === "number" && !Number.isNaN(v) ? v : null;
}

/** Parse + normalize a fixture from a JSON string. */
export function parseFixture(json, source = null) {
  let obj;
  try {
    obj = JSON.parse(json);
  } catch (err) {
    throw new Error(`fixture is not valid JSON: ${err.message}`);
  }
  return normalizeFixture(obj, source);
}

/** Load + normalize a fixture from a file path. */
export function loadFixture(path) {
  return parseFixture(readFileSync(path, "utf8"), path);
}

/**
 * Resolve a fixture reference: an explicit path, or a bare id looked up as
 * fixtures/<id>.offline.json relative to `baseDir`.
 */
export function resolveFixturePath(ref, baseDir) {
  if (ref.endsWith(".json")) return resolve(baseDir, ref);
  return resolve(baseDir, "fixtures", `${ref}.offline.json`);
}
