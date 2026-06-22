// Browser side of the "Talk to PyAI" concierge.
//
// Two connect patterns, chosen by the server's /config (CONNECT_MODE):
//
//   • direct (preferred): POST /session to our backend for a short-lived,
//     origin-locked SESSION TOKEN, then open the Omni WebSocket DIRECTLY to PyAI
//     (`pyai-key.<token>`) and send the `configure` frame ourselves. No key in
//     the page; our backend stays out of the audio path.
//   • broker (fallback): open a WebSocket to our own /voice, which relays to
//     PyAI server-side. The browser code below the transport layer is identical.
//
// Audio is raw PCM16 little-endian at 24 kHz, the format Omni speaks: capture
// the mic at 24 kHz, send Int16 frames up, play back the Int16 frames down.
// Text frames are session events (ready / transcript / barge_in / session_end /
// error) in broker mode, or Omni's native event frames in direct mode.

const RATE = 24000;

const $ = (id) => document.getElementById(id);
const toggle = $("toggle");
const statusEl = $("status");
const orb = $("orb");
const transcriptEl = $("transcript");

let ws;
let audioCtx;
let micStream;
let micSource;
let processor;
let running = false;

// Playback scheduling for the agent's audio.
let nextPlayTime = 0;
const playing = new Set(); // active AudioBufferSourceNodes (for barge-in cancel)

// Transcript rendering.
let lastAssistantTurn = null;

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = "status " + kind;
}

function setOrb(state) {
  orb.className = "orb" + (state ? " " + state : "");
}

// Connect mode is decided server-side (CONNECT_MODE). Default to "direct".
let connectMode = "direct";
// In direct mode we send the configure frame ourselves right after the socket
// opens; this holds it until then.
let pendingConfigure = null;

async function loadMode() {
  try {
    const cfg = await fetch("/config").then((r) => r.json());
    if (cfg && (cfg.mode === "broker" || cfg.mode === "direct")) connectMode = cfg.mode;
  } catch {
    /* keep default */
  }
}

function brokerWsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/voice`;
}

async function start() {
  toggle.disabled = true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    toggle.disabled = false;
    return setStatus("Microphone permission denied.", "err");
  }

  // Ask for a 24 kHz context so capture and playback both match Omni's rate
  // with no manual resampling. Browsers honor this on modern engines.
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RATE });
  await audioCtx.resume();
  nextPlayTime = audioCtx.currentTime;

  try {
    if (connectMode === "direct") await connectDirect();
    else connectBroker();
  } catch (err) {
    toggle.disabled = false;
    return setStatus(err?.message || "Could not start the call.", "err");
  }

  running = true;
  toggle.disabled = false;
  toggle.textContent = "End call";
  toggle.classList.add("stop");
  transcriptEl.classList.add("show");
}

// DIRECT: mint a short-lived session token from our backend, then connect to
// PyAI directly and send the configure frame ourselves. No key in the page.
async function connectDirect() {
  setStatus("Getting a session…");
  const res = await fetch("/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!res.ok) throw new Error("Could not start a session.");
  const session = await res.json();
  pendingConfigure = session.configure || { type: "configure" };

  ws = new WebSocket(session.url, [`pyai-key.${session.token}`]);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    // Stateless on PyAI: the agent's whole behavior travels in this one frame.
    try { ws.send(JSON.stringify(pendingConfigure)); } catch {}
    setStatus("Connecting to the agent…");
    startCapture();
  };
  ws.onmessage = onMessage;
  ws.onerror = () => setStatus("Connection error.", "err");
  ws.onclose = () => { if (running) stop("Call ended."); };
}

// BROKER: connect to our own server, which relays to PyAI server-side.
function connectBroker() {
  ws = new WebSocket(brokerWsUrl());
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    setStatus("Connecting to the agent…");
    startCapture();
  };
  ws.onmessage = onMessage;
  ws.onerror = () => setStatus("Connection error.", "err");
  ws.onclose = () => { if (running) stop("Call ended."); };
}

function startCapture() {
  micSource = audioCtx.createMediaStreamSource(micStream);
  // ScriptProcessor is deprecated but dependency-free and fine for a demo; for
  // production prefer an AudioWorklet. 2048 frames ≈ 85 ms at 24 kHz.
  processor = audioCtx.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (ev) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const input = ev.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    ws.send(pcm.buffer);
  };
  micSource.connect(processor);
  processor.connect(audioCtx.destination); // required for onaudioprocess to fire
  setOrb("live");
  setStatus("Listening — go ahead and ask.", "live");
}

function onMessage(ev) {
  if (typeof ev.data !== "string") {
    playAgentAudio(ev.data); // ArrayBuffer of PCM16 LE
    return;
  }
  let evt;
  try { evt = JSON.parse(ev.data); } catch { return; }
  // Omni server frames are keyed on `event`; the broker also synthesizes a few
  // `type`-keyed control frames (`ready`/`session_end`/`error`). Read `event`
  // first, then fall back to `type` so both modes work. (Switching on `type`
  // alone is the #1 Omni bug — it silently misses every server frame.)
  const kind = evt.event || evt.type;
  switch (kind) {
    case "ready":            // broker mode: synthesized by our server
    case "session_started":  // direct mode: Omni's own opening event
      setStatus("Listening — go ahead and ask.", "live");
      break;
    case "transcript":
      renderTranscript(evt);
      break;
    case "barge_in":
    case "flush":
      stopPlayback(); // user interrupted — drop buffered agent audio immediately
      setOrb("live");
      break;
    case "session_end":
      stop("Call ended.");
      break;
    case "error":
      setStatus(evt.message || "Error.", "err");
      break;
    default:
      break; // hello / turn / etc.
  }
}

function playAgentAudio(arrayBuffer) {
  const bytes = new Int16Array(arrayBuffer);
  if (!bytes.length || !audioCtx) return;
  const buffer = audioCtx.createBuffer(1, bytes.length, RATE);
  const ch = buffer.getChannelData(0);
  for (let i = 0; i < bytes.length; i++) ch[i] = bytes[i] / 0x8000;

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(audioCtx.destination);

  const startAt = Math.max(audioCtx.currentTime, nextPlayTime);
  src.start(startAt);
  nextPlayTime = startAt + buffer.duration;

  playing.add(src);
  setOrb("speaking");
  src.onended = () => {
    playing.delete(src);
    if (playing.size === 0 && running) setOrb("live");
  };
}

function stopPlayback() {
  for (const src of playing) { try { src.stop(); } catch {} }
  playing.clear();
  nextPlayTime = audioCtx ? audioCtx.currentTime : 0;
}

function renderTranscript(evt) {
  const text = (evt.text || "").trim();
  if (!text) return;
  const role = evt.role === "assistant" || evt.role === "agent" ? "assistant" : "user";

  // Coalesce streaming assistant partials into one updating turn.
  if (role === "assistant" && lastAssistantTurn && !lastAssistantTurn.dataset.final) {
    lastAssistantTurn.querySelector(".text").textContent = text;
  } else {
    const turn = document.createElement("div");
    turn.className = "turn " + role;
    turn.innerHTML = `<div class="who">${role === "assistant" ? "PyAI" : "You"}</div><div class="text"></div>`;
    turn.querySelector(".text").textContent = text;
    transcriptEl.appendChild(turn);
    if (role === "assistant") lastAssistantTurn = turn;
  }
  if (role === "assistant" && evt.final) lastAssistantTurn.dataset.final = "1";
  if (role === "user") lastAssistantTurn = null;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function stop(reason = "Call ended.") {
  running = false;
  stopPlayback();
  try { processor && processor.disconnect(); } catch {}
  try { micSource && micSource.disconnect(); } catch {}
  try { micStream && micStream.getTracks().forEach((t) => t.stop()); } catch {}
  try { audioCtx && audioCtx.close(); } catch {}
  try { ws && ws.readyState <= 1 && ws.close(); } catch {}
  audioCtx = null;
  lastAssistantTurn = null;
  toggle.textContent = "Start talking";
  toggle.classList.remove("stop");
  setOrb("");
  setStatus(reason);
}

toggle.onclick = () => (running ? stop() : start());

loadMode();
