import { DEFAULT_CONFIG, WIDGETS, readDashboardConfig, projectExposure, formatPercent } from './model.mjs';

const CSS = `
:host{display:block;min-width:0;color-scheme:light;font-family:ui-sans-serif,system-ui,sans-serif;--bg:#f7f9f8;--card:#fff;--text:#182b25;--muted:#56675f;--line:#d7e1db}
:host([hidden]){display:none}.dashboard{background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:20px;padding:24px;container-type:inline-size}
.dashboard.dark{color-scheme:dark;--bg:#14211d;--card:#1d2d27;--text:#f0f5f2;--muted:#b8c9c0;--line:#3d5248}
*{box-sizing:border-box}h2,h3,p{margin:0}header{display:flex;justify-content:space-between;align-items:start;gap:16px;margin-bottom:22px}h2{font-size:22px;line-height:1.3;letter-spacing:-.025em;overflow-wrap:anywhere}
.eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:7px;color:var(--muted)}.meta,.note{font-size:12px;line-height:1.6;color:var(--muted)}.meta{margin-top:6px}.note{margin-top:18px}
.grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}.card{grid-column:span 2;border:1px solid var(--line);border-top:3px solid var(--accent);background:var(--card);padding:20px;border-radius:12px;min-width:0}.card.wide{grid-column:span 3}h3{font-size:13px;font-weight:600;line-height:1.5;overflow-wrap:anywhere}.value{font-size:30px;font-weight:650;letter-spacing:-.04em;margin:14px 0 4px;font-variant-numeric:tabular-nums}.hint{font-size:12px;line-height:1.6;color:var(--muted)}
.mix{display:flex;height:12px;border-radius:6px;overflow:hidden;margin:18px 0 12px;background:var(--line)}.pass{background:#358065}.warn{background:#b87a16}.fail{background:#c74b54}.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px}.legend span{display:flex;align-items:center;gap:5px}.dot{width:7px;height:7px;border-radius:100%;display:inline-block}
ol{list-style:none;padding:0;margin:14px 0 0}li+li{margin-top:14px}.rule{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:12px;line-height:1.5}.rule-name{overflow-wrap:anywhere}.rule-count{flex-shrink:0;font-variant-numeric:tabular-nums;color:var(--muted)}.track{height:4px;background:var(--line);border-radius:4px;margin-top:6px}.bar{height:100%;background:var(--accent);border-radius:4px}
button{font:inherit;font-size:12px;border:1px solid var(--line);border-radius:30px;padding:8px 12px;background:var(--card);color:var(--text);cursor:pointer;flex-shrink:0}button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}button:disabled{opacity:.6;cursor:wait}.status{padding:20px 0;font-size:14px;line-height:1.6}.sample{padding:9px 12px;margin-bottom:16px;background:var(--card);border:1px dashed var(--line);border-radius:8px;font-size:12px;line-height:1.6}.compact{padding:16px}.compact .card{padding:14px}.compact .value{font-size:26px;margin-top:10px}
@container(max-width:600px){.card{grid-column:span 3}.card.wide{grid-column:span 6}}
@container(max-width:350px){.card{grid-column:span 6}.value{font-size:28px}header{flex-wrap:wrap}}
`;

function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
}

