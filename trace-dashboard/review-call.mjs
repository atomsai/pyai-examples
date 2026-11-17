import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function review(detail, sample = false) {
  const scorecard = detail?.scorecard;
  if (!object(detail) || typeof detail.id !== 'string' || !object(scorecard) ||
      scorecard.call_id !== detail.id || !Array.isArray(scorecard.findings) ||
      !['PASS', 'WARN', 'FAIL'].includes(detail.verdict)) {
    throw new Error('Invalid interaction response; no review was produced.');
  }
  return {
    sample,
    interaction_id: detail.id,
    reported_verdict: detail.verdict,
    interpretation: 'Existing reported checks only; not a new scan or a legal-compliance determination.',
    findings: scorecard.findings,
    satisfied_requirements: scorecard.satisfied_requirements ?? [],
    gate_health: scorecard.gate_health ?? null,
    audit_hash: detail.audit_hash ?? null,
    audit_chain_verified: false,
    advisory_findings: detail.tier2_findings ?? [],
    scorecard,
  };
}

export async function run(args, { env = process.env, fetchImpl = fetch, log = console.error } = {}) {
  const allowed = new Set(['--live', '--project', '--call', '--out']);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.has(key) || key in options) throw new Error('Use [--live --project PROJECT_ID [--call CALL_ID]] [--out FILE].');
    options[key] = key === '--live' ? true : args[++i];
    if (!options[key] || (typeof options[key] === 'string' && options[key].startsWith('--'))) throw new Error(`Missing value for ${key}.`);
  }
  if (!options['--live']) {
    if (options['--project'] || options['--call']) throw new Error('Use --live explicitly to read your organization.');
    return { result: review(JSON.parse(await readFile(new URL('./sample-call.json', import.meta.url))), true), output: options['--out'] };
  }
  if (!env.PYAI_API_KEY || !options['--project']) throw new Error('Live reads require PYAI_API_KEY and --project with the expected project ID.');
  const get = async path => {
    const response = await fetchImpl(`https://api.pyai.com${path}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${env.PYAI_API_KEY}` },
    });
    if (!response.ok) throw new Error(`PyAI read failed (HTTP ${response.status}); stopped without retrying.`);
    return response.json();
  };
  const me = await get('/v1/me');
  if (me?.project_id !== options['--project'] || typeof me.org_id !== 'string' ||
      me.status !== 'active' || me.org_status !== 'active' ||
      !Array.isArray(me.scopes) || !me.scopes.includes('trace:read')) {
    throw new Error('Expected active project and organization with trace:read; no Trace data was requested.');
  }
  log(JSON.stringify({ project_id: me.project_id, org_id: me.org_id, environment: me.env,
    scope: 'Trace reads are organization-scoped, not limited to this project.', credit: me.credit, limits: me.limits,
    key_budget_cents: me.key_budget_cents }));
  if (!options['--call']) {
    const page = await get('/v1/trace/interactions?limit=5');
    if (!Array.isArray(page?.data)) throw new Error('Invalid interaction list.');
    return { result: { sample: false, interactions: page.data, has_more: page.has_more,
      next_step: page.data.length ? 'Choose an authorized call ID and run with --call.' : 'No existing scorecards returned. This is not a compliance PASS; confirm eligible processing and permissions.' }, output: options['--out'] };
  }
  const detail = await get('/v1/trace/interactions/' + encodeURIComponent(options['--call']));
  if (detail?.id !== options['--call']) throw new Error('Returned interaction does not match the requested call.');
  return { result: review(detail), output: options['--out'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { result, output } = await run(process.argv.slice(2));
    const text = JSON.stringify(result, null, 2) + '\n';
    if (output) {
      await writeFile(output, text, { flag: 'wx', mode: 0o600 });
      console.log(`Saved ${result.sample ? 'fictional sample' : 'existing call data'} to ${output}.`);
    } else process.stdout.write(text);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
