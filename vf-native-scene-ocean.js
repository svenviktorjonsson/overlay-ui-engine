/*
 * vf-native-scene-ocean.js -- UI-engine runtime for
 * native_scene.kind = "ocean_wave".
 *
 * The frame is declared by VKF, but the ocean animation, camera orbit, and
 * light orbit all run inside the UI-engine runtime after boot.
 */
(function (global) {
  "use strict";

  var config = global.__vfNativeOceanConfig;
  if (!config || typeof config !== "object") {
    throw new Error("vf-native-scene-ocean requires window.__vfNativeOceanConfig");
  }

  var TAU = Math.PI * 2;
  var surface = config.surface || {};
  var styles = config.styles || {};
  var cameraCfg = config.camera || {};
  var lightCfg = config.light || {};
  var timingCfg = config.timing || {};
  var waves = Array.isArray(config.waves) ? config.waves : [];
  var uCount = Math.max(2, Number(surface.u_steps || 0) | 0);
  var vCount = Math.max(2, Number(surface.v_steps || 0) | 0);
  var faceSubdiv = Math.max(1, Number(surface.face_subdivisions || 4) | 0);
  var uMin = Number(surface.u_min || -6.0);
  var uMax = Number(surface.u_max || 6.0);
  var vMin = Number(surface.v_min || -6.0);
  var vMax = Number(surface.v_max || 6.0);
  var fps = Math.max(1, Number(timingCfg.fps || 30) | 0);
  var durationSeconds = Math.max(0.001, Number(timingCfg.duration_seconds || 10.0));
  var boundary = String(timingCfg.boundary || "repeat");
  var frameCount = Math.max(1, Math.round(fps * durationSeconds));
  var edgeWidth = Number(styles.edge_width || 1.0);
  var vertexSize = Number(styles.vertex_size || 0.12);
  var showEdges = styles.show_edges !== false;
  var showVertices = styles.show_vertices === true;
  var edgeCaps = styles.edge_caps === true;
  var frameId = String(config.frame_id || "");
  var waveDefs = normalizeWaves(waves);
  var initialUValues = sampleAxis(uMin, uMax, uCount);
  var initialVValues = sampleAxis(vMin, vMax, vCount);
  var waveTables = buildWaveTables(initialUValues, initialVValues, waveDefs);
  var cameraTarget = cameraCfg.target || [0, 0, 0];
  var cameraUp = cameraCfg.up || [0, 0, 1];
  var cameraRadius = Number(cameraCfg.radius || 9.6);
  var cameraHeight = Number(cameraCfg.height || 3.2);
  var cameraTheta = Number(cameraCfg.theta || 0.0);
  var cameraTurnsPerCycle = Number(cameraCfg.turns_per_cycle || 1.0);
  var cameraFov = Number(cameraCfg.fov || 42.0);
  var lightTarget = lightCfg.target || [0, 0, 0];
  var lightRadius = Number(lightCfg.radius || 7.1);
  var lightHeight = Number(lightCfg.height || 4.6);
  var lightTheta = Number(lightCfg.theta || 0.45);
  var lightTurnsPerCycle = Number(lightCfg.turns_per_cycle || 2.0);
  var lightModel = lightCfg.model || "blinn_phong";
  var lightColor = lightCfg.color || [1.0, 0.93, 0.78, 1.0];
  var lightKind = String(lightCfg.kind || "point");
  var lightDirection = Array.isArray(lightCfg.direction) ? [Number(lightCfg.direction[0]), Number(lightCfg.direction[1]), Number(lightCfg.direction[2])] : null;
  var lightIntensity = Math.max(0.0, Number(lightCfg.intensity == null ? (lightCfg.power == null ? 24.0 : lightCfg.power) : lightCfg.intensity));
  var lightInnerConeDeg = Number(lightCfg.inner_cone_deg == null ? 14.0 : lightCfg.inner_cone_deg);
  var lightOuterConeDeg = Number(lightCfg.outer_cone_deg == null ? 22.0 : lightCfg.outer_cone_deg);
  var lightRange = Math.max(0.0, Number(lightCfg.range == null ? 0.0 : lightCfg.range));
  var runtime = {
    running: false,
    lastFrameIndex: -1,
    store: null,
    bound: null,
    materials: null,
    geometryArena: null,
    camera: null,
    light: null,
    scene: null,
    clock: null
  };

  function failFast(message) {
    var text = "ocean_wave: " + String(message);
    try { console.error(text); } catch (_) {}
    try {
      if (global.chrome && global.chrome.webview && global.chrome.webview.postMessage) {
        global.chrome.webview.postMessage({ type: "vf_log", level: "error", message: text });
      }
    } catch (_) {}
    throw new Error(text);
  }

  function pageLog(message) {
    var text = "ocean_wave: " + String(message);
    try { console.log(text); } catch (_) {}
    try {
      if (global.chrome && global.chrome.webview && global.chrome.webview.postMessage) {
        global.chrome.webview.postMessage({ type: "vf_log", level: "info", message: text });
      }
    } catch (_) {}
  }

  pageLog("script:loaded");

  function requireRuntime() {
    if (!global.VfDisplay || typeof global.VfDisplay.mountDynamicGeomFrame !== "function") {
      failFast("VfDisplay.mountDynamicGeomFrame is unavailable");
    }
    if (typeof global.VfDisplay.requestDynamicGeomFrameUpdate !== "function") {
      failFast("VfDisplay.requestDynamicGeomFrameUpdate is unavailable");
    }
    if (!global.VfGeomCore) {
      failFast("VfGeomCore is unavailable");
    }
    if (!global.VfGeomWgpu) {
      failFast("VfGeomWgpu is unavailable");
    }
    if (!global.VfGeomFrameAdapter) {
      failFast("VfGeomFrameAdapter is unavailable");
    }
    if (!global.VfGeomMaterialArena || typeof global.VfGeomMaterialArena.createArena !== "function") {
      failFast("VfGeomMaterialArena.createArena is unavailable");
    }
    if (!global.VfGeomParametricSurface || typeof global.VfGeomParametricSurface.createGridSurfaceArena !== "function") {
      failFast("VfGeomParametricSurface.createGridSurfaceArena is unavailable");
    }
    if (!global.VfRenderClock || typeof global.VfRenderClock.createClock !== "function") {
      failFast("VfRenderClock.createClock is unavailable");
    }
    if (!global.VfGeomLedger || typeof global.VfGeomLedger.createParametricSurfaceGridSharedStore !== "function") {
      failFast("VfGeomLedger.createParametricSurfaceGridSharedStore is unavailable");
    }
    if (typeof global.VfDisplay.renderFromJson !== "function") {
      failFast("VfDisplay.renderFromJson is unavailable");
    }
  }

  function runtimeReady() {
    return !!(
      global.VfDisplay &&
      typeof global.VfDisplay.mountDynamicGeomFrame === "function" &&
      typeof global.VfDisplay.requestDynamicGeomFrameUpdate === "function" &&
      typeof global.VfDisplay.renderFromJson === "function" &&
      !!global.VfGeomCore &&
      !!global.VfGeomWgpu &&
      !!global.VfGeomFrameAdapter &&
      global.VfGeomMaterialArena &&
      typeof global.VfGeomMaterialArena.createArena === "function" &&
      global.VfGeomParametricSurface &&
      typeof global.VfGeomParametricSurface.createGridSurfaceArena === "function" &&
      !!global.VfRenderClock &&
      typeof global.VfRenderClock.createClock === "function" &&
      global.VfGeomLedger &&
      typeof global.VfGeomLedger.createParametricSurfaceGridSharedStore === "function"
    );
  }

  function normalizeWaves(source) {
    if (!Array.isArray(source) || !source.length) {
      failFast("config.waves must contain at least one wave component");
    }
    return source.map(function (wave) {
      var spec = wave || {};
      var kind = String(spec.kind || "linear");
      var fn = String(spec.fn || "sin");
      if (kind !== "linear" && kind !== "radial2") {
        failFast("wave.kind must be linear or radial2");
      }
      if (fn !== "sin" && fn !== "cos") {
        failFast("wave.fn must be sin or cos");
      }
      return {
        kind: kind,
        fn: fn,
        amplitude: Number(spec.amplitude || 0.0),
        ux: Number(spec.ux || 0.0),
        uy: Number(spec.uy || 0.0),
        radial2: Number(spec.radial2 || 0.0),
        timeFreq: Number(spec.time_freq || 0.0)
      };
    });
  }

  function sampleAxis(minValue, maxValue, count) {
    var out = new Float32Array(count);
    if (count <= 1) {
      out[0] = Number(minValue);
      return out;
    }
    var step = (Number(maxValue) - Number(minValue)) / Math.max(1, count - 1);
    for (var i = 0; i < count; i += 1) {
      out[i] = Number(minValue) + (step * i);
    }
    return out;
  }

  function buildWaveTables(uValues, vValues, defs) {
    var tables = new Array(defs.length);
    var pointCount = uCount * vCount;
    for (var waveIndex = 0; waveIndex < defs.length; waveIndex += 1) {
      var wave = defs[waveIndex];
      var sinBase = new Float32Array(pointCount);
      var cosBase = new Float32Array(pointCount);
      var offset = 0;
      for (var vIndex = 0; vIndex < vCount; vIndex += 1) {
        var v = vValues[vIndex];
        for (var uIndex = 0; uIndex < uCount; uIndex += 1) {
          var u = uValues[uIndex];
          var baseArg = wave.kind === "radial2"
            ? (((u * u) + (v * v)) * wave.radial2)
            : ((u * wave.ux) + (v * wave.uy));
          sinBase[offset] = Math.sin(baseArg);
          cosBase[offset] = Math.cos(baseArg);
          offset += 1;
        }
      }
      tables[waveIndex] = {
        amplitude: wave.amplitude,
        timeFreq: wave.timeFreq,
        fn: wave.fn,
        sinBase: sinBase,
        cosBase: cosBase
      };
    }
    return tables;
  }

  function boundaryCode(name) {
    if (name === "mirror") { return 1; }
    if (name === "stop") { return 2; }
    if (name === "reset") { return 3; }
    return 0;
  }

  function createMaterials() {
    return global.VfGeomMaterialArena.createArena({
      surface: {
        base_color: styles.face_color || [0.06, 0.55, 0.94, 1.0],
        light_model: "blinn_phong",
        depth_write: true
      },
      edge: {
        base_color: styles.edge_color || [0.08, 0.78, 1.0, 0.95],
        depth_write: true
      },
      vertex: {
        base_color: styles.vertex_color || [1.0, 0.45, 0.18, 1.0],
        depth_write: true
      }
    });
  }

  function createGeometryArena(materials) {
    return global.VfGeomParametricSurface.createGridSurfaceArena({
      uValues: initialUValues,
      vValues: initialVValues,
      faceSubdivisions: faceSubdiv,
      showEdges: showEdges,
      showVertices: showVertices,
      edgeWidth: edgeWidth,
      vertexSize: vertexSize,
      faceMaterialId: "surface",
      edgeMaterialId: "edge",
      vertexMaterialId: "vertex",
      materials: materials,
      edgeCaps: edgeCaps
    });
  }

  function rebuildHeights(bound, phase) {
    var pointCount = uCount * vCount;
    var heights = bound.heights;
    if (waveTables.length <= 0) {
      for (var emptyIndex = 0; emptyIndex < pointCount; emptyIndex += 1) {
        heights[emptyIndex] = 0.0;
      }
      return;
    }
    for (var waveIndex = 0; waveIndex < waveTables.length; waveIndex += 1) {
      var table = waveTables[waveIndex];
      var phaseArg = phase * table.timeFreq;
      var sinTime = Math.sin(phaseArg);
      var cosTime = Math.cos(phaseArg);
      var sinBase = table.sinBase;
      var cosBase = table.cosBase;
      var amplitude = table.amplitude;
      if (table.fn === "cos") {
        for (var cosIndex = 0; cosIndex < pointCount; cosIndex += 1) {
          var cosValue = amplitude * ((cosBase[cosIndex] * cosTime) - (sinBase[cosIndex] * sinTime));
          heights[cosIndex] = waveIndex === 0 ? cosValue : (heights[cosIndex] + cosValue);
        }
      } else {
        for (var sinIndex = 0; sinIndex < pointCount; sinIndex += 1) {
          var sinValue = amplitude * ((sinBase[sinIndex] * cosTime) + (cosBase[sinIndex] * sinTime));
          heights[sinIndex] = waveIndex === 0 ? sinValue : (heights[sinIndex] + sinValue);
        }
      }
    }
  }

  function resolveFrameIndex(step) {
    if (frameCount <= 1) {
      return 0;
    }
    if (boundary === "stop") {
      return Math.min(step, frameCount - 1);
    }
    if (boundary === "reset") {
      return step >= frameCount ? 0 : step;
    }
    if (boundary === "mirror") {
      var span = frameCount - 1;
      var period = span * 2;
      if (period <= 0) {
        return 0;
      }
      var mirrored = step % period;
      if (mirrored < 0) {
        mirrored += period;
      }
      if (mirrored > span) {
        mirrored = period - mirrored;
      }
      return mirrored;
    }
    var repeated = step % frameCount;
    return repeated < 0 ? repeated + frameCount : repeated;
  }

  function progressForFrame(frameIndex) {
    if (frameCount <= 1) {
      return 0.0;
    }
    return Number(frameIndex) / Number(frameCount);
  }

  function updateOrbitCamera(progress, camera) {
    var theta = cameraTheta + (progress * TAU * cameraTurnsPerCycle);
    camera.pos[0] = Math.cos(theta) * cameraRadius;
    camera.pos[1] = Math.sin(theta) * cameraRadius;
    camera.pos[2] = cameraHeight;
  }

  function updateOrbitLight(progress, light) {
    var theta = lightTheta + (progress * TAU * lightTurnsPerCycle);
    light.pos[0] = Math.cos(theta) * lightRadius;
    light.pos[1] = Math.sin(theta) * lightRadius;
    light.pos[2] = lightHeight;
  }

  function updateLedgerForStep(step) {
    var frameIndex = resolveFrameIndex(step);
    if (frameIndex === runtime.lastFrameIndex) {
      return false;
    }
    runtime.lastFrameIndex = frameIndex;
    var progress = progressForFrame(frameIndex);
    var phase = progress * TAU;
    runtime.store.mutate(function (bound) {
      bound.frameIndex[0] = frameIndex;
      bound.boundaryCode[0] = boundaryCode(boundary);
      bound.phase[0] = phase;
      rebuildHeights(bound, phase);
      return { geometryDirty: true };
    });
    return true;
  }

  function buildSnapshot(bound) {
    runtime.geometryArena.rebuild(bound);
    var progress = progressForFrame(bound.frameIndex[0] | 0);
    updateOrbitCamera(progress, runtime.camera);
    updateOrbitLight(progress, runtime.light);
    return runtime.scene;
  }

  function boot() {
    try {
      pageLog("boot:start");
      requireRuntime();
      global.VfDisplay.renderFromJson({ screen: [], frames: {}, geom: {} });
      runtime.materials = createMaterials();
      runtime.geometryArena = createGeometryArena(runtime.materials);
      runtime.camera = {
        pos: [0, 0, 0],
        target: cameraTarget,
        fov: cameraFov,
        up: cameraUp
      };
      runtime.light = {
        pos: [0, 0, 0],
        target: lightTarget,
        model: lightModel,
        color: lightColor,
        kind: lightKind,
        direction: lightDirection,
        intensity: lightIntensity,
        inner_cone_deg: lightInnerConeDeg,
        outer_cone_deg: lightOuterConeDeg,
        range: lightRange
      };
      runtime.scene = {
        parts: runtime.geometryArena.parts(),
        materials: runtime.materials,
        camera: runtime.camera,
        lights: [runtime.light],
        unified_renderer: true
      };
      runtime.store = global.VfGeomLedger.createParametricSurfaceGridSharedStore({
        uValues: initialUValues,
        vValues: initialVValues,
        buildSnapshot: buildSnapshot
      });
      runtime.bound = runtime.store.readState();
      updateLedgerForStep(0);
      global.VfDisplay.mountDynamicGeomFrame(frameId, function () {
        return runtime.store.snapshot();
      });
      global.VfDisplay.requestDynamicGeomFrameUpdate(frameId);
      runtime.clock = global.VfRenderClock.createClock({
        fps: fps,
        initialStep: 0,
        canStep: function () {
          return !!(
            global.VfDisplay &&
            typeof global.VfDisplay.dynamicGeomFrameCanAcceptUpdate === "function" &&
            global.VfDisplay.dynamicGeomFrameCanAcceptUpdate(frameId)
          );
        },
        onStep: function (stepIndex) {
          if (updateLedgerForStep(stepIndex)) {
            global.VfDisplay.requestDynamicGeomFrameUpdate(frameId);
          }
        }
      });
      pageLog("boot:mounted dynamic frame");
      runtime.running = true;
      runtime.clock.start();
    } catch (error) {
      failFast(error && error.message ? error.message : String(error));
    }
  }

  function waitForFrame(attempt) {
    if (attempt === 0) {
      pageLog("waitForFrame:start");
    } else if ((attempt % 30) === 0) {
      var probeFrame = document.querySelector('.vf-frame[data-vf-frame-id="' + frameId + '"]');
      pageLog(
        "waitForFrame:poll attempt=" +
        String(attempt) +
        " frame=" +
        String(!!probeFrame) +
        " display=" +
        String(!!global.VfDisplay) +
        " core=" +
        String(!!global.VfGeomCore) +
        " wgpu=" +
        String(!!global.VfGeomWgpu) +
        " adapter=" +
        String(!!global.VfGeomFrameAdapter) +
        " material=" +
        String(!!global.VfGeomMaterialArena) +
        " surface=" +
        String(!!global.VfGeomParametricSurface) +
        " clock=" +
        String(!!global.VfRenderClock) +
        " ledger=" +
        String(!!global.VfGeomLedger)
      );
    }
    var frame = document.querySelector('.vf-frame[data-vf-frame-id="' + frameId + '"]');
    if (frame && runtimeReady()) {
      pageLog("waitForFrame:ready attempt=" + String(attempt));
      boot();
      return;
    }
    if (attempt > 240) {
      failFast(
        "timed out waiting for ocean frame/runtime (frame=" +
        String(!!frame) +
        " display=" +
        String(!!global.VfDisplay) +
        " core=" +
        String(!!global.VfGeomCore) +
        " wgpu=" +
        String(!!global.VfGeomWgpu) +
        " adapter=" +
        String(!!global.VfGeomFrameAdapter) +
        " material=" +
        String(!!global.VfGeomMaterialArena) +
        " surface=" +
        String(!!global.VfGeomParametricSurface) +
        " clock=" +
        String(!!global.VfRenderClock) +
        " ledger=" +
        String(!!global.VfGeomLedger) +
        ")"
      );
    }
    global.setTimeout(function () { waitForFrame(attempt + 1); }, 16);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { waitForFrame(0); }, { once: true });
  } else {
    waitForFrame(0);
  }
})(typeof window !== "undefined" ? window : this);
