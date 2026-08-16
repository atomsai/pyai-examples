# Recap: every finished conversation becomes a `recap.call`

Point Recap at utterances or a recording and get back a typed object: headline,
summary, action items, next steps, talk ratio, and pack fields. No bot to
invite. No DIY LLM pipeline.

```
utterances or audio
        │
        ├─ PUT  /v1/recap/config                 enable Recap
        ├─ POST /v1/recap/calls/{call_id}        utterances, or
        │  POST /v1/transcription/jobs + call_id recording
        └─ GET  /v1/recap/calls/{call_id}     →  recap.record.v1
```

A sandbox key (`POST /v1/sandbox/keys`) already includes `recap:configure` and
`recap:read`, and mints with Recap enabled.

## Run it

```bash
cp .env.example .env        # PYAI_API_KEY: sandbox key is enough
npm start

# Or Recap a recording (Hear job + call_id):
AUDIO_FILE=./call.wav npm start
AUDIO_URL=https://example.com/call.mp3 npm start
```

Default path posts a short two-party support dialog as utterances so the
example runs with one key and no extra audio step. The printed object is the
product:

```
[1/3] config:  Recap enabled (pack sales_outbound)
[2/3] submit:  call_demo_… pending
[3/3] recap:   call_demo_…  complete

  tldr          Customer rescheduled Tuesday to Thursday at 2pm.
  summary       …
  action_items
    - agent: Send a reminder (due today)
```

## Notes

- **Scopes:** `recap:configure` + `recap:read`. Hear recordings also need
  `hear:transcribe` + `transcribe:jobs`.
- **Object:** completed `record.format` is `recap.record.v1`. Read `tldr`,
  `summary`, `action_items`, `next_steps`, `talk_ratio`, `signals`, `fields`.
- **Webhook:** `PUT /v1/recap/config` with `webhook_url` to receive
  `recap.complete` instead of polling.
- Uses only the built-in `fetch`/`FormData` (Node ≥ 22).
