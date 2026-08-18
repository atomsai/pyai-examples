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
