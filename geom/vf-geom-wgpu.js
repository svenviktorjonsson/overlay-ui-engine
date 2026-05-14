/**
 * WebGPU renderer: packed vertex layout pos(3)+normal(3)+color(4) = 10 f32 = 40 bytes/vertex.
 * Lighting models: flat (unlit), lambert (diffuse), blinn_phong (diffuse+specular).
 * Camera and lights are passed in from mesh.camera / mesh.lights.
 * Depends: vf-geom-math.js (VfGeomMath)
 */
(function (global) {
  "use strict";

  var RUNTIME_ASSET_VERSION = String(global.__vfRuntimeAssetVersion || "");

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
  alpha_mul  : f32,           // 4 bytes   offset 180
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
  let a    = i.color.a * sc.alpha_mul;
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

  var PICK_UB_SIZE = 144; // 16+16 f32 + 4 u32 = 128+16 = 144 bytes
  var SAMPLE_COUNT = 4;

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
            multisample: { count: SAMPLE_COUNT },
            depthStencil: {
              depthWriteEnabled: transparent ? false : true,
              depthCompare: "less",
              format: "depth24plus",
            },
          };
          if (cullMode) { d.primitive.cullMode = cullMode; }
          return d;
        };

        var pipeTri, pipeLine, pipeTriAlpha, pipeTriAlphaDepth;
        if (typeof device.createRenderPipelineAsync === "function") {
          pipeTri  = await device.createRenderPipelineAsync(makeDesc("triangle-list"));
          pipeLine = await device.createRenderPipelineAsync(makeDesc("line-list"));
          pipeTriAlpha = await device.createRenderPipelineAsync(makeDesc("triangle-list", null, true));
          pipeTriAlphaDepth = await device.createRenderPipelineAsync({
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
        } else {
          pipeTri  = device.createRenderPipeline(makeDesc("triangle-list"));
          pipeLine = device.createRenderPipeline(makeDesc("line-list"));
          pipeTriAlpha = device.createRenderPipeline(makeDesc("triangle-list", null, true));
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
        sharedWgpu = { device, format, bindLayout, pipeTri, pipeLine, pipeTriAlpha, pipeTriAlphaDepth, pipePick, pickBindLayout };
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
  function buildUniform(mvp, model, camera, lights, lightModel, alphaMul) {
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
    f32[45] = Number(alphaMul);
    if (!Number.isFinite(f32[45])) { f32[45] = 1.0; }

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
    this._msaaTex    = null;
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
      }, 500);
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
      if (part.uniformBuf) { try { part.uniformBuf.destroy(); } catch(_){} }
      if (part.pickUb) { try { part.pickUb.destroy(); } catch(_){} }
    },

    _createScenePart: function (mesh, index) {
      var dev = this._device;
      var sg2 = sharedWgpu;
      var vb = dev.createBuffer({ size: mesh.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(vb, 0, mesh.vertices);
      var ib = dev.createBuffer({ size: mesh.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(ib, 0, mesh.indices);
      var uniformBuf = dev.createBuffer({
        size: UB_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      var bindGroup = dev.createBindGroup({
        layout: this._bindLayout,
        entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
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
        ibCount: mesh.indices.length,
        topology: mesh.topology || "triangle-list",
        uniformBuf: uniformBuf,
        bindGroup: bindGroup,
        pickUb: pickUb,
        pickBg: pickBg,
        objectId: Number(mesh.object_id || (index + 1)) || (index + 1)
      };
    },

    _canReuseScenePart: function (part, mesh, index) {
      if (!part || !mesh) { return false; }
      if (!part.vb || !part.ib || !part.uniformBuf || !part.pickUb || !part.pickBg || !part.bindGroup) { return false; }
      if ((part.topology || "triangle-list") !== (mesh.topology || "triangle-list")) { return false; }
      if (Number(part.objectId || 0) !== (Number(mesh.object_id || (index + 1)) || (index + 1))) { return false; }
      if (!part.mesh) { return false; }
      if (!part.mesh.vertices || !part.mesh.indices || !mesh.vertices || !mesh.indices) { return false; }
      if (part.mesh.vertices.byteLength !== mesh.vertices.byteLength) { return false; }
      if (part.mesh.indices.byteLength !== mesh.indices.byteLength) { return false; }
      return true;
    },

    _uploadSceneParts: function (scene) {
      if (!scene || !Array.isArray(scene.parts) || !this._device) { return; }
      var dev = this._device;
      var previousParts = Array.isArray(this._parts) ? this._parts : [];
      var nextParts = new Array(scene.parts.length);
      for (var i = 0; i < scene.parts.length; i++) {
        var mesh = scene.parts[i];
        if (!mesh) { continue; }
        var existing = previousParts[i];
        if (this._canReuseScenePart(existing, mesh, i)) {
          dev.queue.writeBuffer(existing.vb, 0, mesh.vertices);
          dev.queue.writeBuffer(existing.ib, 0, mesh.indices);
          existing.mesh = mesh;
          existing.ibCount = mesh.indices.length;
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
        if (!this._parts || !this._parts.length) { return; }
        var MmBatch = getMath();
        var wBatch = this._canvas.width;
        var hBatch = this._canvas.height;
        var aspBatch = wBatch / Math.max(1, hBatch);
        this._ensureDepth();
        this._ensureMsaaColor();
        var encBatch = this._device.createCommandEncoder();
        var passBatch = encBatch.beginRenderPass({
          colorAttachments: [{
            view: this._msaaTex.createView(),
            resolveTarget: this._ctx.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
          depthStencilAttachment: {
            view: this._depthTex.createView(),
            depthClearValue: 1,
            depthLoadOp: "clear",
            depthStoreOp: "store",
          },
        });
        for (var partIndex = 0; partIndex < this._parts.length; partIndex++) {
          var part = this._parts[partIndex];
          var partMesh = part.mesh;
          if (!partMesh || !part.vb || !part.ib) { continue; }
          var camPart = partMesh.camera || mesh.camera || {};
          var posPart = camPart.pos || [0, 0, 5];
          var targetPart = camPart.target || [0, 0, 0];
          var fovPart = camPart.fov !== undefined ? camPart.fov : 45;
          var upPart = camPart.up || [0, 1, 0];
          var projMatPart, viewMatPart, mvpPart, modelMatPart;
          if (partMesh.center !== undefined || partMesh.rotation !== undefined || partMesh.scale !== undefined) {
            modelMatPart = MmBatch.mat4ModelTRS
              ? MmBatch.mat4ModelTRS(partMesh.center, partMesh.rotation, partMesh.scale)
              : (partMesh._modelMatrix || MmBatch.mat4Identity());
          } else {
            modelMatPart = partMesh._modelMatrix || MmBatch.mat4Identity();
          }
          if (partMesh.mode3d === false) {
            projMatPart = MmBatch.mat4OrthoZ01(-1, 1, -1, 1, 0, 1);
            mvpPart = projMatPart;
          } else {
            var fovRadPart = fovPart * Math.PI / 180;
            projMatPart = MmBatch.mat4PerspectiveZ01(fovRadPart, aspBatch, 0.05, 500);
            if (!partMesh.camera && !mesh.camera) {
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
          var rawLightsPart = partMesh.lights || mesh.lights || [];
          var lightsNormPart = rawLightsPart.map(function (l) {
            return {
              pos: l.pos || [0, 10, 10],
              color_f32: parseColor(l.color || "white"),
              model: l.model || "blinn_phong",
            };
          });
          if (!lightsNormPart.length) {
            lightsNormPart = [{ pos: [0, 10, 10], color_f32: [1,1,1,1], model: "blinn_phong" }];
          }
          var lmNamePart = lightsNormPart[0].model || "blinn_phong";
          var lmIntPart = LIGHT_MODELS[lmNamePart] !== undefined ? LIGHT_MODELS[lmNamePart] : 2;
          var ubPart = buildUniform(mvpPart, modelMatPart, posPart, lightsNormPart, lmIntPart, resolveAlphaMul(partMesh));
          this._device.queue.writeBuffer(part.uniformBuf, 0, ubPart);
          var isTransparentPart = !!partMesh.transparent && part.topology === "triangle-list";
          var useTransparentDepthPart = isTransparentPart && !!partMesh.depth_write;
          var pipePart = part.topology === "line-list"
            ? this._pipeLine
            : (
                useTransparentDepthPart && this._pipeTriAlphaDepth ? this._pipeTriAlphaDepth :
                (isTransparentPart && this._pipeTriAlpha ? this._pipeTriAlpha : this._pipeTri)
              );
          passBatch.setPipeline(pipePart);
          passBatch.setBindGroup(0, part.bindGroup);
          passBatch.setVertexBuffer(0, part.vb);
          passBatch.setIndexBuffer(part.ib, "uint32");
          passBatch.drawIndexed(part.ibCount, 1, 0, 0, 0);
        }
        passBatch.end();

        var sgBatch = sharedWgpu;
        var pendingBatchPick = !!this._pendingPickPx;
        var fireBatchPickCallback = false;
        if (sgBatch && sgBatch.pipePick && this._pickTex) {
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
            if (pickMesh.center !== undefined || pickMesh.rotation !== undefined || pickMesh.scale !== undefined) {
              modelPick = MmBatch.mat4ModelTRS
                ? MmBatch.mat4ModelTRS(pickMesh.center, pickMesh.rotation, pickMesh.scale)
                : (pickMesh._modelMatrix || MmBatch.mat4Identity());
            } else {
              modelPick = pickMesh._modelMatrix || MmBatch.mat4Identity();
            }
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
      var ub = buildUniform(mvp, modelMat, pos, lightsNorm, lmInt, resolveAlphaMul(mesh));
      this._device.queue.writeBuffer(this._uniformBuf, 0, ub);
      // --- Draw ---
      this._ensureDepth();
      this._ensureMsaaColor();
      var enc  = this._device.createCommandEncoder();
      var pass = enc.beginRenderPass({
        colorAttachments: [{
          view:       this._msaaTex.createView(),
          resolveTarget: this._ctx.getCurrentTexture().createView(),
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
      var useTransparentDepth = isTransparent && !!mesh.depth_write;
      var pipe = this._topology === "line-list"
        ? this._pipeLine
        : (
            useTransparentDepth && this._pipeTriAlphaDepth ? this._pipeTriAlphaDepth :
            (isTransparent && this._pipeTriAlpha ? this._pipeTriAlpha : this._pipeTri)
          );
      pass.setPipeline(pipe);
      pass.setBindGroup(0, this._bindGroup);
      pass.setVertexBuffer(0, this._vb);
      pass.setIndexBuffer(this._ib, "uint32");
      pass.drawIndexed(this._ibCount, 1, 0, 0, 0);
      pass.end();

      // ── Picking pass (triangle-list only, skips wireframe) ────────────────
      var sg2 = sharedWgpu;
      var pendingSinglePick = !!this._pendingPickPx;
      var fireSinglePickCallback = false;
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
      this._device.queue.submit([enc.finish()]);

      // Fire the callback after the combined visible+pick submit.
      if (fireSinglePickCallback && this._pickCallback) { this._pickCallback(); }

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
      this._lastMesh = null;
      this._lastMeshRevision = -1;
      if (this._resizeRaf) { cancelAnimationFrame(this._resizeRaf); this._resizeRaf = 0; }
      this._destroyParts();
      if (this._vb)        { try { this._vb.destroy(); } catch(_){} this._vb = null; }
      if (this._ib)        { try { this._ib.destroy(); } catch(_){} this._ib = null; }
      if (this._depthTex)  { try { this._depthTex.destroy(); } catch(_){} this._depthTex = null; }
      if (this._uniformBuf){ try { this._uniformBuf.destroy(); } catch(_){} this._uniformBuf = null; }
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

  VfGeomWgpu.__vfRuntimeAssetVersion = RUNTIME_ASSET_VERSION;
  global.VfGeomWgpu    = VfGeomWgpu;
  global.VfGeomWgpuUtil = {
    __vfRuntimeAssetVersion: RUNTIME_ASSET_VERSION,
    parseColor: parseColor,
    LIGHT_MODELS: LIGHT_MODELS
  };
})(typeof window !== "undefined" ? window : this);
