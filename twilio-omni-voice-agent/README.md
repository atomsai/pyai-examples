# Twilio → PyAI Omni voice agent

A real phone number that talks to a [PyAI Omni](https://pyai.com/models/omni)
agent, built on [`@pyai/twilio`](../../sdk/twilio). The whole bridge is one line:

```js
OmniAgent.bridge(twilioWS, { apiKey, agentId, voice, persona, knowledge });
```

`@pyai/twilio` handles mu-law↔PCM16 transcoding, resampling, the Omni handshake,
barge-in, and DTMF — so this example is just an HTTP route for TwiML and a
WebSocket route for the media stream.

## Run it

```bash
# 1) Build the local package this example depends on (one time).
cd ../../sdk/twilio && npm install && npm run build && cd -

# 2) Configure and start.
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

- **Persona / voice** — edit `persona` and `PYAI_VOICE` in `server.js` / `.env`.
- **Knowledge** — replace the `knowledge(query)` stub with your vector search;
  whatever you return is forwarded to the agent each turn.
- **Transfer to a human** — set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and
  `HUMAN_NUMBER`; when the agent decides to hand off, the live call is `<Dial>`ed
  to that number.
- **Lower latency** — pass `omniRate: 8000` to `OmniAgent.bridge(...)` to match
  Twilio's rate exactly and skip resampling.

## Notes

- Needs a public HTTPS/WSS URL (Twilio won't connect to `localhost`).
- Uses `node --env-file=.env`, so create `.env` first (copy the example).
- This bridge is stateless; run as many concurrent calls as your plan's
  realtime concurrency allows.
