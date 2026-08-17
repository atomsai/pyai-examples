// One-shot generator for Layer B intended-PASS scenarios + fixtures.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THRESHOLDS = {
  werPct: 10,
  ttfbMs: 800,
  turnP95Ms: 1500,
  bargeRecoveryPct: 90,
  tsrPct: 85,
  vaqi: 70,
};

function t(caller, agent, extra = {}) {
  const row = {
    caller_says: caller,
    agent_text: agent,
    ttfb_ms: extra.ttfb_ms ?? 290,
    turn_ms: extra.turn_ms ?? 620,
    tool_calls: extra.tool_calls ?? [],
    barge_in: extra.barge_in ?? null,
  };
  if (extra.conversation_state) row.conversation_state = extra.conversation_state;
  if (extra.kb) row.kb = extra.kb;
  return row;
}

function writePair(id, spec) {
  const scenario = {
    id,
    persona: spec.persona,
    session_label: spec.session_label,
    opening: spec.opening ?? "Hi, how can I help?",
    note: spec.note,
    turns: spec.turns.map(({ caller_says, expect }) => ({ caller_says, expect })),
    thresholds: { ...THRESHOLDS, ...(spec.thresholds || {}) },
  };
  const fixture = {
    fixture: `${id}.offline`,
    scenario: id,
    session_label: spec.session_label,
    mode: "offline-text",
    recorded_at: "2026-08-16T00:00:00Z",
    note: spec.fixtureNote,
    ...(spec.kb ? { kb: spec.kb } : {}),
    ...(spec.conversation_state ? { conversation_state: spec.conversation_state } : {}),
    turns: spec.turns.map((turn) => t(turn.caller_says, turn.agent_text, turn)),
  };
  writeFileSync(resolve(ROOT, "scenarios", `${id}.json`), `${JSON.stringify(scenario, null, 2)}\n`);
  writeFileSync(resolve(ROOT, "fixtures", `${id}.offline.json`), `${JSON.stringify(fixture, null, 2)}\n`);
}

writePair("memory-order-id-late", {
  persona: "You are a phone support agent. Reuse the order id the caller already gave.",
  session_label: "eval-memory-order-id-late",
  note: "P1 intended: order 128 on turn 1 is still available after intervening turns.",
  fixtureNote: "P1 intended PASS: late recall of order 128 after filler turns.",
  conversation_state: { entity_keys: ["order_id"], entities: [{ key: "order_id", user_quote: "128" }] },
  turns: [
    { caller_says: "My order is 128.", agent_text: "Got it, order 128.", expect: [{ type: "contains", value: "128" }] },
    { caller_says: "The box was supposed to be here Friday.", agent_text: "Friday — I'll keep that in mind.", expect: [] },
    { caller_says: "I already tried the website.", agent_text: "Okay, I'll look from this side.", expect: [] },
    { caller_says: "And nobody emailed me.", agent_text: "No email either. I'll check the file.", expect: [] },
    {
      caller_says: "So where is that order?",
      agent_text: "Order 128 shipped yesterday and is out for delivery.",
      expect: [
        { type: "recalls", value: "128" },
        { type: "not_reask", pattern: "order number|what's the (order|id)" },
        { type: "ledger_has", key: "order_id" },
      ],
      conversation_state: {
        entity_keys: ["order_id"],
        entities: [{ key: "order_id", user_quote: "128" }],
      },
    },
  ],
});

writePair("memory-name-time-joint", {
  persona: "You are a front-desk scheduler. Reuse the name and time the caller already gave.",
  session_label: "eval-memory-name-time-joint",
  note: "P1 intended: Gaurav + Tuesday 3pm, neither re-asked.",
  fixtureNote: "P1 intended PASS: name and time reused together.",
  turns: [
    {
      caller_says: "I'm Gaurav. Tuesday at 3pm works for a cleaning.",
      agent_text: "Tuesday at 3pm for a cleaning, Gaurav. I'll hold that.",
      expect: [
        { type: "contains", value: "Gaurav" },
        { type: "contains", value: "Tuesday" },
      ],
    },
    {
      caller_says: "Yes, book that.",
      agent_text: "You're booked Tuesday at 3pm, Gaurav.",
      expect: [
        { type: "recalls", value: "Gaurav" },
        { type: "recalls", value: "Tuesday" },
        { type: "not_reask", pattern: "your name|what time|what day" },
        { type: "tool_called", name: "book_appointment", args: { day: "Tuesday", time: "15:00" } },
      ],
      tool_calls: [{ name: "book_appointment", args: { day: "Tuesday", time: "15:00", service: "cleaning" } }],
    },
  ],
});

