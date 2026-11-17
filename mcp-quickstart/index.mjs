#!/usr/bin/env node
/** Local MCP stdio: inspect discovery, project and billing by default.
 * --sandbox explicitly creates a NEW session-only test project; never automatic.
 * Speech requires --generate plus --project <inspected ID> (or --sandbox).
 * Live usage additionally requires --allow-live and an independently approved budget.
 * Node >=22, no dependencies. No automatic retries.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const { values: opts } = parseArgs({ options: {
  sandbox: { type: 'boolean' }, generate: { type: 'boolean' },
  project: { type: 'string' }, profile: { type: 'string' }, 'allow-live': { type: 'boolean' },
} });
const server = spawn('npx', ['-y', '@pyai/mcp@0.5.18', ...(opts.profile ? ['--profile', opts.profile] : [])], {
  cwd: here, stdio: ['pipe', 'pipe', 'inherit'], env: process.env,
});
const pending = new Map();
let nextId = 1;
function failPending(message) {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
  pending.clear();
}
server.on('error', () => failPending('Could not start MCP. Install Node.js 22+ and check npx.'));
server.on('exit', () => failPending('MCP exited before responding; do not retry speech automatically.'));
const rl = createInterface({ input: server.stdout });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id); clearTimeout(p.timer);
  if (msg.error) p.reject(new Error('MCP request failed; no automatic retry.'));
  else p.resolve(msg.result);
});
function send(method, params, id) {
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
}
function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('MCP timed out; speech may have completed. Do not retry automatically.'));
    }, 120_000);
    pending.set(id, { resolve, reject, timer });
    send(method, params, id);
  });
}
async function tool(name, args = {}) {
  const result = await request('tools/call', { name, arguments: args });
  if (!result || result.isError) throw new Error(`${name} failed; stopped without retry. Speech may have completed; inspect artifacts before another request. For whoami, run pyai login or explicitly choose --sandbox.`);
  if (result.structuredContent) return result.structuredContent;
  const text = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
}
function hasBillingContext(limits, credit) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const nullableInteger = value => value === null || Number.isInteger(value);
  // GET /v1/me field types plus the core fields its projection always returns.
  // daily_unit_cap is optional; null caps are unlimited, not free usage.
  return object(limits) && object(credit)
    && ['rps', 'burst', 'concurrency'].every(k => Number.isInteger(limits[k]))
    && Object.hasOwn(limits, 'monthly_units') && nullableInteger(limits.monthly_units)
    && (!Object.hasOwn(limits, 'daily_unit_cap') || nullableInteger(limits.daily_unit_cap))
    && typeof credit.gated === 'boolean' && Number.isInteger(credit.available_cents);
}
function validateWav(path) {
  if (!lstatSync(path).isFile()) throw new Error('Output is not a regular WAV file.');
  const b = readFileSync(path);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE' || b.readUInt32LE(4) !== b.length - 8)
    throw new Error('Output is not a complete RIFF WAV file.');
  let fmt, data, p = 12;
  while (p + 8 <= b.length) {
    const tag = b.toString('ascii', p, p + 4), n = b.readUInt32LE(p + 4), start = p + 8;
    if (start + n > b.length) throw new Error('Truncated WAV chunk.');
    if (tag === 'fmt ') {
      if (fmt || n < 16) throw new Error('Invalid WAV format chunk.');
      fmt = { codec: b.readUInt16LE(start), channels: b.readUInt16LE(start+2), rate: b.readUInt32LE(start+4), bytesPerSecond: b.readUInt32LE(start+8), align: b.readUInt16LE(start+12), bits: b.readUInt16LE(start+14) };
    }
    if (tag === 'data') { if (data !== undefined) throw new Error('Duplicate WAV data.'); data = n; }
    p = start + n + (n % 2);
  }
  if (p !== b.length || !fmt || fmt.codec !== 1 || fmt.bits !== 16 || ![1,2].includes(fmt.channels) || fmt.rate < 8000 || fmt.rate > 192000 || fmt.align !== fmt.channels * 2 || fmt.bytesPerSecond !== fmt.rate * fmt.align || !data || data % fmt.align)
    throw new Error('Output is not a nonempty, complete PCM16 WAV.');
  return { bytes: b.length, seconds: data / fmt.bytesPerSecond };
}
async function main() {
  if (opts.sandbox && opts.project) throw new Error('--sandbox creates a new project; do not combine it with --project.');
  const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pyai-mcp-quickstart', version: '1.1.0' } });
  console.log(`Connected to ${init.serverInfo?.name ?? 'MCP'} (local stdio).`);
  send('notifications/initialized', {});
  const { tools } = await request('tools/list');
  console.log(`Tools: ${tools.map(t => t.name).join(', ')}`);
  let created;
  if (opts.sandbox) {
    created = await tool('create_sandbox_key', { label: 'mcp-quickstart' });
    if (!created.project_id) throw new Error('Sandbox creation did not return a project ID.');
  }
  const me = await tool('whoami');
  // Print only identity/billing fields, never the entire tool result or credentials.
  const fields = ['org_id','org_name','project_id','project_name','env','status','org_status','scopes','expires_at','plan','limits','credit','key_budget_cents','billing_notice','managed_billing'];
  console.log('Project and billing context:\n' + JSON.stringify(Object.fromEntries(fields.filter(k => Object.hasOwn(me,k)).map(k => [k, me[k]])), null, 2));
  if (!me.org_id || !me.project_id || !['test','live'].includes(me.env) || me.status !== 'active' || me.org_status !== 'active' || !hasBillingContext(me.limits, me.credit) || !me.billing_notice)
    throw new Error('Identity or billing context is incomplete/inactive. Stop and inspect whoami.');
  if (created && (me.project_id !== created.project_id || me.org_id !== created.org_id || me.env !== 'test'))
    throw new Error('Sandbox identity does not match the newly created test project.');
  if (!opts.generate) {
    console.log('Inspection complete. No audio submitted. Review billing and limits before opting in with --generate --project <project_id>. --sandbox is session-only.');
    return;
  }
  if (!created && opts.project !== me.project_id) throw new Error('Generation requires --project matching the inspected project ID.');
  if (me.env === 'live' && !opts['allow-live']) throw new Error('Live usage can incur charges. Requires --allow-live and a separately approved budget; this script does not enforce a dollar cap.');
  if (!me.scopes?.some(s => ['speak:synthesize','speak:*','*'].includes(s))) throw new Error('Project key lacks speech synthesis permission.');
  if (me.expires_at != null && me.expires_at <= Date.now()) throw new Error('Project key has expired.');
  const out = join(here, 'hello.wav');
  try { lstatSync(out); throw new Error('Output already exists; preserve it and choose a fresh example directory.'); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  console.log('Submitting one short clip. No automatic retries; inspect billing separately.');
  const tts = await tool('synthesize_speech', { input: 'Hello from the PyAI MCP server.', voice: 'nova', response_format: 'wav', output_path: out });
  if (tts.status !== 'ok' || typeof tts.output_path !== 'string' || resolve(tts.output_path) !== out) throw new Error('Speech result did not confirm the requested output file.');
  const wav = validateWav(out);
  if (tts.bytes !== wav.bytes) throw new Error('Speech result and saved file sizes disagree.');
  console.log(`Saved and validated PCM WAV: ${out} (${wav.bytes} bytes, ${wav.seconds.toFixed(3)} seconds). Play it to confirm audible quality; playback has not been tested by this script.`);
}
main().catch(err => { console.error('Error:', err.message); process.exitCode = 1; }).finally(() => {
  failPending('Client closed.'); rl.close(); server.stdin.end(); server.kill();
});
