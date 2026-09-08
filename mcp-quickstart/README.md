# PyAI MCP quickstart

For ChatGPT, Claude, Cursor, Codex and Devin, use the remote OAuth endpoint:
`https://api.pyai.com/mcp`. Complete instructions: https://pyai.com/mcp.

These small Python and JavaScript examples demonstrate local stdio without an
MCP client dependency. Run `npx -y @pyai/mcp@latest login` first (Node.js 22+),
then from this directory run `node index.mjs` or `python3 client.py`.
The example generates a short audio file using the authorized project.

Local MCP reuses the saved CLI profile or `PYAI_API_KEY` from the environment.
Pass `--sandbox` explicitly to create an isolated sandbox for the example.
The server adopts its key privately; it never returns that key to the client.
The output file must not already exist. Do not paste credentials into prompts.

Read https://pyai.com/mcp-agent-guide.md for discovery, typed inputs, product
recipes, polling, audio results and error recovery.
