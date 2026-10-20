export const WIDGETS = Object.freeze([
  { id: 'scanned', label: 'Scored calls', description: 'The number of calls scored in the selected window.' },
  { id: 'pass_rate', label: 'Pass rate', description: 'PASS verdicts divided by scored calls.' },
  { id: 'gaps', label: 'Calls with a gap', description: 'Calls with a WARN or FAIL verdict.' },
  { id: 'verdicts', label: 'Verdict mix', description: 'PASS, WARN, and FAIL counts side by side.' },
  { id: 'rules', label: 'Top rule findings', description: 'Distinct affected calls for each rule. A call can appear under several rules.' },
]);

export const DEFAULT_CONFIG = Object.freeze({
  schema_version: 'trace-dashboard-v1', title: 'Call quality', theme: 'light',
  accent: '#356859', density: 'comfortable', window_days: 30, max_rules: 5,
  widgets: ['scanned', 'pass_rate', 'gaps', 'verdicts', 'rules'], labels: {},
});

export const PRESETS = Object.freeze([
  { id: 'operations', label: 'Operations', description: 'Volume, verdicts, and the rules that need attention.', widgets: ['scanned', 'pass_rate', 'gaps', 'verdicts', 'rules'] },
  { id: 'risk', label: 'Risk review', description: 'Start with gaps and affected calls by rule.', widgets: ['gaps', 'rules', 'verdicts', 'scanned'] },
  { id: 'leadership', label: 'Leadership', description: 'A compact view of scored volume and verdicts.', widgets: ['scanned', 'pass_rate', 'verdicts'] },
]);

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return value;
}
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Use a short, single-line label.');
  return value.trim();
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('A dashboard count or setting is outside its allowed range.');
  return value;
}

/** Layout only. Unknown fields, including accidental credentials, are discarded. */
export function readDashboardConfig(input) {
  const v = record(input);
  if (v.schema_version !== 'trace-dashboard-v1') throw new Error('Choose a trace-dashboard-v1 layout.');
  if (!['light', 'dark'].includes(v.theme) || !['compact', 'comfortable'].includes(v.density)) throw new Error('Choose a supported theme and spacing.');
  if (typeof v.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(v.accent)) throw new Error('Choose a six-digit hex color.');
  if (![7, 30, 90].includes(v.window_days)) throw new Error('Choose a 7, 30, or 90 day window.');
  const ids = WIDGETS.map(w => w.id);
  if (!Array.isArray(v.widgets) || v.widgets.length < 1 || v.widgets.length > ids.length || new Set(v.widgets).size !== v.widgets.length || v.widgets.some(id => !ids.includes(id))) throw new Error('Choose at least one widget, without duplicates.');
  const labels = {};
  for (const id of ids) if (v.labels && Object.hasOwn(record(v.labels), id)) labels[id] = text(v.labels[id], 60);
  return {
    schema_version: 'trace-dashboard-v1', title: text(v.title, 80), theme: v.theme,
    accent: v.accent.toLowerCase(), density: v.density, window_days: v.window_days,
    max_rules: integer(v.max_rules, 1, 10), widgets: [...v.widgets], labels,
  };
}

/** Allow-list the aggregate response; never pass through unknown upstream fields. */
export function projectExposure(input) {
  const v = record(input);
  if (v.object !== 'trace.exposure') throw new Error('Expected a Trace exposure summary.');
  const scanned = integer(v.interactions_scanned, 0, Number.MAX_SAFE_INTEGER);
  const verdicts = record(v.by_verdict);
  const by_verdict = Object.fromEntries(['PASS', 'WARN', 'FAIL'].map(k => [k, integer(verdicts[k], 0, scanned)]));
  if (by_verdict.PASS + by_verdict.WARN + by_verdict.FAIL !== scanned) throw new Error('Verdict counts do not match scored calls.');
  const gaps = integer(v.with_a_gap, 0, scanned);
  if (gaps !== by_verdict.WARN + by_verdict.FAIL) throw new Error('Gap counts do not match verdicts.');
  if (!Array.isArray(v.by_rule) || v.by_rule.length > 10000) throw new Error('Expected a bounded rule summary.');
  const by_rule = v.by_rule.map(rule => {
    const row = record(rule);
    const count = integer(row.count, 0, scanned);
    return { rule_id: text(row.rule_id, 200), pack_id: row.pack_id == null ? null : text(row.pack_id, 120), count, rate: scanned ? count / scanned : 0 };
  }).sort((a, b) => b.count - a.count || a.rule_id.localeCompare(b.rule_id));
  return {
    object: 'trace.exposure', window_days: integer(v.window_days, 1, 365),
    interactions_scanned: scanned, with_a_gap: gaps, gap_rate: scanned ? gaps / scanned : 0,
    by_verdict, by_rule, top_exposure: by_rule[0]?.rule_id ?? null,
  };
}

export function formatPercent(value) {
  if (value == null) return 'No scored calls';
  // Preserve the distinction between no gaps, a small share, and unanimity.
  if (value > 0 && value < 0.001) return '<0.1%';
  if (value < 1 && value > 0.999) return '>99.9%';
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value);
}

export function embedSnippet(input) {
  const config = readDashboardConfig(input);
  const escaped = JSON.stringify(config).replaceAll('&', '&amp;').replaceAll("'", '&#39;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<script type="module" src="/trace-widgets/trace-dashboard.mjs"></script>\n<pyai-trace-dashboard\n  src="/api/trace-dashboard"\n  config='${escaped}'>\n</pyai-trace-dashboard>`;
}

export function exposureCsv(input) {
  const v = projectExposure(input);
  const rows = [['metric', 'value', 'window_days'], ['scored_calls', v.interactions_scanned, v.window_days], ['pass_calls', v.by_verdict.PASS, v.window_days], ['warn_calls', v.by_verdict.WARN, v.window_days], ['fail_calls', v.by_verdict.FAIL, v.window_days], ['calls_with_gap', v.with_a_gap, v.window_days], ['pass_rate_scored_calls_only', v.interactions_scanned ? v.by_verdict.PASS / v.interactions_scanned : '', v.window_days], ...v.by_rule.map(r => [`rule:${r.rule_id}`, r.count, v.window_days])];
  return rows.map(row => row.map(value => {
    let s = String(value);
    if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n') + '\r\n';
}

export const SAMPLE_EXPOSURE = Object.freeze({
  object: 'trace.exposure', window_days: 30, interactions_scanned: 1240,
  with_a_gap: 86, gap_rate: 86 / 1240, by_verdict: { PASS: 1154, WARN: 64, FAIL: 22 },
  by_rule: [
    { rule_id: 'required_disclosure', pack_id: 'custom', count: 48, rate: 48 / 1240 },
    { rule_id: 'opt_out_handling', pack_id: 'custom', count: 31, rate: 31 / 1240 },
    { rule_id: 'restricted_language', pack_id: 'custom', count: 17, rate: 17 / 1240 },
  ], top_exposure: 'required_disclosure',
});