export function registerTraceDashboard() {
  if (typeof customElements === 'undefined' || customElements.get('pyai-trace-dashboard')) return;
  class TraceDashboard extends HTMLElement {
    static observedAttributes = ['src', 'config'];
    #config = readDashboardConfig(DEFAULT_CONFIG);
    #data = null;
    #updated = null;
    #sample = false;
    #error = '';
    #busy = false;
    #request = null;
    #shadow = this.attachShadow({ mode: 'open' });

    connectedCallback() { if (this.hasAttribute('config')) this.#readConfig(); this.#load(); }
    disconnectedCallback() { this.#request?.abort(); this.#request = null; }
    attributeChangedCallback(name, previous, next) {
      if (previous === next) return;
      if (name === 'config') {
        const oldWindow = this.#config.window_days;
        this.#readConfig();
        if (this.#error) {
          this.#request?.abort(); this.#request = null; this.#busy = false;
          this.#render(); return;
        }
        if (this.isConnected && this.hasAttribute('src') && (oldWindow !== this.#config.window_days || (!this.#data && !this.#busy))) this.#load();
        else this.#render();
      } else if (this.isConnected) {
        this.#data = null; this.#sample = false; this.#updated = null; this.#error = '';
        this.#load();
      }
    }
    #readConfig() {
      try { this.#config = readDashboardConfig(JSON.parse(this.getAttribute('config'))); this.#error = ''; }
      catch { this.#error = 'The dashboard layout could not be read. Import a supported layout to continue.'; this.#data = null; }
    }
    get config() { return readDashboardConfig(this.#config); }
    set config(value) {
      this.setAttribute('config', JSON.stringify(readDashboardConfig(value)));
    }
    setData(value, { sample = false, updatedAt = null } = {}) {
      this.#request?.abort();
      this.#request = null;
      this.#busy = false;
      this.#data = projectExposure(value);
      this.#sample = sample;
      this.#updated = updatedAt;
      this.#error = '';
      this.#render();
    }
    async refresh() { await this.#load(); }
    async #load() {
      this.#request?.abort();
      this.#request = null;
      if (this.#error && !this.hasAttribute('src')) { this.#render(); return; }
      const src = this.getAttribute('src');
      if (!src) { this.#busy = false; this.#render(); return; }
      if (this.hasAttribute('config')) {
        this.#readConfig();
        if (this.#error) { this.#render(); return; }
      }
      const controller = new AbortController();
      this.#request = controller;
      const timeout = setTimeout(() => controller.abort(), 10000);
      this.#busy = true; this.#data = null; this.#error = ''; this.#render();
      try {
        const url = new URL(src, location.href);
        if (url.origin !== location.origin || url.username || url.password || !['https:', 'http:'].includes(url.protocol)) throw new Error('Use a same-origin dashboard endpoint.');
        url.searchParams.set('window_days', String(this.#config.window_days));
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Sign in to your app to view this dashboard.' : response.status === 429 ? 'Too many requests. Wait before refreshing.' : 'Dashboard data could not be loaded. Try refreshing.');
        const body = await response.json();
        const data = projectExposure(body.exposure);
        if (data.window_days !== this.#config.window_days) throw new Error('The server returned a different date window.');
        const updated = new Date(body.generated_at);
        if (!Number.isFinite(updated.getTime())) throw new Error('The server did not include an update time.');
        if (this.#request !== controller || !this.isConnected) return;
        this.#data = data; this.#sample = body.sample === true; this.#updated = updated.toISOString();
      } catch (error) {
        if (this.#request !== controller || !this.isConnected) return;
        this.#error = controller.signal.aborted ? 'The request timed out. Try refreshing.' : error.message;
        this.#data = null;
      } finally {
        clearTimeout(timeout);
        if (this.#request === controller) { this.#busy = false; this.#render(); }
      }
    }
    #render() {
      const config = this.#config;
      const style = node('style', CSS);
      const box = node('section', undefined, `dashboard ${config.theme} ${config.density}`);
      box.style.setProperty('--accent', config.accent);
      box.setAttribute('aria-label', config.title);
      box.setAttribute('aria-busy', String(this.#busy));
      const header = node('header'); const heading = node('div');
      heading.append(node('p', 'Trace · scored calls', 'eyebrow'), node('h2', config.title));
      const date = this.#updated ? new Date(this.#updated) : null;
      heading.append(node('p', `Last ${config.window_days} days${date && Number.isFinite(date.getTime()) ? ` · Updated ${date.toLocaleString()}` : ''}`, 'meta'));
      header.append(heading);
      if (this.hasAttribute('src')) {
        const refresh = node('button', this.#busy ? 'Loading…' : 'Refresh'); refresh.type = 'button'; refresh.disabled = this.#busy;
        refresh.addEventListener('click', () => this.refresh()); header.append(refresh);
      }
      box.append(header);
      if (this.#sample) box.append(node('p', 'Sample data · Fictional calls for layout preview.', 'sample'));
      if (this.#busy || this.#error || !this.#data || this.#data.window_days !== config.window_days) {
        const status = node('p', this.#busy ? 'Loading scored-call data…' : this.#error || 'Choose a data source to see this dashboard.', 'status');
        status.setAttribute('role', this.#error ? 'alert' : 'status'); box.append(status);
      } else {
        const data = this.#data; const scanned = data.interactions_scanned;
        if (scanned === 0) box.append(node('p', 'No scored calls in this window. Rates will appear after calls are scored.', 'sample'));
        const grid = node('div', undefined, 'grid');
        for (const id of config.widgets) {
          const card = node('section', undefined, `card ${['rules', 'verdicts'].includes(id) ? 'wide' : ''}`);
          card.append(node('h3', config.labels[id] || WIDGETS.find(w => w.id === id).label));
          if (id === 'scanned' || id === 'pass_rate' || id === 'gaps') {
            const value = id === 'scanned' ? scanned.toLocaleString() : id === 'gaps' ? data.with_a_gap.toLocaleString() : formatPercent(scanned ? data.by_verdict.PASS / scanned : null);
            const hint = id === 'scanned' ? 'Calls with a Trace scorecard' : id === 'gaps' ? `${formatPercent(scanned ? data.with_a_gap / scanned : null)} · WARN or FAIL` : `${data.by_verdict.PASS.toLocaleString()} of ${scanned.toLocaleString()} scored calls`;
            card.append(node('p', value, 'value'), node('p', hint, 'hint'));
          } else if (id === 'verdicts') {
            const bar = node('div', undefined, 'mix'); bar.setAttribute('aria-hidden', 'true');
            const legend = node('div', undefined, 'legend');
            for (const verdict of ['PASS', 'WARN', 'FAIL']) {
              const segment = node('div', undefined, verdict.toLowerCase()); segment.style.width = `${scanned ? data.by_verdict[verdict] / scanned * 100 : 0}%`; bar.append(segment);
              const item = node('span'); item.append(node('i', undefined, `dot ${verdict.toLowerCase()}`), document.createTextNode(`${verdict} ${data.by_verdict[verdict].toLocaleString()}`)); legend.append(item);
            }
            card.append(bar, legend);
          } else {
            const list = node('ol');
            for (const row of data.by_rule.slice(0, config.max_rules)) {
              const item = node('li'); const line = node('div', undefined, 'rule');
              line.append(node('span', row.rule_id, 'rule-name'), node('span', `${row.count.toLocaleString()} · ${formatPercent(row.rate)}`, 'rule-count'));
              const track = node('div', undefined, 'track'); track.setAttribute('aria-hidden', 'true');
              const fill = node('div', undefined, 'bar'); fill.style.width = `${row.rate * 100}%`; track.append(fill); item.append(line, track); list.append(item);
            }
            card.append(list);
            if (!data.by_rule.length) card.append(node('p', 'No rule findings in this window.', 'hint'));
            else card.append(node('p', `Top ${Math.min(config.max_rules, data.by_rule.length)} of ${data.by_rule.length} rules · distinct affected calls per rule`, 'meta'));
          }
          grid.append(card);
        }
        box.append(grid);
      }
      box.append(node('p', 'Scored calls only. This view does not measure the share of all eligible calls scored or certify compliance. A call can match several rules. Advisory findings are available separately through the findings API.', 'note'));
      this.#shadow.replaceChildren(style, box);
    }
  }
  customElements.define('pyai-trace-dashboard', TraceDashboard);
}

registerTraceDashboard();
