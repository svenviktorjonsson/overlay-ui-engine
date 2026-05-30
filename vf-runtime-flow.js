/**
 * vf-runtime-flow.js — packet routing and legacy fallback flow for the runtime shell.
 */
(function(global) {
  "use strict";

  if (global.VfRuntimeFlow) { return; }

  var PACKET_RUNTIME_STATES = {
    BOOTSTRAP_ONLY: "bootstrap-only",
    ACTIVE_STREAM: "active-stream",
    IDLE: "idle"
  };

  function createFlow(options) {
    options = options || {};
    var config = options.config || {};
    var createRuntimeDependencies = options.createRuntimeDependencies || function() { return {}; };
    var runtimeLog = options.runtimeLog || function() {};
    var getRuntimeSource = options.getRuntimeSource || function() { return null; };
    var applySceneCommands = options.applySceneCommands || function() {};
    var state = options.state || {};
    var BOOTSTRAP_COALESCE_KINDS = {
      "scene.replace": true,
      "ui_state.replace": true,
      "display.replace": true
    };

    function getPacketRuntimeState() {
      var value = String(state.packetRuntimeState || "");
      if (value === PACKET_RUNTIME_STATES.ACTIVE_STREAM || value === PACKET_RUNTIME_STATES.IDLE) {
        return value;
      }
      return PACKET_RUNTIME_STATES.BOOTSTRAP_ONLY;
    }

    function setPacketRuntimeState(nextState, reason) {
      var currentState = getPacketRuntimeState();
      var normalized = String(nextState || "");
      if (normalized !== PACKET_RUNTIME_STATES.ACTIVE_STREAM && normalized !== PACKET_RUNTIME_STATES.IDLE) {
        normalized = PACKET_RUNTIME_STATES.BOOTSTRAP_ONLY;
      }
      if (currentState === normalized) { return normalized; }
      state.packetRuntimeState = normalized;
      runtimeLog(
        "info",
        "packetRuntimeState: " + currentState + " -> " + normalized +
          (reason ? " (" + reason + ")" : "")
      );
      return normalized;
    }

    function enterBootstrapOnly(reason) {
      state.packetIdlePolls = 0;
      return setPacketRuntimeState(PACKET_RUNTIME_STATES.BOOTSTRAP_ONLY, reason);
    }

    function enterActiveStream(reason) {
      state.packetIdlePolls = 0;
      return setPacketRuntimeState(PACKET_RUNTIME_STATES.ACTIVE_STREAM, reason);
    }

    function enterIdle(reason) {
      return setPacketRuntimeState(PACKET_RUNTIME_STATES.IDLE, reason);
    }

    function getNextPacketPollDelay() {
      var currentState = getPacketRuntimeState();
      if (currentState === PACKET_RUNTIME_STATES.IDLE) {
        return null;
      }
      if (currentState === PACKET_RUNTIME_STATES.BOOTSTRAP_ONLY) {
        return Number(config.packetPollMs) || 16;
      }
      var idlePolls = Number(state.packetIdlePolls || 0);
      var idleThreshold = Number(config.packetPollIdleThreshold) || 12;
      var steadyThreshold = Number(config.packetPollSteadyThreshold) || 60;
      var quiesceThreshold = Number(config.packetPollQuiesceThreshold);
      if (!(quiesceThreshold > 0)) {
        quiesceThreshold = steadyThreshold;
      }
      if (idlePolls >= quiesceThreshold) {
        return Number(config.packetPollSteadyMs) || 400;
      }
      if (idlePolls >= steadyThreshold) {
        return Number(config.packetPollSteadyMs) || 400;
      }
      if (idlePolls >= idleThreshold) {
        return Number(config.packetPollIdleMs) || 120;
      }
      return Number(config.packetPollMs) || 16;
    }

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
      var seq = Number(packet.seq);
      if (Number.isFinite(seq) && seq > Number(state.lastRuntimePacketSeq || 0)) {
        state.lastRuntimePacketSeq = seq;
      }
      state.packetModeActive = true;
      enterActiveStream("packet seq=" + String(packet.seq));
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

    function coalesceBootstrapPackets(packets) {
      if (!Array.isArray(packets) || packets.length <= 1) { return packets; }
      if (getPacketRuntimeState() !== PACKET_RUNTIME_STATES.BOOTSTRAP_ONLY) { return packets; }
      var latestByKind = Object.create(null);
      var preserved = [];
      for (var i = 0; i < packets.length; i++) {
        var packet = packets[i];
        var kind = String(packet && packet.kind || "");
        if (!BOOTSTRAP_COALESCE_KINDS[kind]) {
          preserved.push(packet);
          continue;
        }
        latestByKind[kind] = packet;
      }
      if (!latestByKind["scene.replace"] &&
          !latestByKind["ui_state.replace"] &&
          !latestByKind["display.replace"]) {
        return packets;
      }
      var ordered = preserved.slice();
      if (latestByKind["scene.replace"]) {
        ordered.push(latestByKind["scene.replace"]);
      }
      if (latestByKind["ui_state.replace"]) {
        ordered.push(latestByKind["ui_state.replace"]);
      }
      if (latestByKind["display.replace"]) {
        ordered.push(latestByKind["display.replace"]);
      }
      runtimeLog(
        "info",
        "coalesceBootstrapPackets: in=" + packets.length + " out=" + ordered.length
      );
      return ordered;
    }

    function loadRuntimePackets() {
      var runtimeSource = getRuntimeSource();
      if (state.runtimePacketsInFlight || typeof fetch === "undefined" || !runtimeSource) { return; }
      state.runtimePacketsInFlight = true;
      return runtimeSource.loadPackets()
        .then(function(packets) {
          var applied = 0;
          if (!Array.isArray(packets)) {
            return {
              applied: applied,
              nextPollDelayMs: getNextPacketPollDelay(),
              packetRuntimeState: getPacketRuntimeState()
            };
          }
          var routedPackets = coalesceBootstrapPackets(packets);
          for (var i = 0; i < routedPackets.length; i++) {
            var packet = routedPackets[i];
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
            enterActiveStream("applied=" + applied);
            runtimeLog("info", "loadRuntimePackets: applied=" + applied + " newLastSeq=" + state.lastRuntimePacketSeq);
          } else {
            if (state.runtimePacketsSeen) {
              state.packetIdlePolls = Number(state.packetIdlePolls || 0) + 1;
            }
          }
          return {
            applied: applied,
            nextPollDelayMs: getNextPacketPollDelay(),
            packetRuntimeState: getPacketRuntimeState()
          };
        })
        .catch(function(err) {
          runtimeLog("warn", "loadRuntimePackets: " + (err && err.message ? err.message : String(err)));
          return {
            applied: 0,
            nextPollDelayMs: getNextPacketPollDelay(),
            packetRuntimeState: getPacketRuntimeState()
          };
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
      loadScene: loadScene,
      getPacketRuntimeState: getPacketRuntimeState,
      getNextPacketPollDelay: getNextPacketPollDelay,
      enterBootstrapOnly: enterBootstrapOnly,
      packetRuntimeStates: PACKET_RUNTIME_STATES
    };
  }

  global.VfRuntimeFlow = {
    createFlow: createFlow
  };
})(typeof window !== "undefined" ? window : this);
