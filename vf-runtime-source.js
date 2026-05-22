/**
 * vf-runtime-source.js — packet/file sourcing for the runtime shell.
 */
(function(global) {
  "use strict";

  if (global.VfRuntimeSource) { return; }

  function createSource(options) {
    options = options || {};
    var config = options.config || {};
    var runtimeLog = options.runtimeLog || function() {};

    function parsePacketPayload(payload) {
      return payload && Array.isArray(payload.packets) ? payload.packets : null;
    }

    function loadFromOverlayApi() {
      if (typeof fetch === "undefined") { return Promise.resolve(null); }
      return fetch(String(config.overlayPacketUrl || "/api/runtime-packets") + "?t=" + Date.now(), { cache: "no-store" })
        .then(function(r) {
          if (!r.ok) {
            runtimeLog("warn", "loadFromOverlayApi: status=" + r.status);
            return null;
          }
          return r.json();
        })
        .then(function(payload) {
          var packets = parsePacketPayload(payload);
          return packets;
        })
        .catch(function(err) {
          runtimeLog("warn", "loadFromOverlayApi: " + (err && err.message ? err.message : String(err)));
          return null;
        });
    }

    function loadFromFileMirror() {
      if (typeof fetch === "undefined") { return Promise.resolve(null); }
      return fetch(String(config.filePacketUrl || "vf-runtime-packets.json") + "?t=" + Date.now(), { cache: "no-store" })
        .then(function(r) {
          if (!r.ok) {
            runtimeLog("warn", "loadFromFileMirror: status=" + r.status);
            return null;
          }
          return r.text();
        })
        .then(function(raw) {
          if (raw == null) { return null; }
          var packets = JSON.parse(raw);
          return Array.isArray(packets) ? packets : null;
        })
        .catch(function(err) {
          runtimeLog("warn", "loadFromFileMirror: " + (err && err.message ? err.message : String(err)));
          return null;
        });
    }

    function loadPackets() {
      return loadFromOverlayApi().then(function(packets) {
        if (Array.isArray(packets)) { return packets; }
        return loadFromFileMirror();
      });
    }

    function loadSceneCommands() {
      if (typeof fetch === "undefined") { return Promise.resolve(null); }
      var sceneUrl = String(config.sceneUrl || "vkf-scene.json");
      return fetch(sceneUrl + "?t=" + Date.now(), { cache: "no-store" })
        .then(function(r) {
          if (!r.ok) {
            runtimeLog("warn", "loadScene: " + sceneUrl + " fetch " + r.status + " — no scene yet, will retry");
            return null;
          }
          return r.text();
        })
        .then(function(raw) {
          if (raw == null) { return null; }
          var data = JSON.parse(raw);
          if (!Array.isArray(data)) {
            runtimeLog("warn", "loadScene: " + sceneUrl + " is not an array (got " + typeof data + ")");
            return null;
          }
          return {
            raw: raw,
            commands: data
          };
        });
    }

    return {
      loadPackets: loadPackets,
      loadSceneCommands: loadSceneCommands
    };
  }

  global.VfRuntimeSource = {
    createSource: createSource
  };
})(typeof window !== "undefined" ? window : this);
