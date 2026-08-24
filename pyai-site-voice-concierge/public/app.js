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
// Audio is PCM16 little-endian at 24 kHz, the format Omni speaks: resample the
// mic from the AudioContext's actual rate, send PCM16 up, and play PCM16 down. On the
// Omni wire (direct mode) every frame carries a 1-byte type tag; the broker link
// is our own protocol and relays the PCM untagged.
// Text frames are session events (ready / transcript / barge_in / session_end /
// error) in broker mode, or Omni's native event frames in direct mode.

const RATE = 24000;
const MAX_BACKLOG_SECONDS = 1;
const FADE_SECONDS = 0.015;
const STARTUP_AUDIO_WAIT_MS = 4000;
const AGENT_BARGE_ARM_DELAY_MS = 350;
const AGENT_AUDIO_END_GRACE_MS = 500;
const PROTOCOL_VIOLATION_CLOSE_CODE = 4002;

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
let captureMute;
let outputGain;
let running = false;
let startupAudioPhase = "waiting";
let connectedAt = 0;
let responseAudioActive = false;
let agentPlayStartedAt = 0;
let agentEndTimer = null;
let protocolCloseRequested = false;
let protocolCloseAttempts = 0;

// Playback scheduling for the agent's audio.
let nextPlayTime = 0;
const playing = new Set(); // active AudioBufferSourceNodes (for barge-in cancel)

// Transcript rendering.
let lastAssistantTurn = null;

function beginStartupAudioPhase(phase, nowMs, connectedAtMs) {
  if (phase !== "waiting") return phase;
  return nowMs - connectedAtMs < STARTUP_AUDIO_WAIT_MS ? "playing" : "complete";
}

function completeStartupAudioPhase() {
  return "complete";
}

function shouldZeroCallerSamples(nowMs) {
  if (startupAudioPhase === "playing") return true;
  if (
    startupAudioPhase === "waiting" &&
    nowMs - connectedAt < STARTUP_AUDIO_WAIT_MS
  ) {
    return true;
  }
  return (
    responseAudioActive &&
    nowMs - agentPlayStartedAt < AGENT_BARGE_ARM_DELAY_MS
  );
}

function selectCallerSamples(samples, nowMs) {
  return shouldZeroCallerSamples(nowMs)
    ? new Float32Array(samples.length)
    : samples;
}

function beginConnectionAudioState() {
  startupAudioPhase = "waiting";
  connectedAt = Date.now();
  responseAudioActive = false;
  agentPlayStartedAt = 0;
  clearTimeout(agentEndTimer);
  agentEndTimer = null;
}

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

  // Browsers may ignore the requested rate, so capture uses audioCtx.sampleRate
  // and resamples explicitly before encoding.
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RATE });
  await audioCtx.resume();
  nextPlayTime = audioCtx.currentTime;
  outputGain = audioCtx.createGain();
  outputGain.gain.value = 1;
  outputGain.connect(audioCtx.destination);

  try {
    if (connectMode === "direct") await connectDirect();
    else connectBroker();
  } catch (err) {
    const message = err?.message || "Could not start the call.";
    stop(message);
    toggle.disabled = false;
    return setStatus(message, "err");
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

  protocolCloseRequested = false;
  protocolCloseAttempts = 0;
  ws = new WebSocket(session.url, [`pyai-key.${session.token}`]);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    beginConnectionAudioState();
    // Stateless on PyAI: the agent's whole behavior travels in this one frame.
    // Control frames are 0x03-prefixed (OMNI_PROTOCOL_V2.md §2/§3).
    try { ws.send(frame03(pendingConfigure)); } catch {}
    setStatus("Connecting to the agent…");
    startCapture();
  };
  ws.onmessage = onMessage;
  ws.onerror = () => {
    stop("Connection error.");
    setStatus("Connection error.", "err");
  };
  ws.onclose = () => { if (running) stop("Call ended."); };
}

// BROKER: connect to our own server, which relays to PyAI server-side.
function connectBroker() {
  protocolCloseRequested = false;
  protocolCloseAttempts = 0;
  ws = new WebSocket(brokerWsUrl());
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    beginConnectionAudioState();
    setStatus("Connecting to the agent…");
    startCapture();
  };
  ws.onmessage = onMessage;
  ws.onerror = () => {
    stop("Connection error.");
    setStatus("Connection error.", "err");
  };
  ws.onclose = () => { if (running) stop("Call ended."); };
}

function startCapture() {
  micSource = audioCtx.createMediaStreamSource(micStream);
  // ScriptProcessor is deprecated but dependency-free and fine for a demo; for
  // production prefer an AudioWorklet. 2048 frames ≈ 85 ms at 24 kHz.
  processor = audioCtx.createScriptProcessor(2048, 1, 1);
  captureMute = audioCtx.createGain();
  captureMute.gain.value = 0;
  processor.onaudioprocess = (ev) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const input = ev.inputBuffer.getChannelData(0);
    const pcm = pcm16(
      selectCallerSamples(input, Date.now()),
      audioCtx.sampleRate,
    );
    // DIRECT mode talks the engine's wire, so tag the frame. BROKER mode talks
    // our own relay, which tags upstream (see src/omni-session.js).
    ws.send(connectMode === "direct" ? frame01(pcm) : pcm);
  };
  micSource.connect(processor);
  // Keep ScriptProcessor live without routing microphone capture to speakers.
  processor.connect(captureMute);
  captureMute.connect(audioCtx.destination);
  setOrb("live");
  setStatus("Listening, go ahead and ask.", "live");
}

