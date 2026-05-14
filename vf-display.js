/**
 * vf-display.js — renders from vf-display.json.
 *
 * JSON structure:
 *   { "screen": [...2D ops],
 *     "frames": { "<frame_id>": [...2D ops] },
 *     "geom":   { "<frame_id>": { meshes:[...], camera:{...}, lights:[...] } }
 *   }
 *
 * Each mesh in geom.meshes can carry:
 *   { type:"box|ellipsoid|torus|field_mesh", center:[x,y,z], scale:[sx,sy,sz], color:"red", rotation:[rx,ry,rz], ... }
 *   rotation = Euler degrees [rx, ry, rz] applied ZYX.
 *
 * Each mesh gets its own VfGeomWgpu renderer so model matrices are independent.
 */
(function (global) {
  "use strict";

  // ── Logging ───────────────────────────────────────────────────────────────
  function vlog(level, text) {
    var s = "[vf-display] " + String(text);
    try {
      if (global.console) {
        if (level === "error" && global.console.error) { global.console.error(s); return; }
        if (level === "warn"  && global.console.warn)  { global.console.warn(s);  return; }
        if (global.console.log) { global.console.log(s); }
      }
    } catch (_) {}
    // Also forward to C++ host via webview postMessage (same path as vf-log.js)
    try {
      if (global.chrome && global.chrome.webview && global.chrome.webview.postMessage) {
        global.chrome.webview.postMessage({ type: "vf_log", level: level, message: s, t: Date.now() });
      }
    } catch (_) {}
  }

  vlog("info", "vf-display.js loaded");

  // ── State ─────────────────────────────────────────────────────────────────
  var ctxCache = new WeakMap();
  // frame_id -> { entries: [{renderer, ref}] }
  var frameRecs = {};
  var _lastPayloadSummary = "";   // cheap change-detect for log spam suppression

  // ── Event forwarding seam ─────────────────────────────────────────────────
  // Rendering owns event semantics; transport owns delivery.
  var _eventSink = {
    postEvent: function () {}
  };

  function setEventSink(sink) {
    if (sink && typeof sink.postEvent === "function") {
      _eventSink = sink;
      return;
    }
    _eventSink = { postEvent: function () {} };
  }

  function postEvent(evt) {
    try {
      _eventSink.postEvent(evt);
    } catch (_) {}
  }

  var HOVER_MASK = {
    FRAME: 1,
    OBJECT: 2,
    FACE: 4,
    EDGE: 8,
    VERTEX: 16
  };

  function hoverContext(opts) {
    opts = opts || {};
    var frameId = opts.frame_id != null ? String(opts.frame_id) : "";
    var objectId = opts.object_id != null ? opts.object_id : 0;
    var vertexId = opts.vertex_id != null ? opts.vertex_id : null;
    var edgeId = opts.edge_id != null ? opts.edge_id : null;
    var faceId = opts.face_id != null ? opts.face_id : null;
    if ((vertexId != null || edgeId != null) && faceId == null && objectId !== 0 && objectId !== "" && objectId != null) {
      faceId = 0;
    }
    var mask = frameId ? HOVER_MASK.FRAME : 0;
    if (objectId !== 0 && objectId !== "" && objectId != null) { mask |= HOVER_MASK.OBJECT; }
    if (faceId != null) { mask |= HOVER_MASK.FACE; }
    if (edgeId != null) { mask |= HOVER_MASK.EDGE; }
    if (vertexId != null) { mask |= HOVER_MASK.VERTEX; }
    return {
      kind: opts.kind || (vertexId != null ? "vertex" : edgeId != null ? "edge" : faceId != null ? "face" : objectId ? "object" : frameId ? "frame" : "none"),
      mask: mask,
      frame_id: frameId,
      object_id: objectId,
      vertex_id: vertexId,
      edge_id: edgeId,
      face_id: faceId,
      simplex_id: opts.simplex_id != null ? opts.simplex_id : (faceId != null ? faceId : edgeId != null ? edgeId : vertexId != null ? vertexId : 0)
    };
  }

  function withHoverContext(evt, hover) {
    evt.hover = hover || hoverContext({ frame_id: evt.frame_id });
    evt.hover_mask = evt.hover.mask;
    evt.frame_id = evt.hover.frame_id;
    evt.object_id = evt.hover.object_id;
    evt.simplex_id = evt.hover.simplex_id;
    if (evt.hover.vertex_id != null) { evt.vertex_id = evt.hover.vertex_id; }
    if (evt.hover.edge_id != null) { evt.edge_id = evt.hover.edge_id; }
    if (evt.hover.face_id != null) { evt.face_id = evt.hover.face_id; }
    return evt;
  }

  /** Convert a canvas-relative MouseEvent to the { frame_id, object_id, simplex_id }
   *  by firing a pickAt on the renderer that owns that canvas. */
  function resolvePickAt(canvas, cx, cy, fid, rendererIdx) {
    var rec = frameRecs[fid];
    if (!rec || rendererIdx >= rec.entries.length) { return null; }
    return rec.entries[rendererIdx].renderer;
  }

  /** Attach mouse/wheel listeners to a geom canvas.
   *  Multiple overlapping geom canvases per frame are each listened to. */
  function attachCanvasEvents(canvas, fid, meshIdx) {
    // Avoid double-attach
    if (canvas.__vfEventsAttached) { return; }
    canvas.__vfEventsAttached = true;
    canvas.style.pointerEvents = "auto";  // enable pointer events for geom canvases

    function canvasXY(e) {
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function canvasXYscaled(e) {
      // Account for CSS pixels vs device pixels
      var r  = canvas.getBoundingClientRect();
      var sx = canvas.width  / (r.width  || 1);
      var sy = canvas.height / (r.height || 1);
      return {
        x:  (e.clientX - r.left) * sx,
        y:  (e.clientY - r.top)  * sy,
        cx: e.clientX - r.left,
        cy: e.clientY - r.top,
      };
    }

    function emitWithPick(evtType, e, extra) {
      var p = canvasXYscaled(e);
      var mods = {
        ctrl: !!(e && e.ctrlKey),
        shift: !!(e && e.shiftKey),
        alt: !!(e && e.altKey),
        meta: !!(e && e.metaKey)
      };
      var renderer = resolvePickAt(canvas, p.x, p.y, fid, meshIdx);
      if (!renderer) {
        postEvent(withHoverContext(Object.assign({ type: "vf_event", event: evtType,
          x: p.cx, y: p.cy, frame_id: fid }, mods, extra), hoverContext({ frame_id: fid })));
        return;
      }
      renderer.pickAt(p.x, p.y, function(oid, sid) {
        var hover = hoverContext({
          frame_id: fid,
          object_id: oid,
          face_id: oid ? sid : null,
          simplex_id: sid,
          kind: oid ? "face" : "frame"
        });
        postEvent(withHoverContext(Object.assign({ type: "vf_event", event: evtType,
          x: p.cx, y: p.cy, frame_id: fid }, mods, extra), hover));
      });
    }

    canvas.addEventListener("mousemove", function(e) {
      // Move must be low-latency; do not gate it on async GPU picking.
      var p = canvasXY(e);
      postEvent(withHoverContext({
        type: "vf_event",
        event: "move",
        x: p.x,
        y: p.y,
        frame_id: fid,
        buttons: Number(e.buttons) || 0,
        ctrl: !!e.ctrlKey,
        shift: !!e.shiftKey,
        alt: !!e.altKey,
        meta: !!e.metaKey
      }, hoverContext({ frame_id: fid })));
    }, { passive: true });

    canvas.addEventListener("mousedown", function(e) {
      emitWithPick("down", e, { button: e.button });
    }, { passive: true });

    canvas.addEventListener("mouseup", function(e) {
      emitWithPick("up", e, { button: e.button });
    }, { passive: true });

    canvas.addEventListener("wheel", function(e) {
      try { e.__vfHandledWheel = true; } catch(_) {}
      var p = canvasXY(e);
      var step = e.deltaY > 0 ? 1 : -1;
      if (e && typeof e.preventDefault === "function") { e.preventDefault(); }
      postEvent(withHoverContext({ type: "vf_event", event: "wheel",
        x: p.x, y: p.y, step: step, delta: Number(e.deltaY) || 0,
        ctrl: !!e.ctrlKey, frame_id: fid }, hoverContext({ frame_id: fid })));
    }, { passive: false });

    vlog("info", "attachCanvasEvents: frame=" + fid + " meshIdx=" + meshIdx);
  }

  function vec3Add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function vec3Sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vec3Scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function vec3Cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function vec3Len(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
  function vec3Norm(a) {
    var l = vec3Len(a);
    if (l < 1e-9) { return [0, 0, -1]; }
    return [a[0] / l, a[1] / l, a[2] / l];
  }

  function syncGameCamera(fid, camera) {
    if (global.VfGameCamera && typeof global.VfGameCamera.sync === "function") {
      return global.VfGameCamera.sync(fid, camera);
    }
    return null;
  }

  function ensureGameCameraControls(canvas, fid, camera) {
    if (global.VfGameCamera && typeof global.VfGameCamera.attach === "function") {
      global.VfGameCamera.attach(canvas, fid, camera, { findFrameEl: findFrameEl, log: vlog });
    }
  }
  // ── 2-D canvas helpers ────────────────────────────────────────────────────
  function get2d(canvas) {
    if (!canvas) { return null; }
    var c = ctxCache.get(canvas);
    if (c) { return c; }
    c = canvas.getContext("2d", { alpha: true });
    if (c) { ctxCache.set(canvas, c); }
    return c;
  }

  function normToPx(rect, w, h) {
    if (!rect || rect.length < 4) { return null; }
    return { x: rect[0]*w, y: rect[1]*h, rw: rect[2]*w, rh: rect[3]*h };
  }

  var _interactive2d = Object.create(null);
  var _pendingDragPosts = Object.create(null);

  function postDragEventCoalesced(frameId, evt) {
    var key = String(frameId || "__screen__");
    var pending = _pendingDragPosts[key];
    if (pending && pending.evt) {
      var dx = (Number(pending.evt.dx) || 0) + (Number(evt.dx) || 0);
      var dy = (Number(pending.evt.dy) || 0) + (Number(evt.dy) || 0);
      var clientDx = (Number(pending.evt.client_dx) || 0) + (Number(evt.client_dx) || 0);
      var clientDy = (Number(pending.evt.client_dy) || 0) + (Number(evt.client_dy) || 0);
      pending.evt = Object.assign({}, pending.evt, evt);
      pending.evt.dx = dx;
      pending.evt.dy = dy;
      pending.evt.trans = [pending.evt.dx, pending.evt.dy];
      pending.evt.client_dx = clientDx;
      pending.evt.client_dy = clientDy;
      return;
    }
    _pendingDragPosts[key] = { evt: evt };
    var flush = function() {
      var item = _pendingDragPosts[key];
      delete _pendingDragPosts[key];
      if (item && item.evt) { postEvent(item.evt); }
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 16);
    }
  }

  function cursorCss(mode) {
    var m = String(mode || "default");
    if (m === "open_hand") { return "grab"; }
    if (m === "closed_hand") { return "grabbing"; }
    if (m === "finger_up" || m === "finger_down") { return "pointer"; }
    if (m === "cross_hair") { return "crosshair"; }
    if (m === "arrow") { return "default"; }
    return m;
  }

  function applyGlobalCursorMode(mode) {
    if (global.VfGameCamera && typeof global.VfGameCamera.applyGlobalCursorMode === "function") {
      global.VfGameCamera.applyGlobalCursorMode(mode || "default", cursorCss);
      return;
    }
    var css = cursorCss(mode || "default");
    document.documentElement.style.cursor = css;
    document.body.style.cursor = css;
  }
  function isInteractiveOp(o) {
    return !!(o && o.interaction && (o.interaction.mode === "transform_2d" || o.interaction.mode === "pick_2d"));
  }

  function frameInteractionState(fid, ops) {
    var key = String(fid || "__screen__");
    var st = _interactive2d[key];
    if (!st) {
      st = { zoom: 1, panX: 0, panY: 0, drag: null, ops: [] };
      _interactive2d[key] = st;
    }
    st.ops = reconcileInteractionOps(st.ops, ops || []);
    return st;
  }

  function reconcileInteractionOps(previous, incoming) {
    return incoming;
  }

  function applyViewToPoint(st, x, y) {
    return [x * st.zoom + st.panX, y * st.zoom + st.panY];
  }

  function screenToData(st, x, y, w, h) {
    return [((x / (w || 1)) - st.panX) / st.zoom, ((y / (h || 1)) - st.panY) / st.zoom];
  }

  function transformedPoints(o) {
    var pts = Array.isArray(o.points) && o.points.length ? o.points : [[0,0],[1,0],[1,1],[0,1]];
    var tr = Array.isArray(o.transform) && o.transform.length >= 6 ? o.transform : [1,0,0,1,0,0];
    return pts.map(function(p) {
      var x = Number(p[0]) || 0;
      var y = Number(p[1]) || 0;
      return [tr[0] * x + tr[2] * y + tr[4], tr[1] * x + tr[3] * y + tr[5]];
    });
  }

  function pointInPolygon(pt, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1];
      var xj = poly[j][0], yj = poly[j][1];
      var crosses = ((yi > pt[1]) !== (yj > pt[1])) &&
        (pt[0] < (xj - xi) * (pt[1] - yi) / ((yj - yi) || 1e-9) + xi);
      if (crosses) { inside = !inside; }
    }
    return inside;
  }

  function distToSegment(p, a, b) {
    var vx = b[0] - a[0], vy = b[1] - a[1];
    var wx = p[0] - a[0], wy = p[1] - a[1];
    var c1 = vx * wx + vy * wy;
    var c2 = vx * vx + vy * vy || 1e-9;
    var t = Math.max(0, Math.min(1, c1 / c2));
    var dx = p[0] - (a[0] + t * vx);
    var dy = p[1] - (a[1] + t * vy);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function inverseLinearDelta(o, dx, dy) {
    var tr = Array.isArray(o.transform) && o.transform.length >= 6 ? o.transform : [1,0,0,1,0,0];
    var det = tr[0] * tr[3] - tr[1] * tr[2];
    if (Math.abs(det) < 1e-9) { return [dx, dy]; }
    return [
      ( tr[3] * dx - tr[2] * dy) / det,
      (-tr[1] * dx + tr[0] * dy) / det
    ];
  }

  function movePolygonVertex(o, vertexId, dx, dy) {
    if (!o || !Array.isArray(o.points) || vertexId == null || vertexId < 0 || vertexId >= o.points.length) { return; }
    var d = inverseLinearDelta(o, dx, dy);
    var p = o.points[vertexId];
    o.points[vertexId] = [Number(p[0]) + d[0], Number(p[1]) + d[1]];
  }

  function movePolygonEdge(o, edgeId, dx, dy) {
    if (!o || !Array.isArray(o.points) || edgeId == null || edgeId < 0 || edgeId >= o.points.length) { return; }
    var next = (edgeId + 1) % o.points.length;
    movePolygonVertex(o, edgeId, dx, dy);
    movePolygonVertex(o, next, dx, dy);
  }

  function orthogonalScaleEdge(o, edgeId, fromPt, toPt) {
    if (!o || !Array.isArray(o.points) || edgeId == null || edgeId < 0 || edgeId >= o.points.length) { return null; }
    var poly = transformedPoints(o);
    var a = poly[edgeId];
    var b = poly[(edgeId + 1) % poly.length];
    var ex = b[0] - a[0], ey = b[1] - a[1];
    var len = Math.hypot(ex, ey) || 1e-9;
    var nx = -ey / len, ny = ex / len;
    var c = polygonCenter(o);
    var base = (fromPt[0] - c[0]) * nx + (fromPt[1] - c[1]) * ny;
    var next = (toPt[0] - c[0]) * nx + (toPt[1] - c[1]) * ny;
    if (Math.abs(base) < 1e-6) { return null; }
    var k = Math.max(0.05, Math.min(20, next / base));
    var m = [
      1 + (k - 1) * nx * nx,
      (k - 1) * nx * ny,
      (k - 1) * nx * ny,
      1 + (k - 1) * ny * ny,
      0,
      0
    ];
    m[4] = c[0] - (m[0] * c[0] + m[2] * c[1]);
    m[5] = c[1] - (m[1] * c[0] + m[3] * c[1]);
    return m;
  }

  function hitInteractiveOp(st, pt) {
    for (var i = st.ops.length - 1; i >= 0; i--) {
      var o = st.ops[i];
      if (!isInteractiveOp(o)) { continue; }
      var poly = transformedPoints(o);
      var border = Number(o.interaction.border || 0.08);
      var vertexBorder = Number(o.interaction.vertex_border || border * 1.35);
      for (var v = 0; v < poly.length; v++) {
        if (Math.hypot(pt[0] - poly[v][0], pt[1] - poly[v][1]) <= vertexBorder) {
          return { index: i, op: o, vertex: true, vertex_id: v, edge: false, edge_id: null, face_id: null };
        }
      }
      for (var j = 0; j < poly.length; j++) {
        if (distToSegment(pt, poly[j], poly[(j + 1) % poly.length]) <= border) {
          return { index: i, op: o, edge: true, edge_id: j, vertex: false, vertex_id: null, face_id: null };
        }
      }
      if (pointInPolygon(pt, poly)) {
        return { index: i, op: o, edge: false, edge_id: null, vertex: false, vertex_id: null, face_id: 0 };
      }
    }
    return null;
  }

  function opShapeId(o) {
    return o && o.interaction ? String(o.interaction.shape_id || "") : "";
  }

  function isDescendantOf(st, op, ancestorId) {
    var parentId = op && op.interaction ? String(op.interaction.parent_shape_id || "") : "";
    while (parentId) {
      if (parentId === ancestorId) { return true; }
      var parent = null;
      for (var i = 0; i < st.ops.length; i++) {
        if (opShapeId(st.ops[i]) === parentId) {
          parent = st.ops[i];
          break;
        }
      }
      parentId = parent && parent.interaction ? String(parent.interaction.parent_shape_id || "") : "";
    }
    return false;
  }

  function polygonCenter(o) {
    var poly = transformedPoints(o);
    var sx = 0, sy = 0;
    for (var i = 0; i < poly.length; i++) { sx += poly[i][0]; sy += poly[i][1]; }
    return [sx / poly.length, sy / poly.length];
  }

  function leftMultiplyAffine(m, tr) {
    return [
      m[0] * tr[0] + m[2] * tr[1],
      m[1] * tr[0] + m[3] * tr[1],
      m[0] * tr[2] + m[2] * tr[3],
      m[1] * tr[2] + m[3] * tr[3],
      m[0] * tr[4] + m[2] * tr[5] + m[4],
      m[1] * tr[4] + m[3] * tr[5] + m[5],
    ];
  }

  function rotateScaleAround(tr, center, angle, scale) {
    var c = Math.cos(angle), s = Math.sin(angle), k = scale;
    var m = [
      c * k,
      s * k,
      -s * k,
      c * k,
      center[0] - (c * k * center[0] - s * k * center[1]),
      center[1] - (s * k * center[0] + c * k * center[1]),
    ];
    return leftMultiplyAffine(m, tr);
  }

  function applyAffineToSubtree(st, rootOp, m) {
    var rootId = opShapeId(rootOp);
    for (var i = 0; i < st.ops.length; i++) {
      var op = st.ops[i];
      if (op !== rootOp && !isDescendantOf(st, op, rootId)) { continue; }
      var tr = Array.isArray(op.transform) && op.transform.length >= 6 ? op.transform : [1,0,0,1,0,0];
      op.transform = leftMultiplyAffine(m, tr);
    }
  }

  function drawPolygon(ctx, points) {
    if (!points || points.length < 3) { return; }
    ctx.beginPath();
    ctx.moveTo(Number(points[0][0]) || 0, Number(points[0][1]) || 0);
    for (var i = 1; i < points.length; i++) {
      ctx.lineTo(Number(points[i][0]) || 0, Number(points[i][1]) || 0);
    }
    ctx.closePath();
    ctx.fill();
  }

  function canvasColor(color) {
    if (Array.isArray(color) && color.length >= 3) {
      var maxRgb = Math.max(Math.abs(Number(color[0]) || 0), Math.abs(Number(color[1]) || 0), Math.abs(Number(color[2]) || 0));
      var scale = maxRgb <= 1 ? 255 : 1;
      var r = Math.max(0, Math.min(255, Math.round((Number(color[0]) || 0) * scale)));
      var g = Math.max(0, Math.min(255, Math.round((Number(color[1]) || 0) * scale)));
      var b = Math.max(0, Math.min(255, Math.round((Number(color[2]) || 0) * scale)));
      var a = color.length >= 4 ? Math.max(0, Math.min(1, Number(color[3]))) : 1;
      if (!isFinite(a)) { a = 1; }
      return "rgba(" + r + "," + g + "," + b + "," + a + ")";
    }
    return color != null ? String(color) : "#888";
  }

  function redrawInteractiveCanvas(canvas) {
    if (!canvas || !canvas.__vf2dFrameId) { return; }
    var sz = syncCanvasSize(canvas);
    if (!sz) { return; }
    drawOpList(get2d(canvas), sz.w, sz.h, _interactive2d[canvas.__vf2dFrameId].ops, canvas.__vf2dFrameId);
  }

  function attach2dInteractions(canvas, fid) {
    if (!canvas || canvas.__vf2dInteractionsAttached) { return; }
    canvas.__vf2dInteractionsAttached = true;
    canvas.__vf2dFrameId = String(fid || "__screen__");
    canvas.style.pointerEvents = "auto";
    canvas.addEventListener("mousedown", function(e) {
      var st = _interactive2d[canvas.__vf2dFrameId];
      if (!st) { return; }
      var r = canvas.getBoundingClientRect();
      var pt = screenToData(st, e.clientX - r.left, e.clientY - r.top, r.width, r.height);
      var hit = hitInteractiveOp(st, pt);
      var shapeId = hit && hit.op && hit.op.interaction ? hit.op.interaction.shape_id || "" : "";
      var downHover = hoverContext({
        frame_id: canvas.__vf2dFrameId,
        object_id: shapeId,
        vertex_id: hit ? hit.vertex_id : null,
        edge_id: hit ? hit.edge_id : null,
        face_id: hit ? hit.face_id : null,
        kind: hit ? (hit.vertex ? "vertex" : hit.edge ? "edge" : "face") : "frame"
      });
      var action = hit ? "pick" : "pan";
      postEvent(withHoverContext({
        type: "vf_event",
        event: "down",
        x: e.clientX - r.left,
        y: e.clientY - r.top,
        frame_id: canvas.__vf2dFrameId,
        shape_id: shapeId,
        ctrl: !!e.ctrlKey,
        action: action,
      }, downHover));
      st.drag = {
        action: action,
        op: hit ? hit.op : null,
        hit: hit,
        last: pt,
        lastClient: [e.clientX, e.clientY],
        center: hit ? polygonCenter(hit.op) : null,
      };
      canvas.style.cursor = cursorCss(hit && hit.op.interaction.pressed_cursor || "closed_hand");
      e.preventDefault();
    }, { passive: false });
    document.addEventListener("mouseup", function() {
      var st = _interactive2d[canvas.__vf2dFrameId];
      if (!st || !st.drag) { return; }
      st.drag = null;
      canvas.style.cursor = cursorCss(st.cursor || "open_hand");
    }, true);
    document.addEventListener("mousemove", function(e) {
      var st = _interactive2d[canvas.__vf2dFrameId];
      if (!st) { return; }
      var r = canvas.getBoundingClientRect();
      var pt = screenToData(st, e.clientX - r.left, e.clientY - r.top, r.width, r.height);
      if (!st.drag) {
        var hover = hitInteractiveOp(st, pt);
        var hoverId = hover && hover.op && hover.op.interaction ? hover.op.interaction.shape_id || "" : "";
        canvas.style.cursor = cursorCss(hoverId ? hover.op.interaction.cursor : (st.cursor || "open_hand"));
        var hoverCtx = hoverContext({
          frame_id: canvas.__vf2dFrameId,
          object_id: hoverId,
          vertex_id: hover ? hover.vertex_id : null,
          edge_id: hover ? hover.edge_id : null,
          face_id: hover ? hover.face_id : null,
          kind: hover ? (hover.vertex ? "vertex" : hover.edge ? "edge" : "face") : "frame"
        });
        postEvent(withHoverContext({
          type: "vf_event",
          event: "hover",
          x: e.clientX - r.left,
          y: e.clientY - r.top,
          frame_id: canvas.__vf2dFrameId,
          shape_id: hoverId,
        }, hoverCtx));
        return;
      }
      var d = st.drag;
      if (d.action === "pan") {
        st.panX += (e.clientX - d.lastClient[0]) / (r.width || 1);
        st.panY += (e.clientY - d.lastClient[1]) / (r.height || 1);
      }
      var dataDx = pt[0] - d.last[0];
      var dataDy = pt[1] - d.last[1];
      var clientDx = e.clientX - d.lastClient[0];
      var clientDy = e.clientY - d.lastClient[1];
      d.last = pt;
      d.lastClient = [e.clientX, e.clientY];
      var dragShapeId = d.op && d.op.interaction ? d.op.interaction.shape_id || "" : "";
      var dragHover = hoverContext({
        frame_id: canvas.__vf2dFrameId,
        object_id: dragShapeId,
        vertex_id: d.hit ? d.hit.vertex_id : null,
        edge_id: d.hit ? d.hit.edge_id : null,
        face_id: d.hit ? d.hit.face_id : null,
        kind: d.hit ? (d.hit.vertex ? "vertex" : d.hit.edge ? "edge" : "face") : "frame"
      });
      postDragEventCoalesced(canvas.__vf2dFrameId, withHoverContext({
        type: "vf_event",
        event: "drag",
        x: e.clientX - r.left,
        y: e.clientY - r.top,
        dx: dataDx,
        dy: dataDy,
        trans: [dataDx, dataDy],
        client_dx: clientDx,
        client_dy: clientDy,
        frame_id: canvas.__vf2dFrameId,
        shape_id: dragShapeId,
        ctrl: !!e.ctrlKey,
        action: d.action,
      }, dragHover));
      redrawInteractiveCanvas(canvas);
    }, true);
    canvas.addEventListener("wheel", function(e) {
      var st = _interactive2d[canvas.__vf2dFrameId];
      if (!st) { return; }
      var r = canvas.getBoundingClientRect();
      var before = screenToData(st, e.clientX - r.left, e.clientY - r.top, r.width, r.height);
      var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      st.zoom = Math.max(0.1, Math.min(20, st.zoom * factor));
      st.panX = (e.clientX - r.left) / (r.width || 1) - before[0] * st.zoom;
      st.panY = (e.clientY - r.top) / (r.height || 1) - before[1] * st.zoom;
      redrawInteractiveCanvas(canvas);
      e.preventDefault();
    }, { passive: false });
  }

  function drawOpList(ctx, w, h, ops, frameId) {
    if (!w || !h || !ctx) { return; }
    ctx.clearRect(0, 0, w, h);
    if (!ops || !ops.length) { return; }
    var st = frameInteractionState(frameId, ops);
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      if (!o) { continue; }
      if (isInteractiveOp(o)) { st.cursor = o.interaction.cursor || st.cursor || "open_hand"; }
      ctx.fillStyle = canvasColor(o.color);
      if (Array.isArray(o.transform) && o.transform.length >= 6) {
        var tr = o.transform;
        ctx.save();
        ctx.setTransform(
          w * st.zoom * Number(tr[0] || 0),
          h * st.zoom * Number(tr[1] || 0),
          w * st.zoom * Number(tr[2] || 0),
          h * st.zoom * Number(tr[3] || 0),
          w * (st.zoom * Number(tr[4] || 0) + st.panX),
          h * (st.zoom * Number(tr[5] || 0) + st.panY)
        );
        if (o.op === "rect") {
          ctx.fillRect(0, 0, 1, 1);
          ctx.restore();
          continue;
        }
        if (o.op === "polygon") {
          drawPolygon(ctx, o.points);
          ctx.restore();
          continue;
        }
        if (o.op === "oval") {
          ctx.beginPath();
          if (typeof ctx.ellipse === "function") {
            ctx.ellipse(0.5, 0.5, 0.5, 0.5, 0, 0, Math.PI * 2);
          } else {
            ctx.save();
            ctx.translate(0.5, 0.5);
            ctx.scale(0.5, 0.5);
            ctx.arc(0, 0, 1, 0, Math.PI * 2);
            ctx.restore();
          }
          ctx.fill();
          ctx.restore();
          continue;
        }
        ctx.restore();
      }
      var p = normToPx(o.rect, w, h);
      if (!p) { continue; }
      if (o.op === "rect") {
        ctx.fillRect(p.x, p.y, p.rw, p.rh);
        continue;
      }
      if (o.op === "oval") {
        var cx = p.x + p.rw * 0.5;
        var cy = p.y + p.rh * 0.5;
        var rx = Math.max(0.5, p.rw * 0.5);
        var ry = Math.max(0.5, p.rh * 0.5);
        ctx.beginPath();
        if (typeof ctx.ellipse === "function") {
          ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        } else {
          ctx.save();
          ctx.translate(cx, cy);
          ctx.scale(rx, ry);
          ctx.arc(0, 0, 1, 0, Math.PI * 2);
          ctx.restore();
        }
        ctx.fill();
      }
    }
  }

  var _globalWheelBridgeInstalled = false;
  var _globalDragBridgeInstalled = false;
  var _dragState = null; // { fid, lastX, lastY }
  function installGlobalWheelBridge() {
    if (_globalWheelBridgeInstalled) { return; }
    _globalWheelBridgeInstalled = true;
    document.addEventListener("wheel", function(e) {
      try {
        if (e && e.__vfHandledWheel) { return; }
        var t = e.target;
        if (!(t instanceof Element)) { return; }
        var frameEl = t.closest(".vf-frame");
        if (!frameEl) { return; } // do not steal wheel outside frames
        var fid = frameEl.getAttribute("data-vf-frame-id") || "";
        var r = frameEl.getBoundingClientRect();
        var x = e.clientX - r.left;
        var y = e.clientY - r.top;
        var dy = Number(e.deltaY) || 0;
        if (!dy) { return; }
        var step = dy > 0 ? 1 : -1;
        if (typeof e.preventDefault === "function") { e.preventDefault(); }
        postEvent(withHoverContext({
          type: "vf_event",
          event: "wheel",
          x: x, y: y,
          step: step,
          delta: dy,
          ctrl: !!e.ctrlKey,
          frame_id: fid,
        }, hoverContext({ frame_id: fid })));
      } catch (_) {}
    }, { capture: true, passive: false });
  }

  function installGlobalDragBridge() {
    if (_globalDragBridgeInstalled) { return; }
    _globalDragBridgeInstalled = true;

    document.addEventListener("mousedown", function(e) {
      try {
        if (!e || e.button !== 0) { return; }
        var t = e.target;
        if (!(t instanceof Element)) { return; }
        var frameEl = t.closest(".vf-frame");
        if (!frameEl) { return; }
        var fid = frameEl.getAttribute("data-vf-frame-id") || "";
        _dragState = { fid: fid, lastX: e.clientX, lastY: e.clientY };
      } catch (_) {}
    }, true);

    document.addEventListener("mouseup", function(e) {
      try {
        if (e && e.button === 0) { _dragState = null; }
      } catch (_) {}
    }, true);

    document.addEventListener("mousemove", function(e) {
      try {
        if (!_dragState) { return; }
        var buttons = Number(e.buttons) || 0;
        if ((buttons & 1) === 0) {
          _dragState = null;
          return;
        }
        var dx = e.clientX - _dragState.lastX;
        var dy = e.clientY - _dragState.lastY;
        if (!dx && !dy) { return; }
        _dragState.lastX = e.clientX;
        _dragState.lastY = e.clientY;
        postEvent(withHoverContext({
          type: "vf_event",
          event: "drag",
          x: e.clientX,
          y: e.clientY,
          dx: dx,
          dy: dy,
          button: 0,
          buttons: buttons,
          ctrl: !!e.ctrlKey,
          shift: !!e.shiftKey,
          alt: !!e.altKey,
          meta: !!e.metaKey,
          frame_id: _dragState.fid,
        }, hoverContext({ frame_id: _dragState.fid })));
      } catch (_) {}
    }, true);
  }

  function syncCanvasSize(canvas) {
    if (!canvas) { return null; }
    var pr = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.floor(pr.width));
    var h = Math.max(1, Math.floor(pr.height));
    if (canvas.width  !== w) { canvas.width  = w; }
    if (canvas.height !== h) { canvas.height = h; }
    return { w: w, h: h };
  }

  function findFrameEl(fid) {
    try {
      if (global.CSS && typeof global.CSS.escape === "function") {
        return document.querySelector(".vf-frame[data-vf-frame-id=\"" + global.CSS.escape(String(fid)) + "\"]");
      }
      return document.querySelector(".vf-frame[data-vf-frame-id=\"" + String(fid).replace(/["\\]/g,"") + "\"]");
    } catch (_) { return null; }
  }

  // ── Euler ZYX rotation matrix (degrees) — column-major Float32Array ───────
  function mat4EulerZYX(rx, ry, rz) {
    var Mm = global.VfGeomMath;
    if (!Mm) {
      vlog("warn", "mat4EulerZYX: VfGeomMath not loaded, returning identity");
      return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    }
    var toRad = Math.PI / 180;
    var cx = Math.cos(rx * toRad), sx = Math.sin(rx * toRad);
    var Rx = new Float32Array([1,0,0,0, 0,cx,sx,0, 0,-sx,cx,0, 0,0,0,1]);
    var cy = Math.cos(ry * toRad), sy = Math.sin(ry * toRad);
    var Ry = new Float32Array([cy,0,-sy,0, 0,1,0,0, sy,0,cy,0, 0,0,0,1]);
    var cz = Math.cos(rz * toRad), sz = Math.sin(rz * toRad);
    var Rz = new Float32Array([cz,sz,0,0, -sz,cz,0,0, 0,0,1,0, 0,0,0,1]);
    return Mm.mat4Mul(Mm.mat4Mul(Rz, Ry), Rx);
  }

  // Build model matrix: translate(center) * EulerZYX(rotation)
  function meshModelMatrix(spec) {
    var Mm = global.VfGeomMath;
    if (!Mm) { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); }
    var c = spec.center || [0,0,0];
    var rot = spec.rotation || [0,0,0];
    var T = Mm.mat4Translation(c[0], c[1], c[2]);
    var R = mat4EulerZYX(rot[0], rot[1], rot[2]);
    return Mm.mat4Mul(T, R);
  }

  function meshAlpha(spec) {
    if (!spec) { return 1; }
    if (typeof spec.alpha === "number" && isFinite(spec.alpha)) {
      return Math.max(0, Math.min(1, spec.alpha));
    }
    if (Array.isArray(spec.color) && spec.color.length >= 4) {
      var a = Number(spec.color[3]);
      if (isFinite(a)) { return Math.max(0, Math.min(1, a)); }
    }
    return 1;
  }

  function transformPointMat4(m, x, y, z) {
    return [
      m[0] * x + m[4] * y + m[8]  * z + m[12],
      m[1] * x + m[5] * y + m[9]  * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
    ];
  }

  function transformNormalMat4(m, x, y, z) {
    var nx = m[0] * x + m[4] * y + m[8]  * z;
    var ny = m[1] * x + m[5] * y + m[9]  * z;
    var nz = m[2] * x + m[6] * y + m[10] * z;
    var nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nlen < 1e-9) { return [0, 0, 1]; }
    return [nx / nlen, ny / nlen, nz / nlen];
  }

  function parseSpecRgba(spec) {
    var c = spec && spec.color;
    if (global.VfGeomWgpuUtil && typeof global.VfGeomWgpuUtil.parseColor === "function") {
      return global.VfGeomWgpuUtil.parseColor(c);
    }
    if (Array.isArray(c) && c.length >= 3) {
      return [Number(c[0]) || 0.8, Number(c[1]) || 0.8, Number(c[2]) || 0.8, c.length >= 4 ? Number(c[3]) || 1 : 1];
    }
    return [0.8, 0.8, 0.8, 1];
  }

  function vertexRgba(v, offset, fallback) {
    if (!v || offset + 9 >= v.length) { return fallback || [0.8, 0.8, 0.8, 1]; }
    return [v[offset + 6], v[offset + 7], v[offset + 8], v[offset + 9]];
  }

  function pushVertex(outVerts, p, n, rgba) {
    outVerts.push(p[0], p[1], p[2], n[0], n[1], n[2], rgba[0], rgba[1], rgba[2], rgba[3]);
  }

  function overlaySize(spec, mesh, key) {
    var raw = spec && spec[key];
    if (raw !== undefined && raw !== null) {
      return Math.max(0, Number(raw) || 0);
    }
    var d = Number((spec && spec.manifold_dim_count) || (mesh && mesh.manifold_dim_count) || 0);
    if (key === "vertex_size") { return d === 0 ? 4 : 0; }
    if (key === "edge_width") { return d === 1 ? 4 : 0; }
    return 0;
  }

  function impostorRadiusForPixels(px, p, camera) {
    px = Math.max(0, Number(px) || 0);
    if (px <= 0) { return 0; }
    var camPos = (camera && Array.isArray(camera.pos)) ? camera.pos : [0, 0, 5];
    var fov = Number(camera && camera.fov) || 45;
    var dist = Math.max(0.05, vec3Len(vec3Sub(p, camPos)));
    // Approximate screen-space sizing without coupling radius to mesh scale.
    // TODO: move this to the renderer with the actual canvas height so impostors
    // stay exact under every viewport and clip cleanly against nearby D-1 planes.
    var nominalViewportPx = 600;
    return Math.max(0.0005, (2 * dist * Math.tan((fov * Math.PI / 180) * 0.5)) * (px * 0.5 / nominalViewportPx));
  }

  function appendSphereGeom(outVerts, outIdx, center, radius, rgba, counts) {
    if (!(radius > 0)) { return; }
    var seg = 12;
    var rings = 6;
    var base = outVerts.length / 10;
    for (var r = 0; r <= rings; r++) {
      var phi = Math.PI * r / rings;
      var sp = Math.sin(phi);
      var cp = Math.cos(phi);
      for (var s = 0; s <= seg; s++) {
        var th = Math.PI * 2 * s / seg;
        var nx = Math.cos(th) * sp;
        var ny = Math.sin(th) * sp;
        var nz = cp;
        pushVertex(
          outVerts,
          [center[0] + nx * radius, center[1] + ny * radius, center[2] + nz * radius],
          [nx, ny, nz],
          rgba
        );
      }
    }
    var row = seg + 1;
    for (var rr = 0; rr < rings; rr++) {
      for (var ss = 0; ss < seg; ss++) {
        var a = base + rr * row + ss;
        var b = a + 1;
        var c = a + row;
        var d = c + 1;
        outIdx.push(a, c, b, b, c, d);
      }
    }
    if (counts) { counts.spheres++; }
  }

  function appendCylinderSideGeom(outVerts, outIdx, a, b, radius, rgba, counts) {
    var axis = vec3Sub(b, a);
    var len = vec3Len(axis);
    if (!(radius > 0) || len < 1e-6) { return; }
    var dir = vec3Scale(axis, 1 / len);
    var ref = Math.abs(dir[1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
    var u = vec3Norm(vec3Cross(ref, dir));
    var v = vec3Norm(vec3Cross(dir, u));
    var seg = 14;
    var base = outVerts.length / 10;
    for (var s = 0; s <= seg; s++) {
      var th = Math.PI * 2 * s / seg;
      var n = vec3Norm(vec3Add(vec3Scale(u, Math.cos(th)), vec3Scale(v, Math.sin(th))));
      pushVertex(outVerts, vec3Add(a, vec3Scale(n, radius)), n, rgba);
      pushVertex(outVerts, vec3Add(b, vec3Scale(n, radius)), n, rgba);
    }
    for (var i = 0; i < seg; i++) {
      var p0 = base + i * 2;
      var p1 = p0 + 1;
      var p2 = p0 + 2;
      var p3 = p0 + 3;
      outIdx.push(p0, p1, p2, p2, p1, p3);
    }
    if (counts) { counts.cylinders++; }
  }

  function appendSegmentImpostor(outVerts, outIdx, a, b, radius, rgba, counts) {
    appendCylinderSideGeom(outVerts, outIdx, a, b, radius, rgba, counts);
    appendSphereGeom(outVerts, outIdx, a, radius, rgba, counts);
    appendSphereGeom(outVerts, outIdx, b, radius, rgba, counts);
  }

  function pointKey(p) {
    return p[0].toFixed(6) + "," + p[1].toFixed(6) + "," + p[2].toFixed(6);
  }

  function cameraForward(camera) {
    var pos = (camera && Array.isArray(camera.pos)) ? camera.pos : [0, 0, 5];
    var target = (camera && Array.isArray(camera.target)) ? camera.target : [0, 0, 0];
    var fx = target[0] - pos[0];
    var fy = target[1] - pos[1];
    var fz = target[2] - pos[2];
    var fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (fl < 1e-9) { return [0, 0, -1]; }
    return [fx / fl, fy / fl, fz / fl];
  }

  // Build one frame-level transparent mesh so all translucent surfaces are blended
  // in a single pass with back-to-front triangle ordering.
  function buildCombinedTransparentMesh(specs, camera, lights) {
    if (!Array.isArray(specs) || specs.length < 2) { return null; }
    var built = [];
    for (var i = 0; i < specs.length; i++) {
      var spec = specs[i];
      var alpha = meshAlpha(spec);
      if (!(alpha < 0.999)) { return null; }
      var m = buildSingleMesh(spec, camera, lights);
      if (!m || m.topology !== "triangle-list") { return null; }
      built.push({ spec: spec, mesh: m });
    }

    var camPos = (camera && Array.isArray(camera.pos)) ? camera.pos : [0, 0, 5];
    var camFwd = cameraForward(camera);
    var outVerts = [];
    var tris = []; // {a,b,c,depth}
    var vertBase = 0;

    for (var b = 0; b < built.length; b++) {
      var item = built[b];
      var spec = item.spec;
      var mesh = item.mesh;
      var model = meshModelMatrix(spec);
      var v = mesh.vertices;
      var idx = mesh.indices;
      var stride = 10;
      var vcount = Math.floor(v.length / stride);

      for (var vi = 0; vi < vcount; vi++) {
        var o = vi * stride;
        var tp = transformPointMat4(model, v[o], v[o + 1], v[o + 2]);
        var tn = transformNormalMat4(model, v[o + 3], v[o + 4], v[o + 5]);
        outVerts.push(
          tp[0], tp[1], tp[2],
          tn[0], tn[1], tn[2],
          v[o + 6], v[o + 7], v[o + 8], v[o + 9]
        );
      }

      for (var ti = 0; ti + 2 < idx.length; ti += 3) {
        var a = vertBase + idx[ti];
        var c = vertBase + idx[ti + 1];
        var d = vertBase + idx[ti + 2];
        var ao = a * stride, co = c * stride, dof = d * stride;
        var cx = (outVerts[ao] + outVerts[co] + outVerts[dof]) / 3;
        var cy = (outVerts[ao + 1] + outVerts[co + 1] + outVerts[dof + 1]) / 3;
        var cz = (outVerts[ao + 2] + outVerts[co + 2] + outVerts[dof + 2]) / 3;
        var dx = cx - camPos[0], dy = cy - camPos[1], dz = cz - camPos[2];
        // Transparent triangles must be ordered in camera depth, not radial distance.
        // Squared distance misorders off-axis triangles and causes strange overlap.
        var depth = dx * camFwd[0] + dy * camFwd[1] + dz * camFwd[2];
        tris.push({ a: a, b: c, c: d, depth: depth });
      }
      vertBase += vcount;
    }

    tris.sort(function (lhs, rhs) { return rhs.depth - lhs.depth; }); // far -> near
    var outIdx = new Uint32Array(tris.length * 3);
    for (var t = 0; t < tris.length; t++) {
      outIdx[t * 3] = tris[t].a;
      outIdx[t * 3 + 1] = tris[t].b;
      outIdx[t * 3 + 2] = tris[t].c;
    }

    return {
      id: "combined_transparent",
      mode3d: true,
      label: "combined_transparent",
      vertices: new Float32Array(outVerts),
      indices: outIdx,
      topology: "triangle-list",
      camera: camera || null,
      lights: lights || [],
      center: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      alpha: 1,
      transparent: true,
    };
  }

  function buildCombinedTriangleMesh(specs, camera, lights) {
    if (!Array.isArray(specs) || specs.length < 1) { return null; }
    var built = [];
    var needsCombined = specs.length > 1;
    for (var bi = 0; bi < specs.length; bi++) {
      var builtSpec = specs[bi];
      var builtMesh = buildSingleMesh(builtSpec, camera, lights);
      if (!builtMesh) { return null; }
      if (
        builtMesh.topology !== "triangle-list" ||
        builtMesh.solid_volume ||
        overlaySize(builtSpec, builtMesh, "vertex_size") > 0 ||
        overlaySize(builtSpec, builtMesh, "edge_width") > 0
      ) {
        needsCombined = true;
      }
      built.push({ spec: builtSpec, mesh: builtMesh });
    }
    if (!needsCombined) { return null; }

    var outVerts = [];
    var outIdx = [];
    var solidRanges = [];
    var overlayCounts = { spheres: 0, cylinders: 0 };
    var vertBase = 0;
    var stride = 10;

    for (var i = 0; i < built.length; i++) {
      var spec = built[i].spec;
      var m = built[i].mesh;
      var model = meshModelMatrix(spec);
      var v = m.vertices;
      var idx = m.indices;
      var vcount = Math.floor(v.length / stride);
      var vertexSize = overlaySize(spec, m, "vertex_size");
      var edgeWidth = overlaySize(spec, m, "edge_width");
      var seenPoints = Object.create(null);

      function appendPointOverlay(localOffset) {
        var pp = transformPointMat4(model, v[localOffset], v[localOffset + 1], v[localOffset + 2]);
        var key = pointKey(pp);
        if (seenPoints[key]) { return; }
        seenPoints[key] = true;
        appendSphereGeom(
          outVerts,
          outIdx,
          pp,
          impostorRadiusForPixels(vertexSize, pp, camera),
          vertexRgba(v, localOffset, parseSpecRgba(spec)),
          overlayCounts
        );
      }

      function appendEdgeOverlay(aOffset, bOffset) {
        var ap = transformPointMat4(model, v[aOffset], v[aOffset + 1], v[aOffset + 2]);
        var bp = transformPointMat4(model, v[bOffset], v[bOffset + 1], v[bOffset + 2]);
        var mid = [(ap[0] + bp[0]) * 0.5, (ap[1] + bp[1]) * 0.5, (ap[2] + bp[2]) * 0.5];
        appendSegmentImpostor(
          outVerts,
          outIdx,
          ap,
          bp,
          impostorRadiusForPixels(edgeWidth, mid, camera),
          vertexRgba(v, aOffset, parseSpecRgba(spec)),
          overlayCounts
        );
      }

      if (m.topology === "triangle-list") {
        var triStart = outIdx.length;
        for (var vi = 0; vi < vcount; vi++) {
          var o = vi * stride;
          var tp = transformPointMat4(model, v[o], v[o + 1], v[o + 2]);
          var tn = transformNormalMat4(model, v[o + 3], v[o + 4], v[o + 5]);
          outVerts.push(
            tp[0], tp[1], tp[2],
            tn[0], tn[1], tn[2],
            v[o + 6], v[o + 7], v[o + 8], v[o + 9]
          );
        }
        for (var ii = 0; ii < idx.length; ii++) {
          outIdx.push(vertBase + idx[ii]);
        }
        if (m.solid_volume) {
          solidRanges.push({ start: triStart, count: idx.length });
        }
        vertBase += vcount;
        if (vertexSize > 0) {
          for (var pvi = 0; pvi < vcount; pvi++) {
            appendPointOverlay(pvi * stride);
          }
          vertBase = outVerts.length / stride;
        }
        if (edgeWidth > 0) {
          var seenEdges = Object.create(null);
          for (var ti = 0; ti + 2 < idx.length; ti += 3) {
            var tri = [idx[ti], idx[ti + 1], idx[ti + 2]];
            for (var ei = 0; ei < 3; ei++) {
              var ea = tri[ei];
              var eb = tri[(ei + 1) % 3];
              var edgeKey = ea < eb ? ea + ":" + eb : eb + ":" + ea;
              if (seenEdges[edgeKey]) { continue; }
              seenEdges[edgeKey] = true;
              appendEdgeOverlay(ea * stride, eb * stride);
            }
          }
          vertBase = outVerts.length / stride;
        }
      } else if (m.topology === "line-list") {
        if (edgeWidth > 0) {
          for (var li = 0; li + 1 < idx.length; li += 2) {
            appendEdgeOverlay(idx[li] * stride, idx[li + 1] * stride);
          }
        }
        if (vertexSize > 0) {
          for (var lpi = 0; lpi < idx.length; lpi++) {
            appendPointOverlay(idx[lpi] * stride);
          }
        }
        vertBase = outVerts.length / stride;
      } else if (m.topology === "point-list") {
        if (vertexSize > 0) {
          for (var pi = 0; pi < idx.length; pi++) {
            appendPointOverlay(idx[pi] * stride);
          }
        }
        vertBase = outVerts.length / stride;
      } else {
        return null;
      }
    }

    return {
      id: "combined_scene",
      mode3d: true,
      label: "combined_scene",
      vertices: new Float32Array(outVerts),
      indices: new Uint32Array(outIdx),
      topology: "triangle-list",
      solid_volume_ranges: solidRanges,
      overlay_counts: overlayCounts,
      camera: camera || null,
      lights: lights || [],
      center: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      alpha: 1,
    };
  }

  // Build a single-mesh object for the renderer from a spec
  function buildSingleMesh(spec, camera, lights) {
    var Core = global.VfGeomCore;
    if (!Core) {
      vlog("error", "buildSingleMesh: VfGeomCore not loaded");
      return null;
    }
    var mesh;
    if (spec.type === "box") {
      mesh = Core.buildBox([0,0,0], spec.scale || [1,1,1], spec.color || null, spec.id || "box");
    } else if (spec.type === "ellipsoid") {
      mesh = Core.buildSphere([0,0,0], 0.5, spec.color || null, spec.id || "ellipsoid");
    } else if (spec.type === "torus") {
      var major = Number(spec.major_radius);
      var minor = Number(spec.minor_radius);
      if (!(major > 0)) { major = 0.65; }
      if (!(minor > 0)) { minor = 0.22; }
      mesh = Core.buildTorus([0,0,0], major, minor, spec.color || null, spec.id || "torus");
    } else if (spec.type === "field_mesh") {
      var verts = spec.vertices || [];
      var inds = spec.indices || [];
      mesh = {
        id: spec.id || "field_mesh",
        mode3d: true,
        label: spec.id || "field_mesh",
        vertices: (verts instanceof Float32Array) ? verts : new Float32Array(verts),
        indices: (inds instanceof Uint32Array) ? inds : new Uint32Array(inds),
        topology: spec.topology || "triangle-list",
        solid_volume: !!spec.solid_volume,
        manifold_dim_count: Number(spec.manifold_dim_count) || 0,
        vertex_size: Number(spec.vertex_size) || 0,
        edge_width: Number(spec.edge_width) || 0,
      };
    } else if (spec.preset) {
      mesh = Core.getPreset(spec.preset);
    } else {
      vlog("warn", "buildSingleMesh: unknown mesh spec type=" + spec.type);
      return null;
    }
    if (!mesh) {
      vlog("error", "buildSingleMesh: Core returned null for type=" + spec.type);
      return null;
    }
    var out = {};
    for (var k in mesh) { out[k] = mesh[k]; }
    out.camera   = camera || null;
    out.lights   = lights  || [];
    // Forward spec fields so vf-geom-wgpu.js can recompute TRS every frame
    out.center   = spec.center   || [0,0,0];
    out.rotation = spec.rotation || [0,0,0];
    out.scale    = spec.scale    || [1,1,1];
    out.alpha    = meshAlpha(spec);
    out.transparent = out.alpha < 0.999;
    out._modelMatrix = meshModelMatrix(spec);  // fallback if VfGeomMath.mat4ModelTRS absent
    return out;
  }

  // ── Per-frame renderer management ─────────────────────────────────────────

  function ensureGeomCanvas(frameEl, idx) {
    if (!frameEl) { return null; }
    var body = frameEl.querySelector(".vf-frame__body") || frameEl;
    var cls  = "vf-geom-canvas-" + idx;
    var existing = body.querySelector("canvas." + cls);
    if (existing) { return existing; }
    var c = document.createElement("canvas");
    c.className = "vf-geom-canvas " + cls;
    c.style.cssText = "display:block;width:100%;height:100%;position:absolute;inset:0;z-index:" + (10 + idx) + ";pointer-events:auto;";
    body.style.position = "relative";
    body.style.pointerEvents = "auto";
    body.appendChild(c);
    vlog("info", "ensureGeomCanvas: created canvas idx=" + idx + " for frame body (body w=" + body.offsetWidth + " h=" + body.offsetHeight + ")");
    return c;
  }

  // ── Notify native host of updated hit regions after geom frames change ─────
  var _layoutDebounceTimer = null;
  function schedulePostGeomLayout() {
    if (_layoutDebounceTimer) { clearTimeout(_layoutDebounceTimer); }
    _layoutDebounceTimer = setTimeout(function() {
      _layoutDebounceTimer = null;
      var layer = document.getElementById("layer") || document.getElementById("vf-layer") || document.body;
      if (global.VfFrame && typeof global.VfFrame.postNativeHostLayout === "function") {
        global.VfFrame.postNativeHostLayout(layer, { stageAlpha: 0 });
      }
    }, 50);
  }

  function _setDisplayHitRegions(regions) {
    try {
      global.__vfDisplayHitRegions = Array.isArray(regions) ? regions : [];
    } catch (_) {}
  }

  function _appendOvalHitRegions(out, p) {
    if (!p) { return; }
    var cx = p.x + p.rw * 0.5;
    var cy = p.y + p.rh * 0.5;
    var rx = Math.max(0.5, p.rw * 0.5);
    var ry = Math.max(0.5, p.rh * 0.5);
    var step = 4;
    var y0 = Math.floor(p.y);
    var y1 = Math.ceil(p.y + p.rh);
    for (var y = y0; y <= y1; y += step) {
      var yy = ((y + step * 0.5) - cy) / ry;
      var inside = 1 - yy * yy;
      if (inside <= 0) { continue; }
      var xh = rx * Math.sqrt(inside);
      out.push({
        left: Math.floor(cx - xh),
        top: y,
        right: Math.ceil(cx + xh),
        bottom: y + step
      });
    }
  }

  function buildScreenHitRegions(screenOps, w, h) {
    var out = [];
    if (!screenOps || !screenOps.length || !w || !h) { return out; }
    for (var i = 0; i < screenOps.length; i++) {
      var o = screenOps[i];
      if (!o) { continue; }
      var p = normToPx(o.rect, w, h);
      if (!p) { continue; }
      if (o.op === "rect") {
        out.push({
          left: Math.floor(p.x),
          top: Math.floor(p.y),
          right: Math.ceil(p.x + p.rw),
          bottom: Math.ceil(p.y + p.rh)
        });
      } else if (o.op === "oval") {
        _appendOvalHitRegions(out, p);
      }
    }
    return out;
  }

  function updateGeomFrame(fid, geomSpec) {
    var Ctor = global.VfGeomWgpu;
    if (!Ctor) {
      vlog("warn", "updateGeomFrame [" + fid + "]: VfGeomWgpu not loaded — geom skipped");
      return;
    }

    var frameEl = findFrameEl(fid);
    if (!frameEl) {
      vlog("warn", "updateGeomFrame [" + fid + "]: no DOM element .vf-frame[data-vf-frame-id=" + fid + "] found — frame not placed yet?");
      return;
    }

    var specs   = geomSpec.meshes || [];
    var camera  = geomSpec.camera || null;
    syncGameCamera(fid, camera);
    var lights  = geomSpec.lights || [];
    var combinedTransparent = buildCombinedTransparentMesh(specs, camera, lights);
    var combinedTriangles = combinedTransparent ? null : buildCombinedTriangleMesh(specs, camera, lights);
    var renderSpecs = combinedTransparent
      ? [{ __mesh: combinedTransparent, type: "combined_transparent" }]
      : combinedTriangles
      ? [{ __mesh: combinedTriangles, type: "combined_scene" }]
      : specs;

    vlog("info", "updateGeomFrame [" + fid + "]: meshes=" + specs.length +
      (combinedTransparent ? " (combined transparent pass)" : "") +
      (combinedTriangles ? " (combined scene pass)" : "") +
      " camera=" + (camera ? JSON.stringify(camera.pos) : "none") +
      " lights=" + lights.length);

    if (!frameRecs[fid]) { frameRecs[fid] = { entries: [] }; }
    var rec = frameRecs[fid];

    for (var i = 0; i < renderSpecs.length; i++) {
      var spec = renderSpecs[i];
      var mesh = spec.__mesh || buildSingleMesh(spec, camera, lights);
      if (!mesh) {
        vlog("warn", "updateGeomFrame [" + fid + "]: mesh " + i + " build failed, skipping");
        continue;
      }

      if (i < rec.entries.length) {
        rec.entries[i].ref.mesh = mesh;
        if (rec.entries[i].canvas) {
          rec.entries[i].canvas.style.opacity = String(mesh.alpha == null ? 1 : mesh.alpha);
        }
        // log only on first few updates to avoid spam
        if (rec.entries[i]._logCount == null) { rec.entries[i]._logCount = 0; }
        rec.entries[i]._logCount++;
        if (rec.entries[i]._logCount <= 3) {
          vlog("info", "updateGeomFrame [" + fid + "]: updated renderer " + i +
            " center=" + JSON.stringify(spec.center) +
            " scale=" + JSON.stringify(spec.scale) +
            " rot=" + JSON.stringify(spec.rotation || [0,0,0]));
        }
      } else {
        // Spawn new renderer
        var canvas = ensureGeomCanvas(frameEl, i);
        if (!canvas) {
          vlog("error", "updateGeomFrame [" + fid + "]: could not create canvas for mesh " + i);
          continue;
        }
        var sz = syncCanvasSize(canvas);
        vlog("info", "updateGeomFrame [" + fid + "]: spawning renderer " + i +
          " canvas=" + (sz ? sz.w + "x" + sz.h : "?") +
          " mesh.type=" + (spec.type || "mesh") +
          " center=" + JSON.stringify(spec.center) +
          " scale=" + JSON.stringify(spec.scale) +
          " cam=" + (camera ? JSON.stringify(camera.pos) : "none"));

        var refHolder = { mesh: mesh };
        (function(rh, fidInner, meshIdx, cv) {
          var entry = { renderer: null, ref: rh, _logCount: 0 };
          rec.entries.push(entry);
          var r = new Ctor(canvas, function() { return rh.mesh; });
          entry.renderer = r;
          entry.canvas = cv;
          cv.style.opacity = String(mesh.alpha == null ? 1 : mesh.alpha);
          ensureGameCameraControls(cv, fidInner, mesh.camera || camera);
          // Assign stable object_id (1-based: 0 means "no object")
          r._objectId = meshIdx + 1;
          r.init().then(function(ok) {
            if (!ok) {
              vlog("error", "updateGeomFrame [" + fidInner + "]: renderer " + meshIdx + " init FAILED (WebGPU unavailable?)");
            } else {
              vlog("info", "updateGeomFrame [" + fidInner + "]: renderer " + meshIdx + " init OK, starting render loop");
              r.start();
              attachCanvasEvents(cv, fidInner, meshIdx);
              ensureGameCameraControls(cv, fidInner, rh.mesh && rh.mesh.camera);
            }
          }).catch(function(err) {
            vlog("error", "updateGeomFrame [" + fidInner + "]: renderer " + meshIdx + " init threw: " + (err && err.message ? err.message : String(err)));
          });
        })(refHolder, fid, i, canvas);
      }
    }

    // Stop renderers for meshes that were removed
    for (var j = renderSpecs.length; j < rec.entries.length; j++) {
      try {
        vlog("info", "updateGeomFrame [" + fid + "]: stopping renderer " + j + " (mesh removed)");
        rec.entries[j].renderer.stop();
      } catch(_) {}
      try {
        if (rec.entries[j].canvas && rec.entries[j].canvas.parentNode) {
          rec.entries[j].canvas.parentNode.removeChild(rec.entries[j].canvas);
        }
      } catch(_) {}
      rec.entries[j].ref.mesh = null;
    }
    rec.entries.length = renderSpecs.length;
    // Notify native host of updated hit regions (geom canvases)
    schedulePostGeomLayout();
  }

  // ── Main render from JSON ─────────────────────────────────────────────────

  function renderFromJson(data) {
    if (!data || typeof data !== "object") {
      vlog("warn", "renderFromJson: data is null or not an object");
      return;
    }
    applyGlobalCursorMode(data.cursor || "default");

    // Log a summary of what arrived (suppress repeat spam)
    var geomKeys = data.geom ? Object.keys(data.geom) : [];
    var summary = "geomFrames=" + geomKeys.length +
      " screenOps=" + (data.screen ? data.screen.length : 0) +
      " frameKeys=" + (data.frames ? Object.keys(data.frames).length : 0);
    if (summary !== _lastPayloadSummary) {
      vlog("info", "renderFromJson: " + summary + " geomIds=[" + geomKeys.join(",") + "]");
      _lastPayloadSummary = summary;
    }

    // 2-D screen canvas
    var sc = document.getElementById("vf-screen-canvas");
    if (sc) {
      var sz = syncCanvasSize(sc);
      if (sz) {
        drawOpList(get2d(sc), sz.w, sz.h, data.screen, "__screen__");
        attach2dInteractions(sc, "__screen__");
        if (_interactive2d.__screen__ && _interactive2d.__screen__.cursor) {
          sc.style.cursor = cursorCss(_interactive2d.__screen__.cursor);
        }
        _setDisplayHitRegions(buildScreenHitRegions(data.screen, sz.w, sz.h));
        schedulePostGeomLayout();
      } else {
        _setDisplayHitRegions([]);
      }
    } else {
      _setDisplayHitRegions([]);
    }

    // 2-D per-frame canvases
    var frames = data.frames;
    if (frames && typeof frames === "object") {
      for (var fid in frames) {
        if (!Object.prototype.hasOwnProperty.call(frames, fid)) { continue; }
        var el = findFrameEl(fid);
        if (!el) {
          vlog("warn", "renderFromJson: 2D frame [" + fid + "] not found in DOM");
          continue;
        }
        var cv = el.querySelector("canvas.vf-frame__draw-canvas");
        if (!cv) { continue; }
        var fsz = syncCanvasSize(cv);
        if (!fsz) { continue; }
        drawOpList(get2d(cv), fsz.w, fsz.h, frames[fid], fid);
        attach2dInteractions(cv, fid);
        if (_interactive2d[String(fid)] && _interactive2d[String(fid)].cursor) {
          cv.style.cursor = cursorCss(_interactive2d[String(fid)].cursor);
        }
      }
    }

    // 3-D geom
    var geom = data.geom;
    if (geom && typeof geom === "object") {
      for (var gid in geom) {
        if (!Object.prototype.hasOwnProperty.call(geom, gid)) { continue; }
        updateGeomFrame(gid, geom[gid]);
      }
    }
  }

  // ── Dependency check on load ──────────────────────────────────────────────
  // Logged once after a short delay so other scripts have time to register.
  setTimeout(function() {
    vlog("info", "dependency check: VfGeomCore=" + (!!global.VfGeomCore) +
      " VfGeomMath=" + (!!global.VfGeomMath) +
      " VfGeomWgpu=" + (!!global.VfGeomWgpu));
    if (!global.VfGeomCore)  { vlog("warn", "VfGeomCore not found — vf-geom-core.js may not be loaded or failed"); }
    if (!global.VfGeomMath)  { vlog("warn", "VfGeomMath not found — vf-geom-math.js may not be loaded or failed"); }
    if (!global.VfGeomWgpu)  { vlog("warn", "VfGeomWgpu not found — vf-geom-wgpu.js may not be loaded or failed"); }
  }, 800);

  // ── Keyboard events ────────────────────────────────────────────────────
  // Attached to window once — keyboard events have no natural canvas target.
  (function() {
    if (global.__vfKeyboardAttached) { return; }
    global.__vfKeyboardAttached = true;

    function activeFrameId() {
      // Try to find which frame has focus or is under the pointer
      var active = document.activeElement;
      if (active) {
        var fr = active.closest && active.closest(".vf-frame");
        if (fr) { return fr.getAttribute("data-vf-frame-id") || ""; }
      }
      return "";
    }

    function keyEvt(evtName, e) {
      postEvent({
        type:     "vf_event",
        event:    evtName,
        key:      e.key,
        code:     e.code || "",
        ctrl:     e.ctrlKey  || false,
        shift:    e.shiftKey || false,
        alt:      e.altKey   || false,
        frame_id: activeFrameId(),
      });
    }

    global.addEventListener("keydown", function(e) { keyEvt("key_down", e); }, { passive: true, capture: true });
    global.addEventListener("keyup",   function(e) { keyEvt("key_up",   e); }, { passive: true, capture: true });
    vlog("info", "keyboard listeners attached");
  })();

  installGlobalWheelBridge();
  installGlobalDragBridge();
  global.VfDisplay = {
    renderFromJson: renderFromJson,
    setEventSink: setEventSink,
    getInteractiveState: function(frameId) {
      return _interactive2d[String(frameId || "__screen__")] || null;
    },
    getGameCameraState: function(frameId) {
      if (global.VfGameCamera && typeof global.VfGameCamera.getState === "function") {
        return global.VfGameCamera.getState(frameId);
      }
      return null;
    },
    __test: {
      buildCombinedTriangleMesh: buildCombinedTriangleMesh,
      hoverContext: hoverContext,
      HOVER_MASK: HOVER_MASK
    }
  };
  vlog("info", "VfDisplay registered");
})(typeof window !== "undefined" ? window : this);


