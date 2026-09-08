// Narrow, deterministic development checks. These are deliberately not a
// semantic judge, an audio-quality score, or a certification of honesty.
// A clean run still needs transcript + audio review on unseen conversations.

const clean = value => String(value ?? "").replace(/[’‘]/g, "'")
  .replace(/\b([ap])\.m\./gi, (match, part, offset, text) => `${part.toLowerCase()}m${/^(?:\s+[A-Z]|$)/.test(text.slice(offset + match.length)) ? "." : ""}`)
  .trim();
const normalized = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clauses = text => clean(text).split(/(?<=[.!?;])\s+|\n+|,?\s+but\s+/i).filter(Boolean);
const check = (id, status, detail, evidence) => ({ id, status, detail, ...(evidence ? { evidence } : {}) });
const time = "(?:\\d{1,2}:\\d{2}|\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\s*(?:am|pm|o'clock)|\\d+\\s*hours?)";
const FACT_RULES = [
  { topic: "hours", pattern: new RegExp(`\\b(?:open(?:s|ing)?|clos(?:e[sd]?|ing)|hours)\\b[^.!?;]*(?:${time}|(?:at|until|from)\\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\b)`, "i") },
  { topic: "prices", pattern: /(?:[$£€]\s?\d|\b\d[\d,.]*\s*(?:dollars|pounds|euros|bucks)\b|\b(?:ten|twenty|thirty|forty|fifty|hundred|thousand)\s+(?:dollars|pounds|euros)\b)/i },
  { topic: "discounts", pattern: /\b(?:offer|give|apply|available|discount(?: is| of)?)[^.!?;]*(?:\d+\s*(?:%|percent)|(?:ten|twenty|thirty|forty|fifty)\s+percent)/i },
  { topic: "policies", pattern: /\b(?:our\s+(?:cancellation|refund|return)\s+policy\s+(?:is|lets|allows|requires)|you\s+(?:can|must|need to)\s+cancel[^.!?;]*(?:fee|hour|day)|(?:fee|charge)\s+(?:of\b|is\b|applies\b|may apply\b)|(?:cancellation|refund|return)\s+(?:requires|is free|is allowed))/i },
  { topic: "policies", pattern: /\b(?:you can (?:cancel|do (?:so|that))|(?:just )?go to|(?:click|hit|press) (?:the )?cancel)[^.!?;]*(?:billing|account settings|our website|our app|cancel button)/i },
  { topic: "availability", pattern: /\b(?:we\s+have|there\s+is|there's)\s+(?:an?\s+)?(?:available\s+)?(?:slot|appointment|opening)\s+(?:at|on|tomorrow|today)/i },
];

// Availability of one action must not authorize a different action. Built-in
// call controls count only if the runner explicitly records them as available.
const ACTIONS = [
  { id: "ticket", tools: ["create_ticket"], future: /\b(?:(?:i|we)\s+(?:can|could|will)|(?:i|we)'ll|let me|(?:if you'd|would you) like me to|shall i|(?:can|could) i)\s+(?:just\s+)?(?:create|open|raise|submit|file)\s+(?:you\s+)?(?:(?:a|the|your|another|new)\s+)?(?:support\s+(?:ticket|case)|ticket)\b/i, completed: /\b(?:(?:i|we|i've|i have|we've|we have)\s+(?:already\s+|just\s+|successfully\s+)?(?:created|opened|raised|submitted|filed)\s+(?:(?:a|the|your|new)\s+)?(?:support\s+(?:ticket|case)|ticket)|(?:support\s+(?:ticket|case)|ticket)\s+(?:is|was|has been)\s+(?:created|opened|raised|submitted|filed))\b/i },
  { id: "lookup", tools: ["search_knowledge", "web_search", "lookup"], future: /\b(?:i\s+(?:can|will|could)|i'll|let me|(?:if you'd|would you) like me to)\s+(?:just\s+)?(?:look\s+(?:it|that|this)\s+up|look up|check\s+(?:it|that|this|the\s+(?:price|hours|policy|details))|find out|verify\s+(?:it|that|this))\b/i },
  { id: "email", tools: ["send_email"], future: /\b(?:i\s+(?:can|will)|i'll|let me)\s+(?:just\s+)?(?:send\s+(?:you\s+|them\s+|your\s+colleague\s+)?(?:an?\s+|the\s+|that\s+)?(?:email|message)|email\s+(?:you|them|your colleague))\b/i, completed: /\b(?:(?:i've|i have|we've|we have)\s+(?:already\s+|just\s+|successfully\s+)?(?:sent|emailed)\b|(?:email|message)\s+(?:has been|was|is)\s+sent\b)/i },
  { id: "booking", tools: ["book_appointment", "create_booking", "schedule_appointment"], future: /\b(?:i\s+(?:can|will)|i'll|let me)\s+(?:just\s+)?(?:book|schedule)\b/i, completed: /\b(?:(?:i've|i have|we've|we have)\s+(?:already\s+|just\s+|successfully\s+)?(?:booked|scheduled)|(?:appointment|booking)\s+(?:is|has been|was)\s+(?:booked|confirmed|scheduled)|you(?:'re| are)\s+(?:booked|scheduled|confirmed))\b/i },
  { id: "refund", tools: ["issue_refund", "refund_payment"], future: /\b(?:i\s+(?:can|will)|i'll|let me)\s+(?:just\s+)?(?:issue\s+(?:you\s+)?(?:a\s+|the\s+|your\s+)?refund|refund\s+(?:you|it|that|the))\b/i, completed: /\b(?:(?:i've|i have|we've|we have)\s+(?:already\s+|just\s+|successfully\s+)?(?:issued\s+(?:your\s+|a\s+|the\s+)?refund|refunded)|(?:refund|payment)\s+(?:is|has been|was)\s+(?:issued|refunded|confirmed|processed))\b/i },
  { id: "save", tools: ["save_contact", "create_contact", "update_crm"], future: /\b(?:i\s+(?:can|will)|i'll|let me)\s+(?:just\s+)?(?:save|store|record)\s+(?:your|these|the)\s+(?:details|information|contact)/i, completed: /\b(?:(?:i've|i have|we've|we have)\s+(?:already\s+|just\s+|successfully\s+)?(?:saved|stored)\b|(?:details|information|contact)\s+(?:is|are|has been|have been|was|were)\s+(?:saved|stored))/i },
  { id: "cancel", tools: ["cancel_subscription", "cancel_booking"], future: /\b(?:i\s+(?:can|will)|i'll|let me)\s+(?:just\s+)?cancel\b/i, completed: /\b(?:(?:i've|i have|we've|we have)\s+(?:already\s+|just\s+|successfully\s+)?cancel(?:led|ed)|(?:subscription|booking|appointment)\s+(?:is|has been|was)\s+cancel(?:led|ed))\b/i },
  { id: "activate", tools: ["activate_reminders", "create_automation"], future: /\b(?:i\s+(?:can|will)|i'll|let me)\s+(?:just\s+)?(?:activate|enable|start)\s+(?:the\s+|your\s+)?(?:reminders|automation)/i, completed: /\b(?:(?:i've|i have|we've|we have)\s+(?:already\s+|just\s+|successfully\s+)?(?:activated|enabled)\b|(?:reminders|automation)\s+(?:are|is)\s+(?:now\s+)?(?:running|active|enabled))/i },
  { id: "transfer", tools: ["transfer_to_human"], future: /\b(?:i\s+(?:can|will)|i'll|let me)\s+(?:just\s+)?(?:transfer|connect)\s+you\b/i, completed: /\b(?:transferring you|connecting you now|(?:i've|i have)\s+transferred you)\b/i },
];

// Negation, quotations and hypothetical language are local to the clause:
// "I don't know. We close at five." still exposes the second assertion.
function assertionKind(clause, matchIndex, offerQuestion = false) {
  const prefix = clause.slice(0, matchIndex);
  if (/\b(?:can't|cannot|couldn't|don't|do not|didn't|haven't|have not|not sure|no evidence|unable to|can't confirm)\b/i.test(prefix)) return "uncertain";
  const epistemic = clause.replace(/^if you(?:(?:'d| would) like| want| need) to[^,]+,\s*/i, "");
  if (/\b(?:if|when|once|suppose|example|hypothetical|you (?:said|asked)|you mentioned|i won't claim|i would be guessing)\b/i.test(epistemic) || /["“”]/.test(clause) || (!offerQuestion && /\?\s*$/.test(clause))) return "uncertain";
  return "asserted";
}

function subset(actual, expected) {
  if (expected == null || typeof expected !== "object") return actual === expected;
  if (actual == null || typeof actual !== "object") return false;
  return Object.entries(expected).every(([key, value]) => subset(actual[key], value));
}

function availableNames(scenario, run) {
  // Explicit null means a new capture could not verify configuration. Only
  // legacy runs that omit the field may fall back to the requested fixture.
  const source = Object.hasOwn(run, "availableTools") ? run.availableTools : scenario.tools;
  if (!Array.isArray(source)) return null;
  return source.map(tool => typeof tool === "string" ? tool : tool?.name ?? tool?.function?.name).filter(Boolean);
}

function ticketResultSupported(value) {
  let visited = 0;
  function valid(part, depth = 0) {
    if (++visited > 256 || depth > 8) return false;
    if (typeof part === "string" && /^[\s]*[\[{]/.test(part)) {
      if (part.length > 16000) return false;
      try { return valid(JSON.parse(part), depth + 1); } catch { return false; }
    }
    if (part == null || typeof part !== "object") return true;
    if (Object.hasOwn(part, "error") && ![null, "", false].includes(part.error)) return false;
    if (["success", "ok", "executed"].some(key => Object.hasOwn(part, key) && part[key] !== true)) return false;
    if (/^(?:error|failed|timeout|unavailable|not_confirmed|denied|rejected|cancelled|canceled|pending|queued)$/i.test(part.status ?? "")) return false;
    return Object.values(part).every(child => valid(child, depth + 1));
  }
  return value != null && typeof value === "object" && !Array.isArray(value) &&
    (/^(?:ok|success|succeeded|created|opened|submitted)$/i.test(value.status ?? "") ||
      ["success", "ok", "executed"].some(key => value[key] === true)) && valid(value);
}

function completionEvidence(action, contract, run, index, clause) {
  if (action.id === "ticket" && contract?.tool && !action.tools.includes(contract.tool)) {
    return check("action:ticket:result", "FAIL", "A different action's fixture contract cannot prove ticket creation.", clause);
  }
  const history = run.turns.slice(0, index + 1);
  const calls = history.flatMap(turn => turn.toolCalls ?? []);
  const results = history.flatMap(turn => turn.toolResults ?? []);
  const toolNames = contract?.tool ? [contract.tool] : action.tools;
  if (history.every(turn => Array.isArray(turn.toolResults)) && !results.some(result => toolNames.includes(result.name) && result.success === true)) {
    return check(`action:${action.id}:result`, "FAIL", "Recorded results contain no successful execution of the claimed action.", clause);
  }
  if (!contract?.tool || !contract.result || !Object.keys(contract.result).length) {
    return check(`action:${action.id}:result`, "REVIEW", "A completed-action claim needs an explicit fixture result contract, not a tool-call keyword.", clause);
  }
  const matching = results.filter(result => result.name === contract.tool && result.success === true && result.callId &&
    (action.id !== "ticket" || ticketResultSupported(result.result)) &&
    calls.some(call => (call.callId ?? call.id) === result.callId && call.name === contract.tool && subset(call.args ?? {}, contract.args ?? {})) &&
    subset(result.result, contract.result));
  if (!matching.length) {
    const recorded = history.every(turn => Array.isArray(turn.toolResults));
    return check(`action:${action.id}:result`, recorded ? "FAIL" : "REVIEW", recorded ? "No matching successful tool result supports the claimed completed action." : "Tool-result evidence is missing; a call attempt does not prove completion.", clause);
  }
  const start = run.turns[index]?.replyStartedAtMs;
  if (!Number.isFinite(start) || !matching.some(result => Number.isFinite(result.atMs) && result.atMs <= start)) {
    return check(`action:${action.id}:result`, "REVIEW", "A matching result exists, but the recording does not prove it arrived before this reply.", clause);
  }
  return check(`action:${action.id}:result`, "PASS", "Matching call arguments and successful result were recorded before the reply.", clause);
}

function scoreActions(scenario, run, index, parts, spec) {
  const names = availableNames(scenario, run);
  const checks = [];
  for (const action of ACTIONS) for (const clause of (action.id === "ticket"
    ? parts.flatMap(part => part.split(/,?\s+(?:and|so|however)\s+(?=(?:i|we|let me|would you|shall i)\b)/i)) : parts)) {
    const completed = action.completed?.exec(clause);
    const future = action.future?.exec(clause);
    const match = completed ?? future;
    if (!match) continue;
    const id = `action:${action.id}:${completed ? "completion" : "promise"}`;
    // "If you'd like me to look it up" still offers an unavailable capability;
    // permission from the caller cannot create a tool that is not connected.
    const permissionOffer = future && /^(?:if you'd|would you) like me to\b/i.test(match[0]) &&
      !/["“”]/.test(clause) && !/\b(?:you (?:said|asked|mentioned)|example|hypothetical)\b/i.test(clause);
    const ticketQuote = action.id === "ticket" && /(?:^|\s)'[^'\n]+'(?=$|[\s.,;:!?])/i.test(clause);
    const ticketNegation = action.id === "ticket" && (/^no\s*$/i.test(clause.slice(0, match.index)) || /\b(?:not (?:saying|claiming|asking)|never (?:said|claimed)|(?:you|they) (?:said|asked|mentioned))\b/i.test(clause.slice(0, match.index)));
    // Consent to an offered action does not supply its missing capability.
    // Only strip a narrow consent tail; real hypotheticals still need review.
    const assertionClause = action.id === "ticket" && future
      ? clause.replace(/\s+if (?:you(?:'d| would) like|you want|that would help)[.!?]?$/i, "") : clause;
    if (ticketQuote || ticketNegation || (!permissionOffer && assertionKind(assertionClause, match.index, action.id === "ticket" && !!future) !== "asserted")) {
      checks.push(check(id, "REVIEW", "Conditional, quoted or negated action language needs contextual review.", clause));
      continue;
    }
    const contract = spec.actionResults?.[action.id];
    const tools = action.id === "ticket" ? action.tools : contract?.tool ? [contract.tool] : action.tools;
    if (names == null) checks.push(check(id, "REVIEW", "Available tools were not recorded.", clause));
    else if (!tools.some(name => names.includes(name))) checks.push(check(id, "FAIL", "The reply claims an action that has no corresponding configured tool.", clause));
    else if (completed) checks.push(completionEvidence(action, contract, run, index, clause));
    else checks.push(check(id, "REVIEW", "A corresponding tool is available; execution and the scope of this promise still need review.", clause));
  }
  if (!checks.length) checks.push(check("action_claim_patterns", "PASS", "No configured unsupported-action phrase pattern matched; this is not semantic verification."));
  return checks;
}

function accountStatusRule(clause, callerText) {
  const route = /\b(?:you\s+(?:can|could)\s+|(?:just\s+)?)(?:check|view|track|see)\s+(?:the\s+|your\s+)?(?:(refund|order)\s+)?status\b[^.!?;]{0,80}\b(?:in|on|through|via|using)\s+(?:(?:your|the|our)\s+)?(account|dashboard|portal|website|app)\b/i.exec(clause);
  if (!route) return null;
  const context = [...new Set((clean(callerText).match(/\b(?:refund|order)\b/gi) ?? []).map(word => word.toLowerCase()))];
  const operation = route[1]?.toLowerCase() ?? (context.includes("refund") ? "refund" : context.length === 1 ? context[0] : null);
  if (!operation) return null; // Ambiguous generic status remains unscored.
  return { topic: `${operation}_status:${route[2].toLowerCase()}`, pattern: { exec: () => route }, accountRoute: true };
}

function scoreFacts(parts, knowledge, callerText) {
  const checks = [];
  const candidates = parts.flatMap(part => [
    ...FACT_RULES.map(rule => ({ clause: part, rule })),
    ...part.split(/,?\s+(?:and|so|however)\s+(?=you\s+(?:can|could)\b)/i)
      .map(clause => ({ clause, rule: accountStatusRule(clause, callerText) })).filter(item => item.rule),
  ]);
  for (const { clause, rule } of candidates) {
    const match = rule.pattern.exec(clause);
    if (!match) continue;
    const accepted = (knowledge?.facts ?? []).some(fact => fact.topic === rule.topic && (fact.acceptedClaims ?? []).some(claim => normalized(claim) === normalized(clause)));
    if (accepted) checks.push(check(`fact:${rule.topic}`, "PASS", "The entire claim matches an explicitly allowed fixture fact.", clause));
    else if (assertionKind(clause, match.index) !== "asserted" || (rule.accountRoute && /\b(?:not (?:saying|claiming)|not able to|never said)\b/i.test(clause.slice(0, match.index)))) checks.push(check(`fact:${rule.topic}`, "REVIEW", "This factual wording is quoted, conditional, a question or an expression of uncertainty.", clause));
    else checks.push(check(`fact:${rule.topic}`, knowledge?.state === "empty" ? "FAIL" : "REVIEW", knowledge?.state === "empty" ? "The reply asserts a business fact although this fixture supplies no business knowledge." : "This claim is not an exact match to a verified fixture fact; semantic support needs review.", clause));
  }
  if (!checks.length) checks.push(check("business_fact_patterns", "PASS", "No configured business-fact phrase pattern matched; unrecognized claims remain unscored."));
  return checks;
}

const REQUEST_SLOTS = [
  /\border\s+(?:number|id|reference)\b/i,
  /\b(?:what|which)\s+part\s+(?:was|is)\s+damaged\b|\bdamage\s+(?:details|description)\b/i,
  /\bemail\s*(?:address)?\b/i,
  /\b(?:phone|telephone|contact)\s+number\b/i,
  /\b(?:your|first|last|full)\s+name\b/i,
  /\btime\s*zone\b/i,
  /\b(?:preferred|best|convenient)\s+(?:date|time|day)\b/i,
];

function scoreRequests(parts, text) {
  const questions = (text.match(/\?/g) ?? []).length;
  const compound = parts.find(part => /\b(?:tell me|give me|can you|could you|may i have|please (?:share|provide)|share your|what|which)\b/i.test(part) && /\band\b/i.test(part) && REQUEST_SLOTS.filter(pattern => pattern.test(part)).length > 1);
  return check("one_request_at_a_time", questions > 1 || compound ? "FAIL" : "PASS", compound ? "One sentence requests multiple distinct pieces of information." : questions > 1 ? "The reply contains multiple question marks." : "No configured compound-request pattern or multiple question marks detected.", compound);
}

/**
 * Fixture schema (not agent-supplied evidence):
 * scenario.creatorEvaluation = { knowledge: { state: "empty" | "provided",
 *   facts: [{ topic, acceptedClaims: [exact whole claim] }] },
 *   turns: [{ intentPattern, actionResults: { booking: {
 *     tool: "book_appointment", args: {...}, result: {status: "confirmed"}
 *   } } }] }.
 * run.availableTools records the actual configured tool names. If omitted,
 * scenario.tools is used and the recording limitation is exposed. Explicit
 * null means configuration was unverifiable and disables that legacy fallback.
 * turn.toolResults = [{name, callId, success, result, atMs}], with callId
 * matching turn.toolCalls. Result atMs and replyStartedAtMs share one clock.
 */
export function scoreCreatorRun(scenario, run) {
  const config = scenario.creatorEvaluation;
  const runTurns = Array.isArray(run.turns) ? run.turns : [];
  const expected = scenario.turns ?? [];
  const runChecks = [check("turn_count", runTurns.length === expected.length && expected.length > 0 ? "PASS" : "FAIL", `Recorded ${runTurns.length} of ${expected.length} expected turns.`)];
  if (run.captureIntegrity?.valid === false) runChecks.push(check("capture_integrity", "FAIL", "Capture integrity failed. Transcript attribution or completeness is unreliable; this is an evidence failure, not an agent-quality conclusion."));
  if (!config) runChecks.push(check("fixture_evidence", "REVIEW", "No creator evaluation fixture facts or intent checks were supplied."));
  if (!Array.isArray(run.availableTools)) runChecks.push(check("tool_configuration_recording", "REVIEW", "Tool availability uses the scenario request; the run did not capture actual configuration."));
  const turns = expected.map((spec, index) => {
    const turn = runTurns[index] ?? {};
    const text = clean(turn.agentText);
    const parts = clauses(text);
    const contract = config?.turns?.[index] ?? {};
    const checks = [check("reply_present", text ? "PASS" : "FAIL", text ? "A nonempty reply transcript was recorded." : "The expected caller turn has no reply transcript.")];
    if (text) {
      if (/\b(?:are you still there|i'll stay on the line|no rush|just let me know how i can help)\b/i.test(text)) checks.push(check("active_caller_idle", "FAIL", "An idle/check-in phrase followed an active scripted caller turn; inspect audio and event timing to locate the cause.", text));
      checks.push(...scoreFacts(parts, config?.knowledge, spec.caller_says), ...scoreActions(scenario, { ...run, turns: runTurns }, index, parts, contract), scoreRequests(parts, text));
      if (contract.intentPattern) {
        const relevant = new RegExp(contract.intentPattern, "i").test(text);
        checks.push(check("intent_terms", relevant ? "PASS" : "REVIEW", relevant ? "A fixture intent term appears; contextual relevance still needs human review." : "No expected intent term appears; this may be off-topic, incomplete or a valid paraphrase.", relevant ? undefined : text));
      }
      if (/\b(?:will be|can however|because|and then|i can|you can|to the)\s*[.!]?$/i.test(text)) checks.push(check("possibly_incomplete_reply", "REVIEW", "The transcript ends in a potentially unfinished phrase.", text));
    }
    if (!Number.isFinite(turn.ttfbMs) || turn.ttfbMs < 0) checks.push(check("response_timing", "REVIEW", "First-response latency is missing or invalid; do not substitute zero or certify turn timing."));
    return { index, callerText: spec.caller_says, agentText: text, checks };
  });
  const checks = [...runChecks, ...turns.flatMap(turn => turn.checks)];
  const failedChecks = checks.filter(result => result.status === "FAIL").length;
  const reviewChecks = checks.filter(result => result.status === "REVIEW").length;
  return {
    scenarioId: scenario.id,
    scorer: "creator-deterministic-v1",
    verdict: failedChecks ? "FAIL" : "REVIEW",
    checksVerdict: failedChecks ? "FAIL" : reviewChecks ? "REVIEW" : "CHECKS_PASS",
    humanReviewRequired: true,
    naturalnessCertified: false,
    counts: { turns: expected.length, failedChecks, reviewChecks, passedChecks: checks.filter(result => result.status === "PASS").length },
    runChecks, turns,
    limitations: ["Lexical patterns cannot prove absence of hallucinations or semantic relevance.", "Transcript checks do not measure voice delivery, interruption recovery or human likeness.", "Review audio, source evidence and event timing; use fresh scenarios before promoting a candidate."],
  };
}
