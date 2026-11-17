"""Offline subprocess tests: fake npx/MCP only; never contact PyAI or synthesize."""
import json
import os
from pathlib import Path
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


def fake_server():
    case = os.environ['QUICKSTART_CASE']
    for line in sys.stdin:
        msg = json.loads(line)
        if 'id' not in msg:
            continue
        method, params = msg['method'], msg.get('params',{})
        name = params.get('name',method)
        with open(os.environ['QUICKSTART_LOG'],'a') as log:
            log.write(json.dumps({'name':name,'arguments':params.get('arguments',{})})+'\n')
        error = False
        if name == 'initialize':
            result = {'serverInfo':{'name':'offline fixture'},'protocolVersion':'2024-11-05'}
        elif name == 'tools/list':
            result = {'tools':[{'name':n} for n in ('whoami','create_sandbox_key','synthesize_speech')]}
        else:
            payload = {}
            if name == 'create_sandbox_key':
                payload = {'org_id':'org_fixture','project_id':'proj_fixture','credential_saved':'session'}
                error = case == 'sandbox_error'
            elif name == 'whoami':
                payload = {'org_id':'org_fixture','org_name':'Fixture org','project_id':'proj_fixture','project_name':'Fixture project','env':'live' if case.startswith('live') else 'test','status':'active','org_status':'active','scopes':['speak:synthesize'],'expires_at':None,'plan':'enterprise','limits':{'rps':20,'burst':40,'concurrency':2,'monthly_units':None,'daily_unit_cap':10},'credit':{'gated':False,'available_cents':100},'key_budget_cents':None,'billing_notice':'Fixture billing context: caps do not establish free usage.','api_key':'DO-NOT-PRINT-SECRET'}
                error = case in ('missing_credentials','identity_error')
                if case == 'sandbox_wrong_project': payload['project_id'] = 'proj_other'
                if case == 'incomplete_identity': payload.pop('billing_notice')
                if case == 'empty_context': payload.update(limits={}, credit={})
                if case == 'empty_limits': payload['limits'] = {}
                if case == 'empty_credit': payload['credit'] = {}
                if case == 'null_limits': payload['limits'] = None
                if case == 'null_credit': payload['credit'] = None
                if case == 'array_context': payload.update(limits=[10], credit=[100])
                if case == 'string_context': payload.update(limits='unknown', credit='unknown')
                if case == 'zero_context':
                    payload['limits'] = dict.fromkeys(payload['limits'], 0)
                    payload['credit'] = {'gated':False,'available_cents':0}
                    payload['key_budget_cents'] = 0
                if case == 'unknown_limits': payload['limits'] = {'unrelated':True}
                if case == 'unknown_credit': payload['credit'] = {'unrelated':True}
                if case.startswith('missing_limit_'): payload['limits'].pop(case[len('missing_limit_'):])
                if case.startswith('missing_credit_'): payload['credit'].pop(case[len('missing_credit_'):])
                if case.startswith('bad_limit_'): payload['limits'][case[len('bad_limit_'):]] = 'unknown'
                if case == 'boolean_number': payload['credit']['available_cents'] = True
                if case == 'numeric_gate': payload['credit']['gated'] = 0
                if case == 'string_gate': payload['credit']['gated'] = 'false'
                if case == 'null_balance': payload['credit']['available_cents'] = None
                if case == 'string_balance': payload['credit']['available_cents'] = '0'
                if case == 'fractional_balance': payload['credit']['available_cents'] = 0.5
                if case == 'fractional_limit': payload['limits']['rps'] = 1.5
                if case == 'boolean_limit': payload['limits']['monthly_units'] = False
                if case == 'null_rate': payload['limits']['rps'] = None
                if case == 'null_daily_cap': payload['limits']['daily_unit_cap'] = None
                if case == 'absent_daily_cap': payload['limits'].pop('daily_unit_cap')
                if case == 'finite_caps': payload['limits'].update(monthly_units=100, daily_unit_cap=10)
                if case == 'negative_balance': payload['credit'].update(gated=True, available_cents=-1)
                if case == 'extra_fields':
                    payload['limits']['future_field'] = 'ignored'
                    payload['credit']['future_field'] = 'ignored'
                if case == 'integral_numbers':
                    payload['limits']['rps'] = 20.0
                    payload['credit']['available_cents'] = 100.0
                if case == 'no_scope': payload['scopes'] = []
                if case == 'expired': payload['expires_at'] = 1
            elif name == 'synthesize_speech':
                path = Path(params['arguments']['output_path'])
                # Tiny PCM silence fixture for container validation, not speech generation.
                data = b'\0'*16
                wav = b'RIFF'+struct.pack('<I',36+len(data))+b'WAVEfmt '+struct.pack('<IHHIIHH',16,1,1,24000,48000,2,16)+b'data'+struct.pack('<I',len(data))+data
                if case == 'empty_audio': wav = b''
                if case == 'invalid_audio': wav = b'not an audio container'*3
                if case == 'truncated_audio': wav = wav[:-2]
                if case == 'sentinel_header': wav = wav[:4]+b'\xff'*4+wav[8:40]+b'\xff'*4+wav[44:]
                if case == 'empty_pcm': wav = wav[:4]+struct.pack('<I',36)+wav[8:40]+struct.pack('<I',0)
                if case == 'invalid_format': wav = wav[:20]+struct.pack('<H',3)+wav[22:]
                if case == 'bad_alignment': wav = wav[:32]+struct.pack('<H',1)+wav[34:]
                if case not in ('tool_error','missing_audio'): path.write_bytes(wav)
                payload = {'status':'ok','output_path':str(path),'bytes':len(wav)}
                if case == 'wrong_output': payload['output_path'] = str(path.parent/'other.wav')
                if case == 'wrong_bytes': payload['bytes'] += 1
                error = case == 'tool_error'
                if case == 'disconnect': return
            result = {'content':[{'type':'text','text':json.dumps(payload)}]}
            if case != 'text_only': result['structuredContent'] = payload
            if error: result['isError'] = True
        print(json.dumps({'jsonrpc':'2.0','id':msg['id'],'result':result}),flush=True)


