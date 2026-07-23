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

test("widget v2 tags caller PCM and never falls back to unknown binary audio", () => {
  const widget = read("./omni-browser-widget/public/v2/pyai-widget.js");
  assert.match(widget, /out\[0\] = 0x01/);
  assert.match(widget, /ws\.send\(frame01\(/);
  assert.match(widget, /audioCtx\.sampleRate/);
  assert.match(widget, /captureMute\.gain\.value = 0/);
  assert.match(widget, /outputGain\.gain\.linearRampToValueAtTime/);
  assert.match(widget, /ignored unknown Omni frame tag/);
  assert.doesNotMatch(widget, /ws\.send\(pcm\.buffer\)/);
  assert.doesNotMatch(widget, /unexpected\/untagged|best-effort as audio/);
});

test("concierge direct browser transport is tagged, resampled, and strict", () => {
  const client = read("./pyai-site-voice-concierge/public/app.js");
  assert.match(client, /connectMode === "direct" \? frame01\(pcm\) : pcm/);
  assert.match(client, /pcm16\(input, audioCtx\.sampleRate\)/);
  assert.match(client, /captureMute\.gain\.value = 0/);
  assert.match(client, /outputGain\.gain\.linearRampToValueAtTime/);
  assert.match(client, /Ignored unknown Omni binary frame tag/);
  assert.doesNotMatch(client, /untagged fallback|return playAgentAudio\(arrayBuffer\)/);
});

test("concierge broker speaks native tagged Omni without changing key handling", () => {
  const broker = read("./pyai-site-voice-concierge/src/omni-session.js");
  assert.match(broker, /const TAG_AUDIO = Buffer\.from\(\[0x01\]\)/);
  assert.match(broker, /const TAG_CONTROL = Buffer\.from\(\[0x03\]\)/);
  assert.match(broker, /const configure = \{ type: "configure" \}/);
  assert.match(broker, /buf\.subarray\(1\)/);
  assert.doesNotMatch(broker, /event: "configure"/);
  assert.doesNotMatch(broker, /this\.ws\.send\(JSON\.stringify/);
});

test("marketing live Omni demo has no untagged or unknown-audio path", () => {
  const demo = read("../marketing/src/components/interactive/omni-voice-demo.tsx");
  assert.match(demo, /out\[0\] = 0x01/);
  assert.match(demo, /ws\.send\(frame01\(/);
  assert.match(demo, /ctx\.sampleRate/);
  assert.match(demo, /mute\.gain\.value = 0/);
  assert.match(demo, /Ignored unknown Omni binary frame tag/);
  assert.doesNotMatch(demo, /ws\.send\(pcm\.buffer\)|return playAgentAudio\(buf\)/);
});
