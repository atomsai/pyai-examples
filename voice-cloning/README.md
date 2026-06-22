# Voice cloning end-to-end: enroll → poll → speak → use in Omni

Clone a real voice from a reference clip and use it everywhere a stock voice
works — in [Speak](https://pyai.com/models/speak) (`POST /v1/audio/speech`) and
as the `voice_id` of an [Omni](https://pyai.com/models/omni) agent.

```
reference.wav ──POST /v1/voice/clones (name + file)──▶ { id: "voice_…", status: "pending" }
                       poll GET /v1/voice/clones ──────▶ status: "ready"
  voice_…  ──▶ POST /v1/audio/speech (voice: "voice_…") ─────────▶ cloned.wav
  voice_…  ──▶ Omni  configure { voice_id: "voice_…" } ──────────▶ a live agent in that voice
```

This example runs the whole loop with **only a key**: it synthesizes a ~12 s
reference clip (genuine 24 kHz, so it clears the bandwidth gate), enrolls it,
polls until `ready`, speaks a line in the cloned voice, and then **deletes the
clone** so repeated runs don't pile up. For a real clone, point it at a real
person's recording with `REFERENCE_AUDIO=./me.wav` (and set `KEEP_CLONE=1`).

## Run it

```bash
cp .env.example .env        # then edit PYAI_API_KEY (needs the voice:clone scope)
npm start                   # writes reference.wav + cloned.wav, then cleans up

# Use your own reference clip (recommended for a real clone):
REFERENCE_AUDIO=./me.wav KEEP_CLONE=1 npm start
```

Output:

```
[1/4] reference: synthesized a 12.0s clip → reference.wav (24 kHz)
[2/4] enroll:    POST /v1/voice/clones → voice_abc123 (status: pending)
[3/4] ready:     voice_abc123 became ready in 7.2s
[4/4] speak:     wrote cloned.wav in the cloned voice
cleanup:         deleted voice_abc123 (set KEEP_CLONE=1 to keep it)
```

## Reference-clip requirements (read this before you debug a bad clone)

The engine enforces a **genuine ≥24 kHz full-band** gate and wants enough
material. A clip that *looks* like 24 kHz but was upsampled from a phone line is
**rejected** — the gate measures real spectral content, not the file header.

| What you see | Likely cause | Fix |
|---|---|---|
| Enroll `status: failed`, or a thin/muffled clone | Clip is band-limited — recorded at 8 kHz (phone/PSTN) or **upsampled** to 24 kHz | Record at **≥24 kHz full-band** with a real mic; don't resample an 8 kHz file up |
| `status: failed` / poor likeness | Clip too **short** | Give **≥10 s** (6–15 s of clean, continuous speech is the sweet spot) |
| Muddy / averaged voice | Background noise, music, or **multiple speakers** | One speaker, quiet room, no music bed |
| Likeness off for non-English | **EN-only today** | Use English reference + text for now |
| `403 forbidden` | Key lacks the **`voice:clone`** scope | Add the scope to the key in the console |
| `401 unauthorized` | Missing/invalid key | Re-copy the key |

> **Heads-up:** clones are **durable, billed assets** (synthesis bills `voice`
> minutes). This example deletes the clone it creates; in your own code, list
> with `GET /v1/voice/clones` and delete with `DELETE /v1/voice/clones/{id}`.
> Because they hold cost and create durable state, publishable/browser tokens are
> **never** granted `voice:clone` — mint clones from a server-side key only.

## Use the clone in Omni

The cloned `id` is a `voice_id` anywhere a stock voice works. In a realtime
session, set it in the `configure` frame:

```js
ws.send(JSON.stringify({ type: "configure", voice_id: "voice_abc123", persona: "…" }));
```

See [`pyai-site-voice-concierge`](../pyai-site-voice-concierge) for a full
browser agent (set `PYAI_VOICE=voice_abc123`).

## The field-name gotcha

A **clone** response returns the voice as **`id`**; a **designed** voice
(`POST /v1/voice/design`, synthetic-from-text) returns **`voice_id`**. If you
support both, read the right field per surface. This example uses cloning, so it
reads `id`.

## curl, if you prefer no SDK

```bash
# Enroll (multipart): name + a reference clip ≥10s, genuine ≥24 kHz.
curl -X POST https://api.pyai.com/v1/voice/clones \
  -H "Authorization: Bearer $PYAI_API_KEY" \
  -F name="Acme Front Desk" -F file=@reference.wav
# -> 201 { "id": "voice_abc123", "object": "voice", "name": "...", "status": "pending" }

# Poll until ready, then synthesize in the cloned voice.
curl https://api.pyai.com/v1/voice/clones -H "Authorization: Bearer $PYAI_API_KEY"
curl https://api.pyai.com/v1/audio/speech \
  -H "Authorization: Bearer $PYAI_API_KEY" -H "Content-Type: application/json" \
  -d '{"input":"Hello in my own voice.","voice":"voice_abc123"}' --output cloned.wav
```

Uses only the built-in `fetch`/`FormData` (Node ≥ 22) — see `index.mjs`.
