import { newAudioCapture, recordAudio, recordTurnBegin, streamPcmRealtime, INTERRUPTION_OBSERVATION } from "./timing.mjs";

export const realClock = {
  now: () => performance.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

/** One bounded, server-side example. Its playback queue is simulated. */
export async function runSession({ pyai, webSocket, caller, interruption, clock = realClock, timeoutMs = 60000 }) {
  const rate = 24000, frameSize = 480, silence = new Int16Array(frameSize);
  if (!(caller instanceof Int16Array) || !caller.length || caller.length > rate * 20) throw new Error("Provide 1–20 seconds of caller PCM16 at 24 kHz");
  if (interruption && (!(interruption instanceof Int16Array) || !interruption.length || interruption.length > rate * 20)) throw new Error("Invalid interruption PCM");
  const started = clock.now(), all = newAudioCapture(started), reply = newAudioCapture(started);
  const report = { input_rate: rate, output_rate: null, playback_sink: "simulated", tool_calls: 0, tool_executions: 0, duplicate_tool_calls: 0, flushes_after_interruption: 0, cleared_queue_ms: 0, interruption_requested: !!interruption, caller_started_ms: null, interruption_started_ms: null, advisory_transcripts: [], end_reason: "timeout" };
  let session, configuredAt = null, closed = false, failure = null, phase = "greeting", offset = 0, queueEnd = started, interruptionSent = false, inputEndAt = started;
  const handled = new Set();
  const fail = message => { failure ??= new Error(message); };
  try {
    session = pyai.omni.connect({
      webSocket, rate,
      configure: {
        voice_id: "stock_amos_en_us", language: "en", greeting: "Hello. How can I help?",
        persona: "When asked about office hours, call lookup_office_hours. Never guess. After the result, say one short sentence giving its opening_time.",
        tools: [{ name: "lookup_office_hours", description: "Read the synthetic example office opening time.", side_effect: "read", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } }],
      },
      onHello: frame => {
        const match = /^pcm16@(8000|24000)$/.exec(frame.audio_out ?? "");
        if (!match) return fail("Unsupported Omni output format");
        report.output_rate = Number(match[1]);
      },
      onConfigured: () => { configuredAt ??= clock.now(); },
      onAudio: chunk => {
        if (!report.output_rate) return fail("Audio arrived before its output format");
        const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        if (bytes.byteLength % 2) return fail("Invalid PCM16 output");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const pcm = Int16Array.from({ length: bytes.length / 2 }, (_, i) => view.getInt16(i * 2, true));
        const now = clock.now();
        recordAudio(all, pcm, now, report.output_rate);
        queueEnd = Math.max(now, queueEnd) + pcm.length / report.output_rate * 1000;
        if (report.tool_executions) recordAudio(reply, pcm, now, report.output_rate);
      },
      onEvent: frame => {
        if (frame.event === "turn_begin") recordTurnBegin(all, clock.now(), frame.turn);
      },
      onTranscript: frame => {
        // An assistant advisory is progress; never treat it as received speech.
        if (report.advisory_transcripts.length < 100) report.advisory_transcripts.push({ role: frame.role, text: frame.text });
        if (frame.role === "assistant") all.lastAssistantTranscriptAt = clock.now();
      },
      onToolCall: frame => {
        report.tool_calls++;
        if (handled.has(frame.call_id)) { report.duplicate_tool_calls++; return; }
        handled.add(frame.call_id);
        if (frame.name !== "lookup_office_hours") { session.toolResult(frame.call_id, { error: "Unknown example tool" }); return; }
        // Replace this read-only fixture with your authorized data lookup.
        report.tool_executions++;
        session.toolResult(frame.call_id, { result: { opening_time: "9 a.m.", source: "synthetic example office" } });
      },
      onBargeIn: () => {
        const now = clock.now(), queued = Math.max(0, queueEnd - now);
        if (report.interruption_started_ms != null) { report.flushes_after_interruption++; report.cleared_queue_ms += queued; }
        // A real speaker adapter must cancel scheduled and currently playing audio.
        queueEnd = now; all.playbackEndAt = now; reply.playbackEndAt = now;
      },
      onError: () => fail("Omni reported an error; inspect authorized server diagnostics"),
      onClose: () => { closed = true; },
    });
    while (clock.now() - started < timeoutMs) {
      if (failure) throw failure;
      if (closed) { report.end_reason = "closed"; break; }
      const now = clock.now();
      if (configuredAt == null || !report.output_rate) {
        if (now - started >= 10000) throw new Error("Omni connection/configuration timed out");
        await clock.sleep(20); continue;
      }
      const quietAt = Math.max(queueEnd, all.lastPacketAt ?? now, all.lastAssistantTranscriptAt ?? 0, inputEndAt);
      if (phase === "greeting") {
        if (all.firstPacketAt != null && now - configuredAt >= 2000 && now >= quietAt + 800) {
          phase = "caller"; report.caller_started_ms = now - started;
        } else if (now - configuredAt > 15000) throw new Error("Greeting did not drain within 15 seconds");
      }
      if (phase === "reply" && interruption && !interruptionSent && reply.samples && queueEnd - now >= 200) {
        phase = "interruption"; offset = 0; interruptionSent = true; report.interruption_started_ms = now - started;
      }
      const observationEnd = inputEndAt + (interruptionSent ? INTERRUPTION_OBSERVATION.minimumAfterCallerStreamMs : 0);
      if (phase === "reply" && reply.samples && now >= quietAt + 2000 && now >= observationEnd && (!interruption || interruptionSent)) {
        report.end_reason = "quiet_window"; break;
      }
      // Exactly one producer: each 20 ms slot contains caller PCM OR silence.
      let pcm = silence;
      if (phase === "caller" || phase === "interruption") {
        const source = phase === "caller" ? caller : interruption;
        pcm = source.subarray(offset, offset + frameSize); offset += pcm.length;
        if (offset >= source.length) {
          inputEndAt = now + pcm.length / rate * 1000;
          report[phase === "caller" ? "caller_completed_ms" : "interruption_completed_ms"] = inputEndAt - started;
          phase = "reply"; offset = 0;
        }
      }
      await streamPcmRealtime(session, pcm, rate, clock);
    }
    report.audio_bytes = all.samples * 2;
    report.reply_audio_bytes = reply.samples * 2;
    report.elapsed_ms = Math.round(clock.now() - started);
    return { report, audio: all.pcm, replyAudio: reply.pcm };
  } finally { session?.close(); }
}
