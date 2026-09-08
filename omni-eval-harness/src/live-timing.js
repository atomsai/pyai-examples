// Monotonic capture timing. Arrival time is distinct from queued playback:
// a single packet may contain seconds of audio and must finish before settling.
export const FRAME_MS = 20;
export const REALTIME_GAP_LIMIT_MS = 100;

/** Approximate audible bounds; this is energy detection, not a speech/VAD claim. */
export function audibleBounds(pcm, rate, rmsFloor = 160) {
  const window = Math.max(1, Math.round(rate / 100)); // 10 ms windows
  let first = null;
  let last = null;
  for (let off = 0; off < pcm.length; off += window) {
    const end = Math.min(pcm.length, off + window);
    let energy = 0;
    for (let i = off; i < end; i++) energy += pcm[i] * pcm[i];
    if (Math.sqrt(energy / (end - off)) >= rmsFloor) {
      first ??= off;
      last = end;
    }
  }
  return { first, last };
}

export function newAudioCapture(started) {
  return {
    started, firstPacketAt: null, lastPacketAt: null,
    firstAudioAt: null, lastAudioAt: null, playbackEndAt: null,
    samples: 0, pcm: [], turnBeginAt: null, eouMs: null,
    latestTurnBeginAt: null, postTurnBeginFirstPacketAt: null,
    postTurnBeginFirstAudioAt: null, lastAssistantTranscriptAt: null,
    callerTranscriptEvents: [], assistantTranscriptEvents: [],
    turnBegins: [], tools: [], toolResults: [], kb: null, events: [],
  };
}

export function recordTurnBegin(ctx, at, turn, origin = 0) {
  ctx.turnBeginAt ??= at;
  ctx.latestTurnBeginAt = at;
  // Earlier PCM can be a listening cue. A new reply is still pending even
  // when that cue has already finished playing; retain all of its PCM.
  ctx.postTurnBeginFirstPacketAt = null;
  ctx.postTurnBeginFirstAudioAt = null;
  ctx.turnBegins.push({ atMs: Math.round(at - origin), turn: turn ?? null });
}

export function recordAudio(ctx, pcm, at, rate) {
  if (!(pcm instanceof Int16Array) || !pcm.length) return null;
  const copy = pcm.slice(); // Some transports reuse callback buffers.
  const playbackAt = Math.max(at, ctx.playbackEndAt ?? at);
  const endAt = playbackAt + (copy.length / rate) * 1000;
  const bounds = audibleBounds(copy, rate);
  ctx.firstPacketAt ??= at;
  ctx.lastPacketAt = at;
  ctx.playbackEndAt = endAt;
  const afterTurnBegin = ctx.latestTurnBeginAt != null && at >= ctx.latestTurnBeginAt;
  if (afterTurnBegin) ctx.postTurnBeginFirstPacketAt ??= at;
  if (bounds.first != null) {
    ctx.firstAudioAt ??= playbackAt + (bounds.first / rate) * 1000;
    ctx.lastAudioAt = playbackAt + (bounds.last / rate) * 1000;
    if (afterTurnBegin) ctx.postTurnBeginFirstAudioAt ??= playbackAt + (bounds.first / rate) * 1000;
  }
  ctx.samples += copy.length;
  ctx.pcm.push(copy);
  return { playbackAt, endAt, pcm: copy };
}

/** Preserve negative gaps: they are overlaps, never missing measurements. */
export function captureTiming(ctx, caller, origin = 0) {
  const relative = (at) => at == null ? null : Math.round(at - origin);
  const gap = (at) => at == null || caller.speechOffsetAt == null
    ? null : Math.round(at - caller.speechOffsetAt);
  return {
    ttfbMs: gap(ctx.firstAudioAt),
    anyAudioTtfbMs: gap(ctx.firstAudioAt),
    postTurnBeginTtfbMs: gap(ctx.postTurnBeginFirstAudioAt),
    turnMs: gap(ctx.lastAudioAt),
    packetTtfbMs: gap(ctx.firstPacketAt),
    callerStartMs: relative(caller.startedAt),
    callerSpeechOnsetMs: relative(caller.speechOnsetAt),
    callerSpeechOffsetMs: relative(caller.speechOffsetAt),
    callerStreamEndMs: relative(caller.streamEndAt),
    agentFirstPacketMs: relative(ctx.firstPacketAt),
    agentLastPacketMs: relative(ctx.lastPacketAt),
    agentSpeechOnsetMs: relative(ctx.firstAudioAt),
    agentSpeechOffsetMs: relative(ctx.lastAudioAt),
    agentPlaybackEndMs: relative(ctx.playbackEndAt),
    latestTurnBeginMs: relative(ctx.latestTurnBeginAt),
    postTurnBeginFirstPacketMs: relative(ctx.postTurnBeginFirstPacketAt),
    postTurnBeginSpeechOnsetMs: relative(ctx.postTurnBeginFirstAudioAt),
    lastAssistantTranscriptMs: relative(ctx.lastAssistantTranscriptAt),
    callerMaxFrameGapMs: Math.round(caller.maxFrameGapMs ?? 0),
    method: "client-monotonic-queued-playback-energy-bounds",
  };
}

