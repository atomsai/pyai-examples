# Recap: mine your calls (batch transcribe → talk-ratio + keywords + summary)

A Gong-style **conversation-intelligence** recipe built on PyAI
[Hear](https://pyai.com/models/hear) batch jobs. Point it at a call recording
and get back a **diarized transcript**, **talk-ratio** per speaker, **keyword
counts**, and an LLM **summary** — the building blocks of a "mine your calls"
feature.

```
call.wav ──POST /v1/transcription/jobs (diarize:true)──▶ { job_id, status: "queued" }
              poll GET /v1/transcription/jobs/{id} ──────▶ status: "completed"
  result.segments[{ speaker, start, end, text }]
        │
        ├─▶ talk-ratio   (sum of each speaker's segment durations)
        ├─▶ keywords     (top terms, stop-words removed)
        └─▶ summary      (your LLM — stubbed here; swap in OpenAI/Anthropic/…)
```

Batch is the **−50% async tier** ($0.0015/min vs $0.003/min realtime) — the right
tool for after-the-call analytics.

## Run it

Self-contained: with only a key it synthesizes a short **two-voice** support
call (so diarization has two speakers to separate), transcribes it, and prints
the analytics. Bring your own recording with `AUDIO_FILE` or `AUDIO_URL`.

```bash
cp .env.example .env        # PYAI_API_KEY needs scopes: hear:transcribe + transcribe:jobs
npm start

# Analyze your own call instead:
AUDIO_FILE=./call.wav npm start
AUDIO_URL=https://example.com/call.mp3 npm start   # we fetch it; input never stored
```

Output:

```
[1/3] audio:   synthesized a 2-voice call → call.wav (18.4s)
[2/3] job:     job_aZ09… queued → completed in 6.1s (2 speakers)
[3/3] recap:

  Talk ratio
    speaker_0  58%  ██████████████
    speaker_1  42%  ██████████

  Top keywords
    appointment(3)  tuesday(2)  confirm(2)  reschedule(1)  …

  Summary
    Customer asked to move a Tuesday appointment; agent confirmed the new slot
    and offered a reminder. (Replace the stub with your LLM for real summaries.)
```

## How it works

1. **Submit** — `POST /v1/transcription/jobs` with the audio (multipart `audio`
   part, or an `audio_url` we fetch) and `diarize: true` for single-track
   speaker separation. Stereo recording? Use `channel: true` instead for exact,
   model-free per-channel separation.
2. **Poll** — `GET /v1/transcription/jobs/{job_id}` until `status: "completed"`
   (or supply a `webhook_url` for a signed callback). Large results are offloaded
   to a signed `result_url`; this example handles both inline `result` and
   `result_url`.
3. **Analyze** — `result.segments` carry `{ speaker, start, end, text }`.
   Talk-ratio sums each speaker's durations; keywords come from `result.text`;
   the summary is where **your** LLM goes (stubbed so this runs with no extra
   credentials — see `llmSummary()` in `index.mjs`).

## Notes

- **Scopes:** batch jobs need **`hear:transcribe` + `transcribe:jobs`**.
- **Idempotency:** submit supports an `Idempotency-Key` header so a retried POST
  doesn't double-bill — add one in production.
- **Diarization quality:** 2-party separation ships; 3-party is beta. Synthetic
  TTS voices separate well enough to demo; real calls do better.
- Uses only the built-in `fetch`/`FormData` (Node ≥ 22) — see `index.mjs`.
