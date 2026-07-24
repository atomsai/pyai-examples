(function () {
  "use strict";

  var VERSION = "4.0.0";
  var scripts = document.querySelectorAll('script[src*="/widget/v4/pyai-widget.js"]');
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
    outputContext: null,
    processor: null,
    muted: false,
    connected: false,
    sources: [],
    playAt: 0,
    previousFocus: null,
  };

  function emit(name, detail) {
    var value = detail || {};
    value.widgetId = publicId;
    value.instanceId = instanceId;
    window.dispatchEvent(new CustomEvent("pyai:widget:" + name, { detail: value }));
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
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

  function installStyles() {
    if (document.getElementById("pyai-widget-v4-styles")) return;
    var style = element("style");
    style.id = "pyai-widget-v4-styles";
    var nonce = script.nonce || script.getAttribute("nonce");
    if (nonce) style.nonce = nonce;
    style.textContent =
      ".pyai-v4{--pa:#5b5bd6;font-family:Inter,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:#171411}" +
      ".pyai-v4-launch{position:fixed;z-index:2147483000;bottom:max(20px,env(safe-area-inset-bottom));right:20px;border:0;background:var(--pa);color:#fff;border-radius:999px;min-height:52px;padding:0 20px;font:600 15px inherit;box-shadow:0 12px 35px rgba(0,0,0,.22);cursor:pointer}" +
      ".pyai-v4-left{right:auto;left:20px}.pyai-v4-orb{width:56px;height:56px;padding:0;font-size:0}.pyai-v4-orb:after{content:'🎙';font-size:21px}" +
      ".pyai-v4-card{width:300px;border-radius:20px;text-align:left;padding:18px;background:#fff;color:#171411;border:1px solid #e6e1d8}.pyai-v4-card b,.pyai-v4-card span{display:block}.pyai-v4-card span{margin-top:5px;color:#696158;font-size:13px}" +
      ".pyai-v4-inline{position:static;box-shadow:none}.pyai-v4[hidden]{display:none!important}" +
      ".pyai-v4-backdrop{position:fixed;z-index:2147483001;inset:0;background:rgba(20,17,14,.48);display:grid;place-items:end center;padding:20px}" +
      ".pyai-v4-dialog{width:min(420px,100%);max-height:min(680px,calc(100vh - 40px));display:flex;flex-direction:column;background:#fff;border-radius:24px;box-shadow:0 22px 70px rgba(0,0,0,.28);overflow:hidden}" +
      ".pyai-v4-head{display:flex;align-items:flex-start;justify-content:space-between;padding:20px;border-bottom:1px solid #ece8e2}.pyai-v4-head h2{font-size:18px;margin:0}.pyai-v4-head p{font-size:13px;color:#716960;margin:5px 0 0}.pyai-v4-close{border:0;background:transparent;font-size:24px;cursor:pointer}" +
      ".pyai-v4-body{padding:18px;overflow:auto;min-height:180px}.pyai-v4-status{font-size:14px;color:#655e56}.pyai-v4-consent{margin:14px 0;padding:14px;border-radius:14px;background:#f4f1ff;font-size:14px;line-height:1.45}.pyai-v4-transcript{margin-top:14px;display:grid;gap:8px;font-size:14px}.pyai-v4-transcript div{padding:9px 11px;border-radius:12px;background:#f6f4f0}" +
      ".pyai-v4-actions{display:flex;gap:10px;padding:16px 18px;border-top:1px solid #ece8e2}.pyai-v4-btn{flex:1;border:1px solid #ddd6cc;background:#fff;border-radius:999px;min-height:44px;font:600 14px inherit;cursor:pointer}.pyai-v4-primary{border-color:var(--pa);background:var(--pa);color:#fff}" +
      ".pyai-v4-brand{display:block;text-align:center;padding:0 0 14px;font-size:11px;color:#817970}.pyai-v4-brand:focus-visible,.pyai-v4-btn:focus-visible,.pyai-v4-launch:focus-visible{outline:3px solid color-mix(in srgb,var(--pa) 45%,transparent);outline-offset:3px}" +
      "@media(max-width:640px){.pyai-v4-backdrop{padding:0;align-items:end}.pyai-v4-dialog{width:100%;max-height:88vh;border-radius:24px 24px 0 0;padding-bottom:env(safe-area-inset-bottom)}}" +
      "@media(prefers-color-scheme:dark){.pyai-v4[data-theme=auto] .pyai-v4-dialog,.pyai-v4[data-theme=dark] .pyai-v4-dialog{background:#181613;color:#f7f2ea}.pyai-v4[data-theme=auto] .pyai-v4-head,.pyai-v4[data-theme=auto] .pyai-v4-actions,.pyai-v4[data-theme=dark] .pyai-v4-head,.pyai-v4[data-theme=dark] .pyai-v4-actions{border-color:#332e28}.pyai-v4[data-theme=auto] .pyai-v4-transcript div,.pyai-v4[data-theme=dark] .pyai-v4-transcript div{background:#24201c}}";
    document.head.appendChild(style);
  }

  function stopSources() {
    state.sources.forEach(function (source) {
      try { source.stop(); } catch (_) {}
    });
    state.sources = [];
    state.playAt = 0;
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

  function controlFrame(payload) {
    var encoded = new TextEncoder().encode(JSON.stringify(payload));
    var frame = new Uint8Array(encoded.length + 1);
    frame[0] = 0x03;
    frame.set(encoded, 1);
    return frame;
  }

  function playPcm(bytes) {
    if (!state.outputContext) state.outputContext = new AudioContext({ sampleRate: 24000 });
    var count = Math.floor(bytes.byteLength / 2);
    var buffer = state.outputContext.createBuffer(1, count, 24000);
    var channel = buffer.getChannelData(0);
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (var i = 0; i < count; i += 1) channel[i] = view.getInt16(i * 2, true) / 32768;
    var source = state.outputContext.createBufferSource();
    source.buffer = buffer;
    source.connect(state.outputContext.destination);
    state.playAt = Math.max(state.outputContext.currentTime + 0.025, state.playAt);
    source.start(state.playAt);
    state.playAt += buffer.duration;
    state.sources.push(source);
    source.onended = function () {
      var index = state.sources.indexOf(source);
      if (index >= 0) state.sources.splice(index, 1);
    };
  }

  function appendTranscript(payload) {
    var value = payload.text || payload.transcript || payload.delta;
    if (!value || !state.panel) return;
    var log = state.panel.querySelector(".pyai-v4-transcript");
    var row = element("div", "", String(value));
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    emit("transcript", { transcript: payload });
  }

  function handleFrame(buffer) {
    var bytes = new Uint8Array(buffer);
    if (!bytes.length) return;
    if (bytes[0] === 0x01) {
      playPcm(bytes.subarray(1));
      return;
    }
    if (bytes[0] !== 0x02 && bytes[0] !== 0x03) return;
    var payload;
    try { payload = JSON.parse(new TextDecoder().decode(bytes.subarray(1))); } catch (_) { return; }
    if (bytes[0] === 0x02 || payload.event === "transcript") appendTranscript(payload);
    if (payload.event === "flush" || payload.event === "barge_in") stopSources();
    if (payload.event === "session_end") end();
  }

  function startMicrophone() {
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(function (stream) {
        state.stream = stream;
        state.inputContext = new AudioContext();
        var source = state.inputContext.createMediaStreamSource(stream);
        state.processor = state.inputContext.createScriptProcessor(2048, 1, 1);
        state.processor.onaudioprocess = function (event) {
          if (state.muted || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
          state.ws.send(pcm16Frame(event.inputBuffer.getChannelData(0), state.inputContext.sampleRate));
        };
        source.connect(state.processor);
        state.processor.connect(state.inputContext.destination);
      });
  }

  function setStatus(value) {
    if (!state.panel) return;
    state.panel.querySelector(".pyai-v4-status").textContent = value;
  }

  function connect(session) {
    setStatus("Requesting microphone access…");
    return startMicrophone().then(function () {
      setStatus("Connecting…");
      var url = new URL(session.url);
      url.searchParams.set("session_label", session.session_label);
      state.ws = new WebSocket(url.toString(), ["pyai-key." + session.token]);
      state.ws.binaryType = "arraybuffer";
      state.ws.onopen = function () {
        state.connected = true;
        setStatus("Connected. Start speaking.");
        state.ws.send(controlFrame(session.configure || { type: "configure" }));
        emit("connected", {});
      };
      state.ws.onmessage = function (event) {
        if (event.data instanceof ArrayBuffer) handleFrame(event.data);
        else if (event.data instanceof Blob) event.data.arrayBuffer().then(handleFrame);
      };
      state.ws.onerror = function () {
        setStatus("The voice session could not connect.");
        emit("error", { code: "socket_error" });
      };
      state.ws.onclose = function () {
        state.connected = false;
        setStatus("Call ended.");
      };
    });
  }

  function fetchSession() {
    setStatus("Preparing a secure session…");
    return fetch(sessionUrl, { method: "POST", mode: "cors", credentials: "omit", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(function (response) {
        if (!response.ok) throw new Error(response.status === 429 ? "This voice agent has reached today's session limit." : "Voice is unavailable right now.");
        return response.json();
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
    var root = element("div", "pyai-v4 pyai-v4-backdrop");
    root.setAttribute("data-theme", state.config.theme);
    root.style.setProperty("--pa", state.config.accent);
    var dialog = element("section", "pyai-v4-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", instanceId + "-title");
    var head = element("div", "pyai-v4-head");
    var heading = element("div");
    var title = element("h2", "", state.config.title);
    title.id = instanceId + "-title";
    heading.appendChild(title);
    heading.appendChild(element("p", "", state.config.subtitle));
    var close = element("button", "pyai-v4-close", "×");
    close.type = "button"; close.setAttribute("aria-label", "Close voice agent"); close.addEventListener("click", end);
    head.appendChild(heading); head.appendChild(close);
    var body = element("div", "pyai-v4-body");
    var status = element("div", "pyai-v4-status", "Preparing a secure session…");
    status.setAttribute("aria-live", "polite");
    body.appendChild(status);
    var consent = element("div", "pyai-v4-consent");
    consent.hidden = true;
    body.appendChild(consent);
    var transcript = element("div", "pyai-v4-transcript");
    transcript.setAttribute("role", "log"); transcript.setAttribute("aria-live", "polite");
    body.appendChild(transcript);
    var actions = element("div", "pyai-v4-actions");
    var mute = element("button", "pyai-v4-btn", "Mute");
    mute.type = "button";
    mute.addEventListener("click", function () {
      state.muted = !state.muted;
      mute.textContent = state.muted ? "Unmute" : "Mute";
      emit("mute", { muted: state.muted });
    });
    var endButton = element("button", "pyai-v4-btn", "End");
    endButton.type = "button"; endButton.addEventListener("click", end);
    actions.appendChild(mute); actions.appendChild(endButton);
    dialog.appendChild(head); dialog.appendChild(body); dialog.appendChild(actions);
    var referralOverride = safeReferral(script.getAttribute("data-referral"));
    var referral = referralOverride || safeReferral(state.config.referralCode);
    if (state.config.branding === "show") {
      var brand = element("a", "pyai-v4-brand", "Powered by PyAI");
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
      setStatus("Review the recording notice before enabling your microphone.");
      var allow = element("button", "pyai-v4-btn pyai-v4-primary", "Continue and allow microphone");
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
    setStatus(error && error.message ? error.message : "Voice is unavailable right now.");
    emit("error", { code: "session_error" });
  }

  function end() {
    if (state.ws) {
      try {
        if (state.ws.readyState === WebSocket.OPEN) state.ws.send(controlFrame({ type: "session_ending" }));
        state.ws.close(1000, "client ended");
      } catch (_) {}
    }
    state.ws = null;
    if (state.processor) { try { state.processor.disconnect(); } catch (_) {} }
    if (state.stream) state.stream.getTracks().forEach(function (track) { track.stop(); });
    if (state.inputContext) state.inputContext.close().catch(function () {});
    if (state.outputContext) state.outputContext.close().catch(function () {});
    stopSources();
    state.stream = null; state.processor = null; state.inputContext = null; state.outputContext = null;
    state.connected = false;
    if (state.panel) state.panel.remove();
    state.panel = null;
    if (state.previousFocus && state.previousFocus.focus) state.previousFocus.focus();
    emit("close", {});
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
    var launcher = element("button", "pyai-v4 pyai-v4-launch");
    launcher.type = "button";
    launcher.style.setProperty("--pa", config.accent);
    launcher.setAttribute("aria-label", config.label);
    if (config.position === "bottom-left") launcher.classList.add("pyai-v4-left");
    if (config.variant === "orb") launcher.classList.add("pyai-v4-orb");
    if (config.variant === "card") {
      launcher.classList.add("pyai-v4-card");
      launcher.appendChild(element("b", "", config.title));
      launcher.appendChild(element("span", "", config.subtitle));
    } else {
      launcher.textContent = config.label;
    }
    if (config.variant === "inline") {
      launcher.classList.add("pyai-v4-inline");
      script.parentNode.insertBefore(launcher, script.nextSibling);
    } else document.body.appendChild(launcher);
    launcher.addEventListener("click", executeAction);
    state.launcher = launcher;
  }

  function normalizePublic(body) {
    var value = body && body.config || {};
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
    };
  }

  installStyles();
  fetch(configUrl, { method: "GET", mode: "cors", credentials: "omit" })
    .then(function (response) {
      if (!response.ok) throw new Error("Widget is unavailable.");
      return response.json();
    })
    .then(function (body) {
      state.config = normalizePublic(body);
      renderLauncher(state.config);
      emit("ready", { version: VERSION });
    })
    .catch(function () { emit("error", { code: "config_unavailable" }); });

  function select(id) { return !id || id === publicId || id === instanceId; }
  var api = window.PyAIWidget || {};
  api.open = function (id) { if (select(id)) open(); };
  api.close = function (id) { if (select(id)) end(); };
  api.toggle = function (id) { if (select(id)) state.panel ? end() : open(); };
  api.destroy = function (id) {
    if (!select(id)) return;
    end();
    if (state.launcher) state.launcher.remove();
    state.launcher = null;
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
    };
  };
  window.PyAIWidget = api;

  if (window.__PYAI_WIDGET_TEST__) {
    window.__PYAI_WIDGET_TEST__.helpers = {
      safeReferral: safeReferral,
      brandingUrl: brandingUrl,
      normalizePublic: normalizePublic,
      pcm16Frame: pcm16Frame,
      controlFrame: controlFrame,
    };
  }
})();
