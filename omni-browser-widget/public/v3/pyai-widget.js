// PyAI Omni voice widget v2, a single-file, dependency-free embeddable.
//
// Native Omni frames are strictly type-prefixed:
//   client audio 0x01 · client control 0x03
//   server audio 0x01 · transcript 0x02 · control 0x03
(function () {
  "use strict";

  var RUNTIME_KEY = "__PYAI_WIDGET_V2_RUNTIME__";
  var RATE = 24000;
  var MAX_BACKLOG_SECONDS = 1;
  var FADE_SECONDS = 0.015;
  var DEFAULT_ACCENT = "#5b5bd6";

  function warn(message) {
    if (window.console && console.warn) console.warn("PyAI widget: " + message);
  }

  function text(value, fallback, maxLength) {
    var clean = typeof value === "string" ? value.trim() : "";
    return (clean || fallback).slice(0, maxLength);
  }

  function oneOf(value, allowed, fallback) {
    value = String(value || "").toLowerCase();
    return allowed.indexOf(value) >= 0 ? value : fallback;
  }

  function bool(value) {
    return /^(1|true|yes)$/i.test(String(value || ""));
  }

  function safeHttpUrl(value, base) {
    if (!value || String(value).length > 2048) return null;
    try {
      var parsed = new URL(String(value), base || document.baseURI);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
    } catch (error) {
      return null;
    }
  }

  function safeWebSocketUrl(value) {
    if (!value || String(value).length > 2048) return null;
    try {
      var parsed = new URL(String(value));
      if (parsed.protocol === "wss:") return parsed.href;
      if (parsed.protocol === "ws:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname)) return parsed.href;
      return null;
    } catch (error) {
      return null;
    }
  }

  function safeTel(value) {
    var raw = String(value || "").trim();
    if (raw.toLowerCase().indexOf("tel:") === 0) raw = raw.slice(4);
    if (!/^\+?[0-9().\-\s]{3,32}$/.test(raw)) return null;
    var digits = raw.replace(/\D/g, "");
    if (digits.length < 3 || digits.length > 15) return null;
    return "tel:" + (raw.charAt(0) === "+" ? "+" : "") + digits;
  }

  function safeReferral(value) {
    var code = String(value || "").trim();
    if (!code) return null;
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(code)) return null;
    if (/^(org|customer|cus|agent|agt|project|proj|wdgt)[_-]/i.test(code)) return null;
    return code;
  }

  function brandingUrl(variant, referralCode) {
    var base = referralCode
      ? "https://pyai.com/r/" + encodeURIComponent(referralCode)
      : "https://pyai.com/";
    return base +
      "?utm_source=" + encodeURIComponent("customer_widget") +
      "&utm_medium=" + encodeURIComponent("referral") +
      "&utm_campaign=" + encodeURIComponent("powered_by_widget") +
      "&utm_content=" + encodeURIComponent(variant);
  }

  function safeAccent(value) {
    var raw = String(value || "").trim();
    if (!raw || raw.length > 64 || /[;{}]|url\s*\(|var\s*\(/i.test(raw)) return null;
    if (window.CSS && typeof CSS.supports === "function" && !CSS.supports("color", raw)) return null;
    var probe = document.createElement("span");
    probe.style.color = "";
    probe.style.color = raw;
    if (!probe.style.color) return null;
    var parent = document.body || document.documentElement;
    if (!parent || typeof window.getComputedStyle !== "function") return raw;
    probe.style.display = "none";
    parent.appendChild(probe);
    var computed = window.getComputedStyle(probe).color;
    probe.remove();
    var rgba = computed.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
    if (!rgba || (rgba[4] !== undefined && Number(rgba[4]) < 1)) return null;
    return {
      value: computed,
      foreground: contrastForeground(Number(rgba[1]), Number(rgba[2]), Number(rgba[3])),
    };
  }

  function contrastForeground(red, green, blue) {
    function channel(value) {
      value /= 255;
      return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    }
    var luminance = 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
    var whiteContrast = 1.05 / (luminance + 0.05);
    var blackContrast = (luminance + 0.05) / 0.05;
    return whiteContrast >= blackContrast ? "#ffffff" : "#111111";
  }

  function nextInstanceId(runtime) {
    runtime.counter += 1;
    var random = "";
    try {
      random = window.crypto && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : "";
    } catch (error) {}
    return "pyai-widget-" + runtime.counter + (random ? "-" + random : "");
  }

  function parseConfig(script, runtime) {
    function attr(name) {
      return script && script.getAttribute ? script.getAttribute(name) : null;
    }
    var instanceId = nextInstanceId(runtime);
    var widgetId = text(attr("data-widget"), instanceId, 128);
    if (!/^[A-Za-z0-9._:-]+$/.test(widgetId)) {
      warn("ignored invalid data-widget identifier");
      widgetId = instanceId;
    }
    var variant = oneOf(attr("data-variant"), ["orb", "pill", "card", "inline"], "pill");
    var position = oneOf(attr("data-position"), ["bottom-right", "bottom-left"], "bottom-right");
    var theme = oneOf(attr("data-theme"), ["auto", "light", "dark"], "auto");
    var density = oneOf(attr("data-density") || attr("data-size"), ["compact", "comfortable"], "comfortable");
    var rawAction = String(attr("data-action") || "voice").toLowerCase();
    var action = oneOf(rawAction, ["voice", "url", "tel", "event"], "voice");
    var tokenUrl = safeHttpUrl(attr("data-token-url"), document.baseURI);
    var actionUrl = safeHttpUrl(attr("data-url"), document.baseURI);
    var tel = safeTel(attr("data-tel"));
    var accent = safeAccent(attr("data-accent")) || safeAccent(DEFAULT_ACCENT);
    var branding = oneOf(attr("data-branding"), ["show", "hide"], "show");
    var referralCode = safeReferral(attr("data-referral"));
    var disabledReason = "";

    if (rawAction !== action) warn(widgetId + " ignored an invalid action and fell back to voice");
    if (attr("data-accent") && !safeAccent(attr("data-accent"))) warn(widgetId + " ignored an invalid accent color");
    if (attr("data-referral") && !referralCode) warn(widgetId + " ignored an invalid referral code");
    if (action === "voice" && !tokenUrl) disabledReason = "data-token-url is required for voice actions";
    if (action === "url" && !actionUrl) disabledReason = "data-url must be an http or https URL";
    if (action === "tel" && !tel) disabledReason = "data-tel must contain a valid telephone number";

    return {
      instanceId: instanceId,
      widgetId: widgetId,
      variant: variant,
      position: position,
      theme: theme,
      density: density,
      accent: typeof accent === "string" ? accent : accent.value,
      accentForeground: typeof accent === "string" ? "#ffffff" : accent.foreground,
      label: text(attr("data-label"), "Talk to us", 80),
      title: text(attr("data-title"), "Talk with our team", 100),
      subtitle: text(attr("data-subtitle"), "Ask a question by voice.", 180),
      action: action,
      actionUrl: actionUrl,
      actionTarget: oneOf(attr("data-action-target"), ["same", "new"], "new"),
      tel: tel,
      eventValue: text(attr("data-event-value"), "", 256),
      tokenUrl: tokenUrl,
      targetSelector: text(attr("data-target"), "", 256),
      headless: bool(attr("data-headless")),
      branding: branding,
      referralCode: referralCode,
      brandingUrl: brandingUrl(variant, referralCode),
      disabledReason: disabledReason,
    };
  }

  function installStyle(script) {
    if (document.getElementById("pyai-widget-v2-style")) return;
    var style = document.createElement("style");
    style.id = "pyai-widget-v2-style";
    var nonce = script && (script.nonce || script.getAttribute("nonce"));
    if (nonce) style.setAttribute("nonce", nonce);
    style.textContent = [
      "[data-pyai-widget-instance]{--pyai-accent:#5b5bd6;--pyai-accent-fg:#fff;--pyai-bg:#fff;--pyai-fg:#17171c;--pyai-muted:#61616b;--pyai-border:#ddddE5;--pyai-shadow:0 18px 56px rgba(20,20,35,.22);--pyai-gap:12px;--pyai-pad:16px;box-sizing:border-box;color-scheme:light;font:400 14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:var(--pyai-fg)}",
      "[data-pyai-widget-instance] *{box-sizing:border-box}",
      "[data-pyai-widget-instance][data-density=compact]{--pyai-gap:8px;--pyai-pad:12px;font-size:13px}",
      "[data-pyai-widget-instance][data-theme=dark]{--pyai-bg:#17171c;--pyai-fg:#f7f7f9;--pyai-muted:#b6b6c2;--pyai-border:#3c3c47;color-scheme:dark}",
      "@media(prefers-color-scheme:dark){[data-pyai-widget-instance][data-theme=auto]{--pyai-bg:#17171c;--pyai-fg:#f7f7f9;--pyai-muted:#b6b6c2;--pyai-border:#3c3c47;color-scheme:dark}}",
      ".pyai-root-fixed{position:fixed;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:2147483000;max-width:calc(100vw - 32px)}",
      ".pyai-root-fixed[data-position=bottom-right]{right:calc(16px + env(safe-area-inset-right,0px))}",
      ".pyai-root-fixed[data-position=bottom-left]{left:calc(16px + env(safe-area-inset-left,0px))}",
      ".pyai-root-inline{position:relative;display:inline-flex;max-width:100%;flex-direction:column;align-items:flex-start;gap:var(--pyai-gap)}",
      ".pyai-launcher{appearance:none;border:0;margin:0;cursor:pointer;font:600 14px/1.2 inherit;display:flex;align-items:center;justify-content:center;gap:10px;background:var(--pyai-accent);color:var(--pyai-accent-fg);box-shadow:0 8px 24px rgba(0,0,0,.18);transition:transform .15s ease,box-shadow .15s ease}",
      ".pyai-launcher:hover{transform:translateY(-1px);box-shadow:0 11px 28px rgba(0,0,0,.22)}",
      ".pyai-launcher:focus-visible,.pyai-control:focus-visible,.pyai-close:focus-visible{outline:3px solid var(--pyai-accent);outline-offset:3px}",
      ".pyai-launcher:disabled{cursor:not-allowed;filter:grayscale(.75);opacity:.58;transform:none}",
      ".pyai-launcher-orb{width:52px;height:52px;padding:0;border-radius:50%}",
      "[data-density=compact] .pyai-launcher-orb{width:44px;height:44px}",
      ".pyai-launcher-pill,.pyai-launcher-inline{min-height:48px;padding:0 18px;border-radius:999px;max-width:min(320px,calc(100vw - 32px))}",
      "[data-density=compact] .pyai-launcher-pill,[data-density=compact] .pyai-launcher-inline{min-height:40px;padding:0 14px}",
      ".pyai-launcher-card{width:min(300px,calc(100vw - 32px));padding:var(--pyai-pad);border:1px solid var(--pyai-border);border-radius:16px;background:var(--pyai-bg);color:var(--pyai-fg);text-align:left;justify-content:flex-start;box-shadow:var(--pyai-shadow)}",
      ".pyai-card-shell{display:flex;max-width:100%;flex-direction:column;align-items:stretch}.pyai-card-shell .pyai-launcher-card{width:100%}",
      ".pyai-card-icon{display:grid;place-items:center;width:38px;height:38px;flex:0 0 auto;border-radius:50%;background:var(--pyai-accent);color:var(--pyai-accent-fg)}",
      ".pyai-card-copy{min-width:0;flex:1}.pyai-card-title,.pyai-card-subtitle{display:block;overflow-wrap:anywhere}.pyai-card-title{font-weight:700}.pyai-card-subtitle{color:var(--pyai-muted);font-size:12px;margin-top:2px}.pyai-card-action{font-weight:700;color:var(--pyai-accent);white-space:nowrap}",
      ".pyai-branding{display:inline-flex;align-items:center;gap:3px;color:var(--pyai-muted);font:500 10px/1.2 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;text-decoration:none;letter-spacing:.01em}.pyai-branding:hover{color:var(--pyai-fg);text-decoration:underline}.pyai-branding:focus-visible{outline:2px solid var(--pyai-accent);outline-offset:2px;border-radius:3px}.pyai-branding strong{color:currentColor;font-weight:750}.pyai-card-branding{align-self:flex-end;margin:6px 4px 0}.pyai-panel-branding{align-self:center;margin-top:-2px}[data-panel-open=true] .pyai-card-branding{display:none}",
      ".pyai-icon{display:block;width:20px;height:20px;fill:currentColor}.pyai-status-dot{width:8px;height:8px;border-radius:50%;background:currentColor;opacity:.75}",
      "[data-state=connecting] .pyai-status-dot{animation:pyai-pulse 1s infinite}[data-state=live] .pyai-status-dot{background:#22c55e;animation:pyai-pulse 1.2s infinite}[data-state=error] .pyai-status-dot{background:#ef4444}",
      ".pyai-panel{position:absolute;bottom:calc(100% + 12px);width:min(360px,calc(100vw - 32px));max-height:min(560px,calc(100vh - 112px));display:flex;flex-direction:column;gap:var(--pyai-gap);overflow:hidden;padding:var(--pyai-pad);border:1px solid var(--pyai-border);border-radius:18px;background:var(--pyai-bg);color:var(--pyai-fg);box-shadow:var(--pyai-shadow)}",
      "[data-position=bottom-right] .pyai-panel{right:0}[data-position=bottom-left] .pyai-panel{left:0}.pyai-root-inline .pyai-panel{position:relative;inset:auto;width:min(360px,100%);max-height:520px}",
      ".pyai-panel[hidden]{display:none}.pyai-panel-header{display:flex;align-items:flex-start;gap:12px}.pyai-panel-heading{min-width:0;flex:1}.pyai-panel-title{font-size:16px;font-weight:750;overflow-wrap:anywhere}.pyai-status{color:var(--pyai-muted);font-size:13px;margin-top:2px}",
      ".pyai-close{appearance:none;border:0;background:transparent;color:var(--pyai-muted);width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:22px;line-height:1}",
      ".pyai-transcript{min-height:116px;max-height:260px;overflow:auto;padding:12px;border-radius:12px;background:color-mix(in srgb,var(--pyai-bg),var(--pyai-fg) 6%);border:1px solid var(--pyai-border)}",
      ".pyai-transcript-empty{color:var(--pyai-muted)}.pyai-turn{margin:0 0 8px;overflow-wrap:anywhere}.pyai-turn:last-child{margin-bottom:0}.pyai-turn strong{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--pyai-muted)}",
      ".pyai-controls{display:grid;grid-template-columns:1fr 1fr;gap:10px}.pyai-control{appearance:none;min-height:42px;padding:0 12px;border:1px solid var(--pyai-border);border-radius:10px;background:var(--pyai-bg);color:var(--pyai-fg);font:650 13px/1 inherit;cursor:pointer}.pyai-end{border-color:#dc2626;background:#dc2626;color:#fff}.pyai-control[aria-pressed=true]{border-color:var(--pyai-accent);color:var(--pyai-accent)}",
      ".pyai-sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}",
      "@keyframes pyai-pulse{0%,100%{opacity:1}50%{opacity:.35}}",
      "@media(max-width:640px){.pyai-root-fixed .pyai-panel{position:fixed;left:0;right:0;bottom:0;width:100%;max-height:min(78vh,620px);border-radius:20px 20px 0 0;padding-bottom:calc(var(--pyai-pad) + env(safe-area-inset-bottom,0px))}.pyai-root-inline .pyai-panel{width:100%}}",
      "@media(prefers-reduced-motion:reduce){.pyai-launcher,.pyai-launcher:hover{transition:none;transform:none}[data-state] .pyai-status-dot{animation:none!important}}",
    ].join("");
    (document.head || document.documentElement).appendChild(style);
  }

  function element(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function createBrandingAnchor(config, className) {
    var anchor = element("a", "pyai-branding " + className);
    anchor.href = config.brandingUrl;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.setAttribute("aria-label", "Powered by PyAI (opens in a new tab)");
    anchor.appendChild(document.createTextNode("Powered by "));
    anchor.appendChild(element("strong", "", "PyAI"));
    return anchor;
  }

  function micIcon() {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "pyai-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M12 15a3.5 3.5 0 0 0 3.5-3.5v-5a3.5 3.5 0 1 0-7 0v5A3.5 3.5 0 0 0 12 15Zm7-3.5a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V21H8.5a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H13v-2.58A7 7 0 0 0 19 11.5Z");
    svg.appendChild(path);
    return svg;
  }

  function emit(name, detail) {
    var event;
    try {
      event = new CustomEvent("pyai:widget:" + name, { detail: detail });
    } catch (error) {
      event = document.createEvent("CustomEvent");
      event.initCustomEvent("pyai:widget:" + name, false, false, detail);
    }
    window.dispatchEvent(event);
  }

  function emitBrandingClick(config) {
    var detail = { widgetId: config.widgetId, variant: config.variant };
    if (config.referralCode) detail.referralCode = config.referralCode;
    emit("branding-click", detail);
  }

  function createRuntime() {
    var runtime = { counter: 0, instances: [], active: null };

    runtime.find = function (id) {
      if (!runtime.instances.length) return null;
      if (!id) return runtime.active || runtime.instances[runtime.instances.length - 1];
      for (var index = runtime.instances.length - 1; index >= 0; index--) {
        var item = runtime.instances[index];
        if (item.config.widgetId === id || item.config.instanceId === id) return item;
      }
      return null;
    };

    runtime.mount = function (script) {
      installStyle(script);
      var config = parseConfig(script, runtime);
      var mountTarget = null;
      if (config.variant === "inline" && config.targetSelector) {
        try { mountTarget = document.querySelector(config.targetSelector); } catch (error) {
          warn(config.widgetId + " ignored an invalid data-target selector");
        }
      }
      if (!mountTarget && config.variant === "inline") mountTarget = script.parentElement;
      if (!mountTarget || /^(HEAD|SCRIPT)$/i.test(mountTarget.tagName || "")) mountTarget = document.body;
      if (!mountTarget) {
        document.addEventListener("DOMContentLoaded", function once() { runtime.mount(script); }, { once: true });
        return null;
      }
      var instance = createInstance(config, mountTarget, runtime);
      runtime.instances.push(instance);
      if (config.disabledReason) warn(config.widgetId + " disabled: " + config.disabledReason);
      emit("ready", instance.detail({ config: publicConfig(config) }));
      return instance;
    };

    runtime.remove = function (instance) {
      var index = runtime.instances.indexOf(instance);
      if (index >= 0) runtime.instances.splice(index, 1);
      if (runtime.active === instance) runtime.active = null;
    };

    var api = {
      open: function (widgetId) {
        var instance = runtime.find(widgetId);
        if (!instance) return false;
        instance.activate("api");
        return true;
      },
      close: function (widgetId) {
        var instance = runtime.find(widgetId);
        if (!instance) return false;
        instance.close("api");
        return true;
      },
      toggle: function (widgetId) {
        var instance = runtime.find(widgetId);
        if (!instance) return false;
        instance.toggle("api");
        return true;
      },
      destroy: function (widgetId) {
        var instance = runtime.find(widgetId);
        if (!instance) return false;
        instance.destroy();
        return true;
      },
      getConfig: function (widgetId) {
        var instance = runtime.find(widgetId);
        return instance ? publicConfig(instance.config) : null;
      },
    };
    window.PyAIWidget = api;

    document.addEventListener("click", function (event) {
      var trigger = event.target && event.target.closest ? event.target.closest("[data-pyai-widget-open]") : null;
      if (!trigger) return;
      var id = trigger.getAttribute("data-pyai-widget-open") || undefined;
      if (api.open(id)) event.preventDefault();
    });

    if (window.__PYAI_WIDGET_TEST__) {
      window.__PYAI_WIDGET_TEST__.helpers = {
        parseConfig: function (script) { return parseConfig(script, runtime); },
        safeHttpUrl: safeHttpUrl,
        safeTel: safeTel,
        safeReferral: safeReferral,
        brandingUrl: brandingUrl,
        emitBrandingClick: emitBrandingClick,
        publicConfig: publicConfig,
        nextInstanceId: function () { return nextInstanceId(runtime); },
        executeAction: function (config) {
          emit("action", { widgetId: config.widgetId, instanceId: config.instanceId, action: "event", value: config.eventValue || "" });
        },
      };
    }
    return runtime;
  }

  function publicConfig(config) {
    return {
      variant: config.variant,
      position: config.position,
      theme: config.theme,
      density: config.density,
      action: config.action,
      label: config.label,
      title: config.title,
      subtitle: config.subtitle,
      headless: config.headless,
      branding: config.branding,
      referralCode: config.referralCode,
      disabled: Boolean(config.disabledReason),
    };
  }

  function createInstance(config, mountTarget, runtime) {
    var host = element("div", config.variant === "inline" ? "pyai-root-inline" : "pyai-root-fixed");
    host.setAttribute("data-pyai-widget-instance", config.instanceId);
    host.setAttribute("data-widget-id", config.widgetId);
    host.setAttribute("data-position", config.position);
    host.setAttribute("data-theme", config.theme);
    host.setAttribute("data-density", config.density);
    host.setAttribute("data-state", "idle");
    host.style.setProperty("--pyai-accent", config.accent);
    host.style.setProperty("--pyai-accent-fg", config.accentForeground);

    var launcher = createLauncher(config);
    var panel = createPanel(config);
    if (config.action === "voice") launcher.setAttribute("aria-controls", panel.root.id);
    if (!config.headless && config.variant === "card" && config.branding === "show") {
      var cardShell = element("div", "pyai-card-shell");
      cardShell.appendChild(launcher);
      cardShell.appendChild(createBrandingAnchor(config, "pyai-card-branding"));
      host.appendChild(cardShell);
    } else if (!config.headless) {
      host.appendChild(launcher);
    }
    host.appendChild(panel.root);
    mountTarget.appendChild(host);

    var ws, audioCtx, micStream, micSource, processor, captureMute, outputGain, fetchController;
    var running = false;
    var muted = false;
    var open = false;
    var destroyed = false;
    var generation = 0;
    var nextPlayTime = 0;
    var playing = new Set();
    var returnFocus = null;

    var instance = {
      config: config,
      detail: function (extra) {
        var detail = { widgetId: config.widgetId, instanceId: config.instanceId };
        Object.keys(extra || {}).forEach(function (key) { detail[key] = extra[key]; });
        return detail;
      },
      activate: activate,
      close: close,
      toggle: toggle,
      destroy: destroy,
    };

    launcher.addEventListener("click", function () { activate("launcher"); });
    host.addEventListener("click", function (event) {
      var anchor = event.target && event.target.closest ? event.target.closest(".pyai-branding") : null;
      if (!anchor || !host.contains(anchor)) return;
      emitBrandingClick(config);
    });
    panel.close.addEventListener("click", function () { close("close-button"); });
    panel.end.addEventListener("click", function () { close("end-button"); });
    panel.mute.addEventListener("click", function () {
      muted = !muted;
      panel.mute.setAttribute("aria-pressed", String(muted));
      panel.mute.textContent = muted ? "Unmute" : "Mute";
      setStatus(muted ? "Microphone muted" : running ? "Listening" : "Ready");
    });
    panel.root.addEventListener("keydown", onPanelKeydown);

    function activate(source) {
      if (destroyed) return;
      var actionDetail = instance.detail({ action: config.action, source: source });
      if (config.eventValue) actionDetail.value = config.eventValue;
      emit("action", actionDetail);
      if (config.disabledReason) {
        warn(config.widgetId + " action blocked: " + config.disabledReason);
        setState("error", config.disabledReason);
        emit("error", instance.detail({ code: "invalid_config", message: config.disabledReason }));
        return;
      }
      if (config.action === "url") {
        if (config.actionTarget === "same") window.location.assign(config.actionUrl);
        else window.open(config.actionUrl, "_blank", "noopener,noreferrer");
        return;
      }
      if (config.action === "tel") {
        window.location.assign(config.tel);
        return;
      }
      if (config.action === "event") return;
      openVoice(source);
    }

    function openVoice(source) {
      if (open) return;
      open = true;
      runtime.active = instance;
      host.setAttribute("data-panel-open", "true");
      returnFocus = document.activeElement;
      panel.root.hidden = false;
      launcher.setAttribute("aria-expanded", "true");
      setState("connecting", "Starting…");
      emit("open", instance.detail({ source: source }));
      window.requestAnimationFrame(function () { panel.close.focus(); });
      start();
    }

    function close(reason) {
      if (!open && !running) return;
      open = false;
      if (runtime.active === instance) runtime.active = null;
      host.removeAttribute("data-panel-open");
      panel.root.hidden = true;
      launcher.setAttribute("aria-expanded", "false");
      stopTransport();
      setState("idle", config.label);
      emit("close", instance.detail({ reason: reason || "api" }));
      if (returnFocus && document.contains(returnFocus) && returnFocus.focus) returnFocus.focus();
      else if (!config.headless) launcher.focus();
      returnFocus = null;
    }

    function toggle(source) {
      if (config.action !== "voice") return activate(source);
      if (open) close(source);
      else activate(source);
    }

    function destroy() {
      if (destroyed) return;
      close("destroy");
      destroyed = true;
      host.remove();
      runtime.remove(instance);
    }

    function setState(state, message) {
      host.setAttribute("data-state", state);
      setStatus(message);
      launcher.setAttribute("aria-label", config.label + (message && message !== config.label ? ", " + message : ""));
    }

    function setStatus(message) {
      panel.status.textContent = message;
    }

    async function start() {
      if (running || destroyed) return;
      var attempt = ++generation;
      running = true;
      muted = false;
      panel.mute.textContent = "Mute";
      panel.mute.setAttribute("aria-pressed", "false");
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (attempt !== generation || !open) return teardownAudio();
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RATE });
        await audioCtx.resume();
        if (attempt !== generation || !open) return teardownAudio();
        nextPlayTime = audioCtx.currentTime;
        outputGain = audioCtx.createGain();
        outputGain.gain.value = 1;
        outputGain.connect(audioCtx.destination);

        fetchController = typeof AbortController === "function" ? new AbortController() : null;
        var response = await fetch(config.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          credentials: "same-origin",
          signal: fetchController ? fetchController.signal : undefined,
        });
        if (!response.ok) throw new Error("token_" + response.status);
        var session = await response.json();
        if (attempt !== generation || !open) return teardownAudio();
        if (!session || !safeWebSocketUrl(session.url) || !session.token) {
          throw new Error("invalid_session");
        }
        var configure = session.configure || { type: "configure" };
        configure.type = "configure";

        ws = new WebSocket(session.url, ["pyai-key." + session.token]);
        ws.binaryType = "arraybuffer";
        ws.onopen = function () {
          if (attempt !== generation || !open) return;
          try { ws.send(frame03(configure)); } catch (error) {}
          startCapture();
          setState("live", "Listening");
          emit("connected", instance.detail({}));
        };
        ws.onmessage = onMessage;
        ws.onerror = function () {
          if (attempt !== generation) return;
          setState("error", "Connection error");
          emit("error", instance.detail({ code: "connection_error", message: "Connection error" }));
        };
        ws.onclose = function (event) {
          if (attempt !== generation) return;
          ws = null;
          running = false;
          teardownAudio();
          if (open) {
            open = false;
            if (runtime.active === instance) runtime.active = null;
            host.removeAttribute("data-panel-open");
            panel.root.hidden = true;
            launcher.setAttribute("aria-expanded", "false");
            setState("idle", config.label);
            emit("close", instance.detail({ reason: "remote", code: event && event.code }));
          }
        };
      } catch (error) {
        if (attempt !== generation) return;
        running = false;
        teardownAudio();
        var denied = error && error.name === "NotAllowedError";
        var message = denied ? "Allow microphone access" : "Unavailable. Try again later";
        setState("error", message);
        emit("error", instance.detail({ code: denied ? "microphone_denied" : "unavailable", message: message }));
      }
    }

    function startCapture() {
      micSource = audioCtx.createMediaStreamSource(micStream);
      // ScriptProcessor is deprecated but keeps this example dependency-free.
      processor = audioCtx.createScriptProcessor(2048, 1, 1);
      captureMute = audioCtx.createGain();
      captureMute.gain.value = 0;
      processor.onaudioprocess = function (event) {
        if (muted || !ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(frame01(event.inputBuffer.getChannelData(0), audioCtx.sampleRate));
      };
      micSource.connect(processor);
      // A connected output keeps ScriptProcessor firing. Mute it to avoid a
      // microphone-to-speaker echo path.
      processor.connect(captureMute);
      captureMute.connect(audioCtx.destination);
    }

    function onMessage(event) {
      if (typeof event.data === "string") {
        try { handleEvent(JSON.parse(event.data)); } catch (error) {}
        return;
      }
      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then(onBinaryFrame).catch(function () {});
        return;
      }
      onBinaryFrame(event.data);
    }

    function onBinaryFrame(arrayBuffer) {
      var bytes = new Uint8Array(arrayBuffer);
      if (!bytes.length) return;
      var tag = bytes[0];
      if (tag === 0x01) {
        playAgentAudio(bytes.subarray(1));
      } else if (tag === 0x02) {
        try { handleTranscript(JSON.parse(new TextDecoder().decode(bytes.subarray(1)))); } catch (error) {}
      } else if (tag === 0x03) {
        try { handleEvent(JSON.parse(new TextDecoder().decode(bytes.subarray(1)))); } catch (error) {}
      } else {
        warn("ignored unknown Omni frame tag " + tag);
      }
    }

    function handleTranscript(transcript) {
      var transcriptText = text(transcript && (transcript.text || transcript.transcript), "", 4000);
      if (!transcriptText) return;
      var role = oneOf(transcript.role || transcript.speaker, ["user", "assistant", "agent"], "assistant");
      appendTranscript(role === "agent" ? "assistant" : role, transcriptText, transcript.final !== false);
      emit("transcript", instance.detail({ transcript: transcript }));
    }

    function appendTranscript(role, transcriptText, final) {
      panel.empty.hidden = true;
      var last = panel.log.lastElementChild;
      if (!final && last && last.getAttribute("data-partial") === role) {
        last.querySelector("span").textContent = transcriptText;
        return;
      }
      if (last) last.removeAttribute("data-partial");
      var turn = element("p", "pyai-turn");
      if (!final) turn.setAttribute("data-partial", role);
      turn.appendChild(element("strong", "", role === "user" ? "You" : "Agent"));
      turn.appendChild(element("span", "", transcriptText));
      panel.log.appendChild(turn);
      while (panel.log.children.length > 51) panel.log.removeChild(panel.log.children[1]);
      panel.log.scrollTop = panel.log.scrollHeight;
    }

    function handleEvent(event) {
      var kind = event && (event.event || event.type);
      if (kind === "barge_in" || kind === "flush") stopPlayback(true);
      else if (kind === "turn") setStatus(event.role === "assistant" ? "Agent speaking" : muted ? "Microphone muted" : "Listening");
      else if (kind === "session_end") close("session_end");
      else if (kind === "error") {
        setState("error", "Call error");
        emit("error", instance.detail({ code: event.code || "session_error", message: event.message || "Call error" }));
      }
    }

    function playAgentAudio(bytes) {
      if (!audioCtx || !outputGain) return;
      var sampleCount = Math.floor(bytes.byteLength / 2);
      if (!sampleCount) return;
      if (Math.max(0, nextPlayTime - audioCtx.currentTime) > MAX_BACKLOG_SECONDS) stopPlayback(true);
      var buffer = audioCtx.createBuffer(1, sampleCount, RATE);
      var channel = buffer.getChannelData(0);
      var view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
      for (var index = 0; index < sampleCount; index++) channel[index] = view.getInt16(index * 2, true) / 0x8000;
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
        try { source.stop(fadeEnd); } catch (error) {}
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
      try { if (processor) processor.onaudioprocess = null; } catch (error) {}
      try { processor && processor.disconnect(); } catch (error) {}
      try { micSource && micSource.disconnect(); } catch (error) {}
      try { captureMute && captureMute.disconnect(); } catch (error) {}
      try { outputGain && outputGain.disconnect(); } catch (error) {}
      try { micStream && micStream.getTracks().forEach(function (track) { track.stop(); }); } catch (error) {}
      try { audioCtx && audioCtx.close(); } catch (error) {}
      processor = micSource = captureMute = outputGain = micStream = audioCtx = null;
    }

    function stopTransport() {
      generation += 1;
      running = false;
      try { fetchController && fetchController.abort(); } catch (error) {}
      fetchController = null;
      teardownAudio();
      try {
        if (ws) {
          ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
          if (ws.readyState <= WebSocket.OPEN) ws.close(1000, "client_closed");
        }
      } catch (error) {}
      ws = null;
    }

    function onPanelKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        close("escape");
        return;
      }
      if (event.key !== "Tab") return;
      var focusable = panel.root.querySelectorAll("button:not([disabled]),[href],input:not([disabled]),[tabindex]:not([tabindex='-1'])");
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    return instance;
  }

  function createLauncher(config) {
    var launcher = element("button", "pyai-launcher pyai-launcher-" + config.variant);
    launcher.type = "button";
    launcher.setAttribute("aria-label", config.label);
    launcher.setAttribute("aria-haspopup", config.action === "voice" ? "dialog" : "false");
    launcher.setAttribute("aria-expanded", "false");
    if (config.disabledReason) {
      launcher.disabled = true;
      launcher.title = config.disabledReason;
    }
    if (config.variant === "card") {
      var icon = element("span", "pyai-card-icon");
      icon.appendChild(micIcon());
      var copy = element("span", "pyai-card-copy");
      copy.appendChild(element("span", "pyai-card-title", config.title));
      copy.appendChild(element("span", "pyai-card-subtitle", config.subtitle));
      launcher.appendChild(icon);
      launcher.appendChild(copy);
      launcher.appendChild(element("span", "pyai-card-action", config.label));
    } else {
      launcher.appendChild(micIcon());
      if (config.variant !== "orb") launcher.appendChild(element("span", "", config.label));
      launcher.appendChild(element("span", "pyai-status-dot"));
    }
    return launcher;
  }

  function createPanel(config) {
    var root = element("section", "pyai-panel");
    root.hidden = true;
    root.id = config.instanceId + "-dialog";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", config.instanceId + "-title");
    var header = element("div", "pyai-panel-header");
    var heading = element("div", "pyai-panel-heading");
    var title = element("div", "pyai-panel-title", config.title);
    title.id = config.instanceId + "-title";
    var status = element("div", "pyai-status", "Ready");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    heading.appendChild(title);
    heading.appendChild(status);
    var close = element("button", "pyai-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close voice widget");
    header.appendChild(heading);
    header.appendChild(close);

    var log = element("div", "pyai-transcript");
    log.setAttribute("role", "log");
    log.setAttribute("aria-live", "polite");
    log.setAttribute("aria-label", "Call transcript");
    var empty = element("p", "pyai-transcript-empty", "Your live transcript will appear here.");
    log.appendChild(empty);

    var controls = element("div", "pyai-controls");
    var mute = element("button", "pyai-control", "Mute");
    mute.type = "button";
    mute.setAttribute("aria-pressed", "false");
    var end = element("button", "pyai-control pyai-end", "End call");
    end.type = "button";
    controls.appendChild(mute);
    controls.appendChild(end);
    root.appendChild(header);
    root.appendChild(log);
    root.appendChild(controls);
    if (config.branding === "show") root.appendChild(createBrandingAnchor(config, "pyai-panel-branding"));
    return { root: root, status: status, close: close, log: log, empty: empty, mute: mute, end: end };
  }

  function resample(input, fromRate, toRate) {
    if (!input.length || fromRate === toRate) return input;
    var length = Math.max(1, Math.round(input.length * toRate / fromRate));
    var output = new Float32Array(length);
    var scale = fromRate / toRate;
    for (var index = 0; index < length; index++) {
      var position = index * scale;
      var left = Math.min(input.length - 1, Math.floor(position));
      var right = Math.min(input.length - 1, left + 1);
      var mix = position - left;
      output[index] = input[left] * (1 - mix) + input[right] * mix;
    }
    return output;
  }

  function frame01(input, inputRate) {
    var samples = resample(input, inputRate, RATE);
    var out = new Uint8Array(1 + samples.length * 2);
    out[0] = 0x01;
    var view = new DataView(out.buffer);
    for (var index = 0; index < samples.length; index++) {
      var sample = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(1 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return out;
  }

  function frame03(object) {
    var json = new TextEncoder().encode(JSON.stringify(object));
    var out = new Uint8Array(json.length + 1);
    out[0] = 0x03;
    out.set(json, 1);
    return out;
  }

  var runtime = window[RUNTIME_KEY] || (window[RUNTIME_KEY] = createRuntime());
  var script = document.currentScript;
  if (script) runtime.mount(script);
  else warn("could not find the current script element");
})();
