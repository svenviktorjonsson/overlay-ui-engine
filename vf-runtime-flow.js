/**
 * vf-runtime-flow.js — packet routing and legacy fallback flow for the runtime shell.
 */
(function(global) {
  "use strict";

  if (global.VfRuntimeFlow) { return; }

  function createFlow(options) {
    options = options || {};
    var config = options.config || {};
    var createRuntimeDependencies = options.createRuntimeDependencies || function() { return {}; };
    var runtimeLog = options.runtimeLog || function() {};
    var getRuntimeSource = options.getRuntimeSource || function() { return null; };
    var applySceneCommands = options.applySceneCommands || function() {};
    var state = options.state || {};

    function displayRefresh() {
      var deps = createRuntimeDependencies();
      if (state.packetModeActive && deps.display && deps.display.redrawCurrentDisplay) {
        deps.display.redrawCurrentDisplay();
        return;
      }
      if (state.legacyFallbackActive && deps.display && deps.display.loadAndRender) {
        deps.display.loadAndRender();
        return;
      }
      if (!deps.display) {
        runtimeLog("warn", "displayRefresh: VfDisplay not available");
      }
    }

    function stopLegacyFallback() {
      var deps = createRuntimeDependencies();
      state.legacyFallbackActive = false;
      if (state.scenePollTimer && typeof global.clearInterval === "function") {
        global.clearInterval(state.scenePollTimer);
      }
      state.scenePollTimer = 0;
      if (deps.widgets && deps.widgets.stopStatePoll) {
        deps.widgets.stopStatePoll();
      }
    }

    function routeRuntimePacket(packet) {
      var deps = createRuntimeDependencies();
      if (!packet || typeof packet !== "object") { return; }
      state.packetModeActive = true;
      if (state.legacyFallbackActive) {
        stopLegacyFallback();
      }
      var kind = String(packet.kind || "");
      runtimeLog("info", "routeRuntimePacket: seq=" + String(packet.seq) + " kind=" + kind);
      var payload = packet.payload;
      if (kind === "scene.replace" && payload && Array.isArray(payload.commands)) {
        runtimeLog("info", "routeRuntimePacket: scene.replace commands=" + payload.commands.length);
        applySceneCommands(payload.commands);
        return;
      }
      if (deps.widgets && deps.widgets.applyRuntimePacket) {
        deps.widgets.applyRuntimePacket(packet);
      }
      if (deps.display && deps.display.applyRuntimePacket) {
        deps.display.applyRuntimePacket(packet);
      }
    }

    function applyRuntimePayload(payload) {
      if (!payload || typeof payload !== "object") { return false; }
      if (Array.isArray(payload.packets)) {
        for (var i = 0; i < payload.packets.length; i++) {
          routeRuntimePacket(payload.packets[i]);
        }
        return true;
      }
      if (Array.isArray(payload.commands)) {
        applySceneCommands(payload.commands);
        return true;
      }
      return false;
    }

    function loadScene() {
      var runtimeSource = getRuntimeSource();
      if (!state.legacyFallbackActive || state.sceneLoadInFlight || typeof fetch === "undefined" || !runtimeSource) { return; }
      state.sceneLoadInFlight = true;
      return runtimeSource.loadSceneCommands()
        .then(function(result) {
          if (!result) {
            displayRefresh();
            return;
          }
          if (result.raw === state.lastSceneText) {
            displayRefresh();
            return;
          }
          state.lastSceneText = result.raw;
          applySceneCommands(result.commands);
        })
        .catch(function(fetchErr) {
          if (fetchErr && fetchErr.message === "Unexpected end of JSON input") {
            runtimeLog("error", "loadScene: JSON.parse failed: " + fetchErr.message);
            displayRefresh();
            return;
          }
          if (fetchErr && /JSON/.test(String(fetchErr && fetchErr.message || ""))) {
            runtimeLog("error", "loadScene: JSON.parse failed: " + fetchErr.message);
            displayRefresh();
            return;
          }
          runtimeLog("warn", "loadScene: fetch threw: " + (fetchErr && fetchErr.message ? fetchErr.message : String(fetchErr)));
        })
        .finally(function() {
          state.sceneLoadInFlight = false;
        });
    }

    function startLegacyFallback() {
      var deps = createRuntimeDependencies();
      if (state.packetModeActive || state.legacyFallbackActive) { return; }
      state.legacyFallbackActive = true;
      if (deps.widgets && deps.widgets.startStatePoll) {
        deps.widgets.startStatePoll();
      }
      loadScene();
      if (typeof global.setInterval === "function") {
        state.scenePollTimer = global.setInterval(loadScene, Number(config.scenePollMs) || 1500);
      }
    }

    function loadRuntimePackets() {
      var runtimeSource = getRuntimeSource();
      if (state.runtimePacketsInFlight || typeof fetch === "undefined" || !runtimeSource) { return; }
      state.runtimePacketsInFlight = true;
      return runtimeSource.loadPackets()
        .then(function(packets) {
          if (!Array.isArray(packets)) {
            runtimeLog("info", "loadRuntimePackets: no packet array");
            return;
          }
          runtimeLog("info", "loadRuntimePackets: fetched=" + packets.length + " lastSeq=" + state.lastRuntimePacketSeq);
          var applied = 0;
          for (var i = 0; i < packets.length; i++) {
            var packet = packets[i];
            var seq = Number(packet && packet.seq);
            if (!Number.isFinite(seq) || seq <= state.lastRuntimePacketSeq) { continue; }
            state.packetModeActive = true;
            if (state.legacyFallbackActive) {
              stopLegacyFallback();
            }
            routeRuntimePacket(packet);
            state.lastRuntimePacketSeq = seq;
            applied += 1;
          }
          if (applied > 0) {
            state.runtimePacketsSeen = true;
            runtimeLog("info", "loadRuntimePackets: applied=" + applied + " newLastSeq=" + state.lastRuntimePacketSeq);
          } else {
            runtimeLog("info", "loadRuntimePackets: applied=0");
          }
        })
        .catch(function(err) {
          runtimeLog("warn", "loadRuntimePackets: " + (err && err.message ? err.message : String(err)));
        })
        .finally(function() {
          state.runtimePacketsInFlight = false;
        });
    }

    return {
      displayRefresh: displayRefresh,
      stopLegacyFallback: stopLegacyFallback,
      startLegacyFallback: startLegacyFallback,
      routeRuntimePacket: routeRuntimePacket,
      applyRuntimePayload: applyRuntimePayload,
      loadRuntimePackets: loadRuntimePackets,
      loadScene: loadScene
    };
  }

  global.VfRuntimeFlow = {
    createFlow: createFlow
  };
})(typeof window !== "undefined" ? window : this);
