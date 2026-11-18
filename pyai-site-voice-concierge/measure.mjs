// Explicit, bounded API measurements. Importing this module makes no requests.
import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { validateIdentity } from './demo.mjs';

export const samples = [
  { language: 'English', voice: 'stock_aria_en', tier: 'natural', input: 'Your appointment reminder is ready. You can review the details on our website.' },
  { language: 'Hindi', voice: 'stock_ananya_hi', tier: 'standard', input: 'आपकी मुलाकात का रिमाइंडर तैयार है। आप हमारी वेबसाइट पर जानकारी देख सकते हैं।' },
];
export function wav(pcm) {
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export async function createMeasurements({ apiKey, projectId, resultsDir, region, maxRequests = 46 }) {
  if (!region) throw new Error('explicit_client_region_required');
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 46) throw new Error('invalid_request_bound');
  await mkdir(resultsDir, { recursive: true });
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const identityResponse = await fetch('https://api.pyai.com/v1/me', { headers, signal: AbortSignal.timeout(10000) });
  if (!identityResponse.ok) throw new Error(`identity_${identityResponse.status}`);
  const identity = await identityResponse.json(); validateIdentity(identity, projectId);
  if (!identity.scopes.includes('speak:synthesize')) throw new Error('missing_speech_scope');
  const report = { started_at: new Date().toISOString(), client_region: region, endpoint: 'https://api.pyai.com/v1/audio/speech', node: process.version,
    project: { project_id: identity.project_id, env: identity.env, credit: identity.credit },
    conditions: 'One sequential client; first benchmark request separate from next 20 per language; prior demo traffic may already have warmed serving. Shared production server cold state uncontrolled. Same text repeated; report x-pyai-cache on every response. No retries. Client request-start to first nonempty PCM body bytes, including network and admission; not server-only or audible latency.',
    format: 'PCM16 little-endian, 24000 Hz, mono', max_requests: maxRequests, observations: [] };
  const save = async () => writeFile(join(resultsDir, 'measurements.json'), JSON.stringify(report, null, 2));
  let failed = false;
  async function synthesize({ input, voice, language = 'English', tier = 'natural' }, purpose, index) {
    if (failed || report.observations.length >= maxRequests || input.length > 180) throw new Error('run_bound_reached');
    const row = { purpose, index, language, voice, tier, input, characters: [...input].length, started_at: new Date().toISOString(), status: 'SUBMITTING' };
    report.observations.push(row); await save();
    const start = performance.now();
    try {
      const response = await fetch(report.endpoint, { method: 'POST', headers, body: JSON.stringify({ input, voice, response_format: 'pcm', sample_rate: 24000, stream: true }), signal: AbortSignal.timeout(20000) });
      row.http_status = response.status; row.headers_ms = performance.now() - start;
      row.headers = Object.fromEntries([...response.headers].filter(([k]) => /^(content-type|x-request-id|x-pyai-|server-timing)/.test(k)));
      if (!response.ok) { row.error_body = (await response.text()).slice(0, 1000); throw new Error(`speech_${response.status}`); }
      if (!response.headers.get('content-type')?.startsWith('audio/')) throw new Error('non_audio_content_type');
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        if (!chunk.length) continue;
        if (row.first_audio_ms === undefined) row.first_audio_ms = performance.now() - start;
        bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('audio_size_limit'); chunks.push(Buffer.from(chunk));
      }
      const pcm = Buffer.concat(chunks);
      if (!pcm.length || pcm.length % 2) throw new Error('invalid_pcm');
      row.total_ms = performance.now() - start; row.bytes = pcm.length; row.audio_seconds = pcm.length / 48000; row.sha256 = createHash('sha256').update(pcm).digest('hex'); row.status = 'PASS';
      if (purpose === 'caller' || index === 0) await writeFile(join(resultsDir, `${purpose}-${language}-${index}.wav`), wav(pcm));
      await save(); return pcm;
    } catch (error) { failed = true; row.status = 'FAIL'; row.error = error.message; row.elapsed_ms = performance.now() - start; await save(); throw error; }
  }
  async function benchmark() {
    for (const sample of samples) for (let index = 0; index < 21; index++) await synthesize(sample, 'benchmark', index);
    const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
    report.summary = samples.map(sample => {
      const rows = report.observations.filter(r => r.purpose === 'benchmark' && r.language === sample.language);
      const later = rows.filter(r => r.index > 0 && r.status === 'PASS').map(r => r.first_audio_ms);
      return { ...sample, first_request_ms: rows[0]?.first_audio_ms, sequential_n: later.length, p50_ms: percentile(later, 0.5), p95_ms: percentile(later, 0.95), failed: rows.filter(r => r.status !== 'PASS').length };
    });
    report.finished_at = new Date().toISOString(); await save(); return report;
  }
  return { synthesize, benchmark, report };
}
