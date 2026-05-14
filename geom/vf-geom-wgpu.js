/**
 * WebGPU renderer: packed vertex layout pos(3)+normal(3)+color(4) = 10 f32 = 40 bytes/vertex.
 * Lighting models: flat (unlit), lambert (diffuse), blinn_phong (diffuse+specular).
 * Camera and lights are passed in from mesh.camera / mesh.lights.
 * Depends: vf-geom-math.js (VfGeomMath)
 */
(function (global) {
  "use strict";

  function wlog(level, text) {
    var s = "[vf-geom-wgpu] " + String(text);
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

  // ---------------------------------------------------------------------------
  // Shader — supports flat / lambert / blinn_phong via light_model uniform
  // Vertex layout: pos(3) + normal(3) + color(4) — 10 f32 = 40 bytes stride
  // ---------------------------------------------------------------------------
  var SHADER = `
struct Scene {
  mvp        : mat4x4<f32>,   // 64 bytes  offset 0
  model      : mat4x4<f32>,   // 64 bytes  offset 64
  cam_pos    : vec3<f32>,     // 12 bytes  offset 128
  _pad0      : f32,           // 4 bytes   offset 140
  light_pos  : vec3<f32>,     // 12 bytes  offset 144
  _pad1      : f32,           // 4 bytes   offset 156
  light_color: vec4<f32>,     // 16 bytes  offset 160
  // 0=flat, 1=lambert, 2=blinn_phong
  light_model: u32,           // 4 bytes   offset 176
  _pad2      : u32,
  _pad3      : u32,
  _pad4      : u32,           // total 192 bytes (12 * 16)
}
@group(0) @binding(0) var<uniform> sc: Scene;

struct Vin {
  @location(0) pos   : vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color : vec4<f32>,
}
struct Vout {
  @builtin(position) clip    : vec4<f32>,
  @location(0)       color   : vec4<f32>,
  @location(1)       world_pos: vec3<f32>,
  @location(2)       normal  : vec3<f32>,
}

@vertex
fn vs(v: Vin) -> Vout {
  var o: Vout;
  let wp = (sc.model * vec4f(v.pos, 1.0)).xyz;
  o.clip      = sc.mvp * vec4f(wp, 1.0);
  o.color     = v.color;
  o.world_pos = wp;
  // normal in world space (assumes uniform scale)
  o.normal = normalize((sc.model * vec4f(v.normal, 0.0)).xyz);
  return o;
}

@fragment
fn fs(i: Vout) -> @location(0) vec4f {
  let base = i.color.rgb;
  let a    = i.color.a;
  let t    = a;
  let N    = normalize(i.normal);
  let L    = normalize(sc.light_pos - i.world_pos);
  let V    = normalize(sc.cam_pos   - i.world_pos);
  let lc   = sc.light_color.rgb;

  if (sc.light_model == 0u) {
    // flat — vertex color only, no lighting
    return vec4f(base * t, a);
  } else if (sc.light_model == 1u) {
    // lambert — ambient + diffuse
    let ambient  = 0.28 * base;
    let diff     = max(dot(N, L), 0.0);
    let diffuse  = diff * lc * base;
    let lit = ambient + diffuse;
    return vec4f(lit * t, a);
  } else {
    // blinn_phong — ambient + diffuse + specular
    let ambient  = 0.28 * base;
    let diff     = max(dot(N, L), 0.0);
    let diffuse  = diff * lc * base;
    let H        = normalize(L + V);
    let spec     = pow(max(dot(N, H), 0.0), 64.0);
    // For translucent surfaces, reduce mirror-like highlights more aggressively.
    // Without this, stacked alpha layers can look overly bright.
    let specular = spec * lc * (0.5 * a);
    let lit = (ambient + diffuse) * t + specular;
    return vec4f(lit, a);
  }
}
`;


  // ---------------------------------------------------------------------------
  // Picking shader — writes object_id + primitive index to rg32uint texture
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
fn fs_pick(@builtin(primitive_index) prim_index: u32) -> @location(0) vec2<u32> {
  return vec2<u32>(pk.object_id, prim_index);
}
`;

  var PICK_UB_SIZE = 144; // 16+16 f32 + 4 u32 = 128+16 = 144 bytes

  var M = null;
  function getMath() {
    if (!M) { M = global.VfGeomMath; }
    if (!M) { throw new Error("VfGeomMath not loaded"); }
    return M;
  }

  // Uniform buffer: 192 bytes
  var UB_SIZE = 192;

  // light_model name -> int
  var LIGHT_MODELS = { flat: 0, lambert: 1, blinn_phong: 2, phong: 2 };

  // ---------------------------------------------------------------------------
  // Shared device (one per page; requestDevice() limit in WebView2)
  // ---------------------------------------------------------------------------
  var sharedWgpu = null;
  var sharedWgpuPromise = null;

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
        var mod = device.createShaderModule({ code: SHADER });

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

        var bindLayout = device.createBindGroupLayout({
          entries: [{
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" },
          }],
        });
        var plLayout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });

        var makeDesc = function (topo, cullMode, transparent) {
          var targets = [{ format: format }];
          if (transparent) {
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
            vertex:   { module: mod, entryPoint: "vs", buffers: [vbufDesc] },
            fragment: { module: mod, entryPoint: "fs", targets: targets },
            primitive: { topology: topo },
            depthStencil: {
              depthWriteEnabled: transparent ? false : true,
              depthCompare: "less",
              format: "depth24plus",
            },
          };
          if (cullMode) { d.primitive.cullMode = cullMode; }
          return d;
        };

        var pipeTri, pipeLine, pipeTriAlpha;
        if (typeof device.createRenderPipelineAsync === "function") {
          pipeTri  = await device.createRenderPipelineAsync(makeDesc("triangle-list"));
          pipeLine = await device.createRenderPipelineAsync(makeDesc("line-list"));
          pipeTriAlpha = await device.createRenderPipelineAsync(makeDesc("triangle-list", null, true));
        } else {
          pipeTri  = device.createRenderPipeline(makeDesc("triangle-list"));
          pipeLine = device.createRenderPipeline(makeDesc("line-list"));
          pipeTriAlpha = device.createRenderPipeline(makeDesc("triangle-list", null, true));
        }
        // Picking pipeline — writes rg32uint (object_id, prim_index)
        var pickMod = device.createShaderModule({ code: PICK_SHADER });
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
        var pipePick;
        if (typeof device.createRenderPipelineAsync === "function") {
          pipePick = await device.createRenderPipelineAsync(pickPipeDesc);
        } else {
          pipePick = device.createRenderPipeline(pickPipeDesc);
        }
        sharedWgpu = { device, format, bindLayout, pipeTri, pipeLine, pipeTriAlpha, pipePick, pickBindLayout };
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
  // Build scene uniform buffer (192 bytes)
  // ---------------------------------------------------------------------------
  function buildUniform(mvp, model, camera, lights, lightModel) {
    var buf = new ArrayBuffer(UB_SIZE);
    var f32 = new Float32Array(buf);
    var u32 = new Uint32Array(buf);

    // mvp (16 f32 @ offset 0)
    for (var i = 0; i < 16; i++) { f32[i] = mvp[i]; }
    // model (16 f32 @ offset 16)
    for (var i = 0; i < 16; i++) { f32[16 + i] = model[i]; }

    // cam_pos (3 f32 @ offset 32)
    f32[32] = camera[0]; f32[33] = camera[1]; f32[34] = camera[2]; f32[35] = 0;

    // light_pos (3 f32 @ offset 36)
    var lp = lights && lights.length ? lights[0].pos : [0, 10, 10];
    f32[36] = lp[0]; f32[37] = lp[1]; f32[38] = lp[2]; f32[39] = 0;

    // light_color (4 f32 @ offset 40)
    var lc = lights && lights.length ? lights[0].color_f32 : [1, 1, 1, 1];
    f32[40] = lc[0]; f32[41] = lc[1]; f32[42] = lc[2]; f32[43] = lc[3];

    // light_model (u32 @ offset 44)
    u32[44] = lightModel;

    return f32;
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

  // ---------------------------------------------------------------------------
  // VfGeomWgpu — one renderer per canvas
  // ---------------------------------------------------------------------------
  function vec3Sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vec3Add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function vec3Scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function vec3Dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vec3Cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function vec3Norm(a) {
    var l = Math.sqrt(vec3Dot(a, a));
    return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
  }
  function clipPlaneIntersection(a, da, b, db) {
    var t = da / (da - db);
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
  }
  function pushUniquePoint(points, p) {
    for (var i = 0; i < points.length; i++) {
      var q = points[i];
      var dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
      if (dx * dx + dy * dy + dz * dz < 1e-8) { return; }
    }
    points.push(p);
  }
  function appendNearPlaneVolumeCaps(mesh, camPos, camTarget, camUp, near) {
    if (!mesh || mesh.topology !== "triangle-list") { return mesh; }
    var ranges = Array.isArray(mesh.solid_volume_ranges) ? mesh.solid_volume_ranges.slice() : [];
    if (mesh.solid_volume) { ranges.push({ start: 0, count: mesh.indices.length }); }
    if (!ranges.length) { return mesh; }

    var fwd = vec3Norm(vec3Sub(camTarget, camPos));
    if (vec3Dot(fwd, fwd) < 1e-12) { return mesh; }
    var capNear = (near || 0.05) + 0.0004;
    var planePoint = vec3Add(camPos, vec3Scale(fwd, capNear));
    var right = vec3Norm(vec3Cross(fwd, camUp || [0, 1, 0]));
    if (vec3Dot(right, right) < 1e-12) { right = [1, 0, 0]; }
    var up = vec3Norm(vec3Cross(right, fwd));
    var verts = mesh.vertices;
    var inds = mesh.indices;
    var stride = 10;
    var capVerts = [];
    var capIdx = [];

    for (var ri = 0; ri < ranges.length; ri++) {
      var r = ranges[ri];
      var start = Math.max(0, Number(r.start) || 0);
      var end = Math.min(inds.length, start + (Number(r.count) || 0));
      var points = [];
      for (var ii = start; ii + 2 < end; ii += 3) {
        var ia = inds[ii] * stride, ib = inds[ii + 1] * stride, ic = inds[ii + 2] * stride;
        var a = [verts[ia], verts[ia + 1], verts[ia + 2]];
        var b = [verts[ib], verts[ib + 1], verts[ib + 2]];
        var c = [verts[ic], verts[ic + 1], verts[ic + 2]];
        var da = vec3Dot(vec3Sub(a, planePoint), fwd);
        var db = vec3Dot(vec3Sub(b, planePoint), fwd);
        var dc = vec3Dot(vec3Sub(c, planePoint), fwd);
        if ((da < 0 && db >= 0) || (da >= 0 && db < 0)) { pushUniquePoint(points, clipPlaneIntersection(a, da, b, db)); }
        if ((db < 0 && dc >= 0) || (db >= 0 && dc < 0)) { pushUniquePoint(points, clipPlaneIntersection(b, db, c, dc)); }
        if ((dc < 0 && da >= 0) || (dc >= 0 && da < 0)) { pushUniquePoint(points, clipPlaneIntersection(c, dc, a, da)); }
      }
      if (points.length < 3) { continue; }
      var center = [0, 0, 0];
      for (var pi = 0; pi < points.length; pi++) { center = vec3Add(center, points[pi]); }
      center = vec3Scale(center, 1 / points.length);
      points.sort(function (p, q) {
        var px = vec3Dot(vec3Sub(p, center), right), py = vec3Dot(vec3Sub(p, center), up);
        var qx = vec3Dot(vec3Sub(q, center), right), qy = vec3Dot(vec3Sub(q, center), up);
        return Math.atan2(py, px) - Math.atan2(qy, qx);
      });
      var base = (verts.length + capVerts.length) / stride;
      var rgbaOff = (inds[start] || 0) * stride + 6;
      var cr = verts[rgbaOff] || 1, cg = verts[rgbaOff + 1] || 0, cb = verts[rgbaOff + 2] || 0, ca = verts[rgbaOff + 3] || 1;
      capVerts.push(center[0], center[1], center[2], -fwd[0], -fwd[1], -fwd[2], cr, cg, cb, ca);
      for (var pj = 0; pj < points.length; pj++) {
        var p = points[pj];
        capVerts.push(p[0], p[1], p[2], -fwd[0], -fwd[1], -fwd[2], cr, cg, cb, ca);
      }
      for (var tj = 0; tj < points.length; tj++) {
        capIdx.push(base, base + 1 + ((tj + 1) % points.length), base + 1 + tj);
      }
    }
    if (!capIdx.length) { return mesh; }
    var outVerts = new Float32Array(verts.length + capVerts.length);
    outVerts.set(verts, 0);
    outVerts.set(capVerts, verts.length);
    var outIdx = new Uint32Array(inds.length + capIdx.length);
    outIdx.set(inds, 0);
    outIdx.set(capIdx, inds.length);
    var out = {};
    for (var k in mesh) { out[k] = mesh[k]; }
    out.vertices = outVerts;
    out.indices = outIdx;
    return out;
  }

  function VfGeomWgpu(canvas, getMeshFn) {
    this._canvas     = canvas;
    this._getMesh    = getMeshFn;
    this._device     = null;
    this._ctx        = null;
    this._format     = null;
    this._pipeTri    = null;
    this._pipeLine   = null;
    this._pipeTriAlpha = null;
    this._bindLayout = null;
    this._depthTex   = null;
    this._uniformBuf = null;
    this._bindGroup  = null;
    this._vb         = null;
    this._ib         = null;
    this._ibCount    = 0;
    this._topology   = "triangle-list";
    this._lastMesh   = null;
    this._depthW     = 0;
    this._depthH     = 0;
    this._running    = false;
    this._raf        = 0;
    this._resizeRaf  = 0;
    // Picking
    this._objectId      = 0;       // set by display.js before init
    this._pickTex       = null;    // rg32uint render target
    this._pickDepthTex  = null;
    this._pickUb        = null;    // picking uniform buffer (PICK_UB_SIZE bytes)
    this._pickBG        = null;    // picking bind group
    this._pickReadBuf   = null;    // 8-byte mapAsync readback buffer
    this._pickW         = 0;
    this._pickH         = 0;
    this._pickPending   = false;   // readback in flight
    this._pickCallback  = null;    // fn(object_id, simplex_id, x, y) called after readback
    // Hit-map readback (for native overlay pass-through)
    this._hitMapBuf     = null;
    this._hitMapW       = 0;
    this._hitMapH       = 0;
    this._hitMapPending = false;
    this._hitMapFrame   = 0;
    this._hitMapInterval= 6;
    this._lastHitJson   = null;
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
      // Readback buffer: 1 pixel of rg32uint = 2×u32 = 8 bytes.
      // Align to 256 bytes (WebGPU bytesPerRow minimum).
      if (this._pickReadBuf) { try { this._pickReadBuf.destroy(); } catch(_){} }
      this._pickReadBuf = this._device.createBuffer({
        size: 256,   // bytesPerRow must be ≥ 256
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

    /** Ask for the object_id + simplex_id at canvas pixel (cx, cy).
     *  cb(object_id, simplex_id, cx, cy) called asynchronously (next frame). */
    pickAt: function (cx, cy, cb) {
      if (this._pickPending || !this._device || !this._pickTex || !this._pickReadBuf) { return; }
      var self = this;
      var px = Math.max(0, Math.min(this._pickW - 1, Math.floor(cx)));
      var py = Math.max(0, Math.min(this._pickH - 1, Math.floor(cy)));
      this._pickPending = true;
      /* Safety: if mapAsync never resolves (GPU lost, validation error etc.) unlock after 500ms. */
      var safetyTimer = setTimeout(function () {
        if (self._pickPending) {
          wlog("warn", "pickAt: timed out, resetting _pickPending");
          self._pickPending = false;
          self._pickCallback = null;
          self._pendingPickPx = null;
        }
      }, 500);
      // Schedule readback on the next rendered frame
      this._pickCallback = function() {
        var buf = self._pickReadBuf;
        buf.mapAsync(GPUMapMode.READ).then(function() {
          clearTimeout(safetyTimer);
          var u32 = new Uint32Array(buf.getMappedRange(0, 8));
          var oid = u32[0], sid = u32[1];
          buf.unmap();
          self._pickPending = false;
          if (cb) { cb(oid, sid, cx, cy); }
        }).catch(function(e) {
          clearTimeout(safetyTimer);
          wlog("warn", "pickAt mapAsync failed: " + (e && e.message ? e.message : e));
          self._pickPending = false;
        });
        self._pickCallback = null;
      };
      this._pendingPickPx = [px, py];
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
      });
    },

    _uploadMesh: function (mesh) {
      if (!mesh || !this._device) { return; }
      var dev = this._device;
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
      var camEarly = mesh.camera || {};
      var posEarly = camEarly.pos || [0, 0, 5];
      var targetEarly = camEarly.target || [0, 0, 0];
      var upEarly = camEarly.up || [0, 1, 0];
      mesh = appendNearPlaneVolumeCaps(mesh, posEarly, targetEarly, upEarly, 0.05);
      if (mesh !== this._lastMesh) { this._lastMesh = mesh; this._uploadMesh(mesh); }
      if (!this._vb || !this._ib) { return; }

      var Mm    = getMath();
      var w     = this._canvas.width;
      var h     = this._canvas.height;
      var asp   = w / Math.max(1, h);

      // --- Camera ---
      var cam   = mesh.camera || {};
      var pos   = cam.pos    || posEarly;
      var target= cam.target || targetEarly;
      var fov   = cam.fov    !== undefined ? cam.fov : 45;
      var up    = cam.up     || upEarly;

      var projMat, viewMat, mvp, modelMat;
      // Compute model matrix live from mesh data so rotation/center/scale
      // changes applied after init() are always reflected correctly.
      if (mesh.center !== undefined || mesh.rotation !== undefined || mesh.scale !== undefined) {
        modelMat = Mm.mat4ModelTRS
          ? Mm.mat4ModelTRS(mesh.center, mesh.rotation, mesh.scale)
          : (mesh._modelMatrix || Mm.mat4Identity());
      } else {
        modelMat = mesh._modelMatrix || Mm.mat4Identity();
      }

      if (mesh.mode3d === false) {
        // 2D ortho — ignore camera
        projMat = Mm.mat4OrthoZ01(-1, 1, -1, 1, 0, 1);
        mvp     = projMat;
      } else {
        var fovRad = fov * Math.PI / 180;
        projMat  = Mm.mat4PerspectiveZ01(fovRad, asp, 0.05, 500);
        if (!mesh.camera) {
          pos      = [0, 0, 5];
          target   = [0, 0, 0];
          up       = [0, 1, 0];
          viewMat  = mat4LookAt(pos, target, up);
        } else {
          viewMat = mat4LookAt(pos, target, up);
        }
        mvp = Mm.mat4Mul(projMat, viewMat);
      }

      // --- Lights ---
      var rawLights = mesh.lights || [];
      var lightsNorm = rawLights.map(function (l) {
        return {
          pos:      l.pos      || [0, 10, 10],
          color_f32: parseColor(l.color || "white"),
          model:    l.model    || "blinn_phong",
        };
      });
      if (!lightsNorm.length) {
        lightsNorm = [{ pos: [0, 10, 10], color_f32: [1,1,1,1], model: "blinn_phong" }];
      }
      var lmName = lightsNorm[0].model || "blinn_phong";
      var lmInt  = LIGHT_MODELS[lmName] !== undefined ? LIGHT_MODELS[lmName] : 2;

      // --- Build + upload uniform ---
      var ub = buildUniform(mvp, modelMat, pos, lightsNorm, lmInt);
      this._device.queue.writeBuffer(this._uniformBuf, 0, ub);

      // --- Draw ---
      this._ensureDepth();
      var enc  = this._device.createCommandEncoder();
      var pass = enc.beginRenderPass({
        colorAttachments: [{
          view:       this._ctx.getCurrentTexture().createView(),
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
      var isTransparent = !!mesh.transparent && this._topology === "triangle-list";
      var pipe = this._topology === "line-list"
        ? this._pipeLine
        : (isTransparent && this._pipeTriAlpha ? this._pipeTriAlpha : this._pipeTri);
      pass.setPipeline(pipe);
      pass.setBindGroup(0, this._bindGroup);
      pass.setVertexBuffer(0, this._vb);
      pass.setIndexBuffer(this._ib, "uint32");
      pass.drawIndexed(this._ibCount, 1, 0, 0, 0);
      pass.end();
      this._device.queue.submit([enc.finish()]);

      // ── Picking pass (triangle-list only, skips wireframe) ────────────────
      var sg2 = sharedWgpu;
      if (sg2 && sg2.pipePick && this._pickTex && this._topology === "triangle-list") {
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

        var pickEnc  = this._device.createCommandEncoder();
        var pickPass = pickEnc.beginRenderPass({
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
          pickEnc.copyTextureToBuffer(
            { texture: this._pickTex, origin: { x: ppx[0], y: ppx[1], z: 0 }, mipLevel: 0 },
            { buffer: this._pickReadBuf, offset: 0, bytesPerRow: 256 },
            { width: 1, height: 1, depthOrArrayLayers: 1 }
          );
        }
        this._device.queue.submit([pickEnc.finish()]);

        // Fire the callback after submit (readback is now in flight)
        if (this._pickCallback) { this._pickCallback(); }

        // Hit-map readback for native overlay pass-through (throttled).
        // Skip the frame where a pickAt callback just fired to avoid two
        // simultaneous copyTextureToBuffer submits on the same texture.
        this._hitMapFrame++;
        if (this._hitMapFrame >= this._hitMapInterval && !this._hitMapPending && !this._pickCallback) {
          this._hitMapFrame = 0;
          this._ensureHitMapBuf();
          this._scheduleHitMapReadback();
        }
      }
    },

    /* Ensure a GPUBuffer large enough to read back the full picking texture.
       rg32uint = 8 bytes/pixel, bytesPerRow must be a multiple of 256. */
    _ensureHitMapBuf: function () {
      var c = this._canvas;
      var w = Math.max(1, c.width);
      var h = Math.max(1, c.height);
      var bpr = Math.ceil(w * 8 / 256) * 256;
      var needed = bpr * h;
      if (this._hitMapBuf && this._hitMapW === w && this._hitMapH === h) { return; }
      if (this._hitMapBuf) { try { this._hitMapBuf.destroy(); } catch(_){} }
      this._hitMapBuf = this._device.createBuffer({
        size: needed,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      this._hitMapW = w;
      this._hitMapH = h;
    },

    /* Read back the picking texture, derive coarse 16-px-tile hit rects,
       merge with VfFrame panel rects, and post to native via postNativeHostLayout.
       Alpha ≥ 0.05 → interactive. Here: any picked pixel (object_id > 0) → interactive. */
    _scheduleHitMapReadback: function () {
      if (this._hitMapPending || !this._device || !this._pickTex || !this._hitMapBuf) { return; }
      var self = this;
      var w = this._hitMapW;
      var h = this._hitMapH;
      var bpr = Math.ceil(w * 8 / 256) * 256;
      var enc = this._device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: this._pickTex, origin: { x: 0, y: 0, z: 0 }, mipLevel: 0 },
        { buffer: this._hitMapBuf, offset: 0, bytesPerRow: bpr, rowsPerImage: h },
        { width: w, height: h, depthOrArrayLayers: 1 }
      );
      this._device.queue.submit([enc.finish()]);
      this._hitMapPending = true;
      this._hitMapBuf.mapAsync(GPUMapMode.READ).then(function () {
        try {
          var mapped = self._hitMapBuf.getMappedRange();
          var u32    = new Uint32Array(mapped);
          var TILE   = 16;
          var canvas = self._canvas;
          var cw = canvas.width, ch = canvas.height;
          var cr = canvas.getBoundingClientRect();
          var scaleX = cr.width  / cw;
          var scaleY = cr.height / ch;
          var cols   = Math.ceil(cw / TILE);
          var rows   = Math.ceil(ch / TILE);
          var bprU32 = bpr / 4;
          var occupied = new Uint8Array(rows * cols);
          for (var ty = 0; ty < rows; ty++) {
            for (var tx = 0; tx < cols; tx++) {
              var px0 = tx * TILE, py0 = ty * TILE;
              var px1 = Math.min(cw, px0 + TILE);
              var py1 = Math.min(ch, py0 + TILE);
              done: for (var py = py0; py < py1; py++) {
                var rowOff = py * bprU32;
                for (var px = px0; px < px1; px++) {
                  if (u32[rowOff + px * 2] !== 0) {  // object_id (first u32 of rg32uint)
                    occupied[ty * cols + tx] = 1;
                    break done;
                  }
                }
              }
            }
          }
          // Row-span merge → rects in CSS/DIP space
          var rects = [];
          for (var ty = 0; ty < rows; ty++) {
            var inSpan = false, spanStart = 0;
            for (var tx = 0; tx <= cols; tx++) {
              var occ = tx < cols ? occupied[ty * cols + tx] : 0;
              if (occ && !inSpan)  { inSpan = true; spanStart = tx; }
              else if (!occ && inSpan) {
                inSpan = false;
                rects.push({
                  left:   Math.round(cr.left + spanStart * TILE * scaleX),
                  top:    Math.round(cr.top  + ty        * TILE * scaleY),
                  right:  Math.round(cr.left + tx        * TILE * scaleX),
                  bottom: Math.round(cr.top  + (ty + 1)  * TILE * scaleY),
                });
              }
            }
          }
          self._hitMapBuf.unmap();
          self._hitMapPending = false;
          // Merge panel (VfFrame) hit regions too
          var panelRects = [];
          var doc = canvas.ownerDocument;
          var layer = (canvas.closest ? canvas.closest("#layer") : null) ||
                      (doc ? doc.getElementById("layer") : null);
          if (layer) {
            var nodes = layer.querySelectorAll(".vf-frame:not(.vf-frame--pass-through)");
            for (var i = 0; i < nodes.length; i++) {
              var el = nodes[i];
              if (!(el instanceof HTMLElement)) { continue; }
              var er = el.getBoundingClientRect();
              if (er.width < 1 || er.height < 1) { continue; }
              panelRects.push({
                left: Math.round(er.left), top: Math.round(er.top),
                right: Math.round(er.right), bottom: Math.round(er.bottom),
              });
            }
          }
          var allRects = rects.concat(panelRects);
          if (typeof VfFrame !== "undefined" && typeof VfFrame.postNativeHostLayout === "function") {
            var json = JSON.stringify(allRects);
            if (json !== self._lastHitJson) {
              self._lastHitJson = json;
              VfFrame.postNativeHostLayout(layer, { stageAlpha: 0, hitRegions: allRects });
            }
          }
        } catch (e) {
          try { self._hitMapBuf.unmap(); } catch(_) {}
          self._hitMapPending = false;
          wlog("warn", "hitMapReadback: " + (e && e.message ? e.message : e));
        }
      }).catch(function (e) {
        self._hitMapPending = false;
        wlog("warn", "hitMapReadback mapAsync: " + (e && e.message ? e.message : e));
      });
    },

    _frame: function (t) {
      var self = this;
      if (!self._running) { return; }
      try {
        self._renderContent(t);
      } catch (e) {
        wlog("error", "frame: " + (e && e.message ? e.message : e));
      }
      self._raf = requestAnimationFrame(function (t2) { self._frame(t2); });
    },

    start: function () {
      if (this._running) { return; }
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
      if (this._resizeRaf) { cancelAnimationFrame(this._resizeRaf); this._resizeRaf = 0; }
      if (this._vb)        { try { this._vb.destroy(); } catch(_){} this._vb = null; }
      if (this._ib)        { try { this._ib.destroy(); } catch(_){} this._ib = null; }
      if (this._depthTex)  { try { this._depthTex.destroy(); } catch(_){} this._depthTex = null; }
      if (this._uniformBuf){ try { this._uniformBuf.destroy(); } catch(_){} this._uniformBuf = null; }
      if (this._ctx)       { try { this._ctx.unconfigure(); } catch(_){} }
      if (this._pickTex)      { try { this._pickTex.destroy();      } catch(_){} this._pickTex      = null; }
      if (this._pickDepthTex) { try { this._pickDepthTex.destroy(); } catch(_){} this._pickDepthTex = null; }
      if (this._pickUb)       { try { this._pickUb.destroy();       } catch(_){} this._pickUb       = null; }
      if (this._pickReadBuf)  { try { this._pickReadBuf.destroy();  } catch(_){} this._pickReadBuf  = null; }
      if (this._hitMapBuf)    { try { this._hitMapBuf.destroy();    } catch(_){} this._hitMapBuf    = null; }
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
        entries: [{ binding: 0, resource: { buffer: this._uniformBuf } }],
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

  global.VfGeomWgpu    = VfGeomWgpu;
  global.VfGeomWgpuUtil = { parseColor: parseColor, LIGHT_MODELS: LIGHT_MODELS };
})(typeof window !== "undefined" ? window : this);
