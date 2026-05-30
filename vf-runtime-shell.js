/**
 * vf-runtime-shell.js — packet/runtime orchestration for the overlay shell.
 * Preferred runtime path: explicit packets from overlay runtime APIs.
 * Legacy fallback: file-mirror polling for scene/display/widget state.
 */
(function(global) {
  "use strict";

  var _vfRuntimeShellScript = typeof document !== "undefined" ? document.currentScript : null;

  function deriveRuntimeAssetVersion() {
    try {
      if (_vfRuntimeShellScript && _vfRuntimeShellScript.src && typeof URL !== "undefined") {
        var url = new URL(_vfRuntimeShellScript.src, document.baseURI);
        var v = url.searchParams.get("v");
        if (v) { return String(v); }
        if (url.search) { return String(url.search).replace(/^\?/, ""); }
      }
    } catch (_) {}
    return String(Date.now());
  }

  var _vfRuntimeAssetVersion = deriveRuntimeAssetVersion();
  if (global.VfRuntimeShell) {
    var existingVersion = String(global.VfRuntimeShell.runtimeAssetVersion || "");
    if (existingVersion !== _vfRuntimeAssetVersion) {
      throw new Error(
        "[vf-runtime-shell] stale runtime shell already loaded: existing version " +
        existingVersion + " requested version " + _vfRuntimeAssetVersion
      );
    }
    try {
      if (typeof global.VfRuntimeShell.autoBootIfSceneDocument === "function") {
        global.VfRuntimeShell.autoBootIfSceneDocument();
      }
    } catch (_) {}
    return;
  }
  global.__vfRuntimeAssetVersion = _vfRuntimeAssetVersion;

  var DEFAULT_RUNTIME_CONFIG = {
    shellAttr: "data-vf-runtime-shell",
    shellMode: "scene",
    documentTitle: "Vektor Flow — VKF scene",
    documentLang: "en",
    viewportContent: "width=device-width, initial-scale=1",
    layerId: "layer",
    screenCanvasId: "vf-screen-canvas",
    sceneHostStyleId: "vf-runtime-scene-host-style",
    overlayPacketUrl: "/api/runtime-packets",
    filePacketUrl: "vf-runtime-packets.json",
    sceneUrl: "vkf-scene.json",
    sceneStyleDeps: [
      { href: "vf-frame.css" },
      { href: "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css", crossorigin: "anonymous" }
    ],
    sceneScriptDeps: [
      "vf-runtime-source.js",
      "vf-runtime-scene.js",
      "vf-runtime-flow.js",
      "vf-render-clock.js",
      "katex/katex.min.js",
      "vf-frame.js",
      "vf-widgets.js",
      "vf-axis3d-kernel.js",
      "vf-axis3d-kernel-adapter.js",
      "vf-axis3d-projection-kernel.js",
      "vf-axis3d-projection-kernel-adapter.js",
      "geom/vf-geom-math.js",
      "geom/vf-geom-core.js",
      "geom/vf-geom-material-arena.js",
      "geom/vf-geom-ledger.js",
      "geom/vf-geom-ledger-layout.js",
      "geom/vf-geom-ledger-transport.js",
      "geom/vf-geom-parametric-surface.js",
      "geom/vf-geom-frame-adapter.js",
      "geom/vf-geom-wgpu.js",
      "vf-display.js"
    ],
    scenePollMs: 1500,
    packetPollMs: 33,
    packetPollIdleMs: 180,
    packetPollSteadyMs: 400,
    packetPollIdleThreshold: 12,
    packetPollSteadyThreshold: 60,
    packetPollQuiesceThreshold: 60,
    packetFallbackDelayMs: 1200,
    runtimeAssetVersion: _vfRuntimeAssetVersion
  };

  function runtimeLog(level, text) {
    var s = "[vf-runtime-shell] " + String(text);
    try {
      if (global.console) {
        if (level === "error" && global.console.error) { global.console.error(s); return; }
        if (level === "warn" && global.console.warn) { global.console.warn(s); return; }
        if (global.console.log) { global.console.log(s); }
      }
    } catch (_) {}
  }

  function createRuntimeDependencies() {
    return {
      frame: global.VfFrame || null,
      widgets: global.VfWidgets || null,
      display: global.VfDisplay || null
    };
  }

  function createRuntimeShell() {
    var state = {
      booted: false,
      layer: null,
      screenCanvas: null,
      lastSceneText: "",
      sceneLoadInFlight: false,
      runtimePacketsInFlight: false,
      runtimePacketsSeen: false,
      lastRuntimePacketSeq: 0,
      packetFallbackStarted: false,
      packetModeActive: false,
      legacyFallbackActive: false,
      packetRuntimeState: "bootstrap-only",
      scenePollTimer: 0,
      packetPollTimer: 0,
      packetPollDelayMs: Number(DEFAULT_RUNTIME_CONFIG.packetPollMs) || 16,
      packetIdlePolls: 0,
      bootstrapPromise: null,
      sceneAdapter: null,
      runtimeSource: null,
      runtimeFlow: null,
      sharedBufferEntries: Object.create(null),
      sharedBufferBridgeInstalled: false
    };

    function resetSceneBootState() {
      state.lastSceneText = "";
      state.sceneLoadInFlight = false;
      state.runtimePacketsInFlight = false;
      state.runtimePacketsSeen = false;
      state.lastRuntimePacketSeq = 0;
      state.packetFallbackStarted = false;
      state.packetModeActive = false;
      state.legacyFallbackActive = false;
      state.packetRuntimeState = "bootstrap-only";
      if (state.scenePollTimer && typeof global.clearInterval === "function") {
        global.clearInterval(state.scenePollTimer);
      }
      if (state.packetPollTimer && typeof global.clearTimeout === "function") {
        global.clearTimeout(state.packetPollTimer);
      }
      state.scenePollTimer = 0;
      state.packetPollTimer = 0;
      state.packetPollDelayMs = Number(DEFAULT_RUNTIME_CONFIG.packetPollMs) || 16;
      state.packetIdlePolls = 0;
    }

    function sharedBufferKey(channel, name) {
      return String(channel || "") + "::" + String(name || "");
    }

    function ensureSharedBufferEntry(channel, name) {
      var key = sharedBufferKey(channel, name);
      var entry = state.sharedBufferEntries[key];
      if (entry) { return entry; }
      entry = {
        channel: String(channel || ""),
        name: String(name || ""),
        headerBuffer: null,
        stateBuffer: null,
        headerMeta: null,
        stateMeta: null,
        error: null,
        waiters: []
      };
      state.sharedBufferEntries[key] = entry;
      return entry;
    }

    function tryReleaseSharedBuffer(buffer) {
      try {
        if (buffer && global.chrome && global.chrome.webview && typeof global.chrome.webview.releaseBuffer === "function") {
          global.chrome.webview.releaseBuffer(buffer);
        }
      } catch (_) {}
    }

    function resolveSharedBufferWaiters(entry) {
      runtimeLog("info", "resolveSharedBufferWaiters invoked: channel=" + String(entry && entry.channel || "") + " name=" + String(entry && entry.name || "") + " waiters=" + String(entry && entry.waiters ? entry.waiters.length : 0) + " header=" + (!!(entry && entry.headerBuffer)) + " state=" + (!!(entry && entry.stateBuffer)) + " error=" + String(entry && entry.error || ""));
      if (!entry || !entry.waiters || !entry.waiters.length) { return; }
      if (!entry.error && !(entry.headerBuffer && entry.stateBuffer)) { return; }
      if (entry.headerBuffer && entry.stateBuffer) {
        runtimeLog("info", "resolveSharedBufferWaiters: channel=" + String(entry.channel || "") + " name=" + String(entry.name || "") + " waiters=" + String(entry.waiters.length));
      }
      while (entry.waiters.length) {
        var waiter = entry.waiters.shift();
        if (!waiter) { continue; }
        if (entry.error) {
          waiter.reject(new Error(String(entry.error)));
          continue;
        }
        if (entry.headerBuffer && entry.stateBuffer) {
          waiter.resolve({
            headerBuffer: entry.headerBuffer,
            stateBuffer: entry.stateBuffer,
            headerMeta: entry.headerMeta,
            stateMeta: entry.stateMeta
          });
        }
      }
    }

    function installSharedBufferBridge() {
      if (state.sharedBufferBridgeInstalled) { return; }
      state.sharedBufferBridgeInstalled = true;
      if (!global.chrome || !global.chrome.webview || typeof global.chrome.webview.addEventListener !== "function") {
        runtimeLog("warn", "shared buffer bridge unavailable: chrome.webview.addEventListener missing");
        return;
      }
      global.chrome.webview.addEventListener("sharedbufferreceived", function(ev) {
        var meta = ev && ev.additionalData ? ev.additionalData : null;
        if (!meta || String(meta.type || "") !== "vf_geom_ledger_shared_buffer") {
          return;
        }
        runtimeLog("info", "sharedbufferreceived: channel=" + String(meta.channel || "") + " name=" + String(meta.name || "") + " slot=" + String(meta.slot || ""));
        if (typeof ev.getBuffer !== "function") {
          runtimeLog("error", "sharedbufferreceived missing getBuffer()");
          return;
        }
        var slot = String(meta.slot || "");
        var entry = ensureSharedBufferEntry(meta.channel, meta.name);
        function acceptBuffer(buffer) {
          runtimeLog("info", "sharedbufferreceived buffer ready: slot=" + slot + " bytes=" + String(buffer && buffer.byteLength || 0));
          if (slot === "header") {
            tryReleaseSharedBuffer(entry.headerBuffer);
            entry.headerBuffer = buffer;
            entry.headerMeta = meta;
          } else if (slot === "state") {
            tryReleaseSharedBuffer(entry.stateBuffer);
            entry.stateBuffer = buffer;
            entry.stateMeta = meta;
          } else {
            runtimeLog("warn", "sharedbufferreceived ignored unknown slot " + slot);
            tryReleaseSharedBuffer(buffer);
            return;
          }
          entry.error = null;
          resolveSharedBufferWaiters(entry);
        }
        function rejectBuffer(error) {
          entry.error = "shared buffer receive failed: " + String(error && error.message ? error.message : error);
          runtimeLog("error", entry.error);
          resolveSharedBufferWaiters(entry);
        }
        try {
          var bufferOrPromise = ev.getBuffer();
          runtimeLog("info", "sharedbufferreceived getBuffer result: slot=" + slot + " type=" + Object.prototype.toString.call(bufferOrPromise) + " thenable=" + (!!(bufferOrPromise && typeof bufferOrPromise.then === "function")));
          if (bufferOrPromise && typeof bufferOrPromise.then === "function") {
            bufferOrPromise.then(acceptBuffer).catch(rejectBuffer);
          } else {
            acceptBuffer(bufferOrPromise);
          }
        } catch (error) {
          rejectBuffer(error);
        }
      });
      global.chrome.webview.addEventListener("message", function(ev) {
        var data = ev && Object.prototype.hasOwnProperty.call(ev, "data") ? ev.data : null;
        if (typeof data === "string") {
          try { data = JSON.parse(data); } catch (_) {}
        }
        if (!data || String(data.type || "") !== "vf_geom_ledger_error") {
          return;
        }
        var entry = ensureSharedBufferEntry(data.channel, data.name);
        entry.error = String(data.message || "geometry ledger bridge failed");
        resolveSharedBufferWaiters(entry);
      });
      global.addEventListener("beforeunload", function() {
        var keys = Object.keys(state.sharedBufferEntries);
        for (var i = 0; i < keys.length; i += 1) {
          var entry = state.sharedBufferEntries[keys[i]];
          if (!entry) { continue; }
          tryReleaseSharedBuffer(entry.headerBuffer);
          tryReleaseSharedBuffer(entry.stateBuffer);
        }
      }, { once: true });
    }

    function requestSharedBuffers(channel, name) {
      installSharedBufferBridge();
      if (!global.chrome || !global.chrome.webview || typeof global.chrome.webview.postMessage !== "function") {
        throw new Error("chrome.webview.postMessage unavailable for shared buffer request");
      }
      runtimeLog("info", "requestSharedBuffers: channel=" + String(channel || "") + " name=" + String(name || ""));
      global.chrome.webview.postMessage({
        type: "vf_request_shared_buffers",
        channel: String(channel || ""),
        name: String(name || "")
      });
    }

    function waitForSharedBuffers(channel, name) {
      installSharedBufferBridge();
      var entry = ensureSharedBufferEntry(channel, name);
      if (entry.error) {
        runtimeLog("error", "waitForSharedBuffers immediate error: channel=" + String(channel || "") + " name=" + String(name || "") + " message=" + String(entry.error));
        return Promise.reject(new Error(String(entry.error)));
      }
      if (entry.headerBuffer && entry.stateBuffer) {
        runtimeLog("info", "waitForSharedBuffers immediate resolve: channel=" + String(channel || "") + " name=" + String(name || ""));
        return Promise.resolve({
          headerBuffer: entry.headerBuffer,
          stateBuffer: entry.stateBuffer,
          headerMeta: entry.headerMeta,
          stateMeta: entry.stateMeta
        });
      }
      runtimeLog("info", "waitForSharedBuffers pending: channel=" + String(channel || "") + " name=" + String(name || ""));
      return new Promise(function(resolve, reject) {
        entry.waiters.push({ resolve: resolve, reject: reject });
        runtimeLog("info", "waitForSharedBuffers waiter added: channel=" + String(channel || "") + " name=" + String(name || "") + " waiters=" + String(entry.waiters.length));
      });
    }

    function resolveAssetUrl(path) {
      if (typeof URL !== "undefined" && _vfRuntimeShellScript && _vfRuntimeShellScript.src) {
        try {
          var resolved = new URL(path, _vfRuntimeShellScript.src);
          var shellUrl = new URL(_vfRuntimeShellScript.src, document.baseURI);
          if (!resolved.search && resolved.origin === shellUrl.origin) {
            resolved.search = shellUrl.search || ("?v=" + encodeURIComponent(_vfRuntimeAssetVersion));
          }
          return resolved.toString();
        } catch (_) {}
      }
      return path;
    }

    function findScriptByUrl(url) {
      if (typeof document === "undefined") { return null; }
      var scripts = document.getElementsByTagName("script");
      for (var i = 0; i < scripts.length; i++) {
        var src = scripts[i].getAttribute("src") || "";
        if (!src) { continue; }
        try {
          if (new URL(src, document.baseURI).toString() === url) {
            return scripts[i];
          }
        } catch (_) {}
      }
      return null;
    }

    function findStylesheetByUrl(url) {
      if (typeof document === "undefined") { return null; }
      var links = document.getElementsByTagName("link");
      for (var i = 0; i < links.length; i++) {
        if (String(links[i].rel || "").toLowerCase() !== "stylesheet") { continue; }
        var href = links[i].getAttribute("href") || "";
        if (!href) { continue; }
        try {
          if (new URL(href, document.baseURI).toString() === url) {
            return links[i];
          }
        } catch (_) {}
      }
      return null;
    }

    function ensureStylesheetLoaded(spec) {
      if (typeof document === "undefined") { return Promise.resolve(null); }
      spec = typeof spec === "string" ? { href: spec } : (spec || {});
      if (!spec.href) { return Promise.resolve(null); }
      var url = resolveAssetUrl(spec.href);
      var existing = findStylesheetByUrl(url);
      if (existing) {
        existing.setAttribute("data-vf-runtime-ready", "true");
        existing.setAttribute("data-vf-runtime-version", _vfRuntimeAssetVersion);
        return Promise.resolve(existing);
      }
      return new Promise(function(resolve, reject) {
        var link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = url;
        if (spec.crossorigin) {
          link.crossOrigin = spec.crossorigin;
        }
        if (spec.media) {
          link.media = spec.media;
        }
        link.setAttribute("data-vf-runtime-asset", spec.href);
        link.setAttribute("data-vf-runtime-version", _vfRuntimeAssetVersion);
        link.addEventListener("load", function() {
          link.setAttribute("data-vf-runtime-ready", "true");
          resolve(link);
        }, { once: true });
        link.addEventListener("error", reject, { once: true });
        (document.head || document.documentElement).appendChild(link);
      });
    }

    function ensureScriptLoaded(path) {
      if (typeof document === "undefined") { return Promise.resolve(null); }
      var url = resolveAssetUrl(path);
      var existing = findScriptByUrl(url);
      if (existing) {
        var readyState = String(existing.readyState || "");
        if (existing.getAttribute("data-vf-runtime-ready") === "true" || readyState === "complete" || readyState === "loaded") {
          existing.setAttribute("data-vf-runtime-ready", "true");
          existing.setAttribute("data-vf-runtime-version", _vfRuntimeAssetVersion);
          return Promise.resolve(existing);
        }
        return new Promise(function(resolve, reject) {
          existing.addEventListener("load", function() {
            existing.setAttribute("data-vf-runtime-ready", "true");
            existing.setAttribute("data-vf-runtime-version", _vfRuntimeAssetVersion);
            resolve(existing);
          }, { once: true });
          existing.addEventListener("error", reject, { once: true });
        });
      }
      return new Promise(function(resolve, reject) {
        var script = document.createElement("script");
        script.src = url;
        script.async = false;
        script.setAttribute("data-vf-runtime-asset", path);
        script.setAttribute("data-vf-runtime-version", _vfRuntimeAssetVersion);
        script.addEventListener("load", function() {
          script.setAttribute("data-vf-runtime-ready", "true");
          resolve(script);
        }, { once: true });
        script.addEventListener("error", reject, { once: true });
        (document.body || document.head || document.documentElement).appendChild(script);
      });
    }

    function ensureSceneDependencies() {
      if (state.bootstrapPromise) { return state.bootstrapPromise; }
      var styles = DEFAULT_RUNTIME_CONFIG.sceneStyleDeps.slice();
      var deps = DEFAULT_RUNTIME_CONFIG.sceneScriptDeps.slice();
      state.bootstrapPromise = Promise.resolve().then(function() {
        styles.forEach(function(spec) {
          ensureStylesheetLoaded(spec).catch(function(err) {
            runtimeLog("warn", "stylesheet skipped: " + String(spec && spec.href || "") + " " + (err && err.message ? err.message : String(err)));
          });
        });
        return deps.reduce(function(chain, path) {
          return chain.then(function() {
            return ensureScriptLoaded(path);
          });
        }, Promise.resolve());
      }).catch(function(err) {
        runtimeLog("error", "ensureSceneDependencies: " + (err && err.message ? err.message : String(err)));
        throw err;
      });
      return state.bootstrapPromise;
    }

    function isSceneDocument() {
      var body = document && document.body;
      if (!body) { return false; }
      if (body.getAttribute(DEFAULT_RUNTIME_CONFIG.shellAttr) === DEFAULT_RUNTIME_CONFIG.shellMode) {
        return true;
      }
      var pathname = "";
      try {
        pathname = String((global.location && global.location.pathname) || "");
      } catch (_) {}
      return /(?:^|\/)vkf-scene\.html$/i.test(pathname);
    }

    function ensureSceneDocumentMeta() {
      if (typeof document === "undefined") { return null; }
      var docEl = document.documentElement;
      if (docEl && !docEl.getAttribute("lang")) {
        docEl.setAttribute("lang", DEFAULT_RUNTIME_CONFIG.documentLang);
      }
      if (document.title !== DEFAULT_RUNTIME_CONFIG.documentTitle) {
        document.title = DEFAULT_RUNTIME_CONFIG.documentTitle;
      }
      var head = document.head || document.getElementsByTagName("head")[0];
      if (!head) { return null; }
      var viewport = head.querySelector('meta[name="viewport"]');
      if (!viewport) {
        viewport = document.createElement("meta");
        viewport.setAttribute("name", "viewport");
        head.appendChild(viewport);
      }
      viewport.setAttribute("content", DEFAULT_RUNTIME_CONFIG.viewportContent);
      return viewport;
    }

    function ensureSceneHostStyles() {
      if (typeof document === "undefined") { return null; }
      ensureSceneDocumentMeta();
      var styleId = DEFAULT_RUNTIME_CONFIG.sceneHostStyleId;
      var styleEl = document.getElementById(styleId);
      if (styleEl) { return styleEl; }
      styleEl = document.createElement("style");
      styleEl.id = styleId;
      styleEl.textContent = [
        "html, body, #layer {",
        "  margin: 0;",
        "  overflow: hidden;",
        "  background-color: transparent !important;",
        "  background: transparent !important;",
        "  pointer-events: none;",
        "}",
        "html, body {",
        "  height: 100%;",
        "  min-height: 100%;",
        "}",
        "#layer {",
        "  position: absolute;",
        "  inset: 0;",
        "  overflow: hidden;",
        "  min-height: 100%;",
        "  z-index: 1;",
        "  pointer-events: none;",
        "}",
        ".vf-screen-canvas {",
        "  position: fixed;",
        "  inset: 0;",
        "  width: 100%;",
        "  height: 100%;",
        "  display: block;",
        "  z-index: 0;",
        "  pointer-events: none;",
        "  background: transparent;",
        "}"
      ].join("\n");
      (document.head || document.documentElement).appendChild(styleEl);
      return styleEl;
    }

    function ensureShellDom(layerId, screenCanvasId) {
      var body = document && document.body;
      if (!body) { return { layer: null, screenCanvas: null }; }
      ensureSceneHostStyles();

      var screenCanvas = document.getElementById(screenCanvasId);
      if (!screenCanvas) {
        screenCanvas = document.createElement("canvas");
        screenCanvas.id = screenCanvasId;
        screenCanvas.className = "vf-screen-canvas";
        screenCanvas.setAttribute("aria-hidden", "true");
        body.insertBefore(screenCanvas, body.firstChild || null);
      }

      var layer = document.getElementById(layerId);
      if (!layer) {
        layer = document.createElement("div");
        layer.id = layerId;
        body.appendChild(layer);
      }

      return {
        layer: layer,
        screenCanvas: screenCanvas
      };
    }

    function getSceneAdapter() {
      if (state.sceneAdapter) { return state.sceneAdapter; }
      if (!global.VfRuntimeScene || !global.VfRuntimeScene.createAdapter) { return null; }
      state.sceneAdapter = global.VfRuntimeScene.createAdapter({
        createRuntimeDependencies: createRuntimeDependencies,
        runtimeLog: runtimeLog,
        getLayer: function() { return state.layer; },
        displayRefresh: displayRefresh,
        isLegacyFallbackActive: function() { return state.legacyFallbackActive; }
      });
      return state.sceneAdapter;
    }

    function getRuntimeSource() {
      if (state.runtimeSource) { return state.runtimeSource; }
      if (!global.VfRuntimeSource || !global.VfRuntimeSource.createSource) { return null; }
      state.runtimeSource = global.VfRuntimeSource.createSource({
        config: DEFAULT_RUNTIME_CONFIG,
        runtimeLog: runtimeLog
      });
      return state.runtimeSource;
    }

    function getRuntimeFlow() {
      if (state.runtimeFlow) { return state.runtimeFlow; }
      if (!global.VfRuntimeFlow || !global.VfRuntimeFlow.createFlow) { return null; }
      state.runtimeFlow = global.VfRuntimeFlow.createFlow({
        config: DEFAULT_RUNTIME_CONFIG,
        createRuntimeDependencies: createRuntimeDependencies,
        runtimeLog: runtimeLog,
        getRuntimeSource: getRuntimeSource,
        applySceneCommands: applySceneCommands,
        state: state
      });
      return state.runtimeFlow;
    }

    function syncNativeLayout() {
      var adapter = getSceneAdapter();
      if (!adapter || !adapter.syncNativeLayout) { return; }
      adapter.syncNativeLayout();
    }

    function displayRefresh() {
      var flow = getRuntimeFlow();
      if (!flow || !flow.displayRefresh) {
        runtimeLog("warn", "displayRefresh: runtime flow unavailable");
        return;
      }
      flow.displayRefresh();
    }

    function stopLegacyFallback() {
      var flow = getRuntimeFlow();
      if (!flow || !flow.stopLegacyFallback) { return; }
      flow.stopLegacyFallback();
    }

    function startLegacyFallback() {
      var flow = getRuntimeFlow();
      if (!flow || !flow.startLegacyFallback) { return; }
      flow.startLegacyFallback();
    }

    function applySceneCommands(data) {
      var adapter = getSceneAdapter();
      if (!adapter || !adapter.applySceneCommands) {
        runtimeLog("warn", "applySceneCommands: scene adapter unavailable");
        return;
      }
      adapter.applySceneCommands(data);
    }

    function routeRuntimePacket(packet) {
      var flow = getRuntimeFlow();
      if (!flow || !flow.routeRuntimePacket) { return; }
      flow.routeRuntimePacket(packet);
    }

    function applyRuntimePayload(payload) {
      var flow = getRuntimeFlow();
      if (!flow || !flow.applyRuntimePayload) { return false; }
      return flow.applyRuntimePayload(payload);
    }

    function loadRuntimePackets() {
      var flow = getRuntimeFlow();
      if (!flow || !flow.loadRuntimePackets) { return; }
      return flow.loadRuntimePackets();
    }

    function getPacketRuntimeState() {
      var flow = getRuntimeFlow();
      if (!flow || !flow.getPacketRuntimeState) {
        return String(state.packetRuntimeState || "bootstrap-only");
      }
      return flow.getPacketRuntimeState();
    }

    function getNextPacketPollDelay(result) {
      if (result && Object.prototype.hasOwnProperty.call(result, "nextPollDelayMs")) {
        return result.nextPollDelayMs;
      }
      var flow = getRuntimeFlow();
      if (!flow || !flow.getNextPacketPollDelay) {
        return Number(DEFAULT_RUNTIME_CONFIG.packetPollMs) || 33;
      }
      return flow.getNextPacketPollDelay();
    }

    function schedulePacketPoll(delayMs) {
      if (state.packetPollTimer && typeof global.clearTimeout === "function") {
        global.clearTimeout(state.packetPollTimer);
      }
      state.packetPollTimer = 0;
      if (delayMs == null || delayMs === false) {
        state.packetPollDelayMs = 0;
        runtimeLog("info", "schedulePacketPoll: quiesced state=" + getPacketRuntimeState());
        return;
      }
      if (typeof global.setTimeout !== "function") { return; }
      var nextDelay = Math.max(33, Number(delayMs) || 33);
      state.packetPollDelayMs = nextDelay;
      state.packetPollTimer = global.setTimeout(function() {
        state.packetPollTimer = 0;
        var result = loadRuntimePackets();
        if (result && typeof result.then === "function") {
          result.then(function(outcome) {
            schedulePacketPoll(getNextPacketPollDelay(outcome));
          }).catch(function() {
            schedulePacketPoll(getNextPacketPollDelay());
          });
          return;
        }
        schedulePacketPoll(getNextPacketPollDelay(result));
      }, nextDelay);
    }

    function ensurePacketPolling(delayMs) {
      if (state.packetPollTimer) { return; }
      schedulePacketPoll(delayMs == null ? getNextPacketPollDelay() : delayMs);
    }

    function loadScene() {
      var flow = getRuntimeFlow();
      if (!flow || !flow.loadScene) { return; }
      return flow.loadScene();
    }

    function resolveSceneBootOptions() {
      var body = document && document.body;
      if (!body || !isSceneDocument()) { return null; }
      var layerId = body.getAttribute("data-vf-runtime-layer") || DEFAULT_RUNTIME_CONFIG.layerId;
      var screenCanvasId = body.getAttribute("data-vf-runtime-screen-canvas") || DEFAULT_RUNTIME_CONFIG.screenCanvasId;
      ensureShellDom(layerId, screenCanvasId);
      return {
        layerId: layerId,
        screenCanvasId: screenCanvasId
      };
    }

    function installLayoutObservers() {
      if (!state.layer) { return; }
      if (state.layer.__vfRuntimeShellObserversInstalled) { return; }
      state.layer.__vfRuntimeShellObserversInstalled = true;

      state.layer.addEventListener("vf-frame-restore", function() {
        global.requestAnimationFrame(function() {
          global.requestAnimationFrame(syncNativeLayout);
        });
      }, true);

      if (state.screenCanvas && typeof ResizeObserver !== "undefined") {
        var canvasObserver = new ResizeObserver(function() {
          displayRefresh();
        });
        canvasObserver.observe(state.screenCanvas);
      }

      global.addEventListener("resize", function() {
        var deps = createRuntimeDependencies();
        if (state.layer && deps.frame && deps.frame.layoutMinimizedDock) {
          deps.frame.layoutMinimizedDock(state.layer);
        }
        if (state.layer && deps.frame && deps.frame.postNativeHostLayout) {
          global.requestAnimationFrame(function() {
            deps.frame.postNativeHostLayout(state.layer, { stageAlpha: 0 });
          });
        }
        displayRefresh();
      });

      if (typeof ResizeObserver !== "undefined") {
        var t = 0;
        var layoutObserver = new ResizeObserver(function() {
          var deps = createRuntimeDependencies();
          if (!deps.frame || !deps.frame.postNativeHostLayout) { return; }
          var n = performance.now();
          if (n - t < 32) { return; }
          t = n;
          global.requestAnimationFrame(function() {
            deps.frame.postNativeHostLayout(state.layer, { stageAlpha: 0 });
          });
        });
        layoutObserver.observe(state.layer);
      }

      (function nativeLayoutOnMove() {
        var t = 0;
        document.addEventListener("pointermove", function() {
          var deps = createRuntimeDependencies();
          var n = performance.now();
          if (n - t < 48) { return; }
          t = n;
          if (state.layer && deps.frame && deps.frame.postNativeHostLayout) {
            deps.frame.postNativeHostLayout(state.layer, { stageAlpha: 0 });
          }
        }, true);
      })();
    }

    function boot(options) {
      resetSceneBootState();
      state.booted = true;
      installSharedBufferBridge();
      options = options || {};
      state.layer = document.getElementById(options.layerId || "layer");
      state.screenCanvas = document.getElementById(options.screenCanvasId || "vf-screen-canvas");
      runtimeLog("info", "boot: layer=" + (!!state.layer) + " screenCanvas=" + (!!state.screenCanvas));
      installLayoutObservers();
      global.setTimeout(function() {
        runtimeLog("info", "deps: VfGeomCore=" + (typeof global.VfGeomCore !== "undefined") +
          " VfGeomMath=" + (typeof global.VfGeomMath !== "undefined") +
          " VfGeomWgpu=" + (typeof global.VfGeomWgpu !== "undefined") +
          " VfDisplay=" + (typeof global.VfDisplay !== "undefined") +
          " VfFrame=" + (typeof global.VfFrame !== "undefined") +
          " VfWidgets=" + (typeof global.VfWidgets !== "undefined"));
        runtimeLog("info", "navigator.gpu=" + (global.navigator && global.navigator.gpu ? "present" : "MISSING") +
          " webview=" + (typeof global.chrome !== "undefined" && global.chrome.webview ? "present" : "missing"));
      }, 300);
      var initialPacketLoad = loadRuntimePackets();
      if (initialPacketLoad && typeof initialPacketLoad.then === "function") {
        initialPacketLoad.then(function(result) {
          ensurePacketPolling(getNextPacketPollDelay(result));
        }).catch(function() {
          ensurePacketPolling();
        });
      } else {
        ensurePacketPolling();
      }
      global.setTimeout(function() {
        if (state.runtimePacketsSeen || state.packetFallbackStarted) { return; }
        state.packetFallbackStarted = true;
        startLegacyFallback();
      }, DEFAULT_RUNTIME_CONFIG.packetFallbackDelayMs);
      return shell;
    }

    function autoBootIfSceneDocument() {
      var options = resolveSceneBootOptions();
      if (!options) { return false; }
      ensureSceneDependencies().then(function() {
        boot(options);
      }).catch(function() {});
      return true;
    }

    var shell = {
      boot: boot,
      autoBootIfSceneDocument: autoBootIfSceneDocument,
      ensureSceneDependencies: ensureSceneDependencies,
      ensureStylesheetLoaded: ensureStylesheetLoaded,
      ensureScriptLoaded: ensureScriptLoaded,
      isSceneDocument: isSceneDocument,
      ensureSceneDocumentMeta: ensureSceneDocumentMeta,
      ensureSceneHostStyles: ensureSceneHostStyles,
      ensureShellDom: ensureShellDom,
      getSceneAdapter: getSceneAdapter,
      getRuntimeSource: getRuntimeSource,
      getRuntimeFlow: getRuntimeFlow,
      resolveSceneBootOptions: resolveSceneBootOptions,
      displayRefresh: displayRefresh,
      applyRuntimePacket: routeRuntimePacket,
      applyRuntimePayload: applyRuntimePayload,
      loadRuntimePackets: loadRuntimePackets,
      getPacketRuntimeState: getPacketRuntimeState,
      loadScene: loadScene,
      startLegacyFallback: startLegacyFallback,
      stopLegacyFallback: stopLegacyFallback,
      applySceneCommands: applySceneCommands,
      requestSharedBuffers: requestSharedBuffers,
      waitForSharedBuffers: waitForSharedBuffers,
      resolveAssetUrl: resolveAssetUrl,
      runtimeAssetVersion: _vfRuntimeAssetVersion,
      config: DEFAULT_RUNTIME_CONFIG
    };
    return shell;
  }

  global.VfRuntimeShell = createRuntimeShell();
  runtimeLog("info", "VfRuntimeShell registered assetVersion=" + _vfRuntimeAssetVersion);
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function() {
        if (global.VfRuntimeShell && global.VfRuntimeShell.autoBootIfSceneDocument) {
          global.VfRuntimeShell.autoBootIfSceneDocument();
        }
      }, { once: true });
    } else if (global.VfRuntimeShell.autoBootIfSceneDocument) {
      global.VfRuntimeShell.autoBootIfSceneDocument();
    }
  }
})(typeof window !== "undefined" ? window : this);
