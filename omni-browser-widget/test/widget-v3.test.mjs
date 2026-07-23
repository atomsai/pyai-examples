import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/v3/pyai-widget.js", import.meta.url), "utf8");
const transportSource = readFileSync(new URL("../public/v2/pyai-widget.js", import.meta.url), "utf8");

function loadHelpers() {
  const dispatched = [];
  const parent = { appendChild() {} };
  const document = {
    baseURI: "https://customer.example/page",
    currentScript: null,
    body: parent,
    documentElement: parent,
    addEventListener() {},
    createElement() {
      return {
        style: {},
        remove() {},
      };
    },
  };
  const window = {
    __PYAI_WIDGET_TEST__: {},
    CSS: {
      supports(property, value) {
        return property === "color" && !/[;{}]|url\s*\(|var\s*\(/i.test(value);
      },
    },
    console: { warn() {} },
    crypto: { randomUUID: () => "12345678-1234-1234-1234-123456789abc" },
    dispatchEvent(event) { dispatched.push(event); },
    getComputedStyle(node) {
      const value = node.style.color.toLowerCase();
      if (value === "#5b5bd6") return { color: "rgb(91, 91, 214)" };
      if (value === "#ffffff") return { color: "rgb(255, 255, 255)" };
      if (value === "#000000") return { color: "rgb(0, 0, 0)" };
      return { color: value };
    },
  };
  window.window = window;

  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  const context = {
    window,
    document,
    CSS: window.CSS,
    console: window.console,
    crypto: window.crypto,
    CustomEvent,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    DataView,
    Float32Array,
    Set,
    Math,
  };
  vm.runInNewContext(source, context, { filename: "pyai-widget.js" });
  return { helpers: window.__PYAI_WIDGET_TEST__.helpers, dispatched };
}

function script(attributes) {
  return {
    getAttribute(name) {
      return Object.hasOwn(attributes, name) ? attributes[name] : null;
    },
  };
}

test("safe URL and telephone validators reject executable schemes", () => {
  const { helpers } = loadHelpers();
  assert.equal(helpers.safeHttpUrl("javascript:alert(1)", "https://customer.example"), null);
  assert.equal(helpers.safeHttpUrl("data:text/html,x", "https://customer.example"), null);
  assert.equal(
    helpers.safeHttpUrl("/contact", "https://customer.example/page"),
    "https://customer.example/contact",
  );
  assert.equal(helpers.safeTel("+1 (415) 555-0123"), "tel:+14155550123");
  assert.equal(helpers.safeTel("*123#"), null);
  assert.equal(helpers.safeTel("12"), null);
});

test("config parsing constrains enums, text, action, and voice token URL", () => {
  const { helpers } = loadHelpers();
  const config = helpers.parseConfig(script({
    "data-widget": "wdgt_demo",
    "data-variant": "card",
    "data-position": "top-right",
    "data-theme": "dark",
    "data-density": "compact",
    "data-action": "javascript",
    "data-label": "Talk safely",
    "data-accent": "url(https://evil.example/x)",
  }));
  assert.equal(config.widgetId, "wdgt_demo");
  assert.equal(config.variant, "card");
  assert.equal(config.position, "bottom-right");
  assert.equal(config.theme, "dark");
  assert.equal(config.density, "compact");
  assert.equal(config.action, "voice");
  assert.equal(config.label, "Talk safely");
  assert.match(config.disabledReason, /data-token-url is required/);
  assert.notEqual(config.accent, "url(https://evil.example/x)");

  const eventConfig = helpers.parseConfig(script({
    "data-widget": "wdgt_event",
    "data-variant": "inline",
    "data-action": "event",
    "data-event-value": "pricing",
  }));
  assert.equal(eventConfig.disabledReason, "");
  assert.equal(eventConfig.tokenUrl, null);
});

test("branding defaults to show and hide is explicit", () => {
  const { helpers } = loadHelpers();
  const defaultConfig = helpers.parseConfig(script({
    "data-widget": "wdgt_default",
    "data-action": "event",
  }));
  const hiddenConfig = helpers.parseConfig(script({
    "data-widget": "wdgt_hidden",
    "data-action": "event",
    "data-branding": "hide",
  }));
  const unknownConfig = helpers.parseConfig(script({
    "data-widget": "wdgt_unknown",
    "data-action": "event",
    "data-branding": "sometimes",
  }));
  assert.equal(defaultConfig.branding, "show");
  assert.equal(hiddenConfig.branding, "hide");
  assert.equal(unknownConfig.branding, "show");
  assert.equal(helpers.publicConfig(defaultConfig).branding, "show");
  assert.equal(helpers.publicConfig(hiddenConfig).branding, "hide");
  assert.equal(helpers.publicConfig(defaultConfig).tokenUrl, undefined);
});

test("referral validation is opaque and rejects identifiers or injection", () => {
  const { helpers } = loadHelpers();
  assert.equal(helpers.safeReferral("ref_A8b2C9xY"), "ref_A8b2C9xY");
  for (const invalid of [
    "short",
    "https://evil.example/code",
    "org_12345678",
    "customer_12345678",
    "agent_12345678",
    "project_12345678",
    "wdgt_12345678",
    "validcode?next=evil",
    "<b>referral</b>",
    "a".repeat(65),
  ]) {
    assert.equal(helpers.safeReferral(invalid), null, invalid);
  }
});

test("branding URLs have exact referral and generic UTM shapes", () => {
  const { helpers } = loadHelpers();
  assert.equal(
    helpers.brandingUrl("card", "ref_A8b2C9xY"),
    "https://pyai.com/r/ref_A8b2C9xY?utm_source=customer_widget&utm_medium=referral&utm_campaign=powered_by_widget&utm_content=card",
  );
  assert.equal(
    helpers.brandingUrl("pill", null),
    "https://pyai.com/?utm_source=customer_widget&utm_medium=referral&utm_campaign=powered_by_widget&utm_content=pill",
  );

  const invalidConfig = helpers.parseConfig(script({
    "data-widget": "wdgt_generic",
    "data-action": "event",
    "data-referral": "https://evil.example/?x=1",
  }));
  assert.equal(invalidConfig.referralCode, null);
  assert.equal(
    invalidConfig.brandingUrl,
    "https://pyai.com/?utm_source=customer_widget&utm_medium=referral&utm_campaign=powered_by_widget&utm_content=pill",
  );
});

test("branding click event contains only privacy-safe public fields", () => {
  const { helpers, dispatched } = loadHelpers();
  helpers.emitBrandingClick({
    widgetId: "wdgt_public",
    variant: "card",
    referralCode: "ref_A8b2C9xY",
    tokenUrl: "https://customer.example/private-token",
    instanceId: "internal-instance",
  });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, "pyai:widget:branding-click");
  assert.deepEqual(
    JSON.parse(JSON.stringify(dispatched[0].detail)),
    {
      widgetId: "wdgt_public",
      variant: "card",
      referralCode: "ref_A8b2C9xY",
    },
  );
});

test("instance IDs remain unique when widgets share one runtime", () => {
  const { helpers } = loadHelpers();
  const first = helpers.parseConfig(script({
    "data-widget": "wdgt_shared",
    "data-action": "event",
    "data-referral": "ref_first8",
  }));
  const second = helpers.parseConfig(script({
    "data-widget": "wdgt_shared",
    "data-variant": "card",
    "data-action": "event",
    "data-referral": "ref_second9",
  }));
  assert.notEqual(first.instanceId, second.instanceId);
  assert.match(first.instanceId, /^pyai-widget-\d+-/);
  assert.notEqual(first.brandingUrl, second.brandingUrl);
  assert.match(first.brandingUrl, /ref_first8/);
  assert.match(second.brandingUrl, /ref_second9/);
  assert.equal(helpers.publicConfig(first).referralCode, "ref_first8");
});

test("event actions dispatch the documented CustomEvent detail", () => {
  const { helpers, dispatched } = loadHelpers();
  helpers.executeAction({
    widgetId: "wdgt_event",
    instanceId: "pyai-widget-1",
    eventValue: "pricing",
  });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, "pyai:widget:action");
  assert.deepEqual(
    JSON.parse(JSON.stringify(dispatched[0].detail)),
    {
      widgetId: "wdgt_event",
      instanceId: "pyai-widget-1",
      action: "event",
      value: "pricing",
    },
  );
});

