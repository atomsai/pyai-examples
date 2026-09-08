import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CALL_AUDIO_BETWEEN_TURNS_MS,
  CALL_AUDIO_LEAD_MS,
  pcm16ToWav,
  stitchCallPcm,
  writeCallWav,
  stitchCallTimeline,
  writeCallTimelineWav,
} from "../src/call-audio.js";


test("stitchCallPcm preserves caller, measured gap, agent, and turn spacing", () => {
  const rate = 1000;
  const callerPcm = new Int16Array([101, 102]);
  const agentPcm = new Int16Array([201, 202, 203]);
  const pcm = stitchCallPcm([{ callerPcm, agentPcm, ttfbMs: 10 }], rate);

  const callerStart = CALL_AUDIO_LEAD_MS;
  const agentStart = callerStart + callerPcm.length + 10;
  assert.equal(
    pcm.length,
    CALL_AUDIO_LEAD_MS +
      callerPcm.length +
      10 +
      agentPcm.length +
      CALL_AUDIO_BETWEEN_TURNS_MS,
  );
  assert.deepEqual([...pcm.slice(callerStart, callerStart + 2)], [101, 102]);
  assert.deepEqual([...pcm.slice(agentStart, agentStart + 3)], [201, 202, 203]);
});


test("pcm16ToWav writes a valid mono PCM header", () => {
  const wav = pcm16ToWav(new Int16Array([1, -1, 1000]), 24000);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 6);
});


test("writeCallWav returns inspectable duration and content hash", () => {
  const root = mkdtempSync(join(tmpdir(), "pyai-call-audio-"));
  const path = join(root, "call.wav");
  const metadata = writeCallWav(
    path,
    [{
      callerPcm: new Int16Array(100),
      agentPcm: new Int16Array(200),
      ttfbMs: 300,
    }],
    1000,
  );
  const wav = readFileSync(path);
  assert.equal(metadata.bytes, wav.length);
  assert.equal(metadata.duration_ms, 1350);
  assert.match(metadata.sha256, /^[0-9a-f]{64}$/);
});


test("call audio rejects missing turns and wrong PCM types", () => {
  assert.throws(() => stitchCallPcm([], 24000), /at least one turn/);
  assert.throws(
    () => stitchCallPcm([{ callerPcm: Buffer.alloc(4) }], 24000),
    /Int16Array/,
  );
});

test("timeline preserves cross-talk and silence in separate channels", () => {
  const { pcm } = stitchCallTimeline({
    caller: [{ atMs: 0, pcm: new Int16Array([11, 12, 13, 14]) }],
    agent: [{ atMs: 2, pcm: new Int16Array([21, 22]) }, { atMs: 8, pcm: new Int16Array([23]) }],
  }, 1000);
  assert.deepEqual([...pcm], [11, 0, 12, 0, 13, 21, 14, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 23]);
});

test("bursty chunks queue on one lane without erasing PCM or moving the other speaker", () => {
  const result = stitchCallTimeline({
    caller: [{ atMs: 1, pcm: new Int16Array([10]) }],
    agent: [{ atMs: 0, pcm: new Int16Array([1, 2]) }, { atMs: 1, pcm: new Int16Array([3, 4]) }],
  }, 1000);
  assert.deepEqual([...result.pcm], [0, 1, 10, 2, 0, 3, 0, 4]);
  assert.equal(result.queuedChunks, 1);
  assert.equal(result.maximumQueueMs, 1);
});

test("timeline WAV describes stereo estimated playout rather than a clean synthetic dialogue", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pyai-timed-audio-")), "call.wav");
  const metadata = writeCallTimelineWav(path, { caller: [{ atMs: 0, pcm: new Int16Array(100) }], agent: [{ atMs: 50, pcm: new Int16Array(100) }] }, 1000);
  const wav = readFileSync(path);
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(28), 4000);
  assert.equal(wav.readUInt16LE(32), 4);
  assert.equal(metadata.duration_ms, 150);
  assert.equal(metadata.representation, "estimated-playout-stereo");
});

test("timeline rejects corrupt and unbounded timestamps", () => {
  const pcm = new Int16Array([1]);
  for (const atMs of [-1, NaN, Infinity]) assert.throws(() => stitchCallTimeline({ caller: [{ atMs, pcm }] }, 1000));
  assert.throws(() => stitchCallTimeline({ caller: [{ atMs: 2, pcm }, { atMs: 1, pcm }] }, 1000), /ordered/);
  assert.throws(() => stitchCallTimeline({ caller: [{ atMs: 900001, pcm }] }, 1000), /15 minutes/);
});
