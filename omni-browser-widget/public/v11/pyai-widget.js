(function () {
  "use strict";

  var VERSION = "11.0.0";
  var OPENING_AUDIO_POLICY_VERSION = "omni-opening-v1";
  var scripts = document.querySelectorAll('script[src*="/widget/v11/pyai-widget.js"]');
  var script = document.currentScript || scripts[scripts.length - 1];
  if (!script) return;

  var PUBLIC_ID_RE = /^wdgt_[A-Za-z0-9_-]{32,64}$/;
  var REFERRAL_RE = /^(wr|pt|af|cp|iv)_[a-z0-9]{20,40}$/;
  var publicId = script.getAttribute("data-widget") || "";
  if (!PUBLIC_ID_RE.test(publicId)) {
    console.warn("[PyAI Widget] data-widget must be a hosted widget public id.");
    return;
  }

  var apiOrigin = (function () {
    var override = script.getAttribute("data-api-origin");
    if (override && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(override)) return override;
    return "https://api.pyai.com";
  })();
  var configUrl = apiOrigin + "/public/widgets/" + encodeURIComponent(publicId);
  var sessionUrl = configUrl + "/session";
  var instanceId = "pyai-widget-" + Math.random().toString(36).slice(2);
  var state = {
    config: null,
    panel: null,
    launcher: null,
    ws: null,
    stream: null,
    inputContext: null,
    captureMute: null,
    processor: null,
    muted: false,
    connected: false,
    sources: [],
    playAt: 0,
    previousFocus: null,
    wsErrorEmitted: false,
    protocolCloseRequested: false,
    protocolCloseAttempts: 0,
    destroyed: false,
    transcriptHistory: [],
    agentState: null,
    responseAudioActive: false,
    agentPlayStartedAt: 0,
    startupAudioPhase: "waiting",
    connectedAt: 0,
    playbackReady: false,
    pendingAudio: [],
    agentEndTimer: null,
    agentSpeakingTimer: null,
  };
  var MAX_TRANSCRIPT_BYTES = 16384;
  var MAX_TRANSCRIPT_CHARS = 4000;
  var MAX_TRANSCRIPT_ROWS = 100;
  var AGENT_AUDIO_END_GRACE_MS = 500;
  var AGENT_STATE_TRANSITION_MS = 100;
  var STARTUP_AUDIO_WAIT_MS = 4000;
  var AGENT_BARGE_ARM_DELAY_MS = 350;
  var PROTOCOL_VIOLATION_CLOSE_CODE = 4002;

  var ERROR_CONTRACT = {
    mic_permission_denied: {
      message: "Microphone access was denied. Allow microphone access for this site in your browser settings, then try again.",
      retryable: false,
    },
    unsupported_browser: {
      message: "This browser cannot start a voice session. Use a current version of Chrome, Safari, Firefox, or Edge.",
      retryable: false,
    },
    origin_not_allowed: {
      message: "This website is not authorized to use this voice agent.",
      retryable: false,
    },
    credit_exhausted: {
      message: "This voice agent is unavailable because its account needs attention.",
      retryable: false,
    },
    daily_cap_exceeded: {
      message: "This voice agent has reached today's session limit. Try again after the daily reset.",
      retryable: false,
    },
    session_unavailable: {
      message: "A secure voice session is temporarily unavailable. Try again shortly.",
      retryable: true,
    },
    websocket_failed: {
      message: "The live voice connection was interrupted. Try connecting again.",
      retryable: true,
    },
    config_unavailable: {
      message: "This voice agent is unavailable or has been disabled.",
      retryable: false,
    },
    consent_required: {
      message: "Review and accept the recording notice before enabling your microphone.",
      retryable: false,
    },
  };

  function emit(name, detail) {
    var value = detail || {};
    value.widgetId = publicId;
    value.instanceId = instanceId;
    window.dispatchEvent(new CustomEvent("pyai:widget:" + name, { detail: value }));
  }

  function safeRequestId(value) {
    return typeof value === "string" &&
      value.length > 0 &&
      value.length <= 128 &&
      !/[\u0000-\u001f\u007f]/.test(value)
      ? value
      : null;
  }

  function errorDetail(code, requestId, retryableOverride) {
    var definition = ERROR_CONTRACT[code] || ERROR_CONTRACT.session_unavailable;
    var detail = {
      code: ERROR_CONTRACT[code] ? code : "session_unavailable",
      message: definition.message,
      retryable: typeof retryableOverride === "boolean" ? retryableOverride : definition.retryable,
    };
    var safeId = safeRequestId(requestId);
    if (safeId) detail.request_id = safeId;
    return detail;
  }

  function emitError(code, requestId, retryableOverride) {
    var detail = errorDetail(code, requestId, retryableOverride);
    window.dispatchEvent(new CustomEvent("pyai:widget-error", { detail: detail }));
    return detail;
  }

  function emitWebSocketError(retryable) {
    var detail = errorDetail("websocket_failed", null, retryable);
    if (!retryable) {
      detail.message = "The live voice connection was closed. Reload the page or contact the site owner.";
    }
    window.dispatchEvent(new CustomEvent("pyai:widget-error", { detail: detail }));
    return detail;
  }

  function responseCode(body) {
    if (body && body.error && typeof body.error.code === "string") return body.error.code;
    if (body && typeof body.code === "string") return body.code;
    if (body && typeof body.type === "string") {
      var match = body.type.match(/\/problems\/([a-z0-9_]+)$/);
      if (match) return match[1];
    }
    return "";
  }

  function classifyBrokerError(status, body, phase) {
    var code = responseCode(body);
    var requestId = body && body.request_id;
    if (code === "origin_not_allowed" || status === 403) return errorDetail("origin_not_allowed", requestId);
    if (code === "credit_exhausted" || status === 402) return errorDetail("credit_exhausted", requestId);
    if (code === "daily_cap_exceeded" || status === 429) return errorDetail("daily_cap_exceeded", requestId);
    if (phase === "config" && (status === 404 || code === "not_found")) {
      return errorDetail("config_unavailable", requestId);
    }
    return errorDetail(phase === "config" ? "config_unavailable" : "session_unavailable", requestId);
  }

  function parseErrorResponse(response, phase) {
    return response.json()
      .catch(function () { return null; })
      .then(function (body) {
        throw classifyBrokerError(response.status, body, phase);
      });
  }

  function normalizeThrown(error, fallbackCode) {
    return error && ERROR_CONTRACT[error.code]
      ? error
      : errorDetail(fallbackCode);
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function browserSupported() {
    return typeof window.fetch === "function" &&
      typeof window.WebSocket === "function" &&
      typeof window.URL === "function" &&
      typeof navigator !== "undefined" &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      typeof (window.AudioContext || window.webkitAudioContext) === "function";
  }

  function renderUnavailable(message) {
    if (state.launcher || state.destroyed) return;
    var status = element("div", "pyai-v7 pyai-v7-unavailable", message);
    status.setAttribute("role", "alert");
    status.setAttribute("aria-live", "assertive");
    document.body.appendChild(status);
    state.launcher = status;
  }

  function safeReferral(value) {
    if (typeof value !== "string") return null;
    value = value.toLowerCase();
    return REFERRAL_RE.test(value) ? value : null;
  }

  function brandingUrl(variant, code) {
    var content = encodeURIComponent(variant || "pill");
    if (code) {
      return "https://pyai.com/r/" + encodeURIComponent(code) +
        "?utm_source=customer_widget&utm_medium=referral&utm_campaign=powered_by_widget&utm_content=" + content;
    }
    return "https://pyai.com/?utm_source=customer_widget&utm_medium=referral&utm_campaign=powered_by_widget&utm_content=" + content;
  }

  function text(value, fallback) {
    return typeof value === "string" && value ? value : fallback;
  }

  function accentText(accent) {
    var match = /^#([0-9a-f]{6})$/i.exec(accent || "");
    if (!match) return "#fff";
    var channels = [0, 2, 4].map(function (offset) {
      var channel = parseInt(match[1].slice(offset, offset + 2), 16) / 255;
      return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    });
    var luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    return luminance > 0.179 ? "#171411" : "#fff";
  }

  function installStyles() {
    if (document.getElementById("pyai-widget-v7-styles")) return;
    var style = element("style");
    style.id = "pyai-widget-v7-styles";
    var nonce = script.nonce || script.getAttribute("nonce");
    if (nonce) style.nonce = nonce;
    style.textContent =
      ".pyai-v7-unavailable{position:fixed;z-index:2147483000;bottom:max(20px,env(safe-area-inset-bottom));right:20px;max-width:320px;padding:14px 16px;border:1px solid #ddd6cc;border-radius:14px;background:#fff;color:#171411;font:500 14px/1.4 Inter,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}" +
      ".pyai-v7{--pa:#5b5bd6;--pa-text:#fff;font-family:Inter,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:#171411}" +
      ".pyai-v7-launch{position:fixed;z-index:2147483000;bottom:max(20px,env(safe-area-inset-bottom));right:20px;border:0;background:var(--pa);color:var(--pa-text);border-radius:999px;min-height:52px;padding:0 20px;font:600 15px inherit;box-shadow:0 12px 35px rgba(0,0,0,.22);cursor:pointer}" +
      ".pyai-v7-left{right:auto;left:20px}.pyai-v7-orb{width:56px;height:56px;padding:0;font-size:0}.pyai-v7-orb:after{content:'🎙';font-size:21px}" +
      ".pyai-v7-card{width:300px;border-radius:20px;text-align:left;padding:18px;background:#fff;color:#171411;border:1px solid #e6e1d8}.pyai-v7-card b,.pyai-v7-card span{display:block}.pyai-v7-card span{margin-top:5px;color:#696158;font-size:13px}" +
      ".pyai-v7-inline{position:static;box-shadow:none}.pyai-v7[hidden]{display:none!important}" +
      ".pyai-v7-backdrop{position:fixed;z-index:2147483001;inset:0;background:rgba(20,17,14,.48);display:grid;place-items:end center;padding:20px}" +
      ".pyai-v7-dialog{width:min(420px,100%);max-height:min(680px,calc(100vh - 40px));display:flex;flex-direction:column;background:#fff;border-radius:24px;box-shadow:0 22px 70px rgba(0,0,0,.28);overflow:hidden}" +
      ".pyai-v7-head{display:flex;align-items:flex-start;justify-content:space-between;padding:20px;border-bottom:1px solid #ece8e2}.pyai-v7-head h2{font-size:18px;margin:0}.pyai-v7-head p{font-size:13px;color:#716960;margin:5px 0 0}.pyai-v7-close{border:0;background:transparent;font-size:24px;cursor:pointer}" +
      ".pyai-v7-body{padding:18px;overflow:auto;min-height:180px}.pyai-v7-status{font-size:14px;color:#655e56}.pyai-v7-consent{margin:14px 0;padding:14px;border-radius:14px;background:#f4f1ff;font-size:14px;line-height:1.45}.pyai-v7-transcript{margin-top:14px;display:grid;gap:8px;font-size:14px}.pyai-v7-transcript div{padding:9px 11px;border-radius:12px;background:#f6f4f0}" +
      ".pyai-v7-actions{display:flex;gap:10px;padding:16px 18px;border-top:1px solid #ece8e2}.pyai-v7-btn{flex:1;border:1px solid #ddd6cc;background:#fff;border-radius:999px;min-height:44px;font:600 14px inherit;cursor:pointer}.pyai-v7-primary{border-color:var(--pa);background:var(--pa);color:var(--pa-text)}" +
      ".pyai-v7-brand{display:block;text-align:center;padding:0 0 14px;font-size:11px;color:#817970}.pyai-v7-brand:focus-visible,.pyai-v7-btn:focus-visible,.pyai-v7-launch:focus-visible{outline:3px solid color-mix(in srgb,var(--pa) 45%,transparent);outline-offset:3px}" +
      "@media(max-width:640px){.pyai-v7-backdrop{padding:0;align-items:end}.pyai-v7-dialog{width:100%;max-height:88vh;border-radius:24px 24px 0 0;padding-bottom:env(safe-area-inset-bottom)}}" +
      "@media(prefers-color-scheme:dark){.pyai-v7[data-theme=auto] .pyai-v7-dialog,.pyai-v7[data-theme=dark] .pyai-v7-dialog{background:#181613;color:#f7f2ea}.pyai-v7[data-theme=auto] .pyai-v7-head,.pyai-v7[data-theme=auto] .pyai-v7-actions,.pyai-v7[data-theme=dark] .pyai-v7-head,.pyai-v7[data-theme=dark] .pyai-v7-actions{border-color:#332e28}.pyai-v7[data-theme=auto] .pyai-v7-transcript div,.pyai-v7[data-theme=dark] .pyai-v7-transcript div{background:#24201c}}";
    document.head.appendChild(style);
  }

  function stopSources() {
    state.sources.forEach(function (source) {
      try { source.stop(); } catch (_) {}
    });
    state.sources = [];
    state.pendingAudio = [];
    state.playAt = state.inputContext ? state.inputContext.currentTime : 0;
  }

  function releaseCallResources() {
    if (state.processor) {
      state.processor.onaudioprocess = null;
      try { state.processor.disconnect(); } catch (_) {}
    }
    if (state.captureMute) { try { state.captureMute.disconnect(); } catch (_) {} }
    if (state.stream) {
      state.stream.getTracks().forEach(function (track) { track.stop(); });
    }
    if (state.inputContext) state.inputContext.close().catch(function () {});
    stopSources();
    state.stream = null;
    state.processor = null;
    state.captureMute = null;
    state.inputContext = null;
    state.connected = false;
    state.responseAudioActive = false;
    state.agentPlayStartedAt = 0;
    state.playbackReady = false;
    state.pendingAudio = [];
    clearTimeout(state.agentEndTimer);
    state.agentEndTimer = null;
    clearTimeout(state.agentSpeakingTimer);
    state.agentSpeakingTimer = null;
  }

  function downsample(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    var ratio = fromRate / toRate;
    var length = Math.max(1, Math.round(input.length / ratio));
    var output = new Float32Array(length);
    for (var i = 0; i < length; i += 1) {
      var start = Math.floor(i * ratio);
      var end = Math.min(input.length, Math.floor((i + 1) * ratio));
      var sum = 0;
      for (var j = start; j < end; j += 1) sum += input[j];
      output[i] = sum / Math.max(1, end - start);
    }
    return output;
  }

  function pcm16Frame(samples, fromRate) {
    var resampled = downsample(samples, fromRate, 24000);
    var frame = new Uint8Array(1 + resampled.length * 2);
    frame[0] = 0x01;
    var view = new DataView(frame.buffer);
    for (var i = 0; i < resampled.length; i += 1) {
      var sample = Math.max(-1, Math.min(1, resampled[i]));
      view.setInt16(1 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
    }
    return frame;
  }

  function beginStartupAudioPhase(phase, nowMs, connectedAtMs) {
    if (phase !== "waiting") return phase;
    return nowMs - connectedAtMs < STARTUP_AUDIO_WAIT_MS ? "playing" : "complete";
  }

  function completeStartupAudioPhase() {
    return "complete";
  }

  function shouldZeroCallerSamples(captureState, nowMs) {
    if (captureState.startupAudioPhase === "playing") return true;
    if (
      captureState.startupAudioPhase === "waiting" &&
      nowMs - captureState.connectedAt < STARTUP_AUDIO_WAIT_MS
    ) {
      return true;
    }
    return (
      captureState.responseAudioActive &&
      nowMs - captureState.agentPlayStartedAt < AGENT_BARGE_ARM_DELAY_MS
    );
  }

  function selectCallerSamples(samples, captureState, nowMs) {
    return shouldZeroCallerSamples(captureState, nowMs)
      ? new Float32Array(samples.length)
      : samples;
  }

  function pcm16FramePeak(frame) {
    if (!(frame instanceof Uint8Array) || frame[0] !== 0x01) return 0;
    var count = Math.floor((frame.byteLength - 1) / 2);
    var view = new DataView(frame.buffer, frame.byteOffset + 1, count * 2);
    var peak = 0;
    for (var i = 0; i < count; i += 1) {
      peak = Math.max(peak, Math.abs(view.getInt16(i * 2, true)));
    }
    return peak;
  }

  function controlFrame(payload) {
    var encoded = new TextEncoder().encode(JSON.stringify(payload));
    var frame = new Uint8Array(encoded.length + 1);
    frame[0] = 0x03;
    frame.set(encoded, 1);
    return frame;
  }

  function closeForProtocolViolation(reason) {
    if (state.protocolCloseRequested ||
      !state.ws ||
      state.ws.readyState > WebSocket.OPEN) {
      return false;
    }
    state.protocolCloseRequested = true;
    state.protocolCloseAttempts += 1;
    state.ws.close(PROTOCOL_VIOLATION_CLOSE_CODE, reason);
    return true;
  }

  function schedulePcm(bytes) {
    var count = Math.floor(bytes.byteLength / 2);
    if (!count || !state.inputContext) return;
    var buffer = state.inputContext.createBuffer(1, count, 24000);
    var channel = buffer.getChannelData(0);
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (var i = 0; i < count; i += 1) channel[i] = view.getInt16(i * 2, true) / 32768;
    var source = state.inputContext.createBufferSource();
    source.buffer = buffer;
    source.connect(state.inputContext.destination);
    state.playAt = Math.max(state.inputContext.currentTime + 0.025, state.playAt);
    source.start(state.playAt);
    state.playAt += buffer.duration;
    state.sources.push(source);
    source.onended = function () {
      var index = state.sources.indexOf(source);
      if (index >= 0) state.sources.splice(index, 1);
      if (!state.sources.length) {
        clearTimeout(state.agentEndTimer);
        state.agentEndTimer = setTimeout(function () {
          if (!state.sources.length && state.responseAudioActive) {
            state.responseAudioActive = false;
            state.agentPlayStartedAt = 0;
            state.startupAudioPhase = completeStartupAudioPhase(
              state.startupAudioPhase,
            );
            clearTimeout(state.agentSpeakingTimer);
            state.agentSpeakingTimer = null;
            setAgentState("listening");
          }
        }, AGENT_AUDIO_END_GRACE_MS);
      }
    };
  }

  function flushPendingAudio() {
    if (!state.playbackReady || !state.inputContext) return;
    var pending = state.pendingAudio.splice(0);
    pending.forEach(schedulePcm);
  }

  function playPcm(bytes) {
    if (!state.playbackReady || !state.inputContext) {
      state.pendingAudio.push(new Uint8Array(bytes));
      return;
    }
    schedulePcm(bytes);
  }

  function safeTranscriptText(value) {
    if (typeof value !== "string" || !value || value.length > MAX_TRANSCRIPT_CHARS) return null;
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return null;
    return value;
  }

  function normalizeTranscriptBody(bytes) {
    if (!bytes || !bytes.length || bytes.length > MAX_TRANSCRIPT_BYTES) return null;
    var decoded;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (_) {
      return null;
    }
    if (decoded.trimStart().charAt(0) !== "{") {
      var delta = safeTranscriptText(decoded);
      return delta ? {
        event: "transcript",
        role: "user",
        text: delta,
        final: false,
        mode: "delta",
      } : null;
    }
    var payload;
    try {
      payload = JSON.parse(decoded);
    } catch (_) {
      return null;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    var keys = Object.keys(payload);
    if (keys.length !== 4 ||
      !["event", "role", "text", "final"].every(function (key) { return keys.indexOf(key) >= 0; })) return null;
    if (payload.event !== "transcript") return null;
    if (payload.role !== "user" && payload.role !== "assistant") return null;
    var normalizedText = safeTranscriptText(payload.text);
    if (!normalizedText) return null;
    if (typeof payload.final !== "boolean") return null;
    return {
      event: "transcript",
      role: payload.role,
      text: normalizedText,
      final: payload.final,
      mode: "replace",
    };
  }

  function nonNegativeFiniteNumber(value) {
    return typeof value === "number" && isFinite(value) && value >= 0;
  }

  function normalizeServerControl(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    if (typeof payload.event === "string" && payload.event &&
      payload.event !== "transcript") {
      return payload;
    }
    var keys = Object.keys(payload);
    var allowed = {
      type: true,
      call_id: true,
      sent_ms: true,
      realtime_ms: true,
    };
    if (payload.type !== "audio_position" ||
      !keys.every(function (key) { return allowed[key] === true; }) ||
      !nonNegativeFiniteNumber(payload.sent_ms) ||
      !nonNegativeFiniteNumber(payload.realtime_ms) ||
      (payload.call_id !== undefined &&
        (typeof payload.call_id !== "string" || !payload.call_id))) {
      return null;
    }
    var normalized = {};
    keys.forEach(function (key) { normalized[key] = payload[key]; });
    normalized.event = "audio_position";
    return normalized;
  }

  function activeTranscriptRow(role) {
    var history = state.transcriptHistory;
    var row = history.length ? history[history.length - 1] : null;
    return row && !row.final && row.role === role ? row : null;
  }

  function emitTranscriptRow(row) {
    emit("transcript", {
      version: 1,
      role: row.role,
      text: row.text,
      final: row.final,
    });
  }

  function applyTranscript(transcript) {
    if (!transcript) return false;
    var history = state.transcriptHistory;
    var active = activeTranscriptRow(transcript.role);
    if (active) {
      var nextText = transcript.mode === "delta"
        ? active.text + transcript.text
        : transcript.text;
      if (!safeTranscriptText(nextText)) return false;
      if (active.text === nextText && active.final === transcript.final) return false;
      active.text = nextText;
      active.final = transcript.final;
    } else {
      history.push({ role: transcript.role, text: transcript.text, final: transcript.final });
      while (history.length > MAX_TRANSCRIPT_ROWS) history.shift();
    }
    return true;
  }

  function renderTranscriptRows() {
    if (!state.panel) return;
    var log = state.panel.querySelector(".pyai-v7-transcript");
    while (log.firstChild) log.removeChild(log.firstChild);
    for (var i = 0; i < state.transcriptHistory.length; i += 1) {
      var transcript = state.transcriptHistory[i];
      var row = element("div", "",
        (transcript.role === "user" ? "You: " : "Agent: ") + transcript.text);
      row.setAttribute("data-role", transcript.role);
      row.setAttribute("data-final", String(transcript.final));
      if (!transcript.final) row.setAttribute("data-partial", transcript.role);
      log.appendChild(row);
    }
    log.scrollTop = log.scrollHeight;
  }

  function appendTranscript(transcript) {
    if (!transcript || !state.panel || !applyTranscript(transcript)) return;
    renderTranscriptRows();
    var row = activeTranscriptRow(transcript.role) ||
      state.transcriptHistory[state.transcriptHistory.length - 1];
    emitTranscriptRow(row);
  }

  function decodeTaggedFrame(buffer) {
    var bytes = new Uint8Array(buffer);
    if (!bytes.length) return { kind: "unknown", payload: null, bytes: bytes };
    if (bytes[0] === 0x01) return { kind: "audio", payload: null, bytes: bytes.subarray(1) };
    if (bytes[0] !== 0x02 && bytes[0] !== 0x03) {
      return { kind: "unknown", payload: null, bytes: bytes.subarray(1) };
    }
    var body = bytes.subarray(1);
    if (bytes[0] === 0x02) {
      return { kind: "transcript", payload: normalizeTranscriptBody(body), bytes: body };
    }
    var payload;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
    catch (_) { return { kind: "unknown", payload: null, bytes: body }; }
    payload = normalizeServerControl(payload);
    if (!payload) {
      return { kind: "unknown", payload: null, bytes: body };
    }
    return {
      kind: "control",
      payload: payload,
      bytes: body,
    };
  }

  function handleFrame(buffer) {
    var frame = decodeTaggedFrame(buffer);
    if (frame.kind === "audio") {
      clearTimeout(state.agentEndTimer);
      state.agentEndTimer = null;
      if (!state.responseAudioActive) {
        state.responseAudioActive = true;
        state.agentPlayStartedAt = Date.now();
        state.startupAudioPhase = beginStartupAudioPhase(
          state.startupAudioPhase,
          state.agentPlayStartedAt,
          state.connectedAt,
        );
        setAgentState("thinking");
        clearTimeout(state.agentSpeakingTimer);
        state.agentSpeakingTimer = setTimeout(function () {
          state.agentSpeakingTimer = null;
          if (state.responseAudioActive) setAgentState("agent_speaking");
        }, AGENT_STATE_TRANSITION_MS);
      }
      playPcm(frame.bytes);
      return;
    }
    if (!frame.payload) {
      closeForProtocolViolation("invalid_binary_frame");
      return;
    }
    var payload = frame.payload;
    if (frame.kind === "transcript") appendTranscript(payload);
    if (payload.event === "flush" || payload.event === "barge_in") {
      stopSources();
      state.responseAudioActive = false;
      state.agentPlayStartedAt = 0;
      state.startupAudioPhase = completeStartupAudioPhase(
        state.startupAudioPhase,
      );
      clearTimeout(state.agentSpeakingTimer);
      state.agentSpeakingTimer = null;
      setAgentState("listening");
    }
    if (payload.event === "configured" || payload.event === "session_started") setAgentState("listening");
    if (payload.event === "session_end") end();
  }

  function startMicrophone() {
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(function (stream) {
        state.stream = stream;
        var AudioContextClass = window.AudioContext || window.webkitAudioContext;
        state.inputContext = new AudioContextClass({ sampleRate: 24000 });
        state.playbackReady = false;
        var source = state.inputContext.createMediaStreamSource(stream);
        state.processor = state.inputContext.createScriptProcessor(2048, 1, 1);
        state.captureMute = state.inputContext.createGain();
        state.captureMute.gain.value = 0;
        state.processor.onaudioprocess = function (event) {
          if (state.muted || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
          var samples = event.inputBuffer.getChannelData(0);
          state.ws.send(
            pcm16Frame(
              selectCallerSamples(samples, state, Date.now()),
              state.inputContext.sampleRate,
            ),
          );
        };
        source.connect(state.processor);
        state.processor.connect(state.captureMute);
        state.captureMute.connect(state.inputContext.destination);
        return Promise.resolve(state.inputContext.resume()).then(function () {
          state.playbackReady = state.inputContext.state === "running";
          if (!state.playbackReady) {
            throw new Error("Audio playback is not ready.");
          }
          state.playAt = state.inputContext.currentTime;
          flushPendingAudio();
        });
      })
      .catch(function (error) {
        if (error && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
          throw errorDetail("mic_permission_denied");
        }
        throw errorDetail("session_unavailable");
      });
  }

  function setStatus(value) {
    if (!state.panel) return;
    state.panel.querySelector(".pyai-v7-status").textContent = value;
  }

  function setAgentState(value) {
    if (state.agentState === value) return;
    state.agentState = value;
    var label = value === "agent_speaking" ? "Agent speaking" :
      value === "thinking" ? "Thinking" : "Listening";
    setStatus(label);
    emit("state", { version: 1, state: value, label: label });
  }

  function connect(session) {
    if (!browserSupported()) return Promise.reject(errorDetail("unsupported_browser"));
    setStatus("Requesting microphone access…");
    return startMicrophone().then(function () {
      setStatus("Connecting…");
      var url = new URL(session.url);
      url.searchParams.set("session_label", session.session_label);
      try {
        state.ws = new WebSocket(url.toString(), ["pyai-key." + session.token]);
      } catch (_) {
        throw errorDetail("websocket_failed");
      }
      state.protocolCloseRequested = false;
      state.protocolCloseAttempts = 0;
      state.wsErrorEmitted = false;
      state.ws.binaryType = "arraybuffer";
      state.ws.onopen = function () {
        state.connected = true;
        state.startupAudioPhase = "waiting";
        state.connectedAt = Date.now();
        setStatus("Connected. Start speaking.");
        state.ws.send(controlFrame(session.configure || { type: "configure" }));
        emit("connected", {});
      };
      state.ws.onmessage = function (event) {
        if (event.data instanceof ArrayBuffer) handleFrame(event.data);
        else if (event.data instanceof Blob) event.data.arrayBuffer().then(handleFrame);
        else closeForProtocolViolation("binary_frames_required");
      };
      state.ws.onerror = function () {
        if (!state.wsErrorEmitted) {
          state.wsErrorEmitted = true;
          var detail = emitWebSocketError(true);
          setStatus(detail.message);
        }
      };
      state.ws.onclose = function (event) {
        releaseCallResources();
        state.ws = null;
        if (event && event.code !== 1000 && !state.wsErrorEmitted) {
          state.wsErrorEmitted = true;
          var retryable = event.code !== 1008;
          var detail = emitWebSocketError(retryable);
          setStatus(detail.message);
        } else if (!state.wsErrorEmitted) {
          setStatus("Call ended.");
        }
      };
    });
  }

  function fetchSession() {
    setStatus("Preparing a secure session…");
    return window.fetch(sessionUrl, { method: "POST", mode: "cors", credentials: "omit", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(function (response) {
        if (!response.ok) return parseErrorResponse(response, "session");
        return response.json();
      })
      .catch(function (error) {
        throw normalizeThrown(error, "session_unavailable");
      });
  }

  function trapFocus(event) {
    if (!state.panel || event.key !== "Tab") return;
    var nodes = state.panel.querySelectorAll("button,a[href]");
    if (!nodes.length) return;
    var first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function open() {
    if (!state.config || state.panel) return;
    state.previousFocus = document.activeElement;
    var root = element("div", "pyai-v7 pyai-v7-backdrop");
    root.setAttribute("data-theme", state.config.theme);
    root.style.setProperty("--pa", state.config.accent);
    root.style.setProperty("--pa-text", accentText(state.config.accent));
    var dialog = element("section", "pyai-v7-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", instanceId + "-title");
    var head = element("div", "pyai-v7-head");
    var heading = element("div");
    var title = element("h2", "", state.config.title);
    title.id = instanceId + "-title";
    heading.appendChild(title);
    heading.appendChild(element("p", "", state.config.subtitle));
    var close = element("button", "pyai-v7-close", "×");
    close.type = "button"; close.setAttribute("aria-label", "Close voice agent"); close.addEventListener("click", end);
    head.appendChild(heading); head.appendChild(close);
    var body = element("div", "pyai-v7-body");
    var status = element("div", "pyai-v7-status", "Preparing a secure session…");
    status.setAttribute("aria-live", "polite");
    body.appendChild(status);
    var consent = element("div", "pyai-v7-consent");
    consent.hidden = true;
    body.appendChild(consent);
    var transcript = element("div", "pyai-v7-transcript");
    transcript.setAttribute("role", "log"); transcript.setAttribute("aria-live", "polite");
    body.appendChild(transcript);
    var actions = element("div", "pyai-v7-actions");
    var mute = element("button", "pyai-v7-btn", "Mute");
    mute.type = "button";
    mute.addEventListener("click", function () {
      state.muted = !state.muted;
      mute.textContent = state.muted ? "Unmute" : "Mute";
      emit("mute", { muted: state.muted });
    });
    var endButton = element("button", "pyai-v7-btn", "End");
    endButton.type = "button"; endButton.addEventListener("click", end);
    actions.appendChild(mute); actions.appendChild(endButton);
    dialog.appendChild(head); dialog.appendChild(body); dialog.appendChild(actions);
    var referralOverride = safeReferral(script.getAttribute("data-referral"));
    var referral = referralOverride || safeReferral(state.config.referralCode);
    if (state.config.branding === "show") {
      var brand = element("a", "pyai-v7-brand", "Powered by PyAI");
      brand.href = brandingUrl(state.config.variant, referral);
      brand.target = "_blank"; brand.rel = "noopener noreferrer";
      brand.setAttribute("aria-label", "Powered by PyAI (opens in a new tab)");
      brand.addEventListener("click", function () { emit("branding-click", { variant: state.config.variant, referralCode: referral }); });
      dialog.appendChild(brand);
    }
    root.appendChild(dialog); document.body.appendChild(root); state.panel = root;
    root.addEventListener("keydown", function (event) {
      if (event.key === "Escape") end();
      trapFocus(event);
    });
    close.focus();
    emit("open", {});
    if (state.config.consentRequired) {
      consent.hidden = false;
      consent.textContent = text(state.config.consentLine, "This conversation may be recorded.");
      var consentDetail = emitError("consent_required");
      setStatus(consentDetail.message);
      var allow = element("button", "pyai-v7-btn pyai-v7-primary", "Continue and allow microphone");
      allow.type = "button";
      actions.insertBefore(allow, mute);
      mute.hidden = true;
      allow.addEventListener("click", function () {
        allow.disabled = true;
        fetchSession()
          .then(connect)
          .then(function () { allow.remove(); mute.hidden = false; })
          .catch(sessionError);
      });
    } else {
      fetchSession().then(connect).catch(sessionError);
    }
  }

  function sessionError(error) {
    var detail = normalizeThrown(error, "session_unavailable");
    setStatus(detail.message);
    emitError(detail.code, detail.request_id, detail.retryable);
  }

  function end() {
    if (state.ws) {
      try {
        if (state.ws.readyState === WebSocket.OPEN) state.ws.send(controlFrame({ type: "session_ending" }));
        state.ws.onerror = null;
        state.ws.onclose = null;
        state.ws.close(1000, "client ended");
      } catch (_) {}
    }
    state.ws = null;
    releaseCallResources();
    state.connected = false; state.wsErrorEmitted = false;
    state.protocolCloseRequested = false;
    state.protocolCloseAttempts = 0;
    state.agentState = null;
    state.responseAudioActive = false;
    state.agentPlayStartedAt = 0;
    state.startupAudioPhase = "waiting";
    state.connectedAt = 0;
    state.playbackReady = false;
    state.pendingAudio = [];
    clearTimeout(state.agentEndTimer);
    state.agentEndTimer = null;
    clearTimeout(state.agentSpeakingTimer);
    state.agentSpeakingTimer = null;
    state.transcriptHistory = [];
    if (state.panel) state.panel.remove();
    state.panel = null;
    if (state.previousFocus && state.previousFocus.focus) state.previousFocus.focus();
    emit("close", {});
  }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    end();
    if (state.launcher) state.launcher.remove();
    state.launcher = null;
  }

  function executeAction() {
    var action = state.config.action || { type: "voice" };
    if (action.type === "voice") return open();
    if (action.type === "url" && /^https:\/\//.test(action.url || "")) {
      if (action.target === "same") window.location.assign(action.url);
      else window.open(action.url, "_blank", "noopener,noreferrer");
    } else if (action.type === "tel" && /^\+?[0-9]{3,15}$/.test(action.tel || "")) {
      window.location.href = "tel:" + action.tel;
    } else if (action.type === "event") {
      emit("action", { action: "event", value: action.value || null });
    }
  }

  function renderLauncher(config) {
    if (config.headless) return;
    var launcher = element("button", "pyai-v7 pyai-v7-launch");
    launcher.type = "button";
    launcher.style.setProperty("--pa", config.accent);
    launcher.style.setProperty("--pa-text", accentText(config.accent));
    launcher.setAttribute("aria-label", config.label);
    if (config.position === "bottom-left") launcher.classList.add("pyai-v7-left");
    if (config.variant === "orb") launcher.classList.add("pyai-v7-orb");
    if (config.variant === "card") {
      launcher.classList.add("pyai-v7-card");
      launcher.appendChild(element("b", "", config.title));
      launcher.appendChild(element("span", "", config.subtitle));
    } else {
      launcher.textContent = config.label;
    }
    if (config.variant === "inline") {
      launcher.classList.add("pyai-v7-inline");
      script.parentNode.insertBefore(launcher, script.nextSibling);
    } else document.body.appendChild(launcher);
    launcher.addEventListener("click", executeAction);
    state.launcher = launcher;
  }

  function normalizePublic(body) {
    var value = body && body.config || {};
    var transcriptCapability = body && body.capabilities &&
      body.capabilities.transcript === "full" ? "full" : "caller";
    return {
      variant: /^(orb|pill|card|inline)$/.test(value.variant) ? value.variant : "pill",
      position: value.position === "bottom-left" ? "bottom-left" : "bottom-right",
      theme: /^(auto|light|dark)$/.test(value.theme) ? value.theme : "auto",
      density: value.density === "compact" ? "compact" : "comfortable",
      accent: /^#[0-9a-fA-F]{6}$/.test(value.accent || "") ? value.accent : "#5b5bd6",
      label: text(value.label, "Talk to us"),
      title: text(value.title, "Talk with our team"),
      subtitle: text(value.subtitle, "Ask a question by voice."),
      branding: value.branding === "hide" ? "hide" : "show",
      headless: value.headless === true,
      action: value.action && typeof value.action === "object" ? value.action : { type: "voice" },
      referralCode: safeReferral(body.referral_code),
      consentRequired: body && body.profile && body.profile.recording_consent_required === true,
      consentLine: body && body.profile ? body.profile.consent_line : null,
      capabilities: {
        transcript: transcriptCapability,
        transcriptEventVersion: 1,
        agentState: true,
      },
    };
  }

  installStyles();
  if (typeof window.fetch !== "function") {
    var unsupported = emitError("unsupported_browser");
    renderUnavailable(unsupported.message);
  } else {
    window.fetch(configUrl, { method: "GET", mode: "cors", credentials: "omit" })
      .then(function (response) {
        if (!response.ok) return parseErrorResponse(response, "config");
        return response.json();
      })
      .then(function (body) {
        if (!browserSupported()) {
          var unsupported = emitError("unsupported_browser");
          renderUnavailable(unsupported.message);
          return;
        }
        state.config = normalizePublic(body);
        renderLauncher(state.config);
        emit("ready", { version: VERSION });
      })
      .catch(function (error) {
        var detail = normalizeThrown(error, "config_unavailable");
        emitError(detail.code, detail.request_id, detail.retryable);
        renderUnavailable(detail.message);
      });
  }

  function select(id) { return !id || id === publicId || id === instanceId; }
  var api = window.PyAIWidget || {};
  api.open = function (id) { if (select(id)) open(); };
  api.close = function (id) { if (select(id)) end(); };
  api.toggle = function (id) { if (select(id)) state.panel ? end() : open(); };
  api.destroy = function (id) {
    if (!select(id)) return;
    destroy();
  };
  api.getConfig = function (id) {
    if (!select(id) || !state.config) return null;
    return {
      widgetId: publicId,
      variant: state.config.variant,
      position: state.config.position,
      theme: state.config.theme,
      density: state.config.density,
      accent: state.config.accent,
      label: state.config.label,
      title: state.config.title,
      subtitle: state.config.subtitle,
      branding: state.config.branding,
      headless: state.config.headless,
      action: state.config.action,
      referralCode: state.config.referralCode,
      capabilities: state.config.capabilities,
    };
  };
  window.PyAIWidget = api;
  window.addEventListener("pagehide", destroy);
  window.addEventListener("beforeunload", destroy);
  if (typeof window.MutationObserver === "function" && document.documentElement) {
    new window.MutationObserver(function () {
      if (!script.isConnected) destroy();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  if (window.__PYAI_WIDGET_TEST__) {
    window.__PYAI_WIDGET_TEST__.helpers = {
      safeReferral: safeReferral,
      brandingUrl: brandingUrl,
      normalizePublic: normalizePublic,
      pcm16Frame: pcm16Frame,
      pcm16FramePeak: pcm16FramePeak,
      beginStartupAudioPhase: beginStartupAudioPhase,
      completeStartupAudioPhase: completeStartupAudioPhase,
      shouldZeroCallerSamples: shouldZeroCallerSamples,
      selectCallerSamples: selectCallerSamples,
      openingAudioPolicyVersion: OPENING_AUDIO_POLICY_VERSION,
      startupAudioWaitMs: STARTUP_AUDIO_WAIT_MS,
      agentBargeArmDelayMs: AGENT_BARGE_ARM_DELAY_MS,
      agentAudioEndGraceMs: AGENT_AUDIO_END_GRACE_MS,
      controlFrame: controlFrame,
      closeForProtocolViolation: closeForProtocolViolation,
      protocolViolationCloseCode: PROTOCOL_VIOLATION_CLOSE_CODE,
      decodeTaggedFrame: decodeTaggedFrame,
      normalizeTranscriptBody: normalizeTranscriptBody,
      normalizeServerControl: normalizeServerControl,
      applyTranscript: applyTranscript,
      handleFrame: handleFrame,
      setAgentState: setAgentState,
      classifyBrokerError: classifyBrokerError,
      errorDetail: errorDetail,
      emitWebSocketError: emitWebSocketError,
      browserSupported: browserSupported,
      startMicrophone: startMicrophone,
      sessionError: sessionError,
      end: end,
      state: state,
    };
  }
})();
