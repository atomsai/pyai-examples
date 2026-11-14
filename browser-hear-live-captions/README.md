# Browser live captions with PyAI Hear

Stream microphone audio through a local backend to Hear and display revisable
partials and corrected finals. The API key stays on the backend. This existing
example is for microphone captions; for an existing telephone stream, follow the
[8 kHz telephony input instructions](https://docs.pyai.com/guides/streaming-stt#audio-format-pcm16-at-8-or-16-khz).
No carrier connection or phone call is created.

## Run it

Use Node 22 or newer. Supply your **confirmed test project's** credentials through
the local environment or a private local `.env`; never paste a key into the page
or commit it to source control.

```bash
npm install
# The scaffolder creates .env; when cloning, first copy .env.example to .env.
chmod 600 .env
# Set PYAI_API_KEY and PYAI_PROJECT_ID in .env using your local editor.
npm start
```

`npm start` loads `.env` when present; existing environment variables take
precedence. The local `.gitignore` excludes `.env` and `node_modules`.
Alternatively export both variables privately and run `npm start` without a file.

Open <http://127.0.0.1:5173>. Before starting, review the displayed organization,
project, environment, limits, credit and key budget. The server checks `GET /v1/me`
and rejects a different project, live environment, missing `hear:stream` scope,
and invalid or zero daily cap. An absent/null cap means no provider-enforced
ceiling; a cap alone does not prove nonbillable usage. Confirm billing separately.
No new project or key is created.

Click **Start listening**, grant microphone access, and speak. One server
invocation permits **one connection attempt**, at most **60 seconds** and
**60 seconds of PCM16 input**, without reconnecting or retrying. A failed attempt
also consumes that allowance. Restart only after reviewing the result and your
remaining authorized budget. Stop closes capture and the socket immediately;
a pending final may be lost. This example does not save a transcript file.

## Audio and transcript contract

- Requests a 16 kHz `AudioContext` and verifies its actual rate **before** opening
  a WebSocket. Browsers that cannot provide 16 kHz stop with an actionable error;
  do not label 48 kHz bytes as 16 kHz. A production fallback needs an anti-aliasing
  resampler. Hear accepts PCM16 little-endian mono at **8 or 16 kHz**, not arbitrary
  browser rates or compressed microphone recordings.
- Sends binary PCM16 through the same-origin local proxy. The server connects to
  `wss://api.pyai.com/v1/audio/transcriptions/stream` with
  `protocol=pyai-hear-v1&sample_rate=16000&encoding=pcm16&interim_results=true`
  and both `pyai.v1` and `pyai-key.<credential>` subprotocols.
- Shows `partial`, `partial_stable` and `speech_final` as pending text; commits
  corrected `final` once per `utterance_id`. The initial and corrected final are
  not appended as duplicate sentences.
- For telephone input, decode G.711 μ-law to PCM16 first and use `sample_rate=8000`
  on your backend connection. This microphone demo does not decode carrier media.
  Recorded audio, word timestamps and speaker labels use the
  [recorded/async transcription workflows](https://docs.pyai.com/guides/async-transcription-jobs).

## Security and production adaptation

The server binds to `127.0.0.1`, checks the exact local Host and WebSocket Origin,
keeps the upstream endpoint fixed, and bounds duration, bytes and queued data.
It is a **local demo**, not an authenticated multi-user service. Production needs
your application's user authentication, authorization, quotas and session control
on the backend proxy. **Omni session tokens do not authorize Hear**; there is no
Hear browser-token flow demonstrated here. Never ship a long-lived key to a page.

The small demo uses `ScriptProcessorNode`; production capture should use an
`AudioWorklet`. Neither the sample nor its tests establish recognition accuracy
or latency on your telephone audio.

## Non-audio checks

```bash
npm test
```

Tests use mocked identity, a local mock WebSocket and synthetic bytes. They check
format admission, credential isolation, corrected finals, origin checks and the
one-session limit; they never call a PyAI generation or transcription endpoint.
