# Two-human Live Translation over Plivo

This private test host pairs two independently controlled Plivo browser calls
with one PyAI Live Translation session. A third browser endpoint replaces the
agent within that same conversation. It reuses `InterpretationRoom`,
`PlivoInterpretationTransport` and signed, single-use stream admission from the
SDK in this repository. The example never returns a Dial element and never
originates a PSTN call or changes a phone number's routing.

This is implementation preparation. Offline tests do not establish real Plivo
playback, call cleanup, translation quality, capacity or production readiness.
Run actual Plivo acceptance only after the Twilio acceptance stage.

## Dedicated carrier setup

In the monorepo, build the local SDK before installing this example:

```bash
cd sdk/twilio
npm ci
npm run build
cd ../../examples/plivo-live-translation
npm ci --ignore-scripts
```

The published `@pyai/twilio@0.4.9` includes the Plivo interpretation exports.
In a public `pyai-examples` clone, the package names that published dependency.
From `plivo-live-translation`, use `npm install --ignore-scripts`
and `npm start`; the public mirror intentionally omits the platform lockfile.
`Dockerfile` uses the full platform monorepo as its cloud build context.
`Dockerfile.public` uses this example directory as its cloud build context
with the published SDK. Keep cloud builds and carrier execution
within the bounds below.

Use one disposable Plivo Application, with its Answer URL set to
`https://<private-host>/plivo/voice` (POST) and Hangup URL set to
`https://<private-host>/plivo/status` (POST). Provision three disposable SIP
endpoints attached only to this application: customer, agent and replacement
agent. Save their actual returned usernames and resource IDs in the operator's
cleanup manifest. Mount the usernames, application ID and existing account
credentials using `.env.example`; keep endpoint passwords out of the browser.
Do not attach an existing telephone number or modify the managed India-only
number and origination policy.