test("immutable v2 remains transport-only while v3 owns configuration", () => {
  assert.equal(Buffer.byteLength(transportSource), 9695);
  assert.equal(
    createHash("sha256").update(transportSource).digest("hex"),
    "b00a23c0b1709c6e0c0415ab48c5bd30a505ea063bdde63540038a32d20fd950",
  );
  assert.equal(Buffer.byteLength(source), 41458);
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "9dd90a74eb8fcfee3524d29176c12aea5a12c41020dbe5a21938133e9090d3ae",
  );
  assert.doesNotMatch(transportSource, /Powered by PyAI|data-referral|window\.PyAIWidget/);
  assert.match(source, /Powered by PyAI/);
  assert.match(source, /data-referral/);
  assert.match(source, /window\.PyAIWidget = api/);
});

test("runtime source keeps security, accessibility, and responsive invariants", () => {
  assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\b|\.onclick\s*=/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.match(source, /CustomEvent\("pyai:widget:" \+ name/);
  assert.match(source, /data-pyai-widget-open/);
  assert.match(source, /role", "dialog"/);
  assert.match(source, /aria-live/);
  assert.match(source, /safe-area-inset-bottom/);
  assert.match(source, /@media\(max-width:640px\)/);
  assert.match(source, /prefers-color-scheme:dark/);
  assert.match(source, /window\.PyAIWidget = api/);
  assert.match(source, /getConfig: function \(widgetId\)/);
  assert.match(source, /anchor\.target = "_blank"/);
  assert.match(source, /anchor\.rel = "noopener noreferrer"/);
  assert.match(source, /Powered by PyAI \(opens in a new tab\)/);
  assert.match(source, /emit\("branding-click", detail\)/);
  assert.match(source, /if \(config\.branding === "show"\) root\.appendChild/);
  for (const variant of ["orb", "pill", "card", "inline"]) {
    assert.match(source, new RegExp(`"${variant}"`));
  }
});
