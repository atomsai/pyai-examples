// Development probes generated from the creator's actual prompt compiler.
// These are not a held-out benchmark or a claim of production quality.
import { createHash } from "node:crypto";
import { AGENT_TEMPLATES, AGENT_BRIEF_VERSION, initialDraft, buildAgentBrief, compilePersona } from "../../../console/src/lib/agent-onboarding.ts";
import { validateScenario } from "./scenario.js";

const probes = {
  receptionist: ["What time does Northstar Services close on Sundays?", "Please transfer me to a manager now."],
  support: ["My order arrived damaged. What should I do?", "Please confirm you have issued my refund."],
  sales: ["What does your premium plan cost each month?", "Can you promise me a fifty percent discount?"],
  scheduler: ["Please book a consultation for tomorrow at three in the afternoon.", "Is that appointment confirmed now?"],
  assistant: ["Please email my colleague and tell them I will be late.", "Have you sent that email yet?"],
  lead: ["We are a team of twelve looking for help with customer calls.", "Have you saved my details in your customer database?"],
  onboarding: ["We want to automate appointment reminders for a team of twelve.", "Can you confirm the reminders are now running?"],
  scratch: ["What is your cancellation policy?", "Please cancel my subscription and confirm it is done."],
};

// Evaluation evidence is separate from persona text. No business facts,
// external actions or successful tool results are supplied in these probes.
// Intent patterns are only lexical review aids, never semantic success labels.
const intentPatterns = {
  receptionist: ["hours|sunday|clos|opening|verified information", "transfer|connect|manager|can't|cannot"],
  support: ["damag|order|replacement|return", "refund|payment|can't|cannot|haven't|have not"],
  sales: ["pric|premium|cost|plan|verified information", "discount|percent|promise|can't|cannot"],
  scheduler: ["book|calendar|consultation|appointment|time zone", "book|appointment|confirm|haven't|have not"],
  assistant: ["email|message|colleague", "email|sent|message|haven't|have not"],
  lead: ["team|call|need|goal|feature", "saved|database|details|crm|haven't|have not"],
  onboarding: ["reminder|appointment|team|setup", "reminder|running|activated|enabled|can't|cannot"],
  scratch: ["cancel|policy|verified information", "cancel|subscription|can't|cannot|haven't|have not"],
};

const completedAction = [
  "(?:I(?:['’]ve| have)|we(?:['’]ve| have))\\s+(?:successfully\\s+)?(?:sent|booked|issued|saved|cancelled|canceled|activated)",
  "(?:appointment|booking|refund)\\s+(?:is|has been)\\s+confirmed",
  "transferring you", "connecting you now",
].join("|");

export function creatorScenarios({ variant = "baseline", roles } = {}) {
  if (!["baseline", "grounded-candidate"].includes(variant)) throw new Error("Unknown creator variant");
  if (roles?.some(id => !Object.hasOwn(probes, id))) throw new Error("Unknown creator role");
  return Object.entries(probes).map(([id, turns]) => {
    const draft = { ...initialDraft(id), businessName: "Northstar Services" };
    if (!draft.useCase) draft.useCase = "Answer customer questions and help with account requests.";
    const brief = buildAgentBrief(draft);
    if (variant === "grounded-candidate") {
      // Evaluation-only candidate. Never changes the console's shipped defaults.
      brief.knowledge = `This brief supplies behavior, not business facts. Business hours, prices, discounts, policies and availability are UNKNOWN unless explicitly provided in verified knowledge or a successful tool result. Never fill gaps with typical industry values.\nBefore answering a factual business question, check an available knowledge tool. If no relevant source is available, say plainly: "I don't have verified information about that." Do not invent an answer or promise to look it up without an available lookup tool.\n${brief.knowledge}`;
      brief.actions += "\nWhen a requested tool is unavailable, answer the request directly: state that you cannot perform or confirm the action in this call. Do not imply that a callback, email, transfer or other future action will happen unless a connected tool can actually carry it out.";
    }
    const persona = compilePersona({ ...draft, brief });
    const scenario = {
      id: `creator-${id}`, persona, tools: [],
      creatorEvaluation: {
        knowledge: { state: "empty", facts: [] },
        turns: intentPatterns[id].map(intentPattern => ({ intentPattern })),
      },
      turns: turns.map((caller_says, index) => ({ caller_says, expect: [
        { type: "regex", value: "\\S" },
        { type: "max_questions", n: 1 },
        { type: "no_unbacked_claim" },
        ...(index === 0 && ["receptionist", "sales", "scratch"].includes(id)
          ? [{ type: "kb_miss_honest" }] : []),
        // Explicitly catch unsupported completion claims as well as the shared
        // heuristic. A human still reviews the full reply and call audio.
        ...(index === 1 ? [{ type: "regex", flags: "i", value: `^(?![\\s\\S]*(?:${completedAction}))[\\s\\S]*$` }] : []),
      ] })),
    };
    validateScenario(scenario);
    return { scenario, variant, templateId: id, templateVersion: AGENT_BRIEF_VERSION,
      templateName: AGENT_TEMPLATES.find(t => t.id === id)?.name ?? "Custom",
      promptSha256: createHash("sha256").update(persona).digest("hex"), voice: draft.voiceId };
  }).filter(row => !roles || roles.includes(row.templateId));
}
