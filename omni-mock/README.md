# omni-mock — build your Omni client before you have a key

A tiny **offline server that speaks the [PyAI Omni](https://docs.pyai.com)
wire protocol** ([v2](https://docs.pyai.com/realtime/omni-protocol)). Point your
real Omni client at it and develop the hard parts — mic capture, PCM16 framing,
playback, barge-in, event parsing — with **zero cost and no API key**.

```
your client ──ws──▶ ws://localhost:8787/v1/omni   (instead of wss://api.pyai.com/v1/omni)
```

It is **not a model**: the "agent" answers with a short tone and a canned
transcript. The point is the *protocol*, not the brain — so your integration is
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
  client frame carries a first-byte tag — **`0x01` audio · `0x02` transcript ·
  `0x03` control/event JSON**. **Demux on the first byte.** Client control frames
  (`configure`, `dtmf`) are `0x03`-prefixed too. A client that treats all binary
  as audio plays the control/transcript frames as a glitch and misses every
  event — the same way it fails against prod.
- **Handshake:** `hello` → `session_started` (0x03), then a `config_ack` (0x03)
  after your `configure` frame (server frames keyed on `event`).
- **Audio:** send binary PCM16 at the `?rate=` you connect with; after a short
  silence the mock "replies" with a tone (streamed in 150 ms chunks).
- **Barge-in:** send audio while the mock is talking and it emits `flush` and
  stops — exactly the event your client must handle.
- **DTMF & lifecycle:** `{"type":"dtmf","digit":"5"}` is echoed; `{"type":"session_ending"}` closes with `session_end`.

## The conformance check (why this beats a dumb echo)

The #1 Omni bug is sending an **event-keyed** configure
(`{"event":"configure",…}`) instead of a **type-keyed** one
(`{"type":"configure",…}`). Against production this is silent: the transparent
gateway ACKs it, the engine drops your `persona`, and you get a clean handshake
with **zero turns and no error**. omni-mock catches it and tells you:

```
[BUG] client sent event-keyed frame {"event":"configure"} — real engine drops this
silently. Use {"type":"configure"}.
```

It also warns on audio-before-`configure`, a missing `persona`, and a non-`pcm16`
format — the things that "work" in a mock but bite you in prod.

## Limitations (by design)

- No real STT/LLM/TTS — replies are canned. Use it for **protocol** correctness,
  not response quality.
- No auth: any subprotocol/key is accepted (it's local). The real edge validates
  `pyai-key.<key>` + the `omni:session` scope.
- Uses `ws`; Node ≥ 22.