// Build a 0x03-prefixed control frame (the engine's client→server framing).
function frame03(obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(json.length + 1);
  out[0] = 0x03;
  out.set(json, 1);
  return out.buffer;
}

// Build a 0x01-prefixed caller-audio frame. The engine demuxes client frames on
// the first byte with no default branch, so untagged PCM is dropped silently.
function frame01(pcm) {
  const out = new Uint8Array(pcm.byteLength + 1);
  out[0] = 0x01;
  out.set(pcm, 1);
  return out;
}

function resample(input, fromRate, toRate) {
  if (!input.length || fromRate === toRate) return input;
  const length = Math.max(1, Math.round(input.length * toRate / fromRate));
  const output = new Float32Array(length);
  const scale = fromRate / toRate;
  for (let i = 0; i < length; i++) {
    const position = i * scale;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const mix = position - left;
    output[i] = input[left] * (1 - mix) + input[right] * mix;
  }
  return output;
}

function pcm16(input, inputRate) {
  const samples = resample(input, inputRate, RATE);
  const pcm = new Uint8Array(samples.length * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return pcm;
}

function onMessage(ev) {
  if (typeof ev.data !== "string") {
    // DIRECT mode: the engine sends type-tagged binary frames, demux on the
    // first byte (0x01 audio · 0x02 transcript · 0x03 control). BROKER mode: our
    // own server relays raw PCM audio (and carries events as text frames).
    if (connectMode === "direct") return onBinaryFrame(ev.data);
    playAgentAudio(ev.data);
    return;
  }
  if (connectMode === "direct") {
    closeForProtocolViolation("binary_frames_required");
    return;
  }
  try {
    handleEvent(JSON.parse(ev.data));
  } catch {
    /* ignore malformed */
  }
}

function closeForProtocolViolation(reason) {
  if (
    protocolCloseRequested ||
    !ws ||
    ws.readyState > WebSocket.OPEN
  ) {
    return false;
  }
  protocolCloseRequested = true;
  protocolCloseAttempts += 1;
  ws.close(PROTOCOL_VIOLATION_CLOSE_CODE, reason);
  return true;
}

function normalizeTranscriptBody(body) {
  if (!body.length || body.length > 16_384) return null;
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  const safeText = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_000 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
      ? value
      : null;
  try {
    const value = JSON.parse(decoded);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (keys.length !== 4 || !["event", "role", "text", "final"].every((key) => keys.includes(key))) return null;
    if (value.event !== "transcript") return null;
    if (value.role !== "user" && value.role !== "assistant") return null;
    const text = safeText(value.text);
    if (!text || typeof value.final !== "boolean") return null;
    return { event: "transcript", role: value.role, text, final: value.final };
  } catch {
    return null;
  }
}

function normalizeServerControl(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.event === "string" && value.event && value.event !== "transcript") {
    return value;
  }
  const allowedKeys = new Set(["type", "call_id", "sent_ms", "realtime_ms"]);
  const validNumber = (number) => (
    typeof number === "number" && Number.isFinite(number) && number >= 0
  );
  if (
    value.type !== "audio_position"
    || !Object.keys(value).every((key) => allowedKeys.has(key))
    || !validNumber(value.sent_ms)
    || !validNumber(value.realtime_ms)
    || (
      value.call_id !== undefined
      && (typeof value.call_id !== "string" || !value.call_id)
    )
  ) {
    return null;
  }
  return { ...value, event: "audio_position" };
}

// First-byte demux for the engine's binary frames (direct mode). Treating every
// binary frame as audio plays control/transcript frames as a glitch and drops
// every event, the #1 Omni integration bug.
function onBinaryFrame(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  if (!u8.length) return;
  switch (u8[0]) {
    case 0x01:
      return playAgentAudio(u8.subarray(1)); // PCM16 LE
    case 0x02: {
      const transcript = normalizeTranscriptBody(u8.subarray(1));
      if (transcript) renderTranscript(transcript);
      return;
    }
    case 0x03:
      try {
        const event = normalizeServerControl(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(u8.subarray(1))),
        );
        if (!event) throw new Error();
        handleEvent(event);
      } catch {
        closeForProtocolViolation("invalid_control_frame");
      }
      return;
    default:
      closeForProtocolViolation("unknown_binary_tag");
      return;
  }
}

