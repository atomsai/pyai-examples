// omni-eval-harness — entry point.
//
// Two modes:
//   OFFLINE (default)  replays a recorded session fixture and scores it. No
//                      network, no key — safe in CI. This is what `npm test`
//                      and `npm run offline` use.
//   LIVE (--live)      connects to the real PyAI surfaces as a synthetic caller
//                      (Speak -> Omni, plus the Hear stream for caller-audio
//                      WER), captures the session, and scores it. GATED on
//                      PYAI_API_KEY: with no key it skips cleanly and exits 0.
//
// Usage:
//   node src/run.js [scenario] [--live] [--mode voice|text] [--fixture <path>]
//                   [--out <dir>] [--agent-id <id>] [--voice <id>]
//                   [--base-url <url>] [--no-exit-code]
//
//   scenario  a path (scenarios/foo.json) or bare id (foo). Default:
//             scenarios/appointment-booking.json
//
// Exit code: 0 on PASS/WARN, 1 on FAIL (so it can gate CI). Disable with
// --no-exit-code.

import { fileURLToPath } from "node:url";
import { loadScenario, resolveScenarioPath } from "./scenario.js";
import { loadFixture, resolveFixturePath } from "./fixture.js";
import { evaluate } from "./scorers.js";
import { renderMarkdown, writeScorecard } from "./scorecard.js";

const BASE_DIR = fileURLToPath(new URL("..", import.meta.url));

function parseArgs(argv) {
  const opts = {
    scenario: "appointment-booking",
    live: false,
    mode: "voice",
    fixture: null,
    out: "out",
    agentId: null,
    voice: null,
    baseURL: null,
    exitCode: true,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--live": opts.live = true; break;
      case "--mode": opts.mode = argv[++i]; break;
      case "--text": opts.mode = "text"; break;
      case "--voice-mode": opts.mode = "voice"; break;
      case "--fixture": opts.fixture = argv[++i]; break;
      case "--out": opts.out = argv[++i]; break;
      case "--agent-id": opts.agentId = argv[++i]; break;
      case "--voice": opts.voice = argv[++i]; break;
      case "--base-url": opts.baseURL = argv[++i]; break;
      case "--no-exit-code": opts.exitCode = false; break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        positionals.push(a);
    }
  }
  if (positionals[0]) opts.scenario = positionals[0];
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const scenario = loadScenario(resolveScenarioPath(opts.scenario, BASE_DIR));
  const agentId = opts.agentId ?? process.env.PYAI_AGENT_ID ?? scenario.agent_id ?? "harness-agent";

  let run;
  if (opts.live) {
    const apiKey = process.env.PYAI_API_KEY;
    // Dormant gate: behave exactly like the rest of the repo's live paths —
    // when the key is absent, skip cleanly and exit 0 so CI stays green.
    if (!apiKey) {
      console.error("[live] PYAI_API_KEY not set — skipping live run (dormant gate). Exit 0.");
      console.error("[live] Set PYAI_API_KEY (a pyai_test_ sandbox key is fine) to run against api.pyai.com.");
      process.exit(0);
    }
    let runLive;
    try {
      ({ runLive } = await import("./live.js"));
    } catch (err) {
      console.error(`[live] could not load the live runner: ${err.message}`);
      process.exit(2);
    }
    try {
      run = await runLive(scenario, {
        apiKey,
        agentId,
        mode: opts.mode,
        voice: opts.voice ?? process.env.PYAI_VOICE,
        baseURL: opts.baseURL ?? process.env.PYAI_BASE_URL,
      });
    } catch (err) {
      console.error(`[live] run failed: ${err.message}`);
      process.exit(2);
    }
  } else {
    const fixturePath = opts.fixture
      ? resolveFixturePath(opts.fixture, BASE_DIR)
      : resolveFixturePath(scenario.id, BASE_DIR);
    run = loadFixture(fixturePath);
    run.agentId = run.agentId ?? agentId;
    run.source = rel(fixturePath); // show a repo-relative path in the scorecard
  }

  const scorecard = evaluate(scenario, run);
  const { mdPath, jsonPath } = writeScorecard(scorecard, resolveOut(opts.out), scenario.id);

  console.log(renderMarkdown(scorecard));
  console.error(`\nwrote ${rel(mdPath)} and ${rel(jsonPath)}`);

  if (opts.exitCode && scorecard.verdict === "FAIL") process.exit(1);
}

function resolveOut(out) {
  return out.startsWith("/") ? out : fileURLToPath(new URL(`../${out}`, import.meta.url));
}

function rel(p) {
  return p.startsWith(BASE_DIR) ? p.slice(BASE_DIR.length) : p;
}

// Only run the CLI when invoked directly (so importing this file is side-effect free).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exit(2);
  });
}
