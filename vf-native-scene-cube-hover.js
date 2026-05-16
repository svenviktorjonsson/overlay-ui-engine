/*
 * vf-native-scene-cube-hover.js -- UI-engine runtime for
 * native_scene.kind = "cube_hover".
 *
 * VKF declares the scene. After launch, hover state, debug text, GPU picking,
 * and color updates stay inside the overlay runtime.
 */
(function (global) {
  "use strict";

  var config = global.__vfNativeCubeHoverConfig;
  if (!config || typeof config !== "object") {
    throw new Error("vf-native-scene-cube-hover requires window.__vfNativeCubeHoverConfig");
  }

  var FACE_COUNT = 6;
  var EDGE_COUNT = 12;
  var VERTEX_COUNT = 8;

  var style = config.styles || {};
  var faceBase = style.face_base || [1, 0, 0, 1];
  var faceHover = style.face_hover || [1, 0.95, 0, 1];
  var edgeBase = style.edge_base || [0, 0.82, 0.12, 1];
  var edgeHover = style.edge_hover || [1, 1, 0, 1];
  var vertexBase = style.vertex_base || [0.05, 0.32, 1, 1];
  var vertexHover = style.vertex_hover || [1, 1, 1, 1];
  var camera = config.camera || {};
  var light = config.light || {};

  var vertices = [
    [-0.82, -0.82, -0.82],
    [ 0.82, -0.82, -0.82],
    [ 0.82,  0.82, -0.82],
    [-0.82,  0.82, -0.82],
    [-0.82, -0.82,  0.82],
    [ 0.82, -0.82,  0.82],
    [ 0.82,  0.82,  0.82],
    [-0.82,  0.82,  0.82]
  ];
  var faces = [
    [4, 5, 6, 7],
    [0, 1, 2, 3],
    [1, 5, 6, 2],
    [0, 4, 7, 3],
    [3, 2, 6, 7],
    [0, 1, 5, 4]
  ];
  var edges = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7]
  ];

  var hoverObjectId = 0;

  function failFast(message) {
    var text = "cube_hover: " + String(message);
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
      failFast("VfDisplay runtime is not loaded");
    }
    if (!global.VfWidgets || typeof global.VfWidgets.applyRuntimePacket !== "function") {
      failFast("VfWidgets runtime is not loaded");
    }
  }

  function meshVertex(out, p, normal, color) {
    out.push(
      Number(p[0]), Number(p[1]), Number(p[2]),
      Number(normal[0]), Number(normal[1]), Number(normal[2]),
      Number(color[0]), Number(color[1]), Number(color[2]), Number(color[3])
    );
  }

  function normalForFace(face) {
    var a = vertices[face[0]];
    var b = vertices[face[1]];
    var c = vertices[face[2]];
    var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    var vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    var nx = (uy * vz) - (uz * vy);
    var ny = (uz * vx) - (ux * vz);
    var nz = (ux * vy) - (uy * vx);
    var len = Math.sqrt((nx * nx) + (ny * ny) + (nz * nz)) || 1;
    return [nx / len, ny / len, nz / len];
  }

  function faceMesh(face, color) {
    var verts = [];
    var n = normalForFace(face);
    meshVertex(verts, vertices[face[0]], n, color);
    meshVertex(verts, vertices[face[1]], n, color);
    meshVertex(verts, vertices[face[2]], n, color);
    meshVertex(verts, vertices[face[0]], n, color);
    meshVertex(verts, vertices[face[2]], n, color);
    meshVertex(verts, vertices[face[3]], n, color);
    return {
      type: "field_mesh",
      id: "cube_face",
      vertices: verts,
      indices: [0, 1, 2, 3, 4, 5],
      topology: "triangle-list",
      color: color,
      depth_write: true
    };
  }

  function edgeMesh(pair, color) {
    var verts = [];
    meshVertex(verts, vertices[pair[0]], [0, 0, 1], color);
    meshVertex(verts, vertices[pair[1]], [0, 0, 1], color);
    return {
      type: "field_mesh",
      id: "cube_edge",
      vertices: verts,
      indices: [0, 1],
      topology: "line-list",
      color: color,
      edge_width: Number(config.edge_radius || 0.085)
    };
  }

  function vertexMesh(index, color) {
    var verts = [];
    meshVertex(verts, vertices[index], [0, 0, 1], color);
    return {
      type: "field_mesh",
      id: "cube_vertex",
      vertices: verts,
      indices: [0],
      topology: "point-list",
      color: color,
      vertex_size: Number(config.vertex_radius || 0.135)
    };
  }

  function displayPayload() {
    var meshes = [];
    var i;
    for (i = 0; i < FACE_COUNT; i += 1) {
      meshes.push(faceMesh(faces[i], faceBase));
    }
    for (i = 0; i < EDGE_COUNT; i += 1) {
      meshes.push(edgeMesh(edges[i], edgeBase));
    }
    for (i = 0; i < VERTEX_COUNT; i += 1) {
      meshes.push(vertexMesh(i, vertexBase));
    }
    var geom = {};
    geom[String(config.frame_id)] = {
      meshes: meshes,
      camera: {
        pos: camera.pos || [3.2, 2.4, 4.0],
        target: camera.target || [0, 0, 0],
        fov: Number(camera.fov || 42),
        up: camera.up || [0, 1, 0]
      },
      lights: [{
        pos: light.pos || [4, 5, 6],
        target: light.target || [0, 0, 0],
        orbit: light.orbit === true,
        orbit_radius: Number(light.orbit_radius || 4.5),
        height: Number(light.height || 3.2),
        theta: Number(light.theta || 0),
        angular_velocity: Number(light.angular_velocity || 0),
        model: light.model || "blinn_phong",
        color: light.color || "white"
      }],
      unified_renderer: true
    };
    return { screen: [], frames: {}, geom: geom };
  }

  function kindForObject(objectId) {
    if (objectId <= 0) { return "none"; }
    if (objectId <= FACE_COUNT) { return "face"; }
    if (objectId <= FACE_COUNT + EDGE_COUNT) { return "edge"; }
    if (objectId <= FACE_COUNT + EDGE_COUNT + VERTEX_COUNT) { return "vertex"; }
    return "none";
  }

  function indexForObject(objectId, kind) {
    if (kind === "face") { return objectId - 1; }
    if (kind === "edge") { return objectId - FACE_COUNT - 1; }
    if (kind === "vertex") { return objectId - FACE_COUNT - EDGE_COUNT - 1; }
    return -1;
  }

  function baseColorForObject(objectId) {
    var kind = kindForObject(objectId);
    if (kind === "face") { return faceBase; }
    if (kind === "edge") { return edgeBase; }
    if (kind === "vertex") { return vertexBase; }
    return null;
  }

  function hoverColorForObject(objectId) {
    var kind = kindForObject(objectId);
    if (kind === "face") { return faceHover; }
    if (kind === "edge") { return edgeHover; }
    if (kind === "vertex") { return vertexHover; }
    return null;
  }

  function applyColor(objectId, color) {
    if (!(objectId > 0) || !color) { return; }
    global.VfDisplay.applyRuntimePacket({
      kind: "geom.color.patch",
      payload: {
        frame_id: String(config.frame_id),
        object_id: objectId,
        color: color
      }
    });
  }

  function publishDebug(evt, objectId) {
    var kind = kindForObject(objectId);
    var index = indexForObject(objectId, kind);
    var text = [
      "hover=" + kind + ":" + String(index),
      "object_id=" + String(objectId),
      "simplex_id=" + String((evt && evt.simplex_id) || 0),
      "event=" + String((evt && evt.event) || ""),
      "x=" + String((evt && evt.x) || 0) + " y=" + String((evt && evt.y) || 0),
      "runtime=native-webgpu"
    ].join("\n");
    var state = {};
    state[String(config.debug_frame_id)] = {};
    state[String(config.debug_frame_id)][String(config.debug_widget_id)] = { text: text };
    global.VfWidgets.applyRuntimePacket({
      kind: "ui_state.replace",
      payload: { state: state }
    });
  }

  function updateHover(evt) {
    if (!evt || String(evt.frame_id || "") !== String(config.frame_id)) { return; }
    var objectId = Number(evt.object_id || 0) | 0;
    if (String(evt.event || "") === "leave") { objectId = 0; }
    if (objectId === hoverObjectId) { return; }
    applyColor(hoverObjectId, baseColorForObject(hoverObjectId));
    hoverObjectId = objectId;
    applyColor(hoverObjectId, hoverColorForObject(hoverObjectId));
    publishDebug(evt, objectId);
  }

  function boot() {
    requireRuntime();
    if (!global.__vfLocalOnlyFrameEvents) {
      global.__vfLocalOnlyFrameEvents = Object.create(null);
    }
    global.__vfLocalOnlyFrameEvents[String(config.frame_id)] = true;
    global.VfDisplay.renderFromJson(displayPayload());
    global.addEventListener("vf_event", function (event) {
      updateHover(event && event.detail);
    });
    publishDebug({ event: "ready", x: 0, y: 0, simplex_id: 0 }, 0);
  }

  function waitForFrames(attempt) {
    var frame = document.querySelector('.vf-frame[data-vf-frame-id="' + String(config.frame_id) + '"]');
    var debug = document.querySelector('.vf-frame[data-vf-frame-id="' + String(config.debug_frame_id) + '"]');
    if (frame && debug) {
      boot();
      return;
    }
    if (attempt > 240) {
      failFast("timed out waiting for cube frames");
    }
    global.setTimeout(function () { waitForFrames(attempt + 1); }, 16);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { waitForFrames(0); }, { once: true });
  } else {
    waitForFrames(0);
  }
})(typeof window !== "undefined" ? window : this);
