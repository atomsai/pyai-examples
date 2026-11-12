import { createHmac, timingSafeEqual } from 'node:crypto';

export class RoutingError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
const phone = /^\+[1-9]\d{7,14}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const minute = value => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Use HH:MM for business hours.');
  const [h, m] = value.split(':').map(Number); return h * 60 + m;
};

export function configuration(env) {
  const secret = env.DIALPAD_ROUTER_SECRET ?? '';
  if (Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 512) throw new Error('Set a unique router secret of 32 to 512 bytes.');
  const inbound = (env.DIALPAD_INBOUND_NUMBERS ?? '').split(',').map(s => s.trim());
  const agentNumber = env.PYAI_AGENT_NUMBER ?? '';
  if (!inbound.length || inbound.length > 20 || !inbound.every(n => phone.test(n)) || !phone.test(agentNumber) || inbound.includes(agentNumber)) {
    throw new Error('Configure distinct E.164 Dialpad inbound and PyAI agent numbers.');
  }
  const targetId = Number(env.DIALPAD_HUMAN_TARGET_ID);
  const targetType = env.DIALPAD_HUMAN_TARGET_TYPE;
  if (!Number.isSafeInteger(targetId) || targetId <= 0 || !['office', 'department', 'callcenter', 'user'].includes(targetType)) {
    throw new Error('Configure a valid Dialpad human fallback target.');
  }
  const mode = env.ROUTING_MODE ?? 'after_hours';
  if (!['after_hours', 'all_calls'].includes(mode)) throw new Error('Choose after_hours or all_calls routing.');
  const enabled = env.PYAI_ROUTING_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled)) throw new Error('PYAI_ROUTING_ENABLED must be true or false.');
  const timeZone = env.BUSINESS_TIME_ZONE ?? 'America/Los_Angeles';
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const open = minute(env.BUSINESS_OPEN ?? '09:00'), close = minute(env.BUSINESS_CLOSE ?? '17:00');
  if (open >= close) throw new Error('Use a same-day opening interval; overnight hours are not supported in this starter.');
  const days = (env.BUSINESS_DAYS ?? '1,2,3,4,5').split(',').map(Number);
  if (!days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Business days must be 0 (Sunday) through 6.');
  return Object.freeze({ secret, inbound: Object.freeze(inbound), agentNumber, targetId, targetType, mode, enabled: enabled === 'true', formatter, open, close, days: Object.freeze(days) });
}

function decode(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new RoutingError(401, 'invalid_signature');
  const value = Buffer.from(part, 'base64url');
  if (value.toString('base64url') !== part) throw new RoutingError(401, 'invalid_signature');
  return value;
}

export function verifyRoutingRequest(raw, config, now = Date.now()) {
  if (Buffer.byteLength(raw) > 8192) throw new RoutingError(413, 'request_too_large');
  let token = raw.trim();
  // Some HTTP clients wrap the compact JWT in a JSON string. Unsigned objects
  // and caller-supplied routing instructions are never accepted.
  if (token.startsWith('"')) {
    try { token = JSON.parse(token); } catch { throw new RoutingError(401, 'invalid_signature'); }
  }
  if (typeof token !== 'string') throw new RoutingError(401, 'invalid_signature');
  const parts = token.split('.');
  if (parts.length !== 3) throw new RoutingError(401, 'invalid_signature');
  let header, claims;
  try { header = JSON.parse(decode(parts[0]).toString()); claims = JSON.parse(decode(parts[1]).toString()); }
  catch { throw new RoutingError(401, 'invalid_signature'); }
  if (!object(header) || header.alg !== 'HS256' || (header.typ !== undefined && header.typ !== 'JWT') || header.crit !== undefined || header.b64 !== undefined || !object(claims)) {
    throw new RoutingError(401, 'invalid_signature');
  }
  const expected = createHmac('sha256', config.secret).update(parts[0] + '.' + parts[1]).digest();
  const actual = decode(parts[2]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new RoutingError(401, 'invalid_signature');
  for (const key of ['iat', 'exp', 'nbf']) {
    if (claims[key] !== undefined && (typeof claims[key] !== 'number' || !Number.isFinite(claims[key]))) throw new RoutingError(401, 'invalid_timestamp');
  }
  const seconds = now / 1000;
  if ((claims.exp !== undefined && seconds >= claims.exp) || (claims.nbf !== undefined && seconds < claims.nbf) || (claims.iat !== undefined && (claims.iat > seconds + 60 || seconds - claims.iat > 300))) throw new RoutingError(401, 'invalid_timestamp');
  if (!Number.isSafeInteger(claims.date_started) || Math.abs(now - claims.date_started) > 300_000) throw new RoutingError(401, 'stale_request');
  if (!(typeof claims.call_id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(claims.call_id)) && !(Number.isSafeInteger(claims.call_id) && claims.call_id > 0)) throw new RoutingError(400, 'invalid_call');
  if (!config.inbound.includes(claims.internal_number)) throw new RoutingError(403, 'number_not_configured');
  return claims;
}

export function routeCall(claims, config) {
  const human = { action: 'route', target_id: config.targetId, target_type: config.targetType };
  // A returning call from the AI destination must never be forwarded to it.
  // Also use a human destination whose Dialpad rules do not re-enter this router.
  if (!config.enabled || claims.external_number === config.agentNumber) return human;
  const parts = Object.fromEntries(config.formatter.formatToParts(new Date(claims.date_started)).map(p => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const at = Number(parts.hour) * 60 + Number(parts.minute);
  const open = config.days.includes(day) && at >= config.open && at < config.close;
  if (config.mode === 'after_hours' && open) return human;
  return { action: 'forward', forward_to: config.agentNumber };
}

export function routingResponse(raw, config, now) {
  return routeCall(verifyRoutingRequest(raw, config, now), config);
}
