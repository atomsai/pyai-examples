// Test-only preload: the real HTTP server cannot contact cloud or carrier APIs.
const scenario = process.env.MOCK_STORAGE_SCENARIO;
if (!['lease-failure', 'lease-throttled', 'allowance-failure', 'allowance-exhausted'].includes(scenario)) throw new Error('invalid_storage_fixture');
const objects = new Map(), history = new Map();
let generation = 0, deniedExternal = 0, allowanceReads = 0;
const realNow = Date.now; let elapsed = 0;
Date.now = () => realNow() + elapsed;
const json = value => Response.json(value);
const put = (name, value) => {
  const item = { generation: String(++generation), value };
  objects.set(name, item); history.set(`${name}:${item.generation}`, item); return item;
};
globalThis.fetch = async (target, options = {}) => {
  const url = new URL(target);
  if (url.href === 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token') {
    return json({ access_token: 'fixture-private-adc', expires_in: 3600 });
  }
  if (url.origin !== 'https://storage.googleapis.com') {
    deniedExternal++; throw new Error('external_request_forbidden_by_test');
  }
  if (options.headers?.Authorization !== 'Bearer fixture-private-adc') throw new Error('invalid_fixture_authorization');
  const name = url.searchParams.get('name') ?? decodeURIComponent(url.pathname.split('/o/')[1] ?? '');
  if (scenario === 'lease-failure') return jsonWithStatus(403);
  if (scenario === 'lease-throttled') { elapsed += 7000; return jsonWithStatus(429); }
  const allowance = /\/allowance-\d{4}-\d{2}\.json$/.test(name);
  if (allowance) {
    allowanceReads++;
    if (scenario === 'allowance-failure') return jsonWithStatus(403);
    if (!objects.has(name)) {
      const date = new Date().toISOString().slice(0, 10);
      put(name, { schema: 'pyai-carrier-allowance-v1', service_id: 'plivo-permanent-fixture', month: date.slice(0, 7),
        rooms: Array.from({ length: 15 }, (_, i) => ({ id: `test-${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`, date })) });
    }
  }
  if (options.method === 'POST') {
    if (url.searchParams.get('ifGenerationMatch') !== (objects.get(name)?.generation ?? '0')) return new Response('', { status: 412 });
    const item = put(name, JSON.parse(options.body)); return json({ generation: item.generation });
  }
  const item = url.searchParams.has('generation') ? history.get(`${name}:${url.searchParams.get('generation')}`) : objects.get(name);
  if (!item) return new Response('', { status: 404 });
  return url.searchParams.get('alt') === 'media' ? json(item.value) : json({ generation: item.generation });
};
function jsonWithStatus(status) {
  return Response.json({ error: { message: 'private-upstream-response fixture-private-adc https://private.example/secret' } }, { status });
}
process.on('exit', () => console.error(JSON.stringify({ event: 'storage_fixture_complete', denied_external_requests: deniedExternal,
  allowance_reached: allowanceReads > 0 })));
