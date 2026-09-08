import assert from "node:assert/strict";
import { test } from "node:test";
import { productExitCode } from "../src/live-product.js";
import { continuityExitCode } from "../src/live-continuity.js";

for (const [name, exitCode] of [["product", productExitCode], ["continuity", continuityExitCode]]) {
  test(`${name} CLI prioritizes incomplete evidence over content failure`, () => {
    assert.equal(exitCode([]), 2);
    assert.equal(exitCode([{ verdict: "FAIL" }, { verdict: "INVALID_CAPTURE" }]), 2);
    assert.equal(exitCode([{ verdict: "PASS" }, { verdict: "ERROR" }]), 2);
  });

  test(`${name} CLI returns content failure for any failed row`, () => {
    assert.equal(exitCode([{ verdict: "PASS" }, { verdict: "FAIL" }]), 1);
    assert.equal(exitCode([{ verdict: "WARN", content_verdict: "FAIL" }]), 1);
  });

  test(`${name} CLI never treats passing automated checks as listening certification`, () => {
    assert.equal(exitCode([{ verdict: "PASS", content_verdict: "PASS" }]), 3);
    assert.equal(exitCode([{ verdict: "WARN" }, { verdict: "REVIEW" }]), 3);
  });
}
