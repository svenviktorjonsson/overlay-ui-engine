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

  function wlog(level, text) {
    var s = "[vf-geom-wgpu] " + String(text);
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

  function dbgNum(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) { return String(value); }
    return n.toFixed(4);
  }

  function dbgVec(value) {
    if (!value || typeof value.length !== "number") { return "[]"; }
    var out = [];
    for (var i = 0; i < value.length; i += 1) {
      out.push(dbgNum(value[i]));
    }
    return "[" + out.join(",") + "]";
  }

  function mirrorDebugLog(key, message, intervalMs) {
    try {
      var now = Date.now();
      if (!global.__vfMirrorDebugLast) { global.__vfMirrorDebugLast = Object.create(null); }
      var last = Number(global.__vfMirrorDebugLast[key] || 0);
      if (now - last < Math.max(0, Number(intervalMs || 1000))) { return; }
      global.__vfMirrorDebugLast[key] = now;
      wlog("warn", "[DEBUG-mirror-norm] " + String(message));
    } catch (_) {}
  }

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
          normalizeVec3(subVec3(surfaceCamera.target, surfaceCamera.pos), [0, 1, 0])
        );
        var near = 0.05;
        var far = 500.0;
        var eye = vec3Or(surfaceCamera.pos, [0.0, 0.0, 0.0]);
        var mirrorCorners = mirrorWorldCorners(plane);
        var basis = orientMirrorBasisForEye(mirrorCorners, eye);
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
        var currentWidth = Math.abs(right - left);
        var currentHeight = Math.abs(top - bottom);
        var currentAspect = currentWidth / Math.max(1e-6, currentHeight);
        if (Math.abs(currentAspect - targetAspect) > 1e-6) {
          if (currentAspect < targetAspect) {
            var cx = 0.5 * (left + right);
            var halfW = 0.5 * currentHeight * targetAspect;
            left = cx - halfW;
            right = cx + halfW;
          } else {
            var cy = 0.5 * (bottom + top);
            var halfH = 0.5 * currentWidth / targetAspect;
            bottom = cy - halfH;
            top = cy + halfH;
          }
        }
        var returnedUp = basis.up.slice();
        var returnedForward = scaleVec3(basis.backward, -1.0);
        if (Math.abs(dotVec3(returnedForward, returnedUp)) > 0.999) {
          returnedUp = orthogonalUnitVector(returnedForward);
        }
        var target = addVec3(eye, returnedForward);
        var view = mat4FromCameraBasis(eye, basis.right, basis.up, basis.backward);
        var projection = mat4FrustumOffCenterZ01(left, right, bottom, top, near, far);
        var viewProjection = math.mat4Mul(projection, view);
        return {
          pos: eye.slice(),
          target: target.slice(),
          up: returnedUp,
          fov: Number(surfaceCamera.fov == null ? 45.0 : surfaceCamera.fov) || 45.0,
          view_matrix: Array.prototype.slice.call(view),
          projection_matrix: Array.prototype.slice.call(projection),
          _mirrorViewProjection: Array.prototype.slice.call(viewProjection),
          _mirrorFlipU: true,
          _mirrorFlipV: false,
          _mirrorDebug: {
            planePoint: plane.point.slice(),
            planeNormal: plane.normal.slice(),
            frustum: { left: left, right: right, bottom: bottom, top: top, screenDistance: screenDistance }
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
          normalizeVec3(subVec3(surfaceCamera.target, surfaceCamera.pos), [0, 1, 0])
        );
        var near = 0.05;
        var far = 500.0;
        var reflectedPos = reflectPointAcrossPlane(surfaceCamera.pos, plane.point, plane.normal);
        var reflectedTarget = reflectPointAcrossPlane(surfaceCamera.target, plane.point, plane.normal);
        var reflectedUp = normalizeVec3(reflectDirAcrossPlane(surfaceCamera.up || [0, 0, 1], plane.normal), [0, 0, 1]);
        var mirrorCorners = mirrorWorldCorners(plane);
        var basis = orientMirrorBasisForEye(mirrorCorners, reflectedPos);
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
        var reflectedForward = scaleVec3(basis.backward, -1.0);
        var returnedUp = basis.up.slice();
        if (Math.abs(dotVec3(reflectedForward, returnedUp)) > 0.999) {
          returnedUp = orthogonalUnitVector(reflectedForward);
        }
        var returnedTarget = addVec3(reflectedPos, reflectedForward);
        var view = mat4FromCameraBasis(reflectedPos, basis.right, basis.up, basis.backward);
        var projection = mat4FrustumOffCenterZ01(left, right, bottom, top, near, far);
        var clipNormalWorld = plane.normal.slice();
        if (dotVec3(clipNormalWorld, subVec3(reflectedPos, plane.point)) > 0.0) {
          clipNormalWorld = scaleVec3(clipNormalWorld, -1.0);
        }
        var clipPlaneCamera = planeEquationInCameraSpace(view, plane.point, clipNormalWorld);
        projection = applyObliqueNearPlaneZ01(projection, clipPlaneCamera);
        var viewProjection = math.mat4Mul(projection, view);
        return {
          pos: reflectedPos,
          target: returnedTarget,
          up: returnedUp,
          fov: Number(surfaceCamera.fov == null ? 45.0 : surfaceCamera.fov) || 45.0,
          view_matrix: Array.prototype.slice.call(view),
          projection_matrix: Array.prototype.slice.call(projection),
          _mirrorViewProjection: Array.prototype.slice.call(viewProjection),
          _mirrorFlipU: true,
          _mirrorFlipV: false,
          _mirrorDebug: {
            planePoint: plane.point.slice(),
            planeNormal: plane.normal.slice(),
            reflectedTarget: reflectedTarget.slice(),
            clipPlaneCamera: clipPlaneCamera.slice(),
            frustum: { left: left, right: right, bottom: bottom, top: top, screenDistance: screenDistance }
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
  shadow0_count: u32,         // 4 bytes   offset 284
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
}
@group(0) @binding(0) var<uniform> sc: Scene;
@group(0) @binding(1) var surfaceSampler: sampler;
@group(0) @binding(2) var surfaceTex: texture_2d<f32>;

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

fn cross2(a: vec2<f32>, b: vec2<f32>, p: vec2<f32>) -> f32 {
  return ((b.x - a.x) * (p.y - a.y)) - ((b.y - a.y) * (p.x - a.x));
}

fn shadowPoint0(idx: u32) -> vec2<f32> {
  return sc.shadow0_pts[idx].xy;
}

fn shadowPoint1(idx: u32) -> vec2<f32> {
  return sc.shadow1_pts[idx].xy;
}

fn edgeOcclusion(side: f32, edgeLen: f32, softness: f32) -> f32 {
  let sd = side / max(edgeLen, 1e-6);
  if (softness <= 1e-6) {
    return select(0.0, 1.0, sd >= 0.0);
  }
  return smoothstep(-softness, softness, sd);
}

fn shadowOcclusion0(p: vec2<f32>) -> f32 {
  if (sc.shadow0_count < 3u) {
    return 0.0;
  }
  var occ = 1.0;
  for (var i: u32 = 0u; i < sc.shadow0_count; i = i + 1u) {
    let a = shadowPoint0(i);
    let b = shadowPoint0((i + 1u) % sc.shadow0_count);
    let side = cross2(a, b, p);
    let edgeLen = length(b - a);
    occ = occ * edgeOcclusion(side, edgeLen, sc.shadow0_softness);
  }
  return occ;
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
  if (kindCode < 0.5) {
    return 1.0;
  }
  let c = dot(normalize(coneDir), normalize(pointDir));
  let inner = max(innerCos, outerCos);
  let outer = min(innerCos, outerCos);
  return smoothstep(outer, inner, c);
}

fn shadowOcclusion1(p: vec2<f32>) -> f32 {
  if (sc.shadow1_count < 3u) {
    return 0.0;
  }
  var occ = 1.0;
  for (var i: u32 = 0u; i < sc.shadow1_count; i = i + 1u) {
    let a = shadowPoint1(i);
    let b = shadowPoint1((i + 1u) % sc.shadow1_count);
    let side = cross2(a, b, p);
    let edgeLen = length(b - a);
    occ = occ * edgeOcclusion(side, edgeLen, sc.shadow1_softness);
  }
  return occ;
}

fn checkerValue(p: vec2<f32>) -> f32 {
  let cell = floor(p.x) + floor(p.y);
  return abs(cell - (2.0 * floor(cell * 0.5)));
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
  let dx = dpdx(uv);
  let dy = dpdy(uv);
  return max(max(length(dx), length(dy)), 1e-5);
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
    let spot0 = spotlightFactor(sc.light0_dir_intensity.xyz, -L0, sc.light0_spot_params.x, sc.light0_spot_params.y, sc.light0_spot_params.w);
    let diff0 = max(dot(facingNormal, L0), 0.0);
    diffuse += (atten0 * spot0 * diff0) * sc.light0_color.rgb * baseColor;
    if (diff0 > 0.0) {
      let half0 = normalize(L0 + viewDir);
      let spec0 = pow(max(dot(facingNormal, half0), 0.0), 28.0);
      specular += (atten0 * spot0 * spec0) * sc.light0_color.rgb * 0.22;
    }
  }
  if (sc.light_count > 1u) {
    let toLight1 = sc.light1_pos - hitPos;
    let dist1 = max(length(toLight1), 1e-6);
    let L1 = toLight1 / dist1;
    let atten1 = lightAttenuation(dist1, sc.light1_dir_intensity.w, sc.light1_spot_params.z);
    let spot1 = spotlightFactor(sc.light1_dir_intensity.xyz, -L1, sc.light1_spot_params.x, sc.light1_spot_params.y, sc.light1_spot_params.w);
    let diff1 = max(dot(facingNormal, L1), 0.0);
    diffuse += (atten1 * spot1 * diff1) * sc.light1_color.rgb * baseColor;
    if (diff1 > 0.0) {
      let half1 = normalize(L1 + viewDir);
      let spec1 = pow(max(dot(facingNormal, half1), 0.0), 28.0);
      specular += (atten1 * spot1 * spec1) * sc.light1_color.rgb * 0.22;
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
  let viewerDirWorld = normalize(sc.cam_pos - worldPos);
  let reverseFacing = sc.texture_params.w > 0.5;
  let facing = dot(normalize(hostNormal), viewerDirWorld) * select(1.0, -1.0, reverseFacing);
  if (facing <= 1e-4) {
    return base;
  }
  if (sc.texture_params.x > 4.5) {
    let clip = sc.surface_projector * vec4f(worldPos, 1.0);
    if (abs(clip.w) <= 1e-5) {
      return vec3<f32>(0.0, 0.0, 0.0);
    }
    let ndc = clip.xyz / clip.w;
    if (ndc.z < -1e-4 || ndc.z > 1.0001) {
      return vec3<f32>(0.0, 0.0, 0.0);
    }
    var mirrorUv = vec2<f32>(
      (ndc.x * 0.5) + 0.5,
      1.0 - ((ndc.y * 0.5) + 0.5)
    );
    let mirrorFlipCode = i32(sc.texture_params.w + 0.5);
    if ((mirrorFlipCode & 1) != 0) {
      mirrorUv.x = 1.0 - mirrorUv.x;
    }
    if ((mirrorFlipCode & 2) != 0) {
      mirrorUv.y = 1.0 - mirrorUv.y;
    }
    if (mirrorUv.x < -1e-4 || mirrorUv.x > 1.0001 || mirrorUv.y < -1e-4 || mirrorUv.y > 1.0001) {
      return vec3<f32>(0.0, 0.0, 0.0);
    }
    mirrorUv = clamp(mirrorUv, vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0));
    let mirrorColor = textureSampleLevel(surfaceTex, surfaceSampler, mirrorUv, 0.0);
    return mirrorColor.rgb;
  }
    var uv = vec2<f32>(
      clamp(surfaceUv.x, 0.0, 1.0),
      clamp(surfaceUv.y, 0.0, 1.0)
    );
  let sampleColor = textureSampleLevel(surfaceTex, surfaceSampler, uv, 0.0);
  if (sc.texture_params.x > 3.5) {
    return sampleColor.rgb;
  }
  return mix(contentBg, sampleColor.rgb, clamp(sampleColor.a, 0.0, 1.0));
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
  if (kindCode > 4.5) {
    return surfaceWorldSceneColor(base, localPos, worldPos, normal, surfaceProjPos, false);
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

@fragment
fn fs(i: Vout) -> @location(0) vec4f {
  let base = proceduralTexture(i.color.rgb, i.local_pos, i.world_pos, i.normal, i.surface_proj_pos);
  let a    = i.color.a * sc.alpha_mul;
  if (sc.texture_params.x > 3.5) {
    return vec4f(base, 1.0);
  }
  let t    = a;
  let V    = normalize(sc.cam_pos   - i.world_pos);
  var N    = normalize(i.normal);
  let backfaceSpecularOff = sc.surface_cam_up_pad.w > 0.5;
  let facing = dot(N, V);
  let suppressSpecular = backfaceSpecularOff && facing < 0.0;
  if (!suppressSpecular && facing < 0.0) {
    N = -N;
  }

  var diffuse = vec3f(0.0, 0.0, 0.0);
  var specular = vec3f(0.0, 0.0, 0.0);
  if (sc.light_count > 0u) {
    let occ0 = shadowOcclusion0(i.world_pos.xy);
    let vis0 = 1.0 - occ0;
    let toLight0 = sc.light0_pos - i.world_pos;
    let dist0 = max(length(toLight0), 1e-6);
    let L0 = toLight0 / dist0;
    let lc0 = sc.light0_color.rgb;
    let atten0 = lightAttenuation(dist0, sc.light0_dir_intensity.w, sc.light0_spot_params.z);
    let spot0 = spotlightFactor(sc.light0_dir_intensity.xyz, -L0, sc.light0_spot_params.x, sc.light0_spot_params.y, sc.light0_spot_params.w);
    let litScale0 = vis0 * atten0 * spot0;
    let diff0 = max(dot(N, L0), 0.0);
    diffuse += (litScale0 * diff0) * lc0 * base;
    if (!suppressSpecular) {
      let H0 = normalize(L0 + V);
      let spec0 = pow(max(dot(N, H0), 0.0), 40.0);
      specular += (litScale0 * spec0) * lc0 * (1.8 * a);
    }
  }
  if (sc.light_count > 1u) {
    let occ1 = shadowOcclusion1(i.world_pos.xy);
    let vis1 = 1.0 - occ1;
    let toLight1 = sc.light1_pos - i.world_pos;
    let dist1 = max(length(toLight1), 1e-6);
    let L1 = toLight1 / dist1;
    let lc1 = sc.light1_color.rgb;
    let atten1 = lightAttenuation(dist1, sc.light1_dir_intensity.w, sc.light1_spot_params.z);
    let spot1 = spotlightFactor(sc.light1_dir_intensity.xyz, -L1, sc.light1_spot_params.x, sc.light1_spot_params.y, sc.light1_spot_params.w);
    let litScale1 = vis1 * atten1 * spot1;
    let diff1 = max(dot(N, L1), 0.0);
    diffuse += (litScale1 * diff1) * lc1 * base;
    if (!suppressSpecular) {
      let H1 = normalize(L1 + V);
      let spec1 = pow(max(dot(N, H1), 0.0), 40.0);
      specular += (litScale1 * spec1) * lc1 * (1.8 * a);
    }
  }
  if (sc.light_count == 0u) {
    return vec4f(base, a);
  }
  let ambient2 = 0.10 * base;
  let lit2 = (ambient2 + diffuse) * t + specular;
  return vec4f(lit2, a);
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

  function screenEdgeFadeNdc(ndcX, ndcY) {
    var edge = Math.max(Math.abs(Number(ndcX)), Math.abs(Number(ndcY)));
    return 1.0 - smoothstep(0.72, 1.0, edge);
  }

  // Uniform buffer: scene + shadows + procedural texture params.
  var UB_SIZE = 14336;

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
            }
          ],
        });
        var plLayout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
        var flareLayout = device.createPipelineLayout({ bindGroupLayouts: [] });

        var makeDesc = function (topo, cullMode, transparent, vertexEntry, buffers, blendMode) {
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
            fragment: { module: mod, entryPoint: "fs", targets: targets },
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

        var pipeTri, pipeLine, pipeTriAlpha, pipeTriAlphaDepth, pipeTriMultiply, pipeTriAdditive, pipeSphereInst, pipeCylinderInst, pipeFlare;
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
          pipeSphereInst, pipeCylinderInst, pipeFlare, flareQuadBuf,
          surfaceSampler, defaultSurfaceView,
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
    var shadowHulls = meshLike && Array.isArray(meshLike.shadow_hulls)
      ? meshLike.shadow_hulls
      : [Array.isArray(meshLike && meshLike.shadow_hull) ? meshLike.shadow_hull : []];
    var shadowSoftnesses = meshLike && Array.isArray(meshLike.shadow_softnesses)
      ? meshLike.shadow_softnesses
      : [Number(meshLike && meshLike.shadow_softness) || 0.0];
    var shadowHull0 = Array.isArray(shadowHulls[0]) ? shadowHulls[0] : [];
    var shadowHull1 = Array.isArray(shadowHulls[1]) ? shadowHulls[1] : [];
    var shadowCount0 = Math.min(MAX_SHADOW_POINTS, shadowHull0.length);
    var shadowCount1 = Math.min(MAX_SHADOW_POINTS, shadowHull1.length);
    u32[71] = shadowCount0;
    u32[72] = shadowCount1;
    f32[73] = Math.max(0.0, Number(shadowSoftnesses[0]) || 0.0);
    f32[74] = Math.max(0.0, Number(shadowSoftnesses[1]) || 0.0);
    for (var si = 0; si < shadowCount0; si += 1) {
      var p = shadowHull0[si];
      var base = 76 + (si * 4);
      f32[base] = Number(p[0]) || 0;
      f32[base + 1] = Number(p[1]) || 0;
      f32[base + 2] = 0;
      f32[base + 3] = 0;
    }
    for (var sj = 0; sj < shadowCount1; sj += 1) {
      var p1 = shadowHull1[sj];
      var base1 = 76 + (MAX_SHADOW_POINTS * 4) + (sj * 4);
      f32[base1] = Number(p1[0]) || 0;
      f32[base1 + 1] = Number(p1[1]) || 0;
      f32[base1 + 2] = 0;
      f32[base1 + 3] = 0;
    }
    var surfaceSystem = meshLike && meshLike.surface_system && typeof meshLike.surface_system === "object"
      ? meshLike.surface_system
      : null;
    var texture = meshLike && meshLike.texture && typeof meshLike.texture === "object"
      ? meshLike.texture
      : null;
    var textureKind = 0.0;
    var surfaceTextureReady = textureKind > 3.5 && meshLike && meshLike._surfaceTextureReady === true;
    if (surfaceSystem) {
      var surfaceKind = String(surfaceSystem.kind || "").toLowerCase().trim();
      var runtimeTextureReady = surfaceSystem._runtime_texture_ready !== false;
      if (surfaceKind === "screen" && runtimeTextureReady) {
        textureKind = 4.0;
      } else if (surfaceKind === "mirror") {
        textureKind = 5.0;
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
      if (surfaceSystem && String(surfaceSystem.kind || "").toLowerCase().trim() === "screen") {
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
        ? (systemWorld && systemWorld.background ? systemWorld.background : [0.98, 0.98, 1.0, 1.0])
        : (texture && texture.color_a ? texture.color_a : [0.18, 0.22, 0.30, 1.0])
    );
    var cb = parseColor(
      textureKind > 3.5
        ? (systemWorld && systemWorld.frame_color ? systemWorld.frame_color : [0.05, 0.05, 0.07, 1.0])
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
      if (textureKind > 3.5 && textureKind < 4.5 && surfaceSystem && surfaceSystem.reverse_facing === true) {
        f32[343] = 1.0;
      }
      if (textureKind > 4.5) {
        var mirrorFlipCode = 0.0;
        if (surfaceSystem && surfaceSystem._renderFlipU === true) { mirrorFlipCode += 1.0; }
        if (surfaceSystem && surfaceSystem._renderFlipV === true) { mirrorFlipCode += 2.0; }
        f32[343] = mirrorFlipCode;
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
      f32[351] = 0.0;
      f32[352] = Number(surfaceBounds.vAxis && surfaceBounds.vAxis[0] || 0.0);
      f32[353] = Number(surfaceBounds.vAxis && surfaceBounds.vAxis[1] || 0.0);
      f32[354] = Number(surfaceBounds.vAxis && surfaceBounds.vAxis[2] || 0.0);
      f32[355] = meshLike && meshLike.no_backface_specular === true ? 1.0 : 0.0;
      if (textureKind > 4.5) {
        mirrorDebugLog(
          "attach-" + String(meshLike && meshLike.id || "surface"),
          "attach shader=viewport-mirror textureKind=" + dbgNum(textureKind) +
            " id=" + String(meshLike && meshLike.id || "surface") +
            " bounds=[min=" + dbgVec([surfaceBounds.minX, surfaceBounds.minY]) +
            " span=" + dbgVec([surfaceBounds.spanX, surfaceBounds.spanY]) + "]" +
            " flipViewportX=" + String(surfaceSystem && surfaceSystem._renderFlipU === true) +
            " sample=reflected-viewport ready=" + String(surfaceTextureReady),
          1000
        );
      }
      if (textureKind > 4.5) {
        if (!surfaceSystem || !Array.isArray(surfaceSystem._renderViewProjection) || surfaceSystem._renderViewProjection.length !== 16) {
          failFast("mirror surface_system requires a projective view-projection matrix");
        }
      }
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
    var projector = textureKind > 4.5 && surfaceSystem && Array.isArray(surfaceSystem._renderViewProjection)
      ? surfaceSystem._renderViewProjection
      : null;
    for (var pi = 0; pi < 16; pi += 1) {
      f32[projectorBase + pi] = projector ? Number(projector[pi] || 0.0) : (pi % 5 === 0 ? 1.0 : 0.0);
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
    if (!meshLike || String(meshLike.kind || "").toLowerCase().trim() !== "quad") {
      return null;
    }
    var size = meshLike.size;
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

  function orientMirrorBasisForEye(corners, eye) {
    var bottomLeft = corners.bottomLeft;
    var bottomRight = corners.bottomRight;
    var topLeft = corners.topLeft;
    var topRight = corners.topRight;
    var right = normalizeVec3(subVec3(bottomRight, bottomLeft), [1.0, 0.0, 0.0]);
    var up = normalizeVec3(subVec3(topLeft, bottomLeft), [0.0, 1.0, 0.0]);
    var backward = normalizeVec3(crossVec3(right, up), [0.0, 0.0, 1.0]);
    if (dotVec3(backward, subVec3(eye, bottomLeft)) < 0.0) {
      bottomLeft = corners.bottomRight;
      bottomRight = corners.bottomLeft;
      topLeft = corners.topRight;
      right = normalizeVec3(subVec3(bottomRight, bottomLeft), [1.0, 0.0, 0.0]);
      up = normalizeVec3(subVec3(topLeft, bottomLeft), [0.0, 1.0, 0.0]);
      backward = normalizeVec3(crossVec3(right, up), [0.0, 0.0, 1.0]);
    }
    return {
      bottomLeft: bottomLeft,
      bottomRight: bottomRight,
      topLeft: topLeft,
      right: right,
      up: up,
      backward: backward
    };
  }

  function derivePlanarSurfaceLocalFrame(meshLike) {
    return derivePlanarFrameFromPoints(planarPointsFromMeshVertices(meshLike, null));
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
    var points = null;
    if (meshLike && meshLike.vertices && meshLike.vertices.length >= 30) {
      points = planarPointsFromMeshVertices(meshLike, modelMatrix);
    } else {
      points = planarPointsFromQuadSpec(meshLike, modelMatrix);
    }
    if (!Array.isArray(points) || points.length < 3) {
      failFast("mirror surface_system host mesh requires planar vertices or a quad spec");
    }
    var frame = derivePlanarFrameFromPoints(points);
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

  function logMirrorIntersectionLine(viewProjection, frame, flipU, key, intervalMs) {
    if (!frame || !Array.isArray(frame.point) || !Array.isArray(frame.uAxis) || !Array.isArray(frame.vAxis)) { return; }
    var minU = Number(frame.minU || 0.0);
    var maxU = Number(frame.maxU == null ? (minU + Number(frame.spanU || 0.0)) : frame.maxU);
    var minV = Number(frame.minV || 0.0);
    var p0 = addVec3(frame.point, addVec3(scaleVec3(frame.uAxis, minU), scaleVec3(frame.vAxis, minV)));
    var p1 = addVec3(frame.point, addVec3(scaleVec3(frame.uAxis, (minU + maxU) * 0.5), scaleVec3(frame.vAxis, minV)));
    var p2 = addVec3(frame.point, addVec3(scaleVec3(frame.uAxis, maxU), scaleVec3(frame.vAxis, minV)));
    var s0 = projectMirrorWorldPointToUv(viewProjection, p0, flipU);
    var s1 = projectMirrorWorldPointToUv(viewProjection, p1, flipU);
    var s2 = projectMirrorWorldPointToUv(viewProjection, p2, flipU);
    mirrorDebugLog(
      key,
      "[DEBUG-a4f2-line] p0=" + dbgVec(p0) +
        " uv0=" + dbgVec(s0 && s0.uv || []) +
        " ndc0=" + dbgVec(s0 && s0.ndc || []) +
        " p1=" + dbgVec(p1) +
        " uv1=" + dbgVec(s1 && s1.uv || []) +
        " ndc1=" + dbgVec(s1 && s1.ndc || []) +
        " p2=" + dbgVec(p2) +
        " uv2=" + dbgVec(s2 && s2.uv || []) +
        " ndc2=" + dbgVec(s2 && s2.ndc || []),
      intervalMs
    );
  }

  function normalizeLightKind(kind) {
    var raw = String(kind == null ? "point" : kind).toLowerCase().trim();
    if (raw === "spotlight") { return "spot"; }
    if (raw !== "point" && raw !== "spot") { return "point"; }
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
    var hasOrbit = light.orbit === true ||
      light.orbit_radius !== undefined ||
      light.angular_velocity !== undefined ||
      light.theta !== undefined;
    if (!hasOrbit) {
      return vec3Or(light.pos, [0, 10, 10]);
    }
    var radius = Number(light.orbit_radius);
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
      target[1] + height,
      target[2] + Math.sin(angle) * radius,
    ];
  }

  function normalizeLight(light, t) {
    light = light || {};
    var pos = resolveLightPosition(light, t);
    var kind = normalizeLightKind(light.kind);
    var intensity = clampPositiveNumber(light.intensity != null ? light.intensity : light.power, 24.0);
    var range = clampPositiveNumber(light.range, 0.0);
    var innerRad = radiansFromDegrees(light.inner_cone_deg, 14.0);
    var outerRad = radiansFromDegrees(light.outer_cone_deg, 22.0);
    return {
      pos: pos,
      target: vec3Or(light.target, [0, 0, 0]),
      color_f32: parseColor(light.color || "white"),
      model: light.model || "blinn_phong",
      intensity: intensity,
      direction_f32: resolveLightDirection(light, pos),
      kind: kind,
      kind_code: kind === "spot" ? 1.0 : 0.0,
      inner_cone_cos: Math.cos(Math.min(innerRad, outerRad)),
      outer_cone_cos: Math.cos(Math.max(innerRad, outerRad)),
      range: range,
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
    if (meshLike && String(meshLike.kind || "").toLowerCase().trim() === "quad") {
      var rawSize = meshLike.size;
      var sx = 0.0;
      var sy = 0.0;
      if (Array.isArray(rawSize)) {
        sx = Number(rawSize[0] || 0.0);
        sy = Number(rawSize[1] || 0.0);
      } else {
        sx = Number(rawSize || 0.0);
        sy = Number(rawSize || 0.0);
      }
      var halfX = Math.max(1e-4, sx * 0.5);
      var halfY = Math.max(1e-4, sy * 0.5);
      return {
        minX: -halfX,
        minY: -halfY,
        spanX: halfX * 2.0,
        spanY: halfY * 2.0,
        uAxis: [1.0, 0.0, 0.0],
        vAxis: [0.0, 1.0, 0.0]
      };
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
        failFast("pickAt called while previous GPU pick is pending; caller must serialize pick requests");
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
          failFastAsync("GPU pick readback timed out");
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
          failFastAsync("GPU pick readback failed: " + (e && e.message ? e.message : e));
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
      if (part.bindGroup && part._boundSurfaceView === surfaceView) { return; }
      part.bindGroup = this._device.createBindGroup({
        layout: this._bindLayout,
        entries: [
          { binding: 0, resource: { buffer: part.uniformBuf } },
          { binding: 1, resource: sharedWgpu.surfaceSampler },
          { binding: 2, resource: surfaceView }
        ]
      });
      part._boundSurfaceView = surfaceView;
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

    _mirrorTargetDimsForPart: function (part, frameWidth, frameHeight) {
      var dims = createPlanarMirrorAdapter().targetDims(frameWidth, frameHeight, part);
      if (
        !dims ||
        !(Number(dims.width || 0) > 0) ||
        !(Number(dims.height || 0) > 0)
      ) {
        failFast("mirror targetDims must return positive width and height");
      }
      return liveSurfaceTargetDims(dims.width, dims.height);
    },

    _buildPlanarSurfaceRenderCamera: function (part, surfaceCamera, t, targetAspect) {
      return createPlanarMirrorAdapter().buildRenderCamera({
        part: part,
        surfaceCamera: surfaceCamera,
        timeMs: t,
        targetAspect: targetAspect,
        math: getMath()
      });
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
      var rawLightsPart = partMesh.lights || sceneMesh.lights || [];
      var lightsNormPart = rawLightsPart.map(function (l) { return normalizeLight(l, t); });
      var lmNamePart = partMesh.light_model || sceneMesh.light_model || (lightsNormPart[0] && lightsNormPart[0].model) || "blinn_phong";
      var lmIntPart = LIGHT_MODELS[lmNamePart] !== undefined ? LIGHT_MODELS[lmNamePart] : 2;
      var ubPart = buildUniform(mvpPart, modelMatPart, posPart, lightsNormPart, lmIntPart, resolveAlphaMul(partMesh), partMesh);
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
                  isAdditivePart && this._pipeTriAdditive ? this._pipeTriAdditive :
                  isMultiplyPart && this._pipeTriMultiply ? this._pipeTriMultiply :
                  part.topology === "line-list"
                    ? this._pipeLine
                    : (
                        useTransparentDepthPart && this._pipeTriAlphaDepth ? this._pipeTriAlphaDepth :
                        (isTransparentPart && this._pipeTriAlpha ? this._pipeTriAlpha : this._pipeTri)
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
      for (var partIndex = 0; partIndex < this._parts.length; partIndex++) {
        var part = this._parts[partIndex];
        var partMesh = part && part.mesh;
        if (!partMesh) { continue; }
        if (omitObjectId && Number(part.objectId || 0) === Number(omitObjectId || 0)) { continue; }
        if (skipSurfaceParts && partMesh.surface_system) { continue; }
        if (skipOverlayExpanded && partMesh.overlay_expanded === true) { continue; }
        this._drawSingleScenePart(pass, sceneMesh, part, t, aspect, overrideCamera || null, MmBatch, width, height);
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
      var cameraForBuild = camera && typeof camera === "object"
        ? Object.assign({}, camera, {
            viewport_height_px: Math.max(1, Number(viewportHeightPx || camera.viewport_height_px || 0) || 1)
          })
        : null;
      var rebuilt = new Array(sourceSpecs.length);
      for (var i = 0; i < sourceSpecs.length; i += 1) {
        var sourceSpec = sourceSpecs[i];
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
        if (surfaceKind !== "screen" && surfaceKind !== "mirror") {
          partMesh._surfaceTextureReady = false;
          part.surfaceExternalView = null;
          part.surfaceColorView = null;
          this._ensurePartBindGroup(part);
          continue;
        }
        if (surfaceKind === "screen" && surfaceSystem && String(surfaceSystem.frame_ref || "").trim()) {
          var sourceFrameId = String(surfaceSystem.frame_ref || "").trim();
          var frameRenderers = global.__vfFrameRenderers && typeof global.__vfFrameRenderers === "object"
            ? global.__vfFrameRenderers
            : null;
          var sourceRenderer = frameRenderers ? frameRenderers[sourceFrameId] : null;
          if (!sourceRenderer || typeof sourceRenderer._debugGetFrameTextureRef !== "function") {
            failFast('screen surface_system frame_ref "' + sourceFrameId + '" has no live frame renderer');
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
          this._ensurePartBindGroup(part);
          continue;
        }
        if (surfaceKind === "screen") {
          surfaceSystem._runtime_texture_ready = true;
        }
        part.surfaceExternalView = null;
        var targetDims = surfaceKind === "mirror"
          ? this._mirrorTargetDimsForPart(part, width, height)
          : this._surfaceTargetDimsForPart(part, width, height);
        var surfaceCamera = surfaceSystem.camera && typeof surfaceSystem.camera === "object"
          ? surfaceSystem.camera
          : (sceneMesh.camera || null);
        var renderCamera = surfaceCamera;
        if (surfaceKind === "mirror") {
          renderCamera = sceneMesh.camera || surfaceCamera;
          if (!renderCamera || !Array.isArray(renderCamera.pos)) {
            failFast("mirror surface_system requires the active scene camera");
          }
          renderCamera = this._buildPlanarSurfaceRenderCamera(part, renderCamera, t, targetDims.width / Math.max(1, targetDims.height));
          surfaceSystem._renderFlipU = renderCamera._mirrorFlipU === true;
          surfaceSystem._renderFlipV = renderCamera._mirrorFlipV === true;
          surfaceSystem._renderViewProjection = renderCamera._mirrorViewProjection;
          try {
            var mirrorFrame = derivePlanarSurfaceWorldFrame(part, t, getMath());
            logMirrorIntersectionLine(
              renderCamera._mirrorViewProjection,
              mirrorFrame,
              renderCamera._mirrorFlipU === true,
              "a4f2-mirror-line-" + String(partMesh && partMesh.id || "surface"),
              250
            );
          } catch (_) {}
          mirrorDebugLog(
            "a4f2-mirror-camera-" + String(partMesh && partMesh.id || "surface"),
            "[DEBUG-a4f2] mirror camera eye=" + dbgVec(renderCamera.pos || []) +
              " target=" + dbgVec(renderCamera.target || []) +
              " srcEye=" + dbgVec((sceneMesh.camera && sceneMesh.camera.pos) || []) +
              " srcTarget=" + dbgVec((sceneMesh.camera && sceneMesh.camera.target) || []) +
              " frustum=" + JSON.stringify(renderCamera._mirrorDebug && renderCamera._mirrorDebug.frustum || {}),
            250,
          );
        }
        var partBackups = null;
        if (surfaceKind === "mirror") {
          var rebuiltMeshes = this._rebuildUnifiedSourceMeshesForCamera(sceneMesh, renderCamera, targetDims.height);
          if (rebuiltMeshes) {
            partBackups = this._swapScenePartsMeshes(rebuiltMeshes);
          }
        }
        this._ensureSurfaceTarget(part, targetDims.width, targetDims.height);
        partMesh._surfaceTextureReady = true;
        var world = surfaceSystem.world && typeof surfaceSystem.world === "object" ? surfaceSystem.world : {};
        var bg = parseColor(world.background || [0.0, 0.0, 0.0, 1.0]);
        if (surfaceKind === "mirror" && !(bg[3] > 0.0)) {
          bg = [0.02, 0.025, 0.03, 1.0];
        }
        this._encodeScenePartsColorPass(
          enc,
          sceneMesh,
          t,
          part.surfaceW,
          part.surfaceH,
          part.surfaceMsaaTex.createView(),
          part.surfaceColorView,
          part.surfaceDepthTex.createView(),
          { r: bg[0], g: bg[1], b: bg[2], a: bg[3] },
          renderCamera,
          part.objectId,
          true,
          {}
        );
        if (partBackups) {
          this._restoreScenePartsMeshes(partBackups);
        }
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
        bindGroup: null,
        pickUb: pickUb,
        pickBg: pickBg,
        objectId: Number(mesh.object_id || (index + 1)) || (index + 1)
      };
    },

    _canReuseScenePart: function (part, mesh, index) {
      if (!part || !mesh) { return false; }
      if (!part.vb || !part.ib || !part.uniformBuf || !part.pickUb || !part.pickBg || !part.bindGroup) { return false; }
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
      var mesh = this._getMesh(t * 0.001);
      if (!mesh) { return; }
      var meshRevision = Number(mesh && mesh.__revision);
      if (mesh !== this._lastMesh || meshRevision !== this._lastMeshRevision) {
        this._lastMesh = mesh;
        this._lastMeshRevision = meshRevision;
        this._uploadMesh(mesh);
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
        var encBatch = this._device.createCommandEncoder();
        var sceneSourceBackups = this._swapSelfReferencedScreensToPlain(this._frameId);
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
          false
        );
        this._restoreScenePartsMeshes(sceneSourceBackups);
        this._renderSurfacePasses(encBatch, mesh, t, wBatch, hBatch);
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
        var sceneLights = (mesh.lights || []).map(function (l) { return normalizeLight(l, t); });
        this._drawGpuLightFlares(encBatch, mesh, sceneMvp, scenePos, sceneLights, wBatch, hBatch, this._frameColorView);

        var sgBatch = sharedWgpu;
        var pendingBatchPick = !!this._pendingPickPx;
        var fireBatchPickCallback = false;
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
          failFast("pending GPU pick request but pick pass is unavailable for scene parts");
        }
        this._blitFrameTargetToCanvas(encBatch, mesh);
        this._device.queue.submit([encBatch.finish()]);
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
        projMat = Mm.mat4OrthoZ01(-1, 1, -1, 1, 0, 1);
        mvp     = projMat;
      } else {
        var fovRad = fov * Math.PI / 180;
        projMat  = Mm.mat4PerspectiveZ01(fovRad, asp, 0.05, 500);
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
      var rawLights = mesh.lights || [];
      var lightsNorm = rawLights.map(function (l) { return normalizeLight(l, t); });
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
        failFast("pending GPU pick request but pick pass is unavailable for mesh");
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
        var lightPos = light.pos || [0, 0, 0];
        var ndc = projectWorldToNdc(mvp, lightPos);
        if (!ndc) { continue; }
        if (Math.abs(ndc[0]) > 1.02 || Math.abs(ndc[1]) > 1.02) { continue; }
        if (lightOccludedByBoxes(cameraPos, lightPos, occluders)) { continue; }
        var edgeFade = screenEdgeFadeNdc(ndc[0], ndc[1]);
        if (!(edgeFade > 0.001)) { continue; }
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
        var flareAlpha = Math.max(0.0, Math.min(1.0, baseAlpha * (0.30 + (0.70 * facing)) * edgeFade));
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
          pxSize, flareAlpha, facing, edgeFade,
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
    this._ctx = c.getContext("webgpu");
    if (!this._ctx) { wlog("error", "getContext('webgpu') null"); return false; }
    try {
      this._ctx.configure({ device: this._device, format: this._format, alphaMode: "premultiplied" });
    } catch (e) {
      try { this._ctx.configure({ device: this._device, format: this._format, alphaMode: "opaque" }); }
      catch (e2) { wlog("error", "configure failed: " + (e2 && e2.message ? e2.message : e2)); return false; }
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
          { binding: 2, resource: sg.defaultSurfaceView }
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
    surfaceLocalBounds: surfaceLocalBounds,
    derivePlanarSurfaceWorldFrame: derivePlanarSurfaceWorldFrame
  };
})(typeof window !== "undefined" ? window : this);
