import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { SHARED_PACK, scoreSharedPack, toSharedScenario } from "../src/bakeoff.js";
import { loadScenario, resolveScenarioPath } from "../src/scenario.js";
import { loadFixture, resolveFixturePath } from "../src/fixture.js";
import { evaluate } from "../src/scorers.js";

const BASE_DIR = fileURLToPath(new URL("..", import.meta.url));

test("Layer B intended-PASS pack is green offline", () => {
  const rows = scoreSharedPack(BASE_DIR);
  const failed = rows.filter((r) => !r.ok);
  assert.deepEqual(failed, [], failed.map((r) => `${r.id}=${r.verdict}`).join(", "));
  assert.equal(rows.length, SHARED_PACK.length);
});

test("shared scoring drops Omni-only assertions", () => {
  const raw = loadScenario(resolveScenarioPath("memory-constraint-kept", BASE_DIR));
  assert.ok(raw.turns.some((t) => (t.expect || []).some((a) => a.type === "ledger_has")));
  const shared = toSharedScenario(raw);
  assert.ok(shared.turns.every((t) => (t.expect || []).every((a) => a.type !== "ledger_has")));
  const run = loadFixture(resolveFixturePath("memory-constraint-kept", BASE_DIR));
  assert.equal(evaluate(shared, run).verdict, "PASS");
});

test("P0 current-bad fixtures still FAIL after the intended-PASS counterparts land", () => {
  for (const id of ["promise-thursday-callback", "kb-price-miss", "memory-constraint"]) {
    const sc = evaluate(
      loadScenario(resolveScenarioPath(id, BASE_DIR)),
      loadFixture(resolveFixturePath(id, BASE_DIR)),
    );
    assert.equal(sc.verdict, "FAIL", id);
  }
});
