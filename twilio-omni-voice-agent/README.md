# Twilio → PyAI Omni voice agent

A real phone number that talks to a [PyAI Omni](https://pyai.com/models/omni)
agent, built on [`@pyai/twilio`](https://www.npmjs.com/package/@pyai/twilio). The whole bridge is one line:

```js
OmniAgent.bridge(twilioWS, { apiKey, sessionLabel, voice, persona, knowledge });
```

`@pyai/twilio` handles mu-law↔PCM16 transcoding, resampling, the Omni handshake,
barge-in, negotiated playback receipts, and DTMF, so this example is just an HTTP route for TwiML and a
WebSocket route for the media stream.

## Run it

```bash
# Build the SDK only when running from the monorepo.
# Public example clones install the published package below.
if [ -f ../../sdk/twilio/package.json ]; then
  npm --prefix ../../sdk/twilio ci
  npm --prefix ../../sdk/twilio run build
fi

# Configure and start.
cp .env.example .env        # then edit PYAI_API_KEY (a pyai_test_ key is fine)
npm install
npm start
```

The server listens on `:8080`. Expose it so Twilio can reach it:

```bash
ngrok http 8080             # copy the https host it prints
```

Set your Twilio number's **A call comes in** webhook to
`https://<your-ngrok-host>/voice` (HTTP **POST**), then call the number. You
should hear the agent within a second. Talk over it to confirm barge-in cuts it
off; press a key to confirm DTMF flows through.

## What to try

- **Persona / voice**, edit `persona` and `PYAI_VOICE` in `server.js` / `.env`.
- **Knowledge**, replace the `knowledge(query)` stub with your vector search;
  whatever you return is forwarded to the agent each turn.
- **Transfer to a human**, set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and
  `HUMAN_NUMBER`; when the agent decides to hand off, the live call is `<Dial>`ed
  to that number.
- **Lower latency**, pass `omniRate: 8000` to `OmniAgent.bridge(...)` to match
  Twilio's rate exactly and skip resampling.

## Notes

- Needs a public HTTPS/WSS URL (Twilio won't connect to `localhost`).
- Uses `node --env-file=.env`, so create `.env` first (copy the example).
- This bridge is stateless; run as many concurrent calls as your plan's
  realtime concurrency allows.

The monorepo uses its built local SDK; the public example requires the published
`@pyai/twilio` 0.4.3 or later. It credits completed segments from Twilio mark echoes
and discards marks returned by a clear. Generation completion does not prove
playback; see the [SDK playback contract](https://www.npmjs.com/package/@pyai/twilio#playback-receipts).
Version 0.4.2 does not provide these receipts.
