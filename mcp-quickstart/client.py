#!/usr/bin/env python3
"""MCP quickstart (Python) — drive the PyAI MCP server (@pyai/mcp) over stdio.

Spawns ``npx -y @pyai/mcp``, performs the MCP handshake, lists the tools, mints a
free sandbox key (no human steps) unless ``PYAI_API_KEY`` is already set, then
synthesizes speech to ``hello.mp3`` — proving "MCP -> working PyAI call" end to
end.

Transport: newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport).
Standard library only — Python 3.8+, plus Node (for ``npx``) on PATH.

    python3 client.py
"""

import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
HAVE_KEY = bool(os.environ.get("PYAI_API_KEY"))


class MCPStdioClient:
    """Minimal synchronous JSON-RPC client over a subprocess' stdio."""

    def __init__(self, command):
        # Diagnostics go to the server's stderr (inherited); stdout is pure JSON-RPC.
        self.proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            bufsize=1,
        )
        self._next_id = 0

    def _send(self, message):
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def notify(self, method, params=None):
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def request(self, method, params=None):
        self._next_id += 1
        rid = self._next_id
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        assert self.proc.stdout is not None
        # Read lines until we see the response with our id (skip blanks/noise).
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == rid:
                if "error" in msg:
                    raise RuntimeError(msg["error"].get("message", "JSON-RPC error"))
                return msg.get("result")
        raise RuntimeError("MCP server closed the connection before responding")

    def call_tool(self, name, arguments=None):
        result = self.request("tools/call", {"name": name, "arguments": arguments or {}})
        text = "\n".join(c.get("text", "") for c in (result or {}).get("content", []))
        try:
            return json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return text

    def close(self):
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.terminate()
        except Exception:
            pass


def main():
    client = MCPStdioClient(["npx", "-y", "@pyai/mcp"])
    try:
        # 1. Handshake.
        init = client.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "pyai-mcp-quickstart-py", "version": "1.0.0"},
            },
        )
        server = (init or {}).get("serverInfo", {}).get("name", "server")
        print(f"Connected to {server} (protocol {(init or {}).get('protocolVersion')}).")
        client.notify("notifications/initialized")

        # 2. Discover the tools.
        tools = client.request("tools/list").get("tools", [])
        print("Tools: " + ", ".join(t["name"] for t in tools))

        # 3. Get a key with no human steps (skip if one is already set). The server
        #    adopts the minted key for the rest of this session.
        if HAVE_KEY:
            print("Using PYAI_API_KEY from the environment.")
        else:
            key = client.call_tool("create_sandbox_key", {"label": "mcp-quickstart"})
            if isinstance(key, dict) and key.get("api_key"):
                print(
                    f"Minted sandbox key {str(key['api_key'])[:12]}… "
                    f"(org {key.get('org_id', '?')}); adopted for this session."
                )
            else:
                print("create_sandbox_key returned:", key)

        # 4. Synthesize speech. The MCP server writes the audio to output_path on
        #    this machine (it runs locally via npx).
        out_path = str(HERE / "hello.mp3")
        tts = client.call_tool(
            "synthesize_speech",
            {
                "input": "Hello from the PyAI MCP server.",
                "voice": "nova",
                "response_format": "mp3",
                "output_path": out_path,
            },
        )
        print("synthesize_speech:", tts)
        print(f"\nDone — play {out_path}")
    except (RuntimeError, FileNotFoundError) as err:
        print("Error:", err, file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
