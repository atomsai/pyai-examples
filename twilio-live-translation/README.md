# Two-human Live Translation over Twilio

This bounded test host pairs two independent Twilio browser calls with one PyAI
Live Translation session. A third private browser endpoint replaces the agent
inside that same session. It reuses `InterpretationRoom`,
`TwilioInterpretationTransport`, and the SDK's signature-bound stream admission.
No phone-number routing is changed. Browser calls still use real Twilio media
and incur usage.

The host is an implementation candidate. Offline tests and the SDK's synthetic
interpreter test do not establish live carrier acceptance or speech quality.

## Run the candidate

Build `sdk/twilio` from this PR before installing this example. Its new
interpretation exports require the upcoming SDK release; an older published
package cannot run this host. In the monorepo:

```bash
cd sdk/twilio
npm ci
npm run build
cd ../../examples/twilio-live-translation
npm install
```

After SDK 0.4.4 and the public `pyai-examples` mirror are published, a public
clone installs directly with `npm install` from this example folder. Its
dependencies resolve from npm; it does not contain the platform SDK source or
the monorepo lockfile. Use `Dockerfile.public` with this folder as build context.
The original `Dockerfile` uses the platform monorepo as context and builds the
candidate SDK from source.

Use an isolated TwiML application with its Voice URL set to
`https://<test-host>/twilio/voice` (POST). Use a dedicated short-lived Twilio API
key to sign browser tokens. The application grants outgoing browser connections
only; the host accepts only its three server-generated participant identities
and single-use join grants. It does not accept a phone number to dial.

Mount the values listed in `.env.example` through the runtime's secret store.
The PyAI key must have `interpret:session` and live project access. Keep the
Twilio auth token, API key secret, PyAI key and operator token on the server.
Use a single instance, zero minimum instances, 512 MiB RAM and a maximum request
timeout of 30 minutes. Keep the configured public origin fixed; the server never
trusts forwarded host headers for signature validation.

Set `TEST_DEADLINE` to one fixed UTC time within 30 minutes. The process accepts
at most two sequential conversations, each with an eight-minute lifetime, and
applies a carrier-side time limit before returning stream TwiML. Configure an
independent supervisor to end all recorded owned calls, revoke the dedicated
Twilio API key and application, verify private journal exports, and remove the
dedicated host at the original deadline. A process restart must not restart the
supervisor's clock or session budget.

```bash
node --env-file=.env server.mjs
```

`JOURNAL_BUCKET` must be private and writable by the host's existing cloud
identity. Records use immutable objects beneath `JOURNAL_PREFIX`, with source
and translation text, session/participant/call identities, gates and transfer
events. PCM and per-chunk audio metadata are omitted. Failed persistence closes
the conversation. Preserve exported object generations and SHA-256 readbacks
before cleaning up; do not treat process logs as transcript storage.

## Operator flow

The following are **this example server's routes**, not public PyAI API routes.
Send `Authorization: Bearer <operator-token>` from your trusted controller:

1. `POST /rooms` with
   `{"language":"hi","customerVoice":"<Hindi voice ID>","agentVoice":"<English voice ID>"}`.
   Discover real voice IDs from PyAI's current catalog; the example does not
   invent defaults. Use `pa` and a Punjabi voice for the second conversation.
2. Open the returned customer and agent links on separate devices, use
   headphones and select **Join call**. Links contain short-lived single-use
   capabilities in their fragments. Do not put them in public tickets or logs.
3. Read `GET /room` for the joined source/translation and call events. Speak in
   both directions. Normal recognition streams continuously; `POST /commit`
   with `{"leg":"customer"}` is available for an explicit-boundary measurement
   and must be labelled separately from natural streaming latency.
4. Open the replacement-agent link only when the current room is connected.
   Require both-leg clears, a new participant revision, the old call's terminal
   state and fresh translated speech to the replacement. Late old marks must
   never acknowledge replacement playback.
5. `POST /end`; require `cleanup: "calls_terminal_verified"`, then run Punjabi.
   Any uncertain cleanup blocks the next conversation.

Keep echo injection distinct from human speech. Confirm the listening leg's
input is discarded during translated playback and the 250 ms tail; do not
infer acoustic cancellation from headphones or saved audio. Carrier `mark`
receipts establish its playback queue boundary, not physical speaker audibility.
Twilio's fresh mark following `clear` remains a candidate flush barrier until
the real carrier test proves the behavior.

This is a private two-conversation acceptance host. It does not claim production
capacity, JustCall integration, PSTN qualification or human translation quality.
