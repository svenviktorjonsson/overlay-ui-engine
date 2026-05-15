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
  var faceColor = new Float32Array(styles.face_color || [0.06, 0.55, 0.94, 1.0]);
  var edgeColor = new Float32Array(styles.edge_color || [0.08, 0.78, 1.0, 0.95]);
  var vertexColor = new Float32Array(styles.vertex_color || [1.0, 0.45, 0.18, 1.0]);
  var edgeWidth = Number(styles.edge_width || 1.0);
  var vertexSize = Number(styles.vertex_size || 0.12);
  var showEdges = styles.show_edges !== false;
  var showVertices = styles.show_vertices === true;
  var edgeCaps = styles.edge_caps === true;
  var forceFlatFace = styles.face_light_model === "flat";
  var frameId = String(config.frame_id || "");
  var waveDefs = normalizeWaves(waves);
  var initialUValues = sampleAxis(uMin, uMax, uCount);
  var initialVValues = sampleAxis(vMin, vMax, vCount);
  var waveTables = buildWaveTables(initialUValues, initialVValues, waveDefs);
  var surfaceSubdivLayout = buildSurfaceSubdivLayout(faceSubdiv);
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
  var runtime = {
    running: false,
    lastFrameIndex: -1,
    store: null,
    bound: null,
    surfaceMesh: null,
    edgeMesh: null,
    vertexMesh: null,
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

  function buildSurfaceSubdivLayout(subdiv) {
    var subcellCount = subdiv * subdiv;
    var layout = new Float32Array(subcellCount * 6);
    var offset = 0;
    for (var sv = 0; sv < subdiv; sv += 1) {
      var t0 = sv / subdiv;
      var t1 = (sv + 1) / subdiv;
      var tm = (t0 + t1) * 0.5;
      for (var su = 0; su < subdiv; su += 1) {
        var s0 = su / subdiv;
        var s1 = (su + 1) / subdiv;
        var sm = (s0 + s1) * 0.5;
        layout[offset] = s0; offset += 1;
        layout[offset] = s1; offset += 1;
        layout[offset] = sm; offset += 1;
        layout[offset] = t0; offset += 1;
        layout[offset] = t1; offset += 1;
        layout[offset] = tm; offset += 1;
      }
    }
    return layout;
  }

  function boundaryCode(name) {
    if (name === "mirror") { return 1; }
    if (name === "stop") { return 2; }
    if (name === "reset") { return 3; }
    return 0;
  }

  function makeTriangleMesh() {
    var cellCount = (uCount - 1) * (vCount - 1);
    var quadCount = cellCount * faceSubdiv * faceSubdiv;
    var vertexCount = quadCount * 6;
    var vertices = new Float32Array(vertexCount * 10);
    var indices = new Uint32Array(vertexCount);
    for (var vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
      indices[vertexIndex] = vertexIndex;
    }
    seedSurfaceVertexLayout(vertices);
    return {
      type: "field_mesh",
      id: "ocean_surface",
      object_id: 1,
      topology: "triangle-list",
      transparent: false,
      depth_write: true,
      pickable: false,
      static_indices: true,
      vertices: vertices,
      color: Array.prototype.slice.call(faceColor),
      indices: indices
    };
  }

  function seedSurfaceVertexLayout(vertices) {
    var offset = 0;
    for (var vIndex = 0; vIndex < vCount - 1; vIndex += 1) {
      var ay = initialVValues[vIndex];
      var cy = initialVValues[vIndex + 1];
      for (var uIndex = 0; uIndex < uCount - 1; uIndex += 1) {
        var ax = initialUValues[uIndex];
        var bx = initialUValues[uIndex + 1];
        var abx = bx - ax;
        var acy = cy - ay;
        for (var layoutOffset = 0; layoutOffset < surfaceSubdivLayout.length; layoutOffset += 6) {
          var s0 = surfaceSubdivLayout[layoutOffset];
          var s1 = surfaceSubdivLayout[layoutOffset + 1];
          var t0 = surfaceSubdivLayout[layoutOffset + 3];
          var t1 = surfaceSubdivLayout[layoutOffset + 4];
          writeStaticVertexRaw(vertices, offset, ax + (abx * s0), ay + (acy * t0), faceColor); offset += 10;
          writeStaticVertexRaw(vertices, offset, ax + (abx * s1), ay + (acy * t0), faceColor); offset += 10;
          writeStaticVertexRaw(vertices, offset, ax + (abx * s0), ay + (acy * t1), faceColor); offset += 10;
          writeStaticVertexRaw(vertices, offset, ax + (abx * s1), ay + (acy * t0), faceColor); offset += 10;
          writeStaticVertexRaw(vertices, offset, ax + (abx * s1), ay + (acy * t1), faceColor); offset += 10;
          writeStaticVertexRaw(vertices, offset, ax + (abx * s0), ay + (acy * t1), faceColor); offset += 10;
        }
      }
    }
  }

  function makeSphereTemplate(latSeg, lonSeg) {
    var vertexCount = (latSeg + 1) * (lonSeg + 1);
    var vertices = new Float32Array(vertexCount * 10);
    var offset = 0;
    for (var j = 0; j <= latSeg; j += 1) {
      var v = j / latSeg;
      var phi = v * Math.PI;
      var sp = Math.sin(phi);
      var cp = Math.cos(phi);
      for (var i = 0; i <= lonSeg; i += 1) {
        var u = i / lonSeg;
        var th = u * Math.PI * 2;
        var nx = sp * Math.cos(th);
        var ny = cp;
        var nz = sp * Math.sin(th);
        writeVertexRaw(vertices, offset, nx, ny, nz, nx, ny, nz, faceColor);
        offset += 10;
      }
    }
    var row = lonSeg + 1;
    var indices = new Uint32Array(latSeg * lonSeg * 6);
    var indexOffset = 0;
    for (var y = 0; y < latSeg; y += 1) {
      for (var x = 0; x < lonSeg; x += 1) {
        var a = (y * row) + x;
        var b = a + 1;
        var c = a + row;
        var d = c + 1;
        indices[indexOffset] = a; indexOffset += 1;
        indices[indexOffset] = c; indexOffset += 1;
        indices[indexOffset] = b; indexOffset += 1;
        indices[indexOffset] = b; indexOffset += 1;
        indices[indexOffset] = c; indexOffset += 1;
        indices[indexOffset] = d; indexOffset += 1;
      }
    }
    return { vertices: vertices, indices: indices };
  }

  function makeCylinderTemplate(seg) {
    var ringCount = seg + 1;
    var vertexCount = ringCount * 2;
    var vertices = new Float32Array(vertexCount * 10);
    var offset = 0;
    for (var i = 0; i <= seg; i += 1) {
      var th = (i / seg) * Math.PI * 2;
      var ct = Math.cos(th);
      var st = Math.sin(th);
      writeVertexRaw(vertices, offset, ct, st, 0.0, ct, st, 0.0, faceColor);
      offset += 10;
      writeVertexRaw(vertices, offset, ct, st, 1.0, ct, st, 0.0, faceColor);
      offset += 10;
    }
    var indices = new Uint32Array(seg * 6);
    var indexOffset = 0;
    for (var s = 0; s < seg; s += 1) {
      var p0 = s * 2;
      var p1 = p0 + 1;
      var p2 = p0 + 2;
      var p3 = p0 + 3;
      indices[indexOffset] = p0; indexOffset += 1;
      indices[indexOffset] = p1; indexOffset += 1;
      indices[indexOffset] = p2; indexOffset += 1;
      indices[indexOffset] = p2; indexOffset += 1;
      indices[indexOffset] = p1; indexOffset += 1;
      indices[indexOffset] = p3; indexOffset += 1;
    }
    return { vertices: vertices, indices: indices };
  }

  function rebuildSurfaceVertices(bound) {
    var vertices = runtime.surfaceMesh.vertices;
    var offset = 0;
    var heights = bound.heights;
    var layout = surfaceSubdivLayout;
    for (var vIndex = 0; vIndex < vCount - 1; vIndex += 1) {
      var ay = bound.vValues[vIndex];
      var cy = bound.vValues[vIndex + 1];
      var rowOffset = vIndex * uCount;
      var nextRowOffset = rowOffset + uCount;
      for (var uIndex = 0; uIndex < uCount - 1; uIndex += 1) {
        var ax = bound.uValues[uIndex];
        var bx = bound.uValues[uIndex + 1];
        var az = heights[rowOffset + uIndex];
        var bz = heights[rowOffset + uIndex + 1];
        var cz = heights[nextRowOffset + uIndex];
        var dz = heights[nextRowOffset + uIndex + 1];
        var abx = bx - ax;
        var abz = bz - az;
        var acy = cy - ay;
        var acz = cz - az;
        var qz = az - bz - cz + dz;
        for (var layoutOffset = 0; layoutOffset < layout.length; layoutOffset += 6) {
          var s0 = layout[layoutOffset];
          var s1 = layout[layoutOffset + 1];
          var sm = layout[layoutOffset + 2];
          var t0 = layout[layoutOffset + 3];
          var t1 = layout[layoutOffset + 4];
          var tm = layout[layoutOffset + 5];
          var p00z = az + (abz * s0) + (acz * t0) + (qz * s0 * t0);
          var p10z = az + (abz * s1) + (acz * t0) + (qz * s1 * t0);
          var p01z = az + (abz * s0) + (acz * t1) + (qz * s0 * t1);
          var p11z = az + (abz * s1) + (acz * t1) + (qz * s1 * t1);
          var tx = abx;
          var ty = 0.0;
          var tz = abz + (qz * tm);
          var bxn = 0.0;
          var byn = acy;
          var bzn = acz + (qz * sm);
          var nx = (ty * bzn) - (tz * byn);
          var ny = (tz * bxn) - (tx * bzn);
          var nz = (tx * byn) - (ty * bxn);
          var nlen = Math.sqrt((nx * nx) + (ny * ny) + (nz * nz)) || 1.0;
          nx /= nlen;
          ny /= nlen;
          nz /= nlen;
          writeDynamicVertexState(vertices, offset, p00z, nx, ny, nz); offset += 10;
          writeDynamicVertexState(vertices, offset, p10z, nx, ny, nz); offset += 10;
          writeDynamicVertexState(vertices, offset, p01z, nx, ny, nz); offset += 10;
          writeDynamicVertexState(vertices, offset, p10z, nx, ny, nz); offset += 10;
          writeDynamicVertexState(vertices, offset, p11z, nx, ny, nz); offset += 10;
          writeDynamicVertexState(vertices, offset, p01z, nx, ny, nz); offset += 10;
        }
      }
    }
    runtime.surfaceMesh.__revision = Number(runtime.surfaceMesh.__revision || 0) + 1;
  }

  function makeEdgeMesh() {
    var segmentCount = ((uCount - 1) * vCount) + ((vCount - 1) * uCount);
    var template = makeCylinderTemplate(20);
    var instances = new Float32Array(segmentCount * 12);
    seedEdgeInstanceLayout(instances);
    return {
      id: "ocean_grid",
      object_id: 2,
      topology: "triangle-list",
      instance_kind: "cylinder-list",
      instance_count: segmentCount,
      transparent: false,
      depth_write: true,
      pickable: false,
      vertices: template.vertices,
      indices: template.indices,
      instances: instances
    };
  }

  function makeVertexMesh() {
    var vertexCount = uCount * vCount;
    var template = makeSphereTemplate(12, 18);
    var instances = new Float32Array(vertexCount * 8);
    seedVertexInstanceLayout(instances);
    return {
      id: "ocean_vertices",
      object_id: 3,
      topology: "triangle-list",
      instance_kind: "sphere-list",
      instance_count: vertexCount,
      transparent: false,
      depth_write: true,
      pickable: false,
      vertices: template.vertices,
      indices: template.indices,
      instances: instances
    };
  }

  function seedEdgeInstanceLayout(instances) {
    var offset = 0;
    for (var row = 0; row < vCount; row += 1) {
      var v = initialVValues[row];
      for (var col = 0; col < uCount - 1; col += 1) {
        instances[offset] = initialUValues[col]; offset += 1;
        instances[offset] = v; offset += 1;
        offset += 1;
        instances[offset] = edgeWidth; offset += 1;
        instances[offset] = initialUValues[col + 1]; offset += 1;
        instances[offset] = v; offset += 1;
        offset += 1;
        instances[offset] = 0.0; offset += 1;
        instances[offset] = edgeColor[0]; offset += 1;
        instances[offset] = edgeColor[1]; offset += 1;
        instances[offset] = edgeColor[2]; offset += 1;
        instances[offset] = edgeColor[3]; offset += 1;
      }
    }
    for (var col2 = 0; col2 < uCount; col2 += 1) {
      var u = initialUValues[col2];
      for (var row2 = 0; row2 < vCount - 1; row2 += 1) {
        instances[offset] = u; offset += 1;
        instances[offset] = initialVValues[row2]; offset += 1;
        offset += 1;
        instances[offset] = edgeWidth; offset += 1;
        instances[offset] = u; offset += 1;
        instances[offset] = initialVValues[row2 + 1]; offset += 1;
        offset += 1;
        instances[offset] = 0.0; offset += 1;
        instances[offset] = edgeColor[0]; offset += 1;
        instances[offset] = edgeColor[1]; offset += 1;
        instances[offset] = edgeColor[2]; offset += 1;
        instances[offset] = edgeColor[3]; offset += 1;
      }
    }
  }

  function seedVertexInstanceLayout(instances) {
    var offset = 0;
    for (var vIndex = 0; vIndex < vCount; vIndex += 1) {
      var v = initialVValues[vIndex];
      for (var uIndex = 0; uIndex < uCount; uIndex += 1) {
        instances[offset] = initialUValues[uIndex]; offset += 1;
        instances[offset] = v; offset += 1;
        offset += 1;
        instances[offset] = vertexSize; offset += 1;
        instances[offset] = vertexColor[0]; offset += 1;
        instances[offset] = vertexColor[1]; offset += 1;
        instances[offset] = vertexColor[2]; offset += 1;
        instances[offset] = vertexColor[3]; offset += 1;
      }
    }
  }

  function gridIndex(uIndex, vIndex) {
    return (vIndex * uCount) + uIndex;
  }

  function writeVertexRaw(target, offset, px, py, pz, nx, ny, nz, color) {
    target[offset] = px;
    target[offset + 1] = py;
    target[offset + 2] = pz;
    target[offset + 3] = nx;
    target[offset + 4] = ny;
    target[offset + 5] = nz;
    target[offset + 6] = color[0];
    target[offset + 7] = color[1];
    target[offset + 8] = color[2];
    target[offset + 9] = color[3];
  }

  function writeStaticVertexRaw(target, offset, px, py, color) {
    target[offset] = px;
    target[offset + 1] = py;
    target[offset + 6] = color[0];
    target[offset + 7] = color[1];
    target[offset + 8] = color[2];
    target[offset + 9] = color[3];
  }

  function writeDynamicVertexState(target, offset, pz, nx, ny, nz) {
    target[offset + 2] = pz;
    target[offset + 3] = nx;
    target[offset + 4] = ny;
    target[offset + 5] = nz;
  }

  function sampleHeightAtIndex(bound, uIndex, vIndex) {
    return bound.heights[gridIndex(uIndex, vIndex)];
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

  function rebuildEdgeVertices(bound) {
    if (!runtime.edgeMesh) { return; }
    var instances = runtime.edgeMesh.instances;
    var heights = bound.heights;
    var offset = 0;
    for (var row = 0; row < vCount; row += 1) {
      var rowOffset = row * uCount;
      for (var col = 0; col < uCount - 1; col += 1) {
        instances[offset + 2] = heights[rowOffset + col];
        instances[offset + 6] = heights[rowOffset + col + 1];
        offset += 12;
      }
    }
    for (var col2 = 0; col2 < uCount; col2 += 1) {
      for (var row2 = 0; row2 < vCount - 1; row2 += 1) {
        var rowOffset2 = row2 * uCount;
        instances[offset + 2] = heights[rowOffset2 + col2];
        instances[offset + 6] = heights[rowOffset2 + uCount + col2];
        offset += 12;
      }
    }
    runtime.edgeMesh.__revision = Number(runtime.edgeMesh.__revision || 0) + 1;
  }

  function rebuildVertexVertices(bound) {
    if (!runtime.vertexMesh) { return; }
    var instances = runtime.vertexMesh.instances;
    var heights = bound.heights;
    var offset = 2;
    for (var heightIndex = 0; heightIndex < heights.length; heightIndex += 1) {
      instances[offset] = heights[heightIndex];
      offset += 8;
    }
    runtime.vertexMesh.__revision = Number(runtime.vertexMesh.__revision || 0) + 1;
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
    rebuildSurfaceVertices(bound);
    if (showEdges && runtime.edgeMesh) {
      rebuildEdgeVertices(bound);
    }
    if (showVertices && runtime.vertexMesh) {
      rebuildVertexVertices(bound);
    }
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
      runtime.surfaceMesh = makeTriangleMesh();
      runtime.edgeMesh = showEdges ? makeEdgeMesh() : null;
      runtime.vertexMesh = showVertices ? makeVertexMesh() : null;
      runtime.surfaceMesh.light_model = forceFlatFace ? "flat" : null;
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
        color: lightColor
      };
      runtime.scene = {
        parts: [runtime.surfaceMesh],
        camera: runtime.camera,
        lights: [runtime.light],
        unified_renderer: true
      };
      if (showEdges && runtime.edgeMesh) {
        runtime.scene.parts.push(runtime.edgeMesh);
      }
      if (showVertices && runtime.vertexMesh) {
        runtime.scene.parts.push(runtime.vertexMesh);
      }
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
