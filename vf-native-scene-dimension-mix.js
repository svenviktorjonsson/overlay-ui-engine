/*
 * vf-native-scene-dimension-mix.js -- UI-engine runtime for
 * native_scene.kind = "dimension_mix".
 *
 * The VKF file declares parameters only. Geometry is built once inside the
 * overlay runtime so the launched scene no longer depends on a live Python host.
 */
(function (global) {
  "use strict";

  var config = global.__vfNativeDimensionMixConfig;
  if (!config || typeof config !== "object") {
    throw new Error("vf-native-scene-dimension-mix requires window.__vfNativeDimensionMixConfig");
  }

  function failFast(message) {
    var text = "dimension_mix: " + String(message);
    try { console.error(text); } catch (_) {}
    try {
      if (global.chrome && global.chrome.webview && global.chrome.webview.postMessage) {
        global.chrome.webview.postMessage({ type: "vf_log", level: "error", message: text });
      }
    } catch (_) {}
    throw new Error(text);
  }

  function requireRuntime() {
    if (!global.VfDisplay || typeof global.VfDisplay.renderFromJson !== "function") {
      failFast("VfDisplay.renderFromJson is unavailable");
    }
  }

  function toVec3(value, fallback) {
    if (!Array.isArray(value) || value.length !== 3) { return fallback.slice(); }
    return [Number(value[0]), Number(value[1]), Number(value[2])];
  }

  function toRgba(value, fallback) {
    if (!Array.isArray(value) || value.length !== 4) { return fallback.slice(); }
    return [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3])];
  }

  function makeCamera(cfg, fallback) {
    var camera = cfg || {};
    var out = {
      pos: toVec3(camera.pos, fallback.pos),
      target: toVec3(camera.target, fallback.target),
      fov: Number(camera.fov || fallback.fov),
      up: toVec3(camera.up, fallback.up)
    };
    if (camera.min_distance != null) {
      out.min_distance = Number(camera.min_distance);
    }
    return out;
  }

  function makeLight(cfg, fallback, timeSeconds) {
    var light = cfg || {};
    var target = toVec3(light.target, fallback.target);
    var model = String(light.model || fallback.model);
    var color = Array.isArray(light.color) ? toRgba(light.color, fallback.color) : (light.color || fallback.color);
    var kind = String(light.kind || fallback.kind || "point");
    var intensity = Math.max(0.0, Number(light.intensity == null ? (light.power == null ? (fallback.intensity == null ? 24.0 : fallback.intensity) : light.power) : light.intensity));
    var direction = Array.isArray(light.direction) ? toVec3(light.direction, [0, 0, -1]) : (Array.isArray(fallback.direction) ? toVec3(fallback.direction, [0, 0, -1]) : undefined);
    var innerConeDeg = Number(light.inner_cone_deg == null ? (fallback.inner_cone_deg == null ? 14.0 : fallback.inner_cone_deg) : light.inner_cone_deg);
    var outerConeDeg = Number(light.outer_cone_deg == null ? (fallback.outer_cone_deg == null ? 22.0 : fallback.outer_cone_deg) : light.outer_cone_deg);
    var range = Math.max(0.0, Number(light.range == null ? (fallback.range == null ? 0.0 : fallback.range) : light.range));
    if (light.pos) {
      return {
        pos: toVec3(light.pos, fallback.pos),
        target: target,
        model: model,
        color: color,
        kind: kind,
        direction: direction,
        intensity: intensity,
        inner_cone_deg: innerConeDeg,
        outer_cone_deg: outerConeDeg,
        range: range
      };
    }
    var radius = Number(light.radius == null ? fallback.radius : light.radius);
    var height = Number(light.height == null ? fallback.height : light.height);
    var theta = Number(light.theta == null ? fallback.theta : light.theta);
    var angularVelocity = Number(light.angular_velocity == null ? fallback.angular_velocity : light.angular_velocity);
    var angle = theta + (angularVelocity * Number(timeSeconds || 0.0));
    return {
      pos: [target[0] + (Math.cos(angle) * radius), target[1] + (Math.sin(angle) * radius), target[2] + height],
      target: target,
      model: model,
      color: color,
      kind: kind,
      direction: direction,
      intensity: intensity,
      inner_cone_deg: innerConeDeg,
      outer_cone_deg: outerConeDeg,
      range: range
    };
  }

  function pushVertex(out, p, normal, color) {
    out.push(
      Number(p[0]), Number(p[1]), Number(p[2]),
      Number(normal[0]), Number(normal[1]), Number(normal[2]),
      Number(color[0]), Number(color[1]), Number(color[2]), Number(color[3])
    );
  }

  function triangleNormal(a, b, c) {
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

  function normalizeVec3(v) {
    var len = Math.sqrt((v[0] * v[0]) + (v[1] * v[1]) + (v[2] * v[2])) || 1.0;
    return [v[0] / len, v[1] / len, v[2] / len];
  }

  function buildSurfaceGridMesh(id, rows, cols, pointFor, color) {
    var vertices = [];
    var indices = [];
    var grid = new Array(rows);
    var normals = new Array(rows);
    var row;
    var col;
    for (row = 0; row < rows; row += 1) {
      grid[row] = new Array(cols);
      normals[row] = new Array(cols);
    }
    for (row = 0; row < rows; row += 1) {
      for (col = 0; col < cols; col += 1) {
        grid[row][col] = pointFor(row, col);
      }
    }
    for (row = 0; row < rows; row += 1) {
      for (col = 0; col < cols; col += 1) {
        var left = grid[row][Math.max(0, col - 1)];
        var right = grid[row][Math.min(cols - 1, col + 1)];
        var down = grid[Math.max(0, row - 1)][col];
        var up = grid[Math.min(rows - 1, row + 1)][col];
        var du = [right[0] - left[0], right[1] - left[1], right[2] - left[2]];
        var dv = [up[0] - down[0], up[1] - down[1], up[2] - down[2]];
        normals[row][col] = normalizeVec3([
          (du[1] * dv[2]) - (du[2] * dv[1]),
          (du[2] * dv[0]) - (du[0] * dv[2]),
          (du[0] * dv[1]) - (du[1] * dv[0])
        ]);
        pushVertex(vertices, grid[row][col], normals[row][col], color);
      }
    }
    for (row = 0; row < rows - 1; row += 1) {
      for (col = 0; col < cols - 1; col += 1) {
        var i0 = (row * cols) + col;
        var i1 = i0 + 1;
        var i2 = i0 + cols;
        var i3 = i2 + 1;
        indices.push(i0, i2, i3, i0, i3, i1);
      }
    }
    return {
      type: "field_mesh",
      id: id,
      topology: "triangle-list",
      vertices: vertices,
      indices: indices,
      interpolation: true,
      depth_write: true
    };
  }

  function mulberry32(seed) {
    var state = (Number(seed) | 0) >>> 0;
    return function () {
      state = (state + 0x6D2B79F5) >>> 0;
      var t = Math.imul(state ^ (state >>> 15), 1 | state);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gaussian(rand, sigma) {
    var u1 = Math.max(1e-9, rand());
    var u2 = rand();
    var r = Math.sqrt(-2.0 * Math.log(u1));
    var theta = 2.0 * Math.PI * u2;
    return sigma * r * Math.cos(theta);
  }

  function buildPointCloudMesh(spec) {
    var countI = Math.max(2, Number(spec.count_i || 320) | 0);
    var sigma = Number(spec.sigma || 0.24);
    var rand = mulberry32(Number(spec.seed || 7) | 0);
    var color = toRgba(spec.color, [1.0, 0.55, 0.10, 1.0]);
    var vertices = [];
    var indices = [];
    var vertexScale = [];
    var index = 0;
    var pointIndex;
    for (pointIndex = 0; pointIndex < countI; pointIndex += 1) {
      pushVertex(
        vertices,
        [
          gaussian(rand, sigma),
          gaussian(rand, sigma),
          gaussian(rand, sigma),
        ],
        [0, 0, 1],
        color
      );
      indices.push(index);
      vertexScale.push(0.1 + (0.4 * rand()));
      index += 1;
    }
    return {
      type: "field_mesh",
      id: "dim0_points",
      topology: "point-list",
      vertices: vertices,
      indices: indices,
      color: color,
      vertex_size: Number(spec.vertex_size || 0.1),
      vertex_scale: vertexScale,
      depth_write: true
    };
  }

  function buildDoubleHelixMeshes(spec) {
    var steps = Math.max(2, Number(spec.u_steps || 60) | 0);
    var radius = Number(spec.radius || 0.72);
    var pitch = Number(spec.pitch || 0.065);
    var turnStep = Number(spec.turn_step || 0.30);
    var edgeColors = Array.isArray(spec.edge_color_j) ? spec.edge_color_j : [[0.10, 0.86, 0.30, 1.0], [0.10, 0.56, 0.96, 1.0]];
    var vertexColors = Array.isArray(spec.vertex_color_j) ? spec.vertex_color_j : [[0.95, 0.62, 0.18, 1.0], [0.96, 0.34, 0.72, 1.0]];
    var lineVertices = [];
    var pointVertices = [];
    var lineIndices = [];
    var pointIndices = [];
    var phases = [0.0, Math.PI];
    var strand, u, index = 0;
    for (strand = 0; strand < 2; strand += 1) {
      var phase = phases[strand];
      var edgeColor = toRgba(edgeColors[strand] || edgeColors[0], [0.10, 0.86, 0.30, 1.0]);
      var vertexColor = toRgba(vertexColors[strand] || vertexColors[0], [0.95, 0.62, 0.18, 1.0]);
      for (u = 0; u < steps; u += 1) {
        var angle = (u - ((steps - 1) * 0.5)) * turnStep + phase;
        var p = [
          radius * Math.cos(angle),
          radius * Math.sin(angle),
          (u - ((steps - 1) * 0.5)) * pitch
        ];
        pushVertex(lineVertices, p, [0, 0, 1], edgeColor);
        pushVertex(pointVertices, p, [0, 0, 1], vertexColor);
        pointIndices.push(index);
        if (u + 1 < steps) {
          lineIndices.push(index, index + 1);
        }
        index += 1;
      }
    }
    return [
      {
        type: "field_mesh",
        id: "dim1_lines",
        topology: "line-list",
        vertices: lineVertices,
        indices: lineIndices,
        color: edgeColor,
        edge_width: Number(spec.edge_width || 0.04),
        depth_write: true
      },
      {
        type: "field_mesh",
        id: "dim1_points",
        topology: "point-list",
        vertices: pointVertices,
        indices: pointIndices,
        color: vertexColor,
        vertex_size: Number(spec.vertex_size || 0.08),
        depth_write: true
      }
    ];
  }

  function buildPlaneMeshes(spec) {
    var uSteps = Math.max(2, Number(spec.u_steps || 25) | 0);
    var vSteps = Math.max(2, Number(spec.v_steps || 25) | 0);
    var layers = Array.isArray(spec.layers) ? spec.layers : [-1.0, 1.0];
    var uScale = Number(spec.u_scale || 0.11);
    var vScale = Number(spec.v_scale || 0.11);
    var xOffset = Number(spec.x_offset_per_layer || 0.28);
    var yOffset = Number(spec.y_offset_per_layer || 0.14);
    var zOffset = Number(spec.z_offset_per_layer || 0.85);
    var faceColors = Array.isArray(spec.face_color_i) ? spec.face_color_i : [[0.08, 0.78, 0.95, 0.95], [0.22, 0.96, 0.54, 0.95]];
    var heightAmps = Array.isArray(spec.height_amp_i) ? spec.height_amp_i : [0.16, 0.22];
    var heightPhases = Array.isArray(spec.height_phase_i) ? spec.height_phase_i : [0.0, 1.35];
    var layerIndex, u, v, base = 0;
    function pointFor(layerValue, uu, vv, layerSlot) {
      var x0 = (uu - ((uSteps - 1) * 0.5)) * uScale;
      var y0 = (vv - ((vSteps - 1) * 0.5)) * vScale;
      var phase = Number(heightPhases[layerSlot] == null ? 0.0 : heightPhases[layerSlot]);
      var amp = Number(heightAmps[layerSlot] == null ? 0.0 : heightAmps[layerSlot]);
      var zWave = amp * Math.sin((0.72 * x0) + phase) * Math.cos((0.88 * y0) - (0.5 * phase));
      return [
        x0 + (xOffset * layerValue),
        y0 + (yOffset * layerValue),
        (zOffset * layerValue) + zWave
      ];
    }
    var meshes = [];
    for (layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
      var layerValue = Number(layers[layerIndex]);
      var faceColor = toRgba(faceColors[layerIndex] || faceColors[0], [0.08, 0.78, 0.95, 0.95]);
      meshes.push(buildSurfaceGridMesh("dim2_faces_" + String(layerIndex), vSteps, uSteps, function (row, col) {
        return pointFor(layerValue, col, row, layerIndex);
      }, faceColor));
    }
    return meshes;
  }

  function buildVolumeShellMesh(spec) {
    var uSteps = Math.max(2, Number(spec.u_steps || 20) | 0);
    var vSteps = Math.max(2, Number(spec.v_steps || 20) | 0);
    var wSteps = Math.max(2, Number(spec.w_steps || 20) | 0);
    var scale = Number(spec.scale || 0.12);
    var color = toRgba(spec.face_color, [0.92, 0.18, 0.88, 0.95]);
    function warpPoint(uIndex, vIndex, wIndex) {
      var x0 = (uIndex - ((uSteps - 1) * 0.5)) * scale;
      var y0 = (vIndex - ((vSteps - 1) * 0.5)) * scale;
      var z0 = (wIndex - ((wSteps - 1) * 0.5)) * scale;
      return [
        x0 + Number(spec.warp_x_amp || 0.12) * Math.sin((Number(spec.warp_x_y_freq || 1.5) * y0) + (Number(spec.warp_x_z_freq || 1.1) * z0)),
        y0 + Number(spec.warp_y_amp || 0.10) * Math.cos((Number(spec.warp_y_x_freq || 1.3) * x0) + (Number(spec.warp_y_z_freq || -1.4) * z0)),
        z0 + Number(spec.warp_z_amp || 0.11) * Math.sin((Number(spec.warp_z_x_freq || 1.2) * x0) + (Number(spec.warp_z_y_freq || 1.6) * y0))
      ];
    }
    return [
      buildSurfaceGridMesh("dim3_shell_u0", vSteps, wSteps, function (row, col) {
        return warpPoint(0, row, col);
      }, color),
      buildSurfaceGridMesh("dim3_shell_u1", vSteps, wSteps, function (row, col) {
        return warpPoint(uSteps - 1, row, col);
      }, color),
      buildSurfaceGridMesh("dim3_shell_v0", uSteps, wSteps, function (row, col) {
        return warpPoint(row, 0, col);
      }, color),
      buildSurfaceGridMesh("dim3_shell_v1", uSteps, wSteps, function (row, col) {
        return warpPoint(row, vSteps - 1, col);
      }, color),
      buildSurfaceGridMesh("dim3_shell_w0", uSteps, vSteps, function (row, col) {
        return warpPoint(row, col, 0);
      }, color),
      buildSurfaceGridMesh("dim3_shell_w1", uSteps, vSteps, function (row, col) {
        return warpPoint(row, col, wSteps - 1);
      }, color)
    ];
  }

  function buildFrameGeom(frameSpec, meshes, cameraSpec, lightSpec, cameraFallback, lightFallback, timeSeconds) {
    var geom = {};
    geom[String(frameSpec.frame_id)] = {
      meshes: meshes,
      camera: makeCamera(cameraSpec, cameraFallback),
      lights: [makeLight(lightSpec, lightFallback, timeSeconds)],
      unified_renderer: true
    };
    return geom;
  }

  function zoomCamera(camera, zoomFactor) {
    var pos = toVec3(camera.pos, [0, 0, 5]);
    var target = toVec3(camera.target, [0, 0, 0]);
    var dx = pos[0] - target[0];
    var dy = pos[1] - target[1];
    var dz = pos[2] - target[2];
    var currentDistance = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz)) || 1.0;
    var nextFactor = Math.min(2.5, Math.max(0.35, zoomFactor));
    var nextDistance = currentDistance * nextFactor;
    var minDistance = Number(camera.min_distance == null ? 0.0 : camera.min_distance);
    if (minDistance > 0) {
      nextDistance = Math.max(minDistance, nextDistance);
      nextFactor = nextDistance / currentDistance;
    }
    var out = {
      min_distance: minDistance,
      pos: [target[0] + (dx * nextFactor), target[1] + (dy * nextFactor), target[2] + (dz * nextFactor)],
      target: target.slice(),
      fov: Number(camera.fov || 40),
      up: toVec3(camera.up, [0, 0, 1])
    };
    return out;
  }

  function buildDisplayPayload(cameraOverrides, timeSeconds) {
    var frames = config.frames || {};
    var cloud = config.cloud || {};
    var helix = config.helix || {};
    var planes = config.planes || {};
    var volume = config.volume || {};
    var cameras = cameraOverrides || {};
    var geom = {};
    var part;
    part = buildFrameGeom(
      frames.points,
      [buildPointCloudMesh(cloud)],
      cameras.points || cloud.camera,
      cloud.light,
      { pos: [3.3, -4.6, 3.2], target: [0, 0, 0], fov: 40, up: [0, 0, 1] },
      { radius: 4.4, height: 3.2, theta: 0.15, angular_velocity: 0.42, target: [0, 0, 0], model: "blinn_phong", color: "white" },
      timeSeconds
    );
    Object.assign(geom, part);
    part = buildFrameGeom(
      frames.lines,
      buildDoubleHelixMeshes(helix),
      cameras.lines || helix.camera,
      helix.light,
      { pos: [4.2, -5.3, 2.7], target: [0, 0, 0], fov: 36, up: [0, 0, 1] },
      { radius: 4.8, height: 3.6, theta: 0.55, angular_velocity: 0.38, target: [0, 0, 0], model: "blinn_phong", color: "white" },
      timeSeconds
    );
    Object.assign(geom, part);
    part = buildFrameGeom(
      frames.surface,
      buildPlaneMeshes(planes),
      cameras.surface || planes.camera,
      planes.light,
      { pos: [4.2, -6.8, 4.6], target: [0, 0, 0], fov: 34, up: [0, 0, 1] },
      { radius: 4.9, height: 4.6, theta: 1.1, angular_velocity: 0.34, target: [0, 0, 0], model: "blinn_phong", color: "white" },
      timeSeconds
    );
    Object.assign(geom, part);
    part = buildFrameGeom(
      frames.volume,
      buildVolumeShellMesh(volume),
      cameras.volume || volume.camera,
      volume.light,
      { pos: [4.9, -6.8, 4.8], target: [0, 0, 0], fov: 34, up: [0, 0, 1] },
      { radius: 3.8, height: 3.9, theta: 0.95, angular_velocity: 0.31, target: [0.35, -0.10, 0.15], model: "blinn_phong", color: "white" },
      timeSeconds
    );
    Object.assign(geom, part);
    return { screen: [], frames: {}, geom: geom };
  }

  function waitForFrames(attempt) {
    var frames = config.frames || {};
    var keys = ["points", "lines", "surface", "volume"];
    var frameEls = {};
    var i;
    for (i = 0; i < keys.length; i += 1) {
      var frameId = String((frames[keys[i]] || {}).frame_id || "");
      var frameEl = document.querySelector('.vf-frame[data-vf-frame-id="' + frameId + '"]');
      if (!frameEl) {
        if (attempt > 240) {
          failFast("timed out waiting for dimension frames");
        }
        global.setTimeout(function () { waitForFrames(attempt + 1); }, 16);
        return;
      }
      frameEls[keys[i]] = frameEl;
    }
    requireRuntime();
    var cameraState = {
      points: makeCamera((config.cloud || {}).camera, { pos: [3.3, -4.6, 3.2], target: [0, 0, 0], fov: 40, up: [0, 0, 1] }),
      lines: makeCamera((config.helix || {}).camera, { pos: [4.2, -5.3, 2.7], target: [0, 0, 0], fov: 36, up: [0, 0, 1] }),
      surface: makeCamera((config.planes || {}).camera, { pos: [4.2, -6.8, 4.6], target: [0, 0, 0], fov: 34, up: [0, 0, 1] }),
      volume: makeCamera((config.volume || {}).camera, { pos: [4.9, -6.8, 4.8], target: [0, 0, 0], fov: 34, up: [0, 0, 1] })
    };
    function renderCurrent() {
      var timeSeconds = (global.performance && typeof global.performance.now === "function") ? (global.performance.now() * 0.001) : (Date.now() * 0.001);
      global.VfDisplay.renderFromJson(buildDisplayPayload(cameraState, timeSeconds));
    }
    function attachWheelZoom(key) {
      var body = frameEls[key] && frameEls[key].querySelector(".vf-frame__body");
      if (!body || body.__vfWheelZoomAttached) { return; }
      body.__vfWheelZoomAttached = true;
      body.addEventListener("wheel", function (ev) {
        ev.preventDefault();
        var factor = ev.deltaY > 0 ? 1.10 : 0.90;
        cameraState[key] = zoomCamera(cameraState[key], factor);
        renderCurrent();
      }, { passive: false });
    }
    attachWheelZoom("points");
    attachWheelZoom("lines");
    attachWheelZoom("surface");
    attachWheelZoom("volume");
    function animate() {
      renderCurrent();
      global.requestAnimationFrame(animate);
    }
    animate();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { waitForFrames(0); }, { once: true });
  } else {
    waitForFrames(0);
  }
})(typeof window !== "undefined" ? window : this);