Browser SDK `2.2.21` is packaged with the server. The server requests an opaque,
carrier-signed token from
`POST https://api.plivo.com/v1/Account/{auth_id}/JWT/Token/` for the exact endpoint
username and dedicated application. The token permits outgoing calls only.
It does **not** use locally signed JWTs; Plivo rejects those for registration.
See [Plivo browser authentication](https://docs.plivo.com/docs/voice/sdk/browser/jwt-authentication).

The token's `app` claim selects the dedicated outgoing application. The browser
passes its bare `APPLICATION_ID` as the call's opaque destination marker. This
example requires a 16–32 digit application ID, outside the E.164 phone-number
limit. The SDK sends the marker through its registered `phone.plivo.com` route;
it does not dial the application's public inbound `app.plivo.com` SIP URI.
The signed answer request must name that exact marker, either bare or in its
`phone.plivo.com` SIP form, and include its single-use `X-PH-JoinGrant` capability.
The application returns only an isolated inbound PCM Stream, with a scheduled
Hangup before it. It returns no `<Dial>`, so it creates no PSTN or second SIP leg.
See [Plivo's browser call flow](https://docs.plivo.com/docs/voice/sdk/browser/overview).

The pinned Browser SDK registers JWT users as `<sub>_<iss>`. The host binds that
account-qualified source identity as well as the endpoint's plain identity;
both bare-user and SIP-URI callback forms must still identify the configured
endpoint and account. The requested marker remains the exact dedicated
application ID. Unexpected participants, accounts and destinations are rejected.

The pinned official `plivo@4.79.0` helper validates V3 signatures, including POST
parameters. Answer and status signatures use the configured HTTPS origin.
For WebSocket upgrades this host explicitly configures the SDK's
`signatureProtocol: 'http'` option, matching the carrier's observed canonical
signing URI. This changes only the string validated by the official helper;
the media URL and accepted transport remain encrypted `wss://`. The configured
host and exact one-time path are fixed, with no forwarded-header trust or
alternate-protocol fallback. Nonce replay protection and account/call/stream
bindings remain enforced. The host does not use the streaming server wrapper
that logs credentials. See
[Plivo streaming authentication](https://docs.plivo.com/docs/voice-agents/audio-streaming/concepts/audio-streaming-guide).

## Bounded runtime and cleanup

Use one instance, zero minimum instances, 512 MiB RAM and request timeout at
most 30 minutes. Set `PUBLIC_ORIGIN` to the final HTTPS host and `TEST_DEADLINE`
once to an absolute UTC time within 30 minutes. The process permits two
sequential rooms, each at most eight minutes. The carrier receives a scheduled
Hangup and bounded `streamTimeout` in every accepted answer XML.

Before running, configure an independent supervisor with that same original
deadline and the owned application/endpoint/call IDs. It must terminate only
recorded test CallUUIDs, verify terminal call records, revoke the three
endpoints and disposable application, verify private journal exports and
remove the dedicated host. A restart must not renew its time or session budget.
The server itself never deletes applications or endpoints, and never invokes
the whole-account Hangup API.

`JOURNAL_BUCKET` must be private and writable by the host's existing cloud
identity. The durable journal retains joined source/translation text,
session/participant/call identities, playback/gate/transfer and cleanup events;
it omits PCM and per-chunk audio writes. Failed persistence ends the room.
Preserve GCS object generations and SHA-256 readbacks before cleanup.

```bash
node --env-file=.env server.mjs
```

## Operator flow

These are this example's private server routes, not public PyAI endpoints.
Send `Authorization: Bearer <operator-token>` from the trusted controller:

1. `POST /rooms` with
   `{"language":"hi","customerVoice":"<Hindi voice ID>","agentVoice":"<English voice ID>"}`.
   Use actual current PyAI voice IDs; the example supplies no invented defaults.
2. Open the returned customer and agent links on separate devices. They contain
   single-use join capabilities in URL fragments; keep them private. Select
   **Join call**, use headphones and permit the microphone.
3. Inspect `GET /room` for source and translated text, call identities, echo
   gates and transport diagnostics. Natural recognition streams continuously.
   `POST /commit` with `{"leg":"customer"}` permits separately labelled
   explicit-boundary latency measurements.
4. Open the replacement-agent link only when connected. Verify the same
   interpreter session, changed participant revision, both output queues
   cleared, retired call terminal, and fresh translation to the replacement.
5. `POST /end`; require `cleanup:"calls_terminal_verified"`. Only then create
   the Punjabi room using `language:"pa"` and its actual Punjabi voice.

Plivo uses 16 kHz linear PCM in 20 ms frames. The CLI documents little-endian
PCM16; carrier acceptance must verify a nonzero known waveform before assuming
network byte order. Matching `playedStream` or legacy `played` receipts acknowledge
a current, single-use checkpoint on the same stream. Cancellation invalidates old
checkpoints before `clearAudio` and sends a fresh checkpoint behind the clear.
A sequenced `clearedAudio` or that exact fresh checkpoint completes the barrier;
an uncorrelated legacy zero-sequence clear receipt cannot release it. Received/saved
PCM and sent frames are not playback evidence. See the
[stream protocol](https://www.plivo.com/docs/voice-agents/audio-streaming/concepts/audio-streaming-reference)
and [CLI audio format](https://docs.plivo.com/docs/cli/voice-agent/test-websocket).

The host admits each stream only after the official account-token signature
validates its exact WSS URL and consumes the single-use call/participant/room
permit. Attachment consumes that saved proof once, before the transport is
constructed. The transport verifies the expected call, stream and audio format;
legacy numeric account fields never establish ownership. Missing, expired,
replayed or mismatched admission proofs close the socket. Audio received before
verification completes is dropped.

Inject echo separately from human speech and confirm that gated input, including
the server's 250 ms tail, never reaches recognition or gets replayed later.
Queue receipts establish carrier playback progress, not audibility at a
physical speaker. No ten-call capacity, JustCall integration or self-hosted
inference claim follows from this carrier host.
