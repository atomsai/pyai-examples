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
