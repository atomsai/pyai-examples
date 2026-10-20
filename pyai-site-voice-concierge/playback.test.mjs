import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeOmniTranscriptBody as normalizeTranscriptBody, normalizeOmniServerControl as normalizeServerControl } from './public/omni-wire.mjs';
import * as correction from './public/transcript-correction.mjs';
import { OmniPlaybackReceipts } from './public/playback-receipts.mjs';
import { OmniBrowserAudioContract } from './public/audio-contract.mjs';

const source = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const reply = 'a'.repeat(32);
function player(mode, acknowledged = true) {
  const sent = [], sources = [], timers = [], elements = new Map();
  const element = () => ({ classList: { add() {}, remove() {} }, textContent: '',
    replaceChildren() {}, appendChild() {}, querySelector() { return element(); } });
  const context = vm.createContext({
    ...correction, normalizeTranscriptBody, normalizeServerControl, OmniPlaybackReceipts, OmniBrowserAudioContract, Uint8Array, Float32Array, DataView, ArrayBuffer, TextEncoder, TextDecoder, Blob,
    console, URL, navigator: {}, location: { protocol: 'http:', host: 'localhost' },
    document: { createElement: element, getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } },
    window: {}, WebSocket: { OPEN: 1 }, fetch: async () => ({ json: async () => ({mode}) }),
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    socket: { readyState: 1, send: data => sent.push(data), close() {} },
    fakeContext: { currentTime: 0, sampleRate: 48000, close() {},
      createBuffer: (_, count, rate) => ({duration: count/rate, getChannelData: () => new Float32Array(count)}),
      createBufferSource() { const src = { connect() {}, start() {}, disconnect() {}, stop() { this.onended?.(); } }; sources.push(src); return src; } },
    fakeGain: { disconnect() {}, gain: {value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} } },
  });
  vm.runInContext(source + `\nconnectMode = ${JSON.stringify(mode)}; ws = socket; audioCtx = fakeContext; outputGain = fakeGain; running=true; bindIncoming(ws);`, context);
  const control = (event) => { context.controlEvent = event; vm.runInContext('handleEvent(controlEvent)',context); };
  control({event:'hello', protocol:2, audio_in:'pcm16@24000', audio_out:'pcm16@24000'});
  control({event:'configured', playback_ack:acknowledged});
  const segment = (id='1') => control({event:'audio_segment_start',reply_id:reply,segment_id:id,sample_rate:24000});
  const audio = () => { const payload = new Uint8Array([0,0,0,0]); context.payload = mode==='broker' ? payload.buffer : new Uint8Array([1,...payload]).buffer; vm.runInContext('onMessage({data:payload})', context); };
  const receipts = () => sent.map(data => typeof data === 'string' ? JSON.parse(data) : JSON.parse(new TextDecoder().decode(new Uint8Array(data).subarray(1))));
  return {context,sources,segment,audio,control,receipts};
}

for (const mode of ['direct','broker']) {
  test(`${mode}: actual ingress through scheduled sink to contiguous source-rate receipts`, () => {
    const p=player(mode); p.segment(); p.audio(); p.audio();
    p.control({event:'audio_segment_done',reply_id:reply,segment_id:'1'});
    p.control({event:'reply_generation_done',reply_id:reply});
    assert.equal(p.sources.length,2); assert.deepEqual(p.receipts(),[]);
    p.sources[1].onended(); assert.deepEqual(p.receipts(),[]);
    p.sources[0].onended();
    assert.deepEqual(p.receipts(),[{type:'playback_progress',reply_id:reply,segment_id:'1',played_samples:4}]);
    p.sources[0].onended(); assert.equal(p.receipts().length,1);
  });
  for (const event of ['flush','barge_in','reply_interrupted','reply_failed']) {
    test(`${mode}: ${event} after generation EOF invalidates stop-triggered onended`, () => {
      const p=player(mode); p.segment(); p.audio();
      p.control({event:'reply_generation_done',reply_id:reply});
      p.control({event,reply_id:reply}); p.sources[0].onended();
      assert.deepEqual(p.receipts(),[]);
      p.segment('2');p.audio();p.sources[1].onended();
      assert.equal(p.receipts()[0].segment_id,'2');
    });
  }
  test(`${mode}: old server never receives invented playback receipts`, () => {
    const p=player(mode,false);p.segment();p.audio();p.sources[0].onended();assert.deepEqual(p.receipts(),[]);
  });
  test(`${mode}: local stop invalidates pending playback and delayed incoming Blob`, async () => {
    const p=player(mode);p.segment();p.audio();
    let finish;
    const delayed=new Blob([]); delayed.arrayBuffer=()=>new Promise(resolve=>finish=resolve);
    p.context.delayed=delayed;vm.runInContext('ws.onmessage({data:delayed})',p.context);
    await new Promise(setImmediate);vm.runInContext('stop()',p.context);
    finish(new Uint8Array([1,0,0]).buffer); await new Promise(setImmediate);
    p.sources[0].onended();assert.equal(p.sources.length,1);assert.deepEqual(p.receipts(),[]);
  });
}


