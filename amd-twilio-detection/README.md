# AMD, Twilio drop-in (answering machine detection)

Rip out Twilio AMD with **one line of TwiML**. This tiny, zero-dependency Node
server forks a Twilio call's media to **PyAI AMD**, which tells you *who or what*
answered, human, voicemail, IVR, iPhone/Google **screening**, dead number, with the **reason** it decided.

No carrier change, no new SDK: PyAI speaks Twilio's Media Streams protocol
natively, and the decision carries an `answered_by_twilio` field mapped to
Twilio's exact `AnsweredBy` enum, so your existing routing logic doesn't change.

## What it does

- `GET/POST /twiml`, returns the `<Connect><Stream>` TwiML that points the call's
  media at `wss://api.pyai.com/v1/amd/stream`. Point your Twilio number's Voice
  webhook here.
- `POST /amd-events`, receives the `amd.call.completed` decision PyAI posts once
  it classifies the call.
- On boot it sets the account-default operating point via `POST /v1/amd/config`.

## What to do with each verdict

`server.mjs` implements this in `routeCall()`. The table is the part worth copying.

| `answered_by` (webhook) | do | why |
|---|---|---|
| `human` | connect the agent | |
| `voicemail` | drop a message, waiting for the record tone | talking over the greeting loses the start of your message, and some systems never beep |
| `ivr` | navigate the menu or abandon | **never drop a message** — a phone tree discards it |
| `screening` | engage it | an AI screener (iPhone/Google) is relaying to a person who may still pick up |
| `music` | keep waiting | hold music or ringback; nothing said yet |
| `sit_invalid` | scrub the number | carrier intercept, the number is dead; retrying burns spend and reputation |
| `unknown` + subtype `silence` | retry later | answered but nothing came down the line — don't burn an agent slot on dead air |
| `unknown` | your default | no decisive evidence; see `aggressiveness` below |

**Mind which field you read.** On the **webhook**, `answered_by` carries the machine
*subtype* (`voicemail` / `ivr` / `screening` / `music`). On the event pushed over the
**WebSocket** it carries only the coarse class (`human` / `machine` / `sit_invalid` /
`unknown`). Same field name, different value space — that is why this example routes
off the webhook.

**The mistake this prevents:** treating every `machine` as a voicemail. Three of the
subtypes above are machines, and a message dropped into two of them is simply lost.

### When to expect the decision

Measured over ~1,850 real answered calls: `human` typically ~1.4 s (~3.0 s at the
90th percentile), `machine` ~2.2 s (~3.2 s). There is a hard deadline at 6 s — if
nothing is decisive by then you get a verdict anyway. Size any fallback timer past
6 s rather than past the typical case.

## Run it

```bash
cp .env.example .env      # fill in PYAI_API_KEY + PUBLIC_BASE_URL
npm start
```

You need a public URL Twilio (and PyAI) can reach, e.g. `ngrok http 3000` or
`cloudflared tunnel`, set as `PUBLIC_BASE_URL`. Then set your Twilio number's
**Voice → A call comes in** webhook to `${PUBLIC_BASE_URL}/twiml`.

Get a key with no setup:

```bash
curl -sX POST https://api.pyai.com/v1/sandbox/keys
```

## The one dial: `aggressiveness`

`AMD_AGGRESSIVENESS` (0-1) is the whole tuning surface:

- **0.0-0.25, human-safe (default):** never hang up on a person. For predictive
  dialers with live agents.
- **0.6-1.0, machine-aggressive:** fire `machine` fast, for voicemail-drop bots.

Set it per account (this server calls `POST /v1/amd/config`) or per call (the
TwiML `<Parameter name="aggressiveness">`).

## The decision

```json
{
  "event": "amd.call.completed",
  "call_id": "C_123",
  "org_id": "org_...",
  "session_label": null,
  "status": "completed",
  "answered_by": "voicemail",
  "answered_by_twilio": "machine_start",
  "confidence": 0.96,
  "decision_ms": 720,
  "reason": "machine phrase: 'please leave a message' at 1.2s",
  "created_at": 1786000000000
}
```

On the completed-call record (and this webhook), `answered_by` carries the
machine subtype: `human`, `machine`, `voicemail`, `screening`, `ivr`, `music`,
`sit_invalid` (dead number), `unknown`. The mid-call wire event on the stream
itself carries only the routing class: `human`, `machine`, `sit_invalid`,
`unknown`. Read a decision back later with `GET /v1/amd/calls/{call_id}`.

## Billing

Per **answered** call, no-answers, busies, and failed calls are free. The first
5,000 answered calls each month are free, then $0.004/call; AMD bundled with PyAI
telephony or Omni is included.

## Docs

- Guide: https://docs.pyai.com/guides/amd-answering-machine-detection
- API reference: https://docs.pyai.com/api-reference
- Product: https://pyai.com/models/amd
