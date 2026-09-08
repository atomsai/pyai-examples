import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify raw bytes BEFORE JSON parsing. Keep the secret on the server. */
export function verify(rawBody, header, secret, now = Math.floor(Date.now() / 1000)) {
  if (!secret || typeof header !== "string") return false;
  const parts = header.split(",").map((part) => part.trim());
  const timestamps = parts.filter((part) => /^t=\d+$/.test(part));
  const signatures = parts.filter((part) => /^v1=[a-fA-F0-9]{64}$/.test(part));
  if (timestamps.length !== 1 || !signatures.length) return false;
  const timestamp = timestamps[0].slice(2);
  if (Math.abs(now - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  return signatures.some((part) => timingSafeEqual(expected, Buffer.from(part.slice(3), "hex")));
}
