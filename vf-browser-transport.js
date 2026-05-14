/**
 * vf-browser-transport.js — browser transport adapters for the display seam.
 *
 * Keeps fetch/poll/host-delivery outside vf-display.js so the renderer can
 * run against injected data in other hosts (WASM, native embeddings, tests).
 */
(function (global) {
  "use strict";

  function tlog(level, text) {
    var s = "[vf-browser-transport] " + String(text);
    try {
      if (global.console) {
        if (level === "error" && global.console.error) { global.console.error(s); return; }
        if (level === "warn" && global.console.warn) { global.console.warn(s); return; }
        if (global.console.log) { global.console.log(s); }
      }
    } catch (_) {}
    try {
      if (global.chrome && global.chrome.webview && global.chrome.webview.postMessage) {
        global.chrome.webview.postMessage({ type: "vf_log", level: level, message: s, t: Date.now() });
      }
    } catch (_) {}
  }

  function defaultJsonUrl(filename) {
    if (typeof location === "undefined" || !location.href) { return filename; }
    var path = location.pathname || "/";
    var i = path.lastIndexOf("/");
    var base = i >= 0 ? path.substring(0, i + 1) : "/";
    return base + filename;
  }

  function createJsonSource(options) {
    var opts = options || {};
    var url = opts.url;
    var parse = typeof opts.parse === "function" ? opts.parse : JSON.parse;
    var logPrefix = opts.logPrefix || "json source";
    var missingHint = opts.missingHint || "file may not exist yet";
    var lastFetchFailed = false;
    var lastText = "";
    var fetchInFlight = false;

    return {
      read: function (onData, onStale) {
        var apply = typeof onData === "function" ? onData : function () {};
        var stale = typeof onStale === "function" ? onStale : function () {};
        if (typeof fetch === "undefined") {
          tlog("warn", logPrefix + ": fetch not available");
          return;
        }
        if (fetchInFlight) { return; }
        fetchInFlight = true;
        fetch(url, { cache: "no-store" })
          .then(function (r) {
            if (!r.ok) {
              if (!lastFetchFailed) {
                tlog("warn", logPrefix + ": fetch " + r.status + " (" + missingHint + ")");
                lastFetchFailed = true;
              }
              return null;
            }
            lastFetchFailed = false;
            return r.text();
          })
          .then(function (t) {
            var parsed;
            if (t == null) { return; }
            if (t === lastText) {
              stale();
              return;
            }
            lastText = t;
            try {
              parsed = parse(t);
            } catch (e) {
              tlog("error", logPrefix + ": JSON.parse failed: " + e.message + " (first 200 chars: " + t.slice(0, 200) + ")");
              return;
            }
            apply(parsed);
          })
          .catch(function (err) {
            tlog("warn", logPrefix + ": fetch error: " + (err && err.message ? err.message : String(err)));
          })
          .finally(function () {
            fetchInFlight = false;
          });
      }
    };
  }

  function createAgentPortEventSink(options) {
    var opts = options || {};
    var port = 0;

    function resolvePort() {
      if (port) { return port; }
      if (typeof opts.getPort === "function") {
        port = parseInt(opts.getPort(), 10) || 0;
        return port;
      }
      if (typeof global !== "undefined" && global.__agentPort) {
        port = parseInt(global.__agentPort, 10) || 0;
      }
      return port;
    }

    return {
      postEvent: function (evt) {
        var activePort = resolvePort();
        if (!activePort || typeof fetch === "undefined") { return; }
        var body = JSON.stringify({ line: JSON.stringify(evt) });
        try {
          fetch("http://127.0.0.1:" + activePort + "/api/enqueue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body
          }).catch(function () {});
        } catch (_) {}
      }
    };
  }

  function createDisplayJsonSource(options) {
    var opts = options || {};
    return createJsonSource({
      url: opts.url || defaultJsonUrl("vf-display.json"),
      parse: opts.parse,
      logPrefix: "display source",
      missingHint: "vf-display.json may not exist yet"
    });
  }

  function createDisplayRuntime(options) {
    var opts = options || {};
    var display = opts.display;
    if (!display || typeof display.renderFromJson !== "function") {
      throw new Error("createDisplayRuntime requires a VfDisplay-like renderer");
    }
    var eventSink = opts.eventSink || createAgentPortEventSink(opts);
    var source = opts.source || createDisplayJsonSource(opts);
    var lastPayload = null;
    if (typeof display.setEventSink === "function") {
      display.setEventSink(eventSink);
    }

    function applyPayload(data) {
      lastPayload = data;
      display.renderFromJson(data);
    }

    return {
      refresh: function () {
        source.read(function (data) {
          applyPayload(data);
        });
      },
      update: function (data) {
        applyPayload(data);
      },
      getLastPayload: function () {
        return lastPayload;
      }
    };
  }

  function createSceneJsonSource(options) {
    var opts = options || {};
    return createJsonSource({
      url: opts.url || defaultJsonUrl("vkf-scene.json?t=" + Date.now()),
      parse: opts.parse,
      logPrefix: "scene source",
      missingHint: "vkf-scene.json may not exist yet"
    });
  }

  function createSceneRuntime(options) {
    var opts = options || {};
    var apply = typeof opts.apply === "function" ? opts.apply : null;
    if (!apply) {
      throw new Error("createSceneRuntime requires an apply(commands) function");
    }
    var source = opts.source || createSceneJsonSource(opts);
    var lastCommands = null;

    function applyCommands(commands) {
      lastCommands = commands;
      apply(commands);
    }

    return {
      refresh: function (onStale) {
        source.read(function (commands) {
          applyCommands(commands);
        }, onStale);
      },
      update: function (commands) {
        applyCommands(commands);
      },
      getLastCommands: function () {
        return lastCommands;
      }
    };
  }

  function attachDisplayTransport(display, options) {
    var opts = options || {};
    opts.display = display;
    var runtime = createDisplayRuntime(opts);
    return {
      loadAndRender: function () {
        runtime.refresh();
      },
      refresh: function () {
        runtime.refresh();
      },
      update: function (data) {
        runtime.update(data);
      },
      getLastPayload: function () {
        return runtime.getLastPayload();
      }
    };
  }

  function createBrowserSessionRuntime(options) {
    var opts = options || {};
    var displayRuntime = createDisplayRuntime({
      display: opts.display,
      source: opts.displaySource,
      eventSink: opts.eventSink,
      url: opts.displayUrl,
      parse: opts.displayParse,
      getPort: opts.getPort
    });
    var sceneRuntime = createSceneRuntime({
      apply: opts.applyScene,
      source: opts.sceneSource,
      url: opts.sceneUrl,
      parse: opts.sceneParse
    });
    var onSceneStale = typeof opts.onSceneStale === "function" ? opts.onSceneStale : function () {};

    var hooks = {
      refreshScene: function () {
        sceneRuntime.refresh(function () {
          onSceneStale();
        });
      },
      updateScene: function (commands) {
        sceneRuntime.update(commands);
      },
      refreshDisplay: function () {
        displayRuntime.refresh();
      },
      updateDisplay: function (payload) {
        displayRuntime.update(payload);
      },
      updateSession: function (session) {
        var next = session || {};
        if (next.scene) {
          sceneRuntime.update(next.scene);
        }
        if (next.display) {
          displayRuntime.update(next.display);
        }
      }
    };

    return {
      scene: sceneRuntime,
      display: displayRuntime,
      hooks: hooks
    };
  }

  global.VfBrowserTransport = {
    attachDisplayTransport: attachDisplayTransport,
    createBrowserSessionRuntime: createBrowserSessionRuntime,
    createDisplayRuntime: createDisplayRuntime,
    createAgentPortEventSink: createAgentPortEventSink,
    createDisplayJsonSource: createDisplayJsonSource,
    createSceneJsonSource: createSceneJsonSource,
    createSceneRuntime: createSceneRuntime,
    defaultJsonUrl: defaultJsonUrl
  };
})(typeof window !== "undefined" ? window : this);
