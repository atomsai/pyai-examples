# PyAI Twilio starter

Bridge a Twilio Media Stream to Omni for the complete speech-to-speech loop.

## Requirements

Node.js 22+. A PyAI key, a Twilio phone number and auth token, and an HTTPS tunnel or deployed server. Set PUBLIC_ORIGIN to its origin.

## Run

```sh
npm install
cp .env.example .env
# Fill in .env, then:
npm start
```

After starting the server, set your Twilio number’s incoming voice webhook to https://YOUR-HOST/voice (POST). Carrier charges apply when you make a call.

Select a voice from `GET https://api.pyai.com/v1/voices`. Use the current voice/language support table rather than assuming every voice supports every language. PCM, WAV and G.711 support streaming; MP3 and Opus are buffered.

Keep `.env` out of Git. These starters use server-side credentials.

[Full guide](https://docs.pyai.com/guides/twilio-voice-agent) · [Agent setup](https://pyai.com/build-with-ai) · [API contract](https://api.pyai.com/openapi.json)