class QuickstartTests(unittest.TestCase):
    def run_case(self, client, case, args=(), ok=True, synthesis=0, sandbox=0, env_key=False):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            shutil.copy(HERE/client,root/client)
            # PATH-only fixture intercepts the actual CLI subprocess boundary.
            fake = root/'npx'
            fake.write_text('#!/bin/sh\nexec '+shlex.quote(sys.executable)+' '+shlex.quote(str(Path(__file__).resolve()))+' --fake\n')
            fake.chmod(0o755)
            env = {**os.environ,'PATH':td+os.pathsep+os.environ['PATH'],'QUICKSTART_CASE':case,'QUICKSTART_LOG':str(root/'calls'),'HOME':td}
            env.pop('PYAI_API_KEY',None)
            if env_key: env['PYAI_API_KEY'] = 'fixture-opaque-key'
            if case == 'existing_output': (root/'hello.wav').write_bytes(b'preserve me')
            cmd = ['node' if client.endswith('mjs') else sys.executable,str(root/client),*args]
            run = subprocess.run(cmd,env=env,capture_output=True,text=True,timeout=15)
            calls = [json.loads(line) for line in (root/'calls').read_text().splitlines()] if (root/'calls').exists() else []
            names = [c['name'] for c in calls]
            out = run.stdout+run.stderr
            self.assertEqual(run.returncode == 0,ok,out)
            self.assertEqual(names.count('synthesize_speech'),synthesis,out)
            self.assertEqual(names.count('create_sandbox_key'),sandbox,out)
            self.assertNotIn('DO-NOT-PRINT-SECRET',out)
            if synthesis:
                self.assertLess(names.index('whoami'),names.index('synthesize_speech'))
                self.assertIn('Project and billing context:',out)
                self.assertIn('monthly_units',out)
                self.assertEqual('Saved and validated PCM WAV:' in out,ok)
                self.assertNotIn('Done',out)
            if case == 'existing_output': self.assertEqual((root/'hello.wav').read_bytes(),b'preserve me')
            return out

    def test_clients(self):
        for client in ('index.mjs','client.py'):
            cases = [
                ('live_profile',(),True,0,0,False),
                ('live_env_key',(),True,0,0,True),
                ('test_default',(),True,0,0,False),
                ('missing_credentials',(),False,0,0,False),
                ('sandbox_inspect',('--sandbox',),True,0,1,False),
                ('sandbox_error',('--sandbox','--generate'),False,0,1,False),
                ('sandbox_wrong_project',('--sandbox','--generate'),False,0,1,False),
                ('sandbox_generate',('--sandbox','--generate'),True,1,1,False),
                ('missing_confirmation',('--generate',),False,0,0,False),
                ('wrong_project',('--generate','--project','proj_other'),False,0,0,False),
                ('live_unapproved',('--generate','--project','proj_fixture'),False,0,0,False),
                ('live_approved',('--generate','--project','proj_fixture','--allow-live'),True,1,0,True),
                ('unknown_flag',('--genrate',),False,0,0,False),
            ]
            for case in ('identity_error','incomplete_identity','empty_context','empty_limits','empty_credit','null_limits','null_credit','array_context','string_context','no_scope','expired','existing_output'):
                cases.append((case,('--generate','--project','proj_fixture'),False,0,0,False))
            for case in ('tool_error','missing_audio','empty_audio','invalid_audio','truncated_audio','sentinel_header','empty_pcm','invalid_format','bad_alignment','wrong_output','wrong_bytes','disconnect','valid_audio','text_only'):
                cases.append((case,('--generate','--project','proj_fixture'),case in ('valid_audio','text_only'),1,0,False))
            for case in ('zero_context','null_daily_cap','absent_daily_cap','finite_caps','negative_balance','extra_fields','integral_numbers'):
                cases.append((case,('--generate','--project','proj_fixture'),True,1,0,False))
            malformed = ['unknown_limits','unknown_credit','boolean_number','numeric_gate','string_gate','null_balance','string_balance','fractional_balance','fractional_limit','boolean_limit','null_rate']
            malformed += ['missing_limit_'+field for field in ('rps','burst','concurrency','monthly_units')]
            malformed += ['missing_credit_'+field for field in ('gated','available_cents')]
            malformed += ['bad_limit_'+field for field in ('rps','burst','concurrency','monthly_units','daily_unit_cap')]
            for case in malformed:
                cases.append((case,('--generate','--project','proj_fixture'),False,0,0,False))
            for case in ('unknown_limits','unknown_credit'):
                cases.append((case,(),False,0,0,False))
            for case in ('empty_context','empty_limits','empty_credit','array_context','string_context'):
                cases.append((case,(),False,0,0,False))
            for case,args,ok,synthesis,sandbox,env_key in cases:
                with self.subTest(client=client,case=case):
                    self.run_case(client,case,args,ok,synthesis,sandbox,env_key)

if __name__ == '__main__':
    if '--fake' in sys.argv: fake_server()
    else: unittest.main()
