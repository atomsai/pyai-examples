// PyAI Omni voice widget v2, a single-file, dependency-free embeddable.
//
// Native Omni frames are strictly type-prefixed:
//   client audio 0x01 · client control 0x03
//   server audio 0x01 · transcript 0x02 · control 0x03
(function () {
  "use strict";

  var script = document.currentScript;
  var TOKEN_URL = (script && script.getAttribute("data-token-url")) || "/token";
  var LABEL = (script && script.getAttribute("data-label")) || "Talk to us";
  var RATE = 24000;
  var MAX_BACKLOG_SECONDS = 1;
  var FADE_SECONDS = 0.015;

  var style = document.createElement("style");
  style.textContent = [
    ".pyai-fab{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:10px;",
    "padding:12px 18px;border:none;border-radius:999px;cursor:pointer;font:600 14px/1 system-ui,sans-serif;",
    "color:#fff;background:#5B5BD6;box-shadow:0 8px 24px rgba(0,0,0,.18);transition:transform .15s,background .2s}",
    ".pyai-fab:hover{transform:translateY(-1px)}",
    ".pyai-fab:focus-visible{outline:3px solid rgba(91,91,214,.45);outline-offset:3px}",
    ".pyai-fab.live{background:#16a34a}.pyai-fab.connecting{background:#d97706}.pyai-fab.error{background:#dc2626}",
    ".pyai-dot{width:10px;height:10px;border-radius:50%;background:#fff;opacity:.9}",
    ".pyai-fab.live .pyai-dot{animation:pyai-pulse 1.2s infinite}",
    "@keyframes pyai-pulse{0%,100%{opacity:1}50%{opacity:.3}}",
    "@media (prefers-reduced-motion: reduce){.pyai-fab,.pyai-fab:hover{transition:none;transform:none}.pyai-fab.live .pyai-dot{animation:none}}",
  ].join("");
  document.head.appendChild(style);

  var fab = document.createElement("button");
  fab.type = "button";
  fab.className = "pyai-fab";
  fab.setAttribute("aria-label", LABEL);
  fab.innerHTML = '<span class="pyai-dot"></span><span class="pyai-label"></span>';
  var labelEl = fab.querySelector(".pyai-label");
  labelEl.setAttribute("aria-live", "polite");
  document.body.appendChild(fab);

  function setState(cls, text) {
    fab.className = "pyai-fab" + (cls ? " " + cls : "");
    labelEl.textContent = text;
    fab.setAttribute("aria-label", text);
  }
  setState("", LABEL);

  var ws, audioCtx, micStream, micSource, processor, captureMute, outputGain;
  var running = false;
  var nextPlayTime = 0;
  var playing = new Set();

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
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RATE });
      await audioCtx.resume();
      nextPlayTime = audioCtx.currentTime;
      outputGain = audioCtx.createGain();
      outputGain.gain.value = 1;
      outputGain.connect(audioCtx.destination);

      var res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error("token " + res.status);
      var session = await res.json();
      var configure = session.configure || { type: "configure" };

      ws = new WebSocket(session.url, ["pyai-key." + session.token]);
      ws.binaryType = "arraybuffer";
      ws.onopen = function () {
        try { ws.send(frame03(configure)); } catch (e) {}
        startCapture();
      };
      ws.onmessage = onMessage;
      ws.onerror = function () {
        stop("Connection error");
        setState("error", "Connection error");
      };
      ws.onclose = function () { if (running) stop("Talk to us"); };
      running = true;
      fab.disabled = false;
    } catch (e) {
      fab.disabled = false;
      teardownAudio();
      setState("error", e && e.name === "NotAllowedError" ? "Allow microphone access" : "Unavailable. Try again later");
    }
  }

  function startCapture() {
    micSource = audioCtx.createMediaStreamSource(micStream);
    // ScriptProcessor is deprecated but keeps this example dependency-free.
    processor = audioCtx.createScriptProcessor(2048, 1, 1);
    captureMute = audioCtx.createGain();
    captureMute.gain.value = 0;
    processor.onaudioprocess = function (ev) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(frame01(ev.inputBuffer.getChannelData(0), audioCtx.sampleRate));
    };
    micSource.connect(processor);
    // A connected output keeps ScriptProcessor firing. Mute it to avoid a
    // microphone-to-speaker echo path.
    processor.connect(captureMute);
    captureMute.connect(audioCtx.destination);
    setState("live", "Listening, tap to end");
  }

  function resample(input, fromRate, toRate) {
    if (!input.length || fromRate === toRate) return input;
    var length = Math.max(1, Math.round(input.length * toRate / fromRate));
    var output = new Float32Array(length);
    var scale = fromRate / toRate;
    for (var i = 0; i < length; i++) {
      var position = i * scale;
      var left = Math.min(input.length - 1, Math.floor(position));
      var right = Math.min(input.length - 1, left + 1);
      var mix = position - left;
      output[i] = input[left] * (1 - mix) + input[right] * mix;
    }
    return output;
  }

  function frame01(input, inputRate) {
    var samples = resample(input, inputRate, RATE);
    var out = new Uint8Array(1 + samples.length * 2);
    out[0] = 0x01;
    var view = new DataView(out.buffer);
    for (var i = 0; i < samples.length; i++) {
      var sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(1 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return out;
  }

  function frame03(obj) {
    var json = new TextEncoder().encode(JSON.stringify(obj));
    var out = new Uint8Array(json.length + 1);
    out[0] = 0x03;
    out.set(json, 1);
    return out;
  }

  function onMessage(ev) {
    if (typeof ev.data === "string") {
      try { handleEvent(JSON.parse(ev.data)); } catch (e) {}
      return;
    }
    if (ev.data instanceof Blob) {
      ev.data.arrayBuffer().then(onBinaryFrame).catch(function () {});
      return;
    }
    onBinaryFrame(ev.data);
  }

  function onBinaryFrame(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    if (!bytes.length) return;
    var tag = bytes[0];
    if (tag === 0x01) {
      playAgentAudio(bytes.subarray(1));
    } else if (tag === 0x02) {
      // Transcript JSON is valid but intentionally not rendered by this widget.
    } else if (tag === 0x03) {
      try { handleEvent(JSON.parse(new TextDecoder().decode(bytes.subarray(1)))); } catch (e) {}
    } else if (window.console && console.warn) {
      console.warn("PyAI widget ignored unknown Omni frame tag", tag);
    }
  }

  function handleEvent(evt) {
    var kind = evt && (evt.event || evt.type);
    if (kind === "barge_in" || kind === "flush") stopPlayback(true);
    else if (kind === "session_end") stop("Talk to us");
    else if (kind === "error") setState("error", "Error");
  }

  function playAgentAudio(bytes) {
    if (!audioCtx || !outputGain) return;
    var sampleCount = Math.floor(bytes.byteLength / 2);
    if (!sampleCount) return;
    if (Math.max(0, nextPlayTime - audioCtx.currentTime) > MAX_BACKLOG_SECONDS) {
      stopPlayback(true);
    }
    var buffer = audioCtx.createBuffer(1, sampleCount, RATE);
    var channel = buffer.getChannelData(0);
    var view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
    for (var i = 0; i < sampleCount; i++) channel[i] = view.getInt16(i * 2, true) / 0x8000;
    var source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(outputGain);
    var startAt = Math.max(audioCtx.currentTime, nextPlayTime);
    source.start(startAt);
    nextPlayTime = startAt + buffer.duration;
    playing.add(source);
    source.onended = function () {
      playing.delete(source);
      source.disconnect();
    };
  }

  function stopPlayback(fade) {
    var now = audioCtx ? audioCtx.currentTime : 0;
    var fadeEnd = fade && outputGain ? now + FADE_SECONDS : now;
    if (fade && outputGain) {
      outputGain.gain.cancelScheduledValues(now);
      outputGain.gain.setValueAtTime(outputGain.gain.value, now);
      outputGain.gain.linearRampToValueAtTime(0, fadeEnd);
    }
    playing.forEach(function (source) {
      try { source.stop(fadeEnd); } catch (e) {}
    });
    playing.clear();
    nextPlayTime = now;
    if (fade && outputGain) {
      outputGain.gain.setValueAtTime(0, fadeEnd);
      outputGain.gain.linearRampToValueAtTime(1, fadeEnd + FADE_SECONDS);
    }
  }

  function teardownAudio() {
    stopPlayback(false);
    try { if (processor) processor.onaudioprocess = null; } catch (e) {}
    try { processor && processor.disconnect(); } catch (e) {}
    try { micSource && micSource.disconnect(); } catch (e) {}
    try { captureMute && captureMute.disconnect(); } catch (e) {}
    try { outputGain && outputGain.disconnect(); } catch (e) {}
    try { micStream && micStream.getTracks().forEach(function (track) { track.stop(); }); } catch (e) {}
    try { audioCtx && audioCtx.close(); } catch (e) {}
    processor = micSource = captureMute = outputGain = micStream = audioCtx = null;
  }

  function stop(label) {
    running = false;
    teardownAudio();
    try {
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        if (ws.readyState <= WebSocket.OPEN) ws.close(1000, "client_closed");
      }
    } catch (e) {}
    ws = null;
    setState("", label || "Talk to us");
  }
})();
