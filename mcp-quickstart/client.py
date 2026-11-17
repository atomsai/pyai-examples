#!/usr/bin/env python3
"""Local MCP stdio: discovery, identity and billing inspection by default.
--sandbox explicitly creates a NEW session-only test project, never automatic.
Speech requires --generate plus --project ID (or --sandbox); live additionally
requires --allow-live and a separately approved budget. No automatic retries.
Standard library only, Python 3.8+ and Node.js 22+ on PATH.
"""
import argparse
import json
import os
import queue
import struct
import subprocess
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent

class MCPStdioClient:
    def __init__(self, command):
        self.proc = subprocess.Popen(command, cwd=HERE, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, text=True, bufsize=1)
        self._next_id = 0
        self.lines = queue.Queue()
        def read():
            for line in self.proc.stdout:
                self.lines.put(line)
            self.lines.put(None)
        threading.Thread(target=read, daemon=True).start()

    def _send(self, message):
        self.proc.stdin.write(json.dumps(message) + '\n')
        self.proc.stdin.flush()

    def notify(self, method, params=None):
        self._send({'jsonrpc':'2.0', 'method':method, 'params':params or {}})

    def request(self, method, params=None):
        self._next_id += 1
        rid = self._next_id
        self._send({'jsonrpc':'2.0', 'id':rid, 'method':method, 'params':params or {}})
        import time
        deadline = time.monotonic() + 120
        while True:
            try:
                line = self.lines.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty:
                raise RuntimeError('MCP timed out; speech may have completed. Do not retry automatically.')
            if line is None:
                raise RuntimeError('MCP exited before responding; no automatic retry.')
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get('id') == rid:
                if 'error' in msg:
                    raise RuntimeError('MCP request failed; no automatic retry.')
                return msg.get('result')

    def call_tool(self, name, arguments=None):
        result = self.request('tools/call', {'name':name, 'arguments':arguments or {}})
        if not result or result.get('isError'):
            raise RuntimeError(f'{name} failed; stopped without retry. Speech may have completed; inspect artifacts before another request. For whoami, run pyai login or explicitly choose --sandbox.')
        if result.get('structuredContent') is not None:
            return result['structuredContent']
        text = '\n'.join(c.get('text','') for c in result.get('content',[]) if c.get('type') == 'text')
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {'text':text}

    def close(self):
        if self.proc.stdin:
            self.proc.stdin.close()
        if self.proc.poll() is None:
            self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()


def validate_wav(path):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError('Output is not a regular WAV file.')
    b = path.read_bytes()
    if len(b) < 44 or b[:4] != b'RIFF' or b[8:12] != b'WAVE' or struct.unpack_from('<I',b,4)[0] != len(b)-8:
        raise RuntimeError('Output is not a complete RIFF WAV file.')
    fmt, data, p = None, None, 12
    while p + 8 <= len(b):
        tag, n = struct.unpack_from('<4sI',b,p)
        start = p + 8
        if start+n > len(b):
            raise RuntimeError('Truncated WAV chunk.')
        if tag == b'fmt ':
            if fmt is not None or n < 16:
                raise RuntimeError('Invalid WAV format chunk.')
            fmt = struct.unpack_from('<HHIIHH',b,start)
        if tag == b'data':
            if data is not None:
                raise RuntimeError('Duplicate WAV data.')
            data = n
        p = start+n+(n % 2)
    if p != len(b) or not fmt:
        raise RuntimeError('Invalid WAV chunks.')
    codec, channels, rate, byte_rate, align, bits = fmt
    if codec != 1 or bits != 16 or channels not in (1,2) or not 8000 <= rate <= 192000 or align != channels*2 or byte_rate != rate*align or not data or data % align:
        raise RuntimeError('Output is not a nonempty, complete PCM16 WAV.')
    return len(b), data/byte_rate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sandbox', action='store_true')
    parser.add_argument('--generate', action='store_true')
    parser.add_argument('--project')
    parser.add_argument('--profile')
    parser.add_argument('--allow-live', action='store_true')
    args = parser.parse_args()
    if args.sandbox and args.project:
        parser.error('--sandbox creates a new project; do not combine it with --project.')
    client = MCPStdioClient(['npx','-y','@pyai/mcp@0.5.18'] + (['--profile',args.profile] if args.profile else []))
    try:
        init = client.request('initialize', {'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'pyai-mcp-quickstart-py','version':'1.1.0'}})
        print(f"Connected to {init.get('serverInfo',{}).get('name','MCP')} (local stdio).")
        client.notify('notifications/initialized')
        tools = client.request('tools/list')['tools']
        print('Tools: ' + ', '.join(t['name'] for t in tools))
        created = None
        if args.sandbox:
            created = client.call_tool('create_sandbox_key', {'label':'mcp-quickstart'})
            if not created.get('project_id'):
                raise RuntimeError('Sandbox creation did not return a project ID.')
        me = client.call_tool('whoami')
        fields = ['org_id','org_name','project_id','project_name','env','status','org_status','scopes','expires_at','plan','limits','credit','key_budget_cents','billing_notice','managed_billing']
        print('Project and billing context:\n' + json.dumps({k:me[k] for k in fields if k in me}, indent=2))
        if not me.get('org_id') or not me.get('project_id') or me.get('env') not in ('test','live') or me.get('status') != 'active' or me.get('org_status') != 'active' or not isinstance(me.get('limits'), dict) or not me['limits'] or not isinstance(me.get('credit'), dict) or not me['credit'] or not me.get('billing_notice'):
            raise RuntimeError('Identity or billing context is incomplete/inactive. Stop and inspect whoami.')
        if created and (me['project_id'] != created['project_id'] or me['org_id'] != created.get('org_id') or me['env'] != 'test'):
            raise RuntimeError('Sandbox identity does not match the newly created test project.')
        if not args.generate:
            print('Inspection complete. No audio submitted. Review billing and limits before opting in with --generate --project <project_id>. --sandbox is session-only.')
            return
        if not created and args.project != me['project_id']:
            raise RuntimeError('Generation requires --project matching the inspected project ID.')
        if me['env'] == 'live' and not args.allow_live:
            raise RuntimeError('Live usage can incur charges. Requires --allow-live and a separately approved budget; this script does not enforce a dollar cap.')
        if not any(s in ('speak:synthesize','speak:*','*') for s in me.get('scopes',[])):
            raise RuntimeError('Project key lacks speech synthesis permission.')
        import time
        if me.get('expires_at') is not None and me['expires_at'] <= time.time()*1000:
            raise RuntimeError('Project key has expired.')
        out = HERE/'hello.wav'
        if os.path.lexists(out):
            raise RuntimeError('Output already exists; preserve it and choose a fresh example directory.')
        print('Submitting one short clip. No automatic retries; inspect billing separately.')
        tts = client.call_tool('synthesize_speech', {'input':'Hello from the PyAI MCP server.','voice':'nova','response_format':'wav','output_path':str(out)})
        if tts.get('status') != 'ok' or not isinstance(tts.get('output_path'),str) or Path(tts['output_path']).resolve() != out:
            raise RuntimeError('Speech result did not confirm the requested output file.')
        size, seconds = validate_wav(out)
        if tts.get('bytes') != size:
            raise RuntimeError('Speech result and saved file sizes disagree.')
        print(f'Saved and validated PCM WAV: {out} ({size} bytes, {seconds:.3f} seconds). Play it to confirm audible quality; playback has not been tested by this script.')
    finally:
        client.close()

if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, TypeError, KeyError) as err:
        print('Error:', err, file=sys.stderr)
        sys.exit(1)
