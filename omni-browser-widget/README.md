# Hosted Omni browser widget v12

v12 is the current runtime. v1-v11 remain immutable for existing embeds. It
keeps the protected opening and browser-valid protocol close, handles the
playback-position advisory, and corrects interrupted assistant transcripts.

Publish a website widget from **Agents → Website & phone**, then paste one
script tag:

```html
<script src="https://cdn.pyai.com/widget/v12/pyai-widget.js"
  data-widget="wdgt_public_x" async></script>
```

The page contains no API key and needs no customer token endpoint. The opaque
widget id resolves safe presentation/profile data, and every voice start asks
PyAI for a one-session, short-lived, origin-locked `omni:session` token.

The runtime connects only to native Omni at `/v1/omni` with `session_label`.
Server messages must use binary native framing:

- `0x01` + PCM16 agent audio
- `0x02` + `{ "event":"transcript", "role", "text", "final" }`
- `0x03` + JSON control keyed on `event`

Text WebSocket frames and unknown binary tags are rejected. `0x03` also
accepts strictly validated native assistant transcripts as described below. The sole type-keyed server exception is the validated
legacy `audio_position` advisory, normalized to canonical event semantics.
Every other type-keyed server control remains invalid. Client audio/control remains
`0x01` PCM16 and `0x03` JSON keyed on `type`.

v12 protects the turn-0 consent line and greeting from browser self-barge:
it buffers server PCM until the shared playback graph is running, sends
real-time digital silence instead of microphone or speaker energy through the
opening drain, and restores normal caller barge-in after a short warm-up on
later replies.

Protocol violations close once with application-private code `4002`; all
reasons are short stable ASCII values within the browser's 123-byte limit.

## Local smoke

```bash
cp .env.example .env
npm test
npm start
```

Open <http://localhost:8080>. Replace the placeholder public id and local API
origin in `public/index.html` with a published development widget setup.

`server.js` is static-only. Production pages load the asset from
`cdn.pyai.com`; PyAI owns the public config and ephemeral-session broker.

## Public runtime

The embed accepts:

- `data-widget`, required hosted widget public id
- `data-api-origin`, localhost-only test override
- `data-referral`, optional valid PyAI referral code

Presentation, consent, action, and agent behavior come from the published
widget record. The runtime exposes `window.PyAIWidget.open/close/toggle/destroy`
and emits versioned `pyai:widget:*` lifecycle, transcript, state, and error
events.

## Interrupted replies

v12 adds native assistant transcript controls on `0x03`, alongside the
existing `0x02` caller deltas and structured transcripts. Assistant controls
must contain exactly `event`, `role: "assistant"`, `text`, and boolean `final`.
Malformed transcript controls and arbitrary type-keyed controls are rejected.

On `assistant_interrupted`, the displayed reply is reduced to the server's
reported spoken prefix; a zero-length prefix removes that assistant row.
Caller messages remain visible, cancelled tails are ignored, and the next
`turn_begin` restores normal assistant text. This is a server estimate, not a
measurement of what reached the listener. The current event has no turn ID
and caps its prefix at 500 code points, so arbitrarily delayed ambiguous
corrections cannot be resolved by the browser.

The **Publish widget CDN v12** workflow verifies the exact source hash and refuses to overwrite an
existing v12 object. v1-v11 stay immutable.