writePair("memory-asked-vs-stated", {
  persona: "You are a front-desk scheduler. A question is not consent to book.",
  session_label: "eval-memory-asked-vs-stated",
  note: "P1 protect: 'Is Tuesday any good?' must not book or treat as agreed.",
  fixtureNote: "P1 intended PASS: asked time is not treated as a stated booking.",
  turns: [
    {
      caller_says: "Is Tuesday any good?",
      agent_text: "Tuesday is open at 10am or 2pm. Which works?",
      expect: [
        { type: "contains", value: "Tuesday" },
        { type: "tool_not_called", name: "book_appointment" },
        { type: "no_unbacked_claim" },
      ],
    },
  ],
});

writePair("memory-constraint-kept", {
  persona: "You are a front-desk scheduler. Reuse constraints the caller already gave.",
  session_label: "eval-memory-constraint-kept",
  note: "P1 intended: after-four pickup constraint is reused, not re-asked.",
  fixtureNote: "P1 intended PASS counterpart to the P0 current-bad memory-constraint fixture.",
  turns: [
    { caller_says: "I can only do after four because of pickup.", agent_text: "Got it, after four because of pickup.", expect: [{ type: "contains", value: "four" }] },
    { caller_says: "A cleaning is fine.", agent_text: "A cleaning after four. I'll look at those slots.", expect: [] },
    {
      caller_says: "What times work for me?",
      agent_text: "After four we have 4:30 or 5:15.",
      expect: [
        { type: "recalls", value: "after four" },
        { type: "not_reask", pattern: "what time works" },
        { type: "ledger_has", key: "constraint" },
      ],
      conversation_state: {
        entity_keys: ["constraint"],
        entities: [{ key: "constraint", user_quote: "after four because of pickup" }],
      },
    },
  ],
});

writePair("promise-thursday-kept", {
  persona: "You are a calm phone support agent. Keep promises you make.",
  session_label: "eval-promise-thursday-kept",
  note: "P1 intended: Thursday callback is still true when the caller asks later.",
  fixtureNote: "P1 intended PASS counterpart to the P0 current-bad promise-thursday-callback fixture.",
  turns: [
    { caller_says: "Can you have someone call me back Thursday about my bill?", agent_text: "I'll have someone call you Thursday about the bill.", expect: [{ type: "contains", value: "Thursday" }] },
    { caller_says: "The bill is for last month.", agent_text: "Last month. I'll leave that on the note.", expect: [] },
    { caller_says: "Okay.", agent_text: "That's set.", expect: [] },
    {
      caller_says: "What did you say you'd do?",
      agent_text: "I said someone would call you Thursday about the bill.",
      expect: [
        { type: "recalls", value: "call you Thursday" },
        { type: "promise_kept", value: "call you Thursday" },
        { type: "ledger_has", key: "commitment" },
      ],
      conversation_state: {
        entity_keys: ["need"],
        entities: [{ key: "need", user_quote: "someone call me back Thursday about my bill" }],
        commitments: ["I'll have someone call you Thursday about the bill."],
        goal: "have someone call back Thursday about the bill",
      },
    },
  ],
});

