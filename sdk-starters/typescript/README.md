# PyAI TypeScript starter

Use typed requests and native ReadableStream audio in your Node.js backend.

## Requirements

Node.js 22+. A PyAI key. The starter writes speech.pcm; run npm start -- call.wav to also transcribe a recording.

## Run

```sh
npm install
cp .env.example .env
# Fill in .env, then:
npm start
```

The starter runs on Node.js. Keep secret keys on your backend; use the browser voice-agent guide for frontend authentication.

Play the raw audio with FFmpeg installed:

```sh
ffplay -f s16le -ar 24000 -ac 1 speech.pcm
```

Select a voice from `GET https://api.pyai.com/v1/voices`. Use the current voice/language support table rather than assuming every voice supports every language. PCM, WAV and G.711 support streaming; MP3 and Opus are buffered.

Keep `.env` out of Git. These starters use server-side credentials.

[Full guide](https://docs.pyai.com/guides/sdks) · [Agent setup](https://pyai.com/build-with-ai) · [API contract](https://api.pyai.com/openapi.json)
