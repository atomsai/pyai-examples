// Server only. Use a dedicated secret for this destination, not your API key.
import { createHmac, timingSafeEqual } from 'node:crypto';

const response = (status, error) => new Response(JSON.stringify(error ? { error } : { ok: true }), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

/** Validate before parsing JSON or trusting any event fields. */
export function verifyTraceSignature(rawBody, signature, secret, now = Date.now()) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256) throw new Error('Signing secret is not configured.');
  const match = typeof signature === 'string' && /^t=(\d{1,12}),v1=([a-f0-9]{64})$/.exec(signature);
  if (!match || Math.abs(now / 1000 - Number(match[1])) > 300) throw new Error('Invalid or expired signature.');
  const expected = createHmac('sha256', secret).update(match[1] + '.').update(rawBody).digest();
  if (!timingSafeEqual(expected, Buffer.from(match[2], 'hex'))) throw new Error('Invalid signature.');
}

/**
 * enqueueOnce must atomically persist the delivery ID and durable downstream
 * work in one transaction. Resolving means committed, including duplicates.
 * A memory Set or a fire-and-forget promise does not satisfy this contract.
 * Bind secret and queue to a server-resolved destination, never a payload org_id.
 */
export async function traceWebhookResponse(request, { secret, enqueueOnce } = {}) {
  if (request.method !== 'POST') return response(405, 'method_not_allowed');
  if (typeof enqueueOnce !== 'function' || typeof secret !== 'string' || secret.length < 32 || secret.length > 256) return response(503, 'receiver_not_configured');
  const reader = request.body?.getReader();
  if (!reader) return response(400, 'empty_body');
  let raw;
  try {
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); return response(413, 'body_too_large'); }
      chunks.push(Buffer.from(value));
    }
    raw = Buffer.concat(chunks);
  } catch { return response(400, 'unreadable_body'); }
  try { verifyTraceSignature(raw, request.headers.get('X-PyAI-Signature'), secret); }
  catch { return response(401, 'invalid_signature'); }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return response(400, 'invalid_json'); }
  if (!event || typeof event.id !== 'string' || !event.id || event.id.length > 4096 || event.type !== 'trace.scorecard.completed' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return response(400, 'invalid_event');
  try { await enqueueOnce(event); return response(202); }
  catch { return response(503, 'durable_queue_unavailable'); }
}
