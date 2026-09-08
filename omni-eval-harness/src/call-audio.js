import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";


export const CALL_AUDIO_LEAD_MS = 250;
export const CALL_AUDIO_BETWEEN_TURNS_MS = 500;
export const CALL_AUDIO_DEFAULT_GAP_MS = 500;
export const CALL_AUDIO_MAX_GAP_MS = 30_000;


function asPcm16(value) {
  if (value instanceof Int16Array) return value;
  if (value == null) return new Int16Array();
  throw new TypeError("call audio segments must be Int16Array values");
}


function silence(rate, durationMs) {
  const samples = Math.max(0, Math.round((rate * durationMs) / 1000));
  return new Int16Array(samples);
}


function boundedGap(value) {
  if (!Number.isFinite(value)) return CALL_AUDIO_DEFAULT_GAP_MS;
  return Math.max(0, Math.min(CALL_AUDIO_MAX_GAP_MS, Math.round(value)));
}


export function stitchCallPcm(turns, rate) {
  if (!Number.isInteger(rate) || rate <= 0) {
    throw new TypeError("call audio rate must be a positive integer");
  }
  if (!Array.isArray(turns) || turns.length === 0) {
    throw new TypeError("call audio needs at least one turn");
  }

  const segments = [silence(rate, CALL_AUDIO_LEAD_MS)];
  for (const turn of turns) {
    segments.push(asPcm16(turn.callerPcm));
    segments.push(silence(rate, boundedGap(turn.ttfbMs)));
    segments.push(asPcm16(turn.agentPcm));
    segments.push(silence(rate, CALL_AUDIO_BETWEEN_TURNS_MS));
  }

  const sampleCount = segments.reduce((total, segment) => total + segment.length, 0);
  const pcm = new Int16Array(sampleCount);
  let offset = 0;
  for (const segment of segments) {
    pcm.set(segment, offset);
    offset += segment.length;
  }
  return pcm;
}


export function pcm16ToWav(pcmValue, rate, channels = 1) {
  const pcm = asPcm16(pcmValue);
  if (![1, 2].includes(channels) || pcm.length % channels !== 0) {
    throw new TypeError("PCM must contain complete mono or stereo frames");
  }
  const dataBytes = pcm.length * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2 * channels, 28);
  wav.writeUInt16LE(2 * channels, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) {
    wav.writeInt16LE(pcm[i], 44 + i * 2);
  }
  return wav;
}

/**
 * Preserve caller/agent overlap and measured gaps on separate channels.
 * Chunk timestamps describe the harness's estimated playout, not a recording
 * made at a customer's speaker. Within each lane PCM is queued in event order.
 * Unlike the legacy turn stitcher, no synthetic lead/gap/spacing is inserted.
 */
export function stitchCallTimeline({ caller = [], agent = [] }, rate) {
  if (!Number.isInteger(rate) || rate <= 0 || rate > 192000) {
    throw new TypeError("call audio rate must be a positive integer <=192000");
  }
  const schedules = [];
  let end = 0;
  let queuedChunks = 0;
  let maximumQueueMs = 0;
  for (const [channel, chunks] of [caller, agent].entries()) {
    if (!Array.isArray(chunks)) throw new TypeError("timeline channels must be arrays");
    let laneEnd = 0;
    let previousAt = -1;
    for (const chunk of chunks) {
      if (!Number.isFinite(chunk.atMs) || chunk.atMs < 0 || chunk.atMs < previousAt) {
        throw new TypeError("chunk timestamps must be finite, nonnegative and ordered");
      }
      const pcm = asPcm16(chunk.pcm);
      const requested = Math.round(chunk.atMs * rate / 1000);
      const start = Math.max(requested, laneEnd);
      const queueMs = (start - requested) * 1000 / rate;
      if (queueMs > 0) queuedChunks++;
      maximumQueueMs = Math.max(maximumQueueMs, queueMs);
      laneEnd = start + pcm.length;
      if (laneEnd > rate * 15 * 60) throw new RangeError("call timeline exceeds 15 minutes");
      schedules.push({ channel, start, pcm });
      end = Math.max(end, laneEnd);
      previousAt = chunk.atMs;
    }
  }
  if (!end) throw new TypeError("call timeline needs audio samples");
  const pcm = new Int16Array(end * 2);
  for (const segment of schedules) {
    for (let i = 0; i < segment.pcm.length; i++) pcm[(segment.start + i) * 2 + segment.channel] = segment.pcm[i];
  }
  return { pcm, queuedChunks, maximumQueueMs };
}

export function writeCallTimelineWav(path, timeline, rate) {
  const { pcm, queuedChunks, maximumQueueMs } = stitchCallTimeline(timeline, rate);
  const wav = pcm16ToWav(pcm, rate, 2);
  writeFileSync(path, wav);
  return {
    bytes: wav.length, duration_ms: Math.round(pcm.length / 2 / rate * 1000),
    sha256: createHash("sha256").update(wav).digest("hex"),
    channels: 2, channel_labels: ["caller", "agent"],
    representation: "estimated-playout-stereo", queued_chunks: queuedChunks,
    maximum_queue_ms: maximumQueueMs,
  };
}


export function writeCallWav(path, turns, rate) {
  const pcm = stitchCallPcm(turns, rate);
  const wav = pcm16ToWav(pcm, rate);
  writeFileSync(path, wav);
  return {
    bytes: wav.length,
    duration_ms: Math.round((pcm.length / rate) * 1000),
    sha256: createHash("sha256").update(wav).digest("hex"),
  };
}
