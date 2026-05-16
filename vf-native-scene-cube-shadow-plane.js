/*
 * vf-native-scene-cube-shadow-plane.js -- native_scene.kind = "cube_shadow_plane"
 *
 * First-pass physically motivated penumbra: a planar projected shadow from the
 * orbiting light onto the receiver plane. Edge softness comes from source
 * radius, receiver gap, light distance, and grazing angle on the plane.
 */
(function (global) {
  "use strict";

  var config = global.__vfNativeCubeShadowConfig;
  if (!config || typeof config !== "object") {
    throw new Error("vf-native-scene-cube-shadow-plane requires window.__vfNativeCubeShadowConfig");
  }

  function failFast(message) {
    var text = "cube_shadow_plane: " + String(message);
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
    return {
      pos: toVec3(camera.pos, fallback.pos),
      target: toVec3(camera.target, fallback.target),
      fov: Number(camera.fov || fallback.fov),
      up: toVec3(camera.up, fallback.up)
    };
  }

  function currentLightPosition(light, seconds) {
    if (Array.isArray(light.pos) && light.pos.length === 3) {
      return toVec3(light.pos, [0, 0, 0]);
    }
    var target = toVec3(light.target, [0, 0, 0]);
    var radius = Number(light.radius || 4.5);
    var height = Number(light.height || 3.6);
    var theta = Number(light.theta || 0.0);
    var angularVelocity = Number(light.angular_velocity || 0.0);
    var angle = theta + (angularVelocity * seconds);
    return [
      target[0] + (Math.cos(angle) * radius),
      target[1] + (Math.sin(angle) * radius),
      target[2] + height
    ];
  }

  function normalizeLight(light, seconds) {
    var resolved = light || {};
    return {
      pos: currentLightPosition(resolved, seconds),
      target: toVec3(resolved.target, [0, 0, 0]),
      model: String(resolved.model || "blinn_phong"),
      color: toRgba(resolved.color, [1.0, 0.95, 0.84, 1.0]),
      casts_shadow: resolved.casts_shadow !== false,
      source_radius: Math.max(0.0, Number(resolved.source_radius || 0.0)),
      spread: Math.max(0.0, Number(resolved.spread == null ? 1.0 : resolved.spread))
    };
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

  function makeCubeVertices(center, size) {
    var half = Number(size) * 0.5;
    return [
      [center[0] - half, center[1] - half, center[2] - half],
      [center[0] + half, center[1] - half, center[2] - half],
      [center[0] + half, center[1] + half, center[2] - half],
      [center[0] - half, center[1] + half, center[2] - half],
      [center[0] - half, center[1] - half, center[2] + half],
      [center[0] + half, center[1] - half, center[2] + half],
      [center[0] + half, center[1] + half, center[2] + half],
      [center[0] - half, center[1] + half, center[2] + half]
    ];
  }

  function cubeMesh(cube, color) {
    var vertices = makeCubeVertices(cube.center, cube.size);
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
    return {
      type: "field_mesh",
      id: "cube_body",
      topology: "triangle-list",
      vertices: verts,
      indices: indices,
      color: color,
      interpolation: false,
      depth_write: true
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
    var dz = point[2] - lightPos[2];
    if (Math.abs(dz) < 1e-6) { return null; }
    var t = (planeZ - lightPos[2]) / dz;
    return [
      lightPos[0] + ((point[0] - lightPos[0]) * t),
      lightPos[1] + ((point[1] - lightPos[1]) * t),
      planeZ
    ];
  }

  function planeMesh(plane, shadowHulls, shadowSoftnesses) {
    var half = Number(plane.size) * 0.5;
    var z = Number(plane.z || 0.0);
    var center = Array.isArray(plane.center) ? plane.center : [0.0, 0.0];
    var cx = Number(center[0] || 0.0);
    var cy = Number(center[1] || 0.0);
    var verts = [];
    pushVertex(verts, [cx - half, cy - half, z], [0, 0, 1], plane.color);
    pushVertex(verts, [cx + half, cy - half, z], [0, 0, 1], plane.color);
    pushVertex(verts, [cx + half, cy + half, z], [0, 0, 1], plane.color);
    pushVertex(verts, [cx - half, cy + half, z], [0, 0, 1], plane.color);
    return {
      type: "field_mesh",
      id: "ground_plane",
      topology: "triangle-list",
      vertices: verts,
      indices: [0, 1, 2, 0, 2, 3],
      color: plane.color,
      light_model: "blinn_phong",
      interpolation: true,
      transparent: false,
      depth_write: true,
      shadow_hulls: Array.isArray(shadowHulls) ? shadowHulls : [],
      shadow_softnesses: Array.isArray(shadowSoftnesses) ? shadowSoftnesses : []
    };
  }

  function shadowHull(cube, plane, lightPos, shadow) {
    if (!shadow.enabled) { return null; }
    var vertices = makeCubeVertices(cube.center, cube.size);
    var projected2d = [];
    var i;
    for (i = 0; i < vertices.length; i += 1) {
      var projected = projectPointToPlane(vertices[i], lightPos, plane.z);
      if (projected) {
        projected2d.push([projected[0], projected[1]]);
      }
    }
    var hull = convexHull(projected2d);
    return hull.length >= 3 ? hull : null;
  }

  function shadowSoftness(light, cube, plane, hull) {
    if (!light || !light.casts_shadow || !Array.isArray(hull) || hull.length < 3) {
      return 0.0;
    }
    var sourceRadius = Math.max(0.0, Number(light.source_radius || 0.0));
    if (sourceRadius <= 1e-6) {
      return 0.0;
    }
    var planeZ = Number(plane.z || 0.0);
    var cubeBottomZ = Number(cube.center[2]) - (Number(cube.size) * 0.5);
    var receiverGap = Math.max(0.0, cubeBottomZ - planeZ);
    if (receiverGap <= 1e-6) {
      return 0.0;
    }
    var lx = Number(light.pos[0]) - Number(cube.center[0]);
    var ly = Number(light.pos[1]) - Number(cube.center[1]);
    var lz = Number(light.pos[2]) - cubeBottomZ;
    var lightDist = Math.sqrt((lx * lx) + (ly * ly) + (lz * lz)) || 1.0;
    var cosTheta = Math.abs(lz) / lightDist;
    var projectionStretch = 1.0 / Math.max(cosTheta, 0.2);
    var spread = Math.max(0.0, Number(light.spread == null ? 1.0 : light.spread));
    return sourceRadius * (receiverGap / lightDist) * projectionStretch * spread;
  }

  function renderPayload(seconds) {
    var cubeSpec = config.cube || {};
    var planeSpec = config.plane || {};
    var compareCubeSpec = config.compare_cube || null;
    var comparePlaneSpec = config.compare_plane || null;
    var shadowSpec = config.shadow || {};
    var cube = {
      center: toVec3(cubeSpec.center, [0, 0, 1.1]),
      size: Number(cubeSpec.size || 1.6),
      face_color: toRgba(cubeSpec.face_color, [0.96, 0.22, 0.16, 1.0])
    };
    var plane = {
      center: Array.isArray(planeSpec.center) ? [Number(planeSpec.center[0] || 0.0), Number(planeSpec.center[1] || 0.0)] : [0.0, 0.0],
      size: Number(planeSpec.size || 7.0),
      z: Number(planeSpec.z || 0.0),
      color: toRgba(planeSpec.color, [0.20, 0.22, 0.26, 1.0])
    };
    var compareCube = !compareCubeSpec ? null : {
      center: toVec3(compareCubeSpec.center, [3.4, 0.0, 1.8]),
      size: Number(compareCubeSpec.size || cube.size || 1.6),
      face_color: toRgba(compareCubeSpec.face_color, cube.face_color || [0.96, 0.22, 0.16, 1.0])
    };
    var comparePlane = !comparePlaneSpec ? null : {
      center: Array.isArray(comparePlaneSpec.center) ? [Number(comparePlaneSpec.center[0] || 0.0), Number(comparePlaneSpec.center[1] || 0.0)] : [3.4, 0.0],
      size: Number(comparePlaneSpec.size || plane.size || 7.0),
      z: Number(comparePlaneSpec.z == null ? plane.z : comparePlaneSpec.z),
      color: toRgba(comparePlaneSpec.color, plane.color || [0.20, 0.22, 0.26, 1.0])
    };
    var shadow = {
      enabled: shadowSpec.enabled !== false,
      color: toRgba(shadowSpec.color, [0.0, 0.0, 0.0, 0.30]),
      lift: Number(shadowSpec.lift || 0.002)
    };
    var camera = makeCamera(config.camera || {}, { pos: [3.9, -5.6, 3.2], target: [0, 0, 0.9], fov: 34, up: [0, 0, 1] });
    var lightSpecs = Array.isArray(config.lights) && config.lights.length
      ? config.lights
      : [config.light || {}];
    var lights = lightSpecs.map(function (entry) { return normalizeLight(entry, seconds); });
    var shadowHulls = lights.map(function (light) {
      return light.casts_shadow ? shadowHull(cube, plane, light.pos, shadow) : null;
    });
    var shadowSoftnesses = lights.map(function (light, index) {
      return shadowSoftness(light, cube, plane, shadowHulls[index]);
    });
    var meshes = [planeMesh(plane, shadowHulls, shadowSoftnesses)];
    meshes.push(cubeMesh(cube, cube.face_color));
    if (compareCube && comparePlane) {
      var compareShadowHulls = lights.map(function (light) {
        return light.casts_shadow ? shadowHull(compareCube, comparePlane, light.pos, shadow) : null;
      });
      var compareShadowSoftnesses = lights.map(function (light, index) {
        return shadowSoftness(light, compareCube, comparePlane, compareShadowHulls[index]);
      });
      meshes.push(planeMesh(comparePlane, compareShadowHulls, compareShadowSoftnesses));
      meshes.push(cubeMesh(compareCube, compareCube.face_color));
    }
    var geom = {};
    geom[String(config.frame_id)] = {
      meshes: meshes,
      camera: camera,
      lights: lights,
      unified_renderer: true
    };
    return { screen: [], frames: {}, geom: geom };
  }

  function boot() {
    requireRuntime();
    function renderFrame() {
      var seconds = (global.performance && typeof global.performance.now === "function")
        ? (global.performance.now() * 0.001)
        : (Date.now() * 0.001);
      global.VfDisplay.renderFromJson(renderPayload(seconds));
      global.requestAnimationFrame(renderFrame);
    }
    renderFrame();
  }

  function waitForFrame(attempt) {
    var frame = document.querySelector('.vf-frame[data-vf-frame-id="' + String(config.frame_id) + '"]');
    if (frame) {
      boot();
      return;
    }
    if (attempt > 240) {
      failFast("timed out waiting for cube shadow frame");
    }
    global.setTimeout(function () { waitForFrame(attempt + 1); }, 16);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { waitForFrame(0); }, { once: true });
  } else {
    waitForFrame(0);
  }
})(typeof window !== "undefined" ? window : this);
