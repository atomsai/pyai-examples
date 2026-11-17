# PyAI MCP quickstart

For hosted MCP in ChatGPT, Claude, Cursor, Codex or Devin, use
`https://api.pyai.com/mcp` with browser OAuth. Setup: https://pyai.com/mcp.

These JavaScript and Python examples run **local stdio**, using the published
`@pyai/mcp@0.5.18` server. Node.js 22+ is required; Python also needs Python 3.8+.
They need no client dependencies. A hosted MCP result is not a local file; these
examples can verify a file because the MCP server runs on the same machine.

## Inspect first: no speech request

Authenticate an existing project with `npx -y @pyai/mcp@0.5.18 login`, then run:

```sh
node index.mjs
# Or:
python3 client.py
```

Both commands list available tools and call `whoami`, showing organization and
project names and IDs, test/live environment, scopes, limits, credit, billing
notice and any managed payer/budget. They **do not synthesize by default**.
Missing credentials, empty or malformed limits/credit objects, or failed identity
inspection stop the run. Zero and false fields inside populated objects are
valid context; they do not by themselves authorize spending. No project is
created automatically and there is no fallback to another credential.

Use `--profile NAME` to select a saved CLI profile. `PYAI_API_KEY`, if set,
**overrides the profile**. Verify the returned project ID. Never paste keys into
prompts or put them in browser code.

## Explicitly request one clip

After reviewing identity, billing and your approved allowance, substitute the
inspected project ID below:

```sh
node index.mjs --generate --project proj_YOUR_INSPECTED_ID
# Or:
python3 client.py --generate --project proj_YOUR_INSPECTED_ID
```

For a **live** project, `--allow-live` is also required. This acknowledges that
usage may incur charges; it does **not** establish or enforce a dollar cap.
Obtain a separately approved budget and verify the account controls before
using a live project. A daily unit cap, enterprise plan, credit balance,
`credit.gated=false` or a null key budget is not evidence of free usage.

The script rechecks identity and permission, then submits exactly one short
Speak request, with no retries. `hello.wav` must not already exist. The local
server saves it in the example directory. Success requires a successful tool
result, the expected output path and byte count, and a nonempty complete PCM16
WAV with consistent headers and sample alignment. It reports duration. **File
validation does not establish audible quality**: play the saved file to confirm.

A tool error, disconnect, timeout or invalid/missing file exits unsuccessfully.
A delivery failure does not prove synthesis failed: preserve any output, inspect
the result and usage, and do not automatically repeat the request.

## Optional new test project (local only)

`--sandbox` explicitly creates a **new isolated test project**, adopting its key
privately for this MCP process. It replaces the selected identity for this run;
it does not save the key to a CLI profile. Creation can fail due to rate limits
or service errors; failure stops the run with no fallback or synthesis.

```sh
node index.mjs --sandbox             # create + inspect only
python3 client.py --sandbox          # alternative; creates another project
```

To explicitly request creation **and** one clip in the same session, combine
`--sandbox --generate`. The client verifies that `whoami` matches the newly
created organization/project and has environment `test`. It prints identity and
billing before submission. Do not combine `--sandbox` with `--project`; use the
saved profile path for a previously confirmed project. Each invocation creates a
new tenant; avoid repeated sandbox creation.

Test API usage is excluded from monetary billing by the server's environment
accounting rules; daily and concurrency limits still apply. This is separate
from the credit gate and does not extend to an existing live profile, managed
carrier calls, or third-party client fees. Inspect actual limits and stop on
quota/billing errors. This example does not perform a paid billing test.

## Offline regression checks

```sh
npm test
# Equivalent (requires node on PATH):
python3 test_quickstart.py
```

The tests run both real entrypoints against a fake stdio server, without network
calls or speech generation. They cover live saved-profile/environment identities,
missing credentials, explicit project/live consent, failed sandbox creation,
identity mismatch, tool errors, disconnects, existing output and missing, empty,
malformed, truncated or incorrectly reported audio files. Empty and malformed
identity context is rejected in both clients. These fixtures do not wait through
the full 120-second timeout, enforce a real monetary cap, or establish audible
quality; a real TTS-to-file-to-STT journey is a separate acceptance test.

See https://pyai.com/mcp-agent-guide.md for hosted output contracts, discovery,
polling and error recovery.
