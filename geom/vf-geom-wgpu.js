/**
 * WebGPU renderer: packed vertex layout pos(3)+normal(3)+color(4) = 10 f32 = 40 bytes/vertex.
 * Lighting model: unified blinn_phong shading. Legacy names are normalized to
 * this single renderer path for compatibility, but the shader no longer
 * branches by model.
 * Camera and lights are passed in from mesh.camera / mesh.lights.
 * Depends: vf-geom-math.js (VfGeomMath)
 */
(function (global) {
  "use strict";

  var RUNTIME_ASSET_VERSION = String(global.__vfRuntimeAssetVersion || "");
  var _vfGeomLastLogKey = "";
  var _vfGeomLastLogTime = 0;
  var _vfGeomSuppressedCount = 0;
  var _vfGeomLogThrottleMs = 250;

  function wlog(level, text) {
    var s = "[vf-geom-wgpu] " + String(text);
    var now = Date.now();
    var key = String(level || "info") + "::" + s;
    if (key === _vfGeomLastLogKey && (now - _vfGeomLastLogTime) < _vfGeomLogThrottleMs) {
      _vfGeomSuppressedCount += 1;
      return;
    }
    if (_vfGeomSuppressedCount > 0 && global.console && global.console.warn) {
      try {
        global.console.warn("[vf-geom-wgpu] suppressed repeated log x" + String(_vfGeomSuppressedCount) + ": " + _vfGeomLastLogKey.replace(/^[^:]+::/, ""));
      } catch (_) {}
      _vfGeomSuppressedCount = 0;
    }
    _vfGeomLastLogKey = key;
    _vfGeomLastLogTime = now;
    try {
      if (!global.__vfGeomWgpuLog) { global.__vfGeomWgpuLog = []; }
      global.__vfGeomWgpuLog.push({
        level: String(level || "info"),
        message: s,
        t: Date.now()
      });
      if (global.__vfGeomWgpuLog.length > 80) {
        global.__vfGeomWgpuLog.splice(0, global.__vfGeomWgpuLog.length - 80);
      }
      global.__vfGeomWgpuLastLog = s;
      if (level === "error") {
        global.__vfGeomWgpuLastError = s;
      }
    } catch (e) {}
    try {
      if (global.console) {
        if (level === "error" && global.console.error) { global.console.error(s); }
        else if (global.console.warn) { global.console.warn(s); }
        else if (global.console.log) { global.console.log(s); }
      }
    } catch (e) {}
    try {
      if (global.chrome && global.chrome.webview && global.chrome.webview.postMessage) {
        global.chrome.webview.postMessage({ type: "vf_log", level: level, message: s, t: Date.now() });
      }
    } catch (e) {}
  }

  function failFast(message) {
    var text = String(message);
    wlog("error", text);
    throw new Error("[vf-geom-wgpu] " + text);
  }

  function failFastAsync(message) {
    var text = String(message);
    wlog("error", text);
    setTimeout(function () {
      throw new Error("[vf-geom-wgpu] " + text);
    }, 0);
  }

  function perfNowMs() {
    return global.performance && typeof global.performance.now === "function"
      ? global.performance.now()
      : Date.now();
  }

  function ensurePerfStats(renderer) {
    if (!renderer._perfStats) {
      renderer._perfStats = {
        frames: 0,
        metrics: Object.create(null)
      };
    }
    return renderer._perfStats;
  }

  function recordPerfMetric(stats, name, value) {
    if (!stats || !name) { return; }
    var v = Number(value);
    if (!Number.isFinite(v)) { return; }
    var metric = stats.metrics[name];
    if (!metric) {
      metric = stats.metrics[name] = { sum: 0, sumSq: 0 };
    }
    metric.sum += v;
    metric.sumSq += (v * v);
  }

  function flushPerfStats(renderer) {
    var stats = renderer && renderer._perfStats;
    if (!stats || stats.frames < 1000) { return; }
    var frameLabel = String(renderer._frameId || "frame");
    var modeLabel = renderer._offscreenFrame === true ? "offscreen" : "visible";
    var order = [
      "total",
      "get_mesh",
      "upload",
      "shadow_prepare",
      "shadow_cache_hit",
      "shadow_submit",
      "scene_pass",
      "surface_pass",
      "final_pass",
      "flares",
      "pick",
      "submit"
    ];
    var parts = [];
    for (var i = 0; i < order.length; i += 1) {
      var name = order[i];
      var metric = stats.metrics[name];
      if (!metric) { continue; }
      var mean = metric.sum / Math.max(1, stats.frames);
      var variance = Math.max(0, (metric.sumSq / Math.max(1, stats.frames)) - (mean * mean));
      var std = Math.sqrt(variance);
      parts.push(name + "=" + mean.toFixed(2) + "+/-" + std.toFixed(2) + "ms");
    }
    wlog("info", "[perf " + frameLabel + " " + modeLabel + "] avg/std over " + stats.frames + " frames: " + parts.join(" "));
    stats.frames = 0;
    stats.metrics = Object.create(null);
  }

  function maybeLogResolvedLights(renderer, label, lights) {
    if (!renderer) { return; }
    var now = Date.now();
    if ((now - Number(renderer._debugLastResolvedLightLogAt || 0)) < 800) {
      return;
    }
    renderer._debugLastResolvedLightLogAt = now;
    var out = [];
    for (var i = 0; i < Math.min(4, Array.isArray(lights) ? lights.length : 0); i += 1) {
      var light = lights[i];
      if (!light) { continue; }
      out.push(
        (light.id || ("light" + i)) +
        "{kind=" + String(light.kind || "") +
        ",I=" + Number(light.intensity || 0).toFixed(2) +
        ",R=" + Number(light.range || 0).toFixed(2) +
        ",shadow=" + String(light.casts_shadow !== false) +
        ",pos=[" + Number((light.pos && light.pos[0]) || 0).toFixed(2) +
        "," + Number((light.pos && light.pos[1]) || 0).toFixed(2) +
        "," + Number((light.pos && light.pos[2]) || 0).toFixed(2) + "]}"
      );
    }
    wlog("info", "[lights " + String(renderer._frameId || "frame") + " " + (renderer._offscreenFrame === true ? "offscreen" : "visible") + " " + String(label || "") + "] " + out.join(" "));
  }

  function maybeLogMirrorCamera(renderer, mesh) {
    if (!renderer || !mesh || !mesh.camera || !mesh.camera._mirrorDebug) { return; }
    var now = Date.now();
    if ((now - Number(renderer._debugLastMirrorCameraLogAt || 0)) < 800) {
      return;
    }
    renderer._debugLastMirrorCameraLogAt = now;
    var cam = mesh.camera || {};
    var dbg = cam._mirrorDebug || {};
    wlog(
      "warn",
      "[DEBUG-MIRROR-CAMERA-WGPU] frame=" + String(renderer._frameId || "frame") +
      " mode=" + (renderer._offscreenFrame === true ? "offscreen" : "visible") +
      " pos=" + fmtVec3(cam.pos) +
      " target=" + fmtVec3(cam.target) +
      " planePoint=" + fmtVec3(dbg.planePoint) +
      " planeNormal=" + fmtVec3(dbg.planeNormal) +
      " hasView=" + String(Array.isArray(cam.view_matrix) && cam.view_matrix.length === 16) +
      " hasProj=" + String(Array.isArray(cam.projection_matrix) && cam.projection_matrix.length === 16) +
      " clipApplied=" + String(dbg.clipApplied === true) +
      " clipReason=" + String(dbg.clipFallbackReason || "")
    );
  }

  var FRAME_BLIT_SHADER = `
struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@group(0) @binding(0) var blitSampler : sampler;
@group(0) @binding(1) var blitTex : texture_2d<f32>;

@vertex
fn vs_blit(@builtin(vertex_index) vid : u32) -> VOut {
  var positions = array<vec2<f32>, 4>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0,  1.0)
  );
  var uv = array<vec2<f32>, 4>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0)
  );
  var out : VOut;
  out.pos = vec4<f32>(positions[vid], 0.0, 1.0);
  out.uv = uv[vid];
  return out;
}

@fragment
fn fs_blit(in : VOut) -> @location(0) vec4<f32> {
  return textureSampleLevel(blitTex, blitSampler, in.uv, 0.0);
}
`;

  var PLANAR_MIRROR_SEAM_MESSAGE =
    "mirror surface_system is intentionally unimplemented in vf-geom-wgpu. " +
    "Install a planar mirror adapter behind createPlanarMirrorAdapter() before rendering mirrors.";

  function liveSurfaceTargetDims(frameWidth, frameHeight) {
    var width = Math.max(64, Math.min(2048, Math.round(Number(frameWidth || 0) || 0)));
    var height = Math.max(64, Math.min(2048, Math.round(Number(frameHeight || 0) || 0)));
    return { width: width, height: height };
  }

  // See docs/architecture/planar-mirror-rendering-seam.md for the adapter Interface.
  function createPlanarMirrorAdapter() {
    return {
      name: "planar-mirror",
      targetDims: function (frameWidth, frameHeight) {
        return liveSurfaceTargetDims(frameWidth, frameHeight);
      },
      buildApertureCamera: function (args) {
        args = args && typeof args === "object" ? args : {};
        var part = args.part || null;
        var surfaceCamera = args.surfaceCamera || null;
        var viewerPos = Array.isArray(args.viewerPos) ? vec3Or(args.viewerPos, [0.0, 0.0, 0.0]) : null;
        var clipToMirrorPlane = args.clipToMirrorPlane === true;
        var timeMs = Number(args.timeMs || 0.0) || 0.0;
        var targetAspect = Math.max(1e-4, Number(args.targetAspect || 1.0) || 1.0);
        var math = args.math || getMath();
        if (!part || !part.mesh) {
          failFast("mirror aperture camera requires a host mesh part");
        }
        if (!surfaceCamera || !Array.isArray(surfaceCamera.pos) || !Array.isArray(surfaceCamera.target)) {
          failFast("mirror aperture camera requires an active camera");
        }
        var plane = derivePlanarSurfaceWorldFrame(part, timeMs, math);
        plane = canonicalizePlanarFrameAxes(
          plane,
          Array.isArray(plane.points) ? plane.points : [],
          normalizeVec3(surfaceCamera.up || [0, 0, 1], [0, 0, 1]),
          null
        );
        var near = 0.05;
        var far = 500.0;
        var eye = vec3Or(surfaceCamera.pos, [0.0, 0.0, 0.0]);
        var mirrorCorners = mirrorWorldCorners(plane);
        var basis = orientMirrorBasisForEye(
          mirrorCorners,
          eye,
          normalizeVec3(surfaceCamera.up || [0, 0, 1], [0, 0, 1])
        );
        var va = subVec3(basis.bottomLeft, eye);
        var vb = subVec3(basis.bottomRight, eye);
        var vc = subVec3(basis.topLeft, eye);
        var screenDistance = -dotVec3(va, basis.backward);
        if (!(screenDistance > 1e-4)) {
          failFast("mirror aperture camera lies on or behind the mirror plane");
        }
        var left = dotVec3(basis.right, va) * near / screenDistance;
        var right = dotVec3(basis.right, vb) * near / screenDistance;
        var bottom = dotVec3(basis.up, va) * near / screenDistance;
        var top = dotVec3(basis.up, vc) * near / screenDistance;
        if (!(Math.abs(right - left) > 1e-6) || !(Math.abs(top - bottom) > 1e-6)) {
          failFast("mirror aperture camera computed a collapsed off-axis frustum");
        }
        void targetAspect;
        var returnedUp = normalizeVec3(surfaceCamera.up || [0, 0, 1], [0, 0, 1]);
        var target = surfaceCamera.target ? vec3Or(surfaceCamera.target, plane.point) : plane.point.slice();
        var view = mat4FromCameraBasis(eye, basis.right, basis.up, basis.backward);
        var projection = mat4FrustumOffCenterZ01(left, right, bottom, top, near, far);
        var clipResult = { clipped: false, reason: "" };
        if (clipToMirrorPlane === true) {
          var frontNormalWorld = plane.normal.slice();
          if (viewerPos && dotVec3(frontNormalWorld, subVec3(viewerPos, plane.point)) < 0.0) {
            frontNormalWorld = scaleVec3(frontNormalWorld, -1.0);
          }
        var clipPlanePointWorld = addVec3(plane.point, scaleVec3(frontNormalWorld, relativePlaneEpsilon(plane, null, 1e-5)));
          var clipNormalWorld = frontNormalWorld.slice();
          if (dotVec3(clipNormalWorld, subVec3(eye, clipPlanePointWorld)) > 0.0) {
            clipNormalWorld = scaleVec3(clipNormalWorld, -1.0);
          }
          var clipPlaneCamera = planeEquationInCameraSpace(view, clipPlanePointWorld, clipNormalWorld);
          clipResult = tryApplyObliqueNearPlaneZ01(projection, clipPlaneCamera);
          projection = clipResult.projection;
        }
        var viewProjection = math.mat4Mul(projection, view);
        return {
          pos: eye.slice(),
          target: target.slice(),
          up: returnedUp,
          fov: Number(surfaceCamera.fov == null ? 45.0 : surfaceCamera.fov) || 45.0,
          flip_x: surfaceCamera.flip_x === true,
          view_matrix: Array.prototype.slice.call(view),
          projection_matrix: Array.prototype.slice.call(projection),
          _mirrorViewProjection: Array.prototype.slice.call(viewProjection),
          _mirrorFlipU: true,
          _mirrorFlipV: false,
          _mirrorDebug: {
            planePoint: plane.point.slice(),
            planeNormal: plane.normal.slice(),
            frustum: { left: left, right: right, bottom: bottom, top: top, screenDistance: screenDistance },
            clipApplied: clipResult.clipped,
            clipFallbackReason: clipResult.reason
          }
        };
      },
      buildRenderCamera: function (args) {
        args = args && typeof args === "object" ? args : {};
        var part = args.part || null;
        var surfaceCamera = args.surfaceCamera || null;
        var timeMs = Number(args.timeMs || 0.0) || 0.0;
        var targetAspect = Math.max(1e-4, Number(args.targetAspect || 1.0) || 1.0);
        var math = args.math || getMath();
        if (!part || !part.mesh) {
          failFast("mirror surface_system requires a host mesh part");
        }
        if (!surfaceCamera || !Array.isArray(surfaceCamera.pos) || !Array.isArray(surfaceCamera.target)) {
          failFast("mirror surface_system requires an active surface camera");
        }
        var plane = derivePlanarSurfaceWorldFrame(part, timeMs, math);
        plane = canonicalizePlanarFrameAxes(
          plane,
          Array.isArray(plane.points) ? plane.points : [],
          normalizeVec3(surfaceCamera.up || [0, 0, 1], [0, 0, 1]),
          null
        );
        var near = 0.05;
        var far = 500.0;
        var clipEpsilon = relativePlaneEpsilon(plane, null, 1e-5);
        var reflectedPos = reflectPointAcrossPlane(surfaceCamera.pos, plane.point, plane.normal);
        var reflectedTarget = reflectPointAcrossPlane(surfaceCamera.target, plane.point, plane.normal);
        var reflectedUp = normalizeVec3(reflectDirAcrossPlane(surfaceCamera.up || [0, 0, 1], plane.normal), [0, 0, 1]);
        var mirrorCorners = mirrorWorldCorners(plane);
        var basis = orientMirrorBasisForEye(
          mirrorCorners,
          reflectedPos,
          normalizeVec3(surfaceCamera.up || [0, 0, 1], [0, 0, 1])
        );
        var va = subVec3(basis.bottomLeft, reflectedPos);
        var vb = subVec3(basis.bottomRight, reflectedPos);
        var vc = subVec3(basis.topLeft, reflectedPos);
        var screenDistance = -dotVec3(va, basis.backward);
        if (!(screenDistance > 1e-4)) {
          failFast("mirror surface_system camera lies on or behind the mirror plane");
        }
        var left = dotVec3(basis.right, va) * near / screenDistance;
        var right = dotVec3(basis.right, vb) * near / screenDistance;
        var bottom = dotVec3(basis.up, va) * near / screenDistance;
        var top = dotVec3(basis.up, vc) * near / screenDistance;
        if (!(Math.abs(right - left) > 1e-6) || !(Math.abs(top - bottom) > 1e-6)) {
          failFast("mirror surface_system computed a collapsed off-axis frustum");
        }
        void targetAspect;
        var returnedUp = basis.up.slice();
        var returnedTarget = addVec3(reflectedPos, scaleVec3(basis.backward, -1.0));
        var view = mat4FromCameraBasis(reflectedPos, basis.right, basis.up, basis.backward);
        var projection = mat4FrustumOffCenterZ01(left, right, bottom, top, near, far);
        var frontNormalWorld = plane.normal.slice();
        if (dotVec3(frontNormalWorld, subVec3(surfaceCamera.pos, plane.point)) < 0.0) {
          frontNormalWorld = scaleVec3(frontNormalWorld, -1.0);
        }
        var clipPlanePointWorld = addVec3(plane.point, scaleVec3(frontNormalWorld, clipEpsilon));
        var clipNormalWorld = frontNormalWorld.slice();
        if (dotVec3(clipNormalWorld, subVec3(reflectedPos, clipPlanePointWorld)) > 0.0) {
          clipNormalWorld = scaleVec3(clipNormalWorld, -1.0);
        }
        var clipPlaneCamera = planeEquationInCameraSpace(view, clipPlanePointWorld, clipNormalWorld);
        var clipResult = tryApplyObliqueNearPlaneZ01(projection, clipPlaneCamera);
        projection = clipResult.projection;
        var viewProjection = math.mat4Mul(projection, view);
        return {
          pos: reflectedPos,
          target: returnedTarget,
          up: returnedUp,
          fov: Number(surfaceCamera.fov == null ? 45.0 : surfaceCamera.fov) || 45.0,
          flip_x: surfaceCamera.flip_x === true,
          view_matrix: Array.prototype.slice.call(view),
          projection_matrix: Array.prototype.slice.call(projection),
          _mirrorViewProjection: Array.prototype.slice.call(viewProjection),
          _mirrorFlipU: true,
          _mirrorFlipV: false,
          _mirrorDebug: {
            planePoint: plane.point.slice(),
            planeNormal: plane.normal.slice(),
            mirrorFrontNormal: frontNormalWorld.slice(),
            clipPlanePoint: clipPlanePointWorld.slice(),
            reflectedTarget: reflectedTarget.slice(),
            clipPlaneCamera: clipPlaneCamera.slice(),
            frustum: { left: left, right: right, bottom: bottom, top: top, screenDistance: screenDistance },
            clipApplied: clipResult.clipped,
            clipFallbackReason: clipResult.reason
          }
        };
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Shader — single blinn_phong lighting path. light_model stays in the
  // uniform layout only for compatibility with older packet/scene shapes.
  // Vertex layout: pos(3) + normal(3) + color(4) — 10 f32 = 40 bytes stride
  // ---------------------------------------------------------------------------
  var MAX_SHADOW_POINTS = 32;
  var MAX_SURFACE_TRIANGLES = 192;
  var MAX_LIGHT_APERTURE_POINTS = 8;

  var SHADER = `
struct Scene {
  mvp        : mat4x4<f32>,   // 64 bytes  offset 0
  model      : mat4x4<f32>,   // 64 bytes  offset 64
  cam_pos    : vec3<f32>,     // 12 bytes  offset 128
  _pad0      : f32,           // 4 bytes   offset 140
  light0_pos : vec3<f32>,     // 12 bytes  offset 144
  _pad1      : f32,           // 4 bytes   offset 156
  light0_color: vec4<f32>,    // 16 bytes  offset 160
  light1_pos : vec3<f32>,     // 12 bytes  offset 176
  _pad2      : f32,           // 4 bytes   offset 188
  light1_color: vec4<f32>,    // 16 bytes  offset 192
  light0_dir_intensity: vec4<f32>, // 16 bytes offset 208
  light1_dir_intensity: vec4<f32>, // 16 bytes offset 224
  light0_spot_params: vec4<f32>,   // 16 bytes offset 240
  light1_spot_params: vec4<f32>,   // 16 bytes offset 256
  light_count: u32,           // 4 bytes   offset 272
  light_model: u32,           // 4 bytes   offset 276
  alpha_mul  : f32,           // 4 bytes   offset 280
  receive_shadow: u32,        // 4 bytes   offset 284
  shadow1_count: u32,         // 4 bytes   offset 288
  shadow0_softness: f32,      // 4 bytes   offset 292
  shadow1_softness: f32,      // 4 bytes   offset 296
  _pad3      : f32,           // 4 bytes   offset 300
  shadow0_pts : array<vec4<f32>, 32>, // 512 bytes offset 304
  shadow1_pts : array<vec4<f32>, 32>, // 512 bytes offset 816
  texture_color_a : vec4<f32>,        // 16 bytes offset 1328
  texture_color_b : vec4<f32>,        // 16 bytes offset 1344
  texture_params  : vec4<f32>,        // 16 bytes offset 1360
  texture_extra   : vec4<f32>,        // 16 bytes offset 1376
  surface_cam_forward_count : vec4<f32>,
  surface_cam_up_pad        : vec4<f32>,
  surface_tri_a             : array<vec4<f32>, 192>,
  surface_tri_b             : array<vec4<f32>, 192>,
  surface_tri_c             : array<vec4<f32>, 192>,
  surface_tri_color         : array<vec4<f32>, 192>,
  surface_projector         : mat4x4<f32>,
  light0_aperture_plane     : vec4<f32>,
  light0_aperture_normal    : vec4<f32>,
  light0_aperture_u         : vec4<f32>,
  light0_aperture_v         : vec4<f32>,
  light0_aperture_meta      : vec4<f32>,
  light1_aperture_plane     : vec4<f32>,
  light1_aperture_normal    : vec4<f32>,
  light1_aperture_u         : vec4<f32>,
  light1_aperture_v         : vec4<f32>,
  light1_aperture_meta      : vec4<f32>,
  light0_aperture_pts       : array<vec4<f32>, 8>,
  light1_aperture_pts       : array<vec4<f32>, 8>,
  shadow_vp0                : mat4x4<f32>,
  shadow_vp1                : mat4x4<f32>,
  shadow_meta               : vec4<f32>,
}
@group(0) @binding(0) var<uniform> sc: Scene;
@group(0) @binding(1) var surfaceSampler: sampler;
@group(0) @binding(2) var surfaceTex: texture_2d<f32>;
@group(0) @binding(3) var shadowSampler: sampler_comparison;
@group(0) @binding(4) var shadowTex0: texture_depth_2d;
@group(0) @binding(5) var shadowTex1: texture_depth_2d;

struct Vin {
  @location(0) pos   : vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color : vec4<f32>,
}
struct SphereInstVin {
  @location(0) pos        : vec3<f32>,
  @location(1) normal     : vec3<f32>,
  @location(2) _baseColor : vec4<f32>,
  @location(3) centerRad  : vec4<f32>,
  @location(4) instColor  : vec4<f32>,
}
struct CylinderInstVin {
  @location(0) pos        : vec3<f32>,
  @location(1) normal     : vec3<f32>,
  @location(2) _baseColor : vec4<f32>,
  @location(3) aRad       : vec4<f32>,
  @location(4) bPad       : vec4<f32>,
  @location(5) instColor  : vec4<f32>,
}
struct Vout {
  @builtin(position) clip    : vec4<f32>,
  @location(0)       color   : vec4<f32>,
  @location(1)       world_pos: vec3<f32>,
  @location(2)       normal  : vec3<f32>,
  @location(3)       local_pos : vec3<f32>,
  @location(4)       screen_pos : vec4<f32>,
  @location(5)       surface_proj_pos : vec4<f32>,
}
struct PointImpostorVOut {
  @builtin(position) clip    : vec4<f32>,
  @location(0)       color   : vec4<f32>,
  @location(1)       world_pos : vec3<f32>,
  @location(2)       right   : vec3<f32>,
  @location(3)       up      : vec3<f32>,
  @location(4)       center  : vec3<f32>,
  @location(5)       local_uv : vec2<f32>,
}
struct LineImpostorVOut {
  @builtin(position) clip    : vec4<f32>,
  @location(0)       color   : vec4<f32>,
  @location(1)       world_pos : vec3<f32>,
  @location(2)       axis    : vec3<f32>,
  @location(3)       perp    : vec3<f32>,
  @location(4)       local_uv : vec2<f32>,
}

fn cross2(a: vec2<f32>, b: vec2<f32>, p: vec2<f32>) -> f32 {
  return ((b.x - a.x) * (p.y - a.y)) - ((b.y - a.y) * (p.x - a.x));
}

fn shadowPoint0(idx: u32) -> vec2<f32> {
  return sc.shadow0_pts[idx].xy;
}

fn shadowPoint1(idx: u32) -> vec2<f32> {
  return sc.shadow1_pts[idx].xy;
}

fn lightAperturePoint0(idx: u32) -> vec2<f32> {
  return sc.light0_aperture_pts[idx].xy;
}

fn lightAperturePoint1(idx: u32) -> vec2<f32> {
  return sc.light1_aperture_pts[idx].xy;
}

fn contactOccluder0Point(idx: u32) -> vec2<f32> {
  return sc.shadow0_pts[5u + idx].xy;
}

fn contactOccluder1Point(idx: u32) -> vec2<f32> {
  return sc.shadow1_pts[5u + idx].xy;
}

fn edgeOcclusion(side: f32, edgeLen: f32, softness: f32) -> f32 {
  let sd = side / max(edgeLen, 1e-6);
  if (softness <= 1e-6) {
    return select(0.0, 1.0, sd >= 0.0);
  }
  return smoothstep(-softness, softness, sd);
}

fn lightAttenuation(dist: f32, intensity: f32, range: f32) -> f32 {
  let base = max(intensity, 0.0) / max(dist * dist, 1.0);
  if (range <= 1e-6) {
    return base;
  }
  if (dist >= range) {
    return 0.0;
  }
  let x = clamp(dist / range, 0.0, 1.0);
  let fade = 1.0 - (x * x);
  return base * (fade * fade);
}

fn spotlightFactor(coneDir: vec3<f32>, pointDir: vec3<f32>, innerCos: f32, outerCos: f32, kindCode: f32) -> f32 {
  if (kindCode < 0.5 || kindCode > 1.5) {
    return 1.0;
  }
  let c = dot(normalize(coneDir), normalize(pointDir));
  let inner = max(innerCos, outerCos);
  let outer = min(innerCos, outerCos);
  return smoothstep(outer, inner, c);
}

fn projectedApertureFactor0(worldPos: vec3<f32>, lightPos: vec3<f32>, kindCode: f32) -> f32 {
  if (kindCode < 1.5) {
    return 1.0;
  }
  let apertureCount = u32(sc.light0_aperture_meta.z + 0.5);
  if (apertureCount < 3u) {
    return 0.0;
  }
  let planePoint = sc.light0_aperture_plane.xyz;
  let planeNormal = normalize(sc.light0_aperture_normal.xyz);
  let ray = worldPos - lightPos;
  let denom = dot(planeNormal, ray);
  if (abs(denom) <= 1e-6) {
    return 0.0;
  }
  let t = dot(planePoint - lightPos, planeNormal) / denom;
  if (t <= 1e-4 || t >= (1.0 - 1e-4)) {
    return 0.0;
  }
  let hit = lightPos + (t * ray);
  let rel = hit - planePoint;
  let local = vec2<f32>(
    dot(rel, normalize(sc.light0_aperture_u.xyz)),
    dot(rel, normalize(sc.light0_aperture_v.xyz))
  );
  let lightToPlane = max(abs(dot(planePoint - lightPos, planeNormal)), 1e-4);
  let lightSide = dot(lightPos - planePoint, planeNormal);
  let pointSide = dot(worldPos - planePoint, planeNormal);
  let receiverSide = -sign(lightSide) * pointSide;
  if (receiverSide <= sc.light0_aperture_meta.w) {
    return 0.0;
  }
  let receiverGap = max(0.0, receiverSide - sc.light0_aperture_meta.w);
  let softness = sc.light0_aperture_meta.x * (receiverGap / lightToPlane) * sc.light0_aperture_meta.y;
  if (apertureCount == 4u) {
    var minX = 1e9;
    var maxX = -1e9;
    var minY = 1e9;
    var maxY = -1e9;
    for (var qi: u32 = 0u; qi < apertureCount; qi = qi + 1u) {
      let p = lightAperturePoint0(qi);
      minX = min(minX, p.x);
      maxX = max(maxX, p.x);
      minY = min(minY, p.y);
      maxY = max(maxY, p.y);
    }
    let insideX = smoothstep(minX - softness, minX + softness, local.x) * (1.0 - smoothstep(maxX - softness, maxX + softness, local.x));
    let insideY = smoothstep(minY - softness, minY + softness, local.y) * (1.0 - smoothstep(maxY - softness, maxY + softness, local.y));
    return insideX * insideY;
  }
  var occPos = 1.0;
  var occNeg = 1.0;
  for (var i: u32 = 0u; i < apertureCount; i = i + 1u) {
    let a = lightAperturePoint0(i);
    let b = lightAperturePoint0((i + 1u) % apertureCount);
    let side = cross2(a, b, local);
    let edgeLen = length(b - a);
    occPos = occPos * edgeOcclusion(side, edgeLen, softness);
    occNeg = occNeg * edgeOcclusion(-side, edgeLen, softness);
  }
  return max(occPos, occNeg);
}

fn projectedApertureFactor1(worldPos: vec3<f32>, lightPos: vec3<f32>, kindCode: f32) -> f32 {
  if (kindCode < 1.5) {
    return 1.0;
  }
  let apertureCount = u32(sc.light1_aperture_meta.z + 0.5);
  if (apertureCount < 3u) {
    return 0.0;
  }
  let planePoint = sc.light1_aperture_plane.xyz;
  let planeNormal = normalize(sc.light1_aperture_normal.xyz);
  let ray = worldPos - lightPos;
  let denom = dot(planeNormal, ray);
  if (abs(denom) <= 1e-6) {
    return 0.0;
  }
  let t = dot(planePoint - lightPos, planeNormal) / denom;
  if (t <= 1e-4 || t >= (1.0 - 1e-4)) {
    return 0.0;
  }
  let hit = lightPos + (t * ray);
  let rel = hit - planePoint;
  let local = vec2<f32>(
    dot(rel, normalize(sc.light1_aperture_u.xyz)),
    dot(rel, normalize(sc.light1_aperture_v.xyz))
  );
  let lightToPlane = max(abs(dot(planePoint - lightPos, planeNormal)), 1e-4);
  let lightSide = dot(lightPos - planePoint, planeNormal);
  let pointSide = dot(worldPos - planePoint, planeNormal);
  let receiverSide = -sign(lightSide) * pointSide;
  if (receiverSide <= sc.light1_aperture_meta.w) {
    return 0.0;
  }
  let receiverGap = max(0.0, receiverSide - sc.light1_aperture_meta.w);
  let softness = sc.light1_aperture_meta.x * (receiverGap / lightToPlane) * sc.light1_aperture_meta.y;
  if (apertureCount == 4u) {
    var minX = 1e9;
    var maxX = -1e9;
    var minY = 1e9;
    var maxY = -1e9;
    for (var qi: u32 = 0u; qi < apertureCount; qi = qi + 1u) {
      let p = lightAperturePoint1(qi);
      minX = min(minX, p.x);
      maxX = max(maxX, p.x);
      minY = min(minY, p.y);
      maxY = max(maxY, p.y);
    }
    let insideX = smoothstep(minX - softness, minX + softness, local.x) * (1.0 - smoothstep(maxX - softness, maxX + softness, local.x));
    let insideY = smoothstep(minY - softness, minY + softness, local.y) * (1.0 - smoothstep(maxY - softness, maxY + softness, local.y));
    return insideX * insideY;
  }
  var occPos = 1.0;
  var occNeg = 1.0;
  for (var i: u32 = 0u; i < apertureCount; i = i + 1u) {
    let a = lightAperturePoint1(i);
    let b = lightAperturePoint1((i + 1u) % apertureCount);
    let side = cross2(a, b, local);
    let edgeLen = length(b - a);
    occPos = occPos * edgeOcclusion(side, edgeLen, softness);
    occNeg = occNeg * edgeOcclusion(-side, edgeLen, softness);
  }
  return max(occPos, occNeg);
}

fn planarContactVisibility0(worldPos: vec3<f32>, lightPos: vec3<f32>) -> f32 {
  let enabled = sc.shadow0_pts[4u].x;
  if (enabled < 0.5) {
    return 1.0;
  }
  let apertureCount = u32(sc.shadow0_pts[4u].y + 0.5);
  if (apertureCount < 3u) {
    return 1.0;
  }
  let planePoint = sc.shadow0_pts[0u].xyz;
  let planeNormal = normalize(sc.shadow0_pts[1u].xyz);
  let uAxis = normalize(sc.shadow0_pts[2u].xyz);
  let vAxis = normalize(sc.shadow0_pts[3u].xyz);
  let clipEpsilon = max(0.0, sc.shadow0_pts[4u].z);
  let contactBand = max(clipEpsilon, sc.shadow0_pts[4u].w);
  let lightSide = dot(lightPos - planePoint, planeNormal);
  let pointSide = dot(worldPos - planePoint, planeNormal);
  if (abs(lightSide) <= clipEpsilon) {
    return 1.0;
  }
  if (abs(pointSide) > contactBand) {
    return 1.0;
  }
  if (lightSide * pointSide > 0.0 && abs(pointSide) > clipEpsilon) {
    return 1.0;
  }
  let ray = worldPos - lightPos;
  let denom = dot(ray, planeNormal);
  if (abs(denom) <= 1e-6) {
    return 1.0;
  }
  let hitT = dot(planePoint - lightPos, planeNormal) / denom;
  if (hitT < 0.0 || hitT > 1.0) {
    return 1.0;
  }
  let hitPoint = lightPos + (ray * hitT);
  let localVec = hitPoint - planePoint;
  let local = vec2<f32>(dot(localVec, uAxis), dot(localVec, vAxis));
  if (apertureCount == 4u) {
    var minX = 1e9;
    var maxX = -1e9;
    var minY = 1e9;
    var maxY = -1e9;
    for (var qi: u32 = 0u; qi < apertureCount; qi = qi + 1u) {
      let p = contactOccluder0Point(qi);
      minX = min(minX, p.x);
      maxX = max(maxX, p.x);
      minY = min(minY, p.y);
      maxY = max(maxY, p.y);
    }
    if (local.x < minX || local.x > maxX || local.y < minY || local.y > maxY) {
      return 1.0;
    }
    let proximity = 1.0 - smoothstep(clipEpsilon, contactBand, abs(pointSide));
    return 1.0 - proximity;
  }
  var occPos = 1.0;
  var occNeg = 1.0;
  for (var i: u32 = 0u; i < apertureCount; i = i + 1u) {
    let a = contactOccluder0Point(i);
    let b = contactOccluder0Point((i + 1u) % apertureCount);
    let side = cross2(a, b, local);
    let insidePos = select(0.0, 1.0, side >= 0.0);
    let insideNeg = select(0.0, 1.0, side <= 0.0);
    occPos = occPos * insidePos;
    occNeg = occNeg * insideNeg;
  }
  let proximity = 1.0 - smoothstep(clipEpsilon, contactBand, abs(pointSide));
  return 1.0 - (max(occPos, occNeg) * proximity);
}

fn planarContactVisibility1(worldPos: vec3<f32>, lightPos: vec3<f32>) -> f32 {
  let enabled = sc.shadow1_pts[4u].x;
  if (enabled < 0.5) {
    return 1.0;
  }
  let apertureCount = u32(sc.shadow1_pts[4u].y + 0.5);
  if (apertureCount < 3u) {
    return 1.0;
  }
  let planePoint = sc.shadow1_pts[0u].xyz;
  let planeNormal = normalize(sc.shadow1_pts[1u].xyz);
  let uAxis = normalize(sc.shadow1_pts[2u].xyz);
  let vAxis = normalize(sc.shadow1_pts[3u].xyz);
  let clipEpsilon = max(0.0, sc.shadow1_pts[4u].z);
  let contactBand = max(clipEpsilon, sc.shadow1_pts[4u].w);
  let lightSide = dot(lightPos - planePoint, planeNormal);
  let pointSide = dot(worldPos - planePoint, planeNormal);
  if (abs(lightSide) <= clipEpsilon) {
    return 1.0;
  }
  if (abs(pointSide) > contactBand) {
    return 1.0;
  }
  if (lightSide * pointSide > 0.0 && abs(pointSide) > clipEpsilon) {
    return 1.0;
  }
  let ray = worldPos - lightPos;
  let denom = dot(ray, planeNormal);
  if (abs(denom) <= 1e-6) {
    return 1.0;
  }
  let hitT = dot(planePoint - lightPos, planeNormal) / denom;
  if (hitT < 0.0 || hitT > 1.0) {
    return 1.0;
  }
  let hitPoint = lightPos + (ray * hitT);
  let localVec = hitPoint - planePoint;
  let local = vec2<f32>(dot(localVec, uAxis), dot(localVec, vAxis));
  if (apertureCount == 4u) {
    var minX = 1e9;
    var maxX = -1e9;
    var minY = 1e9;
    var maxY = -1e9;
    for (var qi: u32 = 0u; qi < apertureCount; qi = qi + 1u) {
      let p = contactOccluder1Point(qi);
      minX = min(minX, p.x);
      maxX = max(maxX, p.x);
      minY = min(minY, p.y);
      maxY = max(maxY, p.y);
    }
    if (local.x < minX || local.x > maxX || local.y < minY || local.y > maxY) {
      return 1.0;
    }
    let proximity = 1.0 - smoothstep(clipEpsilon, contactBand, abs(pointSide));
    return 1.0 - proximity;
  }
  var occPos = 1.0;
  var occNeg = 1.0;
  for (var i: u32 = 0u; i < apertureCount; i = i + 1u) {
    let a = contactOccluder1Point(i);
    let b = contactOccluder1Point((i + 1u) % apertureCount);
    let side = cross2(a, b, local);
    let insidePos = select(0.0, 1.0, side >= 0.0);
    let insideNeg = select(0.0, 1.0, side <= 0.0);
    occPos = occPos * insidePos;
    occNeg = occNeg * insideNeg;
  }
  let proximity = 1.0 - smoothstep(clipEpsilon, contactBand, abs(pointSide));
  return 1.0 - (max(occPos, occNeg) * proximity);
}

fn shadowMapVisibility0(worldPos: vec3<f32>, normal: vec3<f32>) -> f32 {
  if (sc.shadow_meta.x < 0.5) {
    return 1.0;
  }
  let lightDir = normalize(sc.light0_pos.xyz - worldPos);
  let n = normalize(normal);
  let cosNl = clamp(dot(n, lightDir), 0.0, 1.0);
  let clip = sc.shadow_vp0 * vec4<f32>(worldPos, 1.0);
  if (abs(clip.w) <= 1e-6) {
    return 1.0;
  }
  let ndc = clip.xyz / clip.w;
  let uv = vec2<f32>((ndc.x * 0.5) + 0.5, (-ndc.y * 0.5) + 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || ndc.z < 0.0 || ndc.z > 1.0) {
    return 1.0;
  }
  let dims = vec2<f32>(textureDimensions(shadowTex0));
  let texel = vec2<f32>(1.0 / max(dims.x, 1.0), 1.0 / max(dims.y, 1.0));
  let refDepth = ndc.z - (sc.shadow_meta.y + 0.00125);
  var vis = 0.0;
  for (var oy: i32 = -2; oy <= 2; oy = oy + 1) {
    for (var ox: i32 = -2; ox <= 2; ox = ox + 1) {
      let w = select(1.0, 2.0, abs(ox) + abs(oy) <= 1);
      let offset = vec2<f32>(f32(ox) * texel.x, f32(oy) * texel.y);
      vis = vis + (textureSampleCompareLevel(shadowTex0, shadowSampler, uv + offset, refDepth) * w);
    }
  }
  return vis / 29.0;
}

fn shadowMapVisibility1(worldPos: vec3<f32>, normal: vec3<f32>) -> f32 {
  if (sc.shadow_meta.z < 0.5) {
    return 1.0;
  }
  let lightDir = normalize(sc.light1_pos.xyz - worldPos);
  let n = normalize(normal);
  let cosNl = clamp(dot(n, lightDir), 0.0, 1.0);
  let clip = sc.shadow_vp1 * vec4<f32>(worldPos, 1.0);
  if (abs(clip.w) <= 1e-6) {
    return 1.0;
  }
  let ndc = clip.xyz / clip.w;
  let uv = vec2<f32>((ndc.x * 0.5) + 0.5, (-ndc.y * 0.5) + 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || ndc.z < 0.0 || ndc.z > 1.0) {
    return 1.0;
  }
  let dims = vec2<f32>(textureDimensions(shadowTex1));
  let texel = vec2<f32>(1.0 / max(dims.x, 1.0), 1.0 / max(dims.y, 1.0));
  let refDepth = ndc.z - (sc.shadow_meta.w + 0.00125);
  var vis = 0.0;
  for (var oy: i32 = -2; oy <= 2; oy = oy + 1) {
    for (var ox: i32 = -2; ox <= 2; ox = ox + 1) {
      let w = select(1.0, 2.0, abs(ox) + abs(oy) <= 1);
      let offset = vec2<f32>(f32(ox) * texel.x, f32(oy) * texel.y);
      vis = vis + (textureSampleCompareLevel(shadowTex1, shadowSampler, uv + offset, refDepth) * w);
    }
  }
  return vis / 29.0;
}

fn checkerValue(p: vec2<f32>) -> f32 {
  let cell = floor(p.x) + floor(p.y);
  let base = abs(cell - (2.0 * floor(cell * 0.5)));
  let fp = fract(p);
  let distToGrid = min(fp, vec2<f32>(1.0, 1.0) - fp);
  let fw = vec2<f32>(0.006, 0.006);
  let edgeBlendX = 1.0 - smoothstep(0.0, fw.x, distToGrid.x);
  let edgeBlendY = 1.0 - smoothstep(0.0, fw.y, distToGrid.y);
  let edgeBlend = clamp(max(edgeBlendX, edgeBlendY), 0.0, 1.0);
  return mix(base, 0.5, edgeBlend);
}

fn stripesValue(p: vec2<f32>) -> f32 {
  return smoothstep(0.45, 0.55, 0.5 + (0.5 * sin(6.2831853 * p.x)));
}

fn pipCircle(uv: vec2<f32>, center: vec2<f32>, radius: f32, softness: f32) -> f32 {
  let d = distance(uv, center);
  return 1.0 - smoothstep(radius - softness, radius + softness, d);
}

fn segmentDistance(uv: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
  let ba = b - a;
  let pa = uv - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - (ba * h));
}

fn uvUnitsPerPixel(uv: vec2<f32>) -> f32 {
  return 0.01;
}

fn graphLineMask(uv: vec2<f32>, a: vec2<f32>, b: vec2<f32>, widthPx: f32, uvPerPx: f32) -> f32 {
  if (widthPx <= 0.0) {
    return 0.0;
  }
  let halfWidth = max(0.0, widthPx * 0.5) * uvPerPx;
  let softness = max(uvPerPx * 1.2, 1e-5);
  let d = segmentDistance(uv, a, b);
  return 1.0 - smoothstep(max(0.0, halfWidth - softness), halfWidth + softness, d);
}

fn diceFaceMask(faceIndex: i32, uv: vec2<f32>) -> f32 {
  let d = 0.46;
  let r = 0.16;
  let s = 0.014;
  var mask = 0.0;
  if (faceIndex == 1) {
    mask = max(mask, pipCircle(uv, vec2<f32>(0.0, 0.0), r, s));
  } else if (faceIndex == 2) {
    mask = max(mask, pipCircle(uv, vec2<f32>(-d, -d), r, s));
    mask = max(mask, pipCircle(uv, vec2<f32>( d,  d), r, s));
  } else if (faceIndex == 3) {
    mask = max(mask, pipCircle(uv, vec2<f32>(-d, -d), r, s));
    mask = max(mask, pipCircle(uv, vec2<f32>( 0.0, 0.0), r, s));
    mask = max(mask, pipCircle(uv, vec2<f32>( d,  d), r, s));
  } else if (faceIndex == 4) {
    mask = max(mask, pipCircle(uv, vec2<f32>(-d, -d), r, s));
    mask = max(mask, pipCircle(uv, vec2<f32>( d, -d), r, s));
    mask = max(mask, pipCircle(uv, vec2<f32>(-d,  d), r, s));
    mask = max(mask, pipCircle(uv, vec2<f32>( d,  d), r, s));
  } else if (faceIndex == 5) {
    mask = max(mask, pipCircle(uv, vec2<f32>(-d, -d), r, s));
    mask = max(mask, pipCircle(uv, vec2<f32>( d, -d), r, s));
    mask = max(mask, pipCircle(uv, vec2<f32>( 0.0, 0.0), r, s));
    mask = max(mask, pipCircle(uv, vec2<f32>(-d,  d), r, s));
    mask = max(mask, pipCircle(uv, vec2<f32>( d,  d), r, s));
  } else if (faceIndex == 6) {
    mask = max(mask, pipCircle(uv, vec2<f32>(-d, -d), r, s));
    mask = max(mask, pipCircle(uv, vec2<f32>(-d,  0.0), r, s));
    mask = max(mask, pipCircle(uv, vec2<f32>(-d,  d), r, s));
    mask = max(mask, pipCircle(uv, vec2<f32>( d, -d), r, s));
    mask = max(mask, pipCircle(uv, vec2<f32>( d,  0.0), r, s));
    mask = max(mask, pipCircle(uv, vec2<f32>( d,  d), r, s));
  }
  return mask;
}

fn diceGraphMask(faceIndex: i32, uv: vec2<f32>, widthPx: f32, uvPerPx: f32) -> f32 {
  // Graph nodes must share the exact same 2D face coordinates as the pips.
  // Keep edge cleanup separate so the graph stays a true face-space system.
  let d = 0.46;
  let c = vec2<f32>(0.0, 0.0);
  let tl = vec2<f32>(-d, -d);
  let tr = vec2<f32>( d, -d);
  let bl = vec2<f32>(-d,  d);
  let br = vec2<f32>( d,  d);
  let ml = vec2<f32>(-d,  0.0);
  let mr = vec2<f32>( d,  0.0);
  var mask = 0.0;
  if (faceIndex == 2) {
    mask = max(mask, graphLineMask(uv, tl, br, widthPx, uvPerPx));
  } else if (faceIndex == 3) {
    mask = max(mask, graphLineMask(uv, tl, c, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, c, br, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, tl, br, widthPx, uvPerPx));
  } else if (faceIndex == 4) {
    mask = max(mask, graphLineMask(uv, tl, tr, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, tr, br, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, br, bl, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, bl, tl, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, tl, br, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, tr, bl, widthPx, uvPerPx));
  } else if (faceIndex == 5) {
    mask = max(mask, graphLineMask(uv, tl, tr, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, tr, br, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, br, bl, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, bl, tl, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, tl, c, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, tr, c, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, bl, c, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, br, c, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, tl, br, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, tr, bl, widthPx, uvPerPx));
  } else if (faceIndex == 6) {
    mask = max(mask, graphLineMask(uv, tl, ml, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, ml, bl, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, tr, mr, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, mr, br, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, tl, tr, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, ml, mr, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, bl, br, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, tl, mr, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, tr, ml, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, ml, br, widthPx, uvPerPx));
    mask = max(mask, graphLineMask(uv, mr, bl, widthPx, uvPerPx));
  }
  let edgeProximity = max(abs(uv.x), abs(uv.y));
  let interiorMask = 1.0 - smoothstep(0.84, 0.96, edgeProximity);
  return mask * interiorMask;
}

struct DiceSurfaceSample {
  faceIndex: i32,
  uv: vec2<f32>,
};

fn diceSurface(localPos: vec3<f32>) -> DiceSurfaceSample {
  let ax = abs(localPos.x);
  let ay = abs(localPos.y);
  let az = abs(localPos.z);
  var faceIndex = 1;
  var uv = vec2<f32>(0.0, 0.0);
  if (az >= ax && az >= ay) {
    let denom = max(az, 1e-5);
    uv = vec2<f32>(localPos.x / denom, localPos.y / denom);
    faceIndex = select(6, 1, localPos.z >= 0.0);
  } else if (ay >= ax && ay >= az) {
    let denom = max(ay, 1e-5);
    uv = vec2<f32>(localPos.x / denom, localPos.z / denom);
    faceIndex = select(5, 2, localPos.y >= 0.0);
  } else {
    let denom = max(ax, 1e-5);
    uv = vec2<f32>(localPos.y / denom, localPos.z / denom);
    faceIndex = select(4, 3, localPos.x >= 0.0);
  }
  return DiceSurfaceSample(faceIndex, uv);
}

fn diceValue(localPos: vec3<f32>) -> f32 {
  let surface = diceSurface(localPos);
  let pipMask = diceFaceMask(surface.faceIndex, surface.uv);
  let uvPerPx = uvUnitsPerPixel(surface.uv);
  let graphMask = diceGraphMask(surface.faceIndex, surface.uv, max(0.0, sc.texture_params.w), uvPerPx);
  return max(pipMask, graphMask);
}

fn rotX(a: f32) -> mat3x3<f32> {
  let c = cos(a);
  let s = sin(a);
  return mat3x3<f32>(
    vec3<f32>(1.0, 0.0, 0.0),
    vec3<f32>(0.0, c, s),
    vec3<f32>(0.0, -s, c)
  );
}

fn rotY(a: f32) -> mat3x3<f32> {
  let c = cos(a);
  let s = sin(a);
  return mat3x3<f32>(
    vec3<f32>(c, 0.0, -s),
    vec3<f32>(0.0, 1.0, 0.0),
    vec3<f32>(s, 0.0, c)
  );
}

fn rotZ(a: f32) -> mat3x3<f32> {
  let c = cos(a);
  let s = sin(a);
  return mat3x3<f32>(
    vec3<f32>(c, s, 0.0),
    vec3<f32>(-s, c, 0.0),
    vec3<f32>(0.0, 0.0, 1.0)
  );
}

fn rotateEuler(v: vec3<f32>, angles: vec3<f32>) -> vec3<f32> {
  return rotZ(angles.z) * (rotY(angles.y) * (rotX(angles.x) * v));
}

fn rotateEulerInv(v: vec3<f32>, angles: vec3<f32>) -> vec3<f32> {
  return rotX(-angles.x) * (rotY(-angles.y) * (rotZ(-angles.z) * v));
}

fn rayBoxHit(ro: vec3<f32>, rd: vec3<f32>, halfExtent: f32) -> vec2<f32> {
  let inv = sign(rd) / max(abs(rd), vec3<f32>(1e-5, 1e-5, 1e-5));
  let t0 = ((vec3<f32>(-halfExtent, -halfExtent, -halfExtent) - ro) * inv);
  let t1 = ((vec3<f32>( halfExtent,  halfExtent,  halfExtent) - ro) * inv);
  let tsmaller = min(t0, t1);
  let tbigger = max(t0, t1);
  let tNear = max(max(tsmaller.x, tsmaller.y), tsmaller.z);
  let tFar = min(min(tbigger.x, tbigger.y), tbigger.z);
  return vec2<f32>(tNear, tFar);
}

fn cubeHitNormal(p: vec3<f32>) -> vec3<f32> {
  let ap = abs(p);
  if (ap.x >= ap.y && ap.x >= ap.z) {
    return vec3<f32>(sign(p.x), 0.0, 0.0);
  }
  if (ap.y >= ap.x && ap.y >= ap.z) {
    return vec3<f32>(0.0, sign(p.y), 0.0);
  }
  return vec3<f32>(0.0, 0.0, sign(p.z));
}

fn cubeFacePalette(n: vec3<f32>) -> vec3<f32> {
  if (n.x > 0.5) {
    return vec3<f32>(0.94, 0.28, 0.24);
  }
  if (n.x < -0.5) {
    return vec3<f32>(0.95, 0.64, 0.16);
  }
  if (n.y > 0.5) {
    return vec3<f32>(0.18, 0.84, 0.28);
  }
  if (n.y < -0.5) {
    return vec3<f32>(0.10, 0.78, 0.78);
  }
  if (n.z > 0.5) {
    return vec3<f32>(0.18, 0.46, 0.96);
  }
  return vec3<f32>(0.80, 0.26, 0.96);
}

fn axisRotate(v: vec3<f32>, axis: vec3<f32>, angle: f32) -> vec3<f32> {
  let n = normalize(axis);
  let c = cos(angle);
  let s = sin(angle);
  return (v * c) + (cross(n, v) * s) + (n * dot(n, v) * (1.0 - c));
}

fn axisRotateInv(v: vec3<f32>, axis: vec3<f32>, angle: f32) -> vec3<f32> {
  return axisRotate(v, axis, -angle);
}

fn screenCubeDemoColor(base: vec3<f32>, localPos: vec3<f32>) -> vec3<f32> {
  let surface = diceSurface(localPos);
  let faceUv = surface.uv / max(sc.texture_params.yz, vec2<f32>(1e-4, 1e-4));
  let maxUv = max(abs(faceUv.x), abs(faceUv.y));
  let bgAlpha = clamp(sc.texture_color_a.a, 0.0, 1.0);
  let frameAlpha = clamp(sc.texture_color_b.a, 0.0, 1.0);
  let frameTint = mix(sc.texture_color_a.rgb, sc.texture_color_b.rgb, smoothstep(0.70, 0.92, maxUv) * 0.55);
  let contentBg = mix(base, frameTint, clamp(bgAlpha + frameAlpha, 0.0, 1.0));
  if (maxUv > 0.98) {
    return mix(base, sc.texture_color_b.rgb, frameAlpha);
  }
  let viewerDir = normalize(sc.cam_pos);
  let ro = viewerDir * 2.55;
  let fwd = normalize(-ro);
  var upSeed = vec3<f32>(0.0, 0.0, 1.0);
  if (abs(dot(fwd, upSeed)) > 0.97) {
    upSeed = vec3<f32>(0.0, 1.0, 0.0);
  }
  let right = normalize(cross(fwd, upSeed));
  let up = normalize(cross(right, fwd));
  let rayDir = normalize(fwd + (faceUv.x * right) + (faceUv.y * up));
  let cubeHalf = max(0.12, sc.texture_params.w * 0.5);
  let spinAxis = normalize(sc.texture_extra.xyz);
  let spinAngle = sc.texture_extra.w;
  let localOrigin = axisRotateInv(ro, spinAxis, spinAngle);
  let localDir = normalize(axisRotateInv(rayDir, spinAxis, spinAngle));
  let hit = rayBoxHit(localOrigin, localDir, cubeHalf);
  let tNear = hit.x;
  let tFar = hit.y;
  if (tFar <= max(tNear, 0.0)) {
    return contentBg;
  }
  let tHit = select(tFar, tNear, tNear > 0.0);
  let p = localOrigin + (localDir * tHit);
  let nLocal = cubeHitNormal(p);
  let nWorld = normalize(axisRotate(nLocal, spinAxis, spinAngle));
  let faceColor = cubeFacePalette(nLocal);
  let lightDir = normalize(vec3<f32>(0.52, -0.18, 1.05));
  let viewDir = normalize(-rayDir);
  let diffuse = 0.55 + (0.45 * max(dot(nWorld, lightDir), 0.0));
  let halfDir = normalize(lightDir + viewDir);
  let spec = pow(max(dot(nWorld, halfDir), 0.0), 28.0);
  var cubeColor = faceColor * diffuse;
  cubeColor = cubeColor + (vec3<f32>(1.0, 1.0, 1.0) * (0.26 * spec));
  let edgeCoord = select(abs(p.yz), select(abs(p.xz), abs(p.xy), abs(nLocal.z) > 0.5), abs(nLocal.x) > 0.5);
  let edgeMetric = max(edgeCoord.x, edgeCoord.y);
  let edgeMask = smoothstep(cubeHalf * 0.76, cubeHalf * 0.98, edgeMetric);
  cubeColor = mix(cubeColor, sc.texture_color_b.rgb, edgeMask * 0.35);
  return mix(contentBg, cubeColor, 0.98);
}

fn facePatternColor(kindCode: i32, pLocal: vec3<f32>, halfExtent: f32, baseA: vec3<f32>, baseB: vec3<f32>) -> vec3<f32> {
  let scaled = pLocal / max(halfExtent, 1e-5);
  let surface = diceSurface(scaled);
  if (kindCode == 1) {
    let uv = (surface.uv + vec2<f32>(1.0, 1.0)) * 2.2;
    let mask = checkerValue(uv);
    return mix(baseA, baseB, clamp(mask, 0.0, 1.0));
  }
  if (kindCode == 2) {
    let uv = (surface.uv + vec2<f32>(1.0, 0.0)) * 2.7;
    let mask = stripesValue(uv);
    return mix(baseA, baseB, clamp(mask, 0.0, 1.0));
  }
  if (kindCode == 3) {
    let pipMask = diceFaceMask(surface.faceIndex, surface.uv);
    return mix(baseA, baseB, clamp(pipMask, 0.0, 1.0));
  }
  return cubeFacePalette(cubeHitNormal(pLocal));
}

struct DemoHit {
  t: f32,
  color: vec3<f32>,
  hit: f32,
};

fn demoCubeHit(
  ro: vec3<f32>,
  rd: vec3<f32>,
  center: vec3<f32>,
  halfExtent: f32,
  kindCode: i32,
  baseA: vec3<f32>,
  baseB: vec3<f32>,
) -> DemoHit {
  let localRo = ro - center;
  let hit = rayBoxHit(localRo, rd, halfExtent);
  let tNear = hit.x;
  let tFar = hit.y;
  if (tFar <= max(tNear, 0.0)) {
    return DemoHit(1e9, vec3<f32>(0.0, 0.0, 0.0), 0.0);
  }
  let tHit = select(tFar, tNear, tNear > 0.0);
  let pLocal = localRo + (rd * tHit);
  let nLocal = cubeHitNormal(pLocal);
  let faceColor = facePatternColor(kindCode, pLocal, halfExtent, baseA, baseB);
  let lightDir = normalize(vec3<f32>(0.42, -0.24, 1.06));
  let viewDir = normalize(-rd);
  let diffuse = 0.50 + (0.50 * max(dot(nLocal, lightDir), 0.0));
  let halfDir = normalize(lightDir + viewDir);
  let spec = pow(max(dot(nLocal, halfDir), 0.0), 26.0);
  var cubeColor = faceColor * diffuse;
  cubeColor = cubeColor + (vec3<f32>(1.0, 1.0, 1.0) * (0.22 * spec));
  let edgeCoord = select(abs(pLocal.yz), select(abs(pLocal.xz), abs(pLocal.xy), abs(nLocal.z) > 0.5), abs(nLocal.x) > 0.5);
  let edgeMetric = max(edgeCoord.x, edgeCoord.y);
  let edgeMask = smoothstep(halfExtent * 0.76, halfExtent * 0.98, edgeMetric);
  cubeColor = mix(cubeColor, vec3<f32>(0.06, 0.06, 0.08), edgeMask * 0.28);
  return DemoHit(tHit, cubeColor, 1.0);
}

fn rayTriangleHit(ro: vec3<f32>, rd: vec3<f32>, a: vec3<f32>, b: vec3<f32>, c: vec3<f32>) -> f32 {
  let eps = 1e-5;
  let ab = b - a;
  let ac = c - a;
  let p = cross(rd, ac);
  let det = dot(ab, p);
  if (abs(det) < eps) {
    return -1.0;
  }
  let invDet = 1.0 / det;
  let tvec = ro - a;
  let u = dot(tvec, p) * invDet;
  if (u < 0.0 || u > 1.0) {
    return -1.0;
  }
  let q = cross(tvec, ab);
  let v = dot(rd, q) * invDet;
  if (v < 0.0 || (u + v) > 1.0) {
    return -1.0;
  }
  let t = dot(ac, q) * invDet;
  if (t <= eps) {
    return -1.0;
  }
  return t;
}

fn litSurfaceTriangleColor(baseColor: vec3<f32>, hitPos: vec3<f32>, a: vec3<f32>, b: vec3<f32>, c: vec3<f32>, rd: vec3<f32>) -> vec3<f32> {
  let triNormal = normalize(cross(b - a, c - a));
  let facingNormal = select(-triNormal, triNormal, dot(triNormal, -rd) >= 0.0);
  let viewDir = normalize(-rd);
  var diffuse = vec3<f32>(0.0, 0.0, 0.0);
  var specular = vec3<f32>(0.0, 0.0, 0.0);
  if (sc.light_count > 0u) {
    let toLight0 = sc.light0_pos - hitPos;
    let dist0 = max(length(toLight0), 1e-6);
    let L0 = toLight0 / dist0;
    let atten0 = lightAttenuation(dist0, sc.light0_dir_intensity.w, sc.light0_spot_params.z);
    let spot0 = select(
      spotlightFactor(sc.light0_dir_intensity.xyz, -L0, sc.light0_spot_params.x, sc.light0_spot_params.y, sc.light0_spot_params.w),
      1.0,
      sc.light0_spot_params.w >= 1.5
    );
    let proj0 = projectedApertureFactor0(hitPos, sc.light0_pos, sc.light0_spot_params.w);
    let diff0 = max(dot(facingNormal, L0), 0.0);
    diffuse += (atten0 * spot0 * proj0 * diff0) * sc.light0_color.rgb * baseColor;
    if (diff0 > 0.0 && sc.light0_spot_params.w < 1.5) {
      let half0 = normalize(L0 + viewDir);
      let spec0 = pow(max(dot(facingNormal, half0), 0.0), 28.0);
      specular += (atten0 * spot0 * proj0 * spec0) * sc.light0_color.rgb * 0.22;
    }
  }
  if (sc.light_count > 1u) {
    let toLight1 = sc.light1_pos - hitPos;
    let dist1 = max(length(toLight1), 1e-6);
    let L1 = toLight1 / dist1;
    let atten1 = lightAttenuation(dist1, sc.light1_dir_intensity.w, sc.light1_spot_params.z);
    let spot1 = select(
      spotlightFactor(sc.light1_dir_intensity.xyz, -L1, sc.light1_spot_params.x, sc.light1_spot_params.y, sc.light1_spot_params.w),
      1.0,
      sc.light1_spot_params.w >= 1.5
    );
    let proj1 = projectedApertureFactor1(hitPos, sc.light1_pos, sc.light1_spot_params.w);
    let diff1 = max(dot(facingNormal, L1), 0.0);
    diffuse += (atten1 * spot1 * proj1 * diff1) * sc.light1_color.rgb * baseColor;
    if (diff1 > 0.0 && sc.light1_spot_params.w < 1.5) {
      let half1 = normalize(L1 + viewDir);
      let spec1 = pow(max(dot(facingNormal, half1), 0.0), 28.0);
      specular += (atten1 * spot1 * proj1 * spec1) * sc.light1_color.rgb * 0.22;
    }
  }
  if (sc.light_count == 0u) {
    return baseColor;
  }
  let ambient = baseColor * 0.20;
  return ambient + diffuse + specular;
}

fn surfaceWorldSceneColor(base: vec3<f32>, localPos: vec3<f32>, worldPos: vec3<f32>, hostNormal: vec3<f32>, surfaceProjPos: vec4<f32>, allowDemoFallback: bool) -> vec3<f32> {
  let localPlaneU = vec2<f32>(
    dot(localPos, sc.surface_cam_forward_count.xyz),
    dot(localPos, sc.surface_cam_up_pad.xyz)
  );
  let surfaceSpan = max(sc.texture_extra.zw, vec2<f32>(1e-4, 1e-4));
  let surfaceUv = vec2<f32>(
    (localPlaneU.x - sc.texture_extra.x) / surfaceSpan.x,
    (localPlaneU.y - sc.texture_extra.y) / surfaceSpan.y
  );
  let faceUv = vec2<f32>((surfaceUv.x * 2.0) - 1.0, (surfaceUv.y * 2.0) - 1.0);
  let maxUv = max(abs(faceUv.x), abs(faceUv.y));
  let bgAlpha = clamp(sc.texture_color_a.a, 0.0, 1.0);
  let frameAlpha = clamp(sc.texture_color_b.a, 0.0, 1.0);
  let frameTint = mix(sc.texture_color_a.rgb, sc.texture_color_b.rgb, smoothstep(0.70, 0.92, maxUv) * 0.55);
  let contentBg = mix(base, frameTint, clamp(bgAlpha + frameAlpha, 0.0, 1.0));
  if (maxUv > 0.995) {
    return mix(base, sc.texture_color_b.rgb, frameAlpha);
  }
  let screenFlags = i32(sc.texture_params.w + 0.5);
  var uv = vec2<f32>(
    clamp(surfaceUv.x, 0.0, 1.0),
    clamp(surfaceUv.y, 0.0, 1.0)
  );
  if ((screenFlags & 2) != 0) {
    uv.x = 1.0 - uv.x;
  }
  if ((screenFlags & 4) != 0) {
    uv.y = 1.0 - uv.y;
  }
  let sampleColor = textureSampleLevel(surfaceTex, surfaceSampler, uv, 0.0);
  let sampleAlpha = clamp(sampleColor.a, 0.0, 1.0);
  if (sc.texture_params.x > 3.5) {
    let reflectivity = clamp(sc.surface_cam_forward_count.w, 0.0, 1.0);
    let reflectedLayer = mix(contentBg, sampleColor.rgb, sampleAlpha);
    return mix(contentBg, reflectedLayer, reflectivity);
  }
  return mix(contentBg, sampleColor.rgb, sampleAlpha);
}

fn texturePatternValue(kindCode: f32, p: vec2<f32>) -> f32 {
  if (kindCode < 1.5) {
    return checkerValue(p);
  }
  return stripesValue(p);
}

fn proceduralTexture(base: vec3<f32>, localPos: vec3<f32>, worldPos: vec3<f32>, normal: vec3<f32>, surfaceProjPos: vec4<f32>) -> vec3<f32> {
  let kindCode = sc.texture_params.x;
  if (kindCode < 0.5) {
    return base;
  }
  if (kindCode > 3.5) {
    return surfaceWorldSceneColor(base, localPos, worldPos, normal, surfaceProjPos, true);
  }
  if (kindCode > 2.5) {
    let pipMask = diceValue(localPos);
    let texDice = mix(sc.texture_color_a.rgb, sc.texture_color_b.rgb, clamp(pipMask, 0.0, 1.0));
    return texDice * base;
  }
  let scale = max(sc.texture_params.yz, vec2<f32>(1e-4, 1e-4));
  let weightsRaw = pow(abs(normalize(normal)), vec3<f32>(6.0, 6.0, 6.0));
  let weightSum = max(weightsRaw.x + weightsRaw.y + weightsRaw.z, 1e-6);
  let weights = weightsRaw / weightSum;
  let px = vec2<f32>(localPos.y * scale.x, localPos.z * scale.y);
  let py = vec2<f32>(localPos.x * scale.x, localPos.z * scale.y);
  let pz = vec2<f32>(localPos.x * scale.x, localPos.y * scale.y);
  let mask =
    (weights.x * texturePatternValue(kindCode, px)) +
    (weights.y * texturePatternValue(kindCode, py)) +
    (weights.z * texturePatternValue(kindCode, pz));
  let tex = mix(sc.texture_color_a.rgb, sc.texture_color_b.rgb, clamp(mask, 0.0, 1.0));
  return tex * base;
}

fn shadeLitBase(base: vec3<f32>, alpha: f32, worldPos: vec3<f32>, inputNormal: vec3<f32>, backfaceSpecularOff: bool) -> vec4f {
  let a = alpha * sc.alpha_mul;
  let V = normalize(sc.cam_pos - worldPos);
  var N = normalize(inputNormal);
  let facing = dot(N, V);
  let suppressBackfaceLighting = backfaceSpecularOff && facing < 0.0;
  if (!suppressBackfaceLighting && facing < 0.0) {
    N = -N;
  }
  var diffuse = vec3f(0.0, 0.0, 0.0);
  var specular = vec3f(0.0, 0.0, 0.0);
  if (!suppressBackfaceLighting && sc.light_count > 0u) {
    let stableVis0 = select(1.0, shadowMapVisibility0(worldPos, N), sc.receive_shadow != 0u);
    let contactVis0 = select(1.0, planarContactVisibility0(worldPos, sc.light0_pos), sc.receive_shadow != 0u);
    let vis0 = select(min(stableVis0, contactVis0), 1.0, sc.light0_spot_params.w >= 1.5);
    let toLight0 = sc.light0_pos - worldPos;
    let dist0 = max(length(toLight0), 1e-6);
    let L0 = toLight0 / dist0;
    let lc0 = sc.light0_color.rgb;
    let atten0 = lightAttenuation(dist0, sc.light0_dir_intensity.w, sc.light0_spot_params.z);
    let spot0 = select(
      spotlightFactor(sc.light0_dir_intensity.xyz, -L0, sc.light0_spot_params.x, sc.light0_spot_params.y, sc.light0_spot_params.w),
      1.0,
      sc.light0_spot_params.w >= 1.5
    );
    let proj0 = projectedApertureFactor0(worldPos, sc.light0_pos, sc.light0_spot_params.w);
    let litScale0 = vis0 * atten0 * spot0 * proj0;
    let diff0 = max(dot(N, L0), 0.0);
    diffuse += (litScale0 * diff0) * lc0 * base;
    if (sc.light0_spot_params.w < 1.5) {
      let H0 = normalize(L0 + V);
      let spec0 = pow(max(dot(N, H0), 0.0), 40.0);
      specular += (litScale0 * spec0) * lc0 * (1.8 * a);
    }
  }
  if (!suppressBackfaceLighting && sc.light_count > 1u) {
    let stableVis1 = select(1.0, shadowMapVisibility1(worldPos, N), sc.receive_shadow != 0u);
    let contactVis1 = select(1.0, planarContactVisibility1(worldPos, sc.light1_pos), sc.receive_shadow != 0u);
    let vis1 = select(min(stableVis1, contactVis1), 1.0, sc.light1_spot_params.w >= 1.5);
    let toLight1 = sc.light1_pos - worldPos;
    let dist1 = max(length(toLight1), 1e-6);
    let L1 = toLight1 / dist1;
    let lc1 = sc.light1_color.rgb;
    let atten1 = lightAttenuation(dist1, sc.light1_dir_intensity.w, sc.light1_spot_params.z);
    let spot1 = select(
      spotlightFactor(sc.light1_dir_intensity.xyz, -L1, sc.light1_spot_params.x, sc.light1_spot_params.y, sc.light1_spot_params.w),
      1.0,
      sc.light1_spot_params.w >= 1.5
    );
    let proj1 = projectedApertureFactor1(worldPos, sc.light1_pos, sc.light1_spot_params.w);
    let litScale1 = vis1 * atten1 * spot1 * proj1;
    let diff1 = max(dot(N, L1), 0.0);
    diffuse += (litScale1 * diff1) * lc1 * base;
    if (sc.light1_spot_params.w < 1.5) {
      let H1 = normalize(L1 + V);
      let spec1 = pow(max(dot(N, H1), 0.0), 40.0);
      specular += (litScale1 * spec1) * lc1 * (1.8 * a);
    }
  }
  if (sc.light_count == 0u) {
    return vec4f(base, a);
  }
  let ambient = 0.10 * base;
  let lit = (ambient + diffuse) * a + specular;
  return vec4f(lit, a);
}

fn receivedShadowVisibility(worldPos: vec3<f32>, inputNormal: vec3<f32>) -> f32 {
  if (sc.receive_shadow == 0u) {
    return 1.0;
  }
  var visibility = 1.0;
  let N = normalize(inputNormal);
  if (sc.light_count > 0u) {
    let stableVis0 = shadowMapVisibility0(worldPos, N);
    let contactVis0 = planarContactVisibility0(worldPos, sc.light0_pos);
    visibility = min(visibility, min(stableVis0, contactVis0));
  }
  if (sc.light_count > 1u) {
    let stableVis1 = shadowMapVisibility1(worldPos, N);
    let contactVis1 = planarContactVisibility1(worldPos, sc.light1_pos);
    visibility = min(visibility, min(stableVis1, contactVis1));
  }
  return visibility;
}

fn shadeAmbientBase(base: vec3<f32>, alpha: f32) -> vec4f {
  let a = alpha * sc.alpha_mul;
  if (sc.light_count == 0u) {
    return vec4f(base, a);
  }
  return vec4f((0.10 * base) * a, a);
}

fn screenSurfaceFrontMask(inputNormal: vec3<f32>) -> f32 {
  let surfaceCenter = (sc.model * vec4f(0.0, 0.0, 0.0, 1.0)).xyz;
  var rawNormal = (sc.model * vec4f(0.0, 0.0, 1.0, 0.0)).xyz;
  if (length(rawNormal) <= 1e-6) {
    rawNormal = inputNormal;
  }
  let surfaceNormal = normalize(rawNormal);
  let cameraSide = dot(surfaceNormal, sc.cam_pos - surfaceCenter);
  return select(0.0, 1.0, cameraSide > 1e-4);
}

fn screenSurfaceLayer(base: vec3<f32>, baseAlpha: f32, localPos: vec3<f32>, worldPos: vec3<f32>, hostNormal: vec3<f32>, surfaceProjPos: vec4<f32>) -> vec4<f32> {
  let localPlaneU = vec2<f32>(
    dot(localPos, sc.surface_cam_forward_count.xyz),
    dot(localPos, sc.surface_cam_up_pad.xyz)
  );
  let surfaceSpan = max(sc.texture_extra.zw, vec2<f32>(1e-4, 1e-4));
  let surfaceUv = vec2<f32>(
    (localPlaneU.x - sc.texture_extra.x) / surfaceSpan.x,
    (localPlaneU.y - sc.texture_extra.y) / surfaceSpan.y
  );
  let faceUv = vec2<f32>((surfaceUv.x * 2.0) - 1.0, (surfaceUv.y * 2.0) - 1.0);
  let maxUv = max(abs(faceUv.x), abs(faceUv.y));
  let bgAlpha = clamp(sc.texture_color_a.a, 0.0, 1.0);
  let frameAlpha = clamp(sc.texture_color_b.a, 0.0, 1.0);
  let frameTint = mix(sc.texture_color_a.rgb, sc.texture_color_b.rgb, smoothstep(0.70, 0.92, maxUv) * 0.55);
  let surfaceAlpha = clamp(baseAlpha, 0.0, 1.0);
  let baseLayer = mix(sc.texture_color_a.rgb, base, surfaceAlpha);
  if (maxUv > 0.995) {
    return vec4<f32>(mix(base, sc.texture_color_b.rgb, frameAlpha), surfaceAlpha);
  }
  let screenFlags = i32(sc.texture_params.w + 0.5);
  var uv = vec2<f32>(
    clamp(surfaceUv.x, 0.0, 1.0),
    clamp(surfaceUv.y, 0.0, 1.0)
  );
  if ((screenFlags & 2) != 0) {
    uv.x = 1.0 - uv.x;
  }
  if ((screenFlags & 4) != 0) {
    uv.y = 1.0 - uv.y;
  }
  let reflectionSample = textureSampleLevel(surfaceTex, surfaceSampler, uv, 0.0);
  let reflectivity = clamp(sc.surface_cam_forward_count.w, 0.0, 1.0);
  let backgroundMix = clamp(bgAlpha + frameAlpha, 0.0, 1.0);
  let backgroundAlpha = clamp(max(bgAlpha, frameAlpha), 0.0, 1.0);
  let reflectionAlpha = clamp(reflectionSample.a, 0.0, 1.0);
  let backgroundLayer = mix(baseLayer, frameTint, backgroundMix);
  let reflectedLayer = mix(backgroundLayer, reflectionSample.rgb, reflectionAlpha);
  let finalAlpha = mix(surfaceAlpha, mix(backgroundAlpha, 1.0, reflectionAlpha), reflectivity);
  return vec4<f32>(mix(backgroundLayer, reflectedLayer, reflectivity), finalAlpha);
}

@vertex
fn vs(v: Vin) -> Vout {
  var o: Vout;
  let wp = (sc.model * vec4f(v.pos, 1.0)).xyz;
  o.clip      = sc.mvp * vec4f(wp, 1.0);
  o.screen_pos = o.clip;
  o.surface_proj_pos = sc.surface_projector * vec4f(wp, 1.0);
  o.color     = v.color;
  o.world_pos = wp;
  // normal in world space (assumes uniform scale)
  o.normal = normalize((sc.model * vec4f(v.normal, 0.0)).xyz);
  o.local_pos = v.pos;
  return o;
}

@vertex
fn vs_sphere_instance(v: SphereInstVin) -> Vout {
  var o: Vout;
  let radius = v.centerRad.w;
  let wp = v.centerRad.xyz + (radius * v.pos);
  o.clip = sc.mvp * vec4f(wp, 1.0);
  o.screen_pos = o.clip;
  o.surface_proj_pos = sc.surface_projector * vec4f(wp, 1.0);
  o.color = v.instColor;
  o.world_pos = wp;
  o.normal = normalize((sc.model * vec4f(v.normal, 0.0)).xyz);
  o.local_pos = v.pos;
  return o;
}

@vertex
fn vs_cylinder_instance(v: CylinderInstVin) -> Vout {
  var o: Vout;
  let a = v.aRad.xyz;
  let b = v.bPad.xyz;
  let radius = v.aRad.w;
  let axis = b - a;
  let dir = normalize(axis);
  var refVec = vec3f(0.0, 1.0, 0.0);
  if (abs(dir.y) >= 0.92) {
    refVec = vec3f(1.0, 0.0, 0.0);
  }
  let u = normalize(cross(dir, refVec));
  let vv = cross(dir, u);
  let center = a + (axis * v.pos.z);
  let radial = (u * v.pos.x) + (vv * v.pos.y);
  let wp = center + (radius * radial);
  let wn = normalize((u * v.normal.x) + (vv * v.normal.y) + (dir * v.normal.z));
  o.clip = sc.mvp * vec4f(wp, 1.0);
  o.screen_pos = o.clip;
  o.surface_proj_pos = sc.surface_projector * vec4f(wp, 1.0);
  o.color = v.instColor;
  o.world_pos = wp;
  o.normal = normalize((sc.model * vec4f(wn, 0.0)).xyz);
  o.local_pos = vec3<f32>(v.pos.x, v.pos.y, v.pos.z);
  return o;
}

@vertex
fn vs_point_impostor(v: SphereInstVin) -> PointImpostorVOut {
  var o: PointImpostorVOut;
  let center = v.centerRad.xyz;
  let radius = v.centerRad.w;
  let viewDir = normalize(sc.cam_pos - center);
  var refUp = vec3f(0.0, 0.0, 1.0);
  if (abs(dot(viewDir, refUp)) >= 0.92) {
    refUp = vec3f(0.0, 1.0, 0.0);
  }
  let right = normalize(cross(refUp, viewDir));
  let up = normalize(cross(viewDir, right));
  let wp = center + (right * (v.pos.x * radius)) + (up * (v.pos.y * radius));
  o.clip = sc.mvp * vec4f(wp, 1.0);
  o.color = v.instColor;
  o.world_pos = wp;
  o.right = right;
  o.up = up;
  o.center = center;
  o.local_uv = v.pos.xy;
  return o;
}

@vertex
fn vs_line_impostor(v: CylinderInstVin) -> LineImpostorVOut {
  var o: LineImpostorVOut;
  let a = v.aRad.xyz;
  let b = v.bPad.xyz;
  let t = clamp(v.pos.y, 0.0, 1.0);
  let side = v.pos.x;
  let center = a + ((b - a) * t);
  let axisRaw = b - a;
  let axisLen = max(length(axisRaw), 1e-6);
  let axis = axisRaw / axisLen;
  let width = mix(v.aRad.w, v.bPad.w, t);
  let viewDir = normalize(sc.cam_pos - center);
  var perp = cross(viewDir, axis);
  if (length(perp) <= 1e-6) {
    perp = cross(vec3f(0.0, 0.0, 1.0), axis);
    if (length(perp) <= 1e-6) {
      perp = cross(vec3f(0.0, 1.0, 0.0), axis);
    }
  }
  perp = normalize(perp);
  let wp = center + (perp * (side * width));
  o.clip = sc.mvp * vec4f(wp, 1.0);
  o.color = v.instColor;
  o.world_pos = wp;
  o.axis = axis;
  o.perp = perp;
  o.local_uv = vec2<f32>(side, t);
  return o;
}

@fragment
fn fs(i: Vout) -> @location(0) vec4f {
  if (sc.texture_params.x > 3.5) {
    let frontMask = screenSurfaceFrontMask(i.normal);
    if (frontMask < 0.5 && sc.surface_cam_up_pad.w > 0.5) {
      return shadeAmbientBase(i.color.rgb, i.color.a);
    }
    let surfaceLit = shadeLitBase(i.color.rgb, i.color.a, i.world_pos, i.normal, false);
    let composed = surfaceWorldSceneColor(i.color.rgb, i.local_pos, i.world_pos, i.normal, i.surface_proj_pos, true);
    let shadowVisibility = receivedShadowVisibility(i.world_pos, i.normal);
    let shadowedComposed = composed * mix(0.38, 1.0, shadowVisibility);
    return vec4f(mix(surfaceLit.rgb, shadowedComposed, frontMask), surfaceLit.a);
  }
  let base = proceduralTexture(i.color.rgb, i.local_pos, i.world_pos, i.normal, i.surface_proj_pos);
  return shadeLitBase(base, i.color.a, i.world_pos, i.normal, sc.surface_cam_up_pad.w > 0.5);
}

@fragment
fn fs_point_impostor(i: PointImpostorVOut) -> @location(0) vec4<f32> {
  let radial = length(i.local_uv);
  let edge = max(fwidth(radial), 1e-4);
  let mask = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, radial);
  if (mask <= 1e-4) {
    discard;
  }
  let z = sqrt(max(0.0, 1.0 - min(dot(i.local_uv, i.local_uv), 1.0)));
  let front = normalize(sc.cam_pos - i.center);
  let normal = normalize((i.right * i.local_uv.x) + (i.up * i.local_uv.y) + (front * z));
  return shadeLitBase(i.color.rgb, i.color.a * mask, i.world_pos, normal, false);
}

@fragment
fn fs_line_impostor(i: LineImpostorVOut) -> @location(0) vec4<f32> {
  let x = i.local_uv.x;
  let edge = max(fwidth(x), 1e-4);
  let mask = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, abs(x));
  if (mask <= 1e-4) {
    discard;
  }
  var front = normalize(cross(i.axis, i.perp));
  let viewDir = normalize(sc.cam_pos - i.world_pos);
  if (dot(front, viewDir) < 0.0) {
    front = -front;
  }
  let z = sqrt(max(0.0, 1.0 - min(x * x, 1.0)));
  let normal = normalize((i.perp * x) + (front * z));
  return shadeLitBase(i.color.rgb, i.color.a * mask, i.world_pos, normal, false);
}
`;


  // ---------------------------------------------------------------------------
  // Picking shader — writes object_id + primitive_index to rg32uint texture
  // ---------------------------------------------------------------------------
var PICK_SHADER = `
struct PickScene {
  mvp      : mat4x4<f32>,   // 64 bytes
  model    : mat4x4<f32>,   // 64 bytes
  object_id: u32,           // 4 bytes
  _p0: u32, _p1: u32, _p2: u32,  // padding to 144 bytes total
}
@group(0) @binding(0) var<uniform> pk: PickScene;

struct PVin {
  @location(0) pos: vec3<f32>,
  @location(1) _n:  vec3<f32>,
  @location(2) _c:  vec4<f32>,
}
@vertex
fn vs_pick(v: PVin) -> @builtin(position) vec4<f32> {
  let wp = (pk.model * vec4f(v.pos, 1.0)).xyz;
  return pk.mvp * vec4f(wp, 1.0);
}
@fragment
fn fs_pick() -> @location(0) vec2<u32> {
  return vec2<u32>(pk.object_id, 0u);
}
`;

var SHADOW_SHADER = `
struct ShadowScene {
  model      : mat4x4<f32>,
  shadow_vp0                : mat4x4<f32>,
  shadow_vp1                : mat4x4<f32>,
}
@group(0) @binding(0) var<uniform> sc: ShadowScene;

struct Vin {
  @location(0) pos   : vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color : vec4<f32>,
}

@vertex
fn vs_shadow0(v: Vin) -> @builtin(position) vec4<f32> {
  let wp = (sc.model * vec4<f32>(v.pos, 1.0)).xyz;
  return sc.shadow_vp0 * vec4<f32>(wp, 1.0);
}

@vertex
fn vs_shadow1(v: Vin) -> @builtin(position) vec4<f32> {
  let wp = (sc.model * vec4<f32>(v.pos, 1.0)).xyz;
  return sc.shadow_vp1 * vec4<f32>(wp, 1.0);
}
`;

  var FLARE_SHADER = `
struct FlareVIn {
  @location(0) quad : vec2<f32>,
  @location(1) centerSize : vec4<f32>,
  @location(2) color : vec4<f32>,
  @location(3) params0 : vec4<f32>, // size_px, alpha, facing, edge_fade
  @location(4) axis : vec4<f32>,    // cos, sin, reserved, reserved
}
struct FlareVOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) params0 : vec4<f32>,
  @location(3) axis : vec2<f32>,
}

@vertex
fn vs_flare(v: FlareVIn) -> FlareVOut {
  var o: FlareVOut;
  o.clip = vec4<f32>(
    v.centerSize.x + (v.quad.x * v.centerSize.z),
    v.centerSize.y + (v.quad.y * v.centerSize.w),
    0.0,
    1.0
  );
  o.uv = v.quad;
  o.color = v.color;
  o.params0 = v.params0;
  o.axis = normalize(max(vec2<f32>(1e-5, 1e-5), abs(v.axis.xy)) * sign(v.axis.xy));
  return o;
}

fn gaussian(x: f32, sigma: f32) -> f32 {
  return exp(-0.5 * (x * x) / max(1e-6, sigma * sigma));
}

fn lorentzian(x: f32, gamma: f32) -> f32 {
  let q = x / max(1e-6, gamma);
  return 1.0 / (1.0 + (q * q));
}

@fragment
fn fs_flare(i: FlareVOut) -> @location(0) vec4<f32> {
  let sizePx = max(i.params0.x, 1.0);
  let alpha = i.params0.y;
  let facing = i.params0.z;
  let edgeFade = i.params0.w;
  let p = i.uv * sizePx;
  let r = length(p);
  let sigmaGlow = sizePx * 0.18;
  let sigmaCore = max(1.2, sizePx * 0.022);
  let ring1 = sizePx * 0.16;
  let ring2 = sizePx * 0.28;
  let ring3 = sizePx * 0.42;
  let ringW1 = max(1.8, sizePx * 0.028);
  let ringW2 = max(2.4, sizePx * 0.040);
  let ringW3 = max(3.2, sizePx * 0.052);

  let c = i.axis.x;
  let s = i.axis.y;
  let p0 = vec2<f32>((p.x * c) + (p.y * s), (-p.x * s) + (p.y * c));
  let p1 = vec2<f32>((p.x * -s) + (p.y * c), (-p.x * c) + (p.y * -s));
  let d45 = vec2<f32>(0.70710678 * (c - s), 0.70710678 * (s + c));
  let d135 = vec2<f32>(-0.70710678 * (c + s), 0.70710678 * (c - s));
  let p2 = vec2<f32>((p.x * d45.x) + (p.y * d45.y), (-p.x * d45.y) + (p.y * d45.x));
  let p3 = vec2<f32>((p.x * d135.x) + (p.y * d135.y), (-p.x * d135.y) + (p.y * d135.x));

  let ray0 = 1.00 * gaussian(p0.x, 50.0) * lorentzian(p0.y, 1.7);
  let ray1 = 0.68 * gaussian(p1.x, 34.0) * lorentzian(p1.y, 1.9);
  let ray2 = 0.34 * gaussian(p2.x, 22.0) * lorentzian(p2.y, 2.1);
  let ray3 = 0.18 * gaussian(p3.x, 16.0) * lorentzian(p3.y, 2.2);
  let rays = ray0 + ray1 + ray2 + ray3;

  let core = 1.30 * gaussian(r, sigmaCore);
  let glow = 0.26 * gaussian(r, sigmaGlow);
  let rings =
    0.060 * gaussian(r - ring1, ringW1) +
    0.038 * gaussian(r - ring2, ringW2) +
    0.018 * gaussian(r - ring3, ringW3);

  let globalScale = alpha * edgeFade;
  let whiteA = globalScale * (core + glow + (0.72 * rays));
  let tintA = globalScale * ((0.65 * glow) + (0.35 * rings) + (0.28 * rays));
  let white = vec3<f32>(1.0, 1.0, 1.0) * whiteA;
  let tint = i.color.rgb * tintA;
  return vec4<f32>(white + tint, max(whiteA, tintA));
}
`;

  var PICK_UB_SIZE = 144; // 16+16 f32 + 4 u32 = 128+16 = 144 bytes
  var SAMPLE_COUNT = 4;

  var M = null;
  function getMath() {
    if (!M) { M = global.VfGeomMath; }
    if (!M) { throw new Error("VfGeomMath not loaded"); }
    return M;
  }

  function smoothstep(edge0, edge1, x) {
    var t = Math.max(0, Math.min(1, (Number(x) - Number(edge0)) / Math.max(1e-6, Number(edge1) - Number(edge0))));
    return t * t * (3 - (2 * t));
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
        var tmp = t0; t0 = t1; t1 = tmp;
      }
      tMin = Math.max(tMin, t0);
      tMax = Math.min(tMax, t1);
      if (tMax < tMin) { return false; }
    }
    return tMax > 1e-4 && tMin < (1.0 - 1e-4);
  }

  function lightOccludedByBoxes(cameraPos, lightPos, occluders) {
    var items = Array.isArray(occluders) ? occluders : [];
    for (var i = 0; i < items.length; i += 1) {
      var mesh = items[i];
      if (!mesh || String(mesh.kind || "") !== "cube") { continue; }
      var center = mesh.center || [0, 0, 0];
      var half = Number(mesh.size || 1.0) * 0.5;
      var min = [Number(center[0]) - half, Number(center[1]) - half, Number(center[2]) - half];
      var max = [Number(center[0]) + half, Number(center[1]) + half, Number(center[2]) + half];
      if (segmentIntersectsAabb(cameraPos, lightPos, min, max)) { return true; }
    }
    return false;
  }

  function projectWorldToNdc(mvp, point) {
    var x = Number(point[0]), y = Number(point[1]), z = Number(point[2]);
    var cx =
      (mvp[0] * x) + (mvp[4] * y) + (mvp[8] * z) + mvp[12];
    var cy =
      (mvp[1] * x) + (mvp[5] * y) + (mvp[9] * z) + mvp[13];
    var cw =
      (mvp[3] * x) + (mvp[7] * y) + (mvp[11] * z) + mvp[15];
    if (!(cw > 1e-6)) { return null; }
    return [cx / cw, cy / cw];
  }

  // Uniform buffer: scene + shadows + procedural texture params.
  var UB_SIZE = 14848;
  var SHADOW_UB_SIZE = 192;

  // Legacy names all normalize to the single renderer lighting path.
  var LIGHT_MODELS = { flat: 2, lambert: 2, blinn_phong: 2, phong: 2 };

  // ---------------------------------------------------------------------------
  // Shared device (one per page; requestDevice() limit in WebView2)
  // ---------------------------------------------------------------------------
  var sharedWgpu = null;
  var sharedWgpuPromise = null;

  async function logShaderCompilationInfo(module, label) {
    if (!module || typeof module.getCompilationInfo !== "function") { return; }
    try {
      var info = await module.getCompilationInfo();
      if (!info || !Array.isArray(info.messages) || !info.messages.length) { return; }
      for (var i = 0; i < info.messages.length; i += 1) {
        var msg = info.messages[i] || {};
        var level = String(msg.type || "info").toLowerCase();
        var prefix = "[shader " + String(label || "module") + "] ";
        var details = prefix +
          (msg.lineNum != null ? ("line " + msg.lineNum + ":" + (msg.linePos != null ? msg.linePos : 0) + " ") : "") +
          String(msg.message || "");
        wlog(level === "error" ? "error" : (level === "warning" ? "warn" : "info"), details);
      }
    } catch (err) {
      wlog("warn", "[shader " + String(label || "module") + "] compilation info unavailable: " + (err && err.message ? err.message : String(err)));
    }
  }

  function getSharedWgpu() {
    if (sharedWgpu) { return Promise.resolve(sharedWgpu); }
    if (sharedWgpuPromise) { return sharedWgpuPromise; }
    if (!navigator.gpu) {
      wlog("error", "navigator.gpu missing — need WebView2/Chrome with --enable-unsafe-webgpu.");
      return Promise.resolve(null);
    }
    sharedWgpuPromise = (async function () {
      try {
        wlog("info", "getSharedWgpu: requestAdapter…");
        var adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        if (!adapter) { wlog("error", "requestAdapter() null"); sharedWgpuPromise = null; return null; }
        wlog("info", "getSharedWgpu: requestDevice…");
        var device = await adapter.requestDevice();
        device.lost.then(function (info) {
          wlog("error", "GPUDevice.lost: " + (info && info.message ? info.message : String(info)));
          sharedWgpu = null; sharedWgpuPromise = null;
        });
        try {
          device.addEventListener("uncapturederror", function (ev) {
            var err = ev && ev.error;
            wlog("error", "uncapturederror: " + (err && err.message ? err.message : String(err)));
          });
        } catch (e) {}
        var format = navigator.gpu.getPreferredCanvasFormat();
        wlog("info", "format: " + format);
        var mod = device.createShaderModule({ code: SHADER, label: "vf-geom-main" });
        var flareMod = device.createShaderModule({ code: FLARE_SHADER, label: "vf-geom-flare" });
        logShaderCompilationInfo(mod, "vf-geom-main");
        logShaderCompilationInfo(flareMod, "vf-geom-flare");

        // Vertex buffer layout: stride=40, pos@0, normal@12, color@24
        var vbufDesc = {
          arrayStride: 40,
          stepMode: "vertex",
          attributes: [
            { format: "float32x3", offset:  0, shaderLocation: 0 }, // pos
            { format: "float32x3", offset: 12, shaderLocation: 1 }, // normal
            { format: "float32x4", offset: 24, shaderLocation: 2 }, // color
          ],
        };
        var sphereInstDesc = {
          arrayStride: 32,
          stepMode: "instance",
          attributes: [
            { format: "float32x4", offset:  0, shaderLocation: 3 },
            { format: "float32x4", offset: 16, shaderLocation: 4 },
          ],
        };
        var cylinderInstDesc = {
          arrayStride: 48,
          stepMode: "instance",
          attributes: [
            { format: "float32x4", offset:  0, shaderLocation: 3 },
            { format: "float32x4", offset: 16, shaderLocation: 4 },
            { format: "float32x4", offset: 32, shaderLocation: 5 },
          ],
        };
        var flareQuadDesc = {
          arrayStride: 8,
          stepMode: "vertex",
          attributes: [
            { format: "float32x2", offset: 0, shaderLocation: 0 }
          ],
        };
        var flareInstDesc = {
          arrayStride: 64,
          stepMode: "instance",
          attributes: [
            { format: "float32x4", offset:  0, shaderLocation: 1 },
            { format: "float32x4", offset: 16, shaderLocation: 2 },
            { format: "float32x4", offset: 32, shaderLocation: 3 },
            { format: "float32x4", offset: 48, shaderLocation: 4 }
          ],
        };

        var bindLayout = device.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
              buffer: { type: "uniform" },
            },
            {
              binding: 1,
              visibility: GPUShaderStage.FRAGMENT,
              sampler: { type: "filtering" },
            },
            {
              binding: 2,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: "float" },
            },
            {
              binding: 3,
              visibility: GPUShaderStage.FRAGMENT,
              sampler: { type: "comparison" },
            },
            {
              binding: 4,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: "depth" },
            },
            {
              binding: 5,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: "depth" },
            }
          ],
        });
        var plLayout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
        var shadowBindLayout = device.createBindGroupLayout({
          entries: [{
            binding: 0,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: "uniform" }
          }]
        });
        var shadowPlLayout = device.createPipelineLayout({ bindGroupLayouts: [shadowBindLayout] });
        var flareLayout = device.createPipelineLayout({ bindGroupLayouts: [] });

        var makeDesc = function (topo, cullMode, transparent, vertexEntry, buffers, blendMode, fragmentEntry) {
          var targets = [{ format: format }];
          if (blendMode === "multiply") {
            targets = [{
              format: format,
              blend: {
                color: { srcFactor: "dst", dstFactor: "zero", operation: "add" },
                alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
              },
            }];
          } else if (blendMode === "additive") {
            targets = [{
              format: format,
              blend: {
                color: { srcFactor: "one", dstFactor: "one", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
              },
            }];
          } else if (transparent) {
            targets = [{
              format: format,
              blend: {
                color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
              },
            }];
          }
          var d = {
            layout: plLayout,
            vertex:   { module: mod, entryPoint: vertexEntry || "vs", buffers: buffers || [vbufDesc] },
            fragment: { module: mod, entryPoint: fragmentEntry || "fs", targets: targets },
            primitive: { topology: topo },
            multisample: { count: SAMPLE_COUNT },
            depthStencil: {
              depthWriteEnabled: (transparent || blendMode === "multiply" || blendMode === "additive") ? false : true,
              depthCompare: "less",
              format: "depth24plus",
            },
          };
          if (cullMode) { d.primitive.cullMode = cullMode; }
          return d;
        };

        var pipeTri, pipeLine, pipeTriAlpha, pipeTriAlphaDepth, pipeTriMultiply, pipeTriAdditive, pipeSphereInst, pipeCylinderInst, pipePointImpostor, pipeLineImpostor, pipeFlare, pipeShadow0, pipeShadow1;
        pipeTri  = device.createRenderPipeline(makeDesc("triangle-list"));
        pipeLine = device.createRenderPipeline(makeDesc("line-list"));
        pipeTriAlpha = device.createRenderPipeline(makeDesc("triangle-list", null, true));
        pipeTriMultiply = device.createRenderPipeline(makeDesc("triangle-list", null, false, null, null, "multiply"));
        pipeTriAdditive = device.createRenderPipeline(makeDesc("triangle-list", null, false, null, null, "additive"));
        pipeSphereInst = device.createRenderPipeline(
          makeDesc("triangle-list", null, false, "vs_sphere_instance", [vbufDesc, sphereInstDesc])
        );
        pipeCylinderInst = device.createRenderPipeline(
          makeDesc("triangle-list", null, false, "vs_cylinder_instance", [vbufDesc, cylinderInstDesc])
        );
        pipePointImpostor = device.createRenderPipeline(
          makeDesc("triangle-list", null, true, "vs_point_impostor", [vbufDesc, sphereInstDesc], null, "fs_point_impostor")
        );
        pipeLineImpostor = device.createRenderPipeline(
          makeDesc("triangle-list", null, true, "vs_line_impostor", [vbufDesc, cylinderInstDesc], null, "fs_line_impostor")
        );
        pipeFlare = device.createRenderPipeline({
          layout: flareLayout,
          vertex: { module: flareMod, entryPoint: "vs_flare", buffers: [flareQuadDesc, flareInstDesc] },
          fragment: { module: flareMod, entryPoint: "fs_flare", targets: [{
            format: format,
            blend: {
              color: { srcFactor: "one", dstFactor: "one", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one", operation: "add" }
            }
          }]},
          primitive: { topology: "triangle-strip" },
          multisample: { count: SAMPLE_COUNT }
        });
        pipeTriAlphaDepth = device.createRenderPipeline({
          layout: plLayout,
          vertex:   { module: mod, entryPoint: "vs", buffers: [vbufDesc] },
          fragment: { module: mod, entryPoint: "fs", targets: [{
            format: format,
            blend: {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          }] },
          primitive: { topology: "triangle-list" },
          multisample: { count: SAMPLE_COUNT },
          depthStencil: { depthWriteEnabled: true, depthCompare: "less", format: "depth24plus" },
        });
        // Picking pipeline — writes rg32uint (object_id, prim_index)
        var pickMod = device.createShaderModule({ code: PICK_SHADER, label: "vf-geom-pick" });
        logShaderCompilationInfo(pickMod, "vf-geom-pick");
        var shadowMod = device.createShaderModule({ code: SHADOW_SHADER, label: "vf-geom-shadow" });
        logShaderCompilationInfo(shadowMod, "vf-geom-shadow");
        pipeShadow0 = device.createRenderPipeline({
          layout: shadowPlLayout,
          vertex: { module: shadowMod, entryPoint: "vs_shadow0", buffers: [vbufDesc] },
          primitive: { topology: "triangle-list", cullMode: "none" },
          depthStencil: {
            depthWriteEnabled: true,
            depthCompare: "less",
            format: "depth32float",
            depthBias: 3,
            depthBiasSlopeScale: 1.5,
            depthBiasClamp: 0.0
          }
        });
        pipeShadow1 = device.createRenderPipeline({
          layout: shadowPlLayout,
          vertex: { module: shadowMod, entryPoint: "vs_shadow1", buffers: [vbufDesc] },
          primitive: { topology: "triangle-list", cullMode: "none" },
          depthStencil: {
            depthWriteEnabled: true,
            depthCompare: "less",
            format: "depth32float",
            depthBias: 3,
            depthBiasSlopeScale: 1.5,
            depthBiasClamp: 0.0
          }
        });
        var pickBindLayout = device.createBindGroupLayout({
          entries: [{
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" },
          }],
        });
        var pickPipeLayout = device.createPipelineLayout({ bindGroupLayouts: [pickBindLayout] });
        var pickPipeDesc = {
          layout: pickPipeLayout,
          vertex:   { module: pickMod, entryPoint: "vs_pick", buffers: [vbufDesc] },
          fragment: { module: pickMod, entryPoint: "fs_pick",
                      targets: [{ format: "rg32uint" }] },
          primitive: { topology: "triangle-list" },
          depthStencil: { depthWriteEnabled: true, depthCompare: "less", format: "depth24plus" },
        };
        var pipePick = device.createRenderPipeline(pickPipeDesc);
        var flareQuadData = new Float32Array([
          -1, -1,
           1, -1,
          -1,  1,
           1,  1
        ]);
        var flareQuadBuf = device.createBuffer({
          size: flareQuadData.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
        });
        device.queue.writeBuffer(flareQuadBuf, 0, flareQuadData);
        var surfaceSampler = device.createSampler({
          magFilter: "linear",
          minFilter: "linear",
          mipmapFilter: "linear",
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge"
        });
        var defaultSurfaceTex = device.createTexture({
          size: { width: 1, height: 1, depthOrArrayLayers: 1 },
          format: format,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
          { texture: defaultSurfaceTex },
          new Uint8Array([255, 255, 255, 255]),
          { bytesPerRow: 4, rowsPerImage: 1 },
          { width: 1, height: 1, depthOrArrayLayers: 1 }
        );
        var defaultSurfaceView = defaultSurfaceTex.createView();
        var shadowSampler = device.createSampler({
          compare: "less-equal",
          magFilter: "linear",
          minFilter: "linear",
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge"
        });
        var defaultShadowTex = device.createTexture({
          size: { width: 1, height: 1, depthOrArrayLayers: 1 },
          format: "depth32float",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        var defaultShadowView = defaultShadowTex.createView();
        var frameBlitBindLayout = device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }
          ]
        });
        var frameBlitPipeLayout = device.createPipelineLayout({ bindGroupLayouts: [frameBlitBindLayout] });
        var frameBlitMod = device.createShaderModule({ code: FRAME_BLIT_SHADER, label: "vf-geom-frame-blit" });
        logShaderCompilationInfo(frameBlitMod, "vf-geom-frame-blit");
        var pipeFrameBlit = device.createRenderPipeline({
          layout: frameBlitPipeLayout,
          vertex: { module: frameBlitMod, entryPoint: "vs_blit" },
          fragment: { module: frameBlitMod, entryPoint: "fs_blit", targets: [{ format: format }] },
          primitive: { topology: "triangle-strip" }
        });
        sharedWgpu = {
          device, format, bindLayout,
          pipeTri, pipeLine, pipeTriAlpha, pipeTriAlphaDepth, pipeTriMultiply, pipeTriAdditive,
          pipeSphereInst, pipeCylinderInst, pipePointImpostor, pipeLineImpostor, pipeFlare, flareQuadBuf,
          surfaceSampler, defaultSurfaceView, shadowSampler, defaultShadowView,
          pipeShadow0, pipeShadow1, shadowBindLayout,
          pipePick, pickBindLayout,
          frameBlitBindLayout, pipeFrameBlit
        };
        wlog("info", "getSharedWgpu: OK");
        return sharedWgpu;
      } catch (err) {
        var st = err && err.stack ? err.stack : "";
        wlog("error", "getSharedWgpu failed: " + (err && err.message ? err.message : err) + (st ? "\n" + st : ""));
        sharedWgpu = null; sharedWgpuPromise = null;
        throw err;
      }
    })();
    return sharedWgpuPromise;
  }

  // ---------------------------------------------------------------------------
  // Build scene uniform buffer (560 bytes)
  // ---------------------------------------------------------------------------
  function buildUniform(mvp, model, camera, lights, lightModel, alphaMul, meshLike) {
    var buf = new ArrayBuffer(UB_SIZE);
    var f32 = new Float32Array(buf);
    var u32 = new Uint32Array(buf);

    // mvp (16 f32 @ offset 0)
    for (var i = 0; i < 16; i++) { f32[i] = mvp[i]; }
    // model (16 f32 @ offset 16)
    for (var i = 0; i < 16; i++) { f32[16 + i] = model[i]; }

    // cam_pos (3 f32 @ offset 32)
    f32[32] = camera[0]; f32[33] = camera[1]; f32[34] = camera[2]; f32[35] = 0;

    // light0_pos (3 f32 @ offset 36)
    var lp0 = lights && lights.length ? lights[0].pos : [0, 10, 10];
    f32[36] = lp0[0]; f32[37] = lp0[1]; f32[38] = lp0[2]; f32[39] = 0;

    // light0_color (4 f32 @ offset 40)
    var lc0 = lights && lights.length ? lights[0].color_f32 : [1, 1, 1, 1];
    f32[40] = lc0[0]; f32[41] = lc0[1]; f32[42] = lc0[2]; f32[43] = lc0[3];

    // light1_pos (3 f32 @ offset 44)
    var lp1 = lights && lights.length > 1 ? lights[1].pos : [0, 10, 10];
    f32[44] = lp1[0]; f32[45] = lp1[1]; f32[46] = lp1[2]; f32[47] = 0;

    // light1_color (4 f32 @ offset 48)
    var lc1 = lights && lights.length > 1 ? lights[1].color_f32 : [0, 0, 0, 1];
    f32[48] = lc1[0]; f32[49] = lc1[1]; f32[50] = lc1[2]; f32[51] = lc1[3];

    // light0_dir_intensity (4 f32 @ offset 52)
    var ld0 = lights && lights.length ? lights[0].direction_f32 : [0, 0, -1];
    f32[52] = ld0[0]; f32[53] = ld0[1]; f32[54] = ld0[2];
    f32[55] = lights && lights.length ? (Number(lights[0].intensity) || 0) : 0;

    // light1_dir_intensity (4 f32 @ offset 56)
    var ld1 = lights && lights.length > 1 ? lights[1].direction_f32 : [0, 0, -1];
    f32[56] = ld1[0]; f32[57] = ld1[1]; f32[58] = ld1[2];
    f32[59] = lights && lights.length > 1 ? (Number(lights[1].intensity) || 0) : 0;

    // light0_spot_params (4 f32 @ offset 60)
    f32[60] = lights && lights.length ? (Number(lights[0].inner_cone_cos) || -1) : -1;
    f32[61] = lights && lights.length ? (Number(lights[0].outer_cone_cos) || -1) : -1;
    f32[62] = lights && lights.length ? (Number(lights[0].range) || 0) : 0;
    f32[63] = lights && lights.length ? (Number(lights[0].kind_code) || 0) : 0;

    // light1_spot_params (4 f32 @ offset 64)
    f32[64] = lights && lights.length > 1 ? (Number(lights[1].inner_cone_cos) || -1) : -1;
    f32[65] = lights && lights.length > 1 ? (Number(lights[1].outer_cone_cos) || -1) : -1;
    f32[66] = lights && lights.length > 1 ? (Number(lights[1].range) || 0) : 0;
    f32[67] = lights && lights.length > 1 ? (Number(lights[1].kind_code) || 0) : 0;

    // light_count, light_model, alpha_mul
    u32[68] = Math.min(2, lights && lights.length ? lights.length : 0);
    u32[69] = lightModel;
    f32[70] = Number(alphaMul);
    if (!Number.isFinite(f32[70])) { f32[70] = 1.0; }
    u32[71] = meshLike && meshLike.receives_shadow === false ? 0 : 1;
    u32[72] = 0;
    f32[73] = 0.0;
    f32[74] = 0.0;
    function writePlanarContactOccluder(base, occluder) {
      for (var clear = 0; clear < 128; clear += 1) {
        f32[base + clear] = 0.0;
      }
      if (!occluder || typeof occluder !== "object") { return; }
      var packet = requirePlanarPacket(occluder, "planar contact occluder");
      var planePoint = packet.planePoint;
      var planeNormal = packet.planeNormal;
      var uAxis = packet.uAxis;
      var vAxis = packet.vAxis;
      var points = packet.points;
      var count = Math.min(MAX_LIGHT_APERTURE_POINTS, points.length);
      f32[base + 0] = Number(planePoint[0]) || 0.0;
      f32[base + 1] = Number(planePoint[1]) || 0.0;
      f32[base + 2] = Number(planePoint[2]) || 0.0;
      f32[base + 4] = Number(planeNormal[0]) || 0.0;
      f32[base + 5] = Number(planeNormal[1]) || 0.0;
      f32[base + 6] = Number(planeNormal[2]) || 1.0;
      f32[base + 8] = Number(uAxis[0]) || 0.0;
      f32[base + 9] = Number(uAxis[1]) || 0.0;
      f32[base + 10] = Number(uAxis[2]) || 0.0;
      f32[base + 12] = Number(vAxis[0]) || 0.0;
      f32[base + 13] = Number(vAxis[1]) || 0.0;
      f32[base + 14] = Number(vAxis[2]) || 0.0;
      f32[base + 16] = 1.0;
      f32[base + 17] = count;
      f32[base + 18] = Math.max(0.0, Number(occluder.clip_epsilon || 0.0) || 0.0);
      f32[base + 19] = Math.max(f32[base + 18], Number(occluder.contact_band || 0.08) || 0.08);
      for (var pointIndex = 0; pointIndex < count; pointIndex += 1) {
        var point = points[pointIndex];
        var pointBase = base + 20 + (pointIndex * 4);
        f32[pointBase + 0] = Number(point[0]) || 0.0;
        f32[pointBase + 1] = Number(point[1]) || 0.0;
      }
    }
    writePlanarContactOccluder(76, meshLike && meshLike.shadow_contact0);
    writePlanarContactOccluder(204, meshLike && meshLike.shadow_contact1);
    var surfaceSystem = meshLike && meshLike.surface_system && typeof meshLike.surface_system === "object"
      ? meshLike.surface_system
      : null;
    var texture = meshLike && meshLike.texture && typeof meshLike.texture === "object"
      ? meshLike.texture
      : null;
    var textureKind = 0.0;
    var surfaceTextureReady = textureKind > 3.5 && meshLike && meshLike._surfaceTextureReady === true;
    var meshKindLower = String(meshLike && meshLike.kind || "").toLowerCase().trim();
    var screenHostIsQuadLike = meshKindLower === "quad" || (meshLike && meshLike.size != null);
    if (surfaceSystem) {
      var surfaceKind = String(surfaceSystem.kind || "").toLowerCase().trim();
      var runtimeTextureReady = surfaceSystem._runtime_texture_ready !== false;
      if (surfaceKind === "screen" && runtimeTextureReady && screenHostIsQuadLike) {
        textureKind = 4.0;
      }
    } else if (texture) {
      var rawKind = String(texture.kind || "").toLowerCase().trim();
      if (rawKind === "checker") {
        textureKind = 1.0;
      } else if (rawKind === "stripes") {
        textureKind = 2.0;
      } else if (rawKind === "dice") {
        textureKind = 3.0;
      }
    }
    surfaceTextureReady = textureKind > 3.5 && meshLike && meshLike._surfaceTextureReady === true;
    if (textureKind > 3.5 && !surfaceTextureReady) {
      if (surfaceSystem && String(surfaceSystem.kind || "").toLowerCase().trim() === "screen" && screenHostIsQuadLike) {
        textureKind = 0.0;
      } else {
        failFast("surface_system requires a ready offscreen surface texture");
      }
    }
    var defaultScale = textureKind > 3.5 ? [1.0, 1.0] : [8.0, 8.0];
    var scale = textureKind > 3.5
      ? ((surfaceSystem && Array.isArray(surfaceSystem.scale)) ? surfaceSystem.scale : defaultScale)
      : ((texture && Array.isArray(texture.scale)) ? texture.scale : defaultScale);
    var sx = Number(scale[0]);
    var sy = Number(scale[1]);
    if (!(sx > 0)) { sx = defaultScale[0]; }
    if (!(sy > 0)) { sy = defaultScale[1]; }
    var systemWorld = surfaceSystem && surfaceSystem.world && typeof surfaceSystem.world === "object"
      ? surfaceSystem.world
      : null;
    var ca = parseColor(
      textureKind > 3.5
        ? (systemWorld && systemWorld.background ? systemWorld.background : [0.0, 0.0, 0.0, 0.0])
        : (texture && texture.color_a ? texture.color_a : [0.18, 0.22, 0.30, 1.0])
    );
    var cb = parseColor(
      textureKind > 3.5
        ? (systemWorld && systemWorld.frame_color ? systemWorld.frame_color : [0.0, 0.0, 0.0, 0.0])
        : (texture && texture.color_b ? texture.color_b : [0.90, 0.92, 0.98, 1.0])
    );
    var rotation = texture && Array.isArray(texture.rotation) ? texture.rotation : [0.0, 0.0, 0.0];
    var rx = Number(rotation[0]);
    var ry = Number(rotation[1]);
    var rz = Number(rotation[2]);
    if (!Number.isFinite(rx)) { rx = 0.0; }
    if (!Number.isFinite(ry)) { ry = 0.0; }
    if (!Number.isFinite(rz)) { rz = 0.0; }
    var graphWidthPx = texture && texture.graph_test === true
      ? Math.max(0.0, Number(texture.graph_width_px || 0.0))
      : 0.0;
    var surfaceTriangles = systemWorld && Array.isArray(systemWorld.triangles) ? systemWorld.triangles : [];
    var hasSurfaceTriangles = textureKind > 3.5 && surfaceTriangles.length > 0;
    f32[332] = ca[0]; f32[333] = ca[1]; f32[334] = ca[2]; f32[335] = ca[3];
    f32[336] = cb[0]; f32[337] = cb[1]; f32[338] = cb[2]; f32[339] = cb[3];
      f32[340] = textureKind;
      f32[341] = sx;
      f32[342] = sy;
      f32[343] = graphWidthPx;
      if (textureKind > 3.5 && surfaceSystem) {
        var screenFlags = 0.0;
        if (surfaceSystem.reverse_facing === true) { screenFlags += 1.0; }
        if (surfaceSystem.flip_x === true) { screenFlags += 2.0; }
        if (surfaceSystem.flip_y === true) { screenFlags += 4.0; }
        f32[343] = screenFlags;
      }
    if (hasSurfaceTriangles) {
      var surfaceCamera = surfaceSystem && surfaceSystem.camera && typeof surfaceSystem.camera === "object"
        ? surfaceSystem.camera
        : null;
      var surfaceCount = Math.min(MAX_SURFACE_TRIANGLES, surfaceTriangles.length);
      var surfaceCamPos = vec3Or(surfaceCamera && surfaceCamera.pos ? surfaceCamera.pos : (camera.position || [0.0, 0.0, 0.0]), [0.0, 0.0, 0.0]);
      var worldForward = normalizeVec3(
        surfaceCamera && surfaceCamera.target
          ? [
              Number(surfaceCamera.target[0] || 0.0) - Number((surfaceCamera.pos || [0, 0, 0])[0] || 0.0),
              Number(surfaceCamera.target[1] || 0.0) - Number((surfaceCamera.pos || [0, 0, 0])[1] || 0.0),
              Number(surfaceCamera.target[2] || 0.0) - Number((surfaceCamera.pos || [0, 0, 0])[2] || 0.0)
            ]
          : [0.0, 1.0, 0.0],
        [0.0, 1.0, 0.0]
      );
      var worldUp = normalizeVec3(surfaceCamera && surfaceCamera.up ? surfaceCamera.up : [0.0, 0.0, 1.0], [0.0, 0.0, 1.0]);
      var localForward = worldForward;
      var localUp = worldUp;
      f32[343] = Math.max(1e-4, Math.tan(((Number(surfaceCamera && surfaceCamera.fov || 34.0) || 34.0) * Math.PI / 180.0) * 0.5));
      f32[344] = surfaceCamPos[0];
      f32[345] = surfaceCamPos[1];
      f32[346] = surfaceCamPos[2];
      f32[347] = surfaceTextureReady ? 1.0 : 0.0;
      f32[348] = localForward[0];
      f32[349] = localForward[1];
      f32[350] = localForward[2];
      f32[351] = surfaceCount;
      f32[352] = localUp[0];
      f32[353] = localUp[1];
      f32[354] = localUp[2];
      f32[355] = meshLike && meshLike.no_backface_specular === true ? 1.0 : 0.0;
      var triABase = 356;
      var triBBase = triABase + (MAX_SURFACE_TRIANGLES * 4);
      var triCBase = triBBase + (MAX_SURFACE_TRIANGLES * 4);
      var triColorBase = triCBase + (MAX_SURFACE_TRIANGLES * 4);
      for (var mi = 0; mi < surfaceCount; mi += 1) {
        var tri = surfaceTriangles[mi] && typeof surfaceTriangles[mi] === "object" ? surfaceTriangles[mi] : {};
        var localA = vec3Or(tri.a, [0.0, 0.0, 0.0]);
        var localB = vec3Or(tri.b, [0.0, 0.0, 0.0]);
        var localC = vec3Or(tri.c, [0.0, 0.0, 0.0]);
        var triColor = parseColor(tri.color || [0.84, 0.86, 0.92, 1.0]);
        var aBase = triABase + (mi * 4);
        f32[aBase] = localA[0];
        f32[aBase + 1] = localA[1];
        f32[aBase + 2] = localA[2];
        f32[aBase + 3] = 1.0;
        var bBase = triBBase + (mi * 4);
        f32[bBase] = localB[0];
        f32[bBase + 1] = localB[1];
        f32[bBase + 2] = localB[2];
        f32[bBase + 3] = 1.0;
        var cBase = triCBase + (mi * 4);
        f32[cBase] = localC[0];
        f32[cBase + 1] = localC[1];
        f32[cBase + 2] = localC[2];
        f32[cBase + 3] = 1.0;
        var colorBase = triColorBase + (mi * 4);
        f32[colorBase] = triColor[0];
        f32[colorBase + 1] = triColor[1];
        f32[colorBase + 2] = triColor[2];
        f32[colorBase + 3] = triColor[3];
      }
    } else if (textureKind > 3.5 && surfaceTextureReady) {
      var surfaceBounds = surfaceLocalBounds(meshLike);
      f32[344] = surfaceBounds.minX;
      f32[345] = surfaceBounds.minY;
      f32[346] = surfaceBounds.spanX;
      f32[347] = surfaceBounds.spanY;
      f32[348] = Number(surfaceBounds.uAxis && surfaceBounds.uAxis[0] || 0.0);
      f32[349] = Number(surfaceBounds.uAxis && surfaceBounds.uAxis[1] || 0.0);
      f32[350] = Number(surfaceBounds.uAxis && surfaceBounds.uAxis[2] || 0.0);
      f32[351] = surfaceSystem ? Math.max(0.0, Math.min(1.0, Number(surfaceSystem.reflectivity == null ? 1.0 : surfaceSystem.reflectivity) || 0.0)) : 1.0;
      f32[352] = Number(surfaceBounds.vAxis && surfaceBounds.vAxis[0] || 0.0);
      f32[353] = Number(surfaceBounds.vAxis && surfaceBounds.vAxis[1] || 0.0);
      f32[354] = Number(surfaceBounds.vAxis && surfaceBounds.vAxis[2] || 0.0);
      f32[355] = meshLike && meshLike.no_backface_specular === true ? 1.0 : 0.0;
    } else {
      f32[344] = rx;
      f32[345] = ry;
      f32[346] = rz;
      f32[347] = textureKind > 3.5 && systemWorld ? Math.max(0.2, Number(systemWorld.cube_size || 0.88)) : 0.0;
      var spinAxis = systemWorld && Array.isArray(systemWorld.spin_axis) ? systemWorld.spin_axis : [0.0, 1.0, 0.0];
      var spinAxisNorm = normalizeVec3(spinAxis, [0.0, 1.0, 0.0]);
      f32[344] = spinAxisNorm[0];
      f32[345] = spinAxisNorm[1];
      f32[346] = spinAxisNorm[2];
      f32[347] = surfaceTextureReady
        ? 1.0
        : (textureKind > 3.5 && systemWorld ? (Number(systemWorld.spin_angle || 0.0) || 0.0) : 0.0);
    }

    var projectorBase = 356 + (MAX_SURFACE_TRIANGLES * 4 * 4);
    for (var pi = 0; pi < 16; pi += 1) {
      f32[projectorBase + pi] = (pi % 5 === 0 ? 1.0 : 0.0);
    }
    var lightApertureBase = projectorBase + 16;
    var lightApertureHeaderStride = 20;
    var lightAperturePointsStride = MAX_LIGHT_APERTURE_POINTS * 4;
    var lightAperturePointsBase = lightApertureBase + (2 * lightApertureHeaderStride);
    function finiteComponent(values, index, fallback) {
      var n = Number(values && values[index]);
      return Number.isFinite(n) ? n : fallback;
    }
    function writeLightAperture(lightIndex, lightValue) {
      var base = lightApertureBase + (lightIndex * lightApertureHeaderStride);
      var ptsBase = lightAperturePointsBase + (lightIndex * lightAperturePointsStride);
      for (var clear = 0; clear < lightApertureHeaderStride; clear += 1) {
        f32[base + clear] = 0.0;
      }
      for (var clearPt = 0; clearPt < lightAperturePointsStride; clearPt += 1) {
        f32[ptsBase + clearPt] = 0.0;
      }
      f32[base + 16] = Math.max(0.0, Number(lightValue && lightValue.source_radius || 0.0) || 0.0);
      f32[base + 17] = Math.max(0.0, Number(lightValue ? (lightValue.spread == null ? 1.0 : lightValue.spread) : 1.0) || 0.0);
      if (!lightValue || lightValue.kind_code < 1.5 || !lightValue.projected_aperture) {
        return;
      }
      var aperture = lightValue.projected_aperture;
      var packet = requirePlanarPacket(aperture, "projected light aperture");
      var planePoint = packet.planePoint;
      var planeNormal = packet.planeNormal;
      var uAxis = packet.uAxis;
      var vAxis = packet.vAxis;
      var points = packet.points;
      var count = Math.min(MAX_LIGHT_APERTURE_POINTS, points.length);
      f32[base + 0] = finiteComponent(planePoint, 0, 0.0);
      f32[base + 1] = finiteComponent(planePoint, 1, 0.0);
      f32[base + 2] = finiteComponent(planePoint, 2, 0.0);
      f32[base + 4] = finiteComponent(planeNormal, 0, 0.0);
      f32[base + 5] = finiteComponent(planeNormal, 1, 0.0);
      f32[base + 6] = finiteComponent(planeNormal, 2, 1.0);
      f32[base + 8] = finiteComponent(uAxis, 0, 0.0);
      f32[base + 9] = finiteComponent(uAxis, 1, 0.0);
      f32[base + 10] = finiteComponent(uAxis, 2, 0.0);
      f32[base + 12] = finiteComponent(vAxis, 0, 0.0);
      f32[base + 13] = finiteComponent(vAxis, 1, 0.0);
      f32[base + 14] = finiteComponent(vAxis, 2, 0.0);
      f32[base + 18] = count;
      f32[base + 19] = Math.max(0.0, Number(aperture.clip_epsilon || 0.0) || 0.0);
      for (var pointIndex = 0; pointIndex < count; pointIndex += 1) {
        var point = points[pointIndex];
        var pointBase = ptsBase + (pointIndex * 4);
        f32[pointBase + 0] = finiteComponent(point, 0, 0.0);
        f32[pointBase + 1] = finiteComponent(point, 1, 0.0);
      }
    }
    writeLightAperture(0, lights && lights.length ? lights[0] : null);
    writeLightAperture(1, lights && lights.length > 1 ? lights[1] : null);
    var shadowBase = lightAperturePointsBase + (2 * lightAperturePointsStride);
    function writeShadowMatrix(offset, matrix) {
      for (var mi = 0; mi < 16; mi += 1) {
        f32[offset + mi] = matrix && matrix.length === 16 ? Number(matrix[mi]) || 0.0 : (mi % 5 === 0 ? 1.0 : 0.0);
      }
    }
    writeShadowMatrix(shadowBase + 0, meshLike && meshLike.shadow_viewproj0);
    writeShadowMatrix(shadowBase + 16, meshLike && meshLike.shadow_viewproj1);
    f32[shadowBase + 32] = meshLike && meshLike.shadow_enabled0 ? 1.0 : 0.0;
    f32[shadowBase + 33] = Math.max(0.0, Number(meshLike && meshLike.shadow_bias0 || 0.0) || 0.0);
    f32[shadowBase + 34] = meshLike && meshLike.shadow_enabled1 ? 1.0 : 0.0;
    f32[shadowBase + 35] = Math.max(0.0, Number(meshLike && meshLike.shadow_bias1 || 0.0) || 0.0);

    return f32;
  }

  function buildShadowUniform(model, shadowViewProj0, shadowViewProj1) {
    var f32 = new Float32Array(SHADOW_UB_SIZE / 4);
    for (var i = 0; i < 16; i += 1) {
      f32[i] = model && model.length === 16 ? (Number(model[i]) || 0.0) : (i % 5 === 0 ? 1.0 : 0.0);
      f32[16 + i] = shadowViewProj0 && shadowViewProj0.length === 16 ? (Number(shadowViewProj0[i]) || 0.0) : (i % 5 === 0 ? 1.0 : 0.0);
      f32[32 + i] = shadowViewProj1 && shadowViewProj1.length === 16 ? (Number(shadowViewProj1[i]) || 0.0) : (i % 5 === 0 ? 1.0 : 0.0);
    }
    return f32;
  }

  function resolveAlphaMul(meshLike) {
    if (!meshLike) { return 1.0; }
    var raw = (typeof meshLike.alpha_provider === "function")
      ? meshLike.alpha_provider()
      : meshLike.alpha_mul;
    var alpha = Number(raw);
    if (!Number.isFinite(alpha)) { return 1.0; }
    if (alpha < 0) { return 0.0; }
    if (alpha > 1) { return 1.0; }
    return alpha;
  }

  // ---------------------------------------------------------------------------
  // lookAt: build view matrix from eye, target, up
  // ---------------------------------------------------------------------------
  function mat4LookAt(eye, target, up) {
    var Mm = getMath();
    var ex = eye[0], ey = eye[1], ez = eye[2];
    var tx = target[0], ty = target[1], tz = target[2];
    var ux = up[0], uy = up[1], uz = up[2];
    // forward = normalize(eye - target)
    var fx = ex - tx, fy = ey - ty, fz = ez - tz;
    var fl = Math.sqrt(fx*fx + fy*fy + fz*fz);
    if (fl < 1e-12) { fl = 1; }
    fx /= fl; fy /= fl; fz /= fl;
    // right = normalize(up × forward)
    var rx = uy*fz - uz*fy, ry = uz*fx - ux*fz, rz = ux*fy - uy*fx;
    var rl = Math.sqrt(rx*rx + ry*ry + rz*rz);
    if (rl < 1e-12) { rx = 1; ry = 0; rz = 0; rl = 1; }
    rx /= rl; ry /= rl; rz /= rl;
    // true up = forward × right
    var vx = fy*rz - fz*ry, vy = fz*rx - fx*rz, vz = fx*ry - fy*rx;
    // column-major mat4 (WebGPU std140)
    return new Float32Array([
      rx, vx, fx, 0,
      ry, vy, fy, 0,
      rz, vz, fz, 0,
      -(rx*ex + ry*ey + rz*ez),
      -(vx*ex + vy*ey + vz*ez),
      -(fx*ex + fy*ey + fz*ez),
      1,
    ]);
  }

  function mat4FromCameraBasis(eye, right, up, backward) {
    var ex = Number(eye[0] || 0.0);
    var ey = Number(eye[1] || 0.0);
    var ez = Number(eye[2] || 0.0);
    var rx = Number(right[0] || 0.0);
    var ry = Number(right[1] || 0.0);
    var rz = Number(right[2] || 0.0);
    var ux = Number(up[0] || 0.0);
    var uy = Number(up[1] || 0.0);
    var uz = Number(up[2] || 0.0);
    var bx = Number(backward[0] || 0.0);
    var by = Number(backward[1] || 0.0);
    var bz = Number(backward[2] || 0.0);
    return new Float32Array([
      rx, ux, bx, 0,
      ry, uy, by, 0,
      rz, uz, bz, 0,
      -((rx * ex) + (ry * ey) + (rz * ez)),
      -((ux * ex) + (uy * ey) + (uz * ez)),
      -((bx * ex) + (by * ey) + (bz * ez)),
      1,
    ]);
  }

  // Parse CSS-ish color name / #rrggbb to [r,g,b,a] f32
  var CSS_COLORS = {
    white: [1,1,1,1], black:[0,0,0,1], red:[1,0.1,0.1,1],
    green:[0.15,0.85,0.15,1], blue:[0.15,0.35,1,1],
    yellow:[1,0.9,0.1,1], cyan:[0.1,0.9,0.9,1], magenta:[0.9,0.1,0.9,1],
    orange:[1,0.5,0.05,1], gray:[0.5,0.5,0.5,1], grey:[0.5,0.5,0.5,1],
  };

  function parseColor(c) {
    if (!c) { return [0.8, 0.8, 0.8, 1]; }
    if (typeof c === "object" && c.length >= 3) {
      return [c[0], c[1], c[2], c.length >= 4 ? c[3] : 1];
    }
    var s = String(c).toLowerCase().trim();
    if (CSS_COLORS[s]) { return CSS_COLORS[s].slice(); }
    if (s.startsWith("#")) {
      var h = s.slice(1);
      if (h.length === 3) { h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2]; }
      var n = parseInt(h, 16);
      return [((n>>16)&255)/255, ((n>>8)&255)/255, (n&255)/255, 1];
    }
    return [0.8, 0.8, 0.8, 1];
  }

  function vec3Or(value, fallback) {
    if (value && typeof value === "object" && value.length >= 3) {
      return [
        Number(value[0]) || 0,
        Number(value[1]) || 0,
        Number(value[2]) || 0,
      ];
    }
    return fallback.slice();
  }

  function requireFiniteVec2(value, label) {
    if (!value || typeof value !== "object" || value.length < 2) {
      failFast(label + " requires a finite vec2");
    }
    var x = Number(value[0]);
    var y = Number(value[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      failFast(label + " requires a finite vec2");
    }
    return [x, y];
  }

  function requireFiniteVec3(value, label) {
    if (!value || typeof value !== "object" || value.length < 3) {
      failFast(label + " requires a finite vec3");
    }
    var x = Number(value[0]);
    var y = Number(value[1]);
    var z = Number(value[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      failFast(label + " requires a finite vec3");
    }
    return [x, y, z];
  }

  function requirePlanarPacket(packet, label) {
    if (!packet || typeof packet !== "object") {
      failFast(label + " requires a planar packet");
    }
    var planePoint = requireFiniteVec3(packet.plane_point, label + ".plane_point");
    var planeNormal = requireFiniteVec3(packet.plane_normal, label + ".plane_normal");
    var uAxis = requireFiniteVec3(packet.u_axis, label + ".u_axis");
    var vAxis = requireFiniteVec3(packet.v_axis, label + ".v_axis");
    var points = Array.isArray(packet.points) ? packet.points : null;
    if (!points || points.length < 3) {
      failFast(label + ".points requires at least 3 finite vec2 points");
    }
    return {
      planePoint: planePoint,
      planeNormal: planeNormal,
      uAxis: uAxis,
      vAxis: vAxis,
      points: points.map(function (point, index) {
        return requireFiniteVec2(point, label + ".points[" + index + "]");
      })
    };
  }

  function normalizeVec3(v, fallback) {
    var out = vec3Or(v, fallback);
    var len = Math.sqrt((out[0] * out[0]) + (out[1] * out[1]) + (out[2] * out[2]));
    if (!(len > 1e-9)) {
      return fallback.slice();
    }
    return [out[0] / len, out[1] / len, out[2] / len];
  }

  function subVec3(a, b) {
    return [
      Number(a[0] || 0) - Number(b[0] || 0),
      Number(a[1] || 0) - Number(b[1] || 0),
      Number(a[2] || 0) - Number(b[2] || 0)
    ];
  }

  function addVec3(a, b) {
    return [
      Number(a[0] || 0) + Number(b[0] || 0),
      Number(a[1] || 0) + Number(b[1] || 0),
      Number(a[2] || 0) + Number(b[2] || 0)
    ];
  }

  function dotVec3(a, b) {
    return (Number(a[0] || 0) * Number(b[0] || 0)) +
      (Number(a[1] || 0) * Number(b[1] || 0)) +
      (Number(a[2] || 0) * Number(b[2] || 0));
  }

  function crossVec3(a, b) {
    return [
      (Number(a[1] || 0) * Number(b[2] || 0)) - (Number(a[2] || 0) * Number(b[1] || 0)),
      (Number(a[2] || 0) * Number(b[0] || 0)) - (Number(a[0] || 0) * Number(b[2] || 0)),
      (Number(a[0] || 0) * Number(b[1] || 0)) - (Number(a[1] || 0) * Number(b[0] || 0))
    ];
  }

  function scaleVec3(v, scale) {
    var s = Number(scale || 0.0);
    return [
      (Number(v[0] || 0.0) * s),
      (Number(v[1] || 0.0) * s),
      (Number(v[2] || 0.0) * s)
    ];
  }

  function mat4FrustumOffCenterZ01(left, right, bottom, top, near, far) {
    var l = Number(left || 0.0);
    var r = Number(right || 0.0);
    var b = Number(bottom || 0.0);
    var t = Number(top || 0.0);
    var n = Number(near || 0.0);
    var f = Number(far || 0.0);
    if (!(Math.abs(r - l) > 1e-9) || !(Math.abs(t - b) > 1e-9) || !(Math.abs(n - f) > 1e-9)) {
      failFast("mirror frustum parameters are degenerate");
    }
    var nf = 1.0 / (n - f);
    return new Float32Array([
      (2.0 * n) / (r - l), 0, 0, 0,
      0, (2.0 * n) / (t - b), 0, 0,
      (r + l) / (r - l), (t + b) / (t - b), f * nf, -1,
      0, 0, n * f * nf, 0
    ]);
  }

  function transformPointMat4(m, point) {
    var x = Number(point[0]) || 0.0;
    var y = Number(point[1]) || 0.0;
    var z = Number(point[2]) || 0.0;
    return [
      (Number(m[0]) || 0.0) * x + (Number(m[4]) || 0.0) * y + (Number(m[8]) || 0.0) * z + (Number(m[12]) || 0.0),
      (Number(m[1]) || 0.0) * x + (Number(m[5]) || 0.0) * y + (Number(m[9]) || 0.0) * z + (Number(m[13]) || 0.0),
      (Number(m[2]) || 0.0) * x + (Number(m[6]) || 0.0) * y + (Number(m[10]) || 0.0) * z + (Number(m[14]) || 0.0)
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

  function transformVec4Mat4(m, v) {
    var x = Number(v[0]) || 0.0;
    var y = Number(v[1]) || 0.0;
    var z = Number(v[2]) || 0.0;
    var w = Number(v[3]) || 0.0;
    return [
      (Number(m[0]) || 0.0) * x + (Number(m[4]) || 0.0) * y + (Number(m[8]) || 0.0) * z + (Number(m[12]) || 0.0) * w,
      (Number(m[1]) || 0.0) * x + (Number(m[5]) || 0.0) * y + (Number(m[9]) || 0.0) * z + (Number(m[13]) || 0.0) * w,
      (Number(m[2]) || 0.0) * x + (Number(m[6]) || 0.0) * y + (Number(m[10]) || 0.0) * z + (Number(m[14]) || 0.0) * w,
      (Number(m[3]) || 0.0) * x + (Number(m[7]) || 0.0) * y + (Number(m[11]) || 0.0) * z + (Number(m[15]) || 0.0) * w
    ];
  }

  function invertMat4(m) {
    var out = new Float32Array(16);
    var a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    var a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    var a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    var a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    var b00 = a00 * a11 - a01 * a10;
    var b01 = a00 * a12 - a02 * a10;
    var b02 = a00 * a13 - a03 * a10;
    var b03 = a01 * a12 - a02 * a11;
    var b04 = a01 * a13 - a03 * a11;
    var b05 = a02 * a13 - a03 * a12;
    var b06 = a20 * a31 - a21 * a30;
    var b07 = a20 * a32 - a22 * a30;
    var b08 = a20 * a33 - a23 * a30;
    var b09 = a21 * a32 - a22 * a31;
    var b10 = a21 * a33 - a23 * a31;
    var b11 = a22 * a33 - a23 * a32;
    var det = (b00 * b11) - (b01 * b10) + (b02 * b09) + (b03 * b08) - (b04 * b07) + (b05 * b06);
    if (Math.abs(det) <= 1e-9) {
      failFast("mirror projection matrix is not invertible");
    }
    det = 1.0 / det;
    out[0] = ((a11 * b11) - (a12 * b10) + (a13 * b09)) * det;
    out[1] = ((a02 * b10) - (a01 * b11) - (a03 * b09)) * det;
    out[2] = ((a31 * b05) - (a32 * b04) + (a33 * b03)) * det;
    out[3] = ((a22 * b04) - (a21 * b05) - (a23 * b03)) * det;
    out[4] = ((a12 * b08) - (a10 * b11) - (a13 * b07)) * det;
    out[5] = ((a00 * b11) - (a02 * b08) + (a03 * b07)) * det;
    out[6] = ((a32 * b02) - (a30 * b05) - (a33 * b01)) * det;
    out[7] = ((a20 * b05) - (a22 * b02) + (a23 * b01)) * det;
    out[8] = ((a10 * b10) - (a11 * b08) + (a13 * b06)) * det;
    out[9] = ((a01 * b08) - (a00 * b10) - (a03 * b06)) * det;
    out[10] = ((a30 * b04) - (a31 * b02) + (a33 * b00)) * det;
    out[11] = ((a21 * b02) - (a20 * b04) - (a23 * b00)) * det;
    out[12] = ((a11 * b07) - (a10 * b09) - (a12 * b06)) * det;
    out[13] = ((a00 * b09) - (a01 * b07) + (a02 * b06)) * det;
    out[14] = ((a31 * b01) - (a30 * b03) - (a32 * b00)) * det;
    out[15] = ((a20 * b03) - (a21 * b01) + (a22 * b00)) * det;
    return out;
  }

  function reflectPointAcrossPlane(point, planePoint, planeNormal) {
    var delta = subVec3(point, planePoint);
    var dist = dotVec3(delta, planeNormal);
    return subVec3(point, scaleVec3(planeNormal, 2.0 * dist));
  }

  function reflectDirAcrossPlane(dir, planeNormal) {
    var dist = dotVec3(dir, planeNormal);
    return subVec3(dir, scaleVec3(planeNormal, 2.0 * dist));
  }

  function orthogonalUnitVector(dir) {
    var axis = Math.abs(Number(dir[2] || 0.0)) < 0.9 ? [0.0, 0.0, 1.0] : [0.0, 1.0, 0.0];
    return normalizeVec3(crossVec3(axis, dir), [1.0, 0.0, 0.0]);
  }

  function signedUnit(value) {
    return value >= 0.0 ? 1.0 : -1.0;
  }

  function planeEquationInCameraSpace(viewMatrix, planePointWorld, planeNormalWorld) {
    var pointCamera = transformPointMat4(viewMatrix, planePointWorld);
    var normalCamera = normalizeVec3(transformDirMat4(viewMatrix, planeNormalWorld), [0.0, 0.0, 1.0]);
    return [
      normalCamera[0],
      normalCamera[1],
      normalCamera[2],
      -dotVec3(normalCamera, pointCamera)
    ];
  }

  function applyObliqueNearPlaneZ01(projection, clipPlaneCamera) {
    var inverseProjection = invertMat4(projection);
    var q = transformVec4Mat4(inverseProjection, [
      signedUnit(Number(clipPlaneCamera[0] || 0.0)),
      signedUnit(Number(clipPlaneCamera[1] || 0.0)),
      1.0,
      1.0
    ]);
    var denom =
      (Number(clipPlaneCamera[0] || 0.0) * q[0]) +
      (Number(clipPlaneCamera[1] || 0.0) * q[1]) +
      (Number(clipPlaneCamera[2] || 0.0) * q[2]) +
      (Number(clipPlaneCamera[3] || 0.0) * q[3]);
    if (Math.abs(denom) <= 1e-8) {
      failFast("mirror clip plane is degenerate in camera space");
    }
    var scale = 1.0 / denom;
    var c0 = Number(clipPlaneCamera[0] || 0.0) * scale;
    var c1 = Number(clipPlaneCamera[1] || 0.0) * scale;
    var c2 = Number(clipPlaneCamera[2] || 0.0) * scale;
    var c3 = Number(clipPlaneCamera[3] || 0.0) * scale;
    var out = new Float32Array(projection);
    out[2] = c0;
    out[6] = c1;
    out[10] = c2;
    out[14] = c3;
    return out;
  }

  function tryApplyObliqueNearPlaneZ01(projection, clipPlaneCamera) {
    try {
      return {
        projection: applyObliqueNearPlaneZ01(projection, clipPlaneCamera),
        clipped: true,
        reason: ""
      };
    } catch (error) {
      return {
        projection: new Float32Array(projection),
        clipped: false,
        reason: error && error.message ? String(error.message) : "unknown mirror clip failure"
      };
    }
  }

  function planarPointsFromMeshVertices(meshLike, modelMatrix) {
    var verts = meshLike && meshLike.vertices;
    if (!verts || verts.length < 30) {
      failFast("mirror surface_system host mesh requires at least 3 vertices");
    }
    var points = [];
    for (var i = 0; i + 9 < verts.length; i += 10) {
      var local = [Number(verts[i] || 0.0), Number(verts[i + 1] || 0.0), Number(verts[i + 2] || 0.0)];
      if (!Number.isFinite(local[0]) || !Number.isFinite(local[1]) || !Number.isFinite(local[2])) { continue; }
      points.push(modelMatrix ? transformPointMat4(modelMatrix, local) : local);
    }
    if (points.length < 3) {
      failFast("mirror surface_system host mesh has no usable planar vertices");
    }
    return points;
  }

  function planarPointsFromQuadSpec(meshLike, modelMatrix) {
    var kind = String(meshLike && meshLike.kind || "").toLowerCase().trim();
    var hasSurfaceSystem = !!(meshLike && meshLike.surface_system);
    var rawSize = meshLike && meshLike.size;
    var quadLike = kind === "quad" || (hasSurfaceSystem && rawSize != null);
    if (!meshLike || !quadLike) {
      return null;
    }
    var size = rawSize;
    var sx = 0.0;
    var sy = 0.0;
    if (Array.isArray(size) && size.length >= 2) {
      sx = Number(size[0] || 0.0);
      sy = Number(size[1] || 0.0);
    } else {
      sx = Number(size || 0.0);
      sy = Number(size || 0.0);
    }
    if (!(sx > 1e-8) || !(sy > 1e-8)) {
      wlog("warn", "quad planar seam collapsed id=" + String(meshLike.id || "") + " size=" + JSON.stringify(size) + " keys=" + JSON.stringify(Object.keys(meshLike || {})));
      failFast("mirror surface_system host quad has collapsed size");
    }
    var halfX = sx * 0.5;
    var halfY = sy * 0.5;
    var locals = [
      [-halfX, -halfY, 0.0],
      [ halfX, -halfY, 0.0],
      [ halfX,  halfY, 0.0],
      [-halfX,  halfY, 0.0]
    ];
    var points = new Array(locals.length);
    for (var i = 0; i < locals.length; i += 1) {
      points[i] = modelMatrix ? transformPointMat4(modelMatrix, locals[i]) : locals[i].slice();
    }
    return points;
  }

  function derivePlanarFrameFromPoints(points) {
    var p0 = null;
    var p1 = null;
    var p2 = null;
    for (var i = 0; i < points.length; i += 1) {
      if (!p0) {
        p0 = points[i];
        continue;
      }
      if (!p1) {
        var firstEdge = subVec3(points[i], p0);
        if (dotVec3(firstEdge, firstEdge) > 1e-10) {
          p1 = points[i];
        }
        continue;
      }
      var edgeA = subVec3(p1, p0);
      var edgeB = subVec3(points[i], p0);
      var cross = crossVec3(edgeA, edgeB);
      if (dotVec3(cross, cross) > 1e-12) {
        p2 = points[i];
        break;
      }
    }
    if (!p0 || !p1 || !p2) {
      failFast("mirror surface_system host mesh must be planar with non-collinear vertices");
    }
    var uAxis = normalizeVec3(subVec3(p1, p0), [1.0, 0.0, 0.0]);
    var normal = normalizeVec3(crossVec3(subVec3(p1, p0), subVec3(p2, p0)), [0.0, 0.0, 1.0]);
    var vAxis = normalizeVec3(crossVec3(normal, uAxis), orthogonalUnitVector(uAxis));
    var minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    var maxPlaneDist = 0.0;
    for (var pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
      var rel = subVec3(points[pointIndex], p0);
      var planeDist = Math.abs(dotVec3(rel, normal));
      if (planeDist > maxPlaneDist) { maxPlaneDist = planeDist; }
      var u = dotVec3(rel, uAxis);
      var v = dotVec3(rel, vAxis);
      if (u < minU) { minU = u; }
      if (u > maxU) { maxU = u; }
      if (v < minV) { minV = v; }
      if (v > maxV) { maxV = v; }
    }
    var spanU = maxU - minU;
    var spanV = maxV - minV;
    var planarScale = Math.max(1.0, spanU, spanV);
    if (maxPlaneDist > (planarScale * 1e-4)) {
      failFast("mirror surface_system host mesh is not planar within tolerance");
    }
    if (!(spanU > 1e-6) || !(spanV > 1e-6)) {
      failFast("mirror surface_system host mesh has collapsed planar bounds");
    }
    return {
      point: p0.slice(),
      normal: normal.slice(),
      uAxis: uAxis.slice(),
      vAxis: vAxis.slice(),
      minU: minU,
      minV: minV,
      maxU: maxU,
      maxV: maxV,
      spanU: spanU,
      spanV: spanV
    };
  }

  function projectVectorOntoPlane(vector, planeNormal) {
    return subVec3(vector, scaleVec3(planeNormal, dotVec3(vector, planeNormal)));
  }

  function canonicalizePlanarFrameAxes(frame, points, preferredUp, preferredForward) {
    if (!frame || !Array.isArray(points) || points.length < 3) { return frame; }
    var upCandidate = preferredUp ? projectVectorOntoPlane(preferredUp, frame.normal) : [0.0, 0.0, 0.0];
    var upLen = Math.sqrt(dotVec3(upCandidate, upCandidate));
    if (!(upLen > 1e-8)) {
      upCandidate = frame.vAxis.slice();
      upLen = Math.sqrt(dotVec3(upCandidate, upCandidate));
    }
    if (!(upLen > 1e-8) && preferredForward) {
      upCandidate = projectVectorOntoPlane(preferredForward, frame.normal);
      upLen = Math.sqrt(dotVec3(upCandidate, upCandidate));
    }
    var vAxis = upLen > 1e-8 ? scaleVec3(upCandidate, 1.0 / upLen) : frame.vAxis.slice();
    var uAxis = normalizeVec3(crossVec3(vAxis, frame.normal), frame.uAxis);
    vAxis = normalizeVec3(crossVec3(frame.normal, uAxis), vAxis);
    var minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    for (var pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
      var rel = subVec3(points[pointIndex], frame.point);
      var u = dotVec3(rel, uAxis);
      var v = dotVec3(rel, vAxis);
      if (u < minU) { minU = u; }
      if (u > maxU) { maxU = u; }
      if (v < minV) { minV = v; }
      if (v > maxV) { maxV = v; }
    }
    return {
      point: frame.point.slice(),
      normal: frame.normal.slice(),
      uAxis: uAxis.slice(),
      vAxis: vAxis.slice(),
      minU: minU,
      minV: minV,
      maxU: maxU,
      maxV: maxV,
      spanU: maxU - minU,
      spanV: maxV - minV
    };
  }

  function mirrorWorldCorners(frame) {
    var minU = Number(frame.minU || 0.0);
    var minV = Number(frame.minV || 0.0);
    var maxU = Number(frame.maxU == null ? (minU + Number(frame.spanU || 0.0)) : frame.maxU);
    var maxV = Number(frame.maxV == null ? (minV + Number(frame.spanV || 0.0)) : frame.maxV);
    return {
      bottomLeft: addVec3(frame.point, addVec3(scaleVec3(frame.uAxis, minU), scaleVec3(frame.vAxis, minV))),
      bottomRight: addVec3(frame.point, addVec3(scaleVec3(frame.uAxis, maxU), scaleVec3(frame.vAxis, minV))),
      topLeft: addVec3(frame.point, addVec3(scaleVec3(frame.uAxis, minU), scaleVec3(frame.vAxis, maxV))),
      topRight: addVec3(frame.point, addVec3(scaleVec3(frame.uAxis, maxU), scaleVec3(frame.vAxis, maxV)))
    };
  }

  function planarFrameExtent(frame) {
    return Math.max(
      1e-6,
      Math.abs(Number(frame && frame.spanU || 0.0) || 0.0),
      Math.abs(Number(frame && frame.spanV || 0.0) || 0.0)
    );
  }

  function relativePlaneEpsilon(frame, ratioValue, fallbackRatio) {
    var extent = planarFrameExtent(frame);
    var ratio = Number(ratioValue);
    if (!Number.isFinite(ratio) || !(ratio > 0.0)) {
      ratio = Number(fallbackRatio);
    }
    if (!Number.isFinite(ratio) || !(ratio > 0.0)) {
      ratio = 1e-5;
    }
    ratio = Math.max(1e-8, Math.min(1e-3, ratio));
    return extent * ratio;
  }

  function resolvePlanarMirrorGeometry(meshLike, t, context) {
    var label = String(context || "planar mirror");
    if (!meshLike || typeof meshLike !== "object") {
      failFast(label + " requires a rendered mirror mesh");
    }
    var frame = mirrorFrameForLightMesh(meshLike, t);
    if (!frame) {
      failFast(label + ' mirror mesh "' + String(meshLike.id || "") + '" did not produce a canonical planar frame');
    }
    var center = planarFrameCenter(frame);
    var corners = mirrorWorldCorners(frame);
    var extent = planarFrameExtent(frame);
    return {
      mesh: meshLike,
      frame: frame,
      center: center,
      corners: corners,
      extent: extent,
      epsilon: function (ratioValue, fallbackRatio) {
        return relativePlaneEpsilon(frame, ratioValue, fallbackRatio);
      }
    };
  }

  function createPlanarMirrorRuntime(meshLike, t, context) {
    var geometry = resolvePlanarMirrorGeometry(meshLike, t, context);
    var frame = geometry.frame;
    var center = geometry.center;
    var corners = geometry.corners;
    function localPointFromCenter(worldPoint) {
      var rel = subVec3(worldPoint, center);
      return [
        dotVec3(rel, frame.uAxis),
        dotVec3(rel, frame.vAxis)
      ];
    }
    function aperturePacket(meshId, planeNormal, ratioValue, fallbackRatio) {
      return {
        mesh_id: String(meshId || (meshLike && meshLike.id) || ""),
        plane_point: center.slice(),
        plane_normal: normalizeVec3(planeNormal || frame.normal, frame.normal).slice(),
        u_axis: frame.uAxis.slice(),
        v_axis: frame.vAxis.slice(),
        points: [
          localPointFromCenter(corners.bottomLeft),
          localPointFromCenter(corners.bottomRight),
          localPointFromCenter(corners.topRight),
          localPointFromCenter(corners.topLeft)
        ],
        clip_epsilon: geometry.epsilon(ratioValue, fallbackRatio)
      };
    }
    function debugSnapshot() {
      return {
        mesh_id: String(meshLike && meshLike.id || ""),
        center: center.slice(),
        normal: frame.normal.slice(),
        u_axis: frame.uAxis.slice(),
        v_axis: frame.vAxis.slice(),
        corners: {
          bottomLeft: corners.bottomLeft.slice(),
          bottomRight: corners.bottomRight.slice(),
          topRight: corners.topRight.slice(),
          topLeft: corners.topLeft.slice()
        },
        extent: geometry.extent
      };
    }
    return {
      mesh: meshLike,
      geometry: geometry,
      frame: frame,
      center: center,
      corners: corners,
      extent: geometry.extent,
      epsilon: geometry.epsilon,
      aperturePacket: aperturePacket,
      debugSnapshot: debugSnapshot
    };
  }

  function orientMirrorBasisForEye(corners, eye, preferredUp) {
    void preferredUp;
    var bottomLeft = corners.bottomLeft;
    var bottomRight = corners.bottomRight;
    var topLeft = corners.topLeft;
    function buildBasis() {
      var rightLocal = normalizeVec3(subVec3(bottomRight, bottomLeft), [1.0, 0.0, 0.0]);
      var upLocal = normalizeVec3(subVec3(topLeft, bottomLeft), [0.0, 1.0, 0.0]);
      var backwardLocal = normalizeVec3(crossVec3(rightLocal, upLocal), [0.0, 0.0, 1.0]);
      return { right: rightLocal, up: upLocal, backward: backwardLocal };
    }
    var basis = buildBasis();
    if (dotVec3(basis.backward, subVec3(eye, bottomLeft)) < 0.0) {
      bottomLeft = corners.bottomRight;
      bottomRight = corners.bottomLeft;
      topLeft = corners.topRight;
      basis = buildBasis();
    }
    return {
      bottomLeft: bottomLeft,
      bottomRight: bottomRight,
      topLeft: topLeft,
      right: basis.right,
      up: basis.up,
      backward: basis.backward
    };
  }

  function derivePlanarSurfaceLocalFrame(meshLike) {
    if (meshLike && meshLike.vertices && meshLike.vertices.length >= 30) {
      return derivePlanarFrameFromPoints(planarPointsFromMeshVertices(meshLike, null));
    }
    var quadPoints = planarPointsFromQuadSpec(meshLike, null);
    if (Array.isArray(quadPoints) && quadPoints.length >= 3) {
      return derivePlanarFrameFromPoints(quadPoints);
    }
    failFast("mirror surface_system host mesh requires planar vertices or a quad spec");
  }

  function derivePlanarSurfaceWorldFrame(part, timeMs, MmLocal) {
    var meshLike = part && part.mesh;
    var modelMatrix = resolveAnimatedModelMatrix(
      meshLike,
      timeMs,
      meshLike && meshLike.center ? meshLike.center : [0, 0, 0],
      meshLike && meshLike.rotation ? meshLike.rotation : [0, 0, 0],
      meshLike && meshLike.scale ? meshLike.scale : [1, 1, 1],
      MmLocal || getMath()
    ) || ((meshLike && meshLike._modelMatrix) ? meshLike._modelMatrix : (MmLocal || getMath()).mat4Identity());
    var runtime = createPlanarMirrorRuntime(meshLike, timeMs, "mirror surface_system host");
    var frame = runtime.frame;
    var points = planarShadowPointsForMesh(meshLike, timeMs);
    if (!Array.isArray(points) || points.length < 3) {
      failFast("mirror surface_system host mesh requires planar vertices or a quad spec");
    }
    frame.modelMatrix = Array.prototype.slice.call(modelMatrix);
    frame.points = points.map(function (point) { return point.slice(); });
    return frame;
  }

  function inverseRigidPointMat4(m, point) {
    var px = Number(point[0]) || 0.0;
    var py = Number(point[1]) || 0.0;
    var pz = Number(point[2]) || 0.0;
    var tx = Number(m[12]) || 0.0;
    var ty = Number(m[13]) || 0.0;
    var tz = Number(m[14]) || 0.0;
    var x = px - tx;
    var y = py - ty;
    var z = pz - tz;
    return [
      ((Number(m[0]) || 0.0) * x) + ((Number(m[1]) || 0.0) * y) + ((Number(m[2]) || 0.0) * z),
      ((Number(m[4]) || 0.0) * x) + ((Number(m[5]) || 0.0) * y) + ((Number(m[6]) || 0.0) * z),
      ((Number(m[8]) || 0.0) * x) + ((Number(m[9]) || 0.0) * y) + ((Number(m[10]) || 0.0) * z)
    ];
  }

  function inverseRigidDirMat4(m, dir) {
    var dx = Number(dir[0]) || 0.0;
    var dy = Number(dir[1]) || 0.0;
    var dz = Number(dir[2]) || 0.0;
    return [
      ((Number(m[0]) || 0.0) * dx) + ((Number(m[1]) || 0.0) * dy) + ((Number(m[2]) || 0.0) * dz),
      ((Number(m[4]) || 0.0) * dx) + ((Number(m[5]) || 0.0) * dy) + ((Number(m[6]) || 0.0) * dz),
      ((Number(m[8]) || 0.0) * dx) + ((Number(m[9]) || 0.0) * dy) + ((Number(m[10]) || 0.0) * dz)
    ];
  }

  function clampPositiveNumber(value, fallback) {
    var n = Number(value);
    if (!Number.isFinite(n)) { return fallback; }
    return Math.max(0, n);
  }

  function projectMirrorWorldPointToUv(viewProjection, point, flipU) {
    if (!Array.isArray(viewProjection) && !(viewProjection instanceof Float32Array)) { return null; }
    if (!Array.isArray(point) || point.length < 3) { return null; }
    var x = Number(point[0]) || 0.0;
    var y = Number(point[1]) || 0.0;
    var z = Number(point[2]) || 0.0;
    var clipX = (Number(viewProjection[0]) * x) + (Number(viewProjection[4]) * y) + (Number(viewProjection[8]) * z) + Number(viewProjection[12] || 0.0);
    var clipY = (Number(viewProjection[1]) * x) + (Number(viewProjection[5]) * y) + (Number(viewProjection[9]) * z) + Number(viewProjection[13] || 0.0);
    var clipZ = (Number(viewProjection[2]) * x) + (Number(viewProjection[6]) * y) + (Number(viewProjection[10]) * z) + Number(viewProjection[14] || 0.0);
    var clipW = (Number(viewProjection[3]) * x) + (Number(viewProjection[7]) * y) + (Number(viewProjection[11]) * z) + Number(viewProjection[15] || 0.0);
    if (Math.abs(clipW) <= 1e-8) {
      return { clip: [clipX, clipY, clipZ, clipW], ndc: null, uv: null };
    }
    var ndcX = clipX / clipW;
    var ndcY = clipY / clipW;
    var ndcZ = clipZ / clipW;
    var uvX = (ndcX * 0.5) + 0.5;
    var uvY = 1.0 - ((ndcY * 0.5) + 0.5);
    if (flipU === true) { uvX = 1.0 - uvX; }
    return {
      clip: [clipX, clipY, clipZ, clipW],
      ndc: [ndcX, ndcY, ndcZ],
      uv: [uvX, uvY]
    };
  }

  function normalizeLightKind(kind) {
    var raw = String(kind == null ? "point" : kind).toLowerCase().trim();
    if (raw === "spotlight") { return "spot"; }
    if (raw !== "point" && raw !== "spot" && raw !== "projected") { return "point"; }
    return raw;
  }

  function radiansFromDegrees(value, fallbackDeg) {
    var deg = Number(value);
    if (!Number.isFinite(deg)) { deg = fallbackDeg; }
    return deg * (Math.PI / 180.0);
  }

  function resolveLightDirection(light, pos) {
    light = light || {};
    if (Array.isArray(light.direction) && light.direction.length >= 3) {
      return normalizeVec3(light.direction, [0, 0, -1]);
    }
    if (Array.isArray(light.dir) && light.dir.length >= 3) {
      return normalizeVec3(light.dir, [0, 0, -1]);
    }
    if (Array.isArray(light.target) && light.target.length >= 3) {
      return normalizeVec3([
        Number(light.target[0]) - Number(pos[0]),
        Number(light.target[1]) - Number(pos[1]),
        Number(light.target[2]) - Number(pos[2])
      ], [0, 0, -1]);
    }
    return [0, 0, -1];
  }

  function resolveLightPosition(light, t) {
    light = light || {};
    var target = vec3Or(light.target, [0, 0, 0]);
    if (Array.isArray(light.pos) && light.pos.length >= 3) {
      return vec3Or(light.pos, [0, 10, 10]);
    }
    var hasOrbit = light.orbit === true ||
      String(light.motion || "").toLowerCase().trim() === "orbit" ||
      String(light.motion || "").toLowerCase().trim() === "oscillate" ||
      light.orbit_radius !== undefined ||
      light.radius !== undefined ||
      light.angular_velocity !== undefined ||
      light.theta !== undefined;
    if (!hasOrbit) {
      return vec3Or(light.pos, [0, 10, 10]);
    }
    var radius = Number(light.orbit_radius != null ? light.orbit_radius : light.radius);
    if (!(radius > 0)) { radius = 4; }
    var height = Number(light.height);
    if (!isFinite(height)) { height = 3; }
    var theta = Number(light.theta);
    if (!isFinite(theta)) { theta = 0; }
    var angularVelocity = Number(light.angular_velocity);
    if (!isFinite(angularVelocity)) { angularVelocity = 0; }
    var seconds = Number(t || 0) * 0.001;
    var angle = theta + angularVelocity * seconds;
    return [
      target[0] + Math.cos(angle) * radius,
      target[1] + Math.sin(angle) * radius,
      target[2] + height,
    ];
  }

  function planarFrameCenter(frame) {
    if (!frame) { return [0.0, 0.0, 0.0]; }
    var midU = 0.5 * (Number(frame.minU || 0.0) + Number(frame.maxU == null ? (Number(frame.minU || 0.0) + Number(frame.spanU || 0.0)) : frame.maxU));
    var midV = 0.5 * (Number(frame.minV || 0.0) + Number(frame.maxV == null ? (Number(frame.minV || 0.0) + Number(frame.spanV || 0.0)) : frame.maxV));
    return addVec3(frame.point, addVec3(scaleVec3(frame.uAxis, midU), scaleVec3(frame.vAxis, midV)));
  }

  function fmtVec3(v) {
    return "[" +
      Number(v && v[0] || 0.0).toFixed(4) + "," +
      Number(v && v[1] || 0.0).toFixed(4) + "," +
      Number(v && v[2] || 0.0).toFixed(4) + "]";
  }

  function debugMirrorPlane(label, meshLike, frame, extra) {
    var meshId = String(meshLike && meshLike.id || "");
    if (meshId !== "back_mirror" && String(meshLike && meshLike.surface_system && meshLike.surface_system.kind || "").toLowerCase().trim() !== "screen") {
      return;
    }
    var now = Date.now();
    var key = String(label || "") + "::" + meshId;
    if (!global.__vfMirrorPlaneDebugLast) {
      global.__vfMirrorPlaneDebugLast = Object.create(null);
    }
    if ((now - Number(global.__vfMirrorPlaneDebugLast[key] || 0)) < 650) {
      return;
    }
    global.__vfMirrorPlaneDebugLast[key] = now;
    var center = frame ? planarFrameCenter(frame) : null;
    var parts = [
      "[DEBUG-MIRROR-PLANE]",
      "label=" + String(label || ""),
      "mesh=" + meshId,
      "center=" + fmtVec3(center),
      "normal=" + fmtVec3(frame && frame.normal),
      "point=" + fmtVec3(frame && frame.point),
      "meshCenter=" + fmtVec3(meshLike && meshLike.center),
      "rev=" + String(meshReverseFacing(meshLike)),
      "surface=" + String(meshLike && meshLike.surface_system && meshLike.surface_system.kind || ""),
      "verts=" + String(meshLike && meshLike.vertices && meshLike.vertices.length || 0)
    ];
    if (extra) {
      parts.push(String(extra));
    }
    wlog("warn", parts.join(" "));
  }

  function debugSurfaceBind(label, meshLike, extra) {
    var meshId = String(meshLike && meshLike.id || "");
    if (meshId !== "back_mirror" && String(meshLike && meshLike.surface_system && meshLike.surface_system.kind || "").toLowerCase().trim() !== "screen") {
      return;
    }
    var now = Date.now();
    var key = String(label || "") + "::" + meshId;
    if (!global.__vfSurfaceBindDebugLast) {
      global.__vfSurfaceBindDebugLast = Object.create(null);
    }
    if ((now - Number(global.__vfSurfaceBindDebugLast[key] || 0)) < 650) {
      return;
    }
    global.__vfSurfaceBindDebugLast[key] = now;
    var MmLocal = getMath();
    var modelMatrix = resolveAnimatedModelMatrix(
      meshLike,
      0,
      meshLike && meshLike.center || [0, 0, 0],
      meshLike && meshLike.rotation || [0, 0, 0],
      meshLike && meshLike.scale || [1, 1, 1],
      MmLocal
    ) || (MmLocal && MmLocal.mat4Identity ? MmLocal.mat4Identity() : null);
    var rawNormal = modelMatrix ? normalizeVec3(transformDirMat4(modelMatrix, [0, 0, 1]), [0, 0, 1]) : [0, 0, 1];
    var reverseNormal = meshReverseFacing(meshLike) ? scaleVec3(rawNormal, -1.0) : rawNormal;
    wlog(
      "warn",
      "[DEBUG-MIRROR-SURFACE] label=" + String(label || "") +
      " mesh=" + meshId +
      " rawNormal=" + fmtVec3(rawNormal) +
      " flaggedNormal=" + fmtVec3(reverseNormal) +
      " center=" + fmtVec3(meshLike && meshLike.center) +
      " flags=" + String(meshLike && meshLike.surface_system && meshLike.surface_system.reverse_facing === true ? 1 : 0) +
      (extra ? " " + String(extra) : "")
    );
  }

  function tryDerivePlanarFrameFromPoints(points) {
    try {
      return derivePlanarFrameFromPoints(points);
    } catch (_) {
      return null;
    }
  }

  function visiblePlanarPointsForMesh(meshLike, t, modelMatrix) {
    void t;
    if (!meshLike || typeof meshLike !== "object") { return null; }
    if (meshLike.vertices && meshLike.vertices.length >= 30) {
      var visiblePoints = planarPointsFromMeshVertices(meshLike, modelMatrix);
      if (Array.isArray(visiblePoints) && visiblePoints.length >= 3) {
        return visiblePoints;
      }
    }
    var authoredPoints = planarPointsFromQuadSpec(meshLike, modelMatrix);
    if (Array.isArray(authoredPoints) && authoredPoints.length >= 3) {
      return authoredPoints;
    }
    return null;
  }

  function frameFromQuadLikePoints(points) {
    if (!Array.isArray(points) || points.length < 4) {
      return null;
    }
    var p0 = points[0];
    var p1 = points[1];
    var p3 = points[3];
    var uAxis = normalizeVec3(subVec3(p1, p0), [1.0, 0.0, 0.0]);
    var normal = normalizeVec3(crossVec3(subVec3(p1, p0), subVec3(p3, p0)), [0.0, 0.0, 1.0]);
    var vAxis = normalizeVec3(crossVec3(normal, uAxis), orthogonalUnitVector(uAxis));
    var minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    for (var i = 0; i < points.length; i += 1) {
      var rel = subVec3(points[i], p0);
      var u = dotVec3(rel, uAxis);
      var v = dotVec3(rel, vAxis);
      if (u < minU) { minU = u; }
      if (u > maxU) { maxU = u; }
      if (v < minV) { minV = v; }
      if (v > maxV) { maxV = v; }
    }
    return {
      point: p0.slice(),
      normal: normal.slice(),
      uAxis: uAxis.slice(),
      vAxis: vAxis.slice(),
      minU: minU,
      minV: minV,
      maxU: maxU,
      maxV: maxV,
      spanU: maxU - minU,
      spanV: maxV - minV
    };
  }

  function meshReverseFacing(meshLike) {
    return !!(
      (meshLike && meshLike.reverse_facing === true) ||
      (meshLike && meshLike.surface_system && meshLike.surface_system.reverse_facing === true)
    );
  }

  function mirrorFrameForLightMesh(meshLike, t) {
    if (!meshLike) { return null; }
    var modelMatrix = resolveAnimatedModelMatrix(
      meshLike,
      t,
      meshLike.center || [0, 0, 0],
      meshLike.rotation || [0, 0, 0],
      meshLike.scale || [1, 1, 1],
      getMath()
    ) || (meshLike._modelMatrix || getMath().mat4Identity());
    var points = visiblePlanarPointsForMesh(meshLike, t, modelMatrix);
    if (!Array.isArray(points) || points.length < 3) { return null; }
    var frame = meshLike.vertices && meshLike.vertices.length === 40 && points.length >= 4
      ? frameFromQuadLikePoints(points)
      : tryDerivePlanarFrameFromPoints(points);
    if (!frame) { return null; }
    return frame;
  }

  function resolveLinkedMirrorLight(lightSpec, sourceLightsById, meshById, t) {
    var reflectOfId = String(lightSpec && lightSpec.reflect_of_light_id || "").trim();
    var mirrorMeshId = String(lightSpec && lightSpec.reflect_mirror_mesh_id || "").trim();
    if (!reflectOfId && !mirrorMeshId) { return lightSpec; }
    if (!reflectOfId || !mirrorMeshId) {
      failFast("reflected light requires both reflect_of_light_id and reflect_mirror_mesh_id");
    }
    var sourceLight = sourceLightsById && sourceLightsById[reflectOfId];
    var mirrorMesh = meshById && meshById[mirrorMeshId];
    if (!sourceLight) {
      failFast('reflected light source "' + reflectOfId + '" was not found');
    }
    if (!mirrorMesh) {
      failFast('reflected light mirror mesh "' + mirrorMeshId + '" was not found in rendered scene parts');
    }
    var runtime = createPlanarMirrorRuntime(mirrorMesh, t, "reflected light");
    var frame = runtime.frame;
    var planePoint = runtime.center;
    var planeNormal = normalizeVec3(frame.normal, [0.0, 1.0, 0.0]);
    var clipEpsilon = runtime.epsilon(lightSpec.clip_epsilon_ratio, 1e-5);
    var sourceSide = dotVec3(subVec3(sourceLight.pos, planePoint), planeNormal);
    debugMirrorPlane(
      "light-reflect",
      mirrorMesh,
      frame,
      "source=" + fmtVec3(sourceLight.pos) +
      " reflectNormal=" + fmtVec3(planeNormal) +
      " sourceSide=" + Number(sourceSide || 0.0).toFixed(4) +
      " epsilon=extent*" + Number(lightSpec.clip_epsilon_ratio || 1e-5).toFixed(8) + "=" + clipEpsilon.toFixed(8) +
      " aperturePlanePoint=" + fmtVec3(planePoint)
    );
    var reflectivity = 1.0;
    if (mirrorMesh.surface_system && typeof mirrorMesh.surface_system === "object") {
      reflectivity = Math.max(0.0, Math.min(1.0, Number(mirrorMesh.surface_system.reflectivity == null ? 1.0 : mirrorMesh.surface_system.reflectivity) || 0.0));
    }
    var resolved = Object.assign({}, lightSpec, {
      pos: reflectPointAcrossPlane(sourceLight.pos, planePoint, planeNormal),
      target: reflectPointAcrossPlane(sourceLight.target, planePoint, planeNormal),
      motion: "linked_reflection"
    });
    if (resolved.intensity != null) {
      resolved.intensity = clampPositiveNumber(resolved.intensity, 0.0) * reflectivity;
    }
    if (resolved.power != null) {
      resolved.power = clampPositiveNumber(resolved.power, 0.0) * reflectivity;
    }
    if (!(sourceSide > clipEpsilon)) {
      resolved.intensity = 0.0;
      resolved.power = 0.0;
      resolved.casts_shadow = false;
    }
    if (!(reflectivity > 1e-4)) {
      resolved.intensity = 0.0;
      resolved.power = 0.0;
      resolved.casts_shadow = false;
    }
    if (!resolved.aperture_mesh_id) {
      resolved.aperture_mesh_id = mirrorMeshId;
    }
    if (normalizeLightKind(resolved.kind) === "projected") {
      resolved.projected_aperture = runtime.aperturePacket(mirrorMeshId, planeNormal, lightSpec.clip_epsilon_ratio, 1e-5);
    }
    return resolved;
  }

  function resolveProjectedLightFromMeshId(lightSpec, meshById, t) {
    if (!lightSpec || normalizeLightKind(lightSpec.kind) !== "projected") { return lightSpec; }
    if (lightSpec.projected_aperture && typeof lightSpec.projected_aperture === "object") { return lightSpec; }
    var apertureMeshId = String(lightSpec.aperture_mesh_id || "").trim();
    if (!apertureMeshId) {
      failFast("projected light requires aperture_mesh_id or projected_aperture");
    }
    var apertureMesh = meshById && meshById[apertureMeshId];
    if (!apertureMesh) {
      failFast('projected light aperture mesh "' + apertureMeshId + '" was not found in rendered scene parts');
    }
    var runtime = createPlanarMirrorRuntime(apertureMesh, t, "projected light aperture");
    debugMirrorPlane("light-aperture", apertureMesh, runtime.frame, "apertureCenter=" + fmtVec3(runtime.center));
    return Object.assign({}, lightSpec, {
      projected_aperture: runtime.aperturePacket(apertureMeshId, runtime.frame.normal, lightSpec.clip_epsilon_ratio, 1e-5)
    });
  }

  function planarShadowPointsForMesh(meshLike, t) {
    if (!meshLike || typeof meshLike !== "object") { return null; }
    var meshKind = String(meshLike.kind || "").toLowerCase().trim();
    var isQuadLike = meshKind === "quad" || (meshLike.surface_system && meshLike.size != null);
    var isRenderQuad = !!(meshLike.vertices && meshLike.vertices.length === 40);
    if (!isQuadLike && !isRenderQuad) {
      return null;
    }
    var modelMatrix = resolveAnimatedModelMatrix(
      meshLike,
      t,
      meshLike.center || [0, 0, 0],
      meshLike.rotation || [0, 0, 0],
      meshLike.scale || [1, 1, 1],
      getMath()
    ) || (meshLike._modelMatrix || getMath().mat4Identity());
    return visiblePlanarPointsForMesh(meshLike, t, modelMatrix);
  }

  function planarFrameForShadowMesh(meshLike, t) {
    if (!meshLike || typeof meshLike !== "object") { return null; }
    if (meshLike.visible === false || meshLike.casts_shadow === false) { return null; }
    var points = planarShadowPointsForMesh(meshLike, t);
    if (!Array.isArray(points) || points.length < 3) { return null; }
    var runtime = createPlanarMirrorRuntime(meshLike, t, "planar shadow frame");
    var frame = runtime.frame;
    debugMirrorPlane("shadow-frame", meshLike, frame, "");
    var extent = 0.0;
    for (var i = 0; i < points.length; i += 1) {
      var rel = subVec3(points[i], frame.point);
      extent = Math.max(extent, Math.sqrt(dotVec3(rel, rel)));
      if (Math.abs(dotVec3(rel, frame.normal)) > Math.max(1e-3, extent * 1e-3)) {
        return null;
      }
    }
    return frame;
  }

  function buildPlanarContactOccluder(meshLike, t) {
    var frame = planarFrameForShadowMesh(meshLike, t);
    if (!frame) { return null; }
    if (isPlanarScreenShadowSurface(meshLike)) { return null; }
    debugMirrorPlane("analytic-shadow", meshLike, frame, "");
    var runtime = createPlanarMirrorRuntime(meshLike, t, "planar contact occluder");
    var packet = runtime.aperturePacket(meshLike && meshLike.id, frame.normal, null, 1e-5);
    packet.contact_band = 0.08;
    return packet;
  }

  function resolvePlanarContactOccluderForLight(parts, light, t) {
    if (!Array.isArray(parts) || !light || normalizeLightKind(light.kind) === "projected") {
      return null;
    }
    var best = null;
    var bestScore = Infinity;
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i];
      var meshLike = part && part.mesh;
      var occluder = buildPlanarContactOccluder(meshLike, t);
      if (!occluder) {
        continue;
      }
      var surfaceKind = String(meshLike && meshLike.surface_system && meshLike.surface_system.kind || "").toLowerCase().trim();
      var normal = normalizeVec3(occluder.plane_normal, [0.0, 0.0, 1.0]);
      var horizontalScore = Math.abs(dotVec3(normal, [0.0, 0.0, 1.0]));
      if (horizontalScore > 0.75) {
        continue;
      }
      var score = horizontalScore;
      if (surfaceKind === "screen") {
        score -= 1.0;
      }
      if (score < bestScore) {
        bestScore = score;
        best = occluder;
      }
    }
    return best;
  }

  function resolveSceneLights(rawLights, meshLike, t) {
    var baseLights = (rawLights || []).map(function (l) { return normalizeLight(l, t); });
    var sourceLightsById = Object.create(null);
    for (var i = 0; i < baseLights.length; i += 1) {
      var sourceLight = baseLights[i];
      if (sourceLight && rawLights[i] && rawLights[i].id) {
        sourceLightsById[String(rawLights[i].id)] = sourceLight;
      }
    }
    var meshById = Object.create(null);
    var partSpecs = Array.isArray(meshLike && meshLike.parts) ? meshLike.parts : [];
    for (var pi = 0; pi < partSpecs.length; pi += 1) {
      var partMesh = partSpecs[pi];
      if (partMesh && partMesh.id) {
        meshById[String(partMesh.id)] = partMesh;
      }
    }
    return baseLights.map(function (lightSpec, index) {
      var resolved = resolveLinkedMirrorLight(lightSpec, sourceLightsById, meshById, t);
      resolved = resolveProjectedLightFromMeshId(resolved, meshById, t);
      return resolved;
    });
  }

  function sceneMeshForLightResolution(meshLike, parts) {
    if (!meshLike || !Array.isArray(parts) || !parts.length) {
      return meshLike;
    }
    var runtimeParts = new Array(parts.length);
    for (var i = 0; i < parts.length; i += 1) {
      runtimeParts[i] = parts[i] && parts[i].mesh ? parts[i].mesh : null;
    }
    return Object.assign({}, meshLike, { parts: runtimeParts });
  }

  function lightsForRenderer(rawLights, offscreenFrame) {
    if (!Array.isArray(rawLights)) { return []; }
    if (offscreenFrame !== true) { return rawLights; }
    var filtered = [];
    for (var i = 0; i < rawLights.length; i += 1) {
      var light = rawLights[i];
      if (light && String(light.reflect_of_light_id || "").trim()) {
        continue;
      }
      filtered.push(light);
    }
    return filtered;
  }

  function lightsForMesh(rawLights, offscreenFrame, meshLike) {
    var rendererLights = lightsForRenderer(rawLights, offscreenFrame);
    var meshId = String(meshLike && meshLike.id || "").trim();
    if (!meshId) { return rendererLights; }
    var out = [];
    for (var i = 0; i < rendererLights.length; i += 1) {
      var light = rendererLights[i];
      var kind = normalizeLightKind(light && light.kind);
      var apertureMeshId = String(light && (light.aperture_mesh_id || light.aperture_face_id) || "").trim();
      var mirrorMeshId = String(light && light.reflect_mirror_mesh_id || "").trim();
      if (kind === "projected" && (apertureMeshId === meshId || mirrorMeshId === meshId)) {
        continue;
      }
      out.push(light);
    }
    return out;
  }

  function normalizeLight(light, t) {
    light = light || {};
    if (light.clip_epsilon != null && light.clip_epsilon_ratio == null) {
      failFast("native_scene light clip_epsilon is absolute; use clip_epsilon_ratio");
    }
    var pos = resolveLightPosition(light, t);
    var kind = normalizeLightKind(light.kind);
    var defaultShowMarker = kind === "projected" ? false : true;
    var intensity = clampPositiveNumber(light.intensity != null ? light.intensity : light.power, 24.0);
    var range = clampPositiveNumber(light.range, 0.0);
    var innerRad = radiansFromDegrees(light.inner_cone_deg, 14.0);
    var outerRad = radiansFromDegrees(light.outer_cone_deg, 22.0);
    return {
      id: String(light.id || ""),
      pos: pos,
      target: vec3Or(light.target, [0, 0, 0]),
      color_f32: parseColor(light.color || "white"),
      model: light.model || "blinn_phong",
      intensity: intensity,
      direction_f32: resolveLightDirection(light, pos),
      kind: kind,
      kind_code: kind === "spot" ? 1.0 : (kind === "projected" ? 2.0 : 0.0),
      inner_cone_cos: Math.cos(Math.min(innerRad, outerRad)),
      outer_cone_cos: Math.cos(Math.max(innerRad, outerRad)),
      range: range,
      casts_shadow: light.casts_shadow !== false,
      show_marker: light.show_marker !== undefined ? light.show_marker !== false : defaultShowMarker,
      source_radius: clampPositiveNumber(light.source_radius, 0.0),
      spread: clampPositiveNumber(light.spread, 1.0),
      aperture_mesh_id: String(light.aperture_mesh_id || light.aperture_face_id || ""),
      reflect_of_light_id: String(light.reflect_of_light_id || ""),
      reflect_mirror_mesh_id: String(light.reflect_mirror_mesh_id || ""),
      clip_epsilon_ratio: clampPositiveNumber(light.clip_epsilon_ratio, 1e-5),
      projected_aperture: light && light.projected_aperture && typeof light.projected_aperture === "object"
        ? light.projected_aperture
        : null,
    };
  }

  function chooseShadowUp(direction) {
    var dir = normalizeVec3(direction, [0.0, 0.0, -1.0]);
    var worldUp = [0.0, 0.0, 1.0];
    if (Math.abs(dotVec3(dir, worldUp)) > 0.95) {
      worldUp = [0.0, 1.0, 0.0];
    }
    return normalizeVec3(worldUp, [0.0, 0.0, 1.0]);
  }

  function shadowCasterParts(parts, includeScreens) {
    if (!Array.isArray(parts)) { return []; }
    var out = [];
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i];
      var mesh = part && part.mesh;
      if (!mesh || part.topology !== "triangle-list") { continue; }
      if (mesh.visible === false) { continue; }
      if (mesh.casts_shadow === false) { continue; }
      if (mesh.pickable === false && mesh.no_lighting === true) { continue; }
      if (String(mesh.blend_mode || "") === "additive") { continue; }
      out.push(part);
    }
    return out;
  }

  function planarContactParts(parts) {
    if (!Array.isArray(parts)) { return []; }
    var out = [];
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i];
      var mesh = part && part.mesh;
      if (!mesh || part.topology !== "triangle-list") { continue; }
      if (mesh.visible === false) { continue; }
      if (mesh.casts_shadow === false) { continue; }
      if (mesh.pickable === false && mesh.no_lighting === true) { continue; }
      if (String(mesh.blend_mode || "") === "additive") { continue; }
      if (isPlanarScreenShadowSurface(mesh)) { continue; }
      out.push(part);
    }
    return out;
  }

  function modelMatrixSignature(model) {
    var sig = "";
    for (var i = 0; i < 16; i += 1) {
      if (i > 0) { sig += ","; }
      sig += Number(model && model[i] || 0).toFixed(4);
    }
    return sig;
  }

  function buildShadowCasterSignature(parts, t, MmLocal) {
    if (!Array.isArray(parts) || !parts.length) { return ""; }
    var chunks = [];
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i];
      var mesh = part && part.mesh;
      if (!mesh) { continue; }
      var model = resolveAnimatedModelMatrix(
        mesh,
        t,
        mesh.center || [0, 0, 0],
        mesh.rotation || [0, 0, 0],
        mesh.scale || [1, 1, 1],
        MmLocal
      ) || (mesh._modelMatrix || MmLocal.mat4Identity());
      var modelSig = modelMatrixSignature(model);
      chunks.push(
        String(mesh.id || "") + ":" +
        String(mesh.kind || "") + ":" +
        String((mesh.vertices && mesh.vertices.length) || 0) + ":" +
        String((part && part.ibCount) || 0) + ":" +
        modelSig
      );
    }
    return chunks.join("|");
  }

  function collectShadowWorldPoints(parts, t, MmLocal) {
    var points = [];
    if (!Array.isArray(parts)) { return points; }
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i];
      var mesh = part && part.mesh;
      if (!mesh || part.topology !== "triangle-list") { continue; }
      if (mesh.visible === false) { continue; }
      if (mesh.casts_shadow === false) { continue; }
      if (mesh.pickable === false && mesh.no_lighting === true) { continue; }
      if (String(mesh.blend_mode || "") === "additive") { continue; }
      var model = resolveAnimatedModelMatrix(
        mesh,
        t,
        mesh.center || [0, 0, 0],
        mesh.rotation || [0, 0, 0],
        mesh.scale || [1, 1, 1],
        MmLocal
      ) || (mesh._modelMatrix || MmLocal.mat4Identity());
      var modelSig = modelMatrixSignature(model);
      var verts = mesh.vertices;
      if (!verts || verts.length < 30) { continue; }
      if (part._shadowWorldPointsModelSig === modelSig && Array.isArray(part._shadowWorldPointsCache) && part._shadowWorldPointsCache.length) {
        Array.prototype.push.apply(points, part._shadowWorldPointsCache);
        continue;
      }
      var transformedPoints = [];
      for (var vi = 0; vi + 9 < verts.length; vi += 10) {
        transformedPoints.push(transformPointMat4(model, [verts[vi], verts[vi + 1], verts[vi + 2]]));
      }
      part._shadowWorldPointsModelSig = modelSig;
      part._shadowWorldPointsCache = transformedPoints;
      Array.prototype.push.apply(points, transformedPoints);
    }
    return points;
  }

  function shadowCasterPartsForLight(casterParts, light, t) {
    var out = [];
    if (!Array.isArray(casterParts) || !light) { return out; }
    var apertureCasterId = light && light.projected_aperture && light.projected_aperture.mesh_id
      ? String(light.projected_aperture.mesh_id)
      : "";
    for (var cpi = 0; cpi < casterParts.length; cpi += 1) {
      var casterPart = casterParts[cpi];
      var casterMesh = casterPart && casterPart.mesh;
      if (!casterMesh) { continue; }
      if (apertureCasterId && String(casterMesh.id || "") === apertureCasterId) {
        continue;
      }
      if (canPlanarSurfaceCastShadowForLight(casterMesh, light, t)) {
        out.push(casterPart);
      }
    }
    return out;
  }

  function isPlanarScreenShadowSurface(meshLike) {
    if (!meshLike || typeof meshLike !== "object") {
      return false;
    }
    var surfaceKind = String(meshLike.surface_system && meshLike.surface_system.kind || "").toLowerCase().trim();
    if (surfaceKind === "screen") {
      return true;
    }
    var meshKind = String(meshLike.kind || "").toLowerCase().trim();
    var isPlanar = meshKind === "quad" || meshLike.size != null || (meshLike.vertices && meshLike.vertices.length === 40);
    return isPlanar && meshLike.no_backface_specular === true && meshLike.receives_shadow === false;
  }

  function canPlanarSurfaceCastShadowForLight(meshLike, light, t) {
    if (!isPlanarScreenShadowSurface(meshLike) || !light || normalizeLightKind(light.kind) === "projected") {
      return true;
    }
    var lightKind = normalizeLightKind(light.kind);
    var runtime = createPlanarMirrorRuntime(meshLike, t, "planar shadow light gate");
    var frame = runtime.frame;
    var planePoint = runtime.center;
    var planeNormal = normalizeVec3(frame.normal, [0.0, 1.0, 0.0]);
    var lightSide = dotVec3(subVec3(vec3Or(light.pos, [0.0, 0.0, 0.0]), planePoint), planeNormal);
    if (lightKind === "point") {
      return Math.abs(lightSide) > 1e-4;
    }
    var targetSide = dotVec3(subVec3(vec3Or(light.target, planePoint), planePoint), planeNormal);
    if (Math.abs(lightSide) <= 1e-4 || Math.abs(targetSide) <= 1e-4) {
      return true;
    }
    debugMirrorPlane(
      "shadow-gate",
      meshLike,
      frame,
      "light=" + fmtVec3(light.pos) +
      " target=" + fmtVec3(light.target) +
      " lightSide=" + Number(lightSide || 0.0).toFixed(4) +
      " targetSide=" + Number(targetSide || 0.0).toFixed(4) +
      " casts=" + String(lightSide * targetSide < 0.0)
    );
    return lightSide * targetSide < 0.0;
  }

  function fitShadowViewProjection(light, worldPoints, MmLocal) {
    if (!light || !Array.isArray(worldPoints) || !worldPoints.length) { return null; }
    var eye = vec3Or(light.pos, [0.0, 0.0, 0.0]);
    var aperture = light && light.projected_aperture && typeof light.projected_aperture === "object"
      ? light.projected_aperture
      : null;
    if (aperture) {
      var aperturePacket = requirePlanarPacket(aperture, "projected shadow aperture");
      var planePoint = aperturePacket.planePoint;
      var planeNormal = normalizeVec3(aperturePacket.planeNormal, [0.0, 0.0, 1.0]);
      var uAxis = normalizeVec3(aperturePacket.uAxis, [1.0, 0.0, 0.0]);
      var vAxis = normalizeVec3(aperturePacket.vAxis, [0.0, 1.0, 0.0]);
      var aperturePts = aperturePacket.points;
      var clipEpsilon = Math.max(0.0, Number(aperture.clip_epsilon || 0.0) || 0.0);
      var lightSide = dotVec3(subVec3(eye, planePoint), planeNormal);
      var targetProj = subVec3(planePoint, scaleVec3(planeNormal, lightSide));
      var target = addVec3(targetProj, scaleVec3(planeNormal, -Math.max(1.0, Math.abs(lightSide))));
      var forwardA = normalizeVec3(subVec3(target, eye), [0.0, 0.0, -1.0]);
      var upA = chooseShadowUp(forwardA);
      var viewA = mat4LookAt(eye, target, upA);
      function localSide(a, b, p) {
        return ((b[0] - a[0]) * (p[1] - a[1])) - ((b[1] - a[1]) * (p[0] - a[0]));
      }
      function pointInApertureLocal(local) {
        if (!Array.isArray(aperturePts) || aperturePts.length < 3) { return false; }
        var sign = 0.0;
        for (var ai = 0; ai < aperturePts.length; ai += 1) {
          var a = aperturePts[ai];
          var b = aperturePts[(ai + 1) % aperturePts.length];
          var side = localSide(a, b, local);
          if (Math.abs(side) <= 1e-6) { continue; }
          if (sign === 0.0) {
            sign = side > 0.0 ? 1.0 : -1.0;
            continue;
          }
          if ((side > 0.0 ? 1.0 : -1.0) !== sign) { return false; }
        }
        return true;
      }
      function projectedPointAccepted(worldPoint) {
        var pointSide = dotVec3(subVec3(worldPoint, planePoint), planeNormal);
        var receiverSide = (-Math.sign(lightSide || 1.0)) * pointSide;
        if (!(receiverSide > clipEpsilon)) { return false; }
        var ray = subVec3(worldPoint, eye);
        var denom = dotVec3(planeNormal, ray);
        if (Math.abs(denom) <= 1e-6) { return false; }
        var tHit = dotVec3(subVec3(planePoint, eye), planeNormal) / denom;
        if (!(tHit > 1e-4 && tHit < (1.0 - 1e-4))) { return false; }
        var hit = addVec3(eye, scaleVec3(ray, tHit));
        var rel = subVec3(hit, planePoint);
        var local = [dotVec3(rel, uAxis), dotVec3(rel, vAxis)];
        return pointInApertureLocal(local);
      }
      var candidatePoints = [];
      for (var pi = 0; pi < aperturePts.length; pi += 1) {
        var apt = aperturePts[pi];
        candidatePoints.push(addVec3(planePoint, addVec3(scaleVec3(uAxis, Number(apt[0]) || 0.0), scaleVec3(vAxis, Number(apt[1]) || 0.0))));
      }
      for (var wi = 0; wi < worldPoints.length; wi += 1) {
        if (projectedPointAccepted(worldPoints[wi])) {
          candidatePoints.push(worldPoints[wi]);
        }
      }
      var minDistA = Infinity;
      var maxDistA = 0.0;
      var maxTanXA = 0.0;
      var maxTanYA = 0.0;
      for (var ci = 0; ci < candidatePoints.length; ci += 1) {
        var pViewA = transformPointMat4(viewA, candidatePoints[ci]);
        var distA = -Number(pViewA[2] || 0.0);
        if (!(distA > 1e-4)) { continue; }
        if (distA < minDistA) { minDistA = distA; }
        if (distA > maxDistA) { maxDistA = distA; }
        maxTanXA = Math.max(maxTanXA, Math.abs(Number(pViewA[0] || 0.0)) / distA);
        maxTanYA = Math.max(maxTanYA, Math.abs(Number(pViewA[1] || 0.0)) / distA);
      }
      if (!(maxDistA > 1e-3) || !(minDistA < Infinity)) { return null; }
      var nearA = Math.max(0.05, minDistA * 0.98);
      var farA = Math.max(nearA + 1.0, maxDistA * 1.04);
      maxTanXA = Math.max(maxTanXA, 1e-3);
      maxTanYA = Math.max(maxTanYA, 1e-3);
      var aspectA = Math.max(1e-3, maxTanXA / maxTanYA);
      var fovYA = 2.0 * Math.atan(maxTanYA);
      var projA = MmLocal.mat4PerspectiveZ01(fovYA, aspectA, nearA, farA);
      return {
        view: viewA,
        projection: projA,
        viewProjection: MmLocal.mat4Mul(projA, viewA),
        bias: Math.max(0.0008, Math.min(0.0035, 0.0010 + ((farA - nearA) * 0.00002)))
      };
    }
    var target;
    if (normalizeLightKind(light.kind) === "point") {
      target = [0.0, 0.0, 0.0];
      for (var centerIndex = 0; centerIndex < worldPoints.length; centerIndex += 1) {
        target = addVec3(target, worldPoints[centerIndex]);
      }
      target = scaleVec3(target, 1.0 / Math.max(1, worldPoints.length));
    } else {
      target = Array.isArray(light.target) ? vec3Or(light.target, [0.0, 0.0, 0.0]) : addVec3(eye, vec3Or(light.direction_f32, [0.0, 0.0, -1.0]));
    }
    var forward = normalizeVec3(subVec3(target, eye), [0.0, 0.0, -1.0]);
    var up = chooseShadowUp(forward);
    var view = mat4LookAt(eye, target, up);
    var minDist = Infinity;
    var maxDist = 0.0;
    var maxTanX = 0.0;
    var maxTanY = 0.0;
    for (var i = 0; i < worldPoints.length; i += 1) {
      var pView = transformPointMat4(view, worldPoints[i]);
      var dist = -Number(pView[2] || 0.0);
      if (!(dist > 1e-4)) { continue; }
      if (dist < minDist) { minDist = dist; }
      if (dist > maxDist) { maxDist = dist; }
      maxTanX = Math.max(maxTanX, Math.abs(Number(pView[0] || 0.0)) / dist);
      maxTanY = Math.max(maxTanY, Math.abs(Number(pView[1] || 0.0)) / dist);
    }
    if (!(maxDist > 1e-3) || !(minDist < Infinity)) { return null; }
    var near = Math.max(0.05, minDist * 0.8);
    var far = Math.max(near + 1.0, maxDist * 1.1);
    maxTanX = Math.max(maxTanX, 1e-3);
    maxTanY = Math.max(maxTanY, 1e-3);
    var aspect = Math.max(1e-3, maxTanX / maxTanY);
    var fovY = 2.0 * Math.atan(maxTanY);
    var proj = MmLocal.mat4PerspectiveZ01(fovY, aspect, near, far);
    return {
      view: view,
      projection: proj,
      viewProjection: MmLocal.mat4Mul(proj, view),
      bias: Math.max(0.0008, Math.min(0.0035, 0.0010 + ((far - near) * 0.00002)))
    };
  }

  function meshTiming(meshLike) {
    var timing = meshLike && meshLike.animation_timing && typeof meshLike.animation_timing === "object"
      ? meshLike.animation_timing
      : {};
    var fps = Math.max(1, Number(timing.fps || 30) | 0);
    var durationSeconds = Math.max(0.001, Number(timing.duration_seconds || 10.0));
    var boundary = String(timing.boundary || "repeat");
    var frameCount = Math.max(1, Math.round(fps * durationSeconds));
    return {
      fps: fps,
      duration_seconds: durationSeconds,
      boundary: boundary,
      frameCount: frameCount
    };
  }

  function resolveMeshFramePosition(framePos, timing) {
    timing = timing || meshTiming(null);
    var frameCount = Math.max(1, Number(timing.frameCount || 1) | 0);
    var boundary = String(timing.boundary || "repeat");
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

  function resolveMeshTrackSample(t, count, timing) {
    if (!(count > 0)) { return { index0: 0, index1: 0, mix: 0.0 }; }
    if (count <= 1) { return { index0: 0, index1: 0, mix: 0.0 }; }
    timing = timing || meshTiming(null);
    var framePos = Math.max(0.0, Number(t || 0) * 0.001 * timing.fps);
    var resolved = resolveMeshFramePosition(framePos, timing);
    var scaled;
    var index0;
    var mix;
    if (timing.boundary === "repeat" || timing.boundary === "reset") {
      scaled = (resolved / Math.max(1e-6, timing.frameCount)) * count;
      index0 = Math.floor(scaled);
      mix = scaled - index0;
      index0 = ((index0 % count) + count) % count;
      return { index0: index0, index1: (index0 + 1) % count, mix: mix };
    }
    scaled = (resolved / Math.max(1e-6, timing.frameCount - 1)) * (count - 1);
    if (scaled <= 0.0) { return { index0: 0, index1: 0, mix: 0.0 }; }
    if (scaled >= (count - 1)) { return { index0: count - 1, index1: count - 1, mix: 0.0 }; }
    index0 = Math.floor(scaled);
    mix = scaled - index0;
    return { index0: index0, index1: index0 + 1, mix: mix };
  }

  function sampleMeshVec3Track(track, t, fallback, timing) {
    if (!Array.isArray(track) || !track.length) { return vec3Or(fallback, [0, 0, 0]); }
    var sample = resolveMeshTrackSample(t, track.length, timing);
    var a = vec3Or(track[sample.index0], vec3Or(fallback, [0, 0, 0]));
    var b = vec3Or(track[sample.index1], vec3Or(fallback, [0, 0, 0]));
    return [
      a[0] + ((b[0] - a[0]) * sample.mix),
      a[1] + ((b[1] - a[1]) * sample.mix),
      a[2] + ((b[2] - a[2]) * sample.mix),
    ];
  }

  function meshMatrix4FromValue(value) {
    if (value && value.length === 16) {
      return value;
    }
    if (Array.isArray(value) && value.length === 4) {
      return [
        Number(value[0][0]), Number(value[1][0]), Number(value[2][0]), Number(value[3][0]),
        Number(value[0][1]), Number(value[1][1]), Number(value[2][1]), Number(value[3][1]),
        Number(value[0][2]), Number(value[1][2]), Number(value[2][2]), Number(value[3][2]),
        Number(value[0][3]), Number(value[1][3]), Number(value[2][3]), Number(value[3][3]),
      ];
    }
    return null;
  }

  function sampleMeshMatrixTrack(track, t, timing) {
    if (!Array.isArray(track) || !track.length) { return null; }
    var sample = resolveMeshTrackSample(t, track.length, timing);
    return meshMatrix4FromValue(track[sample.index0]);
  }

  function surfaceLocalBounds(meshLike) {
    if (meshLike) {
      var localKind = String(meshLike.kind || "").toLowerCase().trim();
      var localHasSurfaceSystem = !!meshLike.surface_system;
      if (localKind === "quad" || (localHasSurfaceSystem && meshLike.size != null)) {
        var quadFrame = derivePlanarSurfaceLocalFrame(meshLike);
        var quadPoints = planarPointsFromQuadSpec(meshLike, null);
        if (Array.isArray(quadPoints) && quadPoints.length >= 3) {
          var qMinX = Infinity, qMinY = Infinity, qMaxX = -Infinity, qMaxY = -Infinity;
          for (var qi = 0; qi < quadPoints.length; qi += 1) {
            var qPoint = quadPoints[qi];
            var qU = dotVec3(qPoint, quadFrame.uAxis);
            var qV = dotVec3(qPoint, quadFrame.vAxis);
            if (qU < qMinX) { qMinX = qU; }
            if (qU > qMaxX) { qMaxX = qU; }
            if (qV < qMinY) { qMinY = qV; }
            if (qV > qMaxY) { qMaxY = qV; }
          }
          return {
            minX: qMinX,
            minY: qMinY,
            spanX: Math.max(1e-4, qMaxX - qMinX),
            spanY: Math.max(1e-4, qMaxY - qMinY),
            uAxis: quadFrame.uAxis,
            vAxis: quadFrame.vAxis
          };
        }
      }
    }
    var frame = derivePlanarSurfaceLocalFrame(meshLike);
    var points = planarPointsFromMeshVertices(meshLike, null);
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < points.length; i += 1) {
      var point = points[i];
      var u = dotVec3(point, frame.uAxis);
      var v = dotVec3(point, frame.vAxis);
      if (u < minX) { minX = u; }
      if (u > maxX) { maxX = u; }
      if (v < minY) { minY = v; }
      if (v > maxY) { maxY = v; }
    }
    return {
      minX: minX,
      minY: minY,
      spanX: maxX - minX,
      spanY: maxY - minY,
      uAxis: frame.uAxis,
      vAxis: frame.vAxis
    };
  }

  function resolveAnimatedModelMatrix(meshLike, t, fallbackCenter, fallbackRotation, fallbackScale, MmLocal) {
    var tracks = meshLike && meshLike.tracks && typeof meshLike.tracks === "object" ? meshLike.tracks : null;
    var timing = meshTiming(meshLike);
    if (tracks && tracks.transform) {
      var trackedMatrix = sampleMeshMatrixTrack(tracks.transform, t, timing);
      if (trackedMatrix) { return trackedMatrix; }
    }
    if (shouldUseUploadedModelMatrix(meshLike)) {
      return meshLike._modelMatrix;
    }
    var center = fallbackCenter;
    var rotation = fallbackRotation;
    var scale = fallbackScale;
    if (tracks && tracks.center) {
      center = sampleMeshVec3Track(tracks.center, t, fallbackCenter, timing);
    }
    if (tracks && tracks.rotation) {
      rotation = sampleMeshVec3Track(tracks.rotation, t, fallbackRotation, timing);
    }
    if (tracks && tracks.scale) {
      scale = sampleMeshVec3Track(tracks.scale, t, fallbackScale, timing);
    }
    if (MmLocal && typeof MmLocal.mat4ModelTRS === "function") {
      return MmLocal.mat4ModelTRS(center, rotation, scale);
    }
    return meshLike && meshLike._modelMatrix ? meshLike._modelMatrix : (MmLocal && typeof MmLocal.mat4Identity === "function" ? MmLocal.mat4Identity() : null);
  }

  function isIdentityMat4(m) {
    if (!Array.isArray(m) || m.length !== 16) { return false; }
    for (var i = 0; i < 16; i += 1) {
      var expected = (i % 5 === 0) ? 1.0 : 0.0;
      if (Math.abs((Number(m[i]) || 0.0) - expected) > 1e-7) {
        return false;
      }
    }
    return true;
  }

  function vecHasNonDefault(value, fallback) {
    if (!Array.isArray(value)) { return false; }
    for (var i = 0; i < Math.min(value.length, fallback.length); i += 1) {
      if (Math.abs((Number(value[i]) || 0.0) - Number(fallback[i])) > 1e-7) {
        return true;
      }
    }
    return false;
  }

  function shouldUseUploadedModelMatrix(meshLike) {
    var matrix = meshLike && meshLike._modelMatrix;
    if (!Array.isArray(matrix) || matrix.length !== 16) { return false; }
    if (!isIdentityMat4(matrix)) { return true; }
    return !(
      vecHasNonDefault(meshLike.center, [0.0, 0.0, 0.0]) ||
      vecHasNonDefault(meshLike.rotation, [0.0, 0.0, 0.0]) ||
      vecHasNonDefault(meshLike.scale, [1.0, 1.0, 1.0])
    );
  }

  function resolveSceneMeshById(sceneMesh, meshId) {
    var wantedId = String(meshId || "").trim();
    if (!wantedId || !sceneMesh || !Array.isArray(sceneMesh.parts)) {
      return null;
    }
    for (var i = 0; i < sceneMesh.parts.length; i += 1) {
      var candidate = sceneMesh.parts[i];
      if (String(candidate && candidate.id || "").trim() === wantedId) {
        return candidate;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // VfGeomWgpu — one renderer per canvas
  // ---------------------------------------------------------------------------
  function VfGeomWgpu(canvas, getMeshFn) {
    this._canvas     = canvas;
    this._getMesh    = getMeshFn;
    this._device     = null;
    this._ctx        = null;
    this._format     = null;
    this._pipeTri    = null;
    this._pipeLine   = null;
    this._pipeTriAlpha = null;
    this._pipeTriMultiply = null;
    this._pipeTriAdditive = null;
    this._pipeSphereInst = null;
    this._pipeCylinderInst = null;
    this._pipePointImpostor = null;
    this._pipeLineImpostor = null;
    this._bindLayout = null;
    this._depthTex   = null;
    this._msaaTex    = null;
    this._frameColorTex = null;
    this._frameColorView = null;
    this._frameColorW = 0;
    this._frameColorH = 0;
    this._frameSceneColorTex = null;
    this._frameSceneColorView = null;
    this._frameSceneColorW = 0;
    this._frameSceneColorH = 0;
    this._frameBlitBindGroup = null;
    this._frameBlitSourceView = null;
    this._uniformBuf = null;
    this._bindGroup  = null;
    this._vb         = null;
    this._ib         = null;
    this._ibCount    = 0;
    this._topology   = "triangle-list";
    this._parts      = null;
    this._lastMesh   = null;
    this._lastMeshRevision = -1;
    this._depthW     = 0;
    this._depthH     = 0;
    this._msaaW      = 0;
    this._msaaH      = 0;
    this._running    = false;
    this._raf        = 0;
    this._resizeRaf  = 0;
    // Picking
    this._objectId      = 0;       // set by display.js before init
    this._pickTex       = null;    // rg32uint render target
    this._pickDepthTex  = null;
    this._pickUb        = null;    // picking uniform buffer (PICK_UB_SIZE bytes)
    this._pickBG        = null;    // picking bind group
    this._pickReadBuf   = null;    // mapAsync readback buffer for small pick neighborhood
    this._pickW         = 0;
    this._pickH         = 0;
    this._pickPending   = false;   // readback in flight
    this._pickCallback  = null;    // fn(object_id, simplex_id, x, y) called after readback
  }

  VfGeomWgpu.prototype = {
    _ensurePickTextures: function () {
      if (!this._device || !sharedWgpu) { return; }
      var c = this._canvas;
      var w = Math.max(1, c.width);
      var h = Math.max(1, c.height);
      if (this._pickTex && this._pickW === w && this._pickH === h) { return; }
      // Destroy old
      if (this._pickTex)      { try { this._pickTex.destroy(); }      catch(_){} }
      if (this._pickDepthTex) { try { this._pickDepthTex.destroy(); } catch(_){} }
      this._pickW = w; this._pickH = h;
      this._pickTex = this._device.createTexture({
        size: [w, h, 1],
        format: "rg32uint",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      this._pickDepthTex = this._device.createTexture({
        size: [w, h, 1], format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      // Read back a tiny exact rg32uint neighborhood from the GPU pick buffer.
      // This reduces false background samples on moving edges without inventing
      // a larger hover radius in JS.
      if (this._pickReadBuf) { try { this._pickReadBuf.destroy(); } catch(_){} }
      this._pickReadBuf = this._device.createBuffer({
        size: 256 * 3,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    },

    _buildPickUniform: function (mvp, model) {
      var buf = new ArrayBuffer(PICK_UB_SIZE);
      var f32 = new Float32Array(buf);
      var u32 = new Uint32Array(buf);
      for (var i = 0; i < 16; i++) { f32[i]      = mvp[i]; }
      for (var i = 0; i < 16; i++) { f32[16 + i] = model[i]; }
      u32[32] = this._objectId >>> 0;  // offset 128
      return new Uint8Array(buf);
    },

    /** Ask for the object_id + simplex_id at canvas pixel (cx, cy). */
    pickAt: function (cx, cy, cb) {
      if (!this._device) {
        failFast("pickAt called before GPU device initialization completed");
      }
      if (!this._pickTex || !this._pickDepthTex || !this._pickReadBuf) {
        failFast("pickAt called before GPU pick textures were initialized");
      }
      if (this._pickPending) {
        wlog("warn", "pickAt skipped while previous GPU pick is pending");
        if (typeof cb === "function") {
          try { cb(0, 0); } catch (_) {}
        }
        return;
      }
      var self = this;
      var px = Math.max(0, Math.min(this._pickW - 1, Math.floor(cx)));
      var py = Math.max(0, Math.min(this._pickH - 1, Math.floor(cy)));
      var sampleRadius = 1;
      var ox = Math.max(0, px - sampleRadius);
      var oy = Math.max(0, py - sampleRadius);
      var sampleW = Math.min(this._pickW - ox, (sampleRadius * 2) + 1);
      var sampleH = Math.min(this._pickH - oy, (sampleRadius * 2) + 1);
      var centerSX = px - ox;
      var centerSY = py - oy;
      this._pickPending = true;
      var safetyTimer = setTimeout(function () {
        if (self._pickPending) {
          wlog("warn", "GPU pick readback timed out; dropping pending pick");
          self._pickPending = false;
          self._pickCallback = null;
          self._pendingPickPx = null;
        }
      }, 2500);
      // Schedule readback on a freshly rendered GPU pick pass.
      this._pickCallback = function() {
        var buf = self._pickReadBuf;
        buf.mapAsync(GPUMapMode.READ).then(function() {
          clearTimeout(safetyTimer);
          var u32 = new Uint32Array(buf.getMappedRange(0, 256 * sampleH));
          var u32PerRow = 256 / 4;
          var bestOid = 0;
          var bestSid = 0;
          var bestCount = 0;
          var nearestOid = 0;
          var nearestSid = 0;
          var nearestDistanceSq = Number.POSITIVE_INFINITY;
          var counts = Object.create(null);
          var sampleCount = 0;
          for (var sy = 0; sy < sampleH; sy += 1) {
            var rowOffset = sy * u32PerRow;
            for (var sx = 0; sx < sampleW; sx += 1) {
              var pixelOffset = rowOffset + (sx * 2);
              var sampleOid = u32[pixelOffset] >>> 0;
              var sampleSid = u32[pixelOffset + 1] >>> 0;
              if (!(sampleOid > 0)) { continue; }
              sampleCount += 1;
              var key = String(sampleOid);
              var nextCount = (counts[key] || 0) + 1;
              counts[key] = nextCount;
              if (nextCount > bestCount) {
                bestCount = nextCount;
                bestOid = sampleOid;
                bestSid = sampleSid;
              }
              var dx = sx - centerSX;
              var dy = sy - centerSY;
              var distSq = (dx * dx) + (dy * dy);
              if (distSq < nearestDistanceSq) {
                nearestDistanceSq = distSq;
                nearestOid = sampleOid;
                nearestSid = sampleSid;
              }
            }
          }
          var oid = nearestOid || bestOid || 0;
          var sid = nearestOid ? nearestSid : (bestOid ? bestSid : 0);
          var pickMeta = {
            occupiedHint: sampleCount > 0,
            bestOid: bestOid,
            bestCount: bestCount,
            sampleCount: sampleCount,
            nearestOid: nearestOid,
            nearestDistanceSq: nearestOid ? nearestDistanceSq : -1
          };
          buf.unmap();
          self._pickPending = false;
          if (cb) {
            cb(oid, sid, cx, cy, Object.assign({}, pickMeta, {
              _sample_count: sampleCount,
              _best_oid: bestOid,
              _nearest_oid: nearestOid
            }));
          }
        }).catch(function(e) {
          clearTimeout(safetyTimer);
          wlog("warn", "GPU pick readback failed: " + (e && e.message ? e.message : e));
          self._pickPending = false;
          self._pickCallback = null;
          self._pendingPickPx = null;
        });
        self._pickCallback = null;
      };
      this._pendingPickPx = [ox, oy, sampleW, sampleH];
      var now = global.performance && typeof global.performance.now === "function"
        ? global.performance.now()
        : Date.now();
      this._renderContent(now);
    },

    _ensureDepth: function () {
      var c = this._canvas;
      var w = Math.max(1, c.width);
      var h = Math.max(1, c.height);
      if (this._depthTex && this._depthW === w && this._depthH === h) { return; }
      this._depthW = w; this._depthH = h;
      if (this._depthTex) { this._depthTex.destroy(); }
      this._depthTex = this._device.createTexture({
        size: { width: w, height: h, depthOrArrayLayers: 1 },
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        sampleCount: SAMPLE_COUNT,
      });
    },

    _ensureMsaaColor: function () {
      var c = this._canvas;
      var w = Math.max(1, c.width);
      var h = Math.max(1, c.height);
      if (this._msaaTex && this._msaaW === w && this._msaaH === h) { return; }
      this._msaaW = w; this._msaaH = h;
      if (this._msaaTex) { this._msaaTex.destroy(); }
      this._msaaTex = this._device.createTexture({
        size: { width: w, height: h, depthOrArrayLayers: 1 },
        format: this._format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        sampleCount: SAMPLE_COUNT,
      });
    },

    _destroyParts: function () {
      if (!this._parts || !this._parts.length) { this._parts = null; return; }
      for (var i = 0; i < this._parts.length; i++) {
        var p = this._parts[i];
        this._destroyPart(p);
      }
      this._parts = null;
    },

    _destroyPart: function (part) {
      if (!part) { return; }
      if (part.vb) { try { part.vb.destroy(); } catch(_){} }
      if (part.ib) { try { part.ib.destroy(); } catch(_){} }
      if (part.instanceBuf) { try { part.instanceBuf.destroy(); } catch(_){} }
      if (part.uniformBuf) { try { part.uniformBuf.destroy(); } catch(_){} }
      if (part.shadowUniformBuf) { try { part.shadowUniformBuf.destroy(); } catch(_){} }
      if (part.pickUb) { try { part.pickUb.destroy(); } catch(_){} }
      if (part.surfaceColorTex) { try { part.surfaceColorTex.destroy(); } catch(_){} }
      if (part.surfaceDepthTex) { try { part.surfaceDepthTex.destroy(); } catch(_){} }
      if (part.surfaceMsaaTex) { try { part.surfaceMsaaTex.destroy(); } catch(_){} }
    },

    _ensureFrameColorTarget: function () {
      var c = this._canvas;
      var w = Math.max(1, c.width);
      var h = Math.max(1, c.height);
      if (this._frameColorTex && this._frameColorW === w && this._frameColorH === h) { return; }
      this._frameColorW = w; this._frameColorH = h;
      if (this._frameColorTex) { try { this._frameColorTex.destroy(); } catch(_){} }
      this._frameColorTex = this._device.createTexture({
        size: { width: w, height: h, depthOrArrayLayers: 1 },
        format: this._format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
      });
      this._frameColorView = this._frameColorTex.createView();
      this._frameBlitBindGroup = null;
      this._frameBlitSourceView = null;
    },

    _ensureFrameSceneColorTarget: function () {
      var c = this._canvas;
      var w = Math.max(1, c.width);
      var h = Math.max(1, c.height);
      if (this._frameSceneColorTex && this._frameSceneColorW === w && this._frameSceneColorH === h) { return; }
      this._frameSceneColorW = w; this._frameSceneColorH = h;
      if (this._frameSceneColorTex) { try { this._frameSceneColorTex.destroy(); } catch(_){} }
      this._frameSceneColorTex = this._device.createTexture({
        size: { width: w, height: h, depthOrArrayLayers: 1 },
        format: this._format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
      });
      this._frameSceneColorView = this._frameSceneColorTex.createView();
    },

    _ensureFrameBlitBindGroup: function () {
      if (!this._device || !sharedWgpu || !this._frameColorView) { return null; }
      if (this._frameBlitBindGroup && this._frameBlitSourceView === this._frameColorView) {
        return this._frameBlitBindGroup;
      }
      this._frameBlitBindGroup = this._device.createBindGroup({
        layout: sharedWgpu.frameBlitBindLayout,
        entries: [
          { binding: 0, resource: sharedWgpu.surfaceSampler },
          { binding: 1, resource: this._frameColorView }
        ]
      });
      this._frameBlitSourceView = this._frameColorView;
      return this._frameBlitBindGroup;
    },

    _displayViewForCurrentFrame: function (mesh) {
      var currentFrameId = String(this._frameId || "").trim();
      if (!currentFrameId || !mesh || !Array.isArray(mesh.parts)) {
        return this._frameColorView;
      }
      for (var i = 0; i < mesh.parts.length; i += 1) {
        var partMesh = mesh.parts[i];
        var surfaceSystem = partMesh && partMesh.surface_system && typeof partMesh.surface_system === "object"
          ? partMesh.surface_system
          : null;
        if (!surfaceSystem) { continue; }
        if (String(surfaceSystem.kind || "").toLowerCase().trim() !== "screen") { continue; }
        if (String(surfaceSystem.frame_ref || "").trim() === currentFrameId) {
          return this._frameSceneColorView || this._frameColorView;
        }
      }
      return this._frameColorView;
    },

    _blitFrameTargetToCanvas: function (enc, mesh) {
      var sourceView = this._displayViewForCurrentFrame(mesh);
      if (!enc || !sharedWgpu || !sharedWgpu.pipeFrameBlit || !sourceView) { return; }
      if (sourceView !== this._frameColorView) {
        this._frameBlitBindGroup = this._device.createBindGroup({
          layout: sharedWgpu.frameBlitBindLayout,
          entries: [
            { binding: 0, resource: sharedWgpu.surfaceSampler },
            { binding: 1, resource: sourceView }
          ]
        });
        this._frameBlitSourceView = sourceView;
      }
      var blitBg = sourceView === this._frameColorView ? this._ensureFrameBlitBindGroup() : this._frameBlitBindGroup;
      if (!blitBg) { return; }
      var pass = enc.beginRenderPass({
        colorAttachments: [{
          view: this._ctx.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      pass.setPipeline(sharedWgpu.pipeFrameBlit);
      pass.setBindGroup(0, blitBg);
      pass.draw(4, 1, 0, 0);
      pass.end();
    },

    _ensurePartBindGroup: function (part) {
      if (!part || !this._device || !this._bindLayout || !sharedWgpu) { return; }
      var surfaceView = part.surfaceExternalView || part.surfaceColorView || sharedWgpu.defaultSurfaceView;
      var shadowView0 = this._shadowDepthView0 || sharedWgpu.defaultShadowView;
      var shadowView1 = this._shadowDepthView1 || sharedWgpu.defaultShadowView;
      if (part.bindGroup &&
          part._boundSurfaceView === surfaceView &&
          part._boundShadowView0 === shadowView0 &&
          part._boundShadowView1 === shadowView1) { return; }
      part.bindGroup = this._device.createBindGroup({
        layout: this._bindLayout,
        entries: [
          { binding: 0, resource: { buffer: part.uniformBuf } },
          { binding: 1, resource: sharedWgpu.surfaceSampler },
          { binding: 2, resource: surfaceView },
          { binding: 3, resource: sharedWgpu.shadowSampler },
          { binding: 4, resource: shadowView0 },
          { binding: 5, resource: shadowView1 }
        ]
      });
      part._boundSurfaceView = surfaceView;
      part._boundShadowView0 = shadowView0;
      part._boundShadowView1 = shadowView1;
    },

    _ensurePartShadowBindGroup: function (part) {
      if (!part || !this._device || !sharedWgpu || !sharedWgpu.shadowBindLayout) { return; }
      if (part.shadowBindGroup) { return; }
      part.shadowBindGroup = this._device.createBindGroup({
        layout: sharedWgpu.shadowBindLayout,
        entries: [
          { binding: 0, resource: { buffer: part.shadowUniformBuf || part.uniformBuf } }
        ]
      });
    },

    _ensureSurfaceTarget: function (part, width, height) {
      if (!part || !this._device) { return; }
      var w = Math.max(64, width | 0);
      var h = Math.max(64, height | 0);
      if (part.surfaceColorTex && part.surfaceW === w && part.surfaceH === h) {
        return;
      }
      if (part.surfaceColorTex) { try { part.surfaceColorTex.destroy(); } catch(_){} }
      if (part.surfaceDepthTex) { try { part.surfaceDepthTex.destroy(); } catch(_){} }
      if (part.surfaceMsaaTex) { try { part.surfaceMsaaTex.destroy(); } catch(_){} }
      part.surfaceW = w;
      part.surfaceH = h;
      part.surfaceColorTex = this._device.createTexture({
        size: { width: w, height: h, depthOrArrayLayers: 1 },
        format: this._format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      part.surfaceMsaaTex = this._device.createTexture({
        size: { width: w, height: h, depthOrArrayLayers: 1 },
        format: this._format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        sampleCount: SAMPLE_COUNT,
      });
      part.surfaceDepthTex = this._device.createTexture({
        size: { width: w, height: h, depthOrArrayLayers: 1 },
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        sampleCount: SAMPLE_COUNT,
      });
      part.surfaceColorView = part.surfaceColorTex.createView();
      this._ensurePartBindGroup(part);
    },

    _surfaceAspectForPart: function (part) {
      var mesh = part && part.mesh;
      var verts = mesh && mesh.vertices;
      if (!verts || verts.length < 20) { return 1.0; }
      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (var i = 0; i + 9 < verts.length; i += 10) {
        var x = Number(verts[i] || 0);
        var y = Number(verts[i + 1] || 0);
        if (x < minX) { minX = x; }
        if (x > maxX) { maxX = x; }
        if (y < minY) { minY = y; }
        if (y > maxY) { maxY = y; }
      }
      var spanX = Math.max(1e-4, maxX - minX);
      var spanY = Math.max(1e-4, maxY - minY);
      return spanX / spanY;
    },

    _surfaceTargetDimsForPart: function (part, frameWidth, frameHeight) {
      var aspect = this._surfaceAspectForPart(part);
      var base = Math.max(256, Math.min(1024, Math.max(frameWidth | 0, frameHeight | 0, 256)));
      var w = base;
      var h = base;
      if (aspect >= 1.0) {
        h = Math.max(64, Math.round(base / aspect));
      } else {
        w = Math.max(64, Math.round(base * aspect));
      }
      return { width: w, height: h };
    },

    _sceneBackgroundClear: function (sceneMesh) {
      var bg = sceneMesh && Array.isArray(sceneMesh.background) ? sceneMesh.background : null;
      return {
        r: bg ? (Number(bg[0]) || 0.0) : 0.0,
        g: bg ? (Number(bg[1]) || 0.0) : 0.0,
        b: bg ? (Number(bg[2]) || 0.0) : 0.0,
        a: bg ? Math.max(0.0, Math.min(1.0, Number(bg[3]) || 0.0)) : 0.0
      };
    },

    _buildPlanarSurfaceRenderCamera: function (part, sceneMesh, surfaceCamera, t, targetAspect) {
      var renderGeometry = resolvePlanarMirrorGeometry(part && part.mesh, t, "surface render camera");
      debugMirrorPlane("surface-render-camera", part && part.mesh, renderGeometry.frame, "");
      return createPlanarMirrorAdapter().buildRenderCamera({
        part: part,
        surfaceCamera: surfaceCamera,
        timeMs: t,
        targetAspect: targetAspect,
        math: getMath()
      });
    },

    _ensureShadowTarget: function (slot, width, height) {
      if (!this._device) { return; }
      var w = Math.max(256, width | 0);
      var h = Math.max(256, height | 0);
      var texKey = slot === 1 ? "_shadowDepthTex1" : "_shadowDepthTex0";
      var viewKey = slot === 1 ? "_shadowDepthView1" : "_shadowDepthView0";
      var wKey = slot === 1 ? "_shadowDepthW1" : "_shadowDepthW0";
      var hKey = slot === 1 ? "_shadowDepthH1" : "_shadowDepthH0";
      if (this[texKey] && this[wKey] === w && this[hKey] === h) { return; }
      if (this[texKey]) { try { this[texKey].destroy(); } catch (_) {} }
      this[wKey] = w;
      this[hKey] = h;
      this[texKey] = this._device.createTexture({
        size: { width: w, height: h, depthOrArrayLayers: 1 },
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      });
      this[viewKey] = this[texKey].createView();
    },

    _ensureSharedShadowTarget: function (slot, width, height) {
      if (!this._device || !sharedWgpu) { return null; }
      if (!sharedWgpu._sharedShadowTargets) {
        sharedWgpu._sharedShadowTargets = {
          tex0: null, view0: null, w0: 0, h0: 0,
          tex1: null, view1: null, w1: 0, h1: 0
        };
      }
      var targets = sharedWgpu._sharedShadowTargets;
      var w = Math.max(256, width | 0);
      var h = Math.max(256, height | 0);
      var texKey = slot === 1 ? "tex1" : "tex0";
      var viewKey = slot === 1 ? "view1" : "view0";
      var wKey = slot === 1 ? "w1" : "w0";
      var hKey = slot === 1 ? "h1" : "h0";
      if (!targets[texKey] || targets[wKey] !== w || targets[hKey] !== h) {
        if (targets[texKey]) { try { targets[texKey].destroy(); } catch (_) {} }
        targets[wKey] = w;
        targets[hKey] = h;
        targets[texKey] = this._device.createTexture({
          size: { width: w, height: h, depthOrArrayLayers: 1 },
          format: "depth32float",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        targets[viewKey] = targets[texKey].createView();
      }
      return {
        texture: targets[texKey],
        view: targets[viewKey],
        width: targets[wKey],
        height: targets[hKey]
      };
    },

    _applyShadowStateToPart: function (part, shadowData0, shadowData1, contactOccluder0, contactOccluder1) {
      if (!part || typeof part !== "object") { return; }
      part.shadow_viewproj0 = shadowData0 ? Array.prototype.slice.call(shadowData0.viewProjection) : null;
      part.shadow_viewproj1 = shadowData1 ? Array.prototype.slice.call(shadowData1.viewProjection) : null;
      part.shadow_enabled0 = !!shadowData0;
      part.shadow_enabled1 = !!shadowData1;
      part.shadow_bias0 = shadowData0 ? Number(shadowData0.bias || 0.001) : 0.0;
      part.shadow_bias1 = shadowData1 ? Number(shadowData1.bias || 0.001) : 0.0;
      part.shadow_contact0 = contactOccluder0 || null;
      part.shadow_contact1 = contactOccluder1 || null;
    },

    _prepareShadowMapsForScene: function (enc, mesh, t, frameWidth, frameHeight) {
      if (!mesh || !Array.isArray(this._parts) || !this._parts.length || !sharedWgpu) { return [null, null]; }
      var MmLocal = getMath();
      var sceneLights = resolveSceneLights(
        lightsForRenderer(mesh.lights || [], this._offscreenFrame === true),
        sceneMeshForLightResolution(mesh, this._parts),
        t
      );
      maybeLogResolvedLights(this, "shadow_prepare", sceneLights);
      var activeLights = [];
      for (var li = 0; li < sceneLights.length && activeLights.length < 2; li += 1) {
        if (sceneLights[li] && sceneLights[li].casts_shadow !== false) {
          activeLights.push(sceneLights[li]);
        }
      }
      var casterParts = shadowCasterParts(this._parts, this._offscreenFrame !== true);
      var contactParts = planarContactParts(this._parts);
      if (!casterParts.length || !activeLights.length) {
        this._shadowDepthView0 = null;
        this._shadowDepthView1 = null;
        for (var noShadowPi = 0; noShadowPi < this._parts.length; noShadowPi += 1) {
          this._applyShadowStateToPart(this._parts[noShadowPi], null, null, null, null);
        }
        this._lastShadowCacheHit = 0.0;
        return [null, null];
      }
      var shadowSize = Math.max(512, Math.min(2048, Math.max(frameWidth | 0, frameHeight | 0, 1024)));
      var lightSig = activeLights.map(function (light) {
        return [
          String(light && light.id || ""),
          String(light && light.kind || ""),
          Number(light && light.pos && light.pos[0] || 0).toFixed(4),
          Number(light && light.pos && light.pos[1] || 0).toFixed(4),
          Number(light && light.pos && light.pos[2] || 0).toFixed(4),
          Number(light && light.target && light.target[0] || 0).toFixed(4),
          Number(light && light.target && light.target[1] || 0).toFixed(4),
          Number(light && light.target && light.target[2] || 0).toFixed(4)
        ].join(",");
      }).join("|");
      var lightCaches = this._shadowLightCaches || (this._shadowLightCaches = { slot0: null, slot1: null });
      var cacheHits = 0;
      var prepareLightShadow = function (renderer, slot, light) {
        if (!light) {
          return { shadow: null, contact: null, view: null, casterParts: [], cacheHit: false, cacheKey: "", cacheSlot: slot === 1 ? "slot1" : "slot0" };
        }
        var lightCasterParts = shadowCasterPartsForLight(casterParts, light, t);
        if (!lightCasterParts.length) {
          return { shadow: null, contact: null, view: null, casterParts: [], cacheHit: false, cacheKey: "", cacheSlot: slot === 1 ? "slot1" : "slot0" };
        }
        var slotName = slot === 1 ? "slot1" : "slot0";
        var lightCasterSig = buildShadowCasterSignature(lightCasterParts, t, MmLocal);
        var cacheKey = lightCasterSig + "||" + lightSig + "||slot=" + String(slot) + "||" + String(shadowSize);
        var cacheEntry = lightCaches[slotName] || null;
        if (cacheEntry && cacheEntry.key === cacheKey) {
          cacheHits += 1;
          return {
            shadow: cacheEntry.shadow || null,
            contact: cacheEntry.contact || null,
            view: cacheEntry.view || null,
            casterParts: lightCasterParts,
            cacheHit: true,
            cacheKey: cacheKey,
            cacheSlot: slotName
          };
        }
        var worldPoints = collectShadowWorldPoints(lightCasterParts, t, MmLocal);
        var shadow = fitShadowViewProjection(light, worldPoints, MmLocal);
        var contact = resolvePlanarContactOccluderForLight(contactParts, light, t);
        if (shadow) {
          renderer._ensureShadowTarget(slot, shadowSize, shadowSize);
        }
        return {
          shadow: shadow,
          contact: contact,
          view: slot === 1 ? renderer._shadowDepthView1 : renderer._shadowDepthView0,
          casterParts: lightCasterParts,
          cacheHit: false,
          cacheKey: cacheKey,
          cacheSlot: slotName
        };
      };
      var shadowState0 = prepareLightShadow(this, 0, activeLights[0] || null);
      var shadowState1 = prepareLightShadow(this, 1, activeLights[1] || null);
      this._lastShadowCacheHit = activeLights.length ? (cacheHits / activeLights.length) : 0.0;
      this._shadowDepthView0 = shadowState0.view || null;
      this._shadowDepthView1 = shadowState1.view || null;
      for (var pi = 0; pi < this._parts.length; pi += 1) {
        this._applyShadowStateToPart(
          this._parts[pi],
          shadowState0.shadow,
          shadowState1.shadow,
          shadowState0.contact,
          shadowState1.contact
        );
      }
      var drawShadowPass = function (renderer, slot, shadowData, partsForShadow) {
        if (!shadowData) { return; }
        var depthView = slot === 1 ? renderer._shadowDepthView1 : renderer._shadowDepthView0;
        var pipe = slot === 1 ? sharedWgpu.pipeShadow1 : sharedWgpu.pipeShadow0;
        if (!depthView || !pipe) { return; }
        var pass = enc.beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view: depthView,
            depthClearValue: 1.0,
            depthLoadOp: "clear",
            depthStoreOp: "store"
          }
        });
        pass.setPipeline(pipe);
        var shadowLight = slot === 1 ? activeLights[1] : activeLights[0];
        var apertureCasterId = shadowLight && shadowLight.projected_aperture && shadowLight.projected_aperture.mesh_id
          ? String(shadowLight.projected_aperture.mesh_id)
          : "";
        for (var i = 0; i < partsForShadow.length; i += 1) {
          var part = partsForShadow[i];
          var partMesh = part && part.mesh;
          if (apertureCasterId && String(partMesh.id || "") === apertureCasterId) { continue; }
          var model = resolveAnimatedModelMatrix(
            partMesh,
            t,
            partMesh.center || [0, 0, 0],
            partMesh.rotation || [0, 0, 0],
            partMesh.scale || [1, 1, 1],
            MmLocal
          ) || (partMesh._modelMatrix || MmLocal.mat4Identity());
          var shadowUb = slot === 1
            ? buildShadowUniform(model, null, shadowData && shadowData.viewProjection)
            : buildShadowUniform(model, shadowData && shadowData.viewProjection, null);
          renderer._device.queue.writeBuffer(part.shadowUniformBuf, 0, shadowUb);
          renderer._ensurePartShadowBindGroup(part);
          pass.setBindGroup(0, part.shadowBindGroup);
          pass.setVertexBuffer(0, part.vb);
          pass.setIndexBuffer(part.ib, "uint32");
          pass.drawIndexed(part.ibCount, 1, 0, 0, 0);
        }
        pass.end();
      };
      if (shadowState0.shadow && !shadowState0.cacheHit) {
        drawShadowPass(this, 0, shadowState0.shadow, shadowState0.casterParts || []);
        lightCaches[shadowState0.cacheSlot] = {
          key: shadowState0.cacheKey,
          shadow: shadowState0.shadow,
          contact: shadowState0.contact,
          view: this._shadowDepthView0 || null
        };
      }
      if (shadowState1.shadow && !shadowState1.cacheHit) {
        drawShadowPass(this, 1, shadowState1.shadow, shadowState1.casterParts || []);
        lightCaches[shadowState1.cacheSlot] = {
          key: shadowState1.cacheKey,
          shadow: shadowState1.shadow,
          contact: shadowState1.contact,
          view: this._shadowDepthView1 || null
        };
      }
      return [shadowState0.shadow, shadowState1.shadow];
    },

    _buildPlanarSurfaceApertureCamera: function (part, sceneMesh, surfaceCamera, t, targetAspect) {
      var apertureGeometry = resolvePlanarMirrorGeometry(part && part.mesh, t, "surface aperture camera");
      debugMirrorPlane("surface-aperture-camera", part && part.mesh, apertureGeometry.frame, "");
      return createPlanarMirrorAdapter().buildApertureCamera({
        part: part,
        surfaceCamera: surfaceCamera,
        timeMs: t,
        targetAspect: targetAspect,
        math: getMath()
      });
    },

    _buildMirrorEyeLockedCamera: function (viewerCamera, hostMesh, baseCamera, t) {
      var geometry = resolvePlanarMirrorGeometry(hostMesh, Number(t || 0.0) || 0.0, "mirror eye-locked camera");
      return {
        pos: vec3Or(viewerCamera && viewerCamera.pos, [4.0, -5.0, 3.5]),
        target: geometry.center,
        up: [0.0, 0.0, 1.0],
        fov: Number(viewerCamera && viewerCamera.fov || 34.0) || 34.0,
        flip_x: (baseCamera && baseCamera.flip_x === true) || (viewerCamera && viewerCamera.flip_x === true)
      };
    },

    _resolveScreenRenderCamera: function (part, sceneMesh, surfaceCamera, t, targetAspect) {
      if (!surfaceCamera || typeof surfaceCamera !== "object") {
        return sceneMesh.camera || null;
      }
      var mirrorMeshId = String(surfaceCamera.reflect_mirror_mesh_id || "").trim();
      if (!mirrorMeshId) {
        return surfaceCamera;
      }
      var sourceFrameId = String(surfaceCamera.reflect_of_frame_id || "").trim();
      var sourceCamera = null;
      if (!sourceFrameId || sourceFrameId === "current") {
        sourceCamera = sceneMesh && sceneMesh.camera ? sceneMesh.camera : null;
      } else if (global.__vfNativeSceneLiveCameras && typeof global.__vfNativeSceneLiveCameras === "object") {
        sourceCamera = global.__vfNativeSceneLiveCameras[sourceFrameId] || null;
      }
      if (!sourceCamera || !Array.isArray(sourceCamera.pos) || !Array.isArray(sourceCamera.target)) {
        return null;
      }
      var cameraSeed = sourceCamera;
      if (surfaceCamera.reflect_eye_only === true || surfaceCamera.lock_aperture_camera === true) {
        cameraSeed = this._buildMirrorEyeLockedCamera(sourceCamera, part.mesh, surfaceCamera, t);
      }
      var reflectedCamera = this._buildPlanarSurfaceRenderCamera(part, sceneMesh, cameraSeed, t, targetAspect);
      if (surfaceCamera.lock_aperture_camera === true) {
        reflectedCamera = this._buildPlanarSurfaceApertureCamera(part, sceneMesh, reflectedCamera, t, targetAspect);
      }
      if (reflectedCamera && typeof reflectedCamera === "object" && surfaceCamera.flip_x === true) {
        reflectedCamera.flip_x = true;
      }
      return reflectedCamera;
    },

    _drawSingleScenePart: function (pass, sceneMesh, part, t, aspect, overrideCamera, MmBatch, renderWidth, renderHeight) {
      var partMesh = part && part.mesh;
      if (!partMesh || !part.vb || !part.ib) { return; }
      var camPart = overrideCamera || partMesh.camera || sceneMesh.camera || {};
      var posPart = camPart.pos || [0, 0, 5];
      var targetPart = camPart.target || [0, 0, 0];
      var fovPart = camPart.fov !== undefined ? camPart.fov : 45;
      var upPart = camPart.up || [0, 1, 0];
      var projMatPart, viewMatPart, mvpPart, modelMatPart;
      modelMatPart = resolveAnimatedModelMatrix(
        partMesh,
        t,
        partMesh.center || [0, 0, 0],
        partMesh.rotation || [0, 0, 0],
        partMesh.scale || [1, 1, 1],
        MmBatch
      ) || (partMesh._modelMatrix || MmBatch.mat4Identity());
      if (partMesh.mode3d === false) {
        projMatPart = MmBatch.mat4OrthoZ01(-1, 1, -1, 1, 0, 1);
        mvpPart = projMatPart;
      } else {
        if (camPart && Array.isArray(camPart.projection_matrix) && camPart.projection_matrix.length === 16) {
          projMatPart = new Float32Array(camPart.projection_matrix);
        } else {
          var fovRadPart = fovPart * Math.PI / 180;
          projMatPart = MmBatch.mat4PerspectiveZ01(fovRadPart, aspect, 0.05, 500);
        }
        if (camPart && camPart.flip_x === true) {
          projMatPart[0] = -projMatPart[0];
          projMatPart[4] = -projMatPart[4];
          projMatPart[8] = -projMatPart[8];
          projMatPart[12] = -projMatPart[12];
        }
        if (camPart && Array.isArray(camPart.view_matrix) && camPart.view_matrix.length === 16) {
          viewMatPart = new Float32Array(camPart.view_matrix);
        } else if (!overrideCamera && !partMesh.camera && !sceneMesh.camera) {
          var angPart = t * 0.0008;
          var trPart = MmBatch.mat4Translation(0, 0, -5);
          var rotPart = MmBatch.mat4RotationY(angPart);
          viewMatPart = MmBatch.mat4Mul(trPart, rotPart);
          posPart = [0, 0, 5];
        } else {
          viewMatPart = mat4LookAt(posPart, targetPart, upPart);
        }
        mvpPart = MmBatch.mat4Mul(projMatPart, viewMatPart);
      }
      var rawLightsPart = partMesh.no_lighting === true
        ? []
        : lightsForMesh((partMesh.lights || sceneMesh.lights || []), this._offscreenFrame === true, partMesh);
      var lightsNormPart = resolveSceneLights(rawLightsPart, sceneMeshForLightResolution(sceneMesh, this._parts), t);
      var lmNamePart = partMesh.light_model || sceneMesh.light_model || (lightsNormPart[0] && lightsNormPart[0].model) || "blinn_phong";
      var lmIntPart = LIGHT_MODELS[lmNamePart] !== undefined ? LIGHT_MODELS[lmNamePart] : 2;
      var meshForUniform = partMesh;
      if (part && (
        part.shadow_viewproj0 || part.shadow_viewproj1 ||
        part.shadow_enabled0 !== undefined || part.shadow_enabled1 !== undefined ||
        part.shadow_contact0 || part.shadow_contact1
      )) {
        meshForUniform = Object.assign({}, partMesh, {
          shadow_viewproj0: part.shadow_viewproj0 || null,
          shadow_viewproj1: part.shadow_viewproj1 || null,
          shadow_enabled0: !!part.shadow_enabled0,
          shadow_enabled1: !!part.shadow_enabled1,
          shadow_bias0: Number(part.shadow_bias0 || 0.0) || 0.0,
          shadow_bias1: Number(part.shadow_bias1 || 0.0) || 0.0,
          shadow_contact0: part.shadow_contact0 || null,
          shadow_contact1: part.shadow_contact1 || null
        });
      }
      var ubPart = buildUniform(mvpPart, modelMatPart, posPart, lightsNormPart, lmIntPart, resolveAlphaMul(partMesh), meshForUniform);
      this._device.queue.writeBuffer(part.uniformBuf, 0, ubPart);
      this._ensurePartBindGroup(part);
      var partBlendMode = String(partMesh.blend_mode || "");
      var isMultiplyPart = part.topology === "triangle-list" && partBlendMode === "multiply";
      var isAdditivePart = part.topology === "triangle-list" && partBlendMode === "additive";
      var isTransparentPart = !!partMesh.transparent && part.topology === "triangle-list" && !isMultiplyPart && !isAdditivePart;
      var useTransparentDepthPart = isTransparentPart && !!partMesh.depth_write;
      var pipePart = part.instanceKind === "sphere-list"
        ? this._pipeSphereInst
        : (
            part.instanceKind === "cylinder-list"
              ? this._pipeCylinderInst
              : (
                  part.instanceKind === "point-impostor"
                    ? this._pipePointImpostor
                    : (
                        part.instanceKind === "line-impostor"
                          ? this._pipeLineImpostor
                          : (
                  isAdditivePart && this._pipeTriAdditive ? this._pipeTriAdditive :
                  isMultiplyPart && this._pipeTriMultiply ? this._pipeTriMultiply :
                  part.topology === "line-list"
                    ? this._pipeLine
                    : (
                        useTransparentDepthPart && this._pipeTriAlphaDepth ? this._pipeTriAlphaDepth :
                        (isTransparentPart && this._pipeTriAlpha ? this._pipeTriAlpha : this._pipeTri)
                      )
                          )
                      )
                )
          );
      pass.setPipeline(pipePart);
      pass.setBindGroup(0, part.bindGroup);
      pass.setVertexBuffer(0, part.vb);
      if (part.instanceBuf && part.instanceCount > 0) {
        pass.setVertexBuffer(1, part.instanceBuf);
      }
      pass.setIndexBuffer(part.ib, "uint32");
      pass.drawIndexed(part.ibCount, Math.max(1, Number(part.instanceCount || 0)), 0, 0, 0);
    },

    _encodeScenePartsColorPass: function (enc, sceneMesh, t, width, height, colorView, resolveTarget, depthView, clearColor, overrideCamera, omitObjectId, skipSurfaceParts, options) {
      if (!this._parts || !this._parts.length) { return; }
      options = options && typeof options === "object" ? options : {};
      var skipOverlayExpanded = options.skipOverlayExpanded === true;
      var MmBatch = getMath();
      var aspect = width / Math.max(1, height);
      var pass = enc.beginRenderPass({
        colorAttachments: [{
          view: colorView,
          resolveTarget: resolveTarget || undefined,
          clearValue: clearColor || { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        }],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      function isLateTransparent(part) {
        var mesh = part && part.mesh;
        if (!mesh) { return false; }
        if (part.instanceKind === "point-impostor" || part.instanceKind === "line-impostor") {
          return true;
        }
        return !!mesh.transparent;
      }
      for (var stage = 0; stage < 2; stage += 1) {
        var lateStage = stage === 1;
        for (var partIndex = 0; partIndex < this._parts.length; partIndex++) {
          var part = this._parts[partIndex];
          var partMesh = part && part.mesh;
          if (!partMesh) { continue; }
          if (omitObjectId && Number(part.objectId || 0) === Number(omitObjectId || 0)) { continue; }
          if (skipSurfaceParts && partMesh.surface_system) { continue; }
          if (skipOverlayExpanded && partMesh.overlay_expanded === true) { continue; }
          if (
            partMesh.surface_system &&
            String(partMesh.surface_system.kind || "").toLowerCase().trim() === "screen" &&
            String(partMesh.surface_system.frame_ref || "").trim() &&
            partMesh._surfaceTextureReady !== true
          ) {
            continue;
          }
          if (isLateTransparent(part) !== lateStage) { continue; }
          this._drawSingleScenePart(pass, sceneMesh, part, t, aspect, overrideCamera || null, MmBatch, width, height);
        }
      }
      pass.end();
    },

    _rebuildUnifiedSourceMeshesForCamera: function (sceneMesh, camera, viewportHeightPx) {
      var displayApi = global.VfDisplay && global.VfDisplay.__test;
      var buildSingleMesh = displayApi && typeof displayApi.buildSingleMesh === "function"
        ? displayApi.buildSingleMesh
        : null;
      var sourceSpecs = sceneMesh && Array.isArray(sceneMesh.source_specs) ? sceneMesh.source_specs : null;
      if (!buildSingleMesh || !sourceSpecs || !this._parts || sourceSpecs.length !== this._parts.length) {
        return null;
      }
      var lights = Array.isArray(sceneMesh && sceneMesh.lights) ? sceneMesh.lights : [];
      var rebuilt = new Array(sourceSpecs.length);
      for (var i = 0; i < sourceSpecs.length; i += 1) {
        var sourceSpec = sourceSpecs[i];
        var sourceType = String(sourceSpec && sourceSpec.type || "");
        var sourceTopology = String(sourceSpec && sourceSpec.topology || "");
        var sourceRenderMode = String(sourceSpec && sourceSpec.render_mode || "");
        var buildCameraBase = (
          sourceType === "field_mesh" &&
          sourceRenderMode.toLowerCase() === "marker_impostor" &&
          (sourceTopology === "point-list" || sourceTopology === "line-list") &&
          camera && camera._marker_size_camera && typeof camera._marker_size_camera === "object"
        ) ? camera._marker_size_camera : camera;
        var cameraForBuild = buildCameraBase && typeof buildCameraBase === "object"
          ? Object.assign({}, buildCameraBase, {
              viewport_height_px: Math.max(
                1,
                Number(
                  buildCameraBase.viewport_height_px ||
                  buildCameraBase.viewport_marker_reference_height_px ||
                  viewportHeightPx ||
                  (camera && camera.viewport_height_px) ||
                  0
                ) || 1
              )
            })
          : null;
        var mesh = buildSingleMesh(sourceSpec, cameraForBuild, lights);
        if (!mesh) { return null; }
        mesh.object_id = Number(sourceSpec && sourceSpec.object_id) || (i + 1);
        rebuilt[i] = mesh;
      }
      return rebuilt;
    },

    _swapScenePartsMeshes: function (meshes) {
      if (!Array.isArray(meshes) || !this._parts || meshes.length !== this._parts.length) {
        return null;
      }
      var backups = new Array(this._parts.length);
      for (var i = 0; i < this._parts.length; i += 1) {
        var part = this._parts[i];
        var nextMesh = meshes[i];
        if (!part || !part.vb || !part.ib || !nextMesh) { return null; }
        if (!nextMesh.vertices || !nextMesh.indices) { return null; }
        if (part.mesh && part.mesh.vertices && nextMesh.vertices.byteLength !== part.mesh.vertices.byteLength) { return null; }
        if (part.mesh && part.mesh.indices && nextMesh.indices.byteLength !== part.mesh.indices.byteLength) { return null; }
        backups[i] = {
          mesh: part.mesh,
          ibCount: part.ibCount,
          instanceCount: part.instanceCount,
          instanceKind: part.instanceKind,
          topology: part.topology
        };
      }
      for (var j = 0; j < this._parts.length; j += 1) {
        var swapPart = this._parts[j];
        var swapMesh = meshes[j];
        this._device.queue.writeBuffer(swapPart.vb, 0, swapMesh.vertices);
        this._device.queue.writeBuffer(swapPart.ib, 0, swapMesh.indices);
        swapPart.mesh = swapMesh;
        swapPart.ibCount = swapMesh.indices.length;
        swapPart.instanceCount = Number(swapMesh.instance_count || 0);
        swapPart.instanceKind = swapMesh.instance_kind || null;
        swapPart.topology = swapMesh.topology || "triangle-list";
      }
      return backups;
    },

    _swapSelfReferencedScreensToPlain: function (frameId) {
      var wantedFrameId = String(frameId || "").trim();
      if (!wantedFrameId || !this._parts || !this._parts.length) {
        return null;
      }
      var backups = new Array(this._parts.length);
      var changed = false;
      for (var i = 0; i < this._parts.length; i += 1) {
        var part = this._parts[i];
        var mesh = part && part.mesh;
        var surfaceSystem = mesh && mesh.surface_system && typeof mesh.surface_system === "object"
          ? mesh.surface_system
          : null;
        backups[i] = mesh;
        if (!surfaceSystem) { continue; }
        if (String(surfaceSystem.kind || "").toLowerCase().trim() !== "screen") { continue; }
        if (String(surfaceSystem.frame_ref || "").trim() !== wantedFrameId) { continue; }
        var clone = Object.assign({}, mesh);
        clone.surface_system = null;
        clone.transparent = true;
        clone.depth_write = false;
        part.mesh = clone;
        changed = true;
      }
      return changed ? backups : null;
    },

    _restoreScenePartsMeshes: function (backups) {
      if (!Array.isArray(backups) || !this._parts || backups.length !== this._parts.length) {
        return;
      }
      for (var i = 0; i < this._parts.length; i += 1) {
        if (backups[i]) {
          this._parts[i].mesh = backups[i];
        }
      }
    },

    _restoreScenePartsMeshes: function (backups) {
      if (!Array.isArray(backups) || !this._parts || backups.length !== this._parts.length) {
        return;
      }
      for (var i = 0; i < this._parts.length; i += 1) {
        var part = this._parts[i];
        var backup = backups[i];
        if (!part || !backup || !backup.mesh) { continue; }
        this._device.queue.writeBuffer(part.vb, 0, backup.mesh.vertices);
        this._device.queue.writeBuffer(part.ib, 0, backup.mesh.indices);
        part.mesh = backup.mesh;
        part.ibCount = backup.ibCount;
        part.instanceCount = backup.instanceCount;
        part.instanceKind = backup.instanceKind;
        part.topology = backup.topology;
      }
    },

    _renderSurfacePasses: function (enc, sceneMesh, t, width, height) {
      if (!this._parts || !this._parts.length) { return; }
      var MmBatch = getMath();
      for (var i = 0; i < this._parts.length; i++) {
        var part = this._parts[i];
        var partMesh = part && part.mesh;
        var surfaceSystem = partMesh && partMesh.surface_system && typeof partMesh.surface_system === "object"
          ? partMesh.surface_system
          : null;
        if (!surfaceSystem) {
          if (partMesh) { partMesh._surfaceTextureReady = false; }
          if (part) {
            part.surfaceColorView = null;
            this._ensurePartBindGroup(part);
          }
          continue;
        }
        var surfaceKind = String(surfaceSystem.kind || "").toLowerCase().trim();
        if (surfaceKind === "mirror") {
          failFast("mirror surfaces must be lowered to screen surfaces before vf-geom-wgpu render");
        }
        if (surfaceKind !== "screen") {
          partMesh._surfaceTextureReady = false;
          part.surfaceExternalView = null;
          part.surfaceColorView = null;
          this._ensurePartBindGroup(part);
          continue;
        }
        if (surfaceKind === "screen" && surfaceSystem && String(surfaceSystem.frame_ref || "").trim()) {
          var sourceFrameId = String(surfaceSystem.frame_ref || "").trim();
          var wantedDims = this._surfaceTargetDimsForPart(part, width, height);
          var frameRenderers = global.__vfFrameRenderers && typeof global.__vfFrameRenderers === "object"
            ? global.__vfFrameRenderers
            : null;
          var sourceRenderer = frameRenderers ? frameRenderers[sourceFrameId] : null;
          if (!sourceRenderer || typeof sourceRenderer._debugGetFrameTextureRef !== "function") {
            surfaceSystem._runtime_texture_ready = false;
            part.surfaceExternalView = null;
            partMesh._surfaceTextureReady = false;
            this._ensurePartBindGroup(part);
            continue;
          }
          if (sourceRenderer._offscreenFrame === true && typeof sourceRenderer._debugSetFrameTextureTargetSize === "function") {
            sourceRenderer._debugSetFrameTextureTargetSize(wantedDims.width, wantedDims.height);
          }
          var frameTextureRef = sourceRenderer._debugGetFrameTextureRef();
          if (!frameTextureRef || !frameTextureRef.view) {
            surfaceSystem._runtime_texture_ready = false;
            part.surfaceExternalView = null;
            partMesh._surfaceTextureReady = false;
            this._ensurePartBindGroup(part);
            continue;
          }
          surfaceSystem._runtime_texture_ready = true;
          part.surfaceExternalView = frameTextureRef.view;
          part.surfaceColorView = null;
          part.surfaceW = Number(frameTextureRef.width || 0) || width;
          part.surfaceH = Number(frameTextureRef.height || 0) || height;
          partMesh._surfaceTextureReady = true;
          debugSurfaceBind(
            "frame-ref-bind",
            partMesh,
            "source=" + sourceFrameId +
            " dims=" + String(part.surfaceW) + "x" + String(part.surfaceH) +
            " flipU=" + String(!!frameTextureRef.flipU) +
            " flipV=" + String(!!frameTextureRef.flipV)
          );
          this._ensurePartBindGroup(part);
          continue;
        }
        if (surfaceKind === "screen") {
          surfaceSystem._runtime_texture_ready = true;
        }
        part.surfaceExternalView = null;
        var targetDims = this._surfaceTargetDimsForPart(part, width, height);
        var surfaceCamera = surfaceSystem.camera && typeof surfaceSystem.camera === "object"
          ? surfaceSystem.camera
          : (sceneMesh.camera || null);
        var renderCamera = this._resolveScreenRenderCamera(
          part,
          sceneMesh,
          surfaceCamera,
          t,
          Math.max(1e-4, targetDims.width / Math.max(1, targetDims.height))
        );
        if (!renderCamera) {
          surfaceSystem._runtime_texture_ready = false;
          part.surfaceExternalView = null;
          partMesh._surfaceTextureReady = false;
          this._ensurePartBindGroup(part);
          continue;
        }
        this._ensureSurfaceTarget(part, targetDims.width, targetDims.height);
        partMesh._surfaceTextureReady = true;
        var surfaceClear = this._sceneBackgroundClear(sceneMesh);
        this._encodeScenePartsColorPass(
          enc,
          sceneMesh,
          t,
          part.surfaceW,
          part.surfaceH,
          part.surfaceMsaaTex.createView(),
          part.surfaceColorView,
          part.surfaceDepthTex.createView(),
          surfaceClear,
          renderCamera,
          part.objectId,
          true,
          {}
        );
        this._ensurePartBindGroup(part);
      }
    },

    _debugAnalyzeSurfaceTextures: async function (threshold) {
      if (!this._device || !this._parts || !this._parts.length) { return []; }
      var limit = Math.max(0, Math.min(255, Number(threshold == null ? 32 : threshold) || 32));
      var out = [];
      for (var i = 0; i < this._parts.length; i += 1) {
        var part = this._parts[i];
        var partMesh = part && part.mesh;
        if (!part || !part.surfaceColorTex || !part.surfaceW || !part.surfaceH || !partMesh) { continue; }
        var bytesPerPixel = 4;
        var unpaddedBytesPerRow = part.surfaceW * bytesPerPixel;
        var bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
        var byteLength = bytesPerRow * part.surfaceH;
        var readBuf = this._device.createBuffer({
          size: byteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        var enc = this._device.createCommandEncoder();
        enc.copyTextureToBuffer(
          { texture: part.surfaceColorTex },
          { buffer: readBuf, bytesPerRow: bytesPerRow, rowsPerImage: part.surfaceH },
          { width: part.surfaceW, height: part.surfaceH, depthOrArrayLayers: 1 }
        );
        this._device.queue.submit([enc.finish()]);
        await readBuf.mapAsync(GPUMapMode.READ);
        var mapped = new Uint8Array(readBuf.getMappedRange());
        var minX = part.surfaceW;
        var minY = part.surfaceH;
        var maxX = -1;
        var maxY = -1;
        for (var y = 0; y < part.surfaceH; y += 1) {
          var rowOffset = y * bytesPerRow;
          for (var x = 0; x < part.surfaceW; x += 1) {
            var px = rowOffset + (x * bytesPerPixel);
            var r = mapped[px];
            var g = mapped[px + 1];
            var b = mapped[px + 2];
            if (Math.max(r, g, b) <= limit) { continue; }
            if (x < minX) { minX = x; }
            if (x > maxX) { maxX = x; }
            if (y < minY) { minY = y; }
            if (y > maxY) { maxY = y; }
          }
        }
        readBuf.unmap();
        readBuf.destroy();
        out.push({
          meshId: String(partMesh.id || ""),
          surfaceKind: String(partMesh.surface_system && partMesh.surface_system.kind || ""),
          width: part.surfaceW,
          height: part.surfaceH,
          threshold: limit,
          bbox: maxX >= minX && maxY >= minY ? [minX, minY, maxX, maxY] : null
        });
      }
      return out;
    },

    _debugReadSurfaceTexture: async function (meshId) {
      if (!this._device || !this._parts || !this._parts.length) { return null; }
      var wantedMeshId = String(meshId == null ? "" : meshId);
      var selectedPart = null;
      for (var i = 0; i < this._parts.length; i += 1) {
        var candidate = this._parts[i];
        var candidateMesh = candidate && candidate.mesh;
        if (!candidate || !candidate.surfaceColorTex || !candidate.surfaceW || !candidate.surfaceH || !candidateMesh) { continue; }
        if (wantedMeshId && String(candidateMesh.id || "") !== wantedMeshId && String(candidateMesh.mesh_id || "") !== wantedMeshId) {
          continue;
        }
        selectedPart = candidate;
        break;
      }
      if (!selectedPart) { return null; }
      var bytesPerPixel = 4;
      var width = selectedPart.surfaceW;
      var height = selectedPart.surfaceH;
      var unpaddedBytesPerRow = width * bytesPerPixel;
      var bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
      var byteLength = bytesPerRow * height;
      var readBuf = this._device.createBuffer({
        size: byteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      var enc = this._device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: selectedPart.surfaceColorTex },
        { buffer: readBuf, bytesPerRow: bytesPerRow, rowsPerImage: height },
        { width: width, height: height, depthOrArrayLayers: 1 }
      );
      this._device.queue.submit([enc.finish()]);
      await readBuf.mapAsync(GPUMapMode.READ);
      var mapped = new Uint8Array(readBuf.getMappedRange());
      var packed = new Uint8ClampedArray(width * height * bytesPerPixel);
      for (var y = 0; y < height; y += 1) {
        var srcRow = y * bytesPerRow;
        var dstRow = y * unpaddedBytesPerRow;
        packed.set(mapped.subarray(srcRow, srcRow + unpaddedBytesPerRow), dstRow);
      }
      readBuf.unmap();
      readBuf.destroy();
      return {
        meshId: String(selectedPart.mesh && selectedPart.mesh.id || ""),
        width: width,
        height: height,
        pixels: packed,
        flipU: !!(selectedPart.mesh && selectedPart.mesh.surface_system && selectedPart.mesh.surface_system._renderFlipU),
        flipV: !!(selectedPart.mesh && selectedPart.mesh.surface_system && selectedPart.mesh.surface_system._renderFlipV),
        format: String(this._format || "")
      };
    },

    _debugGetSurfaceTextureRef: function (meshId) {
      if (!this._parts || !this._parts.length) { return null; }
      var wantedMeshId = String(meshId == null ? "" : meshId);
      for (var i = 0; i < this._parts.length; i += 1) {
        var candidate = this._parts[i];
        var candidateMesh = candidate && candidate.mesh;
        if (!candidate || !candidate.surfaceColorTex || !candidate.surfaceColorView || !candidate.surfaceW || !candidate.surfaceH || !candidateMesh) {
          continue;
        }
        if (wantedMeshId && String(candidateMesh.id || "") !== wantedMeshId && String(candidateMesh.mesh_id || "") !== wantedMeshId) {
          continue;
        }
        return {
          meshId: String(candidateMesh.id || ""),
          width: candidate.surfaceW,
          height: candidate.surfaceH,
          texture: candidate.surfaceColorTex,
          view: candidate.surfaceColorView,
          flipU: !!(candidateMesh.surface_system && candidateMesh.surface_system._renderFlipU),
          flipV: !!(candidateMesh.surface_system && candidateMesh.surface_system._renderFlipV),
          format: String(this._format || "")
        };
      }
      return null;
    },

    _debugGetFrameTextureRef: function () {
      if (!this._frameColorTex || !this._frameColorView || !this._frameColorW || !this._frameColorH) {
        return null;
      }
      var sourceView = this._displayViewForCurrentFrame(this._lastMesh || null);
      var useSceneView = !!(sourceView && sourceView === this._frameSceneColorView);
      return {
        width: useSceneView ? (this._frameSceneColorW || this._frameColorW) : this._frameColorW,
        height: useSceneView ? (this._frameSceneColorH || this._frameColorH) : this._frameColorH,
        texture: useSceneView ? (this._frameSceneColorTex || this._frameColorTex) : this._frameColorTex,
        view: sourceView || this._frameColorView,
        flipU: false,
        flipV: false,
        format: String(this._format || "")
      };
    },

    _createScenePart: function (mesh, index) {
      var dev = this._device;
      var sg2 = sharedWgpu;
      var vb = dev.createBuffer({ size: mesh.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(vb, 0, mesh.vertices);
      var ib = dev.createBuffer({ size: mesh.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(ib, 0, mesh.indices);
      var instanceBuf = null;
      if (mesh.instances && mesh.instances.byteLength > 0) {
        instanceBuf = dev.createBuffer({
          size: mesh.instances.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        dev.queue.writeBuffer(instanceBuf, 0, mesh.instances);
      }
      var uniformBuf = dev.createBuffer({
        size: UB_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      var shadowUniformBuf = dev.createBuffer({
        size: SHADOW_UB_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      var pickUb = dev.createBuffer({
        size: PICK_UB_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      var pickBg = dev.createBindGroup({
        layout: sg2.pickBindLayout,
        entries: [{ binding: 0, resource: { buffer: pickUb } }],
      });
      return {
        mesh: mesh,
        vb: vb,
        ib: ib,
        instanceBuf: instanceBuf,
        instanceCount: Number(mesh.instance_count || 0),
        instanceKind: mesh.instance_kind || null,
        staticIndices: mesh.static_indices === true,
        staticVertices: mesh.static_vertices === true,
        ibCount: mesh.indices.length,
        topology: mesh.topology || "triangle-list",
        uniformBuf: uniformBuf,
        shadowUniformBuf: shadowUniformBuf,
        bindGroup: null,
        pickUb: pickUb,
        pickBg: pickBg,
        objectId: Number(mesh.object_id || (index + 1)) || (index + 1)
      };
    },

    _canReuseScenePart: function (part, mesh, index) {
      if (!part || !mesh) { return false; }
      if (!part.vb || !part.ib || !part.uniformBuf || !part.shadowUniformBuf || !part.pickUb || !part.pickBg || !part.bindGroup) { return false; }
      if ((part.topology || "triangle-list") !== (mesh.topology || "triangle-list")) { return false; }
      if ((part.instanceKind || null) !== (mesh.instance_kind || null)) { return false; }
      if (Number(part.objectId || 0) !== (Number(mesh.object_id || (index + 1)) || (index + 1))) { return false; }
      if (!part.mesh) { return false; }
      if (!part.mesh.vertices || !part.mesh.indices || !mesh.vertices || !mesh.indices) { return false; }
      if (part.mesh.vertices.byteLength !== mesh.vertices.byteLength) { return false; }
      if (part.mesh.indices.byteLength !== mesh.indices.byteLength) { return false; }
      if (!!part.mesh.instances !== !!mesh.instances) { return false; }
      if (part.mesh.instances && mesh.instances && part.mesh.instances.byteLength !== mesh.instances.byteLength) { return false; }
      return true;
    },

    _uploadSceneParts: function (scene) {
      if (!scene || !Array.isArray(scene.parts) || !this._device) { return; }
      if (!scene.parts.length) {
        failFast("scene parts upload received zero parts");
      }
      var dev = this._device;
      var previousParts = Array.isArray(this._parts) ? this._parts : [];
      var nextParts = new Array(scene.parts.length);
      for (var i = 0; i < scene.parts.length; i++) {
        var mesh = scene.parts[i];
        if (!mesh) { continue; }
        var existing = previousParts[i];
        if (this._canReuseScenePart(existing, mesh, i)) {
          if (!mesh.instance_kind) {
            if (!existing.staticVertices) {
              dev.queue.writeBuffer(existing.vb, 0, mesh.vertices);
            }
            if (!existing.staticIndices) {
              dev.queue.writeBuffer(existing.ib, 0, mesh.indices);
            }
          }
          if (mesh.instances && existing.instanceBuf) {
            dev.queue.writeBuffer(existing.instanceBuf, 0, mesh.instances);
          }
          existing.mesh = mesh;
          existing.ibCount = mesh.indices.length;
          existing.instanceCount = Number(mesh.instance_count || 0);
          existing.instanceKind = mesh.instance_kind || null;
          existing.staticIndices = mesh.static_indices === true;
          existing.staticVertices = mesh.static_vertices === true;
          existing.topology = mesh.topology || "triangle-list";
          existing.objectId = Number(mesh.object_id || (i + 1)) || (i + 1);
          nextParts[i] = existing;
          previousParts[i] = null;
          continue;
        }
        if (existing) {
          this._destroyPart(existing);
          previousParts[i] = null;
        }
        nextParts[i] = this._createScenePart(mesh, i);
        this._ensurePartBindGroup(nextParts[i]);
      }
      for (var j = 0; j < previousParts.length; j++) {
        if (previousParts[j]) {
          this._destroyPart(previousParts[j]);
        }
      }
      this._parts = nextParts.filter(function (part) { return !!part; });
    },

    _uploadMesh: function (mesh) {
      if (!mesh || !this._device) { return; }
      if (mesh.parts && Array.isArray(mesh.parts)) {
        if (this._vb) { try { this._vb.destroy(); } catch(_){} this._vb = null; }
        if (this._ib) { try { this._ib.destroy(); } catch(_){} this._ib = null; }
        this._ibCount = 0;
        this._topology = "triangle-list";
        this._uploadSceneParts(mesh);
        return;
      }
      var dev = this._device;
      this._destroyParts();
      if (this._vb) { this._vb.destroy(); this._vb = null; }
      if (this._ib) { this._ib.destroy(); this._ib = null; }
      this._vb = dev.createBuffer({ size: mesh.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(this._vb, 0, mesh.vertices);
      this._ib = dev.createBuffer({ size: mesh.indices.byteLength,  usage: GPUBufferUsage.INDEX  | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(this._ib, 0, mesh.indices);
      this._ibCount  = mesh.indices.length;
      this._topology = mesh.topology || "triangle-list";
    },

    _renderContent: function (t) {
      if (!this._device) { return; }
      var perfSample = Object.create(null);
      var perfTotalStart = perfNowMs();
      var perfStageStart = perfTotalStart;
      var mesh = this._getMesh(t * 0.001);
      perfSample.get_mesh = perfNowMs() - perfStageStart;
      if (!mesh) { return; }
      maybeLogMirrorCamera(this, mesh);
      var meshRevision = Number(mesh && mesh.__revision);
      if (mesh !== this._lastMesh || meshRevision !== this._lastMeshRevision) {
        perfStageStart = perfNowMs();
        this._lastMesh = mesh;
        this._lastMeshRevision = meshRevision;
        this._uploadMesh(mesh);
        perfSample.upload = perfNowMs() - perfStageStart;
      } else {
        perfSample.upload = 0.0;
      }
      if (mesh.parts && Array.isArray(mesh.parts)) {
        if (!this._parts || !this._parts.length) {
          failFast("shared scene renderer has zero uploaded parts");
        }
        var MmBatch = getMath();
        var wBatch = this._canvas.width;
        var hBatch = this._canvas.height;
        var aspBatch = wBatch / Math.max(1, hBatch);
        this._ensureDepth();
        this._ensureMsaaColor();
        this._ensureFrameColorTarget();
        this._ensureFrameSceneColorTarget();
        var shadowEncBatch = this._device.createCommandEncoder();
        perfStageStart = perfNowMs();
        var preparedShadows = this._prepareShadowMapsForScene(shadowEncBatch, mesh, t, wBatch, hBatch);
        perfSample.shadow_prepare = perfNowMs() - perfStageStart;
        perfSample.shadow_cache_hit = Number(this._lastShadowCacheHit || 0.0);
        if ((preparedShadows[0] || preparedShadows[1])) {
          perfStageStart = perfNowMs();
          this._device.queue.submit([shadowEncBatch.finish()]);
          perfSample.shadow_submit = perfNowMs() - perfStageStart;
        } else {
          perfSample.shadow_submit = 0.0;
        }
        var encBatch = this._device.createCommandEncoder();
        var sceneSourceBackups = this._swapSelfReferencedScreensToPlain(this._frameId);
        perfStageStart = perfNowMs();
        this._encodeScenePartsColorPass(
          encBatch,
          mesh,
          t,
          wBatch,
          hBatch,
          this._msaaTex.createView(),
          this._frameSceneColorView,
          this._depthTex.createView(),
          { r: 0, g: 0, b: 0, a: 0 },
          null,
          0,
          true
        );
        perfSample.scene_pass = perfNowMs() - perfStageStart;
        this._restoreScenePartsMeshes(sceneSourceBackups);
        perfStageStart = perfNowMs();
        this._renderSurfacePasses(encBatch, mesh, t, wBatch, hBatch);
        perfSample.surface_pass = perfNowMs() - perfStageStart;
        perfStageStart = perfNowMs();
        this._encodeScenePartsColorPass(
          encBatch,
          mesh,
          t,
          wBatch,
          hBatch,
          this._msaaTex.createView(),
          this._frameColorView,
          this._depthTex.createView(),
          { r: 0, g: 0, b: 0, a: 0 },
          null,
          0,
          false
        );
        perfSample.final_pass = perfNowMs() - perfStageStart;
        var sceneCam = mesh.camera || {};
        var scenePos = sceneCam.pos || [0, 0, 5];
        var sceneTarget = sceneCam.target || [0, 0, 0];
        var sceneUp = sceneCam.up || [0, 1, 0];
        var sceneFov = sceneCam.fov !== undefined ? sceneCam.fov : 45;
        var sceneProj = MmBatch.mat4PerspectiveZ01(sceneFov * Math.PI / 180, aspBatch, 0.05, 500);
        var sceneView;
        if (!mesh.camera) {
          var sceneAng = t * 0.0008;
          sceneView = MmBatch.mat4Mul(MmBatch.mat4Translation(0, 0, -5), MmBatch.mat4RotationY(sceneAng));
          scenePos = [0, 0, 5];
        } else {
          sceneView = mat4LookAt(scenePos, sceneTarget, sceneUp);
        }
        var sceneMvp = MmBatch.mat4Mul(sceneProj, sceneView);
        var sceneLights = resolveSceneLights(
          lightsForRenderer(mesh.lights || [], this._offscreenFrame === true),
          sceneMeshForLightResolution(mesh, this._parts),
          t
        );
        maybeLogResolvedLights(this, "flares", sceneLights);
        perfStageStart = perfNowMs();
        this._drawGpuLightFlares(encBatch, mesh, sceneMvp, scenePos, sceneLights, wBatch, hBatch, this._frameColorView);
        perfSample.flares = perfNowMs() - perfStageStart;

        var sgBatch = sharedWgpu;
        var pendingBatchPick = !!this._pendingPickPx;
        var fireBatchPickCallback = false;
        var pickPerfStart = perfNowMs();
        if (pendingBatchPick && sgBatch && sgBatch.pipePick && this._pickTex) {
          var pickPassBatch = encBatch.beginRenderPass({
            colorAttachments: [{
              view: this._pickTex.createView(),
              clearValue: [0, 0, 0, 0],
              loadOp: "clear",
              storeOp: "store",
            }],
            depthStencilAttachment: {
              view: this._pickDepthTex.createView(),
              depthClearValue: 1.0,
              depthLoadOp: "clear",
              depthStoreOp: "discard",
            },
          });
          for (var pickIndex = 0; pickIndex < this._parts.length; pickIndex++) {
            var pickPart = this._parts[pickIndex];
            var pickMesh = pickPart.mesh;
            if (!pickMesh || pickPart.topology !== "triangle-list") { continue; }
            if (pickMesh.pickable === false) { continue; }
            var camPick = pickMesh.camera || mesh.camera || {};
            var posPick = camPick.pos || [0, 0, 5];
            var targetPick = camPick.target || [0, 0, 0];
            var upPick = camPick.up || [0, 1, 0];
            var modelPick;
            modelPick = resolveAnimatedModelMatrix(
              pickMesh,
              t,
              pickMesh.center || [0, 0, 0],
              pickMesh.rotation || [0, 0, 0],
              pickMesh.scale || [1, 1, 1],
              MmBatch
            ) || (pickMesh._modelMatrix || MmBatch.mat4Identity());
            var mvpPick;
            if (pickMesh.mode3d === false) {
              mvpPick = MmBatch.mat4OrthoZ01(-1, 1, -1, 1, 0, 1);
            } else {
              var fovPick = camPick.fov !== undefined ? camPick.fov : 45;
              var projPick = MmBatch.mat4PerspectiveZ01(fovPick * Math.PI / 180, aspBatch, 0.05, 500);
              var viewPick = mat4LookAt(posPick, targetPick, upPick);
              mvpPick = MmBatch.mat4Mul(projPick, viewPick);
            }
            var pickUbPart = this._buildPickUniform(mvpPick, modelPick);
            (new Uint32Array(pickUbPart.buffer))[32] = pickPart.objectId >>> 0;
            this._device.queue.writeBuffer(pickPart.pickUb, 0, pickUbPart);
            pickPassBatch.setPipeline(sgBatch.pipePick);
            pickPassBatch.setBindGroup(0, pickPart.pickBg);
            pickPassBatch.setVertexBuffer(0, pickPart.vb);
            pickPassBatch.setIndexBuffer(pickPart.ib, "uint32");
            pickPassBatch.drawIndexed(pickPart.ibCount);
          }
          pickPassBatch.end();
          var ppxBatch = this._pendingPickPx;
          if (ppxBatch) {
            this._pendingPickPx = null;
            var oxBatch = Math.max(0, Math.min(this._pickW - 1, ppxBatch[0]));
            var oyBatch = Math.max(0, Math.min(this._pickH - 1, ppxBatch[1]));
            var sampleWBatch = Math.max(1, Math.min(this._pickW - oxBatch, ppxBatch[2] || 1));
            var sampleHBatch = Math.max(1, Math.min(this._pickH - oyBatch, ppxBatch[3] || 1));
            encBatch.copyTextureToBuffer(
              { texture: this._pickTex, origin: { x: oxBatch, y: oyBatch, z: 0 }, mipLevel: 0 },
              { buffer: this._pickReadBuf, offset: 0, bytesPerRow: 256, rowsPerImage: sampleHBatch },
              { width: sampleWBatch, height: sampleHBatch, depthOrArrayLayers: 1 }
            );
            fireBatchPickCallback = !!this._pickCallback;
          }
        } else if (pendingBatchPick) {
          wlog("warn", "dropping GPU pick request: pick pass is unavailable for scene parts");
          this._pendingPickPx = null;
          this._pickPending = false;
          this._pickCallback = null;
        }
        perfSample.pick = perfNowMs() - pickPerfStart;
        this._blitFrameTargetToCanvas(encBatch, mesh);
        perfStageStart = perfNowMs();
        this._device.queue.submit([encBatch.finish()]);
        perfSample.submit = perfNowMs() - perfStageStart;
        perfSample.total = perfNowMs() - perfTotalStart;
        var perfStats = ensurePerfStats(this);
        perfStats.frames += 1;
        var perfKeys = Object.keys(perfSample);
        for (var perfIndex = 0; perfIndex < perfKeys.length; perfIndex += 1) {
          recordPerfMetric(perfStats, perfKeys[perfIndex], perfSample[perfKeys[perfIndex]]);
        }
        flushPerfStats(this);
        if (fireBatchPickCallback && this._pickCallback) { this._pickCallback(); }
        return;
      }
      if (!this._vb || !this._ib) { return; }

      var Mm    = getMath();
      var w     = this._canvas.width;
      var h     = this._canvas.height;
      var asp   = w / Math.max(1, h);

      // --- Camera ---
      var cam   = mesh.camera || {};
      var pos   = cam.pos    || [0, 0, 5];
      var target= cam.target || [0, 0, 0];
      var fov   = cam.fov    !== undefined ? cam.fov : 45;
      var up    = cam.up     || [0, 1, 0];

      var projMat, viewMat, mvp, modelMat;
      // Compute model matrix live from mesh data so rotation/center/scale
      // changes applied after init() are always reflected correctly.
      modelMat = resolveAnimatedModelMatrix(
        mesh,
        t,
        mesh.center || [0, 0, 0],
        mesh.rotation || [0, 0, 0],
        mesh.scale || [1, 1, 1],
        Mm
      ) || (mesh._modelMatrix || Mm.mat4Identity());

      if (mesh.mode3d === false) {
        // 2D ortho — ignore camera
        if (String(mesh.aspect || "").toLowerCase() === "equal") {
          if (asp >= 1.0) {
            projMat = Mm.mat4OrthoZ01(-asp, asp, -1, 1, 0, 1);
          } else {
            projMat = Mm.mat4OrthoZ01(-1, 1, -1 / Math.max(1e-6, asp), 1 / Math.max(1e-6, asp), 0, 1);
          }
        } else {
          projMat = Mm.mat4OrthoZ01(-1, 1, -1, 1, 0, 1);
        }
        mvp     = projMat;
      } else {
        var fovRad = fov * Math.PI / 180;
        if (cam && Array.isArray(cam.projection_matrix) && cam.projection_matrix.length === 16) {
          projMat = new Float32Array(cam.projection_matrix);
        } else if (String(cam && cam.projection || "").toLowerCase() === "orthographic") {
          var orthoScale = Math.max(1e-6, Number(cam.ortho_scale || 2.5) || 2.5);
          projMat = Mm.mat4OrthoZ01(-orthoScale * asp, orthoScale * asp, -orthoScale, orthoScale, 0.05, 500);
        } else {
          projMat  = Mm.mat4PerspectiveZ01(fovRad, asp, 0.05, 500);
        }
        // auto-spin if no camera is set on mesh
        if (!mesh.camera) {
          var ang  = t * 0.0008;
          var tr   = Mm.mat4Translation(0, 0, -5);
          var rot  = Mm.mat4RotationY(ang);
          viewMat  = Mm.mat4Mul(tr, rot);
          pos      = [0, 0, 5];
        } else {
          viewMat = mat4LookAt(pos, target, up);
        }
        mvp = Mm.mat4Mul(projMat, viewMat);
      }

      // --- Lights ---
      var rawLights = mesh.no_lighting === true ? [] : lightsForMesh((mesh.lights || []), this._offscreenFrame === true, mesh);
      var lightsNorm = resolveSceneLights(rawLights, sceneMeshForLightResolution(mesh, this._parts), t);
      maybeLogResolvedLights(this, "main", lightsNorm);
      var lmName = mesh.light_model || (lightsNorm[0] && lightsNorm[0].model) || "blinn_phong";
      var lmInt  = LIGHT_MODELS[lmName] !== undefined ? LIGHT_MODELS[lmName] : 2;

      // --- Build + upload uniform ---
      var ub = buildUniform(mvp, modelMat, pos, lightsNorm, lmInt, resolveAlphaMul(mesh), mesh);
      this._device.queue.writeBuffer(this._uniformBuf, 0, ub);
      // --- Draw ---
      this._ensureDepth();
      this._ensureMsaaColor();
      this._ensureFrameColorTarget();
      var enc  = this._device.createCommandEncoder();
      var pass = enc.beginRenderPass({
        colorAttachments: [{
          view:       this._msaaTex.createView(),
          resolveTarget: this._frameColorView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp:  "clear",
          storeOp: "store",
        }],
        depthStencilAttachment: {
          view:            this._depthTex.createView(),
          depthClearValue: 1,
          depthLoadOp:     "clear",
          depthStoreOp:    "store",
        },
      });
      var blendMode = String(mesh.blend_mode || "");
      var isMultiply = this._topology === "triangle-list" && blendMode === "multiply";
      var isAdditive = this._topology === "triangle-list" && blendMode === "additive";
      var isTransparent = !!mesh.transparent && this._topology === "triangle-list" && !isMultiply && !isAdditive;
      var useTransparentDepth = isTransparent && !!mesh.depth_write;
      var pipe = this._topology === "line-list"
        ? this._pipeLine
        : (
            isAdditive && this._pipeTriAdditive ? this._pipeTriAdditive :
            isMultiply && this._pipeTriMultiply ? this._pipeTriMultiply :
            useTransparentDepth && this._pipeTriAlphaDepth ? this._pipeTriAlphaDepth :
            (isTransparent && this._pipeTriAlpha ? this._pipeTriAlpha : this._pipeTri)
          );
      pass.setPipeline(pipe);
      pass.setBindGroup(0, this._bindGroup);
      pass.setVertexBuffer(0, this._vb);
      pass.setIndexBuffer(this._ib, "uint32");
      pass.drawIndexed(this._ibCount, 1, 0, 0, 0);
      pass.end();

      this._drawGpuLightFlares(enc, mesh, mvp, pos, lightsNorm, w, h, this._frameColorView);

      // ── Picking pass (triangle-list only, skips wireframe) ────────────────
      var sg2 = sharedWgpu;
        var pendingSinglePick = !!this._pendingPickPx;
        var fireSinglePickCallback = false;
      if (pendingSinglePick && sg2 && sg2.pipePick && this._pickTex && this._topology === "triangle-list") {
        // Ensure picking UB + BG exist
        if (!this._pickUb) {
          this._pickUb = this._device.createBuffer({
            size: PICK_UB_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
          this._pickBG = this._device.createBindGroup({
            layout: sg2.pickBindLayout,
            entries: [{ binding: 0, resource: { buffer: this._pickUb } }],
          });
        }
        var pickUb = this._buildPickUniform(mvp, modelMat);
        this._device.queue.writeBuffer(this._pickUb, 0, pickUb);

        var pickPass = enc.beginRenderPass({
          colorAttachments: [{
            view:       this._pickTex.createView(),
            clearValue: [0, 0, 0, 0],
            loadOp:  "clear",
            storeOp: "store",
          }],
          depthStencilAttachment: {
            view:              this._pickDepthTex.createView(),
            depthClearValue:   1.0,
            depthLoadOp:       "clear",
            depthStoreOp:      "discard",
          },
        });
        pickPass.setPipeline(sg2.pipePick);
        pickPass.setBindGroup(0, this._pickBG);
        pickPass.setVertexBuffer(0, this._vb);
        pickPass.setIndexBuffer(this._ib, "uint32");
        pickPass.drawIndexed(this._ibCount);
        pickPass.end();

        // If a pickAt request is pending, copy 1 pixel → readback buffer
        var ppx = this._pendingPickPx;
        if (ppx) {
          this._pendingPickPx = null;
          var ox = Math.max(0, Math.min(this._pickW - 1, ppx[0]));
          var oy = Math.max(0, Math.min(this._pickH - 1, ppx[1]));
          var sampleW = Math.max(1, Math.min(this._pickW - ox, ppx[2] || 1));
          var sampleH = Math.max(1, Math.min(this._pickH - oy, ppx[3] || 1));
          enc.copyTextureToBuffer(
            { texture: this._pickTex, origin: { x: ox, y: oy, z: 0 }, mipLevel: 0 },
            { buffer: this._pickReadBuf, offset: 0, bytesPerRow: 256, rowsPerImage: sampleH },
            { width: sampleW, height: sampleH, depthOrArrayLayers: 1 }
          );
          fireSinglePickCallback = !!this._pickCallback;
        }
      } else if (pendingSinglePick) {
        wlog("warn", "dropping GPU pick request: pick pass is unavailable for mesh");
        this._pendingPickPx = null;
        this._pickPending = false;
        this._pickCallback = null;
      }
      this._blitFrameTargetToCanvas(enc, mesh);
      this._device.queue.submit([enc.finish()]);

      // Fire the callback after the combined visible+pick submit.
      if (fireSinglePickCallback && this._pickCallback) { this._pickCallback(); }

    },

    _drawGpuLightFlares: function (enc, mesh, mvp, cameraPos, lightsNorm, width, height, resolveTargetView) {
      var flareCfg = mesh && mesh.light_flares;
      if (!flareCfg || flareCfg.enabled !== true) { return; }
      if (!sharedWgpu || !sharedWgpu.pipeFlare || !sharedWgpu.flareQuadBuf) { return; }
      if (!Array.isArray(lightsNorm) || !lightsNorm.length) { return; }
      if (!mvp || !cameraPos) { return; }
      var occluders = flareCfg.occluders || [];
      var instances = [];
      var centerX = width * 0.5;
      var centerY = height * 0.5;
      var baseSizeWorld = Math.max(0.02, Number(flareCfg.size || 0.18));
      for (var i = 0; i < lightsNorm.length; i += 1) {
        var light = lightsNorm[i];
        if (light && light.show_marker === false) { continue; }
        var lightPos = light.pos || [0, 0, 0];
        var ndc = projectWorldToNdc(mvp, lightPos);
        if (!ndc) { continue; }
        if (Math.abs(ndc[0]) > 1.02 || Math.abs(ndc[1]) > 1.02) { continue; }
        if (lightOccludedByBoxes(cameraPos, lightPos, occluders)) { continue; }
        var intensity = Math.max(0.0, Number(light.intensity || 24.0));
        var toCam = [
          Number(cameraPos[0]) - Number(lightPos[0]),
          Number(cameraPos[1]) - Number(lightPos[1]),
          Number(cameraPos[2]) - Number(lightPos[2])
        ];
        var toCamLen = Math.sqrt((toCam[0] * toCam[0]) + (toCam[1] * toCam[1]) + (toCam[2] * toCam[2])) || 1.0;
        toCam = [toCam[0] / toCamLen, toCam[1] / toCamLen, toCam[2] / toCamLen];
        var facing = 1.0;
        if (String(light.kind || "point") === "spot") {
          var beamDir = light.direction_f32 || [0, 0, -1];
          facing = Math.max(0.0, (beamDir[0] * toCam[0]) + (beamDir[1] * toCam[1]) + (beamDir[2] * toCam[2]));
        }
        var baseAlpha = Math.min(1.0, 0.30 + Math.min(0.70, intensity / 170.0));
        var flareAlpha = Math.max(0.0, Math.min(1.0, baseAlpha * (0.30 + (0.70 * facing))));
        if (!(flareAlpha > 0.001)) { continue; }
        var pxSize = Math.max(72, 96 + (intensity * 0.55) + (72 * facing));
        var sizeNdcX = (pxSize / Math.max(1, width));
        var sizeNdcY = (pxSize / Math.max(1, height));
        var dx = (ndc[0] * 0.5 * width);
        var dy = (-ndc[1] * 0.5 * height);
        var axisAngle = Math.atan2(dy, dx);
        instances.push(
          ndc[0], ndc[1], sizeNdcX, sizeNdcY,
          Number((light.color_f32 || [1, 1, 1, 1])[0]), Number((light.color_f32 || [1, 1, 1, 1])[1]), Number((light.color_f32 || [1, 1, 1, 1])[2]), 1.0,
          pxSize, flareAlpha, facing, 1.0,
          Math.cos(axisAngle), Math.sin(axisAngle), 0.0, 0.0
        );
      }
      var count = instances.length / 16;
      if (!count) { return; }
      var instData = new Float32Array(instances);
      var needBytes = instData.byteLength;
      if (!this._flareInstBuf || this._flareInstBufSize < needBytes) {
        if (this._flareInstBuf) { try { this._flareInstBuf.destroy(); } catch (_) {} }
        this._flareInstBuf = this._device.createBuffer({
          size: Math.max(needBytes, 256),
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
        });
        this._flareInstBufSize = Math.max(needBytes, 256);
      }
      this._device.queue.writeBuffer(this._flareInstBuf, 0, instData);
      var flarePass = enc.beginRenderPass({
        colorAttachments: [{
          view: this._msaaTex.createView(),
          resolveTarget: resolveTargetView || this._ctx.getCurrentTexture().createView(),
          loadOp: "load",
          storeOp: "store"
        }]
      });
      flarePass.setPipeline(sharedWgpu.pipeFlare);
      flarePass.setVertexBuffer(0, sharedWgpu.flareQuadBuf);
      flarePass.setVertexBuffer(1, this._flareInstBuf);
      flarePass.draw(4, count, 0, 0);
      flarePass.end();
    },

    _frame: function (t) {
      var self = this;
      if (!self._running) { return; }
      try {
        self._renderContent(t);
      } catch (e) {
        var msg = "frame: " + (e && e.message ? e.message : e);
        self._runtimeError = msg;
        wlog("error", msg);
        try {
          if (typeof global.__vfGeomRuntimeErrorHandler === "function") {
            global.__vfGeomRuntimeErrorHandler(msg);
          }
        } catch (_) {}
        self._running = false;
        return;
      }
      self._raf = requestAnimationFrame(function (t2) { self._frame(t2); });
    },

    start: function () {
      if (this._running) { return; }
      this._runtimeError = "";
      this._running = true;
      var self = this;
      self._raf = requestAnimationFrame(function (t) { self._frame(t); });
    },

    stop: function () {
      this._running = false;
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    },

    destroy: function () {
      this.stop();
      this._lastMesh = null;
      this._lastMeshRevision = -1;
      if (this._resizeRaf) { cancelAnimationFrame(this._resizeRaf); this._resizeRaf = 0; }
      this._destroyParts();
      if (this._vb)        { try { this._vb.destroy(); } catch(_){} this._vb = null; }
      if (this._ib)        { try { this._ib.destroy(); } catch(_){} this._ib = null; }
      if (this._depthTex)  { try { this._depthTex.destroy(); } catch(_){} this._depthTex = null; }
      if (this._frameColorTex) { try { this._frameColorTex.destroy(); } catch(_){} this._frameColorTex = null; }
      if (this._frameSceneColorTex) { try { this._frameSceneColorTex.destroy(); } catch(_){} this._frameSceneColorTex = null; }
      this._frameColorView = null;
      this._frameSceneColorView = null;
      this._frameBlitBindGroup = null;
      this._frameBlitSourceView = null;
      if (this._uniformBuf){ try { this._uniformBuf.destroy(); } catch(_){} this._uniformBuf = null; }
      if (this._flareInstBuf){ try { this._flareInstBuf.destroy(); } catch(_){} this._flareInstBuf = null; this._flareInstBufSize = 0; }
      if (this._shadowDepthTex0) { try { this._shadowDepthTex0.destroy(); } catch(_){} this._shadowDepthTex0 = null; }
      if (this._shadowDepthTex1) { try { this._shadowDepthTex1.destroy(); } catch(_){} this._shadowDepthTex1 = null; }
      this._shadowDepthView0 = null;
      this._shadowDepthView1 = null;
      if (this._ctx)       { try { this._ctx.unconfigure(); } catch(_){} }
      if (this._pickTex)      { try { this._pickTex.destroy();      } catch(_){} this._pickTex      = null; }
      if (this._pickDepthTex) { try { this._pickDepthTex.destroy(); } catch(_){} this._pickDepthTex = null; }
      if (this._pickUb)       { try { this._pickUb.destroy();       } catch(_){} this._pickUb       = null; }
      if (this._pickReadBuf)  { try { this._pickReadBuf.destroy();  } catch(_){} this._pickReadBuf  = null; }
    },

    onResize: function () {
      var self = this;
      if (self._resizeRaf) { cancelAnimationFrame(self._resizeRaf); }
      self._resizeRaf = requestAnimationFrame(function () {
        self._resizeRaf = 0;
        if (!self._running || !self._device || !self._vb || !self._ib) { return; }
        self._ensureDepth();
        self._ensurePickTextures();
        try { self._renderContent(performance.now()); } catch(e) {}
      });
    },
  };

  VfGeomWgpu.prototype.init = async function () {
    var c = this._canvas;
    var sg;
    try { sg = await getSharedWgpu(); }
    catch (e) { wlog("error", "init: " + (e && e.message ? e.message : e)); return false; }
    if (!sg) { return false; }
    this._device     = sg.device;
    this._format     = sg.format;
    this._bindLayout = sg.bindLayout;
    this._pipeTri    = sg.pipeTri;
    this._pipeLine   = sg.pipeLine;
    this._pipeTriAlpha = sg.pipeTriAlpha || null;
    this._pipeTriAlphaDepth = sg.pipeTriAlphaDepth || null;
    this._pipeTriMultiply = sg.pipeTriMultiply || null;
    this._pipeTriAdditive = sg.pipeTriAdditive || null;
    this._pipeSphereInst = sg.pipeSphereInst || null;
    this._pipeCylinderInst = sg.pipeCylinderInst || null;
    this._pipePointImpostor = sg.pipePointImpostor || null;
    this._pipeLineImpostor = sg.pipeLineImpostor || null;
    this._ctx = c.getContext("webgpu");
    if (!this._ctx) { wlog("error", "getContext('webgpu') null"); return false; }
    try {
      this._ctx.configure({ device: this._device, format: this._format, alphaMode: "premultiplied" });
    } catch (e) {
      wlog("error", "configure alphaMode=premultiplied failed: " + (e && e.message ? e.message : e));
      return false;
    }
    try {
      this._uniformBuf = this._device.createBuffer({
        size: UB_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this._bindGroup = this._device.createBindGroup({
        layout: this._bindLayout,
        entries: [
          { binding: 0, resource: { buffer: this._uniformBuf } },
          { binding: 1, resource: sg.surfaceSampler },
          { binding: 2, resource: sg.defaultSurfaceView },
          { binding: 3, resource: sg.shadowSampler },
          { binding: 4, resource: sg.defaultShadowView },
          { binding: 5, resource: sg.defaultShadowView }
        ],
      });
      this._ensureDepth();
      this._ensurePickTextures();
      wlog("info", "init OK " + c.width + "x" + c.height + " objectId=" + this._objectId);
      return true;
    } catch (e3) {
      wlog("error", "init buf: " + (e3 && e3.message ? e3.message : e3));
      return false;
    }
  };

  VfGeomWgpu.__vfRuntimeAssetVersion = RUNTIME_ASSET_VERSION;
  global.VfGeomWgpu    = VfGeomWgpu;
  global.VfGeomWgpuUtil = {
    __vfRuntimeAssetVersion: RUNTIME_ASSET_VERSION,
    parseColor: parseColor,
    LIGHT_MODELS: LIGHT_MODELS,
    getSharedWgpu: getSharedWgpu,
    createPlanarMirrorAdapter: createPlanarMirrorAdapter,
    derivePlanarSurfaceLocalFrame: derivePlanarSurfaceLocalFrame,
    createPlanarMirrorRuntime: createPlanarMirrorRuntime,
    resolvePlanarMirrorGeometry: resolvePlanarMirrorGeometry,
    surfaceLocalBounds: surfaceLocalBounds,
    derivePlanarSurfaceWorldFrame: derivePlanarSurfaceWorldFrame
  };
})(typeof window !== "undefined" ? window : this);

