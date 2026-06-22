import assert from "node:assert/strict";
import { test } from "node:test";

import { validateScenario, parseScenario } from "../src/scenario.js";

const valid = {
  id: "x",
  persona: "p",
  turns: [{ caller_says: "hi", expect: [{ type: "contains", value: "hello" }] }],
};

test("validateScenario accepts a well-formed scenario", () => {
  assert.equal(validateScenario(valid).id, "x");
});

test("validateScenario rejects a missing id", () => {
  assert.throws(() => validateScenario({ ...valid, id: "" }), /`id` \(string\) is required/);
});

test("validateScenario rejects empty turns", () => {
  assert.throws(() => validateScenario({ ...valid, turns: [] }), /non-empty array/);
});

test("validateScenario rejects a missing caller_says", () => {
  assert.throws(
    () => validateScenario({ ...valid, turns: [{ expect: [] }] }),
    /caller_says \(string\) is required/,
  );
});

test("validateScenario rejects an unknown assertion type", () => {
  assert.throws(
    () => validateScenario({ ...valid, turns: [{ caller_says: "hi", expect: [{ type: "vibes" }] }] }),
    /type must be one of/,
  );
});

test("validateScenario rejects a latency_budget with no budget", () => {
  assert.throws(
    () => validateScenario({ ...valid, turns: [{ caller_says: "hi", expect: [{ type: "latency_budget" }] }] }),
    /needs ttfbMs and\/or turnMs/,
  );
});

test("parseScenario surfaces JSON errors", () => {
  assert.throws(() => parseScenario("{not json"), /not valid JSON/);
});
