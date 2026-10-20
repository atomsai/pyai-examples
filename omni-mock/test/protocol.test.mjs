import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { parse } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const native = JSON.parse(readFileSync(new URL('./native-engine-transcripts.json', import.meta.url), 'utf8'));
function connect(query = '') {
  let server;
  const timers = [], rates = [];
  class Server extends EventEmitter { constructor() { super(); server = this; } }
  const context = vm.createContext({
    WebSocketServer: Server, parse, randomUUID: () => 'mock-call', Buffer,
    process: {env:{}}, console: {log(){},warn(){},error(){}},
    setTimeout: fn => (timers.push(fn), timers.length), clearTimeout(){},
    setInterval: () => 1, clearInterval(){}, rates,
  });
  vm.runInContext(source, context);
  // Audio synthesis is outside this wire-contract check; no media is generated.
  vm.runInContext('tone = rate => { rates.push(rate); return Buffer.alloc(0); };', context);
  const socket = new EventEmitter();
  Object.assign(socket, {OPEN:1,readyState:1,sent:[],closes:[],send(data){this.sent.push(data);},close(...args){this.closes.push(args);}});
  server.emit('connection',socket,{url:'/v1/omni'+query});
  const control = value => socket.emit('message',Buffer.concat([Buffer.from([3]),Buffer.from(JSON.stringify(value))]),true);
  const events = () => socket.sent.filter(b=>b[0]===3).map(b=>JSON.parse(b.subarray(1).toString()));
  return {socket,control,events,timers,rates};
}

test('native configured event and real input/output rate mapping', () => {
  for (const [input, output] of [[8000,8000],[16000,24000],[24000,24000]]) {
    const c = connect('?format=pcm16&rate='+input);
    assert.deepEqual(c.events().map(e=>e.event),['hello','session_started']);
    assert.equal(c.events()[0].audio_in,'pcm16@'+input);
    assert.equal(c.events()[0].audio_out,'pcm16@'+output);
    c.control({type:'configure',playback_ack:true});
    assert.equal(c.events().at(-1).event,'configured');
    assert.equal(c.events().at(-1).audio_out,'pcm16@'+output);
    assert.equal(c.events().at(-1).playback_ack,false);
    c.socket.emit('message',Buffer.from([1,0,0]),true);
    c.timers.at(-1)();
    assert.deepEqual(c.rates,[output]);
  }
});

test('transcript emitters match actual engine frame shapes', () => {
  const c = connect();
  c.control({type:'configure'});
  c.socket.emit('message',Buffer.from([1,0,0]),true);
  c.timers.at(-1)();
  const caller = c.socket.sent.find(b=>b[0]===2);
  assert.equal(caller.subarray(1).toString(),'(mock heard your audio)');
  const actualCaller = Buffer.from(native.frames[0].base64,'base64');
  assert.equal(actualCaller[0],caller[0]);
  assert.throws(()=>JSON.parse(actualCaller.subarray(1).toString()));
  assert.throws(()=>JSON.parse(caller.subarray(1).toString()));
  const assistant = c.events().find(e=>e.event==='transcript');
  const actualAssistant = JSON.parse(Buffer.from(native.frames[1].base64,'base64').subarray(1).toString());
  assert.deepEqual({...assistant,text:actualAssistant.text},actualAssistant);
  assert.equal(c.events().find(e=>e.event==='turn_begin').turn,1);
});

test('unsupported formats/rates reject before hello', () => {
  for(const query of ['?format=mp3','?rate=48000','?rate=0','?rate=nope']) {
    const c=connect(query);
    assert.equal(c.socket.closes[0][0],1008);
    assert.deepEqual(c.events(),[]);
  }
});

test('configured gate, canonical keypad field, and lifecycle', () => {
  const c=connect();
  c.socket.emit('message',Buffer.from([1,0,0]),true);
  assert.equal(c.timers.length,0);
  c.control({event:'configure'});
  assert.equal(c.events().at(-1).code,'client_used_event_key');
  c.control({type:'configure'});
  for(const digit of ['5','a','#'])c.control({type:'dtmf',digit});
  assert.deepEqual(c.events().filter(e=>e.event==='dtmf_received').map(e=>e.digit),['5','A','#']);
  const count=c.events().length;
  c.control({type:'dtmf',digits:'5'});
  c.control({type:'dtmf',digit:'12'});
  assert.equal(c.events().length,count);
  c.control({type:'session_ending'});
  assert.equal(c.events().at(-1).event,'session_end');
  assert.deepEqual(c.socket.closes,[[1000,'session_ending']]);
});
