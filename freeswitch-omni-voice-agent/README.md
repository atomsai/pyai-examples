# FreeSWITCH → PyAI Omni voice agent (SIP, no transcode)

Bridge a **FreeSWITCH** call to a [PyAI Omni](https://pyai.com/models/omni) agent
over `mod_audio_stream`. This is the path for **SIP-trunk** customers who bring
their own carrier (vs. the [Twilio example](../twilio-omni-voice-agent) for
Programmable Voice).

The key win: run FreeSWITCH at **L16 / 16 kHz** and connect Omni at
**`rate=16000`** and there is **no μ-law, no resampling** anywhere — linear PCM16
flows straight through both ways.

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
> URL, subprotocol auth, `configure` frame, PCM16 framing, `flush`/barge events —
> see `docs/OMNI_PROTOCOL_V2.md`). The **FreeSWITCH side** uses the
> [`mod_audio_stream`](https://github.com/amigniter/mod_audio_stream) JSON
> protocol (`streamAudio` to play, `killAudio` to barge); its exact framing
> varies by module build, so the FreeSWITCH-facing bits live in one clearly
> marked adapter (`FS_PROTOCOL` in `server.js`) — match it to your module.

## 1. FreeSWITCH side

Load the module and start a stream from the dialplan. Run the channel at 16 kHz
so the fork is L16/16k (matches Omni's `rate=16000` — zero conversion):

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
| **Barge-in** | `flush` event (caller started talking) | `{"type":"killAudio"}` to stop playback immediately |
| **Transfer to human** | `transfer_to_human` event | ESL `uuid_transfer <uuid> <dest>` (needs the channel `uuid` from the start metadata) |
| **DTMF** | — | FreeSWITCH `DTMF` channel events → forward as `{"type":"dtmf","digit":"5"}` to Omni |

Transfer and DTMF use the FreeSWITCH **Event Socket (ESL)**. The bridge captures
the channel `uuid` from the stream's start metadata (above) so it can issue
`uuid_transfer` / `uuid_break`; wire your ESL client where marked in `server.js`.

## Notes

- **Why no transcode:** Omni at `rate=16000` speaks the same L16/16k FreeSWITCH
  forks. For an 8 kHz G.711 leg use `rate=8000` instead — then the only step is
  μ-law companding, still no resampling.
- **Auth:** the bridge holds the `pyai_*` key server-side and connects to Omni
  with it (subprotocol `pyai-key.<key>`). The key never touches the carrier or
  the caller.
- **Stateless Omni:** there's nothing to create first — the agent's behavior
  (voice, persona, knowledge) travels in the `configure` frame on connect. See
  `src/persona` inline in `server.js`.
- This example is **not** in the nightly live-smoke (it needs a FreeSWITCH box);
  the Omni client logic mirrors the verified [Twilio bridge](../twilio-omni-voice-agent).
