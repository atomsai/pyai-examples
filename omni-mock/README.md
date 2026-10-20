# omni-mock, build your Omni client before you have a key

A tiny **offline server that speaks the [PyAI Omni](https://docs.pyai.com)
wire protocol** ([v2](https://docs.pyai.com/realtime/omni-protocol)). Point your
real Omni client at it and develop the hard parts, mic capture, PCM16 framing,
playback, barge-in, event parsing, with **zero cost and no API key**.

```
your client ──ws──▶ ws://localhost:8787/v1/omni   (instead of wss://api.pyai.com/v1/omni)
```

It is **not a model**: the "agent" answers with a short tone and a canned
transcript. The point is the *protocol*, not the brain, so your integration is
correct on the day you swap in the real key.

## Run it

```bash
cp .env.example .env
npm install
npm start            # ws://localhost:8787/v1/omni
```

Then change your client's base URL from `wss://api.pyai.com` to
`ws://localhost:8787` and run it. You'll get the real handshake, binary PCM16
both ways, transcripts, barge-in, and DTMF.

## What it implements (per `OMNI_PROTOCOL_V2.md`)

- **Binary, type-tagged frames** (the engine's real framing): every server →
  client frame carries a first-byte tag, **`0x01` audio · `0x02` transcript ·
  `0x03` control/event JSON**. **Demux on the first byte.** Client control frames
  (`configure`, `dtmf`) are `0x03`-prefixed too. A client that treats all binary
  as audio plays the control/transcript frames as a glitch and misses every
  event, the same way it fails against prod.
- **Native transcripts:** caller `0x02` frames contain plain UTF-8 text deltas.
  Assistant synthesis text is a `0x03` JSON advisory with exactly
  `{"event":"transcript","role":"assistant","text":"…","final":true}`.
  Neither transcript proves that audio has played.
- **Handshake:** `hello` → `session_started` (0x03), then `configured` (0x03)
  after your `configure` frame. Server frames use `event`; client frames use `type`.
- **Audio:** send `0x01`-prefixed PCM16 at 8000, 16000, or 24000 Hz.
  Output is 8000 Hz for 8000 Hz input, otherwise 24000 Hz, as advertised in
  `hello.audio_out`. The mock replies after a gap in incoming packets.
- **Barge-in:** a new audio packet while the mock is talking emits `flush`
  and stops the tone. This is a packet-driven simulation, not voice detection.
- **DTMF & lifecycle:** `{"type":"dtmf","digit":"5"}` receives
  `dtmf_received`; `{"type":"session_ending"}` closes with `session_end`.
- **Playback receipts:** unsupported here; `configured.playback_ack` is false.
  Test actual rendering and receipt negotiation against a capable server.

## The client-envelope check

Client frames use `type`, for example `{"type":"configure",…}`. The mock
warns and ignores an event-only client envelope so integrations use the
canonical contract. Some engine versions also accept an `event` alias;
this stricter mock check is not a claim that the engine drops that alias.

It warns and ignores audio before `configure`, warns on a missing `persona`,
and rejects unsupported formats and sample rates. Run `npm test` for the
offline handler and native-frame contract checks.

## Limitations (by design)

- No real STT/LLM/TTS, replies are canned. Use it for **protocol** correctness,
  not response quality.
- No auth: any subprotocol/key is accepted (it's local). The real edge validates
  `pyai-key.<key>` + the `omni:session` scope.
- Uses `ws`; Node ≥ 22.