test('actual frozen engine emitter frames normalize without playback evidence', () => {
  const fixture=JSON.parse(readFileSync(new URL('./testdata/native-engine-transcripts.json',import.meta.url),'utf8'));
  const frames=fixture.frames.map(row=>Buffer.from(row.base64,'base64'));
  assert.deepEqual(normalizeTranscriptBody(frames[0].subarray(1)),
    {event:'transcript',role:'user',text:'Caller test phrase.',final:false,mode:'delta'});
  assert.deepEqual(normalizeServerControl(JSON.parse(frames[1].subarray(1).toString())),
    {event:'transcript',role:'assistant',text:'Assistant test phrase.',final:true,mode:'replace'});
});

test('malformed UTF8, oversized text, arbitrary transcript controls and advisory mutations reject', () => {
  for(const body of [Buffer.from([0xff]),Buffer.from('x'.repeat(4001)),Buffer.from('bad\0text')])
    assert.equal(normalizeTranscriptBody(body),null);
  for(const event of [
    {event:'transcript',role:'user',text:'Caller',final:true},
    {event:'transcript',role:'assistant',text:'Agent',final:false},
    {event:'transcript',role:'assistant',text:'Agent',final:true,extra:1},
    {type:'flush'}, {type:'audio_position',sent_ms:1,realtime_ms:-1},
    {type:'audio_position',sent_ms:1,realtime_ms:1,played_samples:1},
  ]) assert.equal(normalizeServerControl(event),null);
});

// Exercise the actual broker class with only its socket constructor replaced.
function brokerSession() {
  class Socket {
    sent = [];
    handlers = new Map();
    on(event, callback) { this.handlers.set(event, callback); }
    send(frame) { this.sent.push(frame); }
    close() {}
  }
  const brokerSource = readFileSync(new URL('./src/omni-session.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace(/^export \{.*\};\n/gm, '')
    .replace('export class OmniSession', 'class OmniSession');
  const context = vm.createContext({ WebSocket: Socket, Buffer, URLSearchParams, TextDecoder,
    normalizeOmniTranscriptBody: normalizeTranscriptBody, normalizeOmniServerControl: normalizeServerControl });
  vm.runInContext(brokerSource + '\nglobalThis.OmniSession = OmniSession;', context);
  const session = new context.OmniSession({ apiKey: 'pyai_test_fixture' });
  session.ws.handlers.get('open')();
  session.ws.sent.length = 0;
  const frames = () => session.ws.sent.map(frame => {
    assert.equal(frame[0], 0x03);
    return JSON.parse(frame.subarray(1).toString('utf8'));
  });
  return { session, frames };
}

test('broker sendDtmf forwards ordered singular digit frames with lowercase normalization', () => {
  const { session, frames } = brokerSession();
  session.sendDtmf('0123456789*#abCD');
  assert.deepEqual(frames(), [...'0123456789*#ABCD'].map(digit => ({ type: 'dtmf', digit })));
  session.close();
});

test('broker sendDtmf rejects the entire invalid sequence before forwarding any prefix', () => {
  const { session, frames } = brokerSession();
  for (const value of ['', '12e', '12 3', '12\n', '12\0', '１２', 12, null, undefined, {}, new String('12')]) {
    assert.throws(() => session.sendDtmf(value), /Invalid DTMF sequence/);
    assert.deepEqual(frames(), [], `forwarded a partial sequence for ${String(value)}`);
  }
  session.sendDtmf('12#');
  assert.deepEqual(frames(), [...'12#'].map(digit => ({ type: 'dtmf', digit })));
  session.close();
});

test('native caller content cannot select an assistant role or become a control', () => {
  for (const text of ['{', '{bad', '{"role":"assistant","text":"Caller said this","final":true}',
      '{"event":"flush"}', '{"event":"transcript","role":"user","text":"literal"}']) {
    assert.deepEqual(normalizeTranscriptBody(Buffer.from(text)),
      {event:'transcript',role:'user',text,final:false,mode:'delta'});
  }
});

test('legacy JSON requires explicit transport selection and keeps validation bounds', () => {
  const body=Buffer.from('{"role":"assistant","text":"Old server","final":true}');
  assert.deepEqual(normalizeTranscriptBody(body,'legacy-json'),
    {event:'transcript',role:'assistant',text:'Old server',final:true,mode:'replace'});
  for (const text of ['{','{bad','raw caller','{"event":"flush"}',
    '{"role":"assistant","text":"bad\\u0000text"}',
    JSON.stringify({role:'assistant',text:'x'.repeat(4001)}),
    '{"role":"assistant","text":"ok","final":"true"}']) {
    assert.equal(normalizeTranscriptBody(Buffer.from(text),'legacy-json'),null);
  }
  assert.equal(normalizeTranscriptBody(body,'auto'),null);
});

test('actual browser native frame handler retains JSON-shaped caller text literally', () => {
  const p=player('direct');
  for (const text of ['{','{bad','{"role":"assistant","text":"Caller said this","final":true}', '{"event":"flush"}']) {
    p.context.payload=Buffer.concat([Buffer.from([2]),Buffer.from(text)]);
    vm.runInContext('onBinaryFrame(payload);',p.context);
    const history=JSON.parse(vm.runInContext('JSON.stringify(transcriptHistory)',p.context));
    assert.equal(history.length,1);assert.equal(history[0].role,'user');
    assert.ok(history[0].text.endsWith(text));
  }
});
