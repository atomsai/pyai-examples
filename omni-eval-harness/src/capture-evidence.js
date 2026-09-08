// Allowlisted diagnostic metadata shared by live fixture export and replay.
// Reject malformed/oversized evidence rather than quietly dropping pieces of
// a transcript or claiming a truncated recording is complete.
const MAX_EVENTS = 4096;
const MAX_TEXT = 1_000_000;
const own = (value, key) => Object.hasOwn(value, key);
const fail = () => { throw new Error("Invalid or oversized capture evidence"); };
const record = value => value && typeof value === "object" && !Array.isArray(value) ? value : fail();
const number = value => value === null || (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) ? value : fail();
const integer = value => value === null || (Number.isSafeInteger(value) && value >= -1) ? value : fail();
const text = (value, max = MAX_TEXT) => value === null || (typeof value === "string" && value.length <= max) ? value : fail();
const bool = value => typeof value === "boolean" ? value : fail();
const mode = value => value === "delta" || value === "replace" ? value : fail();

function fields(value, schema) {
  const source = record(value);
  const result = {};
  for (const [key, normalize] of Object.entries(schema)) if (own(source, key)) result[key] = normalize(source[key]);
  return result;
}

function events(value, schema, required = []) {
  if (!Array.isArray(value) || value.length > MAX_EVENTS) fail();
  return value.map(event => {
    record(event);
    if (required.some(key => !own(event, key))) fail();
    return fields(event, schema);
  });
}

const timestamp = value => value !== null ? number(value) : fail();
const transcriptSchema = {
  atMs: timestamp, clientTurnIndex: integer, text: value => typeof value === "string" && value.length > 0 ? text(value, 4000) : fail(),
  final: bool, mode, sequence: value => Number.isSafeInteger(value) && value >= 0 ? value : fail(),
};
const transcriptEvents = value => events(value, transcriptSchema, ["atMs", "text", "final", "mode"]);
const boundedString = value => text(value, 1024);

const METHOD_SCHEMA = Object.fromEntries([
  ...["inputRate", "outputRate", "settleQuietMs", "maxInputGapMs"].map(key => [key, number]),
  ...["agentTranscription", "callerTranscription", "engineCallerTranscription", "timing", "turnBoundary",
    "postTurnBeginTiming", "completionLimitation"].map(key => [key, boundedString]),
]);
const TIMING_SCHEMA = Object.fromEntries([
  ...["ttfbMs", "anyAudioTtfbMs", "postTurnBeginTtfbMs", "turnMs", "packetTtfbMs",
    "callerStartMs", "callerSpeechOnsetMs", "callerSpeechOffsetMs", "callerStreamEndMs",
    "agentFirstPacketMs", "agentLastPacketMs", "agentSpeechOnsetMs", "agentSpeechOffsetMs",
    "agentPlaybackEndMs", "latestTurnBeginMs", "postTurnBeginFirstPacketMs",
    "postTurnBeginSpeechOnsetMs", "lastAssistantTranscriptMs", "callerMaxFrameGapMs"].map(key => [key, number]),
  ...["method", "callerOffsetBasis", "settleReason"].map(key => [key, boundedString]),
]);

const RUN_SCHEMA = {
  captureMethod: ["capture_method", value => value === null ? null : fields(value, METHOD_SCHEMA)],
  engineCallerTranscriptEvents: ["engine_caller_transcript_events", transcriptEvents],
};
const TURN_SCHEMA = {
  anyAudioTtfbMs: ["any_audio_ttfb_ms", number],
  postTurnBeginTtfbMs: ["post_turn_begin_ttfb_ms", number],
  replyStartedAtMs: ["reply_started_at_ms", number],
  sttFinalMs: ["eou_ms", number],
  brainTtsMs: ["brain_tts_ms", number],
  timing: ["timing", value => value === null ? null : fields(value, TIMING_SCHEMA)],
  engineAssistantText: ["engine_assistant_text", text],
  engineCallerText: ["engine_caller_text", text],
  engineCallerTranscriptEvents: ["engine_caller_transcript_events", transcriptEvents],
  engineAssistantTranscriptEvents: ["engine_assistant_transcript_events", transcriptEvents],
  turnBegins: ["turn_begins", value => events(value, { atMs: timestamp, turn: integer }, ["atMs", "turn"])],
  events: ["events", value => events(value, { atMs: timestamp, event: value =>
    ["idle_prompt", "flush", "barge_in", "end_call", "session_end"].includes(value) ? value : fail() }, ["atMs", "event"])],
};

/** Preserve the existing snake_case artifact and camelCase run conventions. */
export function captureEvidence(source, { turn = false, serialized = false } = {}) {
  record(source);
  const schema = turn ? TURN_SCHEMA : RUN_SCHEMA;
  const result = {};
  for (const [camel, [snake, normalize]] of Object.entries(schema)) {
    const input = own(source, camel) ? camel : own(source, snake) ? snake : null;
    if (input !== null) result[serialized ? snake : camel] = normalize(source[input]);
  }
  return result;
}
