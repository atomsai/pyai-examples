import { configuration } from './routing.mjs';

const config = configuration(process.env);
const mode = process.argv[2];
if (mode === '--plan') {
  const url = new URL(process.env.PUBLIC_ROUTING_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/dialpad/route') throw new Error('Use the HTTPS /dialpad/route callback URL without credentials or query parameters.');
  const office = Number(process.env.DIALPAD_OFFICE_ID);
  if (!Number.isSafeInteger(office) || office <= 0) throw new Error('Set the Dialpad office ID.');
  console.log(JSON.stringify({ method: 'POST', endpoint: 'https://dialpad.com/api/v2/callrouters', body: {
    name: 'PyAI after-hours pilot', office_id: office, routing_url: url.href,
    default_target_id: config.targetId, default_target_type: config.targetType,
    enabled: false, secret: '[set the same secret from your secret store]',
  }, next: 'This is a plan, not an API write. Create the router disabled; assign only an approved test number after account access is qualified.' }, null, 2));
} else if (mode === '--check') {
  const key = process.env.DIALPAD_API_KEY;
  if (!key) throw new Error('Set DIALPAD_API_KEY in the server environment.');
  for (const path of ['/company', '/callrouters']) {
    const result = await fetch('https://dialpad.com/api/v2' + path, { headers: { Authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(4000) });
    console.log(JSON.stringify({ endpoint: path, status: result.status, accessible: result.ok }));
    if (!result.ok) { process.exitCode = 1; break; }
    await result.body?.cancel();
  }
} else { throw new Error('Choose --plan (no network) or --check (read-only API access).'); }
