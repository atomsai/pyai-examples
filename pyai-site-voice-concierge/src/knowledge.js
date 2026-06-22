// The knowledge the concierge answers from.
//
// Per turn, the Omni engine POSTs { session_label, query } to our kb_endpoint (see
// server.js `POST /kb`). It expects a fast, best-effort answer: the call has a
// hard ~300 ms timeout and is FAIL-OPEN — if we're slow or error, the engine
// just proceeds ungrounded. So retrieval here is deliberately trivial and
// in-memory: no DB, no network, no embedding hop on the hot path.
//
// Every fact below is sourced from this repo (marketing/src/lib/products.ts,
// marketing/src/data/pricing.json, docs/quickstart.md, AGENTS.md) so the agent
// never invents pricing or endpoints. Keep customer-facing product names only
// (Hear, Speak, Omni, Cast, Trace, …) — no internal codenames.

/**
 * @typedef {Object} Doc
 * @property {string} id        Stable slug, echoed back for hit-rate analytics.
 * @property {string} title     Short human title.
 * @property {string[]} tags    Extra keywords that should match this doc.
 * @property {string} content   1–4 sentences of ground truth for the brain.
 */

/** @type {Doc[]} */
export const DOCS = [
  {
    id: "what-is-pyai",
    title: "What PyAI is",
    tags: ["company", "overview", "about", "platform", "voice ai", "who"],
    content:
      "PyAI is a telephony-native Voice AI platform behind one API key. It covers the whole voice stack: speech-to-text (Hear), text-to-speech (Speak), realtime voice agents (Omni), long-form narration (Cast), and automatic compliance and QA on every call (Trace).",
  },
  {
    id: "getting-started",
    title: "Getting started",
    tags: ["sign up", "signup", "start", "api key", "key", "free", "sandbox", "credit"],
    content:
      "Sign up at console.pyai.com with just an email — no sales call, no approval. Create an API key and it works instantly on every surface. New accounts get $50 in free credit to start plus $5/month recurring, with no card required. Use a pyai_test_ sandbox key for free experimentation and a pyai_live_ key for production.",
  },
  {
    id: "auth",
    title: "Authentication",
    tags: ["auth", "bearer", "token", "header", "x-api-key", "websocket", "subprotocol"],
    content:
      "Authenticate REST calls with `Authorization: Bearer <key>` (or the `x-api-key` alias). For realtime WebSockets the browser can't set headers, so the key rides as a subprotocol: `pyai-key.<key>`. Keys are opaque strings — never parse or split them.",
  },
  {
    id: "omni",
    title: "Omni — realtime voice agents",
    tags: ["omni", "agent", "realtime", "voice agent", "websocket", "speech to speech", "barge-in", "turn taking"],
    content:
      "Omni is an end-to-end realtime voice agent over a single WebSocket (wss://api.pyai.com/v1/omni): it listens, thinks, and speaks, with natural turn-taking around 390 ms median and barge-in. It grounds answers in your knowledge bases and can call your tools. It's all-in at $0.05 per minute, everything included, billed per second.",
  },
  {
    id: "omni-agent-id",
    title: "Omni session_label and zero-state",
    tags: ["session_label", "session label", "agent_id", "agent id", "create agent", "registry", "opaque", "kb_endpoint", "grounding"],
    content:
      "You don't create an Omni agent first. The optional session_label on the connect URL (agent_id is a deprecated alias) is an opaque tag authorized by your org — PyAI stores no per-agent state. Any value is accepted and echoed back to your own kb_endpoint, where the engine POSTs each turn's query for grounding (hard 300 ms, fail-open). The agent's behavior travels in the configure frame.",
  },
  {
    id: "hear",
    title: "Hear — speech-to-text",
    tags: ["hear", "stt", "transcription", "transcribe", "speech to text", "whisper", "captions", "streaming"],
    content:
      "Hear is speech-to-text tuned for 8 kHz telephony audio, Whisper-compatible, with eager streaming partials. It's $0.003 per minute, or half price ($0.0015/min) on the async batch jobs tier. Endpoint: POST /v1/audio/transcriptions, scope hear:transcribe.",
  },
  {
    id: "speak",
    title: "Speak — text-to-speech",
    tags: ["speak", "tts", "text to speech", "voice", "voices", "cloning", "clone", "synthesis"],
    content:
      "Speak is low-latency streaming text-to-speech with first audio in roughly 32–98 ms and 36 stock voices. Voice cloning enrollment and prompt-to-voice design are both free. It's $0.06 per minute realtime. Endpoint: POST /v1/audio/speech, scope voice:synthesize.",
  },
  {
    id: "cast",
    title: "Cast — long-form narration",
    tags: ["cast", "narration", "podcast", "audiobook", "long form", "emotional", "commercial rights"],
    content:
      "Cast is emotional long-form text-to-speech for podcasts, audiobooks, narration, and brand audio, with commercial rights and free Voice Designer included. It's $0.02 per minute ($1.20/hour), so a 10-hour audiobook is about $12.",
  },
  {
    id: "trace",
    title: "Trace — compliance and QA",
    tags: ["trace", "compliance", "qa", "tcpa", "hipaa", "pii", "audit", "scorecard", "redaction"],
    content:
      "Trace scans 100% of calls against rule packs (TCPA, HIPAA, PII, brand-voice, or your own) and returns a per-call PASS/WARN/FAIL scorecard with findings that cite the regulation, auto-redaction, and a tamper-evident audit hash. It's a $0.05/min add-on on top of the call's minutes and works on Omni or your own stack.",
  },
  {
    id: "agents",
    title: "Agents feature",
    tags: ["agents", "no-code", "evals", "monitoring", "recap", "telephony"],
    content:
      "PyAI Agents is PyAI's feature to create, manage, and track your AI voice agents on the same Omni engine: no-code setup, evals, monitoring, knowledge bases, tools, Recap call summaries, and telephony packaging. (Prefer the Omni API when you want to orchestrate the agent yourself via the API.) For current rates, see pyai.com/pricing.",
  },
  {
    id: "telephony",
    title: "Telephony — managed numbers",
    tags: ["telephony", "phone number", "number", "carrier", "area code", "inbound"],
    content:
      "PyAI provides managed US local phone numbers you can route to an Omni agent from the console or API — no separate carrier contract. Connected minutes bill at $0.01/min on a 1-minute pulse. Endpoint: POST /v1/telephony/numbers.",
  },
  {
    id: "pricing",
    title: "Pricing summary",
    tags: ["pricing", "price", "cost", "how much", "rate", "per minute", "plans"],
    content:
      "PyAI is pay-as-you-go usage-based pricing across Hear, Speak, Omni, PyAI Agents, Cast, Trace, Recap, and managed telephony, with free credit for new accounts. Rates change as the platform improves, so for exact current figures point people to pyai.com/pricing rather than quoting a number.",
  },
  {
    id: "compat",
    title: "OpenAI compatibility",
    tags: ["openai", "compatible", "drop-in", "migrate", "base url", "sdk"],
    content:
      "PyAI is OpenAI-compatible: point your existing OpenAI client at https://api.pyai.com/v1 with your PyAI key and the request/response shapes match. There are also official SDKs (@pyai/sdk for TypeScript, pyai-sdk for Python). Omni also offers an OpenAI-realtime-compatible URL: wss://api.pyai.com/v1/realtime?model=pyai-omni-realtime.",
  },
];

