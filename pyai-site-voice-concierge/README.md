# PyAI site voice concierge, "Talk to PyAI"

A production-shaped integration of **PyAI Omni** as the voice agent on
**pyai.com** itself: a visitor clicks **Talk to PyAI**, speaks, and a realtime
agent answers questions about PyAI's products, models, and pricing, grounded in
a knowledge base you control.

## Deploy in one click (zero-install)

For a bounded synthetic conversation with a real backend action, use the
[local demonstration](#synthetic-website-demonstration) below. The older server
in this example is a reference integration: before exposing it publicly, add
the authenticated project authorization and quota policy described in the
[browser guide](https://docs.pyai.com/guides/browser-voice-agent).

You don't need to clone anything or run `ngrok` to try this on a real URL:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/atomsai/pyai-examples)

Render reads [`render.yaml`](./render.yaml), provisions a public Node service,
and prompts for the **one** thing it needs, your `PYAI_API_KEY` (a `pyai_test_`
key is fine). Everything else is automatic: `KB_TOKEN` is generated and
`KB_PUBLIC_URL` is derived from the service's own URL at runtime, so per-turn
**grounding works with no ngrok and no manual config**. Deploy → open the URL →
click **Talk to PyAI**.

> The button targets the public [`pyai-examples`](https://github.com/atomsai/pyai-examples)
> repo. For a manual deployment, in
> Render, **New → Web Service**, point it at this repo, set **Root Directory** to
> `examples/pyai-site-voice-concierge`, build `npm install`, start
> `npm run start:noenv`, and add `PYAI_API_KEY`. Railway/Fly/Cloud Run work the
> same way, any host that gives the service a public URL gets grounding for free
> (it also honors `PUBLIC_URL`). To **read/edit the code** without installing
> anything, open it in [StackBlitz](https://stackblitz.com/github/atomsai/pyai-examples/tree/main/pyai-site-voice-concierge).

Prefer to run it locally? See [Run it](#run-it) below.

## Synthetic website demonstration

This optional `demo.mjs` server uses the same browser playback client and the
public Omni endpoint. It provides fictional Lantern Desk facts inline, asks
for team size and reminder needs, then saves one confirmed enquiry to a local
file. It does not contact a person, book an appointment, or use a carrier.
This exercises inline context; it does not qualify indexed knowledge retrieval
or the separately hosted widget.

The [18 November 2026 result](https://pyai.com/demos/website-enquiry/result.json)
and [recorded conversation](https://pyai.com/demos/website-enquiry/website-audio.webm)
retain the evidence and limitations. The initial live test failed because native
tool arguments were JSON text; both that representation and object-valued
arguments now pass strict backend validation. The successful run saved one
enquiry and stopped scheduled playback on interruption. This uses the server's
default voice and records its acknowledgement; it does not promise selection
of a voice merely because it appears in the catalog.

Use Node 22 or newer. No server dependencies are needed for this mode. In a
private `.env`, set `PYAI_API_KEY`, the matching `PYAI_PROJECT_ID`, and a random
`DEMO_PASSWORD` of at least 24 characters. Do not commit that file. Run:

```sh
node --env-file=.env demo.mjs
```

Open `http://127.0.0.1:8787`, sign in with username `demo` and your demo password,
and start the microphone. The server binds only to loopback, rejects missing
or wrong origins, checks the exact active test project and non-credit-gated
identity, and allows one session attempt per process. The browser closes after
three minutes. The short-lived token's expiry limits admission; it is not a
server-enforced session-duration or monetary cap. This is a local test policy,
not production authentication or account-wide cost enforcement.

1. Ask: “What does Lantern Desk do? Can it help with appointment reminders?”
2. Say: “There are four people on our team, and yes, we need appointment reminders.”
3. Confirm: “Yes, please save that synthetic enquiry now.”
4. During the reply, interrupt: “Wait, stop. Tell me only how many people are on our team.”

Check `demo-results/enquiry.json` for exactly one receipt with `team_size: 4`
and `needs_reminders: true`. A success response is sent only after that file
is written. Repeated delivery of the same action returns the same receipt;
a different action is rejected. Lost responses are reported as uncertain and
never retried automatically. Keep the receipt while investigating a failure;
the server refuses to overwrite it on a later run.

The API key stays on the backend. The browser receives only the origin-locked
Omni token. The action executor accepts only the fictional enquiry schema.
This demo is not an authorization pattern for real customer writes: an
authenticated visitor controls browser messages, so a production backend must
independently authorize each business action.

Run the non-audio regression tests with `node --test *.test.mjs`. These cover
wrong origin, missing authentication, wrong project, gated/exhausted credit,
duplicate actions, uncertain responses, and playback cancellation. Mock credit
failures do not establish actual account billing behavior.

`measure.mjs` exports an explicitly invoked measurement function: it validates
the same test identity, issues at most 46 short requests with no retries, and
preserves each result or failure. `benchmark()` makes 21 requests per language:
one first observation and 20 subsequent observations using repeated text.
It measures client request-start to first nonempty PCM payload, including
network and admission. It does not measure server-only processing, a controlled
cold start, speaker audibility, or production tail latency. English uses
`stock_aria_en` (Natural); Hindi uses `stock_ananya_hi` (Standard), so the results
are not a matched model comparison.

It ships **two supported web patterns**, switchable with one env var
(`CONNECT_MODE`):

**`direct` (preferred, default), ephemeral session token.** The browser asks
this server for a short-lived, origin-locked **session token**, then opens the
Omni WebSocket **directly** to PyAI. Your server stays out of the audio path.

```
browser ──POST /session──▶ this server ──POST /v1/omni/sessions (Bearer pyai_live_)──▶ PyAI
browser ──wss /v1/omni (pyai-key.<ephemeral token>)─────────────────────────────────▶ PyAI Omni
   (mic + speaker)                ▲                                                       │
                                  └────────── POST /kb { session_label, query } ◀─────────┘
                                               (engine → your kb_endpoint, per turn)
```

**`broker` (fallback), relay through your server.** The browser opens a
WebSocket to *your* `/voice`, and your server relays audio + events to Omni with
its key. Heavier (your server is in the media path), but the right choice when
you also want to inspect or transform the stream.

```
browser ──ws /voice──▶ this server ──wss /v1/omni (pyai-key.<key>)──▶ PyAI Omni
```

## Why you can't just put a key in the page

You **cannot** put a usable *long-lived* Omni credential in a public web page:

- A `pyai_live_` key in the browser has full project scope and would be scraped
  within minutes, never ship a live key to a web page.
- PyAI **publishable tokens** (the browser-safe TTS kind) are scope-locked to
  `speak:synthesize`, realtime/`omni:session` is **never** granted to them.

The fix is the public/private split done right for realtime: your server holds
the secret key and **mints an ephemeral session token** (`POST /v1/omni/sessions`)
that is scope-locked to `omni:session`, locked to your origin, single-session
(`concurrency: 1`), and expires in ~60 s. That token is safe to hand the page, this is `CONNECT_MODE=direct`. See
[`docs/OMNI_EPHEMERAL_SESSION_TOKENS.md`](../../docs/OMNI_EPHEMERAL_SESSION_TOKENS.md).
The broker remains available for when you want to sit in the media path.

## Do I need to "create" an Omni agent first? No.

The session is authorized by your key's **org**, there is nothing to create.
The optional `session_label` is just an **opaque tag**: PyAI keeps zero
per-session profile state and runs no registry. We pass
`pyai-site-concierge` so we can recognize the session in our `kb_endpoint`, but
you can omit it entirely. The agent's behavior (voice, persona, knowledge) is
supplied **per session** in the `configure` frame, see `src/omni-session.js`.

## How grounding works

Omni is stateless on PyAI, so knowledge is **customer-hosted**. Each turn the
engine POSTs `{ session_label, query }` to the `kb_endpoint` we declared in
`configure`, authed with our `kb_token`. We answer from an in-memory PyAI
knowledge base (`src/knowledge.js`) with a trivial keyword retriever, the call
has a hard **~300 ms, fail-open** budget, so it must be fast and never block the
turn. **This callback comes from PyAI's infrastructure, not the browser**, so
`/kb` must be reachable from the public internet (tunnel it in local dev).

## Run it

```bash
cp .env.example .env       # then edit: PYAI_API_KEY is required
npm install
npm start                  # http://localhost:8787
```

Open http://localhost:8787, click **Talk to PyAI**, allow the mic, and ask
"What's Omni?" or "How much does it cost?".

### Turning on live grounding (recommended)

`/kb` must be publicly reachable by the PyAI engine. On a hosted deploy this is
automatic (the server derives `KB_PUBLIC_URL` from the platform's public URL). In
**local** dev, tunnel it:

```bash
ngrok http 8787
# then in .env:
KB_PUBLIC_URL=https://<your-subdomain>.ngrok.app/kb
KB_TOKEN=$(openssl rand -hex 32)
```

Restart. Without `KB_PUBLIC_URL` + `KB_TOKEN` the agent still answers from its
persona, but with no live per-turn retrieval.

## Configuration (`.env`)

| Var | Required | Purpose |
|---|---|---|
| `PYAI_API_KEY` | yes | `pyai_live_`/`pyai_test_` key with `omni:session`. **Server-side only.** |
| `PYAI_SESSION_LABEL` | no | Optional opaque session tag (echoed to `/kb`). Default `pyai-site-concierge`. |
| `PYAI_VOICE` | no | A `voice_id` from `GET /v1/voices`. Omit for the default voice. |
| `PYAI_BASE_URL` | no | Override the API base (testing). Default `https://api.pyai.com`. |
| `PORT` | no | This server's port. Default `8787`. |
| `KB_PUBLIC_URL` | no | Public https URL of `/kb` the engine calls for grounding. Auto-derived from `RENDER_EXTERNAL_URL`/`PUBLIC_URL` on cloud hosts, so a one-click deploy needs no manual value. |
| `KB_TOKEN` | no | Bearer the engine must present to `/kb`. |
| `CONNECT_MODE` | no | `direct` (mint a token, browser connects to PyAI; default) or `broker` (relay through this server). |
| `SESSION_TTL_SECONDS` | no | Lifetime of a minted session token (direct mode). Default `60`, max `600`. |
| `ALLOWED_ORIGINS` | no | Comma-separated browser origins. Locks the minted token's origin (direct) and gates `/voice` (broker). Empty = any (dev only). |
| `MAX_CONCURRENT_SESSIONS` | no | Cap on live broker sessions (broker mode). Default `25`. |

> **Origins matter in direct mode.** The minted token is locked to an origin.
> Set `ALLOWED_ORIGINS=https://pyai.com` in production; with it empty (local
> dev) the server falls back to the request `Origin`/localhost.

## Files

| File | What it does |
|---|---|
| `server.js` | Fastify app: serves the widget, mints session tokens at `/session` (direct), brokers `/voice` ↔ Omni (broker), hosts `/kb`. |
| `src/omni-session.js` | One server-side Omni session (broker mode only): connect, `configure` frame, PCM + event relay. |
| `src/knowledge.js` | The PyAI knowledge base + fast keyword retriever (the `/kb` brain). |
| `src/persona.js` | The concierge persona sent in `configure`. |
| `public/` | The "Talk to PyAI" widget: mic capture → PCM16@24k, agent playback, barge-in. |

The browser uses one resumed audio graph for capture and playback. During the
turn-0 greeting it sends real-time digital silence instead of microphone or
speaker energy until the playback queue drains, then restores microphone audio.
Later replies retain normal barge-in after a short echo-cancellation warm-up.

Both connection modes request playback tracking and wait for the server to
acknowledge support. Each naturally completed playback chunk reports its reply,
segment and source sample count. Interruptions invalidate queued callbacks before
stopping audio, including after generation has finished. Older servers continue
without playback receipts. A backlog above ten seconds ends the call with a
visible error rather than silently discarding speech.

## Wiring it into the real pyai.com

This standalone server is the reference. To embed in the marketing site, host
this service (Cloud Run) and set `ALLOWED_ORIGINS=https://pyai.com`. In the
default `direct` mode the front-end only needs your `/session` + `/kb` endpoints
reachable; the audio socket goes straight to PyAI, so the service carries no
media traffic and scales trivially. Lock `/session` down for a public page
(session cookie / CAPTCHA / rate limit) so it can't be used as a free token
faucet. The widget itself is ~200 lines of vanilla JS you can port into a React
component.

## Notes & caveats

- **Audio format is load-bearing.** Omni speaks PCM16 LE at 24 kHz. Browsers may
  ignore the requested `AudioContext` rate, so the client resamples capture from
  the context's actual rate before sending it.
- **Protect turn-0 audio.** Browser echo cancellation is not a startup gate.
  Buffer server PCM until playback is ready, keep microphone/self-audio out of
  the uplink through the opening drain, and rearm it for later barge-in.
- **Exact event/frame names.** Transcript/barge-in JSON field names aren't fully
  byte-pinned across the docs; `src/omni-session.js` and `public/app.js` accept
  the documented spellings and ignore unknown frames (forward-compatible).
- **Cost.** Omni bills `omni.minutes` at $0.05/min per live session. The
  concurrency cap is your blast-radius guard for a public page.

Native `0x02` transcripts are literal caller text, including braces or JSON-shaped
speech. Assistant text comes from the validated `0x03` transcript event. The
browser uses this native format. A custom broker connecting to an older JSON
transcript transport must explicitly set `OmniSession`'s
`transcriptFormat: "legacy-json"`; content never selects the format or role.
