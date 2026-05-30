/*
 * vf-native-scene.js -- generic native scene runtime
 *
 * First-pass physically motivated penumbra: a planar projected shadow from the
 * orbiting light onto the receiver plane. Edge softness comes from source
 * radius, receiver gap, light distance, and grazing angle on the plane.
 */
(function (global) {
  "use strict";

  var rootConfig = global.__vfNativeSceneConfig;
  if (!rootConfig || typeof rootConfig !== "object") {
    throw new Error("native_scene runtime requires window.__vfNativeSceneConfig");
  }
  var config = rootConfig.scene_ir || rootConfig;
  var frameSpec = config.frame || {};
  var renderOptions = config.render_options || {};
  if (!global.__vfNativeSceneLiveCameras) {
    global.__vfNativeSceneLiveCameras = Object.create(null);
  }
  if (!global.__vfNativeSceneFrameDependents) {
    global.__vfNativeSceneFrameDependents = Object.create(null);
  }
  var surfaceWorlds = config.surface_worlds && typeof config.surface_worlds === "object" ? config.surface_worlds : {};
  var surfaceCameras = config.surface_cameras && typeof config.surface_cameras === "object" ? config.surface_cameras : {};
  var timingCfg = config.timing || {};
  var fps = Math.max(1, Number(timingCfg.fps || 30) | 0);
  var durationSeconds = Math.max(0.001, Number(timingCfg.duration_seconds || 10.0));
  var boundary = String(timingCfg.boundary || "repeat");
  var frameCount = Math.max(1, Math.round(fps * durationSeconds));
  var AXIS_TAGGED_KEY = "__vf_axis_tagged__";

  function showFatalOverlay(text) {
    try {
      var doc = global.document;
      if (!doc) { return; }
      var frameId = String(frameSpec.frame_id || "");
      var host = frameId
        ? doc.querySelector('.vf-frame[data-vf-frame-id="' + frameId + '"] .vf-frame__body')
        : null;
      if (!host) { host = doc.body; }
      if (!host) { return; }
      var existing = doc.getElementById("vf-native-scene-fatal");
      if (!existing) {
        existing = doc.createElement("div");
        existing.id = "vf-native-scene-fatal";
        existing.style.position = "absolute";
        existing.style.inset = "0";
        existing.style.zIndex = "9999";
        existing.style.display = "flex";
        existing.style.alignItems = "center";
        existing.style.justifyContent = "center";
        existing.style.padding = "24px";
        existing.style.background = "rgba(20,12,16,0.92)";
        existing.style.color = "#ffd7df";
        existing.style.font = "600 14px/1.45 Consolas, Menlo, monospace";
        existing.style.whiteSpace = "pre-wrap";
        existing.style.textAlign = "left";
        if (host !== doc.body) {
          var computedPosition = "";
          try { computedPosition = global.getComputedStyle(host).position || ""; } catch (_) {}
          if (!computedPosition || computedPosition === "static") {
            host.style.position = "relative";
          }
        } else {
          existing.style.position = "fixed";
        }
        host.appendChild(existing);
      }
      existing.textContent = String(text);
    } catch (_) {}
  }

  function showStatusOverlay(text) {
    try {
      var doc = global.document;
      if (!doc) { return; }
      var frameId = String(frameSpec.frame_id || "");
      var host = frameId
        ? doc.querySelector('.vf-frame[data-vf-frame-id="' + frameId + '"] .vf-frame__body')
        : null;
      if (!host) { return; }
      var existing = doc.getElementById("vf-native-scene-status");
      if (!existing) {
        existing = doc.createElement("div");
        existing.id = "vf-native-scene-status";
        existing.style.position = "absolute";
        existing.style.left = "8px";
        existing.style.top = "8px";
        existing.style.zIndex = "9998";
        existing.style.maxWidth = "calc(100% - 16px)";
        existing.style.padding = "6px 8px";
        existing.style.background = "rgba(10,14,20,0.72)";
        existing.style.color = "#d9e7ff";
        existing.style.font = "12px/1.35 Consolas, Menlo, monospace";
        existing.style.whiteSpace = "pre-wrap";
        existing.style.pointerEvents = "none";
        existing.style.borderRadius = "6px";
        existing.style.boxShadow = "0 2px 10px rgba(0,0,0,0.35)";
        var computedPosition = "";
        try { computedPosition = global.getComputedStyle(host).position || ""; } catch (_) {}
        if (!computedPosition || computedPosition === "static") {
          host.style.position = "relative";
        }
        host.appendChild(existing);
      }
      existing.textContent = String(text);
    } catch (_) {}
  }

  function clearStatusOverlay() {
    try {
      var doc = global.document;
      if (!doc) { return; }
      var existing = doc.getElementById("vf-native-scene-status");
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
    } catch (_) {}
  }

  function visibleSpecSummary(spec) {
    if (!spec || typeof spec !== "object") {
      return "visibleSpec=null";
    }
    var meshes = Array.isArray(spec.meshes) ? spec.meshes.length : 0;
    var parts = Array.isArray(spec.parts) ? spec.parts.length : 0;
    var cam = spec.camera && typeof spec.camera === "object" ? spec.camera : null;
    var vpw = cam ? Number(cam.viewport_width_px || 0) : 0;
    var vph = cam ? Number(cam.viewport_height_px || 0) : 0;
    return [
      "visibleSpec.meshes=" + String(meshes),
      "visibleSpec.parts=" + String(parts),
      "camera.viewport=" + String(vpw) + "x" + String(vph),
      "unified=" + String(spec.unified_renderer === true)
    ].join("\n");
  }

  function failFast(message) {
    var text = "native_scene: " + String(message);
    try { console.error(text); } catch (_) {}
    try {
      if (global.chrome && global.chrome.webview && global.chrome.webview.postMessage) {
        global.chrome.webview.postMessage({ type: "vf_log", level: "error", message: text });
      }
    } catch (_) {}
    showFatalOverlay(text);
    throw new Error(text);
  }

  global.__vfGeomRuntimeErrorHandler = function (message) {
    failFast("shared renderer frame error: " + String(message || "unknown"));
  };

  function requireRuntime() {
    if (!global.VfDisplay || typeof global.VfDisplay.renderFromJson !== "function") {
      return false;
    }
    return true;
  }

  function clamp01(value) {
    return Math.max(0.0, Math.min(1.0, Number(value) || 0.0));
  }

  function smoothstep(edge0, edge1, x) {
    var t = clamp01((Number(x) - Number(edge0)) / Math.max(1e-6, Number(edge1) - Number(edge0)));
    return t * t * (3.0 - (2.0 * t));
  }

  function toVec3(value, fallback) {
    if (!Array.isArray(value) || value.length !== 3) { return fallback.slice(); }
    return [Number(value[0]), Number(value[1]), Number(value[2])];
  }

  function toRgba(value, fallback) {
    if (!Array.isArray(value) || value.length !== 4) { return fallback.slice(); }
    return [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3])];
  }

  function identityMat4() {
    return [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ];
  }

  function isEncodedAxisTaggedValue(value) {
    return !!value && typeof value === "object" && value[AXIS_TAGGED_KEY] === true;
  }

  function encodedAxisTaggedIdx(value) {
    return isEncodedAxisTaggedValue(value) ? String(value.idx || "") : "";
  }

  function encodedAxisTaggedData(value) {
    return isEncodedAxisTaggedValue(value) ? value.data : value;
  }

  function trackLengthForAxis(value, axisPos) {
    var cur = value;
    for (var i = 0; i < axisPos; i += 1) {
      if (!Array.isArray(cur) || !cur.length) { return 0; }
      cur = cur[0];
    }
    return Array.isArray(cur) ? cur.length : 0;
  }

  function sliceAxisAt(value, axisPos, sampleIndex) {
    if (axisPos <= 0) {
      return Array.isArray(value) ? value[sampleIndex] : value;
    }
    if (!Array.isArray(value)) { return value; }
    return value.map(function (item) {
      return sliceAxisAt(item, axisPos - 1, sampleIndex);
    });
  }

  function entityProperties(entity) {
    if (entity && entity.properties && typeof entity.properties === "object") {
      return entity.properties;
    }
    return entity && typeof entity === "object" ? entity : {};
  }

  function entityEmbedding(entity) {
    return entity && entity.embedding && typeof entity.embedding === "object"
      ? entity.embedding
      : {};
  }

  function entityPropName(entity, canonicalName) {
    var embedding = entityEmbedding(entity);
    return String(embedding[canonicalName] || canonicalName);
  }

  function entityProp(entity, canonicalName, fallback) {
    var props = entityProperties(entity);
    var propName = entityPropName(entity, canonicalName);
    if (Object.prototype.hasOwnProperty.call(props, propName)) {
      return props[propName];
    }
    if (entity && Object.prototype.hasOwnProperty.call(entity, canonicalName)) {
      return entity[canonicalName];
    }
    return fallback;
  }

  function makeCamera(cfg, fallback, seconds) {
    var camera = cfg || {};
    var framePos = animationFramePosition(seconds || 0.0);
    return {
      pos: sampleVec3Track(entityTrack(camera, "pos"), framePos, toVec3(entityProp(camera, "pos", fallback.pos), fallback.pos)),
      target: sampleVec3Track(entityTrack(camera, "target"), framePos, toVec3(entityProp(camera, "target", fallback.target), fallback.target)),
      fov: sampleNumberTrack(entityTrack(camera, "fov"), framePos, Number(entityProp(camera, "fov", fallback.fov) || fallback.fov)),
      up: sampleVec3Track(entityTrack(camera, "up"), framePos, toVec3(entityProp(camera, "up", fallback.up), fallback.up)),
      min_distance: Number(entityProp(camera, "min_distance", fallback.min_distance == null ? 0.0 : fallback.min_distance) || 0.0),
      flip_x: entityProp(camera, "flip_x", fallback.flip_x === true) === true
    };
  }

  function zoomCamera(camera, zoomFactor) {
    var pos = toVec3(camera.pos, [0, 0, 5]);
    var target = toVec3(camera.target, [0, 0, 0]);
    var dx = pos[0] - target[0];
    var dy = pos[1] - target[1];
    var dz = pos[2] - target[2];
    var currentDistance = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz)) || 1.0;
    var nextFactor = Math.max(1e-6, Number(zoomFactor || 1.0));
    var nextDistance = currentDistance * nextFactor;
    var minDistance = Number(camera.min_distance == null ? 0.0 : camera.min_distance);
    var safetyMinDistance = Math.max(1e-4, minDistance);
    nextDistance = Math.max(safetyMinDistance, nextDistance);
    nextFactor = nextDistance / currentDistance;
    return {
      pos: [target[0] + (dx * nextFactor), target[1] + (dy * nextFactor), target[2] + (dz * nextFactor)],
      target: target.slice(),
      fov: Number(camera.fov || 34),
      up: toVec3(camera.up, [0, 0, 1]),
      min_distance: minDistance,
      flip_x: camera.flip_x === true
    };
  }

  function orbitCameraAroundTarget(camera, phiRad, thetaRad) {
    var pos = toVec3(camera.pos, [0, 0, 5]);
    var target = toVec3(camera.target, [0, 0, 0]);
    var dx = Number(pos[0]) - Number(target[0]);
    var dy = Number(pos[1]) - Number(target[1]);
    var dz = Number(pos[2]) - Number(target[2]);
    var radius = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz)) || 1.0;
    var basePhi = Math.atan2(dy, dx);
    var baseTheta = Math.atan2(dz, Math.sqrt((dx * dx) + (dy * dy)) || 1e-6);
    var nextPhi = basePhi + (Number(phiRad) || 0.0);
    var thetaLimit = (Math.PI * 0.5) - 1e-3;
    var nextTheta = Math.max(-thetaLimit, Math.min(thetaLimit, baseTheta + (Number(thetaRad) || 0.0)));
    var cosTheta = Math.cos(nextTheta);
    return {
      pos: [
        target[0] + (radius * cosTheta * Math.cos(nextPhi)),
        target[1] + (radius * cosTheta * Math.sin(nextPhi)),
        target[2] + (radius * Math.sin(nextTheta))
      ],
      target: target.slice(),
      fov: Number(camera.fov || 34),
      up: toVec3(camera.up, [0, 0, 1]),
      min_distance: Number(camera.min_distance == null ? 0.0 : camera.min_distance) || 0.0,
      flip_x: camera.flip_x === true
    };
  }

  function rotateCameraLookAroundEye(camera, angleRad) {
    var pos = toVec3(camera && camera.pos, [0.0, 0.0, 0.0]);
    var target = toVec3(camera && camera.target, [0.0, 0.0, 1.0]);
    var up = normalize3(toVec3(camera && camera.up, [0.0, 0.0, 1.0]), [0.0, 0.0, 1.0]);
    var dx = Number(target[0]) - Number(pos[0]);
    var dy = Number(target[1]) - Number(pos[1]);
    var dz = Number(target[2]) - Number(pos[2]);
    var c = Math.cos(Number(angleRad || 0.0));
    var s = Math.sin(Number(angleRad || 0.0));
    var rx = (c * dx) - (s * dy);
    var ry = (s * dx) + (c * dy);
    return {
      pos: pos,
      target: [Number(pos[0]) + rx, Number(pos[1]) + ry, Number(pos[2]) + dz],
      up: up,
      fov: Number(camera && camera.fov || 34.0) || 34.0,
      min_distance: Number(camera && camera.min_distance || 0.0) || 0.0,
      flip_x: camera && camera.flip_x === true
    };
  }

  function cloneCameraState(camera, fallback) {
    var source = camera && typeof camera === "object" ? camera : (fallback || {});
    var fov = Number(source.fov || (fallback && fallback.fov) || 34);
    if (Array.isArray(source.projection_matrix) && source.projection_matrix.length === 16) {
      var projScaleY = Math.abs(Number(source.projection_matrix[5] || 0.0));
      if (projScaleY > 1e-6) {
        fov = 2.0 * Math.atan(1.0 / projScaleY) * 180.0 / Math.PI;
      }
    }
    var cloned = {
      pos: toVec3(source.pos, toVec3(fallback && fallback.pos, [0, 0, 5])),
      target: toVec3(source.target, toVec3(fallback && fallback.target, [0, 0, 0])),
      fov: fov,
      up: toVec3(source.up, toVec3(fallback && fallback.up, [0, 0, 1])),
      min_distance: Number(source.min_distance == null ? ((fallback && fallback.min_distance) == null ? 0.0 : fallback.min_distance) : source.min_distance) || 0.0,
      flip_x: source.flip_x === true || (!!fallback && fallback.flip_x === true)
    };
    if (Array.isArray(source.view_matrix) && source.view_matrix.length === 16) {
      cloned.view_matrix = source.view_matrix.slice();
    }
    if (Array.isArray(source.projection_matrix) && source.projection_matrix.length === 16) {
      cloned.projection_matrix = source.projection_matrix.slice();
    }
    if (source && source._skip_render === true) {
      cloned._skip_render = true;
    }
    if (source && source._mirrorDebug && typeof source._mirrorDebug === "object") {
      cloned._mirrorDebug = cloneJsonValue(source._mirrorDebug);
    }
    if (Array.isArray(source._mirrorViewProjection) && source._mirrorViewProjection.length === 16) {
      cloned._mirrorViewProjection = source._mirrorViewProjection.slice();
    }
    return cloned;
  }

  function cameraOrbitStepRadians(cameraConfig) {
    var stepDeg = Number(entityProp(cameraConfig || {}, "orbit_step_deg", 5.0));
    if (!Number.isFinite(stepDeg) || Math.abs(stepDeg) < 1e-6) { stepDeg = 5.0; }
    return stepDeg * Math.PI / 180.0;
  }

  function cameraDistance(camera) {
    var pos = toVec3(camera.pos, [0, 0, 5]);
    var target = toVec3(camera.target, [0, 0, 0]);
    var dx = pos[0] - target[0];
    var dy = pos[1] - target[1];
    var dz = pos[2] - target[2];
    return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz)) || 1.0;
  }

  function cloneJsonValue(value) {
    if (Array.isArray(value)) {
      return value.map(cloneJsonValue);
    }
    if (value && typeof value === "object") {
      var out = {};
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          out[key] = cloneJsonValue(value[key]);
        }
      }
      return out;
    }
    return value;
  }

  function normalizeSurfaceCameraSpec(source, fallback) {
    var spec = source && typeof source === "object" ? source : {};
    var base = fallback && typeof fallback === "object" ? fallback : {};
    var out = {
      pos: toVec3(spec.pos, toVec3(base.pos, [1.9, -2.2, 1.4])),
      target: toVec3(spec.target, toVec3(base.target, [0.0, 0.0, 0.0])),
      up: toVec3(spec.up, toVec3(base.up, [0.0, 0.0, 1.0])),
      fov: Number(spec.fov == null ? (base.fov == null ? 34.0 : base.fov) : spec.fov) || 34.0,
      distance: Math.max(0.4, Number(spec.distance == null ? (base.distance == null ? 2.6 : base.distance) : spec.distance) || 2.6)
    };
    var mirrorOf = spec && spec.mirror_of && typeof spec.mirror_of === "object" ? spec.mirror_of : null;
    if (mirrorOf) {
      out.reflect_of_frame_id = String(mirrorOf.frame_id || "");
      out.reflect_mirror_mesh_id = String(mirrorOf.mesh_id || "");
      out.aperture_mirror_mesh_id = String(mirrorOf.mesh_id || "");
      out.reflect_eye_only = mirrorOf.reflect_eye_only !== false;
      out.lock_aperture_camera = mirrorOf.lock_aperture_camera !== false;
      out.controls_enabled = mirrorOf.controls_enabled === true;
      out.flip_x = true;
    }
    if (spec.reflect_of_frame_id !== undefined) { out.reflect_of_frame_id = String(spec.reflect_of_frame_id || ""); }
    if (spec.reflect_mirror_mesh_id !== undefined) { out.reflect_mirror_mesh_id = String(spec.reflect_mirror_mesh_id || ""); }
    if (spec.aperture_mirror_mesh_id !== undefined) { out.aperture_mirror_mesh_id = String(spec.aperture_mirror_mesh_id || ""); }
    if (spec.reflect_eye_only !== undefined) { out.reflect_eye_only = spec.reflect_eye_only === true; }
    if (spec.lock_aperture_camera !== undefined) { out.lock_aperture_camera = spec.lock_aperture_camera === true; }
    if (spec.controls_enabled !== undefined) { out.controls_enabled = spec.controls_enabled === true; }
    if (spec.flip_x !== undefined) { out.flip_x = spec.flip_x === true; }
    return out;
  }

  function resolveSurfaceCamera(system, viewerCamera) {
    var screen = system && typeof system === "object" ? system : {};
    var cameraRef = String(screen.camera_ref || "");
    var currentViewer = viewerCamera && typeof viewerCamera === "object"
      ? viewerCamera
      : { pos: [4.0, -5.0, 3.5], target: [0.0, 0.0, 0.0], up: [0.0, 0.0, 1.0], fov: 34.0 };
    if (cameraRef === "current") {
      var viewPos = toVec3(currentViewer.pos, [4.0, -5.0, 3.5]);
      var viewTarget = toVec3(currentViewer.target, [0.0, 0.0, 0.0]);
      var dx = viewPos[0] - viewTarget[0];
      var dy = viewPos[1] - viewTarget[1];
      var dz = viewPos[2] - viewTarget[2];
      var dist = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz)) || 1.0;
      var desiredDistance = Math.max(0.4, Number(screen.camera_distance || 2.6) || 2.6);
      var scale = desiredDistance / dist;
      return {
        pos: [dx * scale, dy * scale, dz * scale],
        target: [0.0, 0.0, 0.0],
        up: toVec3(currentViewer.up, [0.0, 0.0, 1.0]),
        fov: Number(currentViewer.fov || 34.0),
        distance: desiredDistance
      };
    }
    if (cameraRef && global.__vfNativeSceneLiveCameras && Object.prototype.hasOwnProperty.call(global.__vfNativeSceneLiveCameras, cameraRef)) {
      return normalizeSurfaceCameraSpec(global.__vfNativeSceneLiveCameras[cameraRef], screen.camera || null);
    }
    if (cameraRef && Object.prototype.hasOwnProperty.call(surfaceCameras, cameraRef)) {
      return normalizeSurfaceCameraSpec(surfaceCameras[cameraRef], screen.camera || null);
    }
    return normalizeSurfaceCameraSpec(screen.camera || null, null);
  }

  function resolveReflectSourceCameraForSpec(spec, viewerCamera) {
    var sourceFrameId = String(spec && spec.reflect_of_frame_id || "").trim();
    if (!sourceFrameId || sourceFrameId === "current") {
      return viewerCamera && typeof viewerCamera === "object" ? viewerCamera : null;
    }
    var live = global.__vfNativeSceneLiveCameras && global.__vfNativeSceneLiveCameras[sourceFrameId];
    return live && typeof live === "object" ? live : null;
  }

  function parseCssRgbaColor(text) {
    var raw = String(text || "").trim();
    if (!raw) { return null; }
    if (raw === "transparent") { return [0.0, 0.0, 0.0, 0.0]; }
    var m = raw.match(/^rgba?\(([^)]+)\)$/i);
    if (!m) { return null; }
    var parts = m[1].split(",").map(function (part) { return String(part).trim(); });
    if (parts.length < 3) { return null; }
    var r = Math.max(0, Math.min(255, Number(parts[0]) || 0)) / 255.0;
    var g = Math.max(0, Math.min(255, Number(parts[1]) || 0)) / 255.0;
    var b = Math.max(0, Math.min(255, Number(parts[2]) || 0)) / 255.0;
    var a = parts.length >= 4 ? Math.max(0, Math.min(1, Number(parts[3]) || 0)) : 1.0;
    return [r, g, b, a];
  }

  function resolveSceneBackgroundFallback() {
    if (config && Object.prototype.hasOwnProperty.call(config, "background")) {
      return toRgba(config.background, [0.0, 0.0, 0.0, 0.0]);
    }
    try {
      var doc = global.document;
      if (!doc || typeof global.getComputedStyle !== "function") {
        return [0.0, 0.0, 0.0, 0.0];
      }
      var selector = '.vf-frame[data-vf-frame-id="' + String(frameSpec.frame_id || config.frame_id || "") + '"] .vf-frame__body';
      var host = doc.querySelector(selector) || doc.body;
      if (!host) { return [0.0, 0.0, 0.0, 0.0]; }
      var style = global.getComputedStyle(host);
      var parsed = parseCssRgbaColor(style && style.backgroundColor);
      return parsed || [0.0, 0.0, 0.0, 0.0];
    } catch (_) {
      return [0.0, 0.0, 0.0, 0.0];
    }
  }

  function normalizeSurfaceWorldSpec(source) {
    var spec = source && typeof source === "object" ? source : {};
    var sceneBackground = resolveSceneBackgroundFallback();
    return {
      kind: String(spec.kind || "cube_demo"),
      cube_size: Math.max(0.2, Number(spec.cube_size == null ? 0.88 : spec.cube_size) || 0.88),
      spin_axis: normalize3(toVec3(spec.spin_axis, [0.0, 1.0, 0.0]), [0.0, 1.0, 0.0]),
      angular_velocity: Number(spec.angular_velocity == null ? 1.05 : spec.angular_velocity) || 1.05,
      phase: Number(spec.phase || 0.0) || 0.0,
      background: toRgba(spec.background, sceneBackground),
      frame_color: toRgba(spec.frame_color, sceneBackground),
    };
  }

  function resolveSurfaceWorld(system) {
    var screen = system && typeof system === "object" ? system : {};
    var worldRef = String(screen.world_ref || "");
    if (worldRef && Object.prototype.hasOwnProperty.call(surfaceWorlds, worldRef)) {
      return normalizeSurfaceWorldSpec(surfaceWorlds[worldRef]);
    }
    return normalizeSurfaceWorldSpec(screen.world || null);
  }

  function resolveSurfaceSystem(system, viewerCamera, seconds) {
    if (!system || typeof system !== "object") { return null; }
    var kind = String(system.kind || "").toLowerCase().trim();
    if (kind !== "screen" && kind !== "mirror") { return cloneJsonValue(system); }
    if (Object.prototype.hasOwnProperty.call(system, "camera_mode")) {
      failFast("surface_system.camera_mode is removed; use a reflected camera frame plus screen.frame_ref");
    }
    if (system.camera && typeof system.camera === "object") {
      var directMirrorCamera = system.camera.mirror_of && typeof system.camera.mirror_of === "object";
      var directReflectMesh = String(system.camera.reflect_mirror_mesh_id || "").trim();
      if (directMirrorCamera || directReflectMesh) {
        failFast("surface_system.camera mirror path is removed; use a reflected source frame plus screen.frame_ref");
      }
    }
    var camera = resolveSurfaceCamera(system, viewerCamera);
    var world = resolveSurfaceWorld(system);
    var runtimeKind = kind === "mirror" ? "screen" : kind;
    return {
      kind: runtimeKind,
      scale: Array.isArray(system.scale) ? [Number(system.scale[0]) || 1.0, Number(system.scale[1]) || 1.0] : [1.0, 1.0],
      reflectivity: Math.max(0.0, Math.min(1.0, Number(system.reflectivity == null ? 1.0 : system.reflectivity) || 0.0)),
      world_ref: String(system.world_ref || ""),
      camera_ref: String(system.camera_ref || ""),
      frame_ref: String(system.frame_ref || ""),
      flip_x: kind === "mirror" || system.flip_x === true,
      flip_y: system.flip_y === true,
      reverse_facing: system.reverse_facing === true,
      camera: camera,
      world: {
        kind: world.kind,
        cube_size: world.cube_size,
        spin_axis: world.spin_axis,
        spin_angle: (Number(world.phase || 0.0) || 0.0) + ((Number(world.angular_velocity || 0.0) || 0.0) * Number(seconds || 0.0)),
        background: world.background,
        frame_color: world.frame_color,
      }
    };
  }

  function surfaceTextureKindCode(texture) {
    if (!texture || typeof texture !== "object") { return 0; }
    var raw = String(texture.kind || "").toLowerCase().trim();
    if (raw === "checker") { return 1; }
    if (raw === "stripes") { return 2; }
    if (raw === "dice") { return 3; }
    return 0;
  }

  function meshWorldCenter(mesh) {
    if (mesh && Array.isArray(mesh.transform) && mesh.transform.length === 16) {
      return [
        Number(mesh.transform[12]) || 0,
        Number(mesh.transform[13]) || 0,
        Number(mesh.transform[14]) || 0
      ];
    }
    return toVec3(mesh && mesh.center, [0, 0, 0]);
  }

  function buildSurfaceWorldObjects(meshSpecs, hostMeshId) {
    var objects = [];
    for (var i = 0; i < meshSpecs.length; i += 1) {
      var mesh = meshSpecs[i];
      if (!mesh) { continue; }
      if (String(mesh.id || "") === String(hostMeshId || "")) { continue; }
      if (mesh.visible === false) { continue; }
      if (mesh.kind === "cube") {
        var faceColor = toRgba(mesh.face_color, [0.86, 0.88, 0.94, 1.0]);
        var texture = mesh.texture && typeof mesh.texture === "object" ? mesh.texture : null;
        objects.push({
          center: meshWorldCenter(mesh),
          size: Math.max(0.1, Number(mesh.size || 1.0) || 1.0),
          texture_kind: surfaceTextureKindCode(texture),
          color_a: toRgba(texture && texture.color_a, faceColor),
          color_b: toRgba(texture && texture.color_b, faceColor),
          face_color: faceColor
        });
        continue;
      }
      if (mesh.kind === "random_hull" || mesh.kind === "convex_hull" || mesh.kind === "simplices") {
        var vertices = meshVerticesForOccluder(mesh);
        if (!Array.isArray(vertices) || !vertices.length) { continue; }
        var bounds = computeBounds(vertices);
        var center = meshCenterFromBounds(bounds);
        var spanX = Math.max(0.0, Number(bounds.max[0]) - Number(bounds.min[0]));
        var spanY = Math.max(0.0, Number(bounds.max[1]) - Number(bounds.min[1]));
        var spanZ = Math.max(0.0, Number(bounds.max[2]) - Number(bounds.min[2]));
        var proxySize = Math.max(0.1, spanX, spanY, spanZ);
        var proxyColor = toRgba(mesh.face_color || mesh.color, [0.86, 0.88, 0.94, 1.0]);
        objects.push({
          center: center,
          size: proxySize,
          texture_kind: 0,
          color_a: proxyColor,
          color_b: proxyColor,
          face_color: proxyColor
        });
      }
    }
    return objects;
  }

  function currentFrameViewportHeight() {
    try {
      var frame = global.document && global.document.querySelector(
        '.vf-frame[data-vf-frame-id="' + String(frameSpec.frame_id || config.frame_id || "") + '"]'
      );
      var host = frame ? (frame.querySelector(".vf-frame__body") || frame) : null;
      var height = Math.max(1, Number(host && host.clientHeight) || 0);
      if (height > 0) { return height; }
    } catch (err) {
      failFast("frame viewport height lookup failed: " + (err && err.message ? err.message : String(err)));
    }
    failFast("frame viewport height is unavailable for scene frame");
  }

  function buildSurfaceWorldRenderMesh(mesh, camera, lights) {
    var DisplayApi = global.VfDisplay && global.VfDisplay.__test;
    if (DisplayApi && typeof DisplayApi.buildSingleMesh === "function") {
      try {
        return DisplayApi.buildSingleMesh(mesh, camera || null, Array.isArray(lights) ? lights : []);
      } catch (err) {
        failFast("surface world render mesh build failed: " + (err && err.message ? err.message : String(err)));
      }
    }
    failFast("surface world render mesh builder is unavailable");
  }

  function cameraForward(camera) {
    if (camera && Array.isArray(camera.view_matrix) && camera.view_matrix.length === 16) {
      return normalize3(inverseRigidDirMat4(camera.view_matrix, [0, 0, -1]), [0, 0, -1]);
    }
    var pos = (camera && Array.isArray(camera.pos)) ? camera.pos : [0, 0, 5];
    var target = (camera && Array.isArray(camera.target)) ? camera.target : [0, 0, 0];
    return normalize3([
      Number(target[0] || 0) - Number(pos[0] || 0),
      Number(target[1] || 0) - Number(pos[1] || 0),
      Number(target[2] || 0) - Number(pos[2] || 0)
    ], [0, 0, -1]);
  }

  function impostorWorldRadius(camera, viewportHeightPx, point, pixelRadius) {
    var pxRadius = Number(pixelRadius || 0);
    if (!(pxRadius > 0)) { return 0; }
    var cam = camera || null;
    var viewportHeight = Number(viewportHeightPx || 0);
    if (!cam || !Array.isArray(cam.pos) || !Array.isArray(cam.target) || !(viewportHeight > 0)) {
      return pxRadius;
    }
    var worldPerPixel;
    if (Array.isArray(cam.view_matrix) && cam.view_matrix.length === 16 && Array.isArray(cam.projection_matrix) && cam.projection_matrix.length === 16) {
      var viewPoint = transformPointMat4(cam.view_matrix, Number(point[0] || 0), Number(point[1] || 0), Number(point[2] || 0));
      var depth = Math.max(1e-3, Math.abs(Number(viewPoint[2] || 0)));
      var projScaleY = Math.abs(Number(cam.projection_matrix[5] || 0));
      worldPerPixel = projScaleY > 1e-6
        ? ((2 * depth) / (viewportHeight * projScaleY))
        : pxRadius;
    } else {
      var forward = cameraForward(cam);
      var dx = Number(point[0] || 0) - Number(cam.pos[0] || 0);
      var dy = Number(point[1] || 0) - Number(cam.pos[1] || 0);
      var dz = Number(point[2] || 0) - Number(cam.pos[2] || 0);
      var depth = Math.max(1e-3, (dx * forward[0]) + (dy * forward[1]) + (dz * forward[2]));
      var fovDeg = Number(cam.fov || 34);
      var fovRad = Math.max(1e-4, fovDeg * Math.PI / 180);
      worldPerPixel = (2 * depth * Math.tan(fovRad * 0.5)) / viewportHeight;
    }
    return pxRadius * worldPerPixel;
  }

  function applyImpostorViewBias(camera, viewportHeightPx, point, pixelBias) {
    var biasPx = Number(pixelBias || 0);
    if (!(biasPx > 0)) { return [Number(point[0] || 0), Number(point[1] || 0), Number(point[2] || 0)]; }
    var cam = camera || null;
    if (!cam || !Array.isArray(cam.pos)) {
      return [Number(point[0] || 0), Number(point[1] || 0), Number(point[2] || 0)];
    }
    var worldBias = impostorWorldRadius(camera, viewportHeightPx, point, biasPx);
    if (!(worldBias > 0)) {
      return [Number(point[0] || 0), Number(point[1] || 0), Number(point[2] || 0)];
    }
    var vx = Number(cam.pos[0] || 0) - Number(point[0] || 0);
    var vy = Number(cam.pos[1] || 0) - Number(point[1] || 0);
    var vz = Number(cam.pos[2] || 0) - Number(point[2] || 0);
    var vlen = Math.sqrt((vx * vx) + (vy * vy) + (vz * vz));
    if (!(vlen > 1e-9)) {
      return [Number(point[0] || 0), Number(point[1] || 0), Number(point[2] || 0)];
    }
    return [
      Number(point[0] || 0) + ((vx / vlen) * worldBias),
      Number(point[1] || 0) + ((vy / vlen) * worldBias),
      Number(point[2] || 0) + ((vz / vlen) * worldBias)
    ];
  }

  function applyImpostorViewBiasToSegment(camera, viewportHeightPx, a, b, pixelBias) {
    var midpoint = [
      (Number(a[0] || 0) + Number(b[0] || 0)) * 0.5,
      (Number(a[1] || 0) + Number(b[1] || 0)) * 0.5,
      (Number(a[2] || 0) + Number(b[2] || 0)) * 0.5
    ];
    var biasedMidpoint = applyImpostorViewBias(camera, viewportHeightPx, midpoint, pixelBias);
    var dx = biasedMidpoint[0] - midpoint[0];
    var dy = biasedMidpoint[1] - midpoint[1];
    var dz = biasedMidpoint[2] - midpoint[2];
    return [
      [Number(a[0] || 0) + dx, Number(a[1] || 0) + dy, Number(a[2] || 0) + dz],
      [Number(b[0] || 0) + dx, Number(b[1] || 0) + dy, Number(b[2] || 0) + dz]
    ];
  }

  function norm3(x, y, z) {
    var len = Math.sqrt((x * x) + (y * y) + (z * z));
    if (!(len > 1e-9)) { return [0, 0, 1]; }
    return [x / len, y / len, z / len];
  }

  var sphereTemplateCache = Object.create(null);
  var cylinderTemplateCache = Object.create(null);

  function getSphereTemplate(latSeg, lonSeg) {
    var key = String(latSeg | 0) + "x" + String(lonSeg | 0);
    var cached = sphereTemplateCache[key];
    if (cached) { return cached; }
    var verts = [];
    var idx = [];
    for (var lat = 0; lat <= latSeg; lat += 1) {
      var v = lat / latSeg;
      var theta = v * Math.PI;
      var st = Math.sin(theta);
      var ct = Math.cos(theta);
      for (var lon = 0; lon <= lonSeg; lon += 1) {
        var u = lon / lonSeg;
        var phi = u * Math.PI * 2;
        verts.push(st * Math.cos(phi), st * Math.sin(phi), ct);
      }
    }
    var row = lonSeg + 1;
    for (var lat2 = 0; lat2 < latSeg; lat2 += 1) {
      for (var lon2 = 0; lon2 < lonSeg; lon2 += 1) {
        var a = (lat2 * row) + lon2;
        var b = a + row;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    cached = { verts: verts, idx: idx };
    sphereTemplateCache[key] = cached;
    return cached;
  }

  function getCylinderTemplate(seg) {
    var key = String(seg | 0);
    var cached = cylinderTemplateCache[key];
    if (cached) { return cached; }
    var ring = [];
    var idx = [];
    for (var i = 0; i < seg; i += 1) {
      var t = (i / seg) * Math.PI * 2;
      ring.push(Math.cos(t), Math.sin(t));
    }
    for (var j = 0; j < seg; j += 1) {
      var a = j * 2;
      var b = ((j + 1) % seg) * 2;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    cached = { ring: ring, idx: idx };
    cylinderTemplateCache[key] = cached;
    return cached;
  }

  function pushWorldTriangle(triangles, a, b, c, color) {
    triangles.push({
      a: [Number(a[0]) || 0, Number(a[1]) || 0, Number(a[2]) || 0],
      b: [Number(b[0]) || 0, Number(b[1]) || 0, Number(b[2]) || 0],
      c: [Number(c[0]) || 0, Number(c[1]) || 0, Number(c[2]) || 0],
      color: toRgba(color, [0.82, 0.84, 0.90, 1.0])
    });
  }

  function appendSphereTriangles(triangles, center, radius, color, latSeg, lonSeg) {
    radius = Number(radius);
    if (!(radius > 0)) { return; }
    var template = getSphereTemplate(latSeg || 12, lonSeg || 18);
    var verts = [];
    for (var i = 0; i < template.verts.length; i += 3) {
      var nx = template.verts[i];
      var ny = template.verts[i + 1];
      var nz = template.verts[i + 2];
      verts.push([
        center[0] + (radius * nx),
        center[1] + (radius * ny),
        center[2] + (radius * nz)
      ]);
    }
    for (var k = 0; k + 2 < template.idx.length; k += 3) {
      pushWorldTriangle(triangles, verts[template.idx[k]], verts[template.idx[k + 1]], verts[template.idx[k + 2]], color);
    }
  }

  function appendCylinderTriangles(triangles, a, b, radius, color, seg) {
    radius = Number(radius);
    if (!(radius > 0)) { return; }
    var template = getCylinderTemplate(seg || 20);
    var dir = norm3(Number(b[0]) - Number(a[0]), Number(b[1]) - Number(a[1]), Number(b[2]) - Number(a[2]));
    var ref = Math.abs(dir[1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
    var u = normalize3(cross3(dir, ref), [1, 0, 0]);
    var v = cross3(dir, u);
    var verts = [];
    for (var i = 0; i < template.ring.length; i += 2) {
      var ct = template.ring[i];
      var st = template.ring[i + 1];
      var nx = (u[0] * ct) + (v[0] * st);
      var ny = (u[1] * ct) + (v[1] * st);
      var nz = (u[2] * ct) + (v[2] * st);
      verts.push([
        Number(a[0]) + (radius * nx),
        Number(a[1]) + (radius * ny),
        Number(a[2]) + (radius * nz)
      ]);
      verts.push([
        Number(b[0]) + (radius * nx),
        Number(b[1]) + (radius * ny),
        Number(b[2]) + (radius * nz)
      ]);
    }
    for (var k = 0; k + 2 < template.idx.length; k += 3) {
      pushWorldTriangle(triangles, verts[template.idx[k]], verts[template.idx[k + 1]], verts[template.idx[k + 2]], color);
    }
  }

  function meshVec3At(verts, index) {
    var base = (Number(index) | 0) * 10;
    return [
      Number(verts[base] || 0),
      Number(verts[base + 1] || 0),
      Number(verts[base + 2] || 0)
    ];
  }

  function meshColorAt(verts, index) {
    var base = (Number(index) | 0) * 10;
    return [
      Number(verts[base + 6] == null ? 0.82 : verts[base + 6]),
      Number(verts[base + 7] == null ? 0.84 : verts[base + 7]),
      Number(verts[base + 8] == null ? 0.90 : verts[base + 8]),
      Number(verts[base + 9] == null ? 1.0 : verts[base + 9])
    ];
  }

  function fieldMeshRenderMode(mesh) {
    var mode = String((mesh && mesh.render_mode) || "proxy_geometry").toLowerCase();
    return mode === "marker_impostor" ? "marker_impostor" : "proxy_geometry";
  }

  function fieldMeshMarkerSpace(mesh) {
    var mode = fieldMeshRenderMode(mesh);
    var space = String((mesh && mesh.marker_space) || (mode === "marker_impostor" ? "pixel" : "world")).toLowerCase();
    return space === "pixel" ? "pixel" : "world";
  }

  function overlayRenderMode(mesh, prefix) {
    var key = String(prefix || "") + "_render_mode";
    var mode = String((mesh && mesh[key]) || "proxy_geometry").toLowerCase();
    return mode === "marker_impostor" ? "marker_impostor" : "proxy_geometry";
  }

  function overlayMarkerSpace(mesh, prefix) {
    var mode = overlayRenderMode(mesh, prefix);
    var key = String(prefix || "") + "_marker_space";
    var fallback = mode === "marker_impostor" ? "pixel" : "world";
    var space = String((mesh && mesh[key]) || fallback).toLowerCase();
    return space === "pixel" ? "pixel" : "world";
  }

  function overlayDepthWrite(mesh, prefix) {
    var key = String(prefix || "") + "_depth_write";
    if (mesh && mesh[key] != null) { return mesh[key] === true; }
    return overlayRenderMode(mesh, prefix) !== "marker_impostor";
  }

  function appendTriangleListWorldTriangles(triangles, mesh, model) {
    var verts = mesh.vertices;
    var inds = mesh.indices;
    if ((!Array.isArray(verts) && !(verts instanceof Float32Array)) || !verts.length) { return; }
    if ((!Array.isArray(inds) && !(inds instanceof Uint32Array)) || !inds.length) { return; }
    for (var k = 0; k + 2 < inds.length; k += 3) {
      var ia = Number(inds[k]) | 0;
      var ib = Number(inds[k + 1]) | 0;
      var ic = Number(inds[k + 2]) | 0;
      var ba = ia * 10;
      var bb = ib * 10;
      var bc = ic * 10;
      pushWorldTriangle(
        triangles,
        transformPointMat4(model, Number(verts[ba] || 0.0), Number(verts[ba + 1] || 0.0), Number(verts[ba + 2] || 0.0)),
        transformPointMat4(model, Number(verts[bb] || 0.0), Number(verts[bb + 1] || 0.0), Number(verts[bb + 2] || 0.0)),
        transformPointMat4(model, Number(verts[bc] || 0.0), Number(verts[bc + 1] || 0.0), Number(verts[bc + 2] || 0.0)),
        triangleColorFromMesh(mesh, ia, ib, ic)
      );
    }
  }

  function appendPointImpostorWorldTriangles(triangles, mesh, camera, viewportHeight) {
    var verts = mesh.vertices || [];
    var inds = mesh.indices || [];
    var vertexRadius = Number(mesh.vertex_size || 0);
    if (!(vertexRadius > 0) || !inds.length) { return; }
    var scales = Array.isArray(mesh.vertex_scale) ? mesh.vertex_scale : null;
    var globalScale = scales ? null : Number(mesh.vertex_scale == null ? 1.0 : mesh.vertex_scale);
    var markerSpace = fieldMeshMarkerSpace(mesh);
    for (var i = 0; i < inds.length; i += 1) {
      var vi = Number(inds[i]);
      var pointCenter = meshVec3At(verts, vi);
      var pointScale = scales ? Number(scales[i] == null ? 1.0 : scales[i]) : globalScale;
      if (!(pointScale > 0)) { pointScale = 1.0; }
      var biasedCenter = applyImpostorViewBias(
        camera,
        viewportHeight,
        pointCenter,
        Math.max(0.75, Number(vertexRadius * pointScale || 0) * 0.35)
      );
      appendSphereTriangles(
        triangles,
        biasedCenter,
        markerSpace === "pixel"
          ? impostorWorldRadius(camera, viewportHeight, pointCenter, vertexRadius * pointScale)
          : (vertexRadius * pointScale),
        meshColorAt(verts, vi),
        12,
        18
      );
    }
  }

  function appendLineImpostorWorldTriangles(triangles, mesh, camera, viewportHeight) {
    var verts = mesh.vertices || [];
    var inds = mesh.indices || [];
    var edgeRadius = Number(mesh.edge_width || 0);
    var vertexWidths = Array.isArray(mesh.vertex_widths) ? mesh.vertex_widths : null;
    var hasVertexWidths = !!(vertexWidths && vertexWidths.length);
    if (!(edgeRadius > 0) && !hasVertexWidths) { return; }
    if (inds.length < 2) { return; }
    var edgeCaps = mesh.edge_caps === true;
    var markerSpace = fieldMeshMarkerSpace(mesh);
    for (var i = 0; i + 1 < inds.length; i += 2) {
      var aIdx = Number(inds[i]);
      var bIdx = Number(inds[i + 1]);
      var pa = meshVec3At(verts, aIdx);
      var pb = meshVec3At(verts, bIdx);
      var col = meshColorAt(verts, aIdx);
      var aWidth = hasVertexWidths ? Number(vertexWidths[aIdx] || 0) : edgeRadius;
      var bWidth = hasVertexWidths ? Number(vertexWidths[bIdx] || 0) : edgeRadius;
      var edgeRadiusWorld = markerSpace === "pixel"
        ? Math.max(
            impostorWorldRadius(camera, viewportHeight, pa, aWidth),
            impostorWorldRadius(camera, viewportHeight, pb, bWidth)
          )
        : Math.max(aWidth, bWidth);
      var biasedSegment = applyImpostorViewBiasToSegment(
        camera,
        viewportHeight,
        pa,
        pb,
        Math.max(0.75, edgeRadiusWorld * 0.4)
      );
      pa = biasedSegment[0];
      pb = biasedSegment[1];
      appendCylinderTriangles(triangles, pa, pb, edgeRadiusWorld, col, 20);
      if (edgeCaps) {
        appendSphereTriangles(triangles, pa, edgeRadiusWorld, col, 10, 14);
        appendSphereTriangles(triangles, pb, edgeRadiusWorld, col, 10, 14);
      }
    }
  }

  function triangleColorFromMesh(mesh, ia, ib, ic) {
    var verts = mesh && mesh.vertices;
    if (!Array.isArray(verts) && !(verts instanceof Float32Array)) {
      return [0.82, 0.84, 0.90, 1.0];
    }
    function colorAt(index) {
      var base = (Number(index) | 0) * 10;
      return [
        Number(verts[base + 6] == null ? 0.82 : verts[base + 6]),
        Number(verts[base + 7] == null ? 0.84 : verts[base + 7]),
        Number(verts[base + 8] == null ? 0.90 : verts[base + 8]),
        Number(verts[base + 9] == null ? 1.0 : verts[base + 9])
      ];
    }
    var ca = colorAt(ia);
    var cb = colorAt(ib);
    var cc = colorAt(ic);
    return [
      (ca[0] + cb[0] + cc[0]) / 3.0,
      (ca[1] + cb[1] + cc[1]) / 3.0,
      (ca[2] + cb[2] + cc[2]) / 3.0,
      (ca[3] + cb[3] + cc[3]) / 3.0
    ];
  }

  function buildSurfaceWorldTriangles(meshPayloads, hostMeshId, surfaceCamera, lights) {
    var triangles = [];
    var items = Array.isArray(meshPayloads) ? meshPayloads : [];
    var camera = surfaceCamera && typeof surfaceCamera === "object" ? surfaceCamera : null;
    for (var i = 0; i < items.length; i += 1) {
      var sourceMesh = items[i];
      if (!sourceMesh || String(sourceMesh.id || "") === String(hostMeshId || "")) { continue; }
      if (sourceMesh.transparent === true) { continue; }
      var mesh = buildSurfaceWorldRenderMesh(sourceMesh, camera, lights);
      if (!mesh) { continue; }
      var model = matrixForMesh(mesh);
      var topology = String(mesh.topology || "");
      if (topology === "triangle-list") {
        appendTriangleListWorldTriangles(triangles, mesh, model);
      }
    }
    return triangles;
  }

  function resolveFramePosition(framePos) {
    if (frameCount <= 1) { return 0.0; }
    var step = Math.max(0.0, Number(framePos) || 0.0);
    if (boundary === "stop") {
      return Math.min(step, frameCount - 1);
    }
    if (boundary === "reset") {
      return step >= frameCount ? 0.0 : step;
    }
    if (boundary === "mirror") {
      var span = frameCount - 1;
      var period = span * 2;
      if (period <= 0) { return 0.0; }
      var mirrored = step % period;
      if (mirrored < 0) { mirrored += period; }
      if (mirrored > span) { mirrored = period - mirrored; }
      return mirrored;
    }
    var repeated = step % frameCount;
    return repeated < 0 ? repeated + frameCount : repeated;
  }

  function animationFramePosition(seconds) {
    return Math.max(0.0, Number(seconds || 0) * fps);
  }

  function resolveTrackSample(framePos, count) {
    if (!(count > 0)) { return { index0: 0, index1: 0, mix: 0.0 }; }
    if (count <= 1) { return { index0: 0, index1: 0, mix: 0.0 }; }
    var resolved = resolveFramePosition(framePos);
    var scaled;
    var index0;
    var mix;
    if (boundary === "repeat" || boundary === "reset") {
      scaled = (resolved / Math.max(1e-6, frameCount)) * count;
      index0 = Math.floor(scaled);
      mix = scaled - index0;
      index0 = ((index0 % count) + count) % count;
      return { index0: index0, index1: (index0 + 1) % count, mix: mix };
    }
    scaled = (resolved / Math.max(1e-6, frameCount - 1)) * (count - 1);
    if (scaled <= 0.0) { return { index0: 0, index1: 0, mix: 0.0 }; }
    if (scaled >= (count - 1)) { return { index0: count - 1, index1: count - 1, mix: 0.0 }; }
    index0 = Math.floor(scaled);
    mix = scaled - index0;
    return { index0: index0, index1: index0 + 1, mix: mix };
  }

  function lerpNumber(a, b, mix) {
    return Number(a) + ((Number(b) - Number(a)) * Number(mix));
  }

  function sampleVec3Track(track, framePos, fallback) {
    if (!Array.isArray(track) || !track.length) { return fallback.slice(); }
    var sample = resolveTrackSample(framePos, track.length);
    var a = toVec3(track[sample.index0], fallback);
    var b = toVec3(track[sample.index1], fallback);
    return [
      lerpNumber(a[0], b[0], sample.mix),
      lerpNumber(a[1], b[1], sample.mix),
      lerpNumber(a[2], b[2], sample.mix)
    ];
  }

  function sampleRgbaTrack(track, framePos, fallback) {
    if (!Array.isArray(track) || !track.length) { return fallback.slice(); }
    var sample = resolveTrackSample(framePos, track.length);
    var a = toRgba(track[sample.index0], fallback);
    var b = toRgba(track[sample.index1], fallback);
    return [
      lerpNumber(a[0], b[0], sample.mix),
      lerpNumber(a[1], b[1], sample.mix),
      lerpNumber(a[2], b[2], sample.mix),
      lerpNumber(a[3], b[3], sample.mix)
    ];
  }

  function sampleNumberTrack(track, framePos, fallback) {
    if (!Array.isArray(track) || !track.length) { return Number(fallback); }
    var sample = resolveTrackSample(framePos, track.length);
    return lerpNumber(track[sample.index0], track[sample.index1], sample.mix);
  }

  function sampleStepTrackValue(track, framePos, fallback) {
    if (!Array.isArray(track) || !track.length) { return fallback; }
    var sample = resolveTrackSample(framePos, track.length);
    return track[sample.index0];
  }

  function sampleObjectTrack(track, framePos, fallback) {
    if (isEncodedAxisTaggedValue(track)) {
      var idx = encodedAxisTaggedIdx(track);
      if (idx && idx.charAt(idx.length - 1) === "t") {
        var trackData = encodedAxisTaggedData(track);
        var count = trackLengthForAxis(trackData, idx.length - 1);
        if (count > 0) {
          var sample = resolveTrackSample(framePos, count);
          return sliceAxisAt(trackData, idx.length - 1, sample.index0);
        }
      }
      return fallback;
    }
    return sampleStepTrackValue(track, framePos, fallback);
  }

  function toMatrix4(value, fallback) {
    if (Array.isArray(value) && value.length === 16) {
      return value.map(function (item) { return Number(item); });
    }
    if (Array.isArray(value) && value.length === 4) {
      var rows = [];
      for (var rowIndex = 0; rowIndex < 4; rowIndex += 1) {
        if (!Array.isArray(value[rowIndex]) || value[rowIndex].length !== 4) {
          rows = null;
          break;
        }
        rows.push([
          Number(value[rowIndex][0]),
          Number(value[rowIndex][1]),
          Number(value[rowIndex][2]),
          Number(value[rowIndex][3])
        ]);
      }
      if (rows) {
        return [
          rows[0][0], rows[1][0], rows[2][0], rows[3][0],
          rows[0][1], rows[1][1], rows[2][1], rows[3][1],
          rows[0][2], rows[1][2], rows[2][2], rows[3][2],
          rows[0][3], rows[1][3], rows[2][3], rows[3][3]
        ];
      }
    }
    return Array.isArray(fallback) ? fallback.slice() : null;
  }

  function sampleMatrixTrack(track, framePos, fallback) {
    var identity = Array.isArray(fallback) ? fallback : identityMat4();
    if (isEncodedAxisTaggedValue(track)) {
      var idx = encodedAxisTaggedIdx(track);
      if (idx && idx.charAt(idx.length - 1) === "t") {
        var trackData = encodedAxisTaggedData(track);
        var count = trackLengthForAxis(trackData, idx.length - 1);
        if (count > 0) {
          var sample = resolveTrackSample(framePos, count);
          return toMatrix4(sliceAxisAt(trackData, idx.length - 1, sample.index0), identity);
        }
      }
      return identity.slice();
    }
    return toMatrix4(sampleStepTrackValue(track, framePos, null), identity);
  }

  function entityTrack(light, name) {
    var tracks = light && light.tracks;
    if (!tracks || typeof tracks !== "object") { return null; }
    var propName = entityPropName(light, name);
    var track = tracks[propName];
    if ((track == null || (!Array.isArray(track) && !isEncodedAxisTaggedValue(track))) && propName !== name) {
      track = tracks[name];
    }
    if (Array.isArray(track) && track.length) { return track; }
    if (isEncodedAxisTaggedValue(track)) { return track; }
    return null;
  }

  function resolveTrackedVec3(light, name, framePos, fallback) {
    return sampleVec3Track(entityTrack(light, name), framePos, fallback);
  }

  function resolveTrackedRgba(light, name, framePos, fallback) {
    return sampleRgbaTrack(entityTrack(light, name), framePos, fallback);
  }

  function resolveTrackedNumber(light, name, framePos, fallback) {
    return sampleNumberTrack(entityTrack(light, name), framePos, fallback);
  }

  function resolveTrackedMatrix4(entity, name, framePos, fallback) {
    return sampleMatrixTrack(entityTrack(entity, name), framePos, fallback);
  }

  function resolveTrackedObject(entity, name, framePos, fallback) {
    return sampleObjectTrack(entityTrack(entity, name), framePos, fallback);
  }

  function lightEmissionSolidAngle(kind, outerConeDeg) {
    if (String(kind || "point") === "spot") {
      var outerRad = Math.max(0.0, Number(outerConeDeg || 0.0)) * Math.PI / 180.0;
      return Math.max(1e-6, 2.0 * Math.PI * (1.0 - Math.cos(outerRad)));
    }
    return 4.0 * Math.PI;
  }

  function resolveLightIntensity(light, framePos, kind, outerConeDeg) {
    var explicitIntensityTrack = !!entityTrack(light, "intensity");
    var explicitPowerTrack = !!entityTrack(light, "power");
    var intensityValue = entityProp(light, "intensity", undefined);
    var powerValue = entityProp(light, "power", undefined);
    var explicitIntensity = intensityValue != null;
    var explicitPower = powerValue != null && Number(powerValue) > 0.0;
    if (explicitIntensityTrack || explicitIntensity) {
      return Math.max(0.0, resolveTrackedNumber(light, "intensity", framePos, Number(explicitIntensity ? intensityValue : 24.0)));
    }
    if (explicitPowerTrack || explicitPower) {
      var power = Math.max(0.0, resolveTrackedNumber(light, "power", framePos, Number(explicitPower ? powerValue : 0.0)));
      return power / lightEmissionSolidAngle(kind, outerConeDeg);
    }
    return Math.max(0.0, Number(intensityValue == null ? 24.0 : intensityValue));
  }

  function resolveLightTarget(light, framePos) {
    return resolveTrackedVec3(light, "target", framePos, toVec3(entityProp(light, "target", [0, 0, 0]), [0, 0, 0]));
  }

  function currentLightPosition(light, seconds, framePos, target) {
    if (entityTrack(light, "pos")) {
      return resolveTrackedVec3(light, "pos", framePos, [0, 0, 0]);
    }
    var directPos = entityProp(light, "pos", undefined);
    if (Array.isArray(directPos) && directPos.length === 3) {
      return toVec3(directPos, [0, 0, 0]);
    }
    target = Array.isArray(target) ? target : toVec3(light.target, [0, 0, 0]);
    var radius = Number(entityProp(light, "radius", 4.5) || 4.5);
    var height = Number(entityProp(light, "height", 3.6) || 3.6);
    var theta = Number(entityProp(light, "theta", 0.0) || 0.0);
    var angularVelocity = Number(entityProp(light, "angular_velocity", 0.0) || 0.0);
    var motion = String(entityProp(light, "motion", "orbit") || "orbit");
    var angle;
    if (motion === "oscillate") {
      var thetaAmplitude = Math.max(0.0, Number(entityProp(light, "theta_amplitude", 0.0) || 0.0));
      angle = theta + (Math.sin(angularVelocity * seconds) * thetaAmplitude);
    } else {
      angle = theta + (angularVelocity * seconds);
    }
    return [
      target[0] + (Math.cos(angle) * radius),
      target[1] + (Math.sin(angle) * radius),
      target[2] + height
    ];
  }

  function normalizeLight(light, seconds) {
    var resolved = light || {};
    var framePos = animationFramePosition(seconds);
    var target = resolveLightTarget(resolved, framePos);
    var pos = currentLightPosition(resolved, seconds, framePos, target);
    var kind = String(entityProp(resolved, "kind", "point") || "point");
    var defaultShowMarker = kind === "projected" ? false : true;
    var outerConeDefault = entityProp(resolved, "outer_cone_deg", 22.0);
    var outerConeDeg = resolveTrackedNumber(resolved, "outer_cone_deg", framePos, Number(outerConeDefault == null ? 22.0 : outerConeDefault));
    return {
      id: String(entityProp(resolved, "id", "")),
      pos: pos,
      target: target,
      motion: String(entityProp(resolved, "motion", Array.isArray(entityProp(resolved, "pos", undefined)) ? "fixed" : "orbit") || "orbit"),
      model: String(entityProp(resolved, "model", "blinn_phong") || "blinn_phong"),
      color: resolveTrackedRgba(resolved, "color", framePos, toRgba(entityProp(resolved, "color", [1.0, 0.95, 0.84, 1.0]), [1.0, 0.95, 0.84, 1.0])),
      kind: kind,
      direction: entityTrack(resolved, "direction")
        ? resolveTrackedVec3(resolved, "direction", framePos, [0, 0, -1])
        : (Array.isArray(entityProp(resolved, "direction", undefined)) ? toVec3(entityProp(resolved, "direction", undefined), [0, 0, -1]) : undefined),
      intensity: resolveLightIntensity(resolved, framePos, kind, outerConeDeg),
      inner_cone_deg: resolveTrackedNumber(resolved, "inner_cone_deg", framePos, Number(entityProp(resolved, "inner_cone_deg", 14.0) == null ? 14.0 : entityProp(resolved, "inner_cone_deg", 14.0))),
      outer_cone_deg: outerConeDeg,
      theta_amplitude: Math.max(0.0, Number(entityProp(resolved, "theta_amplitude", 0.0) || 0.0)),
      range: Math.max(0.0, resolveTrackedNumber(resolved, "range", framePos, Number(entityProp(resolved, "range", 0.0) == null ? 0.0 : entityProp(resolved, "range", 0.0)))),
      casts_shadow: entityProp(resolved, "casts_shadow", true) !== false,
      show_marker: entityProp(resolved, "show_marker", defaultShowMarker) !== false,
      source_radius: Math.max(0.0, resolveTrackedNumber(resolved, "source_radius", framePos, Number(entityProp(resolved, "source_radius", 0.0) || 0.0))),
      spread: Math.max(0.0, resolveTrackedNumber(resolved, "spread", framePos, Number(entityProp(resolved, "spread", 1.0) == null ? 1.0 : entityProp(resolved, "spread", 1.0)))),
      power: Math.max(0.0, resolveTrackedNumber(resolved, "power", framePos, Number(entityProp(resolved, "power", 0.0) || 0.0))),
      aperture_mesh_id: String(entityProp(resolved, "aperture_mesh_id", "") || ""),
      reflect_of_light_id: String(entityProp(resolved, "reflect_of_light_id", "") || ""),
      reflect_mirror_mesh_id: String(entityProp(resolved, "reflect_mirror_mesh_id", "") || ""),
      clip_epsilon_ratio: Math.max(0.0, resolveTrackedNumber(resolved, "clip_epsilon_ratio", framePos, Number(entityProp(resolved, "clip_epsilon_ratio", 1e-5) == null ? 1e-5 : entityProp(resolved, "clip_epsilon_ratio", 1e-5))))
    };
  }

  function toVec2(value, fallback) {
    if (!Array.isArray(value) || value.length !== 2) { return fallback.slice(); }
    return [Number(value[0]), Number(value[1])];
  }

  function pushVertex(out, p, normal, color) {
    out.push(
      Number(p[0]), Number(p[1]), Number(p[2]),
      Number(normal[0]), Number(normal[1]), Number(normal[2]),
      Number(color[0]), Number(color[1]), Number(color[2]), Number(color[3])
    );
  }

  function faceNormal(a, b, c) {
    var ux = b[0] - a[0];
    var uy = b[1] - a[1];
    var uz = b[2] - a[2];
    var vx = c[0] - a[0];
    var vy = c[1] - a[1];
    var vz = c[2] - a[2];
    var nx = (uy * vz) - (uz * vy);
    var ny = (uz * vx) - (ux * vz);
    var nz = (ux * vy) - (uy * vx);
    var len = Math.sqrt((nx * nx) + (ny * ny) + (nz * nz)) || 1.0;
    return [nx / len, ny / len, nz / len];
  }

  function normalize3(v, fallback) {
    var x = Number(v[0] || 0.0);
    var y = Number(v[1] || 0.0);
    var z = Number(v[2] || 0.0);
    var len = Math.sqrt((x * x) + (y * y) + (z * z));
    if (!(len > 1e-9)) { return fallback.slice(); }
    return [x / len, y / len, z / len];
  }

  function cross3(a, b) {
    return [
      (a[1] * b[2]) - (a[2] * b[1]),
      (a[2] * b[0]) - (a[0] * b[2]),
      (a[0] * b[1]) - (a[1] * b[0])
    ];
  }

  function dot3(a, b) {
    return (a[0] * b[0]) + (a[1] * b[1]) + (a[2] * b[2]);
  }

  function makeCubeLocalVertices(size) {
    var half = Number(size) * 0.5;
    return [
      [-half, -half, -half],
      [ half, -half, -half],
      [ half,  half, -half],
      [-half,  half, -half],
      [-half, -half,  half],
      [ half, -half,  half],
      [ half,  half,  half],
      [-half,  half,  half]
    ];
  }

  function makeCubeVertices(center, size) {
    var local = makeCubeLocalVertices(size);
    center = toVec3(center, [0, 0, 0]);
    return local.map(function (p) {
      return [center[0] + p[0], center[1] + p[1], center[2] + p[2]];
    });
  }

  function transformLocalVertices(vertices, center, rotation) {
    center = toVec3(center, [0, 0, 0]);
    rotation = toVec3(rotation, [0, 0, 0]);
    var Mm = global.VfGeomMath;
    if (Mm && typeof Mm.mat4ModelTRS === "function") {
      var m = Mm.mat4ModelTRS(center, rotation, [1, 1, 1]);
      return vertices.map(function (p) {
        return transformPointMat4(m, Number(p[0]), Number(p[1]), Number(p[2]));
      });
    }
    return vertices.map(function (p) {
      return [center[0] + Number(p[0]), center[1] + Number(p[1]), center[2] + Number(p[2])];
    });
  }

  function transformPointMat4(m, x, y, z) {
    return [
      m[0] * x + m[4] * y + m[8]  * z + m[12],
      m[1] * x + m[5] * y + m[9]  * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14]
    ];
  }

  function transformVerticesByMatrix(vertices, matrix) {
    var m = toMatrix4(matrix, null);
    if (!m) { return vertices.slice(); }
    return vertices.map(function (p) {
      return transformPointMat4(m, Number(p[0]), Number(p[1]), Number(p[2]));
    });
  }

  function makeRng(seed) {
    var state = (Number(seed) || 0) >>> 0;
    return function () {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function computeBounds(vertices) {
    var min = [Infinity, Infinity, Infinity];
    var max = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < vertices.length; i += 1) {
      var p = vertices[i];
      if (p[0] < min[0]) { min[0] = p[0]; }
      if (p[1] < min[1]) { min[1] = p[1]; }
      if (p[2] < min[2]) { min[2] = p[2]; }
      if (p[0] > max[0]) { max[0] = p[0]; }
      if (p[1] > max[1]) { max[1] = p[1]; }
      if (p[2] > max[2]) { max[2] = p[2]; }
    }
    return { min: min, max: max };
  }

  function computeCentroid(vertices) {
    var out = [0.0, 0.0, 0.0];
    if (!vertices.length) { return out; }
    for (var i = 0; i < vertices.length; i += 1) {
      out[0] += Number(vertices[i][0]);
      out[1] += Number(vertices[i][1]);
      out[2] += Number(vertices[i][2]);
    }
    out[0] /= vertices.length;
    out[1] /= vertices.length;
    out[2] /= vertices.length;
    return out;
  }

  function meshCenterFromBounds(bounds) {
    return [
      0.5 * (Number(bounds.min[0]) + Number(bounds.max[0])),
      0.5 * (Number(bounds.min[1]) + Number(bounds.max[1])),
      0.5 * (Number(bounds.min[2]) + Number(bounds.max[2]))
    ];
  }

  function matrixForMesh(mesh) {
    if (mesh && Array.isArray(mesh.transform) && mesh.transform.length === 16) {
      return mesh.transform.slice();
    }
    var center = toVec3(mesh && mesh.center, [0, 0, 0]);
    var rotation = toVec3(mesh && mesh.rotation, [0, 0, 0]);
    var Mm = global.VfGeomMath;
    if (Mm && typeof Mm.mat4ModelTRS === "function") {
      return Array.prototype.slice.call(Mm.mat4ModelTRS(center, rotation, [1, 1, 1]));
    }
    return [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      center[0], center[1], center[2], 1
    ];
  }

  function transformDirMat4(m, dir) {
    var x = Number(dir[0]) || 0.0;
    var y = Number(dir[1]) || 0.0;
    var z = Number(dir[2]) || 0.0;
    return [
      (Number(m[0]) || 0.0) * x + (Number(m[4]) || 0.0) * y + (Number(m[8]) || 0.0) * z,
      (Number(m[1]) || 0.0) * x + (Number(m[5]) || 0.0) * y + (Number(m[9]) || 0.0) * z,
      (Number(m[2]) || 0.0) * x + (Number(m[6]) || 0.0) * y + (Number(m[10]) || 0.0) * z
    ];
  }

  function inverseRigidDirMat4(m, dir) {
    var x = Number(dir[0]) || 0.0;
    var y = Number(dir[1]) || 0.0;
    var z = Number(dir[2]) || 0.0;
    return [
      ((Number(m[0]) || 0.0) * x) + ((Number(m[1]) || 0.0) * y) + ((Number(m[2]) || 0.0) * z),
      ((Number(m[4]) || 0.0) * x) + ((Number(m[5]) || 0.0) * y) + ((Number(m[6]) || 0.0) * z),
      ((Number(m[8]) || 0.0) * x) + ((Number(m[9]) || 0.0) * y) + ((Number(m[10]) || 0.0) * z)
    ];
  }

  function planeReflectionMat3(normal) {
    var n = normalize3(normal, [0, 0, 1]);
    var nx = Number(n[0]) || 0.0;
    var ny = Number(n[1]) || 0.0;
    var nz = Number(n[2]) || 0.0;
    return [
      1.0 - (2.0 * nx * nx), -2.0 * nx * ny, -2.0 * nx * nz,
      -2.0 * ny * nx, 1.0 - (2.0 * ny * ny), -2.0 * ny * nz,
      -2.0 * nz * nx, -2.0 * nz * ny, 1.0 - (2.0 * nz * nz)
    ];
  }

  function transformDirMat3(m, dir) {
    var x = Number(dir[0]) || 0.0;
    var y = Number(dir[1]) || 0.0;
    var z = Number(dir[2]) || 0.0;
    return [
      (Number(m[0]) || 0.0) * x + (Number(m[1]) || 0.0) * y + (Number(m[2]) || 0.0) * z,
      (Number(m[3]) || 0.0) * x + (Number(m[4]) || 0.0) * y + (Number(m[5]) || 0.0) * z,
      (Number(m[6]) || 0.0) * x + (Number(m[7]) || 0.0) * y + (Number(m[8]) || 0.0) * z
    ];
  }

  function reflectPointAcrossPlane(point, planePoint, planeNormal) {
    var reflection = planeReflectionMat3(planeNormal);
    var vx = Number(point[0]) - Number(planePoint[0]);
    var vy = Number(point[1]) - Number(planePoint[1]);
    var vz = Number(point[2]) - Number(planePoint[2]);
    var reflected = transformDirMat3(reflection, [vx, vy, vz]);
    return [
      Number(planePoint[0]) + reflected[0],
      Number(planePoint[1]) + reflected[1],
      Number(planePoint[2]) + reflected[2]
    ];
  }

  function reflectDirAcrossPlane(dir, planeNormal) {
    return transformDirMat3(planeReflectionMat3(planeNormal), dir);
  }

  function buildMirrorSurfaceCamera(viewerCamera, hostMesh) {
    var model = matrixForMesh(hostMesh);
    var planePoint = transformPointMat4(model, 0.0, 0.0, 0.0);
    var planeNormal = normalize3(transformDirMat4(model, [0, 0, 1]), [0, 0, 1]);
    var viewPos = toVec3(viewerCamera && viewerCamera.pos, [4.0, -5.0, 3.5]);
    var viewTarget = toVec3(viewerCamera && viewerCamera.target, [0.0, 0.0, 0.0]);
    var viewUp = normalize3(toVec3(viewerCamera && viewerCamera.up, [0.0, 0.0, 1.0]), [0.0, 0.0, 1.0]);
    var reflectedPos = reflectPointAcrossPlane(viewPos, planePoint, planeNormal);
    var reflectedTarget = reflectPointAcrossPlane(viewTarget, planePoint, planeNormal);
    var reflectedUp = normalize3(reflectDirAcrossPlane(viewUp, planeNormal), viewUp);
    return {
      pos: reflectedPos,
      target: reflectedTarget,
      up: reflectedUp,
      fov: Number(viewerCamera && viewerCamera.fov || 34.0) || 34.0
    };
  }

  function buildMirrorEyeLockedCamera(viewerCamera, hostMesh, baseCamera) {
    var geomUtil = global.VfGeomWgpuUtil;
    if (!geomUtil || typeof geomUtil.derivePlanarSurfaceWorldFrame !== "function" || !global.VfGeomMath) {
      failFast("mirror eye-locked camera requires canonical planar frame adapter");
    }
    var frame = geomUtil.derivePlanarSurfaceWorldFrame({ mesh: hostMesh }, 0, global.VfGeomMath);
    if (!frame || !Array.isArray(frame.point) || !Array.isArray(frame.normal)) {
      failFast("mirror eye-locked camera canonical planar frame is invalid");
    }
    var minU = Number(frame.minU || 0.0);
    var maxU = Number(frame.maxU == null ? (minU + Number(frame.spanU || 0.0)) : frame.maxU);
    var minV = Number(frame.minV || 0.0);
    var maxV = Number(frame.maxV == null ? (minV + Number(frame.spanV || 0.0)) : frame.maxV);
    var planePoint = [
      Number(frame.point[0] || 0.0) + (Number(frame.uAxis[0] || 0.0) * ((minU + maxU) * 0.5)) + (Number(frame.vAxis[0] || 0.0) * ((minV + maxV) * 0.5)),
      Number(frame.point[1] || 0.0) + (Number(frame.uAxis[1] || 0.0) * ((minU + maxU) * 0.5)) + (Number(frame.vAxis[1] || 0.0) * ((minV + maxV) * 0.5)),
      Number(frame.point[2] || 0.0) + (Number(frame.uAxis[2] || 0.0) * ((minU + maxU) * 0.5)) + (Number(frame.vAxis[2] || 0.0) * ((minV + maxV) * 0.5))
    ];
    var planeNormal = normalize3(frame.normal, [0.0, 0.0, 1.0]);
    var reflectedPos = reflectPointAcrossPlane(
      toVec3(viewerCamera && viewerCamera.pos, [4.0, -5.0, 3.5]),
      planePoint,
      planeNormal
    );
    return {
      pos: reflectedPos,
      target: planePoint,
      up: [0.0, 0.0, 1.0],
      fov: Number(viewerCamera && viewerCamera.fov || 34.0) || 34.0,
      flip_x: (baseCamera && baseCamera.flip_x === true) || (viewerCamera && viewerCamera.flip_x === true)
    };
  }

  function renderedMirrorPartForCamera(mesh, camera, purpose) {
    var rendered = buildMeshPayload(mesh, camera, []);
    if (Array.isArray(rendered)) {
      failFast(String(purpose || "mirror camera") + " requires one rendered planar mirror mesh");
    }
    if (!rendered || rendered.kind !== "quad") {
      failFast(String(purpose || "mirror camera") + " requires rendered quad mirror mesh");
    }
    return { mesh: rendered };
  }

  function buildConvexHullGeometry(spec, points) {
    if (spec._generatedHull) { return spec._generatedHull; }
    var verts = Array.isArray(points) ? points : [];
    if (verts.length < 4) {
      failFast("convex hull requires at least 4 points");
    }
    var coplanarZ = true;
    var z0 = Number(verts[0][2] || 0.0);
    for (var zIndex = 1; zIndex < verts.length; zIndex += 1) {
      if (Math.abs((Number(verts[zIndex][2] || 0.0)) - z0) > 1e-6) {
        coplanarZ = false;
        break;
      }
    }
    if (coplanarZ) {
      var ordered = verts.map(function (p, idx) {
        return [Number(p[0] || 0.0), Number(p[1] || 0.0), Number(p[2] || 0.0), idx];
      }).sort(function (a, b) {
        return a[0] === b[0] ? (a[1] - b[1]) : (a[0] - b[0]);
      });
      var unique = [];
      for (var uniqueIndex = 0; uniqueIndex < ordered.length; uniqueIndex += 1) {
        if (!unique.length || Math.abs(unique[unique.length - 1][0] - ordered[uniqueIndex][0]) > 1e-6 || Math.abs(unique[unique.length - 1][1] - ordered[uniqueIndex][1]) > 1e-6) {
          unique.push(ordered[uniqueIndex]);
        }
      }
      if (unique.length < 3) {
        failFast("convex hull requires at least 3 unique coplanar points");
      }
      var lower = [];
      for (var li = 0; li < unique.length; li += 1) {
        while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], unique[li]) <= 0) {
          lower.pop();
        }
        lower.push(unique[li]);
      }
      var upper = [];
      for (var ui = unique.length - 1; ui >= 0; ui -= 1) {
        while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], unique[ui]) <= 0) {
          upper.pop();
        }
        upper.push(unique[ui]);
      }
      lower.pop();
      upper.pop();
      var boundary = lower.concat(upper);
      var boundaryIndices = boundary.map(function (p) { return Number(p[3]) | 0; });
      var boundaryFaces = [];
      var boundaryEdges = [];
      for (var edgeIdx = 0; edgeIdx < boundaryIndices.length; edgeIdx += 1) {
        boundaryEdges.push([boundaryIndices[edgeIdx], boundaryIndices[(edgeIdx + 1) % boundaryIndices.length]]);
      }
      for (var faceIdx = 1; faceIdx + 1 < boundaryIndices.length; faceIdx += 1) {
        boundaryFaces.push([boundaryIndices[0], boundaryIndices[faceIdx], boundaryIndices[faceIdx + 1]]);
      }
      spec._generatedHull = {
        vertices: verts,
        hullVertexIndices: boundaryIndices.slice(),
        faces: boundaryFaces,
        edges: boundaryEdges,
        bounds: computeBounds(verts),
        centroid: computeCentroid(verts)
      };
      return spec._generatedHull;
    }
    var centroid = computeCentroid(verts);
    var faces = [];
    var edgeSeen = Object.create(null);
    var edges = [];
    var eps = 1e-5;
    for (var a = 0; a < verts.length - 2; a += 1) {
      for (var b = a + 1; b < verts.length - 1; b += 1) {
        for (var c = b + 1; c < verts.length; c += 1) {
          var pa = verts[a];
          var pb = verts[b];
          var pc = verts[c];
          var n = faceNormal(pa, pb, pc);
          var side = 0;
          var valid = true;
          for (var d = 0; d < verts.length; d += 1) {
            if (d === a || d === b || d === c) { continue; }
            var pd = verts[d];
            var signed = ((pd[0] - pa[0]) * n[0]) + ((pd[1] - pa[1]) * n[1]) + ((pd[2] - pa[2]) * n[2]);
            if (Math.abs(signed) <= eps) { continue; }
            var curr = signed > 0 ? 1 : -1;
            if (side === 0) {
              side = curr;
            } else if (side !== curr) {
              valid = false;
              break;
            }
          }
          if (!valid) { continue; }
          var tri = [a, b, c];
          var faceCenter = [
            (pa[0] + pb[0] + pc[0]) / 3.0,
            (pa[1] + pb[1] + pc[1]) / 3.0,
            (pa[2] + pb[2] + pc[2]) / 3.0
          ];
          var outward = [
            faceCenter[0] - centroid[0],
            faceCenter[1] - centroid[1],
            faceCenter[2] - centroid[2]
          ];
          if ((((n[0] * outward[0]) + (n[1] * outward[1]) + (n[2] * outward[2])) < 0.0)) {
            tri = [a, c, b];
          }
          faces.push(tri);
          var triEdges = [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]];
          for (var triEdgeIndex = 0; triEdgeIndex < triEdges.length; triEdgeIndex += 1) {
            var triEdge = triEdges[triEdgeIndex];
            var edgeKey = triEdge[0] < triEdge[1] ? (triEdge[0] + "," + triEdge[1]) : (triEdge[1] + "," + triEdge[0]);
            if (!edgeSeen[edgeKey]) {
              edgeSeen[edgeKey] = true;
              edges.push([triEdge[0], triEdge[1]]);
            }
          }
        }
      }
    }
    spec._generatedHull = {
      vertices: verts,
      hullVertexIndices: Array.from(edgeSeen ? (function () {
        var used = Object.create(null);
        var out = [];
        for (var edgeIdx3 = 0; edgeIdx3 < edges.length; edgeIdx3 += 1) {
          var edge3 = edges[edgeIdx3];
          for (var edgeVertIdx = 0; edgeVertIdx < edge3.length; edgeVertIdx += 1) {
            var vi = Number(edge3[edgeVertIdx]) | 0;
            if (!used[vi]) {
              used[vi] = true;
              out.push(vi);
            }
          }
        }
        return out;
      }()) : []),
      faces: faces,
      edges: edges,
      bounds: computeBounds(verts),
      centroid: centroid
    };
    return spec._generatedHull;
  }

  function buildSimplicialGeometry(spec) {
    if (spec._generatedSimplices) { return spec._generatedSimplices; }
    var vertices = Array.isArray(spec.points) ? spec.points.map(function (p) { return toVec3(p, [0, 0, 0]); }) : [];
    var simplices = spec.add_simplices || {};
    var edges = Array.isArray(simplices.edges) ? simplices.edges : [];
    var faces = Array.isArray(simplices.faces) ? simplices.faces : [];
    var volumes = Array.isArray(simplices.volumes) ? simplices.volumes : [];
    var boundaryFaces = [];
    var seen = Object.create(null);
    for (var i = 0; i < faces.length; i += 1) {
      if (Array.isArray(faces[i]) && faces[i].length === 3) {
        boundaryFaces.push([Number(faces[i][0]) | 0, Number(faces[i][1]) | 0, Number(faces[i][2]) | 0]);
      }
    }
    for (var volumeIndex = 0; volumeIndex < volumes.length; volumeIndex += 1) {
      var tetra = volumes[volumeIndex];
      if (!Array.isArray(tetra) || tetra.length !== 4) { continue; }
      var tetraFaces = [
        [tetra[0], tetra[1], tetra[2]],
        [tetra[0], tetra[1], tetra[3]],
        [tetra[0], tetra[2], tetra[3]],
        [tetra[1], tetra[2], tetra[3]]
      ];
      for (var faceIndex = 0; faceIndex < tetraFaces.length; faceIndex += 1) {
        var face = tetraFaces[faceIndex].map(function (v) { return Number(v) | 0; });
        var key = face.slice().sort(function (a, b) { return a - b; }).join(",");
        if (!seen[key]) {
          seen[key] = { count: 1, face: face };
        } else {
          seen[key].count += 1;
        }
      }
    }
    var keys = Object.keys(seen);
    for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      var entry = seen[keys[keyIndex]];
      if (entry.count === 1) {
        boundaryFaces.push(entry.face);
      }
    }
    spec._generatedSimplices = {
      vertices: vertices,
      edges: edges,
      faces: boundaryFaces,
      bounds: computeBounds(vertices),
      centroid: computeCentroid(vertices)
    };
    return spec._generatedSimplices;
  }

  function generateRandomHullGeometry(spec) {
    if (spec._generatedHull) { return spec._generatedHull; }
    var center = toVec3(spec.center, [0, 0, 1.2]);
    var stretch = toVec3(spec.stretch, [1.0, 0.84, 1.28]);
    var radius = Math.max(0.1, Number(spec.radius || 1.1));
    var count = Math.max(8, Number(spec.count || 100) | 0);
    var jitter = Math.max(0.0, Number(spec.jitter || 0.28));
    var rnd = makeRng(spec.seed || 7);
    var points = [];
    for (var i = 0; i < count; i += 1) {
      var z = (rnd() * 2.0) - 1.0;
      var theta = rnd() * Math.PI * 2.0;
      var r = Math.sqrt(Math.max(0.0, 1.0 - (z * z)));
      var dir = [r * Math.cos(theta), r * Math.sin(theta), z];
      var radial = radius * (1.0 - jitter + (2.0 * jitter * rnd()));
      points.push([
        center[0] + (dir[0] * stretch[0] * radial),
        center[1] + (dir[1] * stretch[1] * radial),
        center[2] + (dir[2] * stretch[2] * radial)
      ]);
    }
    return buildConvexHullGeometry(spec, points);
  }

  function meshVerticesForOccluder(mesh) {
    if (!mesh) { return []; }
    if (mesh.kind === "field_mesh") {
      var rawVerts = Array.isArray(mesh.vertices) ? mesh.vertices : [];
      var localPositions = [];
      if (rawVerts.length && Array.isArray(rawVerts[0])) {
        for (var fv = 0; fv < rawVerts.length; fv += 1) {
          localPositions.push(toVec3(rawVerts[fv], [0.0, 0.0, 0.0]));
        }
      } else {
        for (var flatIndex = 0; flatIndex + 2 < rawVerts.length; flatIndex += 10) {
          localPositions.push([
            Number(rawVerts[flatIndex] || 0.0),
            Number(rawVerts[flatIndex + 1] || 0.0),
            Number(rawVerts[flatIndex + 2] || 0.0)
          ]);
        }
      }
      if (Array.isArray(mesh._modelMatrix) && mesh._modelMatrix.length === 16) {
        return transformVerticesByMatrix(localPositions, mesh._modelMatrix);
      }
      var meshScale = toVec3(mesh.scale, [1.0, 1.0, 1.0]);
      var scaledLocal = [];
      for (var localIndex = 0; localIndex < localPositions.length; localIndex += 1) {
        var lp = localPositions[localIndex];
        scaledLocal.push([
          Number(lp[0] || 0.0) * Number(meshScale[0] || 1.0),
          Number(lp[1] || 0.0) * Number(meshScale[1] || 1.0),
          Number(lp[2] || 0.0) * Number(meshScale[2] || 1.0)
        ]);
      }
      return transformLocalVertices(scaledLocal, mesh.center || [0, 0, 0], mesh.rotation || [0, 0, 0]);
    }
    if (mesh.kind === "cube") {
      if (Array.isArray(mesh.transform) && mesh.transform.length === 16) {
        return transformVerticesByMatrix(makeCubeLocalVertices(mesh.size), mesh.transform);
      }
      return transformLocalVertices(makeCubeLocalVertices(mesh.size), mesh.center, mesh.rotation || [0, 0, 0]);
    }
    if (mesh.kind === "quad") {
      var quadSize = Array.isArray(mesh.size)
        ? [Number(mesh.size[0] || 0.0), Number(mesh.size[1] || 0.0)]
        : [Number(mesh.size || 0.0), Number(mesh.size || 0.0)];
      var halfX = Math.max(0.0, quadSize[0]) * 0.5;
      var halfY = Math.max(0.0, quadSize[1]) * 0.5;
      var localQuad = [
        [-halfX, -halfY, 0.0],
        [ halfX, -halfY, 0.0],
        [ halfX,  halfY, 0.0],
        [-halfX,  halfY, 0.0]
      ];
      if (Array.isArray(mesh.transform) && mesh.transform.length === 16) {
        return transformVerticesByMatrix(localQuad, mesh.transform);
      }
      return transformLocalVertices(localQuad, mesh.center, mesh.rotation || [0, 0, 0]);
    }
    if (mesh.kind === "convex_hull") {
      return buildConvexHullGeometry(mesh, Array.isArray(mesh.points) ? mesh.points.map(function (p) {
        return toVec3(p, [0, 0, 0]);
      }) : []).vertices;
    }
    if (mesh.kind === "simplices") {
      return buildSimplicialGeometry(mesh).vertices;
    }
    if (mesh.kind === "random_hull") {
      return generateRandomHullGeometry(mesh).vertices;
    }
    return [];
  }

  function cubeMesh(cube, color) {
    var vertices = makeCubeLocalVertices(cube.size);
    var faces = [
      [4, 5, 6, 7],
      [0, 1, 2, 3],
      [1, 5, 6, 2],
      [0, 4, 7, 3],
      [3, 2, 6, 7],
      [0, 1, 5, 4]
    ];
    var verts = [];
    var indices = [];
    var nextIndex = 0;
    var i;
    for (i = 0; i < faces.length; i += 1) {
      var face = faces[i];
      var a = vertices[face[0]];
      var b = vertices[face[1]];
      var c = vertices[face[2]];
      var d = vertices[face[3]];
      var n = faceNormal(a, b, c);
      pushVertex(verts, a, n, color);
      pushVertex(verts, b, n, color);
      pushVertex(verts, c, n, color);
      pushVertex(verts, a, n, color);
      pushVertex(verts, c, n, color);
      pushVertex(verts, d, n, color);
      indices.push(nextIndex, nextIndex + 1, nextIndex + 2, nextIndex + 3, nextIndex + 4, nextIndex + 5);
      nextIndex += 6;
    }
    var mesh = {
      type: "field_mesh",
      id: String(cube.id || "cube_body"),
      topology: "triangle-list",
      vertices: verts,
      indices: indices,
      color: color,
      texture: cube.texture || null,
      surface_system: cube.surface_system || null,
      casts_shadow: cube.casts_shadow !== false,
      receives_shadow: cube.receives_shadow !== false,
      no_backface_specular: cube.no_backface_specular === true,
      tracks: cube.tracks || null,
      animation_timing: {
        fps: fps,
        duration_seconds: durationSeconds,
        boundary: boundary
      },
      scale: [1, 1, 1],
      interpolation: false,
      depth_write: true
    };
    if (Array.isArray(cube.transform) && cube.transform.length === 16) {
      mesh._modelMatrix = cube.transform.slice();
    } else {
      mesh.center = toVec3(cube.center, [0, 0, 0]);
      mesh.rotation = toVec3(cube.rotation, [0, 0, 0]);
    }
    return mesh;
  }

  function convexHullMesh(mesh, color) {
    var hull = mesh.kind === "random_hull"
      ? generateRandomHullGeometry(mesh)
      : buildConvexHullGeometry(mesh, Array.isArray(mesh.points) ? mesh.points.map(function (p) {
          return toVec3(p, [0, 0, 0]);
        }) : []);
    var verts = [];
    var indices = [];
    var nextIndex = 0;
    for (var i = 0; i < hull.faces.length; i += 1) {
      var tri = hull.faces[i];
      var a = hull.vertices[tri[0]];
      var b = hull.vertices[tri[1]];
      var c = hull.vertices[tri[2]];
      var n = faceNormal(a, b, c);
      pushVertex(verts, a, n, color);
      pushVertex(verts, b, n, color);
      pushVertex(verts, c, n, color);
      indices.push(nextIndex, nextIndex + 1, nextIndex + 2);
      nextIndex += 3;
    }
    return {
      type: "field_mesh",
      id: String(mesh.id || "random_hull"),
      topology: "triangle-list",
      vertices: verts,
      indices: indices,
      color: color,
      interpolation: false,
      depth_write: true
    };
  }

  function convexHullEdgeMesh(mesh) {
    var hull = mesh.kind === "random_hull"
      ? generateRandomHullGeometry(mesh)
      : buildConvexHullGeometry(mesh, Array.isArray(mesh.points) ? mesh.points.map(function (p) {
          return toVec3(p, [0, 0, 0]);
        }) : []);
    var edgeWidth = Math.max(0.0, Number(mesh.edge_width || 0.0));
    if (!(edgeWidth > 0) || mesh.show_edges === false || !Array.isArray(hull.edges) || !hull.edges.length) {
      return null;
    }
    var color = toRgba(mesh.edge_color, [0.10, 0.82, 0.26, 1.0]);
    var liftedVertices = liftedFlatVertices(hull.vertices, mesh.edge_lift);
    var verts = [];
    var indices = [];
    for (var i = 0; i < liftedVertices.length; i += 1) {
      pushVertex(verts, liftedVertices[i], [0, 0, 1], color);
    }
    for (var edgeIndex = 0; edgeIndex < hull.edges.length; edgeIndex += 1) {
      var edge = hull.edges[edgeIndex];
      if (!Array.isArray(edge) || edge.length !== 2) { continue; }
      indices.push(Number(edge[0]) | 0, Number(edge[1]) | 0);
    }
    return {
      type: "field_mesh",
      id: String(mesh.id || "convex_hull") + "_edges",
      topology: "line-list",
      vertices: verts,
      indices: indices,
      edge_width: edgeWidth,
      edge_caps: mesh.edge_caps !== false,
      color: color,
      render_mode: overlayRenderMode(mesh, "edge"),
      marker_space: overlayMarkerSpace(mesh, "edge"),
      casts_shadow: mesh.edge_casts_shadow !== false,
      no_lighting: mesh.edge_receives_lighting === false,
      interpolation: false,
      depth_write: overlayDepthWrite(mesh, "edge")
    };
  }

  function convexHullVertexMesh(mesh) {
    var hull = mesh.kind === "random_hull"
      ? generateRandomHullGeometry(mesh)
      : buildConvexHullGeometry(mesh, Array.isArray(mesh.points) ? mesh.points.map(function (p) {
          return toVec3(p, [0, 0, 0]);
        }) : []);
    var vertexSize = Math.max(0.0, Number(mesh.vertex_size || 0.0));
    var hullVertexIndices = Array.isArray(hull.hullVertexIndices) ? hull.hullVertexIndices : [];
    if (!(vertexSize > 0) || mesh.show_vertices === false || !Array.isArray(hull.vertices) || !hull.vertices.length || !hullVertexIndices.length) {
      return null;
    }
    var color = toRgba(mesh.vertex_color, mesh.face_color || [0.96, 0.22, 0.16, 1.0]);
    var liftedVertices = liftedFlatVertices(hull.vertices, mesh.vertex_lift);
    var verts = [];
    var indices = [];
    for (var i = 0; i < hullVertexIndices.length; i += 1) {
      var sourceIndex = Number(hullVertexIndices[i]) | 0;
      if (!liftedVertices[sourceIndex]) { continue; }
      pushVertex(verts, liftedVertices[sourceIndex], [0, 0, 1], color);
      indices.push(indices.length);
    }
    return {
      type: "field_mesh",
      id: String(mesh.id || "convex_hull") + "_vertices",
      topology: "point-list",
      vertices: verts,
      indices: indices,
      vertex_size: vertexSize,
      color: color,
      render_mode: overlayRenderMode(mesh, "vertex"),
      marker_space: overlayMarkerSpace(mesh, "vertex"),
      casts_shadow: mesh.vertex_casts_shadow !== false,
      no_lighting: mesh.vertex_receives_lighting === false,
      interpolation: false,
      depth_write: overlayDepthWrite(mesh, "vertex")
    };
  }

  function simplicesMesh(mesh, color) {
    var simplicial = buildSimplicialGeometry(mesh);
    var verts = [];
    var indices = [];
    var nextIndex = 0;
    for (var i = 0; i < simplicial.faces.length; i += 1) {
      var tri = simplicial.faces[i];
      var a = simplicial.vertices[tri[0]];
      var b = simplicial.vertices[tri[1]];
      var c = simplicial.vertices[tri[2]];
      if (!a || !b || !c) { continue; }
      var n = faceNormal(a, b, c);
      pushVertex(verts, a, n, color);
      pushVertex(verts, b, n, color);
      pushVertex(verts, c, n, color);
      indices.push(nextIndex, nextIndex + 1, nextIndex + 2);
      nextIndex += 3;
    }
    if (!indices.length) { return null; }
    return {
      type: "field_mesh",
      id: String(mesh.id || "simplices"),
      topology: "triangle-list",
      vertices: verts,
      indices: indices,
      color: color,
      interpolation: false,
      depth_write: true
    };
  }

  function liftedFlatVertices(vertices, amount) {
    var lift = Number(amount || 0.0);
    if (!(lift > 0) || !Array.isArray(vertices) || !vertices.length) {
      return vertices;
    }
    var z0 = Number(vertices[0][2] || 0.0);
    for (var i = 1; i < vertices.length; i += 1) {
      if (Math.abs((Number(vertices[i][2] || 0.0)) - z0) > 1e-6) {
        return vertices;
      }
    }
    var out = [];
    for (var vertexIndex = 0; vertexIndex < vertices.length; vertexIndex += 1) {
      var v = vertices[vertexIndex];
      out.push([Number(v[0] || 0.0), Number(v[1] || 0.0), Number(v[2] || 0.0) + lift]);
    }
    return out;
  }

  function simplicesEdgeMesh(mesh) {
    var simplicial = buildSimplicialGeometry(mesh);
    var edgeWidth = Math.max(0.0, Number(mesh.edge_width || 0.0));
    if (!(edgeWidth > 0) || mesh.show_edges === false || !Array.isArray(simplicial.edges) || !simplicial.edges.length) {
      return null;
    }
    var color = toRgba(mesh.edge_color, [0.10, 0.82, 0.26, 1.0]);
    var liftedVertices = liftedFlatVertices(simplicial.vertices, mesh.edge_lift);
    var verts = [];
    var indices = [];
    for (var i = 0; i < liftedVertices.length; i += 1) {
      pushVertex(verts, liftedVertices[i], [0, 0, 1], color);
    }
    for (var edgeIndex = 0; edgeIndex < simplicial.edges.length; edgeIndex += 1) {
      var edge = simplicial.edges[edgeIndex];
      if (!Array.isArray(edge) || edge.length !== 2) { continue; }
      var a = Number(edge[0]) | 0;
      var b = Number(edge[1]) | 0;
      if (!simplicial.vertices[a] || !simplicial.vertices[b]) { continue; }
      indices.push(a, b);
    }
    if (!indices.length) { return null; }
    return {
      type: "field_mesh",
      id: String(mesh.id || "simplices") + "_edges",
      topology: "line-list",
      vertices: verts,
      indices: indices,
      edge_width: edgeWidth,
      edge_caps: mesh.edge_caps !== false,
      color: color,
      render_mode: overlayRenderMode(mesh, "edge"),
      marker_space: overlayMarkerSpace(mesh, "edge"),
      casts_shadow: mesh.edge_casts_shadow !== false,
      no_lighting: mesh.edge_receives_lighting === false,
      interpolation: false,
      depth_write: overlayDepthWrite(mesh, "edge")
    };
  }

  function simplicesVertexMesh(mesh) {
    var simplicial = buildSimplicialGeometry(mesh);
    var vertexSize = Math.max(0.0, Number(mesh.vertex_size || 0.0));
    if (!(vertexSize > 0) || mesh.show_vertices === false || !Array.isArray(simplicial.vertices) || !simplicial.vertices.length) {
      return null;
    }
    var color = toRgba(mesh.vertex_color, mesh.face_color || [0.96, 0.22, 0.16, 1.0]);
    var liftedVertices = liftedFlatVertices(simplicial.vertices, mesh.vertex_lift);
    var verts = [];
    var indices = [];
    for (var i = 0; i < liftedVertices.length; i += 1) {
      pushVertex(verts, liftedVertices[i], [0, 0, 1], color);
      indices.push(i);
    }
    return {
      type: "field_mesh",
      id: String(mesh.id || "simplices") + "_vertices",
      topology: "point-list",
      vertices: verts,
      indices: indices,
      vertex_size: vertexSize,
      color: color,
      render_mode: overlayRenderMode(mesh, "vertex"),
      marker_space: overlayMarkerSpace(mesh, "vertex"),
      casts_shadow: mesh.vertex_casts_shadow !== false,
      no_lighting: mesh.vertex_receives_lighting === false,
      interpolation: false,
      depth_write: overlayDepthWrite(mesh, "vertex")
    };
  }

  function cross2(o, a, b) {
    return ((a[0] - o[0]) * (b[1] - o[1])) - ((a[1] - o[1]) * (b[0] - o[0]));
  }

  function convexHull(points) {
    var pts = points.slice().sort(function (a, b) {
      return a[0] === b[0] ? (a[1] - b[1]) : (a[0] - b[0]);
    });
    var unique = [];
    var i;
    for (i = 0; i < pts.length; i += 1) {
      if (!unique.length || Math.abs(unique[unique.length - 1][0] - pts[i][0]) > 1e-6 || Math.abs(unique[unique.length - 1][1] - pts[i][1]) > 1e-6) {
        unique.push(pts[i]);
      }
    }
    if (unique.length < 3) { return unique; }
    var lower = [];
    for (i = 0; i < unique.length; i += 1) {
      while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], unique[i]) <= 0) {
        lower.pop();
      }
      lower.push(unique[i]);
    }
    var upper = [];
    for (i = unique.length - 1; i >= 0; i -= 1) {
      while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], unique[i]) <= 0) {
        upper.pop();
      }
      upper.push(unique[i]);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  function projectPointToPlane(point, lightPos, planeZ) {
    planeZ = Number(planeZ);
    if (!Number.isFinite(planeZ)) { planeZ = 0.0; }
    var dz = point[2] - lightPos[2];
    if (Math.abs(dz) < 1e-6) { return null; }
    var t = (planeZ - lightPos[2]) / dz;
    return [
      lightPos[0] + ((point[0] - lightPos[0]) * t),
      lightPos[1] + ((point[1] - lightPos[1]) * t),
      planeZ
    ];
  }

  function planeMesh(plane) {
    var planeColor = toRgba(plane.color, [0.20, 0.22, 0.26, 1.0]);
    var isTransparent = plane.transparent === true || Number(planeColor[3] || 0.0) < 0.999;
    var size = Array.isArray(plane.size)
      ? [Number(plane.size[0] || 0.0), Number(plane.size[1] || 0.0)]
      : [Number(plane.size || 0.0), Number(plane.size || 0.0)];
    var halfX = Math.max(0.0, size[0]) * 0.5;
    var halfY = Math.max(0.0, size[1]) * 0.5;
    var center = toVec3(plane.center, [0.0, 0.0, 0.0]);
    var rotation = toVec3(plane.rotation, [0.0, 0.0, 0.0]);
    var verts = [];
    pushVertex(verts, [-halfX, -halfY, 0.0], [0, 0, 1], planeColor);
    pushVertex(verts, [ halfX, -halfY, 0.0], [0, 0, 1], planeColor);
    pushVertex(verts, [ halfX,  halfY, 0.0], [0, 0, 1], planeColor);
    pushVertex(verts, [-halfX,  halfY, 0.0], [0, 0, 1], planeColor);
    return {
      type: "field_mesh",
      id: String(plane.id || "ground_plane"),
      kind: "quad",
      topology: "triangle-list",
      vertices: verts,
      indices: [0, 1, 2, 0, 2, 3],
      center: center,
      size: size,
      rotation: rotation,
      _modelMatrix: toMatrix4(plane.transform, null),
      color: planeColor,
      texture: plane.texture || null,
      surface_system: plane.surface_system || null,
      casts_shadow: plane.casts_shadow !== false,
      receives_shadow: plane.receives_shadow !== false,
      no_backface_specular: plane.no_backface_specular === true,
      reverse_facing: plane.reverse_facing === true,
      light_model: "blinn_phong",
      interpolation: true,
      transparent: isTransparent,
      depth_write: !isTransparent
    };
  }

  function normalizeMeshSpec(mesh, seconds, viewerCamera) {
    var spec = mesh || {};
    var framePos = animationFramePosition(seconds || 0.0);
    var kind = String(spec.kind || "");
    var faceColor = entityProp(spec, "face_color", entityProp(spec, "color", [0.96, 0.22, 0.16, 1.0]));
    if (kind !== "cube" && kind !== "quad" && kind !== "random_hull" && kind !== "convex_hull" && kind !== "simplices" && kind !== "field_mesh") {
      failFast("mesh.kind must be cube, quad, random_hull, convex_hull, simplices, or field_mesh");
    }
    if (kind === "field_mesh") {
      var renderMode = String(entityProp(spec, "render_mode", "proxy_geometry"));
      return {
        id: String(spec.id || "field_mesh"),
        kind: "field_mesh",
        vertices: Array.isArray(entityProp(spec, "vertices", [])) ? entityProp(spec, "vertices", []).slice() : [],
        indices: Array.isArray(entityProp(spec, "indices", [])) ? entityProp(spec, "indices", []).slice() : [],
        topology: String(entityProp(spec, "topology", "triangle-list")),
        interpolation: entityProp(spec, "interpolation", false) === true,
        alpha: Math.max(0.0, Math.min(1.0, Number(entityProp(spec, "alpha", 1.0) || 1.0))),
        center: resolveTrackedVec3(spec, "center", framePos, toVec3(entityProp(spec, "center", [0.0, 0.0, 0.0]), [0.0, 0.0, 0.0])),
        scale: resolveTrackedVec3(spec, "scale", framePos, toVec3(entityProp(spec, "scale", [1.0, 1.0, 1.0]), [1.0, 1.0, 1.0])),
        rotation: resolveTrackedVec3(spec, "rotation", framePos, toVec3(entityProp(spec, "rotation", [0.0, 0.0, 0.0]), [0.0, 0.0, 0.0])),
        color: toRgba(entityProp(spec, "color", [1.0, 1.0, 1.0, 1.0]), [1.0, 1.0, 1.0, 1.0]),
        time_boundary: String(entityProp(spec, "time_boundary", "clamp")),
        time_count: Math.max(1, Number(entityProp(spec, "time_count", 1) || 1) | 0),
        time_index: Math.max(0, Number(entityProp(spec, "time_index", 0) || 0) | 0),
        manifold_dim_count: Math.max(0, Number(entityProp(spec, "manifold_dim_count", 0) || 0) | 0),
        solid_volume: entityProp(spec, "solid_volume", false) === true,
        vertex_size: Math.max(0.0, Number(entityProp(spec, "vertex_size", 0.0) || 0.0)),
        edge_width: Math.max(0.0, Number(entityProp(spec, "edge_width", 0.0) || 0.0)),
        vertex_widths: Array.isArray(entityProp(spec, "vertex_widths", [])) ? entityProp(spec, "vertex_widths", []).slice() : [],
        render_mode: renderMode,
        marker_space: String(entityProp(spec, "marker_space", String(renderMode).toLowerCase() === "marker_impostor" ? "pixel" : "world")),
        casts_shadow: entityProp(spec, "casts_shadow", true) !== false,
        no_lighting: entityProp(spec, "receives_lighting", true) === false,
        depth_write: entityProp(spec, "depth_write", false) === true,
        tracks: spec && spec.tracks && typeof spec.tracks === "object" ? spec.tracks : null,
        animation_timing: {
          fps: fps,
          duration_seconds: durationSeconds,
          boundary: boundary
        }
      };
    }
    if (kind === "cube") {
      var transformFallback = entityProp(spec, "transform", null);
      return {
        id: String(spec.id || "cube"),
        kind: "cube",
        tracks: spec && spec.tracks && typeof spec.tracks === "object" ? spec.tracks : null,
        animation_timing: {
          fps: fps,
          duration_seconds: durationSeconds,
          boundary: boundary
        },
        center: resolveTrackedVec3(spec, "center", framePos, toVec3(entityProp(spec, "center", [0, 0, 1.1]), [0, 0, 1.1])),
        size: resolveTrackedNumber(spec, "size", framePos, Number(entityProp(spec, "size", 1.6) || 1.6)),
        rotation: resolveTrackedVec3(spec, "rotation", framePos, toVec3(entityProp(spec, "rotation", [0, 0, 0]), [0, 0, 0])),
        transform: resolveTrackedMatrix4(spec, "transform", framePos, toMatrix4(transformFallback, null)),
        face_color: resolveTrackedRgba(spec, "face_color", framePos, toRgba(faceColor, [0.96, 0.22, 0.16, 1.0])),
        texture: resolveTrackedObject(spec, "texture", framePos, entityProp(spec, "texture", null)),
        surface_system: resolveSurfaceSystem(resolveTrackedObject(spec, "surface_system", framePos, entityProp(spec, "surface_system", null)), viewerCamera, seconds),
        casts_shadow: entityProp(spec, "casts_shadow", true) !== false,
        receives_shadow: entityProp(spec, "receives_shadow", true) !== false,
        no_backface_specular: entityProp(spec, "no_backface_specular", false) === true
      };
    }
    if (kind === "convex_hull") {
      if (!spec._vfConvexHullMesh) {
        spec._vfConvexHullMesh = {
          id: String(spec.id || "convex_hull"),
          kind: "convex_hull",
          points: Array.isArray(entityProp(spec, "points", [])) ? entityProp(spec, "points", []).map(function (p) { return toVec3(p, [0, 0, 0]); }) : [],
          face_color: toRgba(faceColor, [0.96, 0.22, 0.16, 1.0]),
          edge_color: toRgba(entityProp(spec, "edge_color", [0.10, 0.82, 0.26, 1.0]), [0.10, 0.82, 0.26, 1.0]),
          edge_width: Math.max(0.0, Number(entityProp(spec, "edge_width", 0.03) || 0.03)),
          edge_caps: entityProp(spec, "edge_caps", true) !== false,
          edge_lift: Math.max(0.0, Number(entityProp(spec, "edge_lift", 0.003) || 0.003)),
          show_edges: entityProp(spec, "show_edges", true) !== false,
          edge_render_mode: String(entityProp(spec, "edge_render_mode", "proxy_geometry")),
          edge_marker_space: String(entityProp(spec, "edge_marker_space", "world")),
          edge_casts_shadow: entityProp(spec, "edge_casts_shadow", true) !== false,
          edge_receives_lighting: entityProp(spec, "edge_receives_lighting", true) !== false,
          edge_depth_write: entityProp(spec, "edge_depth_write", null),
          vertex_color: toRgba(entityProp(spec, "vertex_color", faceColor), [0.96, 0.22, 0.16, 1.0]),
          vertex_size: Math.max(0.0, Number(entityProp(spec, "vertex_size", 0.06) || 0.06)),
          vertex_lift: Math.max(0.0, Number(entityProp(spec, "vertex_lift", 0.006) || 0.006)),
          show_vertices: entityProp(spec, "show_vertices", true) !== false,
          vertex_render_mode: String(entityProp(spec, "vertex_render_mode", "proxy_geometry")),
          vertex_marker_space: String(entityProp(spec, "vertex_marker_space", "world")),
          vertex_casts_shadow: entityProp(spec, "vertex_casts_shadow", true) !== false,
          vertex_receives_lighting: entityProp(spec, "vertex_receives_lighting", true) !== false,
          vertex_depth_write: entityProp(spec, "vertex_depth_write", null),
          _generatedHull: null
        };
      }
      return spec._vfConvexHullMesh;
    }
    if (kind === "random_hull") {
      if (!spec._vfRandomHullMesh) {
        spec._vfRandomHullMesh = {
          id: String(spec.id || "random_hull"),
          kind: "random_hull",
          center: toVec3(entityProp(spec, "center", [0, 0, 1.2]), [0, 0, 1.2]),
          radius: Math.max(0.1, Number(entityProp(spec, "radius", 1.1) || 1.1)),
          count: Math.max(8, Number(entityProp(spec, "count", 100) || 100) | 0),
          seed: Math.max(0, Number(entityProp(spec, "seed", 7) || 7) | 0),
          stretch: toVec3(entityProp(spec, "stretch", [1.0, 0.84, 1.28]), [1.0, 0.84, 1.28]),
          jitter: Math.max(0.0, Number(entityProp(spec, "jitter", 0.28) || 0.28)),
          face_color: toRgba(faceColor, [0.96, 0.22, 0.16, 1.0]),
          edge_color: toRgba(entityProp(spec, "edge_color", [0.10, 0.82, 0.26, 1.0]), [0.10, 0.82, 0.26, 1.0]),
          edge_width: Math.max(0.0, Number(entityProp(spec, "edge_width", 0.03) || 0.03)),
          edge_caps: entityProp(spec, "edge_caps", true) !== false,
          edge_lift: Math.max(0.0, Number(entityProp(spec, "edge_lift", 0.003) || 0.003)),
          show_edges: entityProp(spec, "show_edges", true) !== false,
          edge_render_mode: String(entityProp(spec, "edge_render_mode", "proxy_geometry")),
          edge_marker_space: String(entityProp(spec, "edge_marker_space", "world")),
          edge_casts_shadow: entityProp(spec, "edge_casts_shadow", true) !== false,
          edge_receives_lighting: entityProp(spec, "edge_receives_lighting", true) !== false,
          edge_depth_write: entityProp(spec, "edge_depth_write", null),
          vertex_color: toRgba(entityProp(spec, "vertex_color", faceColor), [0.96, 0.22, 0.16, 1.0]),
          vertex_size: Math.max(0.0, Number(entityProp(spec, "vertex_size", 0.06) || 0.06)),
          vertex_lift: Math.max(0.0, Number(entityProp(spec, "vertex_lift", 0.006) || 0.006)),
          show_vertices: entityProp(spec, "show_vertices", true) !== false,
          vertex_render_mode: String(entityProp(spec, "vertex_render_mode", "proxy_geometry")),
          vertex_marker_space: String(entityProp(spec, "vertex_marker_space", "world")),
          vertex_casts_shadow: entityProp(spec, "vertex_casts_shadow", true) !== false,
          vertex_receives_lighting: entityProp(spec, "vertex_receives_lighting", true) !== false,
          vertex_depth_write: entityProp(spec, "vertex_depth_write", null),
          _generatedHull: null
        };
      }
      return spec._vfRandomHullMesh;
    }
    if (kind === "simplices") {
      if (!spec._vfSimplicesMesh) {
        spec._vfSimplicesMesh = {
          id: String(spec.id || "simplices"),
          kind: "simplices",
          points: Array.isArray(entityProp(spec, "points", [])) ? entityProp(spec, "points", []).map(function (p) { return toVec3(p, [0, 0, 0]); }) : [],
          add_simplices: entityProp(spec, "add_simplices", { edges: [], faces: [], volumes: [] }),
          face_color: toRgba(faceColor, [0.96, 0.22, 0.16, 1.0]),
          edge_color: toRgba(entityProp(spec, "edge_color", [0.10, 0.82, 0.26, 1.0]), [0.10, 0.82, 0.26, 1.0]),
          edge_width: Math.max(0.0, Number(entityProp(spec, "edge_width", 0.03) || 0.03)),
          edge_caps: entityProp(spec, "edge_caps", true) !== false,
          edge_lift: Math.max(0.0, Number(entityProp(spec, "edge_lift", 0.003) || 0.003)),
          show_edges: entityProp(spec, "show_edges", true) !== false,
          edge_render_mode: String(entityProp(spec, "edge_render_mode", "proxy_geometry")),
          edge_marker_space: String(entityProp(spec, "edge_marker_space", "world")),
          edge_casts_shadow: entityProp(spec, "edge_casts_shadow", true) !== false,
          edge_receives_lighting: entityProp(spec, "edge_receives_lighting", true) !== false,
          edge_depth_write: entityProp(spec, "edge_depth_write", null),
          vertex_color: toRgba(entityProp(spec, "vertex_color", faceColor), [0.96, 0.22, 0.16, 1.0]),
          vertex_size: Math.max(0.0, Number(entityProp(spec, "vertex_size", 0.06) || 0.06)),
          vertex_lift: Math.max(0.0, Number(entityProp(spec, "vertex_lift", 0.006) || 0.006)),
          show_vertices: entityProp(spec, "show_vertices", true) !== false,
          vertex_render_mode: String(entityProp(spec, "vertex_render_mode", "proxy_geometry")),
          vertex_marker_space: String(entityProp(spec, "vertex_marker_space", "world")),
          vertex_casts_shadow: entityProp(spec, "vertex_casts_shadow", true) !== false,
          vertex_receives_lighting: entityProp(spec, "vertex_receives_lighting", true) !== false,
          vertex_depth_write: entityProp(spec, "vertex_depth_write", null),
          _generatedSimplices: null
        };
      }
      return spec._vfSimplicesMesh;
    }
    var quadCenterRaw = entityProp(spec, "center", undefined);
    var quadCenter = Array.isArray(quadCenterRaw) && quadCenterRaw.length >= 3
      ? toVec3(quadCenterRaw, [0.0, 0.0, 0.0])
      : (function () {
          var center2 = toVec2(entityProp(spec, "center", [0.0, 0.0]), [0.0, 0.0]);
          return [center2[0], center2[1], Number(entityProp(spec, "z", 0.0) || 0.0)];
        }());
    var quadSurfaceSystem = resolveSurfaceSystem(resolveTrackedObject(spec, "surface_system", framePos, entityProp(spec, "surface_system", null)), viewerCamera, seconds);
    var quadCastsShadowDefault = quadSurfaceSystem ? false : true;
    var quadReverseFacing = entityProp(spec, "reverse_facing", false) === true ||
      (quadSurfaceSystem && quadSurfaceSystem.reverse_facing === true);
    return {
      id: String(spec.id || "plane"),
      kind: "quad",
      tracks: spec && spec.tracks && typeof spec.tracks === "object" ? spec.tracks : null,
      animation_timing: {
        fps: fps,
        duration_seconds: durationSeconds,
        boundary: boundary
      },
      center: resolveTrackedVec3(spec, "center", framePos, quadCenter),
      size: Array.isArray(entityProp(spec, "size", null))
        ? toVec2(entityProp(spec, "size", [7.0, 7.0]), [7.0, 7.0])
        : Number(entityProp(spec, "size", 7.0) || 7.0),
      rotation: resolveTrackedVec3(spec, "rotation", framePos, toVec3(entityProp(spec, "rotation", [0.0, 0.0, 0.0]), [0.0, 0.0, 0.0])),
        transform: resolveTrackedMatrix4(spec, "transform", framePos, toMatrix4(entityProp(spec, "transform", null), null)),
        color: toRgba(entityProp(spec, "color", [0.20, 0.22, 0.26, 1.0]), [0.20, 0.22, 0.26, 1.0]),
        texture: resolveTrackedObject(spec, "texture", framePos, entityProp(spec, "texture", null)),
        visible: entityProp(spec, "visible", true) !== false,
        surface_system: quadSurfaceSystem,
        casts_shadow: entityProp(spec, "casts_shadow", quadCastsShadowDefault) !== false,
        receives_shadow: entityProp(spec, "receives_shadow", true) !== false,
        no_backface_specular: entityProp(spec, "no_backface_specular", false) === true,
        reverse_facing: quadReverseFacing
      };
  }

  function normalizeShadowReceiverSpec(receiver) {
    var spec = receiver || {};
    return {
      receiver_mesh: String(entityProp(spec, "receiver_mesh", "")),
      occluders: Array.isArray(entityProp(spec, "occluders", [])) ? entityProp(spec, "occluders", []).map(String) : [],
      lights: Array.isArray(entityProp(spec, "lights", [])) ? entityProp(spec, "lights", []).map(String) : [],
      policy_kind: String(entityProp(spec, "policy_kind", "light_camera_depth_map")),
      policy_softness: String(entityProp(spec, "policy_softness", "shadow_map_bias"))
    };
  }

  function buildMeshPayload(mesh, camera, lights) {
    if (mesh.kind === "field_mesh") {
      var renderMode = String(mesh.render_mode || "proxy_geometry");
      var displayTest = global.VfDisplay && global.VfDisplay.__test;
      var canExpandOverlay = displayTest && typeof displayTest.buildSingleMesh === "function";
      var topology = String(mesh.topology || "triangle-list");
      var markerSizingCamera = camera && camera._marker_size_camera ? camera._marker_size_camera : camera;
      var buildCamera = (
        String(renderMode).toLowerCase() === "marker_impostor" &&
        (topology === "point-list" || topology === "line-list")
      ) ? markerSizingCamera : camera;
      if (canExpandOverlay && (topology === "point-list" || topology === "line-list")) {
        var expanded = displayTest.buildSingleMesh({
          type: "field_mesh",
          id: String(mesh.id || "field_mesh"),
          topology: topology,
          vertices: Array.isArray(mesh.vertices) ? mesh.vertices.slice() : [],
          indices: Array.isArray(mesh.indices) ? mesh.indices.slice() : [],
          color: toRgba(mesh.color, [1.0, 1.0, 1.0, 1.0]),
          alpha: Math.max(0.0, Math.min(1.0, Number(mesh.alpha || 1.0) || 1.0)),
          center: toVec3(mesh.center, [0.0, 0.0, 0.0]),
          scale: toVec3(mesh.scale, [1.0, 1.0, 1.0]),
          rotation: toVec3(mesh.rotation, [0.0, 0.0, 0.0]),
          vertex_size: Math.max(0.0, Number(mesh.vertex_size || 0.0)),
          edge_width: Math.max(0.0, Number(mesh.edge_width || 0.0)),
          vertex_widths: Array.isArray(mesh.vertex_widths) ? mesh.vertex_widths.slice() : [],
          render_mode: renderMode,
          marker_space: String(mesh.marker_space || (String(renderMode).toLowerCase() === "marker_impostor" ? "pixel" : "world")),
          interpolation: mesh.interpolation === true,
          depth_write: mesh.depth_write === true,
          edge_caps: mesh.edge_caps === true,
          vertex_scale: Array.isArray(mesh.vertex_scale) ? mesh.vertex_scale.slice() : mesh.vertex_scale
        }, buildCamera, lights);
        if (expanded && expanded.vertices && expanded.indices) {
          return {
            type: "field_mesh",
            id: String(expanded.id || mesh.id || "field_mesh"),
            kind: String(mesh.kind || expanded.kind || "field_mesh"),
            topology: String(expanded.topology || "triangle-list"),
            vertices: expanded.vertices instanceof Float32Array
              ? new Float32Array(expanded.vertices)
              : (Array.isArray(expanded.vertices) ? new Float32Array(expanded.vertices) : new Float32Array(Array.prototype.slice.call(expanded.vertices || []))),
            indices: expanded.indices instanceof Uint32Array
              ? new Uint32Array(expanded.indices)
              : (Array.isArray(expanded.indices) ? new Uint32Array(expanded.indices) : new Uint32Array(Array.prototype.slice.call(expanded.indices || []))),
            instances: expanded.instances
              ? (
                  expanded.instances instanceof Float32Array
                    ? new Float32Array(expanded.instances)
                    : (Array.isArray(expanded.instances) ? new Float32Array(expanded.instances) : new Float32Array(Array.prototype.slice.call(expanded.instances)))
                )
              : null,
            instance_count: Math.max(0, Number(expanded.instance_count || 0) | 0),
            instance_kind: expanded.instance_kind || null,
            static_vertices: expanded.static_vertices === true,
            static_indices: expanded.static_indices === true,
            transparent: expanded.transparent === true,
            color: toRgba(mesh.color, [1.0, 1.0, 1.0, 1.0]),
            alpha: Math.max(0.0, Math.min(1.0, Number(mesh.alpha || 1.0) || 1.0)),
            center: Array.isArray(expanded.center) ? expanded.center.slice() : [0.0, 0.0, 0.0],
            scale: Array.isArray(expanded.scale) ? expanded.scale.slice() : [1.0, 1.0, 1.0],
            rotation: Array.isArray(expanded.rotation) ? expanded.rotation.slice() : [0.0, 0.0, 0.0],
            size: Array.isArray(mesh.size) ? mesh.size.slice() : (mesh.size != null ? mesh.size : null),
            time_boundary: String(mesh.time_boundary || "clamp"),
            time_count: Math.max(1, Number(mesh.time_count || 1) | 0),
            time_index: Math.max(0, Number(mesh.time_index || 0) | 0),
            manifold_dim_count: Math.max(0, Number(mesh.manifold_dim_count || 0) | 0),
            solid_volume: mesh.solid_volume === true,
            vertex_size: Math.max(0.0, Number(mesh.vertex_size || 0.0)),
            edge_width: Math.max(0.0, Number(mesh.edge_width || 0.0)),
            vertex_widths: Array.isArray(mesh.vertex_widths) ? mesh.vertex_widths.slice() : [],
            render_mode: renderMode,
            marker_space: String(mesh.marker_space || (String(renderMode).toLowerCase() === "marker_impostor" ? "pixel" : "world")),
            casts_shadow: mesh.casts_shadow !== false,
            receives_shadow: mesh.receives_shadow !== false,
            no_backface_specular: mesh.no_backface_specular === true,
            reverse_facing: mesh.reverse_facing === true,
            no_lighting: mesh.no_lighting === true,
            interpolation: mesh.interpolation === true,
            depth_write: mesh.depth_write === true,
            overlay_expanded: expanded.overlay_expanded === true,
            surface_system: mesh.surface_system || null,
            tracks: mesh.tracks || null,
            animation_timing: mesh.animation_timing || null,
            _modelMatrix: Array.isArray(mesh._modelMatrix) ? mesh._modelMatrix.slice() : null
          };
        }
      }
      return {
        type: "field_mesh",
        id: String(mesh.id || "field_mesh"),
        kind: String(mesh.kind || "field_mesh"),
        topology: topology,
        vertices: Array.isArray(mesh.vertices) ? mesh.vertices.slice() : [],
        indices: Array.isArray(mesh.indices) ? mesh.indices.slice() : [],
        color: toRgba(mesh.color, [1.0, 1.0, 1.0, 1.0]),
        alpha: Math.max(0.0, Math.min(1.0, Number(mesh.alpha || 1.0) || 1.0)),
        center: toVec3(mesh.center, [0.0, 0.0, 0.0]),
        scale: toVec3(mesh.scale, [1.0, 1.0, 1.0]),
        rotation: toVec3(mesh.rotation, [0.0, 0.0, 0.0]),
        size: Array.isArray(mesh.size) ? mesh.size.slice() : (mesh.size != null ? mesh.size : null),
        time_boundary: String(mesh.time_boundary || "clamp"),
        time_count: Math.max(1, Number(mesh.time_count || 1) | 0),
        time_index: Math.max(0, Number(mesh.time_index || 0) | 0),
        manifold_dim_count: Math.max(0, Number(mesh.manifold_dim_count || 0) | 0),
        solid_volume: mesh.solid_volume === true,
        vertex_size: Math.max(0.0, Number(mesh.vertex_size || 0.0)),
        edge_width: Math.max(0.0, Number(mesh.edge_width || 0.0)),
        vertex_widths: Array.isArray(mesh.vertex_widths) ? mesh.vertex_widths.slice() : [],
        render_mode: renderMode,
        marker_space: String(mesh.marker_space || (String(renderMode).toLowerCase() === "marker_impostor" ? "pixel" : "world")),
        casts_shadow: mesh.casts_shadow !== false,
        receives_shadow: mesh.receives_shadow !== false,
        no_backface_specular: mesh.no_backface_specular === true,
        reverse_facing: mesh.reverse_facing === true,
        no_lighting: mesh.no_lighting === true,
        interpolation: mesh.interpolation === true,
        depth_write: mesh.depth_write === true,
        surface_system: mesh.surface_system || null,
        tracks: mesh.tracks || null,
        animation_timing: mesh.animation_timing || null,
        _modelMatrix: Array.isArray(mesh._modelMatrix) ? mesh._modelMatrix.slice() : null
      };
    }
    if (mesh.kind === "cube") {
      return cubeMesh(mesh, mesh.face_color);
    }
    if (mesh.kind === "random_hull" || mesh.kind === "convex_hull") {
      return [
        convexHullMesh(mesh, mesh.face_color),
        convexHullEdgeMesh(mesh),
        convexHullVertexMesh(mesh)
      ].filter(Boolean);
    }
    if (mesh.kind === "simplices") {
      return [
        simplicesMesh(mesh, mesh.face_color),
        simplicesEdgeMesh(mesh),
        simplicesVertexMesh(mesh)
      ].filter(Boolean);
    }
    return planeMesh(mesh);
  }

  function buildGlowHaloMesh(light, camera, markerSize) {
    var center = toVec3(light.pos, [0, 0, 0]);
    var camPos = toVec3(camera.pos, [0, 0, 5]);
    var toCamera = normalize3([
      camPos[0] - center[0],
      camPos[1] - center[1],
      camPos[2] - center[2]
    ], [0, 1, 0]);
    var camUp = Array.isArray(camera.up) ? toVec3(camera.up, [0, 0, 1]) : [0, 0, 1];
    var right = normalize3(cross3(camUp, toCamera), [1, 0, 0]);
    var up = normalize3(cross3(toCamera, right), [0, 0, 1]);
    var spotlightBoost = 1.0;
    if (String(light.kind || "point") === "spot") {
      var dir = Array.isArray(light.direction)
        ? normalize3(light.direction, [0, 0, -1])
        : normalize3([
            Number(light.target[0]) - center[0],
            Number(light.target[1]) - center[1],
            Number(light.target[2]) - center[2]
          ], [0, 0, -1]);
      spotlightBoost = Math.max(0.0, (dir[0] * toCamera[0]) + (dir[1] * toCamera[1]) + (dir[2] * toCamera[2]));
    }
    var intensity = Math.max(0.0, Number(light.intensity || 24.0));
    var glowRadius = Math.max(0.10, Number(markerSize || 0.18) * (4.2 + Math.min(5.0, intensity / 40.0)));
    var glowAlpha = Math.min(1.0, 0.42 + (0.42 * spotlightBoost));
    var color = toRgba(light.color, [1.0, 1.0, 1.0, 1.0]);
    var centerColor = [1.0, 1.0, 1.0, glowAlpha];
    var innerColor = [color[0], color[1], color[2], glowAlpha * 0.62];
    var outerColor = [color[0], color[1], color[2], 0.0];
    var segments = 20;
    var innerScale = 0.34;
    var verts = [];
    var indices = [];
    pushVertex(verts, center, toCamera, centerColor);
    for (var i = 0; i < segments; i += 1) {
      var angle = (i / segments) * Math.PI * 2.0;
      var c = Math.cos(angle);
      var s = Math.sin(angle);
      var innerPoint = [
        center[0] + ((right[0] * c) + (up[0] * s)) * glowRadius * innerScale,
        center[1] + ((right[1] * c) + (up[1] * s)) * glowRadius * innerScale,
        center[2] + ((right[2] * c) + (up[2] * s)) * glowRadius * innerScale
      ];
      var outerPoint = [
        center[0] + ((right[0] * c) + (up[0] * s)) * glowRadius,
        center[1] + ((right[1] * c) + (up[1] * s)) * glowRadius,
        center[2] + ((right[2] * c) + (up[2] * s)) * glowRadius
      ];
      pushVertex(verts, innerPoint, toCamera, innerColor);
      pushVertex(verts, outerPoint, toCamera, outerColor);
    }
    for (var j = 0; j < segments; j += 1) {
      var next = (j + 1) % segments;
      var innerA = 1 + (j * 2);
      var outerA = innerA + 1;
      var innerB = 1 + (next * 2);
      var outerB = innerB + 1;
      indices.push(0, innerA, innerB);
      indices.push(innerA, outerA, outerB);
      indices.push(innerA, outerB, innerB);
    }
    return {
      type: "field_mesh",
      id: String("light_glow_" + String(light.id || "light")),
      topology: "triangle-list",
      vertices: verts,
      indices: indices,
      color: color,
      interpolation: true,
      transparent: false,
      blend_mode: "additive",
      depth_write: false
    };
  }

  function buildLightMarkerMeshes(lights, camera, markerSize) {
    var meshes = [];
    var size = Math.max(0.02, Number(markerSize || 0.18));
    for (var i = 0; i < lights.length; i += 1) {
      var light = lights[i];
      if (light.show_marker === false) { continue; }
      meshes.push(buildGlowHaloMesh(light, camera, size));
    }
    return meshes;
  }

  function ensureFlareLayer(frame) {
    if (!frame) { return null; }
    var host = frame.querySelector(".vf-geom-canvas-host") || frame;
    if (!host) { return null; }
    host.style.position = host.style.position || "relative";
    var layer = host.querySelector('[data-vf-light-flare-layer="1"]');
    if (layer) { return layer; }
    layer = document.createElement("div");
    layer.setAttribute("data-vf-light-flare-layer", "1");
    layer.style.position = "absolute";
    layer.style.left = "0";
    layer.style.top = "0";
    layer.style.right = "0";
    layer.style.bottom = "0";
    layer.style.pointerEvents = "none";
    layer.style.overflow = "hidden";
    host.appendChild(layer);
    return layer;
  }

  function ensureFlareElement(layer, key) {
    var selector = '[data-vf-light-flare="' + String(key) + '"]';
    var node = layer.querySelector(selector);
    if (node) { return node; }
    node = document.createElement("div");
    node.setAttribute("data-vf-light-flare", String(key));
    node.style.position = "absolute";
    node.style.borderRadius = "999px";
    node.style.pointerEvents = "none";
    node.style.transform = "translate(-50%, -50%)";
    node.style.mixBlendMode = "plus-lighter";
    node.style.overflow = "visible";
    node.style.willChange = "transform, width, height, opacity, background, box-shadow, filter";
    ensureFlareCanvas(node);
    layer.appendChild(node);
    return node;
  }

  function ensureFlareCanvas(node) {
    var canvas = node.querySelector("canvas[data-vf-flare-canvas='1']");
    if (canvas) { return canvas; }
    canvas = document.createElement("canvas");
    canvas.setAttribute("data-vf-flare-canvas", "1");
    canvas.style.position = "absolute";
    canvas.style.left = "50%";
    canvas.style.top = "50%";
    canvas.style.transform = "translate(-50%, -50%)";
    canvas.style.pointerEvents = "none";
    canvas.style.background = "transparent";
    node.appendChild(canvas);
    return canvas;
  }

  function ensureFlarePart(node, name) {
    var selector = '[data-vf-flare-part="' + String(name) + '"]';
    var part = node.querySelector(selector);
    if (part) { return part; }
    part = document.createElement("div");
    part.setAttribute("data-vf-flare-part", String(name));
    part.style.position = "absolute";
    part.style.left = "50%";
    part.style.top = "50%";
    part.style.transform = "translate(-50%, -50%)";
    part.style.pointerEvents = "none";
    part.style.borderRadius = "999px";
    part.style.backgroundRepeat = "no-repeat";
    part.style.backgroundPosition = "center";
    part.style.backgroundSize = "100% 100%";
    node.appendChild(part);
    return part;
  }

  function drawAnalyticFlareCanvas(canvas, options) {
    if (!canvas) { return; }
    var dpr = Math.max(1, Math.min(2, global.devicePixelRatio || 1));
    var cssSize = Math.max(64, Math.round(Number(options.size || 160)));
    var width = Math.max(64, Math.round(cssSize * dpr));
    var height = width;
    if (canvas.width !== width) { canvas.width = width; }
    if (canvas.height !== height) { canvas.height = height; }
    canvas.style.width = cssSize + "px";
    canvas.style.height = cssSize + "px";
    var ctx = canvas.getContext("2d");
    if (!ctx) { return; }
    var image = ctx.createImageData(width, height);
    var data = image.data;
    var cx = width * 0.5;
    var cy = height * 0.5;
    var flareAlpha = clamp01(options.flareAlpha);
    var facing = clamp01(options.facing);
    var edgeFade = clamp01(options.edgeFade);
    var baseAngle = Number(options.axisAngle || 0.0);
    var tint = options.color || [1, 1, 1, 1];
    var cr = Number(tint[0] || 1.0);
    var cg = Number(tint[1] || 1.0);
    var cb = Number(tint[2] || 1.0);

    var sigmaGlow = cssSize * 0.18 * dpr;
    var sigmaCore = Math.max(1.2, cssSize * 0.022 * dpr);
    var ring1 = cssSize * 0.16 * dpr;
    var ring2 = cssSize * 0.28 * dpr;
    var ring3 = cssSize * 0.42 * dpr;
    var ringW1 = Math.max(1.8, cssSize * 0.028 * dpr);
    var ringW2 = Math.max(2.4, cssSize * 0.040 * dpr);
    var ringW3 = Math.max(3.2, cssSize * 0.052 * dpr);

    var rays = [
      { angle: baseAngle + (Math.PI * 0.5), sigmaU: 50 * dpr, gammaV: 1.7 * dpr, amp: 1.00 },
      { angle: baseAngle, sigmaU: 34 * dpr, gammaV: 1.9 * dpr, amp: 0.68 },
      { angle: baseAngle + (Math.PI * 0.25), sigmaU: 22 * dpr, gammaV: 2.1 * dpr, amp: 0.34 },
      { angle: baseAngle + (Math.PI * 0.75), sigmaU: 16 * dpr, gammaV: 2.2 * dpr, amp: 0.18 }
    ];

    function gaussian(x, sigma) {
      return Math.exp(-0.5 * (x * x) / Math.max(1e-6, sigma * sigma));
    }

    function lorentzian(x, gamma) {
      var ratio = x / Math.max(1e-6, gamma);
      return 1.0 / (1.0 + (ratio * ratio));
    }

    function addRgb(px, py, r, g, b, a) {
      if (!(a > 0.0)) { return; }
      var ix = ((py * width) + px) * 4;
      data[ix] = Math.min(255, data[ix] + Math.round(r * 255.0 * a));
      data[ix + 1] = Math.min(255, data[ix + 1] + Math.round(g * 255.0 * a));
      data[ix + 2] = Math.min(255, data[ix + 2] + Math.round(b * 255.0 * a));
      data[ix + 3] = Math.min(255, data[ix + 3] + Math.round(255.0 * a));
    }

    var globalScale = flareAlpha * edgeFade;
    for (var py = 0; py < height; py += 1) {
      var dy = py - cy;
      for (var px = 0; px < width; px += 1) {
        var dx = px - cx;
        var r = Math.sqrt((dx * dx) + (dy * dy));

        var core = 1.30 * gaussian(r, sigmaCore);
        var glow = 0.26 * gaussian(r, sigmaGlow);
        var rings =
          0.060 * gaussian(r - ring1, ringW1) +
          0.038 * gaussian(r - ring2, ringW2) +
          0.018 * gaussian(r - ring3, ringW3);

        var rayAccum = 0.0;
        for (var ri = 0; ri < rays.length; ri += 1) {
          var ray = rays[ri];
          var c = Math.cos(ray.angle);
          var s = Math.sin(ray.angle);
          var u = (dx * c) + (dy * s);
          var v = (-dx * s) + (dy * c);
          rayAccum += ray.amp * gaussian(u, ray.sigmaU) * lorentzian(v, ray.gammaV);
        }

        var whiteA = globalScale * (core + glow + (0.72 * rayAccum));
        var tintA = globalScale * ((0.65 * glow) + (0.35 * rings) + (0.28 * rayAccum));
        addRgb(px, py, 1.0, 1.0, 1.0, whiteA);
        addRgb(px, py, cr, cg, cb, tintA);
      }
    }

    ctx.clearRect(0, 0, width, height);
    ctx.putImageData(image, 0, 0);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    var ghostAlpha = 0.20 * globalScale * (0.4 + 0.6 * facing);
    if (ghostAlpha > 0.001) {
      var gx1 = cx - ((options.ghostDx1 || 0.0) * dpr);
      var gy1 = cy - ((options.ghostDy1 || 0.0) * dpr);
      var gx2 = cx - ((options.ghostDx2 || 0.0) * dpr);
      var gy2 = cy - ((options.ghostDy2 || 0.0) * dpr);
      var g1 = ctx.createRadialGradient(gx1, gy1, 0, gx1, gy1, cssSize * 0.05 * dpr);
      g1.addColorStop(0, "rgba(255,255,255," + (0.75 * ghostAlpha).toFixed(4) + ")");
      g1.addColorStop(0.45, "rgba(" + Math.round(cr * 255) + "," + Math.round(cg * 255) + "," + Math.round(cb * 255) + "," + ghostAlpha.toFixed(4) + ")");
      g1.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g1;
      ctx.beginPath();
      ctx.arc(gx1, gy1, cssSize * 0.05 * dpr, 0, Math.PI * 2);
      ctx.fill();

      var g2 = ctx.createRadialGradient(gx2, gy2, 0, gx2, gy2, cssSize * 0.03 * dpr);
      g2.addColorStop(0, "rgba(255,255,255," + (0.55 * ghostAlpha).toFixed(4) + ")");
      g2.addColorStop(0.5, "rgba(" + Math.round(cr * 255) + "," + Math.round(cg * 255) + "," + Math.round(cb * 255) + "," + (0.72 * ghostAlpha).toFixed(4) + ")");
      g2.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.arc(gx2, gy2, cssSize * 0.03 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function projectPointToScreen(camera, point, width, height) {
    if (camera && Array.isArray(camera.view_matrix) && camera.view_matrix.length === 16 && Array.isArray(camera.projection_matrix) && camera.projection_matrix.length === 16) {
      var viewPoint = transformPointMat4(camera.view_matrix, Number(point[0] || 0), Number(point[1] || 0), Number(point[2] || 0));
      var vx = Number(viewPoint[0] || 0);
      var vy = Number(viewPoint[1] || 0);
      var vz = Number(viewPoint[2] || 0);
      var proj = camera.projection_matrix;
      var clipX = (Number(proj[0]) * vx) + (Number(proj[4]) * vy) + (Number(proj[8]) * vz) + Number(proj[12] || 0);
      var clipY = (Number(proj[1]) * vx) + (Number(proj[5]) * vy) + (Number(proj[9]) * vz) + Number(proj[13] || 0);
      var clipW = (Number(proj[3]) * vx) + (Number(proj[7]) * vy) + (Number(proj[11]) * vz) + Number(proj[15] || 0);
      if (!(Math.abs(clipW) > 1e-6)) { return null; }
      var ndcX = clipX / clipW;
      var ndcY = clipY / clipW;
      if (ndcX < -1.02 || ndcX > 1.02 || ndcY < -1.02 || ndcY > 1.02) {
        return null;
      }
      return {
        x: ((ndcX * 0.5) + 0.5) * width,
        y: ((-ndcY * 0.5) + 0.5) * height,
        depth: Math.max(1e-3, Math.abs(vz)),
        ndcX: ndcX,
        ndcY: ndcY
      };
    }
    var eye = toVec3(camera.pos, [0, 0, 5]);
    var target = toVec3(camera.target, [0, 0, 0]);
    var up = toVec3(camera.up, [0, 0, 1]);
    var forward = normalize3([
      target[0] - eye[0],
      target[1] - eye[1],
      target[2] - eye[2]
    ], [0, 1, 0]);
    var right = normalize3(cross3(forward, up), [1, 0, 0]);
    var trueUp = normalize3(cross3(right, forward), [0, 0, 1]);
    var rel = [
      Number(point[0]) - eye[0],
      Number(point[1]) - eye[1],
      Number(point[2]) - eye[2]
    ];
    var viewX = dot3(rel, right);
    var viewY = dot3(rel, trueUp);
    var viewZ = dot3(rel, forward);
    if (!(viewZ > 1e-4)) { return null; }
    var aspect = Math.max(1e-4, width / Math.max(height, 1));
    var tanHalf = Math.tan((Number(camera.fov || 40.0) * Math.PI / 180.0) * 0.5);
    var ndcX = viewX / (viewZ * tanHalf * aspect);
    var ndcY = viewY / (viewZ * tanHalf);
    if (ndcX < -1.02 || ndcX > 1.02 || ndcY < -1.02 || ndcY > 1.02) {
      return null;
    }
    return {
      x: ((ndcX * 0.5) + 0.5) * width,
      y: ((-ndcY * 0.5) + 0.5) * height,
      depth: viewZ,
      ndcX: ndcX,
      ndcY: ndcY
    };
  }

  function segmentIntersectsAabb(start, end, min, max) {
    var dir = [
      Number(end[0]) - Number(start[0]),
      Number(end[1]) - Number(start[1]),
      Number(end[2]) - Number(start[2])
    ];
    var tMin = 0.0;
    var tMax = 1.0;
    for (var axis = 0; axis < 3; axis += 1) {
      var s = Number(start[axis]);
      var d = Number(dir[axis]);
      var lo = Number(min[axis]);
      var hi = Number(max[axis]);
      if (Math.abs(d) < 1e-8) {
        if (s < lo || s > hi) { return false; }
        continue;
      }
      var invD = 1.0 / d;
      var t0 = (lo - s) * invD;
      var t1 = (hi - s) * invD;
      if (t0 > t1) {
        var tmp = t0;
        t0 = t1;
        t1 = tmp;
      }
      tMin = Math.max(tMin, t0);
      tMax = Math.min(tMax, t1);
      if (tMax < tMin) { return false; }
    }
    return tMax > 1e-4 && tMin < (1.0 - 1e-4);
  }

  function lightOccludedByMeshes(camera, light, occluders) {
    var eye = toVec3(camera.pos, [0, 0, 0]);
    var lightPos = toVec3(light.pos, [0, 0, 0]);
    var items = Array.isArray(occluders) ? occluders : [];
    for (var i = 0; i < items.length; i += 1) {
      var mesh = items[i];
      var vertices = meshVerticesForOccluder(mesh);
      if (!vertices.length) { continue; }
      var bounds = computeBounds(vertices);
      var min = bounds.min;
      var max = bounds.max;
      if (segmentIntersectsAabb(eye, lightPos, min, max)) {
        return true;
      }
    }
    return false;
  }

  function lightFacingCamera(light, camera) {
    var pos = toVec3(light.pos, [0, 0, 0]);
    var toCamera = normalize3([
      Number(camera.pos[0]) - pos[0],
      Number(camera.pos[1]) - pos[1],
      Number(camera.pos[2]) - pos[2]
    ], [0, -1, 0]);
    if (String(light.kind || "point") !== "spot") {
      return 1.0;
    }
    var beamDir = Array.isArray(light.direction)
      ? normalize3(light.direction, [0, 1, 0])
      : normalize3([
          Number(light.target[0]) - pos[0],
          Number(light.target[1]) - pos[1],
          Number(light.target[2]) - pos[2]
        ], [0, 1, 0]);
    return clamp01(dot3(beamDir, toCamera));
  }

  function updateLightFlares(frame, camera, lights, occluders) {
    var layer = ensureFlareLayer(frame);
    if (!layer) { return; }
    var host = layer.parentElement || frame;
    var width = Math.max(1, host.clientWidth || 0);
    var height = Math.max(1, host.clientHeight || 0);
    var active = Object.create(null);
    for (var i = 0; i < lights.length; i += 1) {
      var light = lights[i];
      if (light.show_marker === false) { continue; }
      var projected = projectPointToScreen(camera, light.pos, width, height);
      if (!projected) { continue; }
      if (lightOccludedByMeshes(camera, light, occluders)) { continue; }
      var facing = lightFacingCamera(light, camera);
      var intensity = Math.max(0.0, Number(light.intensity || 24.0));
      var baseAlpha = Math.min(1.0, 0.30 + Math.min(0.70, intensity / 170.0));
      var flareAlpha = clamp01(baseAlpha * (0.30 + (0.70 * facing)));
      var size = Math.max(92, 120 + (intensity * 0.72) + (120 * facing));
      var node = ensureFlareElement(layer, i);
      var canvas = ensureFlareCanvas(node);
      var color = toRgba(light.color, [1.0, 1.0, 1.0, 1.0]);
      var cr = Math.round(color[0] * 255);
      var cg = Math.round(color[1] * 255);
      var cb = Math.round(color[2] * 255);
      var coreAlpha = clamp01(1.00 * flareAlpha);
      var innerAlpha = clamp01(0.78 * flareAlpha);
      var haloAlpha = clamp01(0.28 * flareAlpha);
      var streakAlpha = clamp01((0.28 + 0.62 * facing) * flareAlpha);
      var centerX = width * 0.5;
      var centerY = height * 0.5;
      var dx = projected.x - centerX;
      var dy = projected.y - centerY;
      var ghostAX = centerX - (dx * 0.42);
      var ghostAY = centerY - (dy * 0.42);
      var ghostBX = centerX - (dx * 0.78);
      var ghostBY = centerY - (dy * 0.78);
      var axisAngle = Math.atan2(dy, dx);
      node.style.display = "block";
      node.style.left = projected.x + "px";
      node.style.top = projected.y + "px";
      node.style.width = size + "px";
      node.style.height = size + "px";
      node.style.opacity = "1";
      node.style.filter = "none";
      node.style.background = "transparent";
      node.style.boxShadow = "none";
      drawAnalyticFlareCanvas(canvas, {
        size: Math.round(size * 1.8),
        flareAlpha: flareAlpha,
        facing: facing,
        edgeFade: 1.0,
        axisAngle: axisAngle,
        color: color,
        ghostDx1: dx * 0.42,
        ghostDy1: dy * 0.42,
        ghostDx2: dx * 0.78,
        ghostDy2: dy * 0.78
      });
      active[String(i)] = true;
    }
    var children = layer.querySelectorAll("[data-vf-light-flare]");
    for (var j = 0; j < children.length; j += 1) {
      var key = children[j].getAttribute("data-vf-light-flare") || "";
      if (!active[key]) {
        children[j].style.display = "none";
      }
    }
  }

  function buildSceneState(cameraOverride, seconds) {
    var camera = cameraOverride || makeCamera(config.camera || {}, { pos: [3.9, -5.6, 3.2], target: [0, 0, 0.9], fov: 34, up: [0, 0, 1], min_distance: 0.0 }, seconds);
    var lightSpecs = Array.isArray(config.lights)
      ? config.lights
      : (config.light ? [config.light] : []);
    var meshSpecs = Array.isArray(config.meshes) ? config.meshes.map(function (mesh) { return normalizeMeshSpec(mesh, seconds, camera); }) : [];
    var receivers = Array.isArray(config.shadow_receivers) ? config.shadow_receivers.map(normalizeShadowReceiverSpec) : [];
    var meshById = Object.create(null);
    for (var meshIndex = 0; meshIndex < meshSpecs.length; meshIndex += 1) {
      meshById[meshSpecs[meshIndex].id] = meshSpecs[meshIndex];
    }
    var lights = lightSpecs.map(function (entry) { return normalizeLight(entry, seconds); });
    for (var mirrorIndex = 0; mirrorIndex < meshSpecs.length; mirrorIndex += 1) {
      var mirrorMesh = meshSpecs[mirrorIndex];
      var surfaceSystem = mirrorMesh && mirrorMesh.surface_system && typeof mirrorMesh.surface_system === "object"
        ? mirrorMesh.surface_system
        : null;
      if (!surfaceSystem) {
        continue;
      }
      var surfaceKind = String(surfaceSystem.kind || "").toLowerCase().trim();
      if (surfaceKind === "mirror") {
        if (!surfaceSystem.world || typeof surfaceSystem.world !== "object") {
          surfaceSystem.world = {};
        }
        surfaceSystem.world.objects = buildSurfaceWorldObjects(meshSpecs, mirrorMesh.id);
      }
    }
    var meshes = [];
    var receiverIds = Object.create(null);
    for (var receiverIndex = 0; receiverIndex < receivers.length; receiverIndex += 1) {
      var receiver = receivers[receiverIndex] || {};
      var receiverMesh = meshById[String(receiver.receiver_mesh || "")];
      if (!receiverMesh || receiverMesh.kind !== "quad" || receiverMesh.visible === false) {
        continue;
      }
      receiverIds[receiverMesh.id] = true;
      var lightIds = Array.isArray(receiver.lights) ? receiver.lights.map(String) : [];
      void lightIds;
      var receiverPayload = buildMeshPayload(receiverMesh, camera, lights);
      if (Array.isArray(receiverPayload)) {
        for (var receiverPayloadIndex = 0; receiverPayloadIndex < receiverPayload.length; receiverPayloadIndex += 1) {
          if (receiverPayload[receiverPayloadIndex]) { meshes.push(receiverPayload[receiverPayloadIndex]); }
        }
      } else if (receiverPayload) {
        meshes.push(receiverPayload);
      }
    }
    for (var i = 0; i < meshSpecs.length; i += 1) {
      var mesh = meshSpecs[i];
      if (mesh.visible === false) { continue; }
      if (receiverIds[mesh.id]) { continue; }
      var meshPayload = buildMeshPayload(mesh, camera, lights);
      if (Array.isArray(meshPayload)) {
        for (var meshPayloadIndex = 0; meshPayloadIndex < meshPayload.length; meshPayloadIndex += 1) {
          if (meshPayload[meshPayloadIndex]) { meshes.push(meshPayload[meshPayloadIndex]); }
        }
      } else if (meshPayload) {
        meshes.push(meshPayload);
      }
    }
    if (renderOptions.show_light_markers === true) {
      var markerMeshes = buildLightMarkerMeshes(lights, camera, renderOptions.light_marker_size);
      for (var markerIndex = 0; markerIndex < markerMeshes.length; markerIndex += 1) {
        meshes.push(markerMeshes[markerIndex]);
      }
    }
    return {
      camera: camera,
      lights: lights,
      meshes: meshes,
      flare_occluders: meshSpecs.filter(function (mesh) { return mesh.kind === "cube" || mesh.kind === "random_hull" || mesh.kind === "convex_hull" || mesh.kind === "simplices"; })
    };
  }

  function renderPayload(cameraOverride, seconds) {
    var state = buildSceneState(cameraOverride, seconds);
    if (!state.meshes || !state.meshes.length) {
      failFast("scene resolved zero visible meshes");
    }
    var sceneBackground = resolveSceneBackgroundFallback();
    var geom = {};
    geom[String(frameSpec.frame_id || config.frame_id)] = {
      meshes: state.meshes,
      camera: state.camera,
      lights: state.lights,
      background: sceneBackground,
      light_flares: {
        enabled: renderOptions.light_flares === true,
        size: Number(renderOptions.light_marker_size || 0.18),
        lights: state.lights,
        occluders: state.flare_occluders
      },
      unified_renderer: true
    };
    return { payload: { screen: [], frames: {}, geom: geom }, state: state };
  }

  function resolveMeshSpecById(meshSpecs, meshId, purpose) {
    var targetId = String(meshId || "").trim();
    for (var i = 0; i < meshSpecs.length; i += 1) {
      if (String(meshSpecs[i] && meshSpecs[i].id || "") === targetId) {
        return meshSpecs[i];
      }
    }
    failFast(String(purpose || "camera setup") + ': mesh id "' + targetId + '" was not found');
  }

  function requirePlanarMirrorAdapterMethod(methodName, purpose) {
    var adapterApi = global.VfGeomWgpuUtil;
    if (!adapterApi || typeof adapterApi.createPlanarMirrorAdapter !== "function") {
      failFast(String(purpose || "camera setup") + ": planar mirror adapter factory is unavailable");
    }
    var adapter = adapterApi.createPlanarMirrorAdapter();
    if (!adapter || typeof adapter[methodName] !== "function") {
      failFast(String(purpose || "camera setup") + ': planar mirror adapter method "' + String(methodName) + '" is unavailable');
    }
    return adapter;
  }

  function fmtMirrorDebugVec3(value) {
    var v = Array.isArray(value) ? value : [];
    return "[" +
      (Number(v[0] || 0.0)).toFixed(4) + "," +
      (Number(v[1] || 0.0)).toFixed(4) + "," +
      (Number(v[2] || 0.0)).toFixed(4) + "]";
  }

  function debugMirrorCamera(label, camera, extra) {
    try {
      var debug = camera && camera._mirrorDebug && typeof camera._mirrorDebug === "object"
        ? camera._mirrorDebug
        : {};
      global.console.warn(
        "[DEBUG-MIRROR-CAMERA] label=" + String(label || "") +
        " frame=" + String(frameSpec && frameSpec.frame_id || config.frame_id || "") +
        " pos=" + fmtMirrorDebugVec3(camera && camera.pos) +
        " target=" + fmtMirrorDebugVec3(camera && camera.target) +
        " hasView=" + String(Array.isArray(camera && camera.view_matrix) && camera.view_matrix.length === 16) +
        " hasProj=" + String(Array.isArray(camera && camera.projection_matrix) && camera.projection_matrix.length === 16) +
        " planePoint=" + fmtMirrorDebugVec3(debug.planePoint) +
        " planeNormal=" + fmtMirrorDebugVec3(debug.planeNormal) +
        " clipApplied=" + String(debug.clipApplied === true) +
        (extra ? " " + String(extra) : "")
      );
    } catch (err) {
      void err;
    }
  }

  function resolveLinkedMirrorCamera(baseCamera, seconds) {
    var cameraCfg = config.camera || {};
    var props = cameraCfg && cameraCfg.properties && typeof cameraCfg.properties === "object"
      ? cameraCfg.properties
      : {};
    var sourceFrameId = String(props.reflect_of_frame_id || "").trim();
    var mirrorMeshId = String(props.reflect_mirror_mesh_id || "").trim();
    if (!sourceFrameId || !mirrorMeshId) {
      if (sourceFrameId || mirrorMeshId) {
        failFast("linked reflected camera requires both reflect_of_frame_id and reflect_mirror_mesh_id");
      }
      return baseCamera;
    }
    var sourceCamera = global.__vfNativeSceneLiveCameras[sourceFrameId];
    if (!sourceCamera || !Array.isArray(sourceCamera.pos) || !Array.isArray(sourceCamera.target)) {
      failFast('linked reflected camera source frame "' + sourceFrameId + '" is not registered');
    }
    var meshSpecs = Array.isArray(config.meshes)
      ? config.meshes.map(function (mesh) { return normalizeMeshSpec(mesh, seconds, sourceCamera); })
      : [];
    var mirrorMesh = resolveMeshSpecById(meshSpecs, mirrorMeshId, "linked reflected camera");
    try {
      var adapter = requirePlanarMirrorAdapterMethod("buildRenderCamera", "linked reflected camera");
      var mirrorPart = renderedMirrorPartForCamera(mirrorMesh, sourceCamera, "linked reflected camera");
      var frameRect = frameSpec && Array.isArray(frameSpec.rect) ? frameSpec.rect : [0, 0, 1, 1];
      var targetAspect = Math.max(1e-4, Number(frameRect[2] || 1.0) / Math.max(1e-4, Number(frameRect[3] || 1.0)));
      if (props.reflect_eye_only === true || props.lock_aperture_camera === true) {
        var planeSeed = buildMirrorEyeLockedCamera(sourceCamera, mirrorPart.mesh, baseCamera);
        var eyeLockedCamera = adapter.buildRenderCamera({
          part: mirrorPart,
          surfaceCamera: {
            pos: toVec3(sourceCamera.pos, [0.0, 0.0, 0.0]),
            target: toVec3(planeSeed.target, [0.0, 0.0, 0.0]),
            up: [0.0, 0.0, 1.0],
            fov: Number(sourceCamera.fov || 34.0) || 34.0,
            flip_x: planeSeed.flip_x === true
          },
          timeMs: seconds * 1000.0,
          targetAspect: targetAspect,
          math: global.VfGeomMath
        });
        debugMirrorCamera("linked-reflected-eye-locked", eyeLockedCamera, "source=" + sourceFrameId + " mirror=" + mirrorMeshId);
        return eyeLockedCamera;
      }
      var reflectedCamera = adapter.buildRenderCamera({
        part: mirrorPart,
        surfaceCamera: sourceCamera,
        timeMs: seconds * 1000.0,
        targetAspect: targetAspect,
        math: global.VfGeomMath
      });
      debugMirrorCamera("linked-reflected", reflectedCamera, "source=" + sourceFrameId + " mirror=" + mirrorMeshId);
      if (props.reflect_keep_world_up === true) {
        return {
          pos: toVec3(reflectedCamera.pos, toVec3(sourceCamera.pos, [0.0, 0.0, 0.0])),
          target: reflectedCamera && reflectedCamera._mirrorDebug && Array.isArray(reflectedCamera._mirrorDebug.reflectedTarget)
            ? toVec3(reflectedCamera._mirrorDebug.reflectedTarget, toVec3(reflectedCamera.target, [0.0, 0.0, 0.0]))
            : toVec3(reflectedCamera.target, [0.0, 0.0, 0.0]),
          up: toVec3(sourceCamera.up, [0.0, 0.0, 1.0]),
          fov: Number(reflectedCamera.fov || sourceCamera.fov || 34.0) || 34.0
        };
      }
      return reflectedCamera;
    } catch (err) {
      var message = err && err.message ? String(err.message) : String(err);
      failFast("linked reflected camera setup failed: " + message);
    }
  }

  function resolveMirrorApertureCamera(baseCamera, seconds, targetAspect) {
    var cameraCfg = config.camera || {};
    var props = cameraCfg && cameraCfg.properties && typeof cameraCfg.properties === "object"
      ? cameraCfg.properties
      : {};
    var mirrorMeshId = String(props.aperture_mirror_mesh_id || "").trim();
    if (!mirrorMeshId) {
      return baseCamera;
    }
    var forceAperture = props.lock_aperture_camera === true;
    if (Array.isArray(baseCamera && baseCamera.view_matrix) && baseCamera.view_matrix.length === 16 &&
        Array.isArray(baseCamera && baseCamera.projection_matrix) && baseCamera.projection_matrix.length === 16) {
      if (!forceAperture) {
        debugMirrorCamera("aperture-skip-existing-matrices", baseCamera, "mirror=" + mirrorMeshId);
        return baseCamera;
      }
      debugMirrorCamera("aperture-force-existing-matrices", baseCamera, "mirror=" + mirrorMeshId);
    }
    var meshSpecs = Array.isArray(config.meshes)
      ? config.meshes.map(function (mesh) { return normalizeMeshSpec(mesh, seconds, baseCamera); })
      : [];
    var mirrorMesh = resolveMeshSpecById(meshSpecs, mirrorMeshId, "aperture camera");
    try {
      var adapter = requirePlanarMirrorAdapterMethod("buildApertureCamera", "aperture camera");
      var mirrorPart = renderedMirrorPartForCamera(mirrorMesh, baseCamera, "aperture camera");
      var apertureCamera = adapter.buildApertureCamera({
        part: mirrorPart,
        surfaceCamera: baseCamera,
        timeMs: seconds * 1000.0,
        targetAspect: targetAspect,
        math: global.VfGeomMath
      });
      debugMirrorCamera("aperture-built", apertureCamera, "mirror=" + mirrorMeshId);
      return apertureCamera;
    } catch (err) {
      failFast("aperture camera setup failed: " + (err && err.message ? err.message : String(err)));
    }
  }

  function cameraBehaviorProps() {
    var cameraCfg = config.camera || {};
    var props = cameraCfg && cameraCfg.properties && typeof cameraCfg.properties === "object"
      ? cameraCfg.properties
      : {};
    if (cameraCfg && typeof cameraCfg === "object") {
      if (cameraCfg.controls_enabled !== undefined && props.controls_enabled === undefined) {
        props.controls_enabled = cameraCfg.controls_enabled;
      }
      if (cameraCfg.look_only_controls !== undefined && props.look_only_controls === undefined) {
        props.look_only_controls = cameraCfg.look_only_controls;
      }
      if (cameraCfg.controls_mode !== undefined && props.controls_mode === undefined) {
        props.controls_mode = cameraCfg.controls_mode;
      }
      if (props.controls_mode === "look_only" && props.look_only_controls === undefined) {
        props.look_only_controls = true;
      }
      if (cameraCfg.lock_aperture_camera !== undefined && props.lock_aperture_camera === undefined) {
        props.lock_aperture_camera = cameraCfg.lock_aperture_camera;
      }
    }
    return props;
  }

  function linkedSourceEyeKey() {
    var props = cameraBehaviorProps();
    var sourceFrameId = String(props.reflect_of_frame_id || "").trim();
    if (!sourceFrameId) { return ""; }
    var sourceCamera = global.__vfNativeSceneLiveCameras[sourceFrameId];
    if (!sourceCamera || !Array.isArray(sourceCamera.pos)) { return ""; }
    var pos = toVec3(sourceCamera.pos, [0.0, 0.0, 0.0]);
    return [
      Number(pos[0]).toFixed(6),
      Number(pos[1]).toFixed(6),
      Number(pos[2]).toFixed(6)
    ].join(",");
  }

  function registerFrameDependent(sourceFrameId, dependentFrameId, callback) {
    var key = String(sourceFrameId || "").trim();
    var depKey = String(dependentFrameId || "").trim();
    if (!key || !depKey || typeof callback !== "function") { return; }
    var registry = global.__vfNativeSceneFrameDependents;
    if (!registry[key]) {
      registry[key] = Object.create(null);
    }
    registry[key][depKey] = callback;
  }

  function triggerFrameDependents(sourceFrameId) {
    var key = String(sourceFrameId || "").trim();
    if (!key) { return; }
    var registry = global.__vfNativeSceneFrameDependents;
    var deps = registry && registry[key];
    if (!deps || typeof deps !== "object") { return; }
    var keys = Object.keys(deps);
    for (var i = 0; i < keys.length; i += 1) {
      var fn = deps[keys[i]];
      if (typeof fn !== "function") { continue; }
      try {
        fn();
      } catch (err) {
        failFast("dependent frame render failed for " + keys[i] + ": " + (err && err.message ? err.message : String(err)));
      }
    }
  }

  function fittedViewAspect(frameEl, bodyEl) {
    try {
      if (global.VfDisplay && typeof global.VfDisplay.geomFrameViewAspect === "function") {
        var frameId = String(frameSpec.frame_id || config.frame_id || "").trim();
        var exact = Number(global.VfDisplay.geomFrameViewAspect(frameId) || 0.0);
        if (exact > 1e-6) { return exact; }
      }
    } catch (err) {
      failFast("frame aspect lookup failed: " + (err && err.message ? err.message : String(err)));
    }
    var rect = bodyEl && typeof bodyEl.getBoundingClientRect === "function"
      ? bodyEl.getBoundingClientRect()
      : { width: 1, height: 1 };
    var width = Math.max(1, Number(rect.width || 1));
    var height = Math.max(1, Number(rect.height || 1));
    return Math.max(1e-4, width / Math.max(1, height));
  }

  function sceneFrameVisible() {
    return !((frameSpec && frameSpec.visible === false) || (config && config.visible === false));
  }

  function offscreenFramePixels() {
    var rect = frameSpec && Array.isArray(frameSpec.rect) ? frameSpec.rect : [0, 0, 1, 1];
    var viewportW = Math.max(1, Number(global.innerWidth || 1280) || 1280);
    var viewportH = Math.max(1, Number(global.innerHeight || 720) || 720);
    var width = Math.max(1, Math.round(viewportW * Math.max(0.01, Number(rect[2] || 1.0))));
    var height = Math.max(1, Math.round(viewportH * Math.max(0.01, Number(rect[3] || 1.0))));
    if (String(frameSpec && frameSpec.aspect || "").toLowerCase() === "equal") {
      var fit = Math.max(1, Math.min(width, height));
      width = fit;
      height = fit;
    }
    return { width: width, height: height };
  }

  function visibleFramePixels(frameEl, bodyEl) {
    var rect = bodyEl && typeof bodyEl.getBoundingClientRect === "function"
      ? bodyEl.getBoundingClientRect()
      : { width: 1, height: 1 };
    var width = Math.max(1, Number(rect.width || 1) || 1);
    var height = Math.max(1, Number(rect.height || 1) || 1);
    if (String(frameSpec && frameSpec.aspect || "").toLowerCase() === "equal") {
      var fit = Math.max(1, Math.min(width, height));
      width = fit;
      height = fit;
    }
    return { width: width, height: height };
  }

  function frameCameraConfigSignature() {
    try {
      return JSON.stringify({
        frame_id: frameSpec && frameSpec.frame_id || config.frame_id || "",
        visible: frameSpec && frameSpec.visible,
        camera: config.camera || null,
        meshes: (Array.isArray(config.meshes) ? config.meshes : []).map(function (mesh) {
          return {
            id: mesh && mesh.id,
            kind: mesh && mesh.kind,
            properties: mesh && mesh.properties,
            center: mesh && mesh.center,
            size: mesh && mesh.size,
            rotation: mesh && mesh.rotation,
            transform: mesh && mesh.transform,
            surface_system: mesh && mesh.surface_system,
            reverse_facing: mesh && mesh.reverse_facing
          };
        })
      });
    } catch (err) {
      failFast("frame camera config signature failed: " + (err && err.message ? err.message : String(err)));
    }
  }

  function boot() {
    requireRuntime();
    var frame = document.querySelector('.vf-frame[data-vf-frame-id="' + String(frameSpec.frame_id || config.frame_id) + '"]');
    var body = frame ? frame.querySelector(".vf-frame__body") : null;
    var cameraFallback = { pos: [3.9, -5.6, 3.2], target: [0, 0, 0.9], fov: 34, up: [0, 0, 1], min_distance: 0.0 };
    var watchedFrameId = String(frameSpec.frame_id || config.frame_id);
    if (!global.__vfNativeSceneCameraControls) {
      global.__vfNativeSceneCameraControls = {
        activeFrameId: "",
        states: Object.create(null)
      };
    }
    var controlRegistry = global.__vfNativeSceneCameraControls;
    if (!controlRegistry.states[watchedFrameId]) {
        controlRegistry.states[watchedFrameId] = {
          zoomFactor: 1.0,
          orbitPhi: 0.0,
          orbitTheta: 0.0,
          orbitStep: cameraOrbitStepRadians(config.camera || {}),
          orbitSpeedRadPerSec: Math.max(cameraOrbitStepRadians(config.camera || {}) * 18.0, Math.PI * 0.45),
          controlsEnabled: cameraBehaviorProps().controls_enabled !== false,
          lookOnlyControls: cameraBehaviorProps().look_only_controls === true,
          lockApertureCamera: cameraBehaviorProps().lock_aperture_camera === true,
          apertureInitDone: false,
          userInteracted: false,
          linkedEyeKey: "",
          baseCamera: null,
          exactInitCamera: null,
          rendering: false,
          lastRenderTsMs: 0.0,
          keyLeft: false,
          keyRight: false,
          keyUp: false,
          keyDown: false,
          dependencyWaitStartMs: 0.0
        };
      }
    var controlState = controlRegistry.states[watchedFrameId];
    var configSignature = frameCameraConfigSignature();
    controlState.zoomFactor = 1.0;
    controlState.orbitPhi = 0.0;
    controlState.orbitTheta = 0.0;
    controlState.keyLeft = false;
    controlState.keyRight = false;
    controlState.keyUp = false;
    controlState.keyDown = false;
    controlState.apertureInitDone = false;
    controlState.userInteracted = false;
    controlState.linkedEyeKey = "";
    controlState.baseCamera = null;
    controlState.exactInitCamera = null;
    controlState.dependencyWaitStartMs = 0.0;
    controlState.configSignature = configSignature;
    var useVisibleFrame = sceneFrameVisible();
    var dependencySourceFrameId = String(cameraBehaviorProps().reflect_of_frame_id || "").trim();
    var offscreenSpec = null;
    var offscreenMounted = false;
    var visibleSpec = null;
    var visibleMounted = false;
    var offscreenPixels = null;
    if (!useVisibleFrame) {
      if (!global.VfDisplay || typeof global.VfDisplay.mountOffscreenGeomFrame !== "function") {
        failFast("offscreen scene frame support is unavailable");
      }
      offscreenPixels = offscreenFramePixels();
      if (dependencySourceFrameId) {
        registerFrameDependent(dependencySourceFrameId, watchedFrameId, function () {
          if (controlState.rendering === true) { return; }
          renderFrame();
        });
      }
    }
    function ensureVisibleGeomMount() {
      if (!useVisibleFrame || visibleMounted) { return; }
      if (!global.VfDisplay || typeof global.VfDisplay.mountDynamicGeomFrame !== "function") {
        failFast("visible scene frame support is unavailable");
      }
      global.VfDisplay.mountDynamicGeomFrame(watchedFrameId, function () {
        return visibleSpec;
      });
      visibleMounted = true;
    }
    function pushVisibleRender(rendered) {
      var payload = rendered && rendered.payload && typeof rendered.payload === "object"
        ? rendered.payload
        : { screen: [], frames: {}, geom: {} };
      var geomPayload = payload.geom && typeof payload.geom === "object"
        ? payload.geom[watchedFrameId] || null
        : null;
      var has2dPayload = !!(
        (Array.isArray(payload.screen) && payload.screen.length > 0) ||
        (payload.frames && typeof payload.frames === "object" && Object.keys(payload.frames).length > 0)
      );
      if (geomPayload && !has2dPayload) {
        var nextVisibleSpec = cloneJsonValue(geomPayload);
        if (nextVisibleSpec && nextVisibleSpec.camera && frame && body) {
          var fitRect = visibleFramePixels(frame, body);
          nextVisibleSpec.camera = Object.assign({}, nextVisibleSpec.camera, {
            viewport_width_px: Math.max(1, Math.round(fitRect.width || 1)),
            viewport_height_px: Math.max(1, Math.round(fitRect.height || 1))
          });
        }
        visibleSpec = nextVisibleSpec;
        ensureVisibleGeomMount();
        global.VfDisplay.requestDynamicGeomFrameUpdate(watchedFrameId);
        return;
      }
      global.VfDisplay.renderFromJson(payload);
    }
    function markActiveFrame() {
      controlRegistry.activeFrameId = watchedFrameId;
    }
    function applyWheelZoom(state, ev) {
      if (!state) { return; }
      if (state.controlsEnabled === false) { return; }
      if (ev && typeof ev.preventDefault === "function") {
        ev.preventDefault();
      }
      var rawDelta = Number(ev && ev.deltaY);
      var direction = rawDelta > 0 ? 1 : -1;
      var magnitude = Math.max(1.0, Math.min(4.0, Math.abs(rawDelta) / 100.0 || 1.0));
      var step = 0.25 * magnitude;
      var factor = direction > 0 ? (1.0 + step) : (1.0 / (1.0 + step));
      state.zoomFactor = Math.max(1e-6, Number(state.zoomFactor || 1.0) * factor);
      state.userInteracted = true;
    }
    function handleWheelZoom(ev) {
      markActiveFrame();
      applyWheelZoom(controlState, ev);
    }
    function attachFrameZoomTarget(target) {
      if (!target || target.__vfWheelZoomAttached) { return; }
      target.__vfWheelZoomAttached = true;
      target.addEventListener("pointerenter", markActiveFrame, { passive: true });
      target.addEventListener("pointermove", markActiveFrame, { passive: true });
      target.addEventListener("pointerdown", markActiveFrame, { passive: true });
    }
    function eventFrameId(ev) {
      var target = ev && ev.target;
      var frameEl = target && typeof target.closest === "function" ? target.closest(".vf-frame") : null;
      if (!frameEl && ev && typeof ev.composedPath === "function") {
        var path = ev.composedPath();
        for (var i = 0; i < path.length; i++) {
          var node = path[i];
          if (node && typeof node.getAttribute === "function" && node.classList && node.classList.contains("vf-frame")) {
            frameEl = node;
            break;
          }
        }
      }
      return frameEl ? String(frameEl.getAttribute("data-vf-frame-id") || "").trim() : "";
    }
    function keyEventTargetsTextInput(ev) {
      var target = ev && ev.target;
      if (!target) { return false; }
      var tagName = String(target.tagName || "").toLowerCase();
      if (tagName === "input" || tagName === "textarea" || tagName === "select") { return true; }
      return target.isContentEditable === true;
    }
    function keyEventAllowedForActiveFrame(ev, activeFrameId) {
      if (keyEventTargetsTextInput(ev)) { return false; }
      var fid = eventFrameId(ev);
      return !fid || fid === activeFrameId;
    }
    if (useVisibleFrame) {
      attachFrameZoomTarget(frame);
      attachFrameZoomTarget(body);
      markActiveFrame();
    }
    if (!global.__vfNativeSceneGlobalWheelAttached) {
      global.__vfNativeSceneGlobalWheelAttached = true;
      global.addEventListener("wheel", function (ev) {
        var registry = global.__vfNativeSceneCameraControls;
        var activeFrameId = String(registry && registry.activeFrameId || "").trim();
        if (!activeFrameId) { return; }
        var activeState = registry && registry.states ? registry.states[activeFrameId] : null;
        if (!activeState) { return; }
        var fid = eventFrameId(ev);
        if (!fid || fid !== activeFrameId) { return; }
        applyWheelZoom(activeState, ev);
      }, { passive: false, capture: true });
    }
    if (!global.__vfNativeSceneArrowOrbitAttached) {
      global.__vfNativeSceneArrowOrbitAttached = true;
      global.addEventListener("keydown", function (ev) {
        var key = String(ev && ev.key || "");
        if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "ArrowUp" && key !== "ArrowDown") { return; }
        var activeFrameId = String(global.__vfNativeSceneCameraControls && global.__vfNativeSceneCameraControls.activeFrameId || "").trim();
        var activeState = activeFrameId && global.__vfNativeSceneCameraControls && global.__vfNativeSceneCameraControls.states
          ? global.__vfNativeSceneCameraControls.states[activeFrameId]
          : null;
        if (!activeState) { return; }
        if (activeState.controlsEnabled === false) { return; }
        if (!keyEventAllowedForActiveFrame(ev, activeFrameId)) { return; }
        ev.preventDefault();
        if (key === "ArrowLeft") { activeState.keyLeft = true; }
        else if (key === "ArrowRight") { activeState.keyRight = true; }
        else if (key === "ArrowUp") { activeState.keyUp = true; }
        else if (key === "ArrowDown") { activeState.keyDown = true; }
        activeState.userInteracted = true;
      }, true);
      global.addEventListener("keyup", function (ev) {
        var key = String(ev && ev.key || "");
        if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "ArrowUp" && key !== "ArrowDown") { return; }
        var activeFrameId = String(global.__vfNativeSceneCameraControls && global.__vfNativeSceneCameraControls.activeFrameId || "").trim();
        var activeState = activeFrameId && global.__vfNativeSceneCameraControls && global.__vfNativeSceneCameraControls.states
          ? global.__vfNativeSceneCameraControls.states[activeFrameId]
          : null;
        if (!activeState) { return; }
        if (!keyEventAllowedForActiveFrame(ev, activeFrameId)) { return; }
        if (key === "ArrowLeft") { activeState.keyLeft = false; }
        else if (key === "ArrowRight") { activeState.keyRight = false; }
        else if (key === "ArrowUp") { activeState.keyUp = false; }
        else if (key === "ArrowDown") { activeState.keyDown = false; }
      }, true);
      global.addEventListener("blur", function () {
        var registry = global.__vfNativeSceneCameraControls;
        if (!registry || !registry.states) { return; }
        var frameIds = Object.keys(registry.states);
        for (var i = 0; i < frameIds.length; i += 1) {
          var state = registry.states[frameIds[i]];
          if (!state) { continue; }
          state.keyLeft = false;
          state.keyRight = false;
          state.keyUp = false;
          state.keyDown = false;
        }
      }, true);
    }

    function ensureGeomRendererReady(attempt) {
      var status = global.VfDisplay && typeof global.VfDisplay.geomFrameStatus === "function"
        ? global.VfDisplay.geomFrameStatus(watchedFrameId)
        : null;
      if (status && status.runningRenderers > 0) {
        clearStatusOverlay();
        return;
      }
      if (status) {
        var runtimeFailures = Array.isArray(status.runtimeFailures) ? status.runtimeFailures.filter(Boolean) : [];
        var initFailures = Array.isArray(status.initFailures) ? status.initFailures.filter(Boolean) : [];
        if (runtimeFailures.length || initFailures.length) {
          failFast("geom renderer failed for frame " + watchedFrameId + ": " + JSON.stringify(status || {}));
        }
      }
      if (attempt > 240) {
        return;
      }
      global.setTimeout(function () { ensureGeomRendererReady(attempt + 1); }, 16);
    }

    function renderFrame() {
        if (controlState.rendering === true) { return; }
        controlState.rendering = true;
        try {
          var seconds = (global.performance && typeof global.performance.now === "function")
            ? (global.performance.now() * 0.001)
            : (Date.now() * 0.001);
          var nowMs = seconds * 1000.0;
          if (!useVisibleFrame && dependencySourceFrameId) {
            var dependencyCamera = global.__vfNativeSceneLiveCameras && global.__vfNativeSceneLiveCameras[dependencySourceFrameId];
            if (!dependencyCamera || !Array.isArray(dependencyCamera.pos) || !Array.isArray(dependencyCamera.target)) {
              if (!(controlState.dependencyWaitStartMs > 0.0)) {
                controlState.dependencyWaitStartMs = nowMs;
              }
              if ((nowMs - controlState.dependencyWaitStartMs) > 4000.0) {
                failFast('dependent reflected frame "' + watchedFrameId + '" timed out waiting for source frame "' + dependencySourceFrameId + '"');
              }
              controlState.rendering = false;
              global.setTimeout(renderFrame, 16);
              return;
            }
            controlState.dependencyWaitStartMs = 0.0;
          }
          var dtSec = controlState.lastRenderTsMs > 0
            ? Math.max(0.0, Math.min(0.1, (nowMs - controlState.lastRenderTsMs) * 0.001))
            : (1.0 / 60.0);
          controlState.lastRenderTsMs = nowMs;
          if (controlState.controlsEnabled !== false) {
            var orbitSpeed = Number(controlState.orbitSpeedRadPerSec || 0.0) || 0.0;
            if (orbitSpeed > 0.0) {
              var deltaPhi = 0.0;
              var deltaTheta = 0.0;
              if (controlState.keyLeft) { deltaPhi -= orbitSpeed * dtSec; }
              if (controlState.keyRight) { deltaPhi += orbitSpeed * dtSec; }
              if (controlState.keyUp) { deltaTheta += orbitSpeed * dtSec; }
              if (controlState.keyDown) { deltaTheta -= orbitSpeed * dtSec; }
              if (deltaPhi !== 0.0 || deltaTheta !== 0.0) {
                controlState.orbitPhi += deltaPhi;
                controlState.orbitTheta += deltaTheta;
                controlState.userInteracted = true;
              }
            }
          }
          var authoredCamera = makeCamera(config.camera || {}, cameraFallback, seconds);
          if (controlState.lockApertureCamera === true) {
            var currentEyeKey = linkedSourceEyeKey();
            if (!controlState.exactInitCamera || currentEyeKey !== controlState.linkedEyeKey) {
              var lockedCamera = resolveLinkedMirrorCamera(authoredCamera, seconds);
            var lockedAspect = useVisibleFrame
              ? fittedViewAspect(frame, body)
              : (offscreenFramePixels().width / Math.max(1, offscreenFramePixels().height));
              lockedCamera = resolveMirrorApertureCamera(lockedCamera, seconds, lockedAspect);
              controlState.baseCamera = cloneCameraState(lockedCamera, cameraFallback);
              controlState.exactInitCamera = cloneCameraState(lockedCamera, cameraFallback);
              controlState.linkedEyeKey = currentEyeKey;
            }
            controlState.apertureInitDone = true;
            controlState.userInteracted = false;
          }
          if (!controlState.apertureInitDone) {
            var initCamera = resolveLinkedMirrorCamera(authoredCamera, seconds);
            var initAspect = useVisibleFrame
              ? fittedViewAspect(frame, body)
              : (offscreenFramePixels().width / Math.max(1, offscreenFramePixels().height));
            initCamera = resolveMirrorApertureCamera(initCamera, seconds, initAspect);
            controlState.baseCamera = cloneCameraState(initCamera, cameraFallback);
            controlState.exactInitCamera = cloneCameraState(initCamera, cameraFallback);
            controlState.apertureInitDone = true;
          }
          var baseCamera = controlState.baseCamera
            ? cloneCameraState(controlState.baseCamera, cameraFallback)
            : authoredCamera;
          var userCamera;
          if (controlState.lookOnlyControls === true) {
            var zoomedBaseCamera = Math.abs(Number(controlState.zoomFactor || 1.0) - 1.0) > 1e-6
              ? zoomCamera(baseCamera, Number(controlState.zoomFactor || 1.0))
              : baseCamera;
            userCamera = Math.abs(Number(controlState.orbitPhi || 0.0)) > 1e-9
              ? rotateCameraLookAroundEye(zoomedBaseCamera, Number(controlState.orbitPhi || 0.0))
              : zoomedBaseCamera;
          } else {
            var orbitCamera = (Math.abs(Number(controlState.orbitPhi || 0.0)) > 1e-9 || Math.abs(Number(controlState.orbitTheta || 0.0)) > 1e-9)
              ? orbitCameraAroundTarget(baseCamera, Number(controlState.orbitPhi || 0.0), Number(controlState.orbitTheta || 0.0))
              : baseCamera;
            userCamera = Math.abs(Number(controlState.zoomFactor || 1.0) - 1.0) > 1e-6
              ? zoomCamera(orbitCamera, Number(controlState.zoomFactor || 1.0))
              : orbitCamera;
          }
          var renderCamera = controlState.userInteracted !== true && controlState.exactInitCamera
            ? cloneCameraState(controlState.exactInitCamera, cameraFallback)
            : userCamera;
          var markerReferenceHeightPx;
          if (useVisibleFrame) {
            markerReferenceHeightPx = Math.max(
              1,
              Math.round((body && body.getBoundingClientRect ? body.getBoundingClientRect().height : 0) || 0) ||
              Math.round(Number(global.innerHeight || 720) || 720)
            );
          } else {
            var sourceMarkerReferenceHeightPx = 0;
            if (dependencySourceFrameId && global.__vfNativeSceneLiveCameras) {
              sourceMarkerReferenceHeightPx = Number(
                global.__vfNativeSceneLiveCameras[dependencySourceFrameId] &&
                global.__vfNativeSceneLiveCameras[dependencySourceFrameId].viewport_marker_reference_height_px || 0
              ) || 0;
            }
            markerReferenceHeightPx = sourceMarkerReferenceHeightPx > 0
              ? Math.max(1, Math.round(sourceMarkerReferenceHeightPx))
              : Math.max(1, Number(offscreenPixels && offscreenPixels.height || 0) || 1);
          }
          var markerSizeCamera = null;
          if (!useVisibleFrame && dependencySourceFrameId && global.__vfNativeSceneLiveCameras) {
            var sourceMarkerCamera = global.__vfNativeSceneLiveCameras[dependencySourceFrameId];
            if (sourceMarkerCamera && typeof sourceMarkerCamera === "object") {
              markerSizeCamera = Object.assign({}, sourceMarkerCamera);
              if (!(Number(markerSizeCamera.viewport_height_px || 0) > 0)) {
                markerSizeCamera.viewport_height_px = Number(markerSizeCamera.viewport_marker_reference_height_px || 0) || 0;
              }
            }
          }
          var liveCamera = {
            pos: toVec3(renderCamera.pos, [0, 0, 0]),
            target: toVec3(renderCamera.target, [0, 0, 0]),
            up: toVec3(renderCamera.up, [0, 0, 1]),
            fov: Number(renderCamera.fov || 34.0) || 34.0,
            viewport_height_px: markerReferenceHeightPx,
            viewport_marker_reference_height_px: markerReferenceHeightPx,
            flip_x: renderCamera.flip_x === true
          };
          renderCamera.viewport_marker_reference_height_px = markerReferenceHeightPx;
          renderCamera.viewport_height_px = markerReferenceHeightPx;
          if (markerSizeCamera) {
            renderCamera._marker_size_camera = markerSizeCamera;
          }
          if (Array.isArray(renderCamera.view_matrix) && renderCamera.view_matrix.length === 16) {
            liveCamera.view_matrix = renderCamera.view_matrix.slice();
          }
          if (Array.isArray(renderCamera.projection_matrix) && renderCamera.projection_matrix.length === 16) {
            liveCamera.projection_matrix = renderCamera.projection_matrix.slice();
          }
          global.__vfNativeSceneLiveCameras[String(frameSpec.frame_id || config.frame_id)] = liveCamera;
        if (useVisibleFrame) {
          triggerFrameDependents(String(frameSpec.frame_id || config.frame_id));
        }
        if (!useVisibleFrame && renderCamera && renderCamera._skip_render === true) {
          if (!dependencySourceFrameId) {
            global.requestAnimationFrame(renderFrame);
          }
          controlState.rendering = false;
          return;
        }
        var rendered = renderPayload(renderCamera, seconds);
        if (useVisibleFrame) {
          pushVisibleRender(rendered);
        } else {
          offscreenSpec = rendered.payload && rendered.payload.geom
            ? rendered.payload.geom[watchedFrameId] || null
            : null;
          if (!offscreenMounted) {
            global.VfDisplay.mountOffscreenGeomFrame(watchedFrameId, function () {
              return offscreenSpec;
            }, offscreenPixels.width, offscreenPixels.height);
            offscreenMounted = true;
          }
          global.VfDisplay.requestDynamicGeomFrameUpdate(watchedFrameId);
        }
        controlState.rendering = false;
        if (useVisibleFrame || !dependencySourceFrameId) {
          global.requestAnimationFrame(renderFrame);
        }
      } catch (err) {
        controlState.rendering = false;
        failFast("render loop failed: " + (err && err.message ? err.message : String(err)));
      }
    }
    renderFrame();
    if (useVisibleFrame) {
      ensureGeomRendererReady(0);
    }
  }

  function waitForFrame(attempt) {
    if (!requireRuntime()) {
      if (attempt > 240) {
        failFast("VfDisplay.renderFromJson is unavailable");
      }
      global.setTimeout(function () { waitForFrame(attempt + 1); }, 16);
      return;
    }
    if (!sceneFrameVisible()) {
      boot();
      return;
    }
    var frame = document.querySelector('.vf-frame[data-vf-frame-id="' + String(frameSpec.frame_id || config.frame_id) + '"]');
    if (frame) {
      boot();
      return;
    }
    if (attempt > 240) {
      failFast("timed out waiting for scene frame");
    }
    global.setTimeout(function () { waitForFrame(attempt + 1); }, 16);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { waitForFrame(0); }, { once: true });
  } else {
    waitForFrame(0);
  }
})(typeof window !== "undefined" ? window : this);
