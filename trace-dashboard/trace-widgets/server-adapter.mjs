// Server only. Keep the API key in your application server's secret store.
import { projectExposure } from './model.mjs';

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie, Authorization' };
const reply = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });

/**
 * resolveApiKey must authenticate the app user, authorize dashboard access, and
 * resolve that user's tenant key on the server. Return null to deny access.
 * Never resolve a key from a browser-supplied org ID or forward caller headers.
 */
export async function traceDashboardResponse(request, { resolveApiKey } = {}) {
  if (request.method !== 'GET') return reply(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  const url = new URL(request.url);
  const rawDays = url.searchParams.get('window_days') ?? '30';
  if (!['7', '30', '90'].includes(rawDays)) return reply(400, { error: 'invalid_window' });
  if (typeof resolveApiKey !== 'function') return reply(503, { error: 'authentication_not_configured' });
  let key;
  try { key = await resolveApiKey(request); } catch { return reply(503, { error: 'authentication_unavailable' }); }
  if (key == null) return reply(401, { error: 'sign_in_required' });
  if (typeof key !== 'string' || !key.trim() || key.length > 512 || /[\r\n]/.test(key)) return reply(503, { error: 'server_key_not_configured' });
  try {
    const response = await fetch(`https://api.pyai.com/v1/trace/exposure?window_days=${rawDays}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      if (response.status === 429) {
        const rawRetry = response.headers.get('Retry-After');
        const retry = rawRetry && /^\d+$/.test(rawRetry) ? Math.max(1, Math.min(Number(rawRetry), 3600)) : 60;
        return reply(429, { error: 'trace_rate_limited' }, { 'Retry-After': String(retry) });
      }
      return reply(502, { error: response.status === 401 || response.status === 403 ? 'trace_key_or_scope_invalid' : 'trace_unavailable' });
    }
    const exposure = projectExposure(await response.json());
    if (exposure.window_days !== Number(rawDays)) return reply(502, { error: 'unexpected_trace_window' });
    return reply(200, { exposure, generated_at: new Date().toISOString() });
  } catch { return reply(502, { error: 'trace_unavailable' }); }
}
