export interface TraceWebhookEvent {
  id: string;
  type: 'trace.scorecard.completed';
  occurred_at?: string | number;
  data: Record<string, unknown>;
}
export function verifyTraceSignature(rawBody: Uint8Array, signature: string | null, secret: string, now?: number): void;
export function traceWebhookResponse(request: Request, options?: {
  secret?: string;
  enqueueOnce?: (event: TraceWebhookEvent) => Promise<void>;
}): Promise<Response>;