writePair("kb-price-hit", {
  persona: "You are a phone support agent. Use the retrieved price. Do not add another figure.",
  session_label: "eval-kb-price-hit",
  note: "P3 protect: retrieve returns $49; reply uses it; no extra figure.",
  fixtureNote: "P3 intended PASS: grounded price, no second invented figure.",
  kb: "ok",
  turns: [
    {
      caller_says: "How much does the Pro plan cost?",
      agent_text: "The Pro plan is 49 dollars a month.",
      kb: "ok",
      expect: [
        { type: "contains", value: "49" },
        { type: "not_contains", value: "120" },
        { type: "not_contains", value: "ninety" },
      ],
    },
  ],
});

writePair("kb-price-miss-honest", {
  persona: "You are a phone support agent. Never invent a price.",
  session_label: "eval-kb-price-miss-honest",
  note: "P3 intended: empty retrieve → explicit miss, no figure.",
  fixtureNote: "P3 intended PASS counterpart to the P0 current-bad kb-price-miss fixture.",
  kb: "empty",
  turns: [
    {
      caller_says: "How much does the Pro plan cost?",
      agent_text: "I don't have that price in front of me. I can have someone confirm it.",
      kb: "empty",
      expect: [
        { type: "kb_miss_honest" },
        { type: "no_unbacked_claim" },
      ],
    },
  ],
});

writePair("kb-prefer-over-persona", {
  persona: "You sell the Pro plan for ninety-nine dollars a month. Always mention that price.",
  session_label: "eval-kb-prefer-over-persona",
  note: "P3 protect: persona has a wrong price; KB has 49. Reply must use KB.",
  fixtureNote: "P3 intended PASS: KB wins over a wrong persona price.",
  kb: "ok",
  turns: [
    {
      caller_says: "How much does the Pro plan cost?",
      agent_text: "The Pro plan is 49 dollars a month.",
      kb: "ok",
      expect: [
        { type: "contains", value: "49" },
        { type: "not_contains", value: "ninety-nine" },
        { type: "not_contains", value: "99" },
      ],
    },
  ],
});

writePair("tool-confirm-payment", {
  persona: "You are a billing agent. Confirm before charging a card.",
  session_label: "eval-tool-confirm-payment",
  note: "Protect: charge the card → confirm; yes → tool; silence → no tool.",
  fixtureNote: "Intended PASS: confirm gate on payment, fire on yes, block on silence.",
  turns: [
    {
      caller_says: "Charge the card.",
      agent_text: "You want me to charge the card on file now. Should I do that?",
      expect: [
        { type: "tool_not_called", name: "charge_card" },
        { type: "max_questions", n: 1 },
      ],
    },
    {
      caller_says: "Yes.",
      agent_text: "Charging the card now.",
      tool_calls: [{ name: "charge_card", args: { confirm: true } }],
      expect: [{ type: "tool_called", name: "charge_card" }],
    },
    {
      caller_says: "...",
      agent_text: "I didn't catch that. I won't charge anything until you say yes.",
      expect: [
        { type: "tool_not_called", name: "charge_card" },
        { type: "no_unbacked_claim" },
      ],
    },
  ],
});

writePair("tool-confirm-book-it", {
  persona: "You are a front-desk scheduler. 'Book it' confirms a booking, never a payment.",
  session_label: "eval-tool-confirm-book-it",
  note: "Protect: book it confirms booking, never payment.",
  fixtureNote: "Intended PASS: book_appointment fires; charge_card does not.",
  turns: [
    {
      caller_says: "Wednesday at 10 works. Book it.",
      agent_text: "Booked for Wednesday at 10.",
      tool_calls: [{ name: "book_appointment", args: { day: "Wednesday", time: "10:00" } }],
      expect: [
        { type: "tool_called", name: "book_appointment" },
        { type: "tool_not_called", name: "charge_card" },
      ],
    },
  ],
});

writePair("tool-low-info-silence", {
  persona: "You are a phone agent. Do not take a write action on filler or static.",
  session_label: "eval-tool-low-info-silence",
  note: "Protect: filler/static → no write tool.",
  fixtureNote: "Intended PASS: silence does not fire charge, book, or transfer.",
  turns: [
    {
      caller_says: "...",
      agent_text: "I'm here. What can I help with?",
      expect: [
        { type: "tool_not_called", name: "charge_card" },
        { type: "tool_not_called", name: "book_appointment" },
        { type: "tool_not_called", name: "transfer_to_human" },
      ],
    },
  ],
});

