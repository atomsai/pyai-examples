// PyAI Omni voice widget — a single-file, dependency-free embeddable.
//
// Drop it into ANY page with one tag:
//   <script src="https://your-site.example/pyai-widget.js" data-token-url="/token"></script>
//
// It injects a floating mic button. On click it: mints a short-lived session
// token from `data-token-url` (your backend — see server.js), opens the Omni
// WebSocket DIRECTLY to PyAI with `pyai-key.<token>`, sends the `configure`
// frame, streams mic PCM16 up at 24 kHz, and plays the agent's PCM16 back —
// with barge-in. No key in the page; this file never sees your secret key.
//
// Audio note: Omni speaks raw PCM16 little-endian. We request a 24 kHz
// AudioContext so capture + playback match Omni with no manual resampling.

(function () {
  "use strict";

  var script = document.currentScript;
  var TOKEN_URL = (script && script.getAttribute("data-token-url")) || "/token";
  var LABEL = (script && script.getAttribute("data-label")) || "Talk to us";
  var RATE = 24000;

  // ---- UI (injected; no external CSS) -------------------------------------
  var style = document.createElement("style");
  style.textContent = [
    ".pyai-fab{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:10px;",
    "padding:12px 18px;border:none;border-radius:999px;cursor:pointer;font:600 14px/1 system-ui,sans-serif;",
    "color:#fff;background:#5B5BD6;box-shadow:0 8px 24px rgba(0,0,0,.18);transition:transform .15s,background .2s}",
    ".pyai-fab:hover{transform:translateY(-1px)}",
    ".pyai-fab.live{background:#16a34a}.pyai-fab.connecting{background:#d97706}.pyai-fab.error{background:#dc2626}",
    ".pyai-dot{width:10px;height:10px;border-radius:50%;background:#fff;opacity:.9}",
    ".pyai-fab.live .pyai-dot{animation:pyai-pulse 1.2s infinite}",
    "@keyframes pyai-pulse{0%,100%{opacity:1}50%{opacity:.3}}",
  ].join("");
  document.head.appendChild(style);

  var fab = document.createElement("button");
  fab.className = "pyai-fab";
  fab.innerHTML = '<span class="pyai-dot"></span><span class="pyai-label"></span>';
  var labelEl = fab.querySelector(".pyai-label");
  document.body.appendChild(fab);

  function setState(cls, text) {
    fab.className = "pyai-fab" + (cls ? " " + cls : "");
    labelEl.textContent = text;
  }
  setState("", LABEL);

  // ---- Audio + WS state ----------------------------------------------------
  var ws, audioCtx, micStream, micSource, processor;
  var running = false;
  var nextPlayTime = 0;
  var playing = new Set(); // active sources, for barge-in cancel

  fab.onclick = function () {
    if (running) stop("Talk to us");
    else start();
  };

  async function start() {
    setState("connecting", "Starting…");
    fab.disabled = true;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      fab.disabled = false;
      return setState("error", "Mic blocked");
    }

    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RATE });
    try { await audioCtx.resume(); } catch (e) {}
    nextPlayTime = audioCtx.currentTime;

    var session;
    try {
      var res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!res.ok) throw new Error("token " + res.status);
      session = await res.json();
    } catch (e) {
      fab.disabled = false;
      teardownAudio();
      return setState("error", "Unavailable");
    }

    var configure = session.configure || { type: "configure" };
    ws = new WebSocket(session.url, ["pyai-key." + session.token]);
    ws.binaryType = "arraybuffer";
    ws.onopen = function () {
      // Stateless on PyAI: the whole agent behavior travels in this one frame.
      // Control frames are 0x03-prefixed (see OMNI_PROTOCOL_V2.md §2/§3).
      try { ws.send(frame03(configure)); } catch (e) {}
      startCapture();
    };
    ws.onmessage = onMessage;
    ws.onerror = function () { setState("error", "Connection error"); };
    ws.onclose = function () { if (running) stop("Talk to us"); };

    running = true;
    fab.disabled = false;
  }

  function startCapture() {
    micSource = audioCtx.createMediaStreamSource(micStream);
    // ScriptProcessor is deprecated but dependency-free; for production prefer an
    // AudioWorklet. ~2048 frames ≈ 85 ms at 24 kHz.
    processor = audioCtx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = function (ev) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      var input = ev.inputBuffer.getChannelData(0);
      var pcm = new Int16Array(input.length);
      for (var i = 0; i < input.length; i++) {
        var s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      ws.send(pcm.buffer);
    };
    micSource.connect(processor);
    processor.connect(audioCtx.destination); // required for onaudioprocess to fire
    setState("live", "Listening — tap to end");
  }

  // Build a 0x03-prefixed control frame (the engine's client→server framing).
  function frame03(obj) {
    var json = new TextEncoder().encode(JSON.stringify(obj));
    var out = new Uint8Array(json.length + 1);
    out[0] = 0x03;
    out.set(json, 1);
    return out.buffer;
  }

  // Demux by the first byte: 0x01 audio · 0x02 transcript · 0x03 control/event.
  // (Treating every binary frame as audio — the classic bug — plays control
  // frames as a glitch and silently drops every event.)
  function onMessage(ev) {
    if (typeof ev.data === "string") { // legacy text frame — tolerate
      try { handleEvent(JSON.parse(ev.data)); } catch (e) {}
      return;
    }
    var u8 = new Uint8Array(ev.data);
    var tag = u8[0];
    if (tag === 0x01) return playAgentAudio(ev.data.slice(1)); // PCM16
    if (tag === 0x02) return; // transcript JSON — this minimal widget doesn't render it
    if (tag === 0x03) {
      try { handleEvent(JSON.parse(new TextDecoder().decode(u8.subarray(1)))); } catch (e) {}
      return;
    }
    playAgentAudio(ev.data); // unexpected/untagged: best-effort as audio
  }

  function handleEvent(evt) {
    var kind = evt.event || evt.type; // server frames keyed on `event`
    if (kind === "barge_in" || kind === "flush") stopPlayback();
    else if (kind === "session_end") stop("Talk to us");
    else if (kind === "error") setState("error", "Error");
  }

  function playAgentAudio(arrayBuffer) {
    if (!audioCtx) return;
    var bytes = new Int16Array(arrayBuffer);
    if (!bytes.length) return;
    var buffer = audioCtx.createBuffer(1, bytes.length, RATE);
    var ch = buffer.getChannelData(0);
    for (var i = 0; i < bytes.length; i++) ch[i] = bytes[i] / 0x8000;
    var src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);
    var startAt = Math.max(audioCtx.currentTime, nextPlayTime);
    src.start(startAt);
    nextPlayTime = startAt + buffer.duration;
    playing.add(src);
    src.onended = function () { playing.delete(src); };
  }

  function stopPlayback() {
    playing.forEach(function (src) { try { src.stop(); } catch (e) {} });
    playing.clear();
    nextPlayTime = audioCtx ? audioCtx.currentTime : 0;
  }

  function teardownAudio() {
    try { processor && processor.disconnect(); } catch (e) {}
    try { micSource && micSource.disconnect(); } catch (e) {}
    try { micStream && micStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { audioCtx && audioCtx.close(); } catch (e) {}
    audioCtx = null;
  }

  function stop(label) {
    running = false;
    stopPlayback();
    teardownAudio();
    try { ws && ws.readyState <= 1 && ws.close(); } catch (e) {}
    setState("", label || "Talk to us");
  }
})();
