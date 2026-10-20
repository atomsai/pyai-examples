import { DEFAULT_CONFIG, PRESETS, readDashboardConfig, embedSnippet } from './trace-widgets/model.mjs';
import './trace-widgets/trace-dashboard.mjs';

const widget = document.querySelector('pyai-trace-dashboard');
const get = id => document.getElementById(id);
let config = readDashboardConfig(DEFAULT_CONFIG);
function update() {
  const preset = PRESETS.find(p => p.id === get('preset').value);
  try {
    config = readDashboardConfig({ ...config, title: get('title').value, theme: get('theme').value, accent: get('accent').value, density: get('density').value, window_days: Number(get('days').value), widgets: [...preset.widgets] });
    // Use one attribute update so the element makes one fresh request.
    widget.setAttribute('config', JSON.stringify(config));
    get('embed').value = embedSnippet(config); get('notice').textContent = '';
  } catch (error) { get('notice').textContent = error.message; }
}
for (const id of ['title', 'preset', 'theme', 'accent', 'density', 'days']) get(id).addEventListener('change', update);
get('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(get('embed').value); get('notice').textContent = 'Embed copied.'; }
  catch { get('notice').textContent = 'Select the embed text and copy it.'; }
});
get('download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'trace-dashboard.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
update();
widget.setAttribute('src', '/api/trace-dashboard');