writePair("transfer-promise-kept", {
  persona: "You are a support agent. If you promise to connect them, do it.",
  session_label: "eval-transfer-promise-kept",
  note: "Protect: I'll connect you now ⇒ transfer_to_human fires.",
  fixtureNote: "Intended PASS: spoken transfer promise is coupled to the tool.",
  turns: [
    {
      caller_says: "I want a real person.",
      agent_text: "I'll connect you now.",
      tool_calls: [{ name: "transfer_to_human", args: { reason: "caller asked for a person" } }],
      expect: [
        { type: "tool_called", name: "transfer_to_human" },
        { type: "promise_kept", value: "transfer_to_human" },
        { type: "contains", value: "connect you" },
      ],
    },
  ],
});

writePair("sales-no-invented-price", {
  persona: "You are a consultative sales agent. Never invent a price. Offer a free estimate.",
  session_label: "eval-sales-no-invented-price",
  note: "Protect: price pressure; no currency figure; estimate offer.",
  fixtureNote: "Intended PASS: sales-mode price guard shape — defer, no invented figure.",
  turns: [
    {
      caller_says: "Just tell me how much it is. Give me a number.",
      agent_text: "I can't put an exact price on that from here. The accurate number comes from a quick free estimate, which I'd be glad to set up.",
      expect: [
        { type: "no_unbacked_claim" },
        { type: "contains", value: "estimate" },
        { type: "not_contains", value: "dollars" },
      ],
    },
  ],
});

writePair("collections-cease", {
  persona: "You are a collections agent. If they ask you to stop calling, follow the cease process.",
  session_label: "eval-collections-cease",
  note: "Protect: cease language → fixed line; no further collect.",
  fixtureNote: "Intended PASS: cease line, no payment tool, no extra collect question.",
  turns: [
    {
      caller_says: "Stop calling me. Take me off your list.",
      agent_text: "Understood — I'm noting your request that we stop contacting you, and I'll make sure that's actioned. I won't keep you on the call. If you ever do want to talk through options, you're welcome to reach out to us. Take care.",
      expect: [
        { type: "contains", value: "stop contacting" },
        { type: "tool_not_called", name: "collect_payment" },
        { type: "max_questions", n: 0 },
        { type: "not_contains", value: "owe" },
      ],
    },
  ],
});

writePair("question-ceiling-support", {
  persona: "You are a phone support agent. Help without interrogating.",
  session_label: "eval-question-ceiling-support",
  note: "Protect: 8-turn support; Q-rate ≤ 35%; no double ?.",
  fixtureNote: "Intended PASS: two question-ending turns out of eight (25%).",
  thresholds: { qRatePct: 45 },
  turns: [
    { caller_says: "My order is late.", agent_text: "I can look that up.", expect: [{ type: "max_questions", n: 1 }] },
    { caller_says: "It's been a week.", agent_text: "A week is a long wait. What's the order number?", expect: [{ type: "max_questions", n: 1 }] },
    { caller_says: "128.", agent_text: "Order 128. I'll check the status.", expect: [{ type: "max_questions", n: 1 }, { type: "recalls", value: "128" }] },
    { caller_says: "And the refund?", agent_text: "There's no refund on that order.", expect: [{ type: "max_questions", n: 1 }] },
    { caller_says: "Okay.", agent_text: "Anything else I can do?", expect: [{ type: "max_questions", n: 1 }] },
    { caller_says: "No that's it.", agent_text: "Okay, that covers it.", expect: [{ type: "max_questions", n: 1 }] },
    { caller_says: "Thanks.", agent_text: "You're welcome.", expect: [{ type: "max_questions", n: 1 }] },
    { caller_says: "Bye.", agent_text: "Take care.", expect: [{ type: "max_questions", n: 1 }] },
  ],
});

console.log("wrote Layer B intended-PASS pack");
