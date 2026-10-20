// Shared with the standalone playground bundle. Corrections describe the
// server's spoken prefix, not a browser measurement of what the user heard.
// The protocol has no correction turn ID and caps reply at 500 code points;
// delayed empty/identical prefixes cannot be disambiguated across responses.
/** @typedef {{callId: string|null, turn: number, responseKey: string|null, interrupted: boolean}} AssistantTranscriptState */
/** @returns {AssistantTranscriptState} */
export function createAssistantTranscriptState() {
  return { callId: null, turn: 0, responseKey: null, interrupted: false };
}

/** @param {AssistantTranscriptState} state @param {{event?: unknown, call_id?: unknown, turn?: unknown}} event @returns {AssistantTranscriptState} */
export function advanceAssistantTranscriptState(state, event) {
  if (!event || typeof event.call_id !== "string" || !event.call_id) return state;
  if (event.event === "hello" || event.event === "session_started") {
    if (state.callId) return state;
    return { ...state, callId: event.call_id };
  }
  if (event.call_id !== state.callId) return state;
  if (event.event === "turn_begin" && typeof event.turn === "number" && Number.isInteger(event.turn) && event.turn > state.turn) {
    return { ...state, turn: event.turn, responseKey: state.callId + ":" + event.turn, interrupted: false };
  }
  return state;
}

/** @param {AssistantTranscriptState} state @param {{event?: unknown, call_id?: unknown, reply?: unknown}} event */
export function readAssistantInterruption(state, event) {
  if (event?.event !== "assistant_interrupted" || !state.responseKey || state.interrupted
    || event.call_id !== state.callId || typeof event.reply !== "string"
    || Array.from(event.reply).length > 500
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(event.reply)) return null;
  return { responseKey: state.responseKey, reply: event.reply.trim() };
}

/** @template {{role: string, text: string, final: boolean, responseKey?: string|null, interrupted?: boolean}} T
 * @param {T[]} turns @param {{responseKey: string, reply: string}} correction @returns {T[]} */
export function reconcileAssistantTranscript(turns, correction) {
  const index = turns.findLastIndex((turn) => turn.role === "assistant"
    && turn.responseKey === correction.responseKey);
  if (index < 0) return turns;
  const row = turns[index];
  if (row.interrupted || !row.text.startsWith(correction.reply)) return turns;
  // Preserve a caller row that arrived before the interruption control.
  if (!correction.reply) return turns.filter((_, i) => i !== index);
  return turns.map((turn, i) => i === index
    ? { ...turn, text: correction.reply, final: true, interrupted: true } : turn);
}
