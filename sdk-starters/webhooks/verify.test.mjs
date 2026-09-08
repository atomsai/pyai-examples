import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verify } from "./verify.mjs";

const secret = "local-test-secret";
const now = 1788800000;
const body = Buffer.from('{"type":"transcription.job.completed","data":{"job_id":"job_test"}}');
const sign = (time = now, bytes = body) => `t=${time},v1=${createHmac("sha256", secret).update(`${time}.`).update(bytes).digest("hex")}`;

test("accepts authentic bytes and valid signatures during rotation", () => {
  assert.equal(verify(body, sign(), secret, now), true);
  assert.equal(verify(body, `${sign()},v1=${"0".repeat(64)}`, secret, now), true);
});
test("rejects changed bytes, wrong secrets, stale and future signatures", () => {
  assert.equal(verify(Buffer.concat([body, Buffer.from(" ")]), sign(), secret, now), false);
  assert.equal(verify(body, sign(), "wrong-secret", now), false);
  assert.equal(verify(body, sign(now - 301), secret, now), false);
  assert.equal(verify(body, sign(now + 301), secret, now), false);
});
test("malformed headers fail closed without throwing", () => {
  for (const header of [undefined, "", "t=NaN,v1=ab", `t=${now},v1=ab`, `t=${now},${sign()}`, `t=${now},v1=${"z".repeat(64)}`]) {
    assert.equal(verify(body, header, secret, now), false);
  }
});