export async function streamPcmRealtime(omni, pcm, rate, clock, onFrame = () => {}) {
  const frameSize = Math.max(1, Math.round((rate * FRAME_MS) / 1000));
  const bounds = audibleBounds(pcm, rate);
  const startedAt = clock.now();
  let speechOnsetAt = null;
  let speechOffsetAt = null;
  let previousFrameEnd = startedAt;
  let maxFrameGapMs = 0;
  for (let off = 0; off < pcm.length; off += frameSize) {
    const frame = pcm.subarray(off, Math.min(off + frameSize, pcm.length));
    const at = clock.now();
    maxFrameGapMs = Math.max(maxFrameGapMs, at - previousFrameEnd);
    const durationMs = (frame.length / rate) * 1000;
    omni.sendAudio(frame);
    onFrame(frame, at);
    if (bounds.first != null && bounds.first >= off && bounds.first < off + frame.length) {
      speechOnsetAt = at + ((bounds.first - off) / rate) * 1000;
    }
    if (bounds.last != null && bounds.last > off && bounds.last <= off + frame.length) {
      speechOffsetAt = at + ((bounds.last - off) / rate) * 1000;
    }
    previousFrameEnd = at + durationMs;
    // Pace from the actual send. Never burst late frames to "catch up".
    await clock.sleep(Math.max(0, previousFrameEnd - clock.now()));
  }
  return { startedAt, speechOnsetAt, speechOffsetAt,
    streamEndAt: clock.now(), maxFrameGapMs };
}

export async function streamSilenceWhile(omni, rate, shouldContinue, clock, onFrame = () => {}) {
  const silence = new Int16Array(Math.max(1, Math.round((rate * FRAME_MS) / 1000)));
  while (shouldContinue()) {
    const at = clock.now();
    omni.sendAudio(silence);
    onFrame(silence, at);
    await clock.sleep(FRAME_MS);
  }
}

export async function waitForAgentSettle(getCtx, clock, opts = {}) {
  const started = clock.now();
  const timeoutMs = opts.timeoutMs ?? 25000;
  const settleMs = opts.settleMs ?? 2000;
  while (true) {
    const ctx = getCtx();
    const at = clock.now();
    if (opts.isClosed?.()) return { reason: "closed", at };
    const hasResponseAudio = !opts.requireTurnBegin || (ctx.latestTurnBeginAt != null
      && ctx.postTurnBeginFirstAudioAt != null);
    // Synthesis text is progress, not a completion event. It can arrive after
    // early/final audio, so extend the quiet floor without demanding another
    // packet after every advisory. The protocol still has no reply-end marker.
    const activityEnd = Math.max(ctx.playbackEndAt ?? -Infinity,
      ctx.latestTurnBeginAt ?? -Infinity, ctx.lastAssistantTranscriptAt ?? -Infinity);
    if (ctx.firstPacketAt != null && hasResponseAudio && at >= activityEnd + settleMs) {
      return { reason: "settled", at };
    }
    if (opts.allowEmpty && ctx.firstPacketAt == null && at - started >= (opts.emptyWaitMs ?? 800)) {
      return { reason: "empty", at };
    }
    if (at - started >= timeoutMs) return { reason: "timeout", at };
    await clock.sleep(20);
  }
}

export async function withTimeout(promise, ms, message, clock) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = clock.setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clock.clearTimeout(timer);
  }
}
