# Runnable Omni starter

Requires Node 20.19+ and ESM. Node 20 uses the included `ws` transport;
Node 22 also works. The separate MCP server requires Node 22+.
This server-side example uses a synthetic read-only office-hours tool. Read
`PYAI.md` when generating the project through the CLI.

<!-- omni-install:start -->
```sh
npm install @pyai/sdk@0.7.0
npx pyai init voice-demo --template omni
cd voice-demo
npm install
```

Initialization is offline; installing dependencies and running `main.mjs` are
separate steps. For an existing checkout of this example, run `npm install`
in its directory instead.
<!-- omni-install:end -->

Inject `PYAI_API_KEY` through your secret manager or shell environment. Do not
paste a real key into source, a prompt, or shell history. `.env.example` documents
the variable; this program does not load `.env` or saved CLI profiles.

Prepare a 24 kHz PCM16 mono WAV, at most 20 seconds, saying “Please look up the
office opening time.” Then run:

```sh
node main.mjs caller.wav
```

Running the program explicitly opens one bounded Omni session and uploads its
captured reply to Hear. Both consume your key's allowed usage. Automatic retries
are disabled. No managed number is bought and no phone call is placed.

`session.mjs` waits for configuration and the greeting to drain, sends exactly
one paced input stream (caller PCM or silence), returns the read tool's result,
and captures output using the rate from `hello.audio_out`. Never run a separate
silence timer alongside caller audio. `timing.mjs` is generated from the existing
Omni evaluation harness's timing utilities.

The new private `omni-run-*` folder contains `session.wav`, `reply.wav`, and
`report.json`. The report separates received audio, an office-hours answer
recovered by Hear from captured audio, and physical playback (not tested).
A synthesis transcript is advisory; it is not evidence that speech arrived.
Capture ends after the simulated queue drains and two seconds of quiet. Omni
has no protocol reply-end marker, so this is a bounded capture heuristic.
Listen to the saved file when qualifying actual sound quality or completeness.

To exercise interruption, supply a second WAV saying “Stop speaking now”:

```sh
node main.mjs caller.wav interruption.wav
```

The second clip starts while reply audio is queued. `onBargeIn` clears that
simulated queue, and capture observes at least five seconds after that clip ends.
An interrupted answer can correctly fail the full-answer check;
inspect the separate interruption evidence. This is not a physical speaker test.
For a real playback adapter, cancel both queued and currently playing audio.
Replace the example lookup with authorized application data before product use.
