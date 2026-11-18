// Local, authenticated synthetic demo. Never bind this server to a public interface.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

export const configure = {
  type: 'configure', language: 'en',
  greeting: 'Welcome to the Lantern Desk demonstration. What would you like to know?',
  persona: `You are the Lantern Desk website assistant. Your complete product knowledge is exactly: "Lantern Desk provides appointment reminders for teams of up to ten users. This is a synthetic demonstration; it never books a real appointment." For a product question, state those facts and ask how many people are in the visitor's team and whether they need reminders. Do not infer delivery channels, automation, integrations, pricing, guarantees or any other capabilities. Email and text messaging are NOT verified capabilities; never offer them. Ask for confirmation before saving the synthetic enquiry with save_demo_enquiry. Never claim it was saved until the tool returns success. After saving, explain what was saved and the demonstration limitations in three sentences. If interrupted, stop immediately and answer the new question briefly. Do not offer phone calls, transfers or real bookings.`,
  tools: [{ name: 'save_demo_enquiry', side_effect: 'action', description: 'Save a confirmed synthetic enquiry to this demo backend. No real booking or external contact.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      team_size: { type: 'integer', minimum: 1, maximum: 10 }, needs_reminders: { type: 'boolean' },
    }, required: ['team_size', 'needs_reminders'] } }],
};

export function validateIdentity(me, projectId) {
  if (!projectId || me?.project_id !== projectId || me.env !== 'test' || me.status !== 'active' || me.org_status !== 'active') throw new Error('wrong_test_project');
  if (me.credit?.gated !== false) throw new Error('nonbillable_test_project_required');
  if (!me.scopes?.includes('omni:session')) throw new Error('missing_omni_scope');
}

export function toolArguments(value) {
  // Native Omni can carry JSON text; SDK/client versions may supply an object.
  if (typeof value === 'string') {
    if (value.length > 2048) throw new Error('arguments_too_large');
    value = JSON.parse(value);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_arguments');
  return value;
}

export async function startDemo({ apiKey, projectId, password, port = 8787, resultsDir = './demo-results', fetchImpl = fetch }) {
  if (!apiKey || !projectId || typeof password !== 'string' || password.length < 24) throw new Error('demo_credentials_required');
  const origin = `http://127.0.0.1:${port}`;
  const auth = Buffer.from('Basic ' + Buffer.from(`demo:${password}`).toString('base64'));
  const dir = resolve(resultsDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let attempted = false;
  let closedAt = 0;
  let receipt;
  let actionPending = false;
  const root = fileURLToPath(new URL('./public/', import.meta.url));
  const publicFiles = new Set(['index.html', 'app.js', 'audio-contract.mjs', 'omni-wire.mjs', 'playback-receipts.mjs', 'transcript-correction.mjs', 'tool-client.mjs']);
  const server = createServer(async (req, res) => {
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const presented = Buffer.from(req.headers.authorization || '');
    if (auth.length !== presented.length || !timingSafeEqual(auth, presented)) { res.setHeader('WWW-Authenticate', 'Basic realm="Local synthetic demo"'); return json(401, { error: 'authentication_required' }); }
    if (req.method === 'POST' && req.headers.origin !== origin) return json(403, { error: 'origin_not_allowed' });
    try {
      if (req.method === 'GET' && req.url === '/config') return json(200, { mode: 'direct' });
      if (req.method === 'POST' && req.url === '/session') {
        if (attempted) return json(429, { error: 'one_session_limit' });
        attempted = true; // Upstream failures consume the attempt too. No automatic retry.
        const response = await fetchImpl('https://api.pyai.com/v1/me', { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) });
        if (!response.ok) return json(503, { error: 'identity_unavailable' });
        validateIdentity(await response.json(), projectId);
        const mint = await fetchImpl('https://api.pyai.com/v1/omni/sessions', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ allowed_origins: [origin], ttl_seconds: 60, session_label: 'lantern-desk-synthetic-demo' }), signal: AbortSignal.timeout(10000) });
        if (!mint.ok) return json(mint.status === 402 ? 402 : 502, { error: mint.status === 402 ? 'credit_exhausted' : 'mint_failed' });
        const session = await mint.json();
        const url = new URL(session.url);
        if (url.protocol !== 'wss:' || url.hostname !== 'api.pyai.com' || !session.token || !session.expires_at) throw new Error('invalid_session');
        url.searchParams.set('format', 'pcm16'); url.searchParams.set('rate', '24000');
        closedAt = Date.now() + 180000;
        return json(200, { token: session.token, url: url.href, expires_at: session.expires_at, configure, max_duration_ms: 180000 });
      }
      if (req.method === 'POST' && req.url === '/demo-action') {
        if (!closedAt || Date.now() > closedAt) return json(403, { error: 'demo_session_inactive' });
        let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 4096) return json(413, { error: 'too_large' }); }
        const call = JSON.parse(text);
        let args;
        try { args = toolArguments(call.arguments); } catch { return json(400, { error: 'invalid_action' }); }
        if (call.name !== 'save_demo_enquiry' || typeof call.call_id !== 'string' || !/^[\w-]{1,128}$/.test(call.call_id)
          || !args || Object.keys(args).sort().join(',') !== 'needs_reminders,team_size'
          || !Number.isInteger(args.team_size) || args.team_size < 1 || args.team_size > 10 || typeof args.needs_reminders !== 'boolean') return json(400, { error: 'invalid_action' });
        if (receipt) return receipt.call_id === call.call_id && receipt.data.team_size === args.team_size && receipt.data.needs_reminders === args.needs_reminders ? json(200, receipt) : json(409, { error: 'one_action_limit' });
        if (actionPending) return json(409, { error: 'action_in_progress' });
        actionPending = true;
        // One durable receipt before success. No CRM, email or calendar side effects.
        const saved = { success: true, call_id: call.call_id, id: 'synthetic-enquiry-1', data: args };
        await writeFile(join(dir, 'enquiry.json'), JSON.stringify(saved, null, 2), { flag: 'wx', mode: 0o600 });
        receipt = saved;
        return json(200, receipt);
      }
      if (req.method !== 'GET') return json(404, { error: 'not_found' });
      const name = req.url === '/' ? 'index.html' : req.url.slice(1);
      if (!publicFiles.has(name)) return json(404, { error: 'not_found' });
      let body = await readFile(join(root, name), 'utf8');
      if (name === 'index.html') body = body.replaceAll('Talk to PyAI', 'Lantern Desk synthetic demo')
        .replace('Ask anything about PyAI, products, models, pricing, out loud.', 'Ask about appointment reminders, qualify a fictional team, and save one demo enquiry.');
      res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html' : 'text/javascript', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body);
    } catch (error) { json(503, { error: ['wrong_test_project', 'nonbillable_test_project_required', 'missing_omni_scope'].includes(error.message) ? error.message : 'demo_failed' }); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, origin };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { origin } = await startDemo({ apiKey: process.env.PYAI_API_KEY, projectId: process.env.PYAI_PROJECT_ID, password: process.env.DEMO_PASSWORD });
  console.log(`Open ${origin}; username demo, password from DEMO_PASSWORD. One synthetic session, maximum 3 minutes.`);
}