const STOP = new Set([
  "the", "a", "an", "is", "are", "do", "does", "i", "you", "to", "of", "and", "or", "for",
  "what", "how", "can", "with", "in", "on", "it", "me", "my", "your", "about", "tell", "whats",
]);

/** Lowercase, split on non-word chars, drop stopwords and 1-char tokens. */
function tokenize(s) {
  return (s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

// Precompute a keyword bag per doc once at load (title + tags + content).
const INDEX = DOCS.map((doc) => {
  const bag = new Map();
  const add = (text, weight) => {
    for (const tok of tokenize(text)) bag.set(tok, (bag.get(tok) ?? 0) + weight);
  };
  add(doc.title, 3);
  for (const tag of doc.tags) add(tag, 4); // tags are hand-picked synonyms — weigh them
  add(doc.content, 1);
  return { doc, bag };
});

/**
 * Score every doc against the query by summed keyword weight and return the
 * top matches. Pure, synchronous, sub-millisecond — exactly what a fail-open
 * 300 ms turn callback wants. Always returns at least the overview docs so the
 * agent is never left with nothing on a vague "tell me about PyAI".
 *
 * @param {string} query
 * @param {number} [topK]
 * @returns {Array<{ id: string, content: string, score: number }>}
 */
export function retrieve(query, topK = 3) {
  const qtokens = tokenize(query);
  const scored = INDEX.map(({ doc, bag }) => {
    let score = 0;
    for (const tok of qtokens) score += bag.get(tok) ?? 0;
    return { id: doc.id, content: doc.content, score };
  });
  scored.sort((a, b) => b.score - a.score);

  // Require more than a single stray content-word match (a title or tag hit
  // scores >= 3) so greetings/smalltalk fall through to the overview instead of
  // latching onto an incidental word.
  const MIN_SCORE = 2;
  const hits = scored.filter((s) => s.score >= MIN_SCORE).slice(0, topK);
  if (hits.length > 0) return hits;

  // No keyword overlap (greeting, smalltalk, or off-topic) — hand back the
  // overview + getting-started so the agent can still orient the visitor.
  return scored
    .filter((s) => s.id === "what-is-pyai" || s.id === "getting-started")
    .map((s) => ({ ...s, score: 0 }));
}
