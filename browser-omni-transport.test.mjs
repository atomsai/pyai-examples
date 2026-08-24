import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const fixtures = JSON.parse(read("./omni-browser-protocol-fixtures.json"));

test("shared browser fixtures pin control JSON and little-endian PCM", () => {
  const control = Uint8Array.from(fixtures.control.frameBytes);
  assert.equal(control[0], 0x03);
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(control.subarray(1))),
    fixtures.control.payload,
  );

  const pcm = Uint8Array.from(fixtures.pcm16.frameBytes);
  assert.equal(pcm[0], 0x01);
  const view = new DataView(pcm.buffer, pcm.byteOffset + 1, pcm.byteLength - 1);
  assert.deepEqual(
    Array.from({ length: view.byteLength / 2 }, (_, index) => view.getInt16(index * 2, true)),
    [-32768, -16384, 0, 16383, 32767],
  );
});

test("widget v7 stays immutable with its historical tagged transport", () => {
  const widget = read("./omni-browser-widget/public/v7/pyai-widget.js");
  const server = read("./omni-browser-widget/server.js");
  assert.match(widget, /frame\[0\] = 0x01/);
  assert.match(widget, /state\.ws\.send\(pcm16Frame\(/);
  assert.match(widget, /bytes\[0\] === 0x01/);
  assert.match(widget, /normalizeTranscriptPayload/);
  assert.match(widget, /event\.data instanceof ArrayBuffer/);
  assert.match(server, /"\/widget\/v7\/pyai-widget\.js"/);
  assert.doesNotMatch(server, /"\/pyai-widget\.js"|widget\/v[2-6]/);
});

test("widget v8 preserves strict framing with bounded duplex capture", () => {
  const widget = read("./omni-browser-widget/public/v8/pyai-widget.js");
  const server = read("./omni-browser-widget/server.js");
  assert.match(widget, /VERSION = "8\.0\.0"/);
  assert.match(widget, /frame\[0\] = 0x01/);
  assert.match(widget, /captureMute\.gain\.value = 0/);
  assert.match(widget, /AGENT_BARGE_ARM_DELAY_MS = 350/);
  assert.match(widget, /selectCallerSamples\(samples, state, Date\.now\(\)\)/);
  assert.match(widget, /state\.ws\.close\(1002, "binary_frames_required"\)/);
  assert.match(widget, /state\.ws\.close\(1002, "invalid_binary_frame"\)/);
  assert.match(server, /"\/widget\/v8\/pyai-widget\.js"/);
});

test("widget v9 preserves strict framing and the canonical protected opening", () => {
  const widget = read("./omni-browser-widget/public/v9/pyai-widget.js");
  const server = read("./omni-browser-widget/server.js");
  assert.match(widget, /VERSION = "9\.0\.0"/);
  assert.match(widget, /frame\[0\] = 0x01/);
  assert.match(widget, /captureMute\.gain\.value = 0/);
  assert.match(widget, /startupAudioPhase/);
  assert.match(widget, /pendingAudio/);
  assert.match(widget, /flushPendingAudio\(\)/);
  assert.match(widget, /AGENT_BARGE_ARM_DELAY_MS = 350/);
  assert.match(widget, /selectCallerSamples\(samples, state, Date\.now\(\)\)/);
  assert.match(widget, /state\.ws\.close\(1002, "binary_frames_required"\)/);
  assert.match(widget, /state\.ws\.close\(1002, "invalid_binary_frame"\)/);
  assert.match(server, /"\/widget\/v9\/pyai-widget\.js"/);
});

test("concierge direct browser transport is tagged, resampled, and strict", () => {
  const client = read("./pyai-site-voice-concierge/public/app.js");
  assert.match(client, /connectMode === "direct" \? frame01\(pcm\) : pcm/);
  assert.match(client, /selectCallerSamples\(input, Date\.now\(\)\)/);
  assert.match(client, /captureMute\.gain\.value = 0/);
  assert.match(client, /startupAudioPhase === "playing"/);
  assert.match(client, /AGENT_AUDIO_END_GRACE_MS = 500/);
  assert.match(client, /AGENT_BARGE_ARM_DELAY_MS = 350/);
  assert.match(client, /startupAudioPhase = completeStartupAudioPhase/);
  assert.match(client, /outputGain\.gain\.linearRampToValueAtTime/);
  assert.match(client, /ws\?\.close\(1002, "unknown_binary_tag"\)/);
  assert.match(client, /value\.event !== "transcript"/);
  assert.doesNotMatch(client, /untagged fallback|return playAgentAudio\(arrayBuffer\)/);
});

test("concierge broker speaks native tagged Omni without changing key handling", () => {
  const broker = read("./pyai-site-voice-concierge/src/omni-session.js");
  assert.match(broker, /const TAG_AUDIO = Buffer\.from\(\[0x01\]\)/);
  assert.match(broker, /const TAG_CONTROL = Buffer\.from\(\[0x03\]\)/);
  assert.match(broker, /const configure = \{ type: "configure" \}/);
  assert.match(broker, /typeof evt\.event !== "string"/);
  assert.match(broker, /value\.event !== "transcript"/);
  assert.match(broker, /buf\.subarray\(1\)/);
  assert.doesNotMatch(broker, /event: "configure"/);
  assert.doesNotMatch(broker, /this\.ws\.send\(JSON\.stringify/);
});