function handleEvent(evt) {
  const kind = typeof evt.event === "string" ? evt.event : "";
  switch (kind) {
    case "config_ack":     // direct mode: ack for our configure
      setStatus("Listening, go ahead and ask.", "live");
      break;
    case "ready":            // broker mode: synthesized by our server
    case "session_started":  // direct mode: Omni's own opening event
      setStatus("Listening, go ahead and ask.", "live");
      break;
    case "transcript":
      renderTranscript(evt);
      break;
    case "barge_in":
    case "flush":
      stopPlayback(true, true); // fade, drop stale audio, and fail-open capture
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

function playAgentAudio(bytes) {
  if (!audioCtx || !outputGain) return;
  const sampleCount = Math.floor(bytes.byteLength / 2);
  if (!sampleCount) return;
  clearTimeout(agentEndTimer);
  agentEndTimer = null;
  if (!responseAudioActive) {
    responseAudioActive = true;
    agentPlayStartedAt = Date.now();
    startupAudioPhase = beginStartupAudioPhase(
      startupAudioPhase,
      agentPlayStartedAt,
      connectedAt,
    );
  }
  if (
    startupAudioPhase !== "playing" &&
    Math.max(0, nextPlayTime - audioCtx.currentTime) > MAX_BACKLOG_SECONDS
  ) {
    stopPlayback(true);
  }
  const buffer = audioCtx.createBuffer(1, sampleCount, RATE);
  const ch = buffer.getChannelData(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) ch[i] = view.getInt16(i * 2, true) / 0x8000;

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(outputGain);

  const startAt = Math.max(audioCtx.currentTime, nextPlayTime);
  src.start(startAt);
  nextPlayTime = startAt + buffer.duration;

  playing.add(src);
  setOrb("speaking");
  src.onended = () => {
    playing.delete(src);
    src.disconnect();
    if (playing.size === 0) {
      clearTimeout(agentEndTimer);
      agentEndTimer = setTimeout(() => {
        if (playing.size !== 0 || !responseAudioActive) return;
        responseAudioActive = false;
        agentPlayStartedAt = 0;
        startupAudioPhase = completeStartupAudioPhase(startupAudioPhase);
        agentEndTimer = null;
        if (running) setOrb("live");
      }, AGENT_AUDIO_END_GRACE_MS);
    }
  };
}

function stopPlayback(fade = false, completeOpening = false) {
  const now = audioCtx ? audioCtx.currentTime : 0;
  const fadeEnd = fade && outputGain ? now + FADE_SECONDS : now;
  if (fade && outputGain) {
    outputGain.gain.cancelScheduledValues(now);
    outputGain.gain.setValueAtTime(outputGain.gain.value, now);
    outputGain.gain.linearRampToValueAtTime(0, fadeEnd);
  }
  for (const src of playing) { try { src.stop(fadeEnd); } catch {} }
  playing.clear();
  nextPlayTime = now;
  clearTimeout(agentEndTimer);
  agentEndTimer = null;
  if (completeOpening) {
    responseAudioActive = false;
    agentPlayStartedAt = 0;
    startupAudioPhase = completeStartupAudioPhase(startupAudioPhase);
  }
  if (fade && outputGain) {
    outputGain.gain.setValueAtTime(0, fadeEnd);
    outputGain.gain.linearRampToValueAtTime(1, fadeEnd + FADE_SECONDS);
  }
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
  stopPlayback(false, true);
  try { if (processor) processor.onaudioprocess = null; } catch {}
  try { processor && processor.disconnect(); } catch {}
  try { micSource && micSource.disconnect(); } catch {}
  try { captureMute && captureMute.disconnect(); } catch {}
  try { outputGain && outputGain.disconnect(); } catch {}
  try { micStream && micStream.getTracks().forEach((t) => t.stop()); } catch {}
  try { audioCtx && audioCtx.close(); } catch {}
  try {
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      if (ws.readyState <= WebSocket.OPEN) ws.close(1000, "client_closed");
    }
  } catch {}
  audioCtx = null;
  processor = null;
  micSource = null;
  captureMute = null;
  outputGain = null;
  micStream = null;
  ws = null;
  lastAssistantTurn = null;
  startupAudioPhase = "waiting";
  connectedAt = 0;
  responseAudioActive = false;
  agentPlayStartedAt = 0;
  protocolCloseRequested = false;
  toggle.textContent = "Start talking";
  toggle.classList.remove("stop");
  setOrb("");
  setStatus(reason);
}

toggle.onclick = () => (running ? stop() : start());

loadMode();

if (window.__PYAI_CONCIERGE_TEST__) {
  window.__PYAI_CONCIERGE_TEST__.helpers = {
    beginStartupAudioPhase,
    completeStartupAudioPhase,
    shouldZeroCallerSamples,
    selectCallerSamples,
    startupAudioWaitMs: STARTUP_AUDIO_WAIT_MS,
    agentBargeArmDelayMs: AGENT_BARGE_ARM_DELAY_MS,
    agentAudioEndGraceMs: AGENT_AUDIO_END_GRACE_MS,
    closeForProtocolViolation,
    normalizeServerControl,
    protocolViolationCloseCode: PROTOCOL_VIOLATION_CLOSE_CODE,
    state: () => ({
      running,
      hasSocket: Boolean(ws),
      hasAudioContext: Boolean(audioCtx),
      hasMicrophone: Boolean(micStream),
      protocolCloseRequested,
      protocolCloseAttempts,
    }),
  };
}
