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


export function pcm16ToWav(pcmValue, rate) {
  const pcm = asPcm16(pcmValue);
  const dataBytes = pcm.length * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) {
    wav.writeInt16LE(pcm[i], 44 + i * 2);
  }
  return wav;
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
