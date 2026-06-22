# Omni browser voice widget

Add a **talking voice agent to any website with one `<script>` tag** — no phone,
no Twilio, no framework, no build step. The agent runs over a WebSocket directly
between the visitor's browser and PyAI [Omni](https://docs.pyai.com); your secret
key never leaves your server.

```html
<script src="https://your-site.example/pyai-widget.js" data-token-url="/token"></script>
```

That injects a floating mic button. Click → talk → the agent talks back, with
barge-in (interrupt it any time).

> Want a fuller standalone app with per-turn knowledge-base grounding and a
> one-click cloud deploy? See [`../pyai-site-voice-concierge`](../pyai-site-voice-concierge).
> This example is deliberately the **minimal embeddable** version.

## How it works

```
browser ──POST /token──▶ your server ──POST /v1/omni/sessions──▶ PyAI   (mint short-lived token)
browser ──wss /v1/omni  (pyai-key.<ephemeral token>)───────────▶ PyAI   (audio, direct)
```

- `public/pyai-widget.js` — the entire client: a self-contained, dependency-free
  widget. Captures the mic (Web Audio, 24 kHz PCM16), opens the Omni WebSocket
  with the token's subprotocol, sends the `configure` frame, and plays the
  agent's PCM16 back.
- `server.js` — ~80 lines, **zero dependencies** (Node built-in `http`). Its only
  job is to mint a short-lived, origin-locked session token via
  `POST /v1/omni/sessions` so your `pyai_live_` key never ships to the browser.
  This server is **never in the audio path**.

## Run it

```bash
cp .env.example .env     # add your PYAI_API_KEY (a pyai_test_ sandbox key is fine)
npm start                # http://localhost:8080
```

Open <http://localhost:8080>, click **Talk to us**, allow the mic, and speak.

## Put it on your own site

1. Host `pyai-widget.js` somewhere your pages can load it — **a CDN is ideal**
   (see below), or your own site/CDN.
2. Run the `/token` endpoint from `server.js` on your backend (or fold it into
   your existing API). Set `ALLOWED_ORIGINS` to your site's origin(s).
3. Add the one-line `<script>` tag, pointing `data-token-url` at your endpoint.

Optional attributes: `data-label` (button text). Configure the agent's behavior
(`PERSONA`, `PYAI_VOICE`) and token lifetime (`SESSION_TTL_SECONDS`) via env.

## Serve the widget from a CDN

`pyai-widget.js` is a single, static, dependency-free file — perfect for a CDN.
Cross-origin `<script>` execution needs no CORS, and the widget reads its config
from its own `<script>` tag's `data-*` attributes, so the **same hosted file
works for every site** — only `data-token-url` differs.

PyAI already runs one (`cdn.pyai.com` → a GCS bucket behind Cloud CDN, see
`infra/terraform/lb_cdn.tf`). Publish to a **versioned, immutable** path:

```bash
gsutil -h "Cache-Control:public,max-age=31536000,immutable" \
  cp public/pyai-widget.js gs://pyai-cdn-assets/widget/v1/pyai-widget.js
```

Then the embed is just:

```html
<script src="https://cdn.pyai.com/widget/v1/pyai-widget.js" data-token-url="/token"></script>
```

Use a new version segment (`/widget/v2/…`) for breaking changes so cached pages
keep working. Any CDN works the same way — e.g. publish the file to npm and load
it via `https://cdn.jsdelivr.net/npm/<pkg>@<version>/pyai-widget.js`.

## Production notes

- **Lock down `/token`.** It mints billable sessions — add auth / CAPTCHA /
  rate-limiting and keep `ALLOWED_ORIGINS` tight. Tokens are origin-locked and
  short-lived (~60s) by design.
- **Never put your key in the page.** Always mint a token server-side; this
  recipe does that for you.
- For lower-latency/robust capture, swap the demo's `ScriptProcessor` for an
  `AudioWorklet` (the deprecated API is used here only to stay dependency-free).
- Native WebRTC (SDP/ICE) is **not** used or required — Omni is WebSocket + PCM16.
