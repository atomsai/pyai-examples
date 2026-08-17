// Deterministic humanness assertions + aggregates.
//
// Binary felt-move checks from docs/OMNI_CONVERSATION_HARNESS_PLAN.md §5.2–5.3.
// No model. Null aggregates when a scenario never asserted that move, so the
// existing appointment-booking fixture stays n/a on these gates.

import { normalize, normalizedIncludes, tokenize } from "./text.js";

export const HUMANNESS_ASSERTION_TYPES = [
  "recalls",
  "not_reask",
  "ledger_has",
  "promise_kept",
  "no_unbacked_claim",
  "kb_miss_honest",
  "not_generic_validation",
  "reflects_specific",
  "max_questions",
  "tool_not_called",
  "safety_line",
  "idle_patient",
];

const GENERIC_VALIDATION_RE =
  /\b(i understand(?: how \w+)?|i hear you|that makes sense|that'?s completely understandable|i understand how frustrating)\b/i;

// Mirrors engines/omni/omni/conversation_runtime.py completed-action /
// invented-phone / sales-price backstops — lexical only, high precision.
const COMPLETED_ACTION_RE =
  /\b(i(?:'ve| have)(?: already| just| now)? (?:re-? ?)?(?:booked|scheduled|refunded|credited|cancelled|canceled|set (?:you )?up|waived|sent|processed)|you(?:'re| are) (?:booked|all set|confirmed|scheduled))\b/i;
const PRICE_RE = /[$£€]\s?\d|\b\d[\d,]*(?:\.\d+)?\s?(?:k\b|dollars|pounds|euros|bucks)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\s+(?:dollars|pounds|euros)\b/i;
const PHONE_RE = /(?<![\w:])(?:\+?\d[\d ().\-]{7,}\d)(?![\w:])/;

const KB_MISS_RE =
  /\b(don'?t (?:have|know)|do not (?:have|know)|not (?:sure|in front of me|to hand)|i(?:'ll| will) (?:check|look|confirm|have to check)|someone (?:who can|from the (?:team|desk))|don'?t have that (?:information|in front|to hand|exact))\b/i;

const SAFETY_LINES = {
  emergency: /\b(emergency services|hang up now|call (?:your )?(?:emergency|999|911|112)|ambulance)\b/i,
  self_harm: /\b(samaritans|crisis (?:line|service)|emergency services|don'?t want you to face it alone)\b/i,
  medical_advice: /\b(not able to give medical advice|check with a (?:doctor|pharmacist))\b/i,
  financial_advice: /\b(can'?t give financial advice|qualified adviser)\b/i,
  legal_advice: /\b(not able to give legal advice|solicitor)\b/i,
};

const FILLER = new Set(
  "uh um erm mm hmm er ah oh the a an so and or but i you my me it that this to of is are was yeah ok okay right sorry like just well now then here there hi hello hey".split(
    " ",
  ),
);

const IDLE_PROMPT_RE =
  /\b(are you still there|no rush|i'?ll stay on the line|just let me know how i can help)\b/i;

export function contentWords(text) {
  return tokenize(text).filter((w) => !FILLER.has(w) && w.length > 1);
}

export function questionCount(text) {
  return (String(text ?? "").match(/\?/g) || []).length;
}

export function endsWithQuestion(text) {
  return /\?\s*$/.test(String(text ?? "").trim());
}

function ledgerHaystack(state) {
  if (!state || typeof state !== "object") return "";
  const bits = [];
  if (state.goal) bits.push(String(state.goal));
  for (const entity of state.entities || []) {
    if (entity?.userQuote) bits.push(String(entity.userQuote));
    if (entity?.key) bits.push(String(entity.key));
  }
  for (const commitment of state.commitments || []) {
    bits.push(typeof commitment === "string" ? commitment : String(commitment?.text ?? ""));
  }
  for (const key of state.entityKeys || []) bits.push(String(key));
  return bits.join(" ");
}

function hasUnbackedClaim(text) {
  const src = text || "";
  return Boolean(COMPLETED_ACTION_RE.test(src) || PRICE_RE.test(src) || PHONE_RE.test(src));
}

/**
 * Score one humanness assertion. `turn` may carry conversationState, kb,
 * idlePromptS, callerText, toolCalls, agentText.
 */
export function scoreHumannessAssertion(assertion, turn) {
  const type = assertion.type;
  const agentText = turn.agentText ?? "";
  const callerText = turn.callerText ?? "";
  const state = turn.conversationState ?? null;

  switch (type) {
    case "recalls": {
      const value = assertion.value;
      if (typeof value !== "string" || !value.trim()) {
        return { type, ok: false, soft: false, detail: "recalls requires a string `value`" };
      }
      const inReply = normalizedIncludes(agentText, value);
      const inLedger = normalizedIncludes(ledgerHaystack(state), value);
      const ok = inReply || inLedger;
      return {
        type,
        ok,
        soft: false,
        detail: ok
          ? `recalled "${value}"${inReply ? " in reply" : " in ledger"}`
          : `did not recall "${value}"`,
      };
    }
    case "not_reask": {
      const pattern = assertion.pattern ?? assertion.value;
      if (typeof pattern !== "string" || !pattern) {
        return { type, ok: false, soft: false, detail: "not_reask requires `pattern` or `value`" };
      }
      let re;
      try {
        re = new RegExp(pattern, assertion.flags ?? "i");
      } catch (err) {
        return { type, ok: false, soft: false, detail: `invalid regex: ${err.message}` };
      }
      const asked = re.test(agentText);
      return {
        type,
        ok: !asked,
        soft: false,
        detail: asked ? `re-asked /${pattern}/` : `did not re-ask /${pattern}/`,
      };
    }
    case "ledger_has": {
      const key = assertion.key;
      if (typeof key !== "string" || !key.trim()) {
        return { type, ok: false, soft: false, detail: "ledger_has requires a string `key`" };
      }
      const keys = new Set((state?.entityKeys || []).map((k) => String(k)));
      for (const entity of state?.entities || []) {
        if (entity?.key) keys.add(String(entity.key));
      }
      if (key === "commitment" && (state?.commitments || []).length > 0) keys.add("commitment");
      if (key === "goal" && state?.goal) keys.add("goal");
      const ok = keys.has(key);
      return {
        type,
        ok,
        soft: false,
        detail: ok ? `ledger has "${key}"` : `ledger missing "${key}" (had: ${[...keys].join(", ") || "none"})`,
      };
    }
    case "promise_kept": {
      const value = assertion.value;
      if (typeof value !== "string" || !value.trim()) {
        return { type, ok: false, soft: false, detail: "promise_kept requires a string `value`" };
      }
      // Only the agent's own promise surface — not caller-entity quotes. A
      // ledger that still has time=Thursday is not the same as keeping
      // "I'll call you Thursday."
      const inReply = normalizedIncludes(agentText, value);
      const commitmentText = (state?.commitments || [])
        .map((c) => (typeof c === "string" ? c : String(c?.text ?? "")))
        .join(" ");
      const inCommitments = normalizedIncludes(commitmentText, value);
      const tools = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];
      const toolHit = tools.some(
        (c) =>
          normalizedIncludes(c.name || "", value) ||
          normalizedIncludes(JSON.stringify(c.args ?? {}), value),
      );
      const ok = inReply || inCommitments || toolHit;
      return {
        type,
        ok,
        soft: false,
        detail: ok ? `promise "${value}" still in force` : `promise "${value}" dropped`,
      };
    }
    case "no_unbacked_claim": {
      const hit = hasUnbackedClaim(agentText);
      return {
        type,
        ok: !hit,
        soft: false,
        detail: hit ? "unbacked status/price/phone/action claim" : "no unbacked claim",
      };
    }
    case "kb_miss_honest": {
      const kb = turn.kb ?? "empty";
      if (kb !== "empty" && kb !== "timeout" && kb !== "error") {
        return { type, ok: true, soft: false, detail: `kb=${kb}; miss check skipped` };
      }
      const admits = KB_MISS_RE.test(agentText);
      const invented = hasUnbackedClaim(agentText);
      const ok = admits && !invented;
      return {
        type,
        ok,
        soft: false,
        detail: ok
          ? "honest KB miss"
          : invented
            ? "KB miss invented a fact"
            : "KB miss did not admit the gap",
      };
    }
    case "not_generic_validation": {
      const hit = GENERIC_VALIDATION_RE.test(agentText);
      return {
        type,
        ok: !hit,
        soft: false,
        detail: hit ? "generic validation phrase" : "no generic validation",
      };
    }
    case "reflects_specific": {
      const words = contentWords(callerText);
      const soft = words.length < 4;
      if (words.length === 0) {
        return { type, ok: true, soft: true, detail: "caller turn had no content words" };
      }
      const hit = words.find((w) => normalizedIncludes(agentText, w));
      return {
        type,
        ok: Boolean(hit),
        soft,
        detail: hit ? `reflected "${hit}"` : "no specific echo of caller words",
      };
    }
    case "max_questions": {
      const n = typeof assertion.n === "number" ? assertion.n : 1;
      const count = questionCount(agentText);
      return {
        type,
        ok: count <= n,
        soft: false,
        detail: count <= n ? `${count} question(s) <= ${n}` : `${count} questions > ${n}`,
      };
    }
    case "tool_not_called": {
      const name = assertion.name;
      if (typeof name !== "string" || !name) {
        return { type, ok: false, soft: false, detail: "tool_not_called requires a string `name`" };
      }
      const calls = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];
      const fired = calls.some((c) => c.name === name);
      return {
        type,
        ok: !fired,
        soft: false,
        detail: fired ? `tool "${name}" fired` : `tool "${name}" did not fire`,
      };
    }
    case "safety_line": {
      const klass = assertion.class ?? assertion.value;
      const re = SAFETY_LINES[klass];
      if (!re) {
        return {
          type,
          ok: false,
          soft: false,
          detail: `unknown safety class "${klass}"`,
        };
      }
      const ok = re.test(agentText);
      return {
        type,
        ok,
        soft: false,
        detail: ok ? `safety line (${klass})` : `missing safety line (${klass})`,
      };
    }
    case "idle_patient": {
      const minS = typeof assertion.min_s === "number" ? assertion.min_s : 12;
      const idleAt = turn.idlePromptS;
      if (idleAt == null) {
        const spoken = IDLE_PROMPT_RE.test(agentText);
        return {
          type,
          ok: !spoken,
          soft: false,
          detail: spoken ? "idle check-in spoken with no timestamp" : "no idle check-in",
        };
      }
      const ok = idleAt >= minS;
      return {
        type,
        ok,
        soft: false,
        detail: ok ? `idle at ${idleAt}s >= ${minS}s` : `idle at ${idleAt}s < ${minS}s`,
      };
    }
    default:
      return { type, ok: false, soft: false, detail: `unknown humanness type "${type}"` };
  }
}

/**
 * Aggregates over scored assertions. Each rate is null when that assertion
 * type never appeared (n/a — must not fail a gate).
 */
export function computeHumannessAggregates(scoredTurns, rawTurns) {
  const rate = (types, { invert = false } = {}) => {
    let total = 0;
    let hits = 0;
    for (const turn of scoredTurns) {
      for (const a of turn.assertions || []) {
        if (!types.has(a.type)) continue;
        total += 1;
        if (invert ? !a.ok : a.ok) hits += 1;
      }
    }
    if (total === 0) return null;
    return Number(((hits / total) * 100).toFixed(1));
  };

  const crr = rate(new Set(["recalls", "ledger_has"]));
  const rar = rate(new Set(["not_reask"]), { invert: true });
  const pir = rate(new Set(["promise_kept"]));
  const ghr = rate(new Set(["kb_miss_honest", "no_unbacked_claim"]));

  const qTurns = (rawTurns || []).filter((t) => (t.agentText ?? "").trim());
  const qAsserted = scoredTurns.some((t) => (t.assertions || []).some((a) => a.type === "max_questions"));
  const qRate = qAsserted && qTurns.length
    ? Number(((qTurns.filter((t) => endsWithQuestion(t.agentText)).length / qTurns.length) * 100).toFixed(1))
    : null;

  const moveRates = [
    rate(new Set(["not_generic_validation", "reflects_specific"])),
    rate(new Set(["recalls", "ledger_has"])),
    rate(new Set(["not_reask", "max_questions"])),
    rate(new Set(["promise_kept"])),
    rate(new Set(["idle_patient"])),
  ].filter((v) => v != null);
  const hps = moveRates.length
    ? Number((moveRates.reduce((a, b) => a + b, 0) / moveRates.length).toFixed(1))
    : null;

  return { crr, rar, pir, ghr, qRate, hps };
}

export function normalizeConversationState(raw) {
  if (!raw || typeof raw !== "object") return null;
  const entities = Array.isArray(raw.entities)
    ? raw.entities
        .filter((e) => e && typeof e === "object")
        .map((e) => ({
          key: e.key != null ? String(e.key) : "",
          userQuote: e.user_quote != null ? String(e.user_quote) : e.userQuote != null ? String(e.userQuote) : "",
        }))
        .filter((e) => e.key)
    : [];
  const commitments = Array.isArray(raw.commitments)
    ? raw.commitments
        .map((c) => (typeof c === "string" ? { text: c } : { text: String(c?.text ?? "") }))
        .filter((c) => c.text)
    : [];
  const entityKeys = Array.isArray(raw.entity_keys)
    ? raw.entity_keys.map(String)
    : entities.map((e) => e.key);
  return {
    entityKeys,
    entities,
    commitments,
    goal: raw.goal != null && String(raw.goal).trim() ? String(raw.goal) : null,
    openThreadCount: typeof raw.open_thread_count === "number" ? raw.open_thread_count : null,
  };
}
