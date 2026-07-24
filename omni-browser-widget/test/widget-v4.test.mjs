import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/v4/pyai-widget.js", import.meta.url), "utf8");
const v1 = readFileSync(new URL("../public/pyai-widget.js", import.meta.url));
const v2 = readFileSync(new URL("../public/v2/pyai-widget.js", import.meta.url));
const v3 = readFileSync(new URL("../public/v3/pyai-widget.js", import.meta.url));

function helpers() {
  const script = {
    nonce: "",
    parentNode: { insertBefore() {} },
    getAttribute(name) {
      if (name === "data-widget") return "wdgt_12345678901234567890123456789012";
      return null;
    },
  };
  const parent = { appendChild() {} };
  const document = {
    currentScript: script,
    head: parent,
    body: parent,
    querySelectorAll() { return [script]; },
    getElementById() { return null; },
    createElement() {
      return {
        className: "",
        style: { setProperty() {} },
        setAttribute() {},
        appendChild() {},
        addEventListener() {},
      };
    },
  };
  const window = {
    __PYAI_WIDGET_TEST__: {},
    dispatchEvent() {},
    addEventListener() {},
  };
  window.window = window;
  const context = {
    window,
    document,
    console: { warn() {} },
    CustomEvent: class {},
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Float32Array,
    DataView,
    Math,
    Promise,
    fetch() { return new Promise(() => {}); },
  };
  vm.runInNewContext(source, context, { filename: "pyai-widget-v4.js" });
  return window.__PYAI_WIDGET_TEST__.helpers;
}

test("v4 derives registry endpoints and never accepts token URLs or executable config", () => {
  assert.match(source, /\/public\/widgets\//);
  assert.match(source, /sessionUrl = configUrl \+ "\/session"/);
  assert.doesNotMatch(source, /data-token-url|innerHTML\s*=|\beval\s*\(|new\s+Function\b|\.onclick\s*=/);
  assert.match(source, /PUBLIC_ID_RE/);
  assert.match(source, /credentials: "omit"/);
});

test("v4 keeps native framing, resampling, flush and accessible consent", () => {
  const h = helpers();
  const audio = h.pcm16Frame(new Float32Array([0, 1, -1, 0.5]), 24000);
  assert.equal(audio[0], 0x01);
  assert.equal(audio.byteLength, 9);
  const control = h.controlFrame({ type: "configure" });
  assert.equal(control[0], 0x03);
  assert.equal(JSON.parse(new TextDecoder().decode(control.subarray(1))).type, "configure");
  assert.match(source, /payload\.event === "flush" \|\| payload\.event === "barge_in"/);
  assert.match(source, /Continue and allow microphone/);
  assert.match(source, /aria-modal/);
  assert.match(source, /aria-live/);
  assert.match(source, /safe-area-inset-bottom/);
  assert.match(source, /role", "log"/);
});

test("v4 referral override accepts only existing opaque referral format", () => {
  const h = helpers();
  assert.equal(h.safeReferral("wr_0123456789abcdefghjk"), "wr_0123456789abcdefghjk");
  for (const value of ["org_123", "agent_123", "wdgt_123", "https://evil.example", "<script>"]) {
    assert.equal(h.safeReferral(value), null);
  }
});

test("v1-v3 assets remain byte-for-byte immutable", () => {
  assert.equal(createHash("sha256").update(v1).digest("hex"), "37801a06a5ad0af16888877b4e12bbcaa32b7ac77700ebcb8326c8893b99e512");
  assert.equal(createHash("sha256").update(v2).digest("hex"), "b00a23c0b1709c6e0c0415ab48c5bd30a505ea063bdde63540038a32d20fd950");
  assert.equal(createHash("sha256").update(v3).digest("hex"), "9dd90a74eb8fcfee3524d29176c12aea5a12c41020dbe5a21938133e9090d3ae");
});
