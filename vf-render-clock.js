/**
 * vf-render-clock.js — paced render/simulation clock for dynamic scenes.
 *
 * The clock is intentionally non-compensating:
 * - it never fast-forwards to catch up
 * - it advances at most one simulation step per render opportunity
 * - it can be gated by the renderer so producers never outrun presentation
 */
(function (global) {
  "use strict";

  var RUNTIME_ASSET_VERSION = String(global.__vfRuntimeAssetVersion || "");
  if (global.VfRenderClock) {
    var existingVersion = String(global.VfRenderClock.__vfRuntimeAssetVersion || "");
    if (existingVersion !== RUNTIME_ASSET_VERSION) {
      throw new Error(
        "[vf-render-clock] stale module already loaded: existing version " +
        existingVersion + " requested version " + RUNTIME_ASSET_VERSION
      );
    }
    return;
  }

  function fail(message) {
    throw new Error("[vf-render-clock] " + String(message));
  }

  function createClock(options) {
    options = options || {};
    var fps = Math.max(1, Number(options.fps || 60) | 0);
    var frameMs = 1000.0 / fps;
    var requestAnimationFrameFn = options.requestAnimationFrame || global.requestAnimationFrame;
    var canStep = typeof options.canStep === "function" ? options.canStep : function () { return true; };
    var onStep = options.onStep;
    if (typeof requestAnimationFrameFn !== "function") {
      fail("createClock requires requestAnimationFrame");
    }
    if (typeof onStep !== "function") {
      fail("createClock requires onStep(stepIndex, nowMs)");
    }

    var running = false;
    var nextDueMs = -1;
    var lastNowMs = -1;
    var stepIndex = Number(options.initialStep || 0) | 0;

    function start() {
      if (running) {
        return;
      }
      running = true;
      requestAnimationFrameFn(tick);
    }

    function stop() {
      running = false;
    }

    function tick(now) {
      if (!running) {
        return;
      }
      var nowMs = Number(now) || 0;
      if (lastNowMs < 0) {
        lastNowMs = nowMs;
        nextDueMs = nowMs + frameMs;
      } else if (nowMs >= nextDueMs && canStep()) {
        lastNowMs = nowMs;
        nextDueMs = nowMs + frameMs;
        stepIndex += 1;
        onStep(stepIndex, nowMs);
      }
      requestAnimationFrameFn(tick);
    }

    return {
      start: start,
      stop: stop,
      running: function () {
        return running;
      },
      fps: function () {
        return fps;
      },
      frameMs: function () {
        return frameMs;
      },
      stepIndex: function () {
        return stepIndex;
      },
      reset: function (nextStepIndex) {
        stepIndex = Number(nextStepIndex || 0) | 0;
        nextDueMs = -1;
        lastNowMs = -1;
      }
    };
  }

  global.VfRenderClock = {
    __vfRuntimeAssetVersion: RUNTIME_ASSET_VERSION,
    createClock: createClock
  };
})(typeof window !== "undefined" ? window : this);
