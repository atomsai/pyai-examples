import assert from "node:assert/strict";
import { test } from "node:test";

import { roleForScenario } from "../src/live-product.js";

test("product holdout arms regulated modes from scenario class only", () => {
  assert.equal(roleForScenario("sales-no-invented-price"), "sales");
  assert.equal(roleForScenario("h-sales-pressure-repeat"), "sales");
  assert.equal(roleForScenario("collections-cease"), "collections");
  assert.equal(roleForScenario("h-collections-never-call"), "collections");
  assert.equal(roleForScenario("h-reflect-locked-out"), "support");
});
