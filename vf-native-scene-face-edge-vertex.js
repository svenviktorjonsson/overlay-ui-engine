/*
 * vf-native-scene-face-edge-vertex.js — UI-engine runtime for the VKF
 * native_scene.kind = "face_edge_vertex_drag" declaration.
 */
(function (global) {
        "use strict";

        var config = global.__vfNativeFaceEdgeVertexConfig;
        if (!config || typeof config !== "object") {
          throw new Error("vf-native-scene-face-edge-vertex requires window.__vfNativeFaceEdgeVertexConfig");
        }
        if (!global.__vfGeomFrameIds) {
          global.__vfGeomFrameIds = Object.create(null);
        }
        global.__vfGeomFrameIds[String(config.frame_id)] = true;
        // WebGPU 2-D ortho in vf-geom-wgpu maps negative world-z into visible
        // depth in [0,1]. Keep the face furthest back, then edges, then
        // vertices nearest the viewer.
        var FACE_BASE_Z = -0.030;
        var FACE_OVERLAY_Z = -0.029;
        var EDGE_BASE_Z = -0.020;
        var EDGE_OVERLAY_Z = -0.019;
        var VERTEX_BASE_Z = -0.010;
        var VERTEX_OVERLAY_Z = -0.009;
        var VERTEX_SEGMENTS = 16;
        var FACE_TRIANGLE_COUNT = 2;
        var EDGE_TRIANGLE_COUNT = 2 + (VERTEX_SEGMENTS * 2);
        var VERTEX_TRIANGLE_COUNT = VERTEX_SEGMENTS;
        var UNIT_CIRCLE = makeUnitCircle(VERTEX_SEGMENTS);
        var MAX_BOOT_ATTEMPTS = 240;
        var TRANSPORT_PATH = "./vf-geom-ledger-transport.json";

        function pageLog(level, message) {
          var text = "ui_face_edge_vertex_drag: " + String(message);
          try {
            if (global.console) {
              if (level === "error" && global.console.error) {
                global.console.error(text);
              } else if (level === "warn" && global.console.warn) {
                global.console.warn(text);
              } else if (global.console.log) {
                global.console.log(text);
              }
            }
          } catch (_) {}
          try {
            if (global.chrome && global.chrome.webview && global.chrome.webview.postMessage) {
              global.chrome.webview.postMessage({ type: "vf_log", level: level, message: text });
            }
          } catch (_) {}
        }

        function failFast(message, error) {
          var text = String(message);
          if (error) {
            var extra = error && error.stack ? error.stack : (error && error.message ? error.message : String(error));
            text += "\n" + extra;
          }
          pageLog("error", text);
          throw new Error(text);
        }

        function requireDisplay() {
          if (!global.VfDisplay || typeof global.VfDisplay.renderFromJson !== "function") {
            failFast("VfDisplay.renderFromJson is unavailable; GPU display runtime not loaded");
          }
        }

        function requireGeomLedger() {
          if (!global.VfGeomLedger || typeof global.VfGeomLedger.createStore !== "function") {
            failFast("VfGeomLedger.createStore is unavailable; geometry ledger runtime not loaded");
          }
          if (typeof global.VfGeomLedger.createTransportStore !== "function") {
            failFast("VfGeomLedger.createTransportStore is unavailable; transport-backed ledger runtime not loaded");
          }
          if (typeof global.VfGeomLedger.createRafPresenter !== "function") {
            failFast("VfGeomLedger.createRafPresenter is unavailable; geometry ledger runtime not loaded");
          }
          if (typeof global.VfGeomLedger.createFaceEdgeVertexController !== "function") {
            failFast("VfGeomLedger.createFaceEdgeVertexController is unavailable; geometry ledger runtime not loaded");
          }
          if (typeof global.VfGeomLedger.createFaceEdgeVertexSharedStore !== "function") {
            failFast("VfGeomLedger.createFaceEdgeVertexSharedStore is unavailable; shared geometry ledger runtime not loaded");
          }
          if (!global.VfGeomLedgerLayout || !global.VfGeomLedgerLayout.FACE_EDGE_VERTEX_STATE_FORMAT) {
            failFast("VfGeomLedgerLayout is unavailable; shared geometry layout runtime not loaded");
          }
          if (!global.VfGeomLedgerTransport || typeof global.VfGeomLedgerTransport.createSharedBufferTransport !== "function") {
            failFast("VfGeomLedgerTransport.createSharedBufferTransport is unavailable; geometry ledger transport runtime not loaded");
          }
        }

        function loadGeomTransportDescriptor() {
          return fetch(TRANSPORT_PATH, { cache: "no-store" })
            .then(function (response) {
              if (!response.ok) {
                throw new Error("HTTP " + String(response.status) + " while loading " + TRANSPORT_PATH);
              }
              return response.json();
            })
            .then(function (descriptor) {
              if (!descriptor || typeof descriptor !== "object") {
                throw new Error("geometry transport descriptor is not an object");
              }
              if (String(descriptor.kind || "") !== "shared-buffer") {
                throw new Error("geometry transport kind must be shared-buffer for this example");
              }
              return descriptor;
            });
        }

        function sceneWindow() {
          var frame = document.querySelector('.vf-frame[data-vf-frame-id="' + config.frame_id + '"]');
          var body = frame ? (frame.querySelector(".vf-frame__body") || frame) : null;
          var canvas = body ? body.querySelector("canvas.vf-geom-canvas") : null;
          var rect = canvas && typeof canvas.getBoundingClientRect === "function"
            ? canvas.getBoundingClientRect()
            : (body && typeof body.getBoundingClientRect === "function" ? body.getBoundingClientRect() : null);
          var w = canvas && Number(canvas.width) > 0
            ? Number(canvas.width)
            : (rect ? Math.max(1, Math.round(Number(rect.width) || 1)) : (body ? Math.max(1, Number(body.clientWidth) || 1) : 1));
          var h = canvas && Number(canvas.height) > 0
            ? Number(canvas.height)
            : (rect ? Math.max(1, Math.round(Number(rect.height) || 1)) : (body ? Math.max(1, Number(body.clientHeight) || 1) : 1));
          var aspect = "";
          if (frame && frame.dataset && frame.dataset.vfAspect) {
            aspect = String(frame.dataset.vfAspect || "").trim().toLowerCase();
          } else {
            aspect = String(config.aspect || "").trim().toLowerCase();
          }
          if (aspect !== "equal") {
            return {
              width: w,
              height: h,
              fitSize: Math.min(w, h),
              left: 0,
              top: 0,
              sx: 1.0,
              sy: 1.0
            };
          }
          var fitSize = Math.max(1, Math.min(w, h));
          var left = (w - fitSize) * 0.5;
          var top = (h - fitSize) * 0.5;
          return {
            width: w,
            height: h,
            fitSize: fitSize,
            left: left,
            top: top,
            sx: fitSize / w,
            sy: fitSize / h
          };
        }

        function clipPoint(p) {
          var view = sceneWindow();
          return [
            (((view.left + Number(p[0]) * view.fitSize) / view.width) * 2) - 1,
            1 - (((view.top + Number(p[1]) * view.fitSize) / view.height) * 2)
          ];
        }

        function makeUnitCircle(segments) {
          var count = Math.max(3, Number(segments) | 0);
          var table = new Array(count);
          for (var i = 0; i < count; i += 1) {
            var angle = (i / count) * Math.PI * 2;
            table[i] = [Math.cos(angle), Math.sin(angle)];
          }
          return table;
        }

        function pushVertex(vertices, point, z, color) {
          vertices.push(
            Number(point[0]),
            Number(point[1]),
            Number(z),
            0.0, 0.0, 1.0,
            Number(color[0]),
            Number(color[1]),
            Number(color[2]),
            Number(color[3])
          );
          return (vertices.length / 10) - 1;
        }

        function pushTriangle(vertices, indices, primitiveMeta, a, b, c, z, color, kind, index) {
          var base = vertices.length / 10;
          pushVertex(vertices, a, z, color);
          pushVertex(vertices, b, z, color);
          pushVertex(vertices, c, z, color);
          indices.push(base, base + 1, base + 2);
          primitiveMeta.push({ kind: kind, index: index });
        }

        function pushQuad(vertices, indices, primitiveMeta, a, b, c, d, z, color, kind, index) {
          pushTriangle(vertices, indices, primitiveMeta, a, b, c, z, color, kind, index);
          pushTriangle(vertices, indices, primitiveMeta, a, c, d, z, color, kind, index);
        }

        function polygonArea2(points) {
          var sum = 0.0;
          for (var i = 0; i < points.length; i += 1) {
            var p = points[i];
            var q = points[(i + 1) % points.length];
            sum += (Number(p[0]) * Number(q[1])) - (Number(q[0]) * Number(p[1]));
          }
          return sum;
        }

        function cross2(a, b, c) {
          return (Number(b[0]) - Number(a[0])) * (Number(c[1]) - Number(a[1])) -
            (Number(b[1]) - Number(a[1])) * (Number(c[0]) - Number(a[0]));
        }

        function pointInTriangle2(p, a, b, c) {
          var c1 = cross2(a, b, p);
          var c2 = cross2(b, c, p);
          var c3 = cross2(c, a, p);
          var hasNeg = (c1 < 0) || (c2 < 0) || (c3 < 0);
          var hasPos = (c1 > 0) || (c2 > 0) || (c3 > 0);
          return !(hasNeg && hasPos);
        }

        function pushFacePolygon(vertices, indices, primitiveMeta, points, z, color, kind, index) {
          if (!Array.isArray(points) || points.length < 3) {
            return;
          }
          if (points.length === 3) {
            pushTriangle(vertices, indices, primitiveMeta, points[0], points[1], points[2], z, color, kind, index);
            return;
          }
          var winding = polygonArea2(points) >= 0 ? 1 : -1;
          var remaining = [];
          for (var i = 0; i < points.length; i += 1) {
            remaining.push(i);
          }
          var guard = 0;
          while (remaining.length > 3 && guard < 32) {
            guard += 1;
            var earClipped = false;
            for (var r = 0; r < remaining.length; r += 1) {
              var ia = remaining[(r + remaining.length - 1) % remaining.length];
              var ib = remaining[r];
              var ic = remaining[(r + 1) % remaining.length];
              var a = points[ia];
              var b = points[ib];
              var c = points[ic];
              var turn = cross2(a, b, c);
              if ((winding > 0 && turn <= 1e-9) || (winding < 0 && turn >= -1e-9)) {
                continue;
              }
              var containsOther = false;
              for (var t = 0; t < remaining.length; t += 1) {
                var ip = remaining[t];
                if (ip === ia || ip === ib || ip === ic) {
                  continue;
                }
                if (pointInTriangle2(points[ip], a, b, c)) {
                  containsOther = true;
                  break;
                }
              }
              if (containsOther) {
                continue;
              }
              pushTriangle(vertices, indices, primitiveMeta, a, b, c, z, color, kind, index);
              remaining.splice(r, 1);
              earClipped = true;
              break;
            }
            if (!earClipped) {
              break;
            }
          }
          if (remaining.length === 3) {
            pushTriangle(
              vertices,
              indices,
              primitiveMeta,
              points[remaining[0]],
              points[remaining[1]],
              points[remaining[2]],
              z,
              color,
              kind,
              index
            );
            return;
          }
          for (var fallback = 1; fallback + 1 < points.length; fallback += 1) {
            pushTriangle(vertices, indices, primitiveMeta, points[0], points[fallback], points[fallback + 1], z, color, kind, index);
          }
        }

        function createFieldMeshBuffer(id, objectId, triangleCount, transparent) {
          var vertexCount = triangleCount * 3;
          var indices = new Uint32Array(vertexCount);
          for (var i = 0; i < vertexCount; i += 1) {
            indices[i] = i;
          }
          return {
            type: "field_mesh",
            id: id,
            object_id: objectId,
            mode3d: false,
            topology: "triangle-list",
            vertices: new Float32Array(vertexCount * 10),
            indices: indices,
            transparent: !!transparent,
            pickable: !transparent,
            depth_write: true,
            alpha: 1.0,
            alpha_mul: 1.0,
            alpha_provider: null,
            _vfTriangleCount: triangleCount,
            _vfTriangleCursor: 0
          };
        }

        function resetFieldMesh(mesh) {
          mesh._vfTriangleCursor = 0;
        }

        function writeMeshVertex(dst, vertexIndex, point, z, color) {
          var offset = vertexIndex * 10;
          dst[offset + 0] = Number(point[0]);
          dst[offset + 1] = Number(point[1]);
          dst[offset + 2] = Number(z);
          dst[offset + 3] = 0.0;
          dst[offset + 4] = 0.0;
          dst[offset + 5] = 1.0;
          dst[offset + 6] = Number(color[0]);
          dst[offset + 7] = Number(color[1]);
          dst[offset + 8] = Number(color[2]);
          dst[offset + 9] = Number(color[3]);
        }

        function writeMeshTriangle(mesh, a, b, c, z, color) {
          var triIndex = mesh._vfTriangleCursor || 0;
          if (triIndex >= mesh._vfTriangleCount) {
            return;
          }
          var baseVertex = triIndex * 3;
          writeMeshVertex(mesh.vertices, baseVertex + 0, a, z, color);
          writeMeshVertex(mesh.vertices, baseVertex + 1, b, z, color);
          writeMeshVertex(mesh.vertices, baseVertex + 2, c, z, color);
          mesh._vfTriangleCursor = triIndex + 1;
        }

        function zeroRemainingMeshTriangles(mesh) {
          var triIndex = mesh._vfTriangleCursor || 0;
          while (triIndex < mesh._vfTriangleCount) {
            var baseVertex = triIndex * 3;
            writeMeshVertex(mesh.vertices, baseVertex + 0, [0, 0], 0, [0, 0, 0, 0]);
            writeMeshVertex(mesh.vertices, baseVertex + 1, [0, 0], 0, [0, 0, 0, 0]);
            writeMeshVertex(mesh.vertices, baseVertex + 2, [0, 0], 0, [0, 0, 0, 0]);
            triIndex += 1;
          }
          mesh._vfTriangleCursor = mesh._vfTriangleCount;
        }

        function segmentIntersection2(a, b, c, d) {
          var ax = Number(a[0]); var ay = Number(a[1]);
          var bx = Number(b[0]); var by = Number(b[1]);
          var cx = Number(c[0]); var cy = Number(c[1]);
          var dx = Number(d[0]); var dy = Number(d[1]);
          var rX = bx - ax;
          var rY = by - ay;
          var sX = dx - cx;
          var sY = dy - cy;
          var denom = (rX * sY) - (rY * sX);
          if (Math.abs(denom) < 1e-9) {
            return null;
          }
          var qpx = cx - ax;
          var qpy = cy - ay;
          var t = ((qpx * sY) - (qpy * sX)) / denom;
          var u = ((qpx * rY) - (qpy * rX)) / denom;
          if (t <= 1e-6 || t >= (1 - 1e-6) || u <= 1e-6 || u >= (1 - 1e-6)) {
            return null;
          }
          return [ax + (t * rX), ay + (t * rY)];
        }

        function triangulateQuad(points) {
          var hitABCD = segmentIntersection2(points[0], points[1], points[2], points[3]);
          if (hitABCD) {
            return [
              [points[0], points[3], hitABCD],
              [points[1], points[2], hitABCD]
            ];
          }
          var hitBCDA = segmentIntersection2(points[1], points[2], points[3], points[0]);
          if (hitBCDA) {
            return [
              [points[1], points[0], hitBCDA],
              [points[2], points[3], hitBCDA]
            ];
          }
          var winding = polygonArea2(points) >= 0 ? 1 : -1;
          for (var i = 0; i < 4; i += 1) {
            var ia = (i + 3) % 4;
            var ib = i;
            var ic = (i + 1) % 4;
            var id = (i + 2) % 4;
            var a = points[ia];
            var b = points[ib];
            var c = points[ic];
            var d = points[id];
            var turn = cross2(a, b, c);
            if ((winding > 0 && turn <= 1e-9) || (winding < 0 && turn >= -1e-9)) {
              continue;
            }
            if (pointInTriangle2(d, a, b, c)) {
              continue;
            }
            return [
              [a, b, c],
              [a, c, d]
            ];
          }
          return [
            [points[0], points[1], points[2]],
            [points[0], points[2], points[3]]
          ];
        }

        function writeFaceMesh(mesh, faceClip, z, color) {
          resetFieldMesh(mesh);
          var triangles = triangulateQuad(faceClip);
          for (var i = 0; i < triangles.length; i += 1) {
            writeMeshTriangle(mesh, triangles[i][0], triangles[i][1], triangles[i][2], z, color);
          }
          zeroRemainingMeshTriangles(mesh);
        }

        function writeCircleMesh(mesh, centerNorm, radius, segments, z, color) {
          resetFieldMesh(mesh);
          var center = clipPoint(centerNorm);
          var cx = Number(centerNorm[0]);
          var cy = Number(centerNorm[1]);
          var unitCircle = Number(segments) === VERTEX_SEGMENTS ? UNIT_CIRCLE : makeUnitCircle(segments);
          for (var i = 0; i < unitCircle.length; i += 1) {
            var p0u = unitCircle[i];
            var p1u = unitCircle[(i + 1) % unitCircle.length];
            var p0 = clipPoint([
              cx + p0u[0] * Number(radius),
              cy + p0u[1] * Number(radius)
            ]);
            var p1 = clipPoint([
              cx + p1u[0] * Number(radius),
              cy + p1u[1] * Number(radius)
            ]);
            writeMeshTriangle(mesh, center, p0, p1, z, color);
          }
          zeroRemainingMeshTriangles(mesh);
        }

        function writeCapsuleMesh(mesh, aNorm, bNorm, radiusNorm, z, color) {
          resetFieldMesh(mesh);
          var ax = Number(aNorm[0]);
          var ay = Number(aNorm[1]);
          var bx = Number(bNorm[0]);
          var by = Number(bNorm[1]);
          var dx = bx - ax;
          var dy = by - ay;
          var len = Math.sqrt(dx * dx + dy * dy);
          var px;
          var py;
          if (!(len > 0)) {
            px = Number(radiusNorm);
            py = 0;
          } else {
            var ux = dx / len;
            var uy = dy / len;
            px = -uy * Number(radiusNorm);
            py = ux * Number(radiusNorm);
          }
          var q0 = clipPoint([ax + px, ay + py]);
          var q1 = clipPoint([bx + px, by + py]);
          var q2 = clipPoint([bx - px, by - py]);
          var q3 = clipPoint([ax - px, ay - py]);
          writeMeshTriangle(mesh, q0, q1, q2, z, color);
          writeMeshTriangle(mesh, q0, q2, q3, z, color);
          var circleCenters = [aNorm, bNorm];
          for (var ci = 0; ci < circleCenters.length; ci += 1) {
            var centerNorm = circleCenters[ci];
            var center = clipPoint(centerNorm);
            var ccx = Number(centerNorm[0]);
            var ccy = Number(centerNorm[1]);
            for (var seg = 0; seg < UNIT_CIRCLE.length; seg += 1) {
              var p0u = UNIT_CIRCLE[seg];
              var p1u = UNIT_CIRCLE[(seg + 1) % UNIT_CIRCLE.length];
              var p0 = clipPoint([
                ccx + p0u[0] * Number(radiusNorm),
                ccy + p0u[1] * Number(radiusNorm)
              ]);
              var p1 = clipPoint([
                ccx + p1u[0] * Number(radiusNorm),
                ccy + p1u[1] * Number(radiusNorm)
              ]);
              writeMeshTriangle(mesh, center, p0, p1, z, color);
            }
          }
          zeroRemainingMeshTriangles(mesh);
        }

        function boot(sharedBuffers) {
          requireDisplay();
          requireGeomLedger();
          pageLog("info", "boot: checking frames");
          if (!global.__vfLocalOnlyFrameEvents) {
            global.__vfLocalOnlyFrameEvents = Object.create(null);
          }
          global.__vfLocalOnlyFrameEvents[config.frame_id] = true;
          var frame = document.querySelector('.vf-frame[data-vf-frame-id="' + config.frame_id + '"]');
          var debugFrame = document.querySelector('.vf-frame[data-vf-frame-id="' + config.debug_frame_id + '"]');
          var debugArea = debugFrame ? debugFrame.querySelector("textarea") : document.querySelector("textarea");
          if (!frame || !debugArea) {
            return false;
          }

          var geomBody = frame.querySelector(".vf-frame__body") || frame;
          var resizeObserver = null;
          var resizeRaf = 0;
          var controller = global.VfGeomLedger.createFaceEdgeVertexController({
            points: config.points,
            edgePairs: config.edge_pairs,
            dragConfig: config.drag || {}
          });

          if (!sharedBuffers || !sharedBuffers.headerBuffer || !sharedBuffers.stateBuffer) {
            failFast("shared geometry buffers not available from host");
          }

          if (!global.__vfGeomTransportDescriptor || String(global.__vfGeomTransportDescriptor.kind || "") !== "shared-buffer") {
            failFast("geometry transport descriptor must require shared-buffer for this example");
          }

          var ledger = global.VfGeomLedger.createFaceEdgeVertexSharedStore({
            headerBuffer: sharedBuffers.headerBuffer,
            stateBuffer: sharedBuffers.stateBuffer,
            points: config.points,
            edgePairs: config.edge_pairs,
            buildSnapshot: function (state) {
              return {
                geomSpec: currentGeomSpec()
              };
            }
          });
          var state = ledger.readState();
          var lastDebugText = "";
          var lastDebugPaintTs = -1;
          var presenter = global.VfGeomLedger.createRafPresenter(ledger, function (snapshot) {
            var now = (global.performance && typeof global.performance.now === "function")
              ? global.performance.now()
              : Date.now();
            var dragging = !!(state && state.drag && state.drag.active);
            var nextDebugText = null;
            var debugChanged = false;
            if (!dragging || lastDebugPaintTs < 0 || (now - lastDebugPaintTs) >= 80) {
              nextDebugText = controller.buildDebugText(state);
              debugChanged = nextDebugText !== lastDebugText;
            }
            if (debugChanged && (!dragging || lastDebugPaintTs < 0 || (now - lastDebugPaintTs) >= 80)) {
              debugArea.value = nextDebugText;
              debugArea.scrollTop = 0;
              lastDebugText = nextDebugText;
              lastDebugPaintTs = now;
            }
          });

          function requestRenderForResize() {
            if (resizeRaf) {
              return;
            }
            resizeRaf = global.requestAnimationFrame(function () {
              resizeRaf = 0;
              ledger.touch();
            });
          }

          function styleState(kind, index) {
            var hovered = state.hover && state.hover.kind === kind && Number(state.hover.index) === Number(index);
            var selected = false;
            if (kind === "face") {
              selected = !!(state.selection && state.selection.faceSelected);
            } else if (kind === "edge") {
              selected = !!(state.selection && state.selection.edgeSelected && state.selection.edgeSelected[index]);
            } else if (kind === "vertex") {
              selected = !!(state.selection && state.selection.vertexSelected && state.selection.vertexSelected[index]);
            }
            if (selected) {
              return "selected";
            }
            if (hovered) {
              return "hover";
            }
            return "none";
          }

          function styleConfig(kind) {
            var styles = config.styles || {};
            var style = styles[kind];
            if (!style) {
              failFast("missing VKF style config for kind " + String(kind));
            }
            return style;
          }

          function styleColor(kind, layer, index) {
            var style = styleConfig(kind);
            if (layer === "base") {
              return style.base_color;
            }
            var stateKey = styleState(kind, index);
            var overlayColors = style.overlay_colors || {};
            var color = overlayColors[stateKey];
            if (!Array.isArray(color) || color.length !== 4) {
              failFast("missing overlay color for " + String(kind) + " state " + String(stateKey));
            }
            return color;
          }

          function styleScale(kind, layer, index) {
            var style = styleConfig(kind);
            if (kind === "face") {
              return 0.0;
            }
            if (layer === "base") {
              return Number(style.base_scale);
            }
            var stateKey = styleState(kind, index);
            var overlayScales = style.overlay_scales || {};
            var value = Number(overlayScales[stateKey]);
            if (!(value > 0)) {
              failFast("missing overlay scale for " + String(kind) + " state " + String(stateKey));
            }
            return value;
          }

          function meshObjectId(kind, index) {
            if (kind === "face") { return 1; }
            if (kind === "edge") { return index + 2; }
            if (kind === "vertex") { return index + 6; }
            failFast("unknown object id mesh kind " + String(kind));
          }

          function createSceneCache() {
            var meshes = [
              createFieldMeshBuffer("face_edge_vertex_drag_face_0_base", meshObjectId("face", 0), FACE_TRIANGLE_COUNT, false),
              createFieldMeshBuffer("face_edge_vertex_drag_face_0_overlay", meshObjectId("face", 0), FACE_TRIANGLE_COUNT, true)
            ];
            for (var edgeIndex = 0; edgeIndex < 4; edgeIndex += 1) {
              meshes.push(createFieldMeshBuffer("face_edge_vertex_drag_edge_" + String(edgeIndex) + "_base", meshObjectId("edge", edgeIndex), EDGE_TRIANGLE_COUNT, false));
              meshes.push(createFieldMeshBuffer("face_edge_vertex_drag_edge_" + String(edgeIndex) + "_overlay", meshObjectId("edge", edgeIndex), EDGE_TRIANGLE_COUNT, true));
            }
            for (var vertexIndex = 0; vertexIndex < 4; vertexIndex += 1) {
              meshes.push(createFieldMeshBuffer("face_edge_vertex_drag_vertex_" + String(vertexIndex) + "_base", meshObjectId("vertex", vertexIndex), VERTEX_TRIANGLE_COUNT, false));
              meshes.push(createFieldMeshBuffer("face_edge_vertex_drag_vertex_" + String(vertexIndex) + "_overlay", meshObjectId("vertex", vertexIndex), VERTEX_TRIANGLE_COUNT, true));
            }
            return {
              unified_renderer: true,
              meshes: meshes
            };
          }

          var sceneCache = createSceneCache();

          function currentGeomSpec() {
            var faceClip = state.points.map(clipPoint);
            writeFaceMesh(sceneCache.meshes[0], faceClip, FACE_BASE_Z, styleColor("face", "base", 0));
            writeFaceMesh(sceneCache.meshes[1], faceClip, FACE_OVERLAY_Z, styleColor("face", "overlay", 0));
            var meshIndex = 2;
            for (var edgeIndex = 0; edgeIndex < 4; edgeIndex += 1) {
              var pair = state.edgePairs[edgeIndex];
              writeCapsuleMesh(
                sceneCache.meshes[meshIndex],
                state.points[pair[0]],
                state.points[pair[1]],
                styleScale("edge", "base", edgeIndex),
                EDGE_BASE_Z,
                styleColor("edge", "base", edgeIndex)
              );
              meshIndex += 1;
              writeCapsuleMesh(
                sceneCache.meshes[meshIndex],
                state.points[pair[0]],
                state.points[pair[1]],
                styleScale("edge", "overlay", edgeIndex),
                EDGE_OVERLAY_Z,
                styleColor("edge", "overlay", edgeIndex)
              );
              meshIndex += 1;
            }
            for (var vertexIndex = 0; vertexIndex < 4; vertexIndex += 1) {
              writeCircleMesh(
                sceneCache.meshes[meshIndex],
                state.points[vertexIndex],
                styleScale("vertex", "base", vertexIndex),
                VERTEX_SEGMENTS,
                VERTEX_BASE_Z,
                styleColor("vertex", "base", vertexIndex)
              );
              meshIndex += 1;
              writeCircleMesh(
                sceneCache.meshes[meshIndex],
                state.points[vertexIndex],
                styleScale("vertex", "overlay", vertexIndex),
                VERTEX_SEGMENTS,
                VERTEX_OVERLAY_Z,
                styleColor("vertex", "overlay", vertexIndex)
              );
              meshIndex += 1;
            }
            return sceneCache;
          }

          function handleVfEvent(ev) {
            var payload = ev && ev.detail ? ev.detail : null;
            if (!payload || String(payload.frame_id || "") !== config.frame_id) {
              return;
            }
            ledger.mutate(function () {
              return controller.applyEvent(state, payload);
            });
          }

          global.addEventListener("vf_event", handleVfEvent);
          if (!global.VfDisplay || typeof global.VfDisplay.mountLedgerGeomFrame !== "function") {
            failFast("VfDisplay.mountLedgerGeomFrame is missing");
          }
          global.VfDisplay.mountLedgerGeomFrame(config.frame_id, ledger, function (snapshot) {
            return snapshot.geomSpec;
          });
          if (typeof global.ResizeObserver === "function" && geomBody) {
            resizeObserver = new global.ResizeObserver(function () {
              requestRenderForResize();
            });
            resizeObserver.observe(geomBody);
          }
          global.addEventListener("beforeunload", function () {
            try {
              if (global.__vfLocalOnlyFrameEvents) {
                delete global.__vfLocalOnlyFrameEvents[config.frame_id];
              }
            } catch (_) {}
            if (presenter) {
              try { presenter.dispose(); } catch (_) {}
            }
            if (resizeObserver) {
              try { resizeObserver.disconnect(); } catch (_) {}
              resizeObserver = null;
            }
          }, { once: true });
          presenter.request();
          pageLog("info", "boot: complete");
          return true;
        }

        function waitForFrame(sharedBuffers, attempt) {
          pageLog("info", "waitForFrame attempt=" + String(attempt));
          if (!global.VfDisplay || typeof global.VfDisplay.renderFromJson !== "function") {
            if (Number(attempt) >= MAX_BOOT_ATTEMPTS) {
              failFast("VfDisplay.renderFromJson never became available");
            }
            global.setTimeout(function () { waitForFrame(sharedBuffers, Number(attempt) + 1); }, 16);
            return;
          }
          if (boot(sharedBuffers)) return;
          if (Number(attempt) >= MAX_BOOT_ATTEMPTS) {
            failFast("expected frames " + config.frame_id + " and " + config.debug_frame_id + " were not created");
          }
          global.setTimeout(function () { waitForFrame(sharedBuffers, Number(attempt) + 1); }, 16);
        }

        function startWhenReady() {
          pageLog("info", "startWhenReady");
          var shell = global.VfRuntimeShell || null;
          if (shell && typeof shell.ensureSceneDependencies === "function") {
            shell.ensureSceneDependencies().then(function () {
              pageLog("info", "scene dependencies ready");
              return loadGeomTransportDescriptor();
            }).then(function (descriptor) {
              global.__vfGeomTransportDescriptor = descriptor;
              if (typeof shell.requestSharedBuffers !== "function" || typeof shell.waitForSharedBuffers !== "function") {
                failFast("VfRuntimeShell shared buffer bridge unavailable");
              }
              shell.requestSharedBuffers("scene", config.frame_id);
              return shell.waitForSharedBuffers("scene", config.frame_id);
            }).then(function (sharedBuffers) {
              pageLog("info", "shared buffers resolved");
              waitForFrame(sharedBuffers, 0);
            }).catch(function (error) {
              failFast("scene dependency bootstrap failed", error);
            });
            return;
          }
          loadGeomTransportDescriptor().then(function (descriptor) {
            global.__vfGeomTransportDescriptor = descriptor;
            if (!global.VfRuntimeShell || typeof global.VfRuntimeShell.requestSharedBuffers !== "function" || typeof global.VfRuntimeShell.waitForSharedBuffers !== "function") {
              failFast("VfRuntimeShell shared buffer bridge unavailable");
            }
            global.VfRuntimeShell.requestSharedBuffers("scene", config.frame_id);
            return global.VfRuntimeShell.waitForSharedBuffers("scene", config.frame_id);
          }).then(function (sharedBuffers) {
            pageLog("info", "shared buffers resolved");
            waitForFrame(sharedBuffers, 0);
          }).catch(function (error) {
            failFast("geometry transport bootstrap failed", error);
          });
        }

        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", startWhenReady, { once: true });
        } else {
          startWhenReady();
        }
      })(typeof window !== "undefined" ? window : this);
