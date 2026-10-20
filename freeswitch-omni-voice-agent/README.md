# FreeSWITCH → PyAI Omni voice agent (SIP, linear PCM)

Bridge a **FreeSWITCH** call to a [PyAI Omni](https://pyai.com/models/omni) agent
over `mod_audio_stream`. This is the path for **SIP-trunk** customers who bring
their own carrier (vs. the [Twilio example](../twilio-omni-voice-agent) for
Programmable Voice).

Run FreeSWITCH's caller-audio stream at **L16 / 16 kHz** and connect Omni at
**`rate=16000`**. That parameter describes caller input; Omni returns **24 kHz
PCM16** for 16/24 kHz input and **8 kHz PCM16** for 8 kHz input. The bridge reads
both native `hello.audio_in` and `hello.audio_out` before playback, rejects
contradictory declarations or incomplete PCM16 samples, and labels playback
with the declared output sample rate. It
preserves audio bytes; FreeSWITCH or your media adapter must convert the output
to the call's playback rate when those rates differ.

```
   SIP caller
      │
      ▼
  FreeSWITCH ──mod_audio_stream (L16 mono @ 16k, WebSocket)──▶ this bridge
      ▲                                                          │
      │  agent audio (played back via the module)                │  wss://api.pyai.com/v1/omni
      └──────────────────────────────────────────────────────── │   ?format=pcm16&rate=16000
                                                                  ▼
                                                            PyAI Omni
```

> **What's verified vs. what to match.** The **Omni side** here is exact (connect
> URL, subprotocol auth, `configure` frame, PCM16 framing, `flush`/barge events, > see `docs/OMNI_PROTOCOL_V2.md`). The **FreeSWITCH side** uses the
> [`mod_audio_stream`](https://github.com/amigniter/mod_audio_stream) JSON
> protocol (`streamAudio` to play, `killAudio` to barge); its exact framing
> varies by module build, so the FreeSWITCH-facing bits live in one clearly
> marked adapter (`FS_PROTOCOL` in `server.js`), match it to your module.

## 1. FreeSWITCH side

Load the module and start a stream from the dialplan. Run the channel at 16 kHz
so caller input is L16/16k (matches Omni's input `rate=16000`):

```xml
<!-- dialplan/default/omni.xml -->
<extension name="omni-agent">
  <condition field="destination_number" expression="^(omni|\d+)$">
    <action application="answer"/>
    <!-- 16 kHz internally so the audio fork is L16/16k -->
    <action application="set" data="sample_rate=16000"/>
    <!-- Start the bidirectional WebSocket stream to the bridge.
         args: <uuid> start <wss-url> <mix> <rate> [metadata-json] -->
    <action application="set" data="STREAM_METADATA={\"uuid\":\"${uuid}\",\"did\":\"${destination_number}\"}"/>
    <action application="audio_stream"
            data="${uuid} start ws://BRIDGE_HOST:8080/fs mono 16k ${STREAM_METADATA}"/>
    <action application="park"/>
  </condition>
</extension>
```

Load `mod_audio_stream` in `modules.conf.xml` (or `load mod_audio_stream` at the
CLI). Use `wss://` + a public host in production; `ws://` is fine on a private
network between FreeSWITCH and the bridge.

## 2. Run the bridge

```bash
cp .env.example .env        # then edit PYAI_API_KEY (a pyai_test_ key is fine)
npm install
npm start                   # ws://0.0.0.0:8080/fs
```

Point `audio_stream` at `ws://<bridge-host>:8080/fs`, place a call to the
extension, and you should hear the agent within ~1 s. Talk over it to confirm
barge-in cuts it off.

## 3. Barge-in, transfer, DTMF

| Feature | Omni → bridge | bridge → FreeSWITCH |
|---|---|---|
| **Barge-in / cancelled reply** | `flush`, `barge_in`, `reply_interrupted`, or `reply_failed` | `{"type":"killAudio"}` to discard queued speech |
| **Transfer to human** | `transfer_to_human` event | ESL `uuid_transfer <uuid> <dest>` (needs the channel `uuid` from the start metadata) |
| **DTMF** |, | FreeSWITCH `DTMF` channel events → forward as `{"type":"dtmf","digit":"5"}` to Omni |

Transfer and DTMF use the FreeSWITCH **Event Socket (ESL)**. The bridge captures
the channel `uuid` from the stream's start metadata (above) so it can issue
`uuid_transfer` / `uuid_break`; wire your ESL client where marked in `server.js`.

## Notes

- **Input and output rates:** the bridge does not resample. A 16 kHz caller
  stream receives 24 kHz agent audio, passed to `streamAudio` as
  `sampleRate: 24000`. Verify that your module build accepts this rate and
  converts it for the call; otherwise add a real resampler in `FS_PROTOCOL`.
  Changing the label to 16000 without conversion changes speed and pitch.
  For `rate=8000`, both Omni directions use 8 kHz PCM16; FreeSWITCH still owns
  any carrier codec conversion.
- **Playback acknowledgement:** this bridge does not request `playback_ack`
  or send `playback_progress`. `streamAudio` delivery is not evidence that the
  caller heard the audio; a real downstream played-sample signal is required
  before enabling acknowledgement mode.
- **Auth:** the bridge holds the `pyai_*` key server-side and connects to Omni
  with it (subprotocol `pyai-key.<key>`). The key never touches the carrier or
  the caller.
- **Stateless Omni:** there's nothing to create first, the agent's behavior
  (voice, persona, knowledge) travels in the `configure` frame on connect. See
  `src/persona` inline in `server.js`.
- This example is **not** in the nightly live-smoke (it needs a FreeSWITCH box);
  the Omni client logic mirrors the verified [Twilio bridge](../twilio-omni-voice-agent).

Run `npm test` for the offline transport-handler checks. They use opaque bytes,
fake sockets, and transcript frames captured from the native engine methods.
The bridge accepts caller UTF-8 deltas and the assistant synthesis-text advisory;
neither establishes audible FreeSWITCH playback or generates a playback receipt.
Caller braces and JSON-looking content always remain user text. Set
`OMNI_LEGACY_JSON_TRANSCRIPTS=1` only when connecting to a known older bridge
that sends JSON transcript objects; native Omni leaves this option unset.
