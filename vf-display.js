/**
 * vf-display.js — renders from display payloads.
 * Preferred runtime path: explicit packets from vf-runtime-packets.json.
 * Legacy fallback: polling vf-display.json.
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

  var _vfDisplayScript = typeof document !== "undefined" ? document.currentScript : null;

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
  var _lastDisplayPayload = null;

  // ── Event forwarding ──────────────────────────────────────────────────────
  // frame_id -> { fid, canvases: [...] } for hit-testing
  var _frameEventMap = {};  // fid -> { fid, el }
  var _apiPort = 0;         // discovered from window.__agentPort

  function getApiPort() {
    if (_apiPort) { return _apiPort; }
    if (typeof global !== "undefined" && global.__agentPort) {
      _apiPort = parseInt(global.__agentPort, 10) || 0;
    }
    return _apiPort;
  }

  function postEvent(evt) {
    try {
      if (typeof global.CustomEvent === "function" && typeof global.dispatchEvent === "function") {
        global.dispatchEvent(new global.CustomEvent("vf_event", { detail: evt }));
      }
    } catch (_) {}
    try {
      var localOnlyFrames = global.__vfLocalOnlyFrameEvents;
      var frameId = evt && evt.frame_id != null ? String(evt.frame_id) : "";
      if (localOnlyFrames && frameId && localOnlyFrames[frameId]) {
        return;
      }
    } catch (_) {}
    try {
      if (typeof window !== "undefined" && window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
        window.chrome.webview.postMessage(evt);
        return;
      }
    } catch (_) {}
    var port = getApiPort();
    if (!port) { return; }  // no port yet — events queued until next hover/click
    var body = JSON.stringify({ line: JSON.stringify(evt) });
    try {
      fetch("http://127.0.0.1:" + port + "/api/enqueue", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    body,
      }).catch(function(){});
    } catch(_) {}
  }

  function _emptyGeomHit(frameX, frameY, fid) {
    return {
      type: "vf_event",
      x: frameX,
      y: frameY,
      frame_id: fid,
      object_id: 0,
      simplex_id: 0,
      pick_id: 0,
      pick_mask_representation: 0,
      pick_mask_carrier: 0,
      pick_mask_content: 0,
      pick_mask_exact: 0
    };
  }

  function isGeomClaimedFrame(fid) {
    try {
      var geomFrameIds = global.__vfGeomFrameIds;
      if (geomFrameIds && fid && geomFrameIds[String(fid)]) {
        return true;
      }
    } catch (_) {}
    var frameEl = findFrameEl(fid);
    var body = frameEl ? (frameEl.querySelector(".vf-frame__body") || frameEl) : null;
    return !!(
      (frameEl && frameEl.querySelector("canvas.vf-geom-canvas")) ||
      (body && body.__vfGeomFrameEventsAttached)
    );
  }

  function disableFrameCanvasEvents(fid) {
    var frameEl = findFrameEl(fid);
    if (!frameEl) { return; }
    var drawCanvas = frameEl.querySelector("canvas.vf-frame__draw-canvas");
    if (!drawCanvas) { return; }
    drawCanvas.__vfFrameEventsDisabled = true;
    drawCanvas.__vfOps = [];
    drawCanvas.style.pointerEvents = "none";
  }

  function ensureGeomFrameEvents(fid) {
    var frameEl = findFrameEl(fid);
    if (!frameEl) { return; }
    if (!global.__vfGeomFrameIds) {
      global.__vfGeomFrameIds = Object.create(null);
    }
    global.__vfGeomFrameIds[String(fid)] = true;
    disableFrameCanvasEvents(fid);
    var body = frameEl.querySelector(".vf-frame__body") || frameEl;
    if (!body || body.__vfGeomFrameEventsAttached) { return; }
    var AdapterApi = global.VfGeomFrameAdapter;
    if (!AdapterApi || typeof AdapterApi.createPointerDispatch !== "function" || typeof AdapterApi.createPointerRuntime !== "function") {
      throw new Error("ensureGeomFrameEvents(" + String(fid) + "): VfGeomFrameAdapter pointer runtime not loaded");
    }
    var pointerDispatch = AdapterApi.createPointerDispatch();
    var pickArbitrator = AdapterApi.createPickArbitrator({ emptyHit: _emptyGeomHit });
    var pointerRuntime = AdapterApi.createPointerRuntime({
      dispatch: pointerDispatch,
      requestAnimationFrame: global.requestAnimationFrame.bind(global),
      cancelAnimationFrame: global.cancelAnimationFrame.bind(global),
      performPick: function (req, cb) {
        var rec = frameRecs[fid];
        var frameRect = body ? body.getBoundingClientRect() : null;
        pickArbitrator.pickFrame({
          fid: fid,
          entries: rec && rec.entries ? rec.entries : [],
          clientX: req.clientX,
          clientY: req.clientY,
          frameRect: frameRect
        }, cb);
      },
      emit: function (hit, req) {
        if (req && req.evtType === "leave") {
          postEvent(hit);
          return;
        }
        if (req && req.evtType === "down" && body.__vfGeomDragState) {
          if (Number(hit && hit.object_id || 0) > 0 && !(req.mods && (req.mods.ctrl || req.mods.shift))) {
            body.__vfGeomDragState.hit = Object.assign({}, hit);
          } else {
            body.__vfGeomDragState = null;
          }
        }
        postEvent(Object.assign({}, hit, req.mods, { event: req.evtType }, req.extra));
      }
    });
    body.__vfGeomFrameEventsAttached = true;
    body.style.pointerEvents = "auto";
    body.__vfGeomPickRuntime = pointerRuntime;
    body.__vfGeomDragState = null;

    function emitWithPick(evtType, e, extra) {
      var mods = {
        ctrl: !!(e && e.ctrlKey),
        shift: !!(e && e.shiftKey),
        alt: !!(e && e.altKey),
        meta: !!(e && e.metaKey)
      };
      if (!body.__vfGeomPickRuntime) { return; }
      body.__vfGeomPickRuntime.enqueue({
        evtType: evtType,
        clientX: e.clientX,
        clientY: e.clientY,
        mods: mods,
        extra: extra
      });
    }

    function currentFrameMetrics() {
      var rect = body.getBoundingClientRect();
      var aspect = "";
      try {
        aspect = String(frameEl && frameEl.dataset && frameEl.dataset.vfAspect ? frameEl.dataset.vfAspect : "").trim().toLowerCase();
      } catch (_) {}
      if (aspect === "equal") {
        var fitSize = Math.max(1, Math.min(rect.width || 1, rect.height || 1));
        return {
          left: rect.left + ((rect.width - fitSize) * 0.5),
          top: rect.top + ((rect.height - fitSize) * 0.5),
          width: fitSize,
          height: fitSize
        };
      }
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width || 1,
        height: rect.height || 1
      };
    }

    function postDirectDrag(e) {
      var dragState = body.__vfGeomDragState;
      if (!dragState) { return false; }
      var buttons = Number(e.buttons) || 0;
      if ((buttons & 1) === 0) {
        body.__vfGeomDragState = null;
        return false;
      }
      var dx = e.clientX - dragState.lastX;
      var dy = e.clientY - dragState.lastY;
      if (!dx && !dy) {
        return true;
      }
      if (!dragState.hit || !(Number(dragState.hit.object_id || 0) > 0)) {
        return true;
      }
      dragState.lastX = e.clientX;
      dragState.lastY = e.clientY;
      var metrics = currentFrameMetrics();
      var hit = Object.assign({}, dragState.hit);
      postEvent(Object.assign({}, hit, {
        type: "vf_event",
        event: "drag",
        x: e.clientX - metrics.left,
        y: e.clientY - metrics.top,
        dx: dx,
        dy: dy,
        dx_norm: dx / (metrics.width || 1),
        dy_norm: dy / (metrics.height || 1),
        button: 0,
        buttons: buttons,
        pointerId: Number(e.pointerId) || 0,
        ctrl: !!e.ctrlKey,
        shift: !!e.shiftKey,
        alt: !!e.altKey,
        meta: !!e.metaKey,
        frame_id: fid
      }));
      return true;
    }

    body.addEventListener("pointermove", function(e) {
      if (body.__vfGeomDragState && postDirectDrag(e)) {
        return;
      }
      emitWithPick((Number(e.buttons) || 0) ? "move" : "hover", e, { buttons: Number(e.buttons) || 0 });
    }, { passive: true });

    body.addEventListener("pointerleave", function() {
      if (body.__vfGeomPickRuntime) {
        body.__vfGeomPickRuntime.leave(_emptyGeomHit(0, 0, fid));
      }
    }, { passive: true });

    body.addEventListener("pointerdown", function(e) {
      try { body.setPointerCapture(e.pointerId); } catch (_) {}
      body.__vfGeomDragState = {
        pointerId: Number(e.pointerId) || 0,
        lastX: e.clientX,
        lastY: e.clientY,
        hit: null
      };
      emitWithPick("down", e, { button: e.button, pointerId: Number(e.pointerId) || 0 });
    }, { passive: true });

    body.addEventListener("pointerup", function(e) {
      body.__vfGeomDragState = null;
      emitWithPick("up", e, { button: e.button, pointerId: Number(e.pointerId) || 0 });
      try { body.releasePointerCapture(e.pointerId); } catch (_) {}
    }, { passive: true });

    body.addEventListener("pointercancel", function(e) {
      body.__vfGeomDragState = null;
      emitWithPick("up", e, { button: e.button, pointerId: Number(e.pointerId) || 0 });
      try { body.releasePointerCapture(e.pointerId); } catch (_) {}
    }, { passive: true });

    body.addEventListener("wheel", function(e) {
      try { e.__vfHandledWheel = true; } catch(_) {}
      var r = body.getBoundingClientRect();
      var x = e.clientX - r.left;
      var y = e.clientY - r.top;
      var step = e.deltaY > 0 ? 1 : -1;
      if (e && typeof e.preventDefault === "function") { e.preventDefault(); }
      postEvent({ type: "vf_event", event: "wheel",
        x: x, y: y, step: step, delta: Number(e.deltaY) || 0,
        ctrl: !!e.ctrlKey, frame_id: fid, object_id: 0, simplex_id: 0 });
    }, { passive: false });

    vlog("info", "ensureGeomFrameEvents: frame=" + fid);
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

  function colorToCss(color) {
    if (typeof color === "string") { return color; }
    if (Array.isArray(color) && color.length >= 3) {
      var r = Number(color[0]);
      var g = Number(color[1]);
      var b = Number(color[2]);
      var a = color.length >= 4 ? Number(color[3]) : 1;
      if (!isFinite(r) || !isFinite(g) || !isFinite(b)) { return "#888"; }
      if (Math.max(Math.abs(r), Math.abs(g), Math.abs(b), Math.abs(a)) > 1) {
        if (Math.abs(r) > 1) { r = r / 255; }
        if (Math.abs(g) > 1) { g = g / 255; }
        if (Math.abs(b) > 1) { b = b / 255; }
        if (Math.abs(a) > 1) { a = a / 255; }
      }
      r = Math.max(0, Math.min(1, r));
      g = Math.max(0, Math.min(1, g));
      b = Math.max(0, Math.min(1, b));
      a = Math.max(0, Math.min(1, a));
      return "rgba(" +
        Math.round(r * 255) + ", " +
        Math.round(g * 255) + ", " +
        Math.round(b * 255) + ", " + a + ")";
    }
    return String(color != null ? color : "#888");
  }

  function pointToPx(point, w, h) {
    if (!point || point.length < 2) { return null; }
    return [point[0] * w, point[1] * h];
  }

  function pathPoints(ctx, points, w, h) {
    if (!points || !points.length) { return false; }
    var first = pointToPx(points[0], w, h);
    if (!first) { return false; }
    ctx.beginPath();
    ctx.moveTo(first[0], first[1]);
    for (var i = 1; i < points.length; i++) {
      var p = pointToPx(points[i], w, h);
      if (!p) { return false; }
      ctx.lineTo(p[0], p[1]);
    }
    return true;
  }

  function applyLinePattern(ctx, pattern, widthPx) {
    var p = String(pattern || "solid");
    if (p === "dashed") {
      ctx.setLineDash([Math.max(4, widthPx * 3), Math.max(3, widthPx * 2)]);
      return;
    }
    if (p === "dotted") {
      ctx.setLineDash([Math.max(1, widthPx), Math.max(3, widthPx * 2.2)]);
      return;
    }
    ctx.setLineDash([]);
  }

  function drawPointShape(ctx, shape, x, y, r) {
    var s = String(shape || "circle");
    if (s === "square") {
      ctx.beginPath();
      ctx.rect(x - r, y - r, r * 2, r * 2);
      ctx.fill();
      return;
    }
    if (s === "diamond") {
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawOpList(ctx, w, h, ops) {
    if (!w || !h || !ctx) { return; }
    ctx.clearRect(0, 0, w, h);
    if (!ops || !ops.length) { return; }
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      if (!o) { continue; }
      if (o.op === "polygon") {
        if (!pathPoints(ctx, o.points, w, h)) { continue; }
        ctx.closePath();
        if (o.color != null) {
          ctx.fillStyle = colorToCss(o.color);
          ctx.fill();
        }
        if (o.strokeColor != null && o.strokeWidth != null) {
          ctx.strokeStyle = colorToCss(o.strokeColor);
          ctx.lineWidth = Math.max(1, Number(o.strokeWidth) * Math.min(w, h));
          ctx.setLineDash([]);
          ctx.stroke();
        }
        continue;
      }
      if (o.op === "polyline") {
        if (!pathPoints(ctx, o.points, w, h)) { continue; }
        ctx.strokeStyle = colorToCss(o.color);
        ctx.lineWidth = Math.max(1, (Number(o.width) || 0) * Math.min(w, h));
        ctx.lineCap = String(o.cap || "round");
        applyLinePattern(ctx, o.pattern, ctx.lineWidth);
        ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }
      if (o.op === "point") {
        var pp = pointToPx(o.point, w, h);
        if (!pp) { continue; }
        ctx.fillStyle = colorToCss(o.color);
        drawPointShape(ctx, o.shape, pp[0], pp[1], Math.max(1, (Number(o.radius) || 0) * Math.min(w, h)));
        continue;
      }
      var p = normToPx(o.rect, w, h);
      if (!p) { continue; }
      ctx.fillStyle = colorToCss(o.color);
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

  function _opPickFields(op) {
    if (!op || typeof op !== "object") {
      return {
        pick_id: 0,
        pick_mask_representation: 0,
        pick_mask_carrier: 0,
        pick_mask_content: 0,
        pick_mask_exact: 0
      };
    }
    return {
      pick_id: Number(op.pick_id) || 0,
      pick_mask_representation: Number(op.pick_mask_representation) || 0,
      pick_mask_carrier: Number(op.pick_mask_carrier) || 0,
      pick_mask_content: Number(op.pick_mask_content) || 0,
      pick_mask_exact: Number(op.pick_mask_exact) || 0
    };
  }

  function _distToSegmentSq(px, py, ax, ay, bx, by) {
    var abx = bx - ax;
    var aby = by - ay;
    var ab2 = abx * abx + aby * aby;
    if (ab2 <= 1e-12) {
      var dx0 = px - ax;
      var dy0 = py - ay;
      return dx0 * dx0 + dy0 * dy0;
    }
    var t = ((px - ax) * abx + (py - ay) * aby) / ab2;
    if (t < 0) { t = 0; }
    if (t > 1) { t = 1; }
    var qx = ax + abx * t;
    var qy = ay + aby * t;
    var dx = px - qx;
    var dy = py - qy;
    return dx * dx + dy * dy;
  }

  function _pointInPolygon(px, py, points, w, h) {
    var inside = false;
    for (var i = 0, j = points.length - 1; i < points.length; j = i++) {
      var pi = pointToPx(points[i], w, h);
      var pj = pointToPx(points[j], w, h);
      if (!pi || !pj) { return false; }
      var xi = pi[0], yi = pi[1];
      var xj = pj[0], yj = pj[1];
      var intersects = ((yi > py) !== (yj > py)) &&
        (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-12) + xi);
      if (intersects) { inside = !inside; }
    }
    return inside;
  }

  function _pointHitsDiamond(px, py, cx, cy, r) {
    if (r <= 0) { return false; }
    return (Math.abs(px - cx) + Math.abs(py - cy)) <= r;
  }

  function _hitTestFrameOps(ops, w, h, px, py) {
    if (!ops || !ops.length || !w || !h) { return null; }
    for (var i = ops.length - 1; i >= 0; i--) {
      var op = ops[i];
      if (!op || typeof op !== "object") { continue; }
      if (op.op === "point") {
        var pp = pointToPx(op.point, w, h);
        if (!pp) { continue; }
        var r = Math.max(1, (Number(op.radius) || 0) * Math.min(w, h));
        var hit = false;
        var shape = String(op.shape || "circle");
        if (shape === "square") {
          hit = px >= (pp[0] - r) && px <= (pp[0] + r) && py >= (pp[1] - r) && py <= (pp[1] + r);
        } else if (shape === "diamond") {
          hit = _pointHitsDiamond(px, py, pp[0], pp[1], r);
        } else {
          var dxp = px - pp[0];
          var dyp = py - pp[1];
          hit = (dxp * dxp + dyp * dyp) <= (r * r);
        }
        if (hit) {
          return Object.assign({ object_id: 1, simplex_id: i }, _opPickFields(op));
        }
        continue;
      }
      if (op.op === "polyline") {
        var pts = op.points;
        if (!Array.isArray(pts) || pts.length < 2) { continue; }
        var tol = Math.max(3, (Number(op.width) || 0) * Math.min(w, h) * 0.75);
        var tolSq = tol * tol;
        var segHit = false;
        for (var s = 0; s < pts.length - 1; s++) {
          var a = pointToPx(pts[s], w, h);
          var b = pointToPx(pts[s + 1], w, h);
          if (!a || !b) { continue; }
          if (_distToSegmentSq(px, py, a[0], a[1], b[0], b[1]) <= tolSq) {
            segHit = true;
            break;
          }
        }
        if (segHit) {
          return Object.assign({ object_id: 1, simplex_id: i }, _opPickFields(op));
        }
        continue;
      }
      if (op.op === "polygon") {
        if (_pointInPolygon(px, py, op.points, w, h)) {
          return Object.assign({ object_id: 1, simplex_id: i }, _opPickFields(op));
        }
      }
    }
    return null;
  }

  function attachFrameCanvasEvents(canvas, fid) {
    if (!canvas || canvas.__vfFrameEventsAttached) { return; }
    if (canvas.__vfFrameEventsDisabled || isGeomClaimedFrame(fid)) {
      canvas.__vfFrameEventsDisabled = true;
      canvas.style.pointerEvents = "none";
      return;
    }
    canvas.__vfFrameEventsAttached = true;
    canvas.style.pointerEvents = "auto";

    function canvasXY(e) {
      var r = canvas.getBoundingClientRect();
      var sx = canvas.width / (r.width || 1);
      var sy = canvas.height / (r.height || 1);
      return {
        x: (e.clientX - r.left) * sx,
        y: (e.clientY - r.top) * sy,
        cx: e.clientX - r.left,
        cy: e.clientY - r.top
      };
    }

    function emit(evtType, e, extra) {
      var p = canvasXY(e);
      var hit = _hitTestFrameOps(canvas.__vfOps || [], canvas.width || 0, canvas.height || 0, p.x, p.y) || {
        object_id: 0,
        simplex_id: 0,
        pick_id: 0,
        pick_mask_representation: 0,
        pick_mask_carrier: 0,
        pick_mask_content: 0,
        pick_mask_exact: 0
      };
      postEvent(Object.assign({
        type: "vf_event",
        event: evtType,
        x: p.cx,
        y: p.cy,
        frame_id: fid
      }, hit, {
        ctrl: !!(e && e.ctrlKey),
        shift: !!(e && e.shiftKey),
        alt: !!(e && e.altKey),
        meta: !!(e && e.metaKey)
      }, extra));
    }

    canvas.addEventListener("pointerdown", function(e) {
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      emit("down", e, { button: e.button });
    }, { passive: true });

    canvas.addEventListener("pointerup", function(e) {
      emit("up", e, { button: e.button });
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    }, { passive: true });

    canvas.addEventListener("pointercancel", function(e) {
      emit("up", e, { button: e.button });
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    }, { passive: true });

    canvas.addEventListener("pointermove", function(e) {
      emit("hover", e, { buttons: Number(e.buttons) || 0 });
    }, { passive: true });
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
        postEvent({
          type: "vf_event",
          event: "wheel",
          x: x, y: y,
          step: step,
          delta: dy,
          ctrl: !!e.ctrlKey,
          frame_id: fid,
          object_id: 0,
          simplex_id: 0
        });
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
        var frameBody = frameEl.querySelector(".vf-frame__body");
        if (frameBody && frameBody.__vfGeomFrameEventsAttached) { return; }
        var fid = frameEl.getAttribute("data-vf-frame-id") || "";
        var rect = frameEl.getBoundingClientRect();
        _dragState = {
          fid: fid,
          lastX: e.clientX,
          lastY: e.clientY,
          width: rect && rect.width ? rect.width : 1,
          height: rect && rect.height ? rect.height : 1
        };
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
        var activeFrameEl = _dragState.fid ? findFrameEl(_dragState.fid) : null;
        var activeFrameBody = activeFrameEl ? (activeFrameEl.querySelector(".vf-frame__body") || activeFrameEl) : null;
        if (activeFrameBody && activeFrameBody.__vfGeomFrameEventsAttached) {
          _dragState = null;
          return;
        }
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
        postEvent({
          type: "vf_event",
          event: "drag",
          x: e.clientX,
          y: e.clientY,
          dx: dx,
          dy: dy,
          dx_norm: dx / (_dragState.width || 1),
          dy_norm: dy / (_dragState.height || 1),
          button: 0,
          buttons: buttons,
          ctrl: !!e.ctrlKey,
          shift: !!e.shiftKey,
          alt: !!e.altKey,
          meta: !!e.metaKey,
          frame_id: _dragState.fid,
          object_id: 0,
          simplex_id: 0
        });
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

  function buildUnifiedFrameScene(specs, camera, lights) {
    if (!Array.isArray(specs) || !specs.length) { return null; }
    var parts = [];
    for (var i = 0; i < specs.length; i++) {
      var mesh = buildSingleMesh(specs[i], camera, lights);
      if (!mesh) { return null; }
      mesh.object_id = Number(specs[i] && specs[i].object_id) || (i + 1);
      parts.push(mesh);
    }
    return {
      id: "unified_frame_scene",
      parts: parts,
      camera: camera || null,
      lights: lights || [],
      mode3d: false,
      unified_renderer: true
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
        mode3d: spec.mode3d === false ? false : true,
        label: spec.id || "field_mesh",
        vertices: (verts instanceof Float32Array) ? verts : new Float32Array(verts),
        indices: (inds instanceof Uint32Array) ? inds : new Uint32Array(inds),
        topology: spec.topology || "triangle-list",
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
    out.transparent = spec.transparent === true || out.alpha < 0.999;
    out.depth_write = spec.depth_write === true;
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

  function prewarmGeomRenderer(renderer) {
    if (!renderer || typeof renderer._renderContent !== "function") { return; }
    try {
      var now = (global.performance && typeof global.performance.now === "function")
        ? global.performance.now()
        : Date.now();
      renderer._renderContent(now);
    } catch (err) {
      vlog("warn", "prewarmGeomRenderer failed: " + (err && err.message ? err.message : String(err)));
    }
  }

  // ── Notify native host of updated hit regions after geom frames change ─────
  var _layoutDebounceTimer = null;
  function collectGeomFrameBodyHitRegions() {
    var out = [];
    var keys = Object.keys(frameRecs || {});
    for (var i = 0; i < keys.length; i += 1) {
      var fid = keys[i];
      var rec = frameRecs[fid];
      if (!rec || !rec.entries || rec.entries.length < 1) { continue; }
      var hasRenderer = false;
      for (var j = 0; j < rec.entries.length; j += 1) {
        if (rec.entries[j] && rec.entries[j].renderer) {
          hasRenderer = true;
          break;
        }
      }
      if (!hasRenderer) { continue; }
      var frameEl = findFrameEl(fid);
      if (!frameEl) { continue; }
      var body = frameEl.querySelector(".vf-frame__body") || frameEl;
      var rect = body.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) { continue; }
      out.push({
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom)
      });
    }
    return out;
  }

  function schedulePostGeomLayout() {
    if (_layoutDebounceTimer) { clearTimeout(_layoutDebounceTimer); }
    _layoutDebounceTimer = setTimeout(function() {
      _layoutDebounceTimer = null;
      var layer = document.getElementById("layer") || document.getElementById("vf-layer") || document.body;
      if (global.VfFrame && typeof global.VfFrame.postNativeHostLayout === "function") {
        global.VfFrame.postNativeHostLayout(layer, {
          stageAlpha: 0,
          hitRegions: collectGeomFrameBodyHitRegions()
        });
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
    var lights  = geomSpec.lights || [];
    var unifiedScene = geomSpec && geomSpec.unified_renderer === true
      ? buildUnifiedFrameScene(specs, camera, lights)
      : null;
    var combinedTransparent = !unifiedScene && geomSpec && geomSpec.combine_transparent === true && specs.length > 1
      ? buildCombinedTransparentMesh(specs, camera, lights)
      : null;
    var renderSpecs = unifiedScene
      ? [{ __mesh: unifiedScene, type: "unified_frame_scene" }]
      : combinedTransparent
      ? [{ __mesh: combinedTransparent, type: "combined_transparent" }]
      : specs;

    vlog("info", "updateGeomFrame [" + fid + "]: meshes=" + specs.length +
      (unifiedScene ? " (unified frame renderer)" : "") +
      (combinedTransparent ? " (combined transparent pass)" : "") +
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
          var entry = { renderer: null, ref: rh, _logCount: 0, resizeObserver: null, resizeRaf: 0 };
          rec.entries.push(entry);
          var r = new Ctor(canvas, function() { return rh.mesh; });
          entry.renderer = r;
          entry.canvas = cv;
          cv.style.opacity = String(mesh.alpha == null ? 1 : mesh.alpha);
          cv.style.pointerEvents = "none";
          // Assign stable object_id (1-based: 0 means "no object")
          r._objectId = meshIdx + 1;
          r.init().then(function(ok) {
            if (!ok) {
              vlog("error", "updateGeomFrame [" + fidInner + "]: renderer " + meshIdx + " init FAILED (WebGPU unavailable?)");
            } else {
              vlog("info", "updateGeomFrame [" + fidInner + "]: renderer " + meshIdx + " init OK, starting render loop");
              prewarmGeomRenderer(r);
              r.start();
              if (typeof ResizeObserver === "function") {
                var host = cv.parentElement || cv;
                entry.resizeObserver = new ResizeObserver(function () {
                  if (entry.resizeRaf) { return; }
                  entry.resizeRaf = requestAnimationFrame(function () {
                    entry.resizeRaf = 0;
                    syncCanvasSize(cv);
                    if (r && typeof r.onResize === "function") {
                      r.onResize();
                    }
                  });
                });
                entry.resizeObserver.observe(host);
              }
              ensureGeomFrameEvents(fidInner);
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
        if (rec.entries[j].resizeObserver) {
          rec.entries[j].resizeObserver.disconnect();
        }
      } catch(_) {}
      try {
        if (rec.entries[j].resizeRaf) {
          cancelAnimationFrame(rec.entries[j].resizeRaf);
        }
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

  function _buildDynamicGeomScene(geomSpec) {
    if (geomSpec && Array.isArray(geomSpec.parts)) {
      return geomSpec;
    }
    if (!geomSpec || !Array.isArray(geomSpec.meshes)) {
      throw new Error("dynamic geom provider returned invalid spec");
    }
    var scene = geomSpec && geomSpec.unified_renderer === true
      ? buildUnifiedFrameScene(geomSpec.meshes, geomSpec.camera || null, geomSpec.lights || [])
      : null;
    if (!scene) {
      throw new Error("dynamic geom provider did not produce a unified scene");
    }
    return scene;
  }

  function mountDynamicGeomFrame(fid, provider) {
    if (typeof provider !== "function") {
      throw new Error("mountDynamicGeomFrame(" + String(fid) + "): provider must be a function");
    }
    var Ctor = global.VfGeomWgpu;
    if (!Ctor) {
      throw new Error("mountDynamicGeomFrame(" + String(fid) + "): VfGeomWgpu not loaded");
    }
    var frameEl = findFrameEl(fid);
    if (!frameEl) {
      throw new Error("mountDynamicGeomFrame(" + String(fid) + "): frame DOM element not found");
    }
    var AdapterCtor = global.VfGeomFrameAdapter;
    if (!AdapterCtor || typeof AdapterCtor.createAdapter !== "function") {
      throw new Error("mountDynamicGeomFrame(" + String(fid) + "): VfGeomFrameAdapter not loaded");
    }
    if (!frameRecs[fid]) { frameRecs[fid] = { entries: [] }; }
    if (!global.__vfGeomFrameIds) {
      global.__vfGeomFrameIds = Object.create(null);
    }
    global.__vfGeomFrameIds[String(fid)] = true;
    disableFrameCanvasEvents(fid);
    var rec = frameRecs[fid];
    if (!rec.dynamicAdapter) {
      rec.dynamicAdapter = AdapterCtor.createAdapter({
        provider: provider,
        buildScene: _buildDynamicGeomScene
      });
    } else {
      rec.dynamicAdapter.replaceProvider(provider);
    }

    if (rec.entries.length > 0 && rec.entries[0] && rec.entries[0].renderer) {
      ensureGeomFrameEvents(fid);
      schedulePostGeomLayout();
      return;
    }

    var canvas = ensureGeomCanvas(frameEl, 0);
    if (!canvas) {
      throw new Error("mountDynamicGeomFrame(" + String(fid) + "): could not create geom canvas");
    }
    syncCanvasSize(canvas);
    var entry = { renderer: null, ref: null, _logCount: 0, resizeObserver: null, resizeRaf: 0, canvas: canvas };
    rec.entries = [entry];
    var refHolder = {
      get mesh() {
        if (!rec.dynamicAdapter) { return null; }
        try {
          return rec.dynamicAdapter.currentScene();
        } catch (err) {
          vlog("error", err && err.message ? err.message : String(err));
          return null;
        }
      }
    };
    entry.ref = refHolder;
    var r = new Ctor(canvas, function() { return refHolder.mesh; });
    entry.renderer = r;
    canvas.style.pointerEvents = "none";
    r.init().then(function(ok) {
      if (!ok) {
        vlog("error", "mountDynamicGeomFrame [" + fid + "]: renderer init FAILED");
        return;
      }
      vlog("info", "mountDynamicGeomFrame [" + fid + "]: renderer init OK, starting render loop");
      prewarmGeomRenderer(r);
      r.start();
      if (typeof ResizeObserver === "function") {
        var host = canvas.parentElement || canvas;
        entry.resizeObserver = new ResizeObserver(function () {
          if (entry.resizeRaf) { return; }
          entry.resizeRaf = requestAnimationFrame(function () {
            entry.resizeRaf = 0;
            syncCanvasSize(canvas);
            if (rec.dynamicAdapter) {
              rec.dynamicAdapter.onHostResize(host.clientWidth || 0, host.clientHeight || 0);
            }
            if (r && typeof r.onResize === "function") {
              r.onResize();
            }
          });
        });
        entry.resizeObserver.observe(host);
        if (rec.dynamicAdapter) {
          rec.dynamicAdapter.onHostResize(host.clientWidth || 0, host.clientHeight || 0);
        }
      }
      ensureGeomFrameEvents(fid);
      schedulePostGeomLayout();
    }).catch(function(err) {
      vlog("error", "mountDynamicGeomFrame [" + fid + "]: renderer init threw: " + (err && err.message ? err.message : String(err)));
    });
  }

  function mountLedgerGeomFrame(fid, ledger, selectGeomSpec) {
    if (!ledger || typeof ledger.snapshot !== "function") {
      throw new Error("mountLedgerGeomFrame(" + String(fid) + "): ledger must expose snapshot()");
    }
    var Ctor = global.VfGeomWgpu;
    if (!Ctor) {
      throw new Error("mountLedgerGeomFrame(" + String(fid) + "): VfGeomWgpu not loaded");
    }
    var frameEl = findFrameEl(fid);
    if (!frameEl) {
      throw new Error("mountLedgerGeomFrame(" + String(fid) + "): frame DOM element not found");
    }
    var AdapterCtor = global.VfGeomFrameAdapter;
    if (!AdapterCtor || typeof AdapterCtor.createLedgerAdapter !== "function") {
      throw new Error("mountLedgerGeomFrame(" + String(fid) + "): VfGeomFrameAdapter ledger runtime not loaded");
    }
    if (!frameRecs[fid]) { frameRecs[fid] = { entries: [] }; }
    if (!global.__vfGeomFrameIds) {
      global.__vfGeomFrameIds = Object.create(null);
    }
    global.__vfGeomFrameIds[String(fid)] = true;
    disableFrameCanvasEvents(fid);
    var rec = frameRecs[fid];
    if (rec.dynamicAdapter && typeof rec.dynamicAdapter.dispose === "function") {
      try { rec.dynamicAdapter.dispose(); } catch (_) {}
    }
    rec.dynamicAdapter = AdapterCtor.createLedgerAdapter({
      ledger: ledger,
      selectGeomSpec: selectGeomSpec,
      buildScene: _buildDynamicGeomScene
    });

    if (rec.entries.length > 0 && rec.entries[0] && rec.entries[0].renderer) {
      ensureGeomFrameEvents(fid);
      schedulePostGeomLayout();
      return;
    }

    var canvas = ensureGeomCanvas(frameEl, 0);
    if (!canvas) {
      throw new Error("mountLedgerGeomFrame(" + String(fid) + "): could not create geom canvas");
    }
    syncCanvasSize(canvas);
    var entry = { renderer: null, ref: null, _logCount: 0, resizeObserver: null, resizeRaf: 0, canvas: canvas };
    rec.entries = [entry];
    var refHolder = {
      get mesh() {
        if (!rec.dynamicAdapter) { return null; }
        try {
          return rec.dynamicAdapter.currentScene();
        } catch (err) {
          vlog("error", err && err.message ? err.message : String(err));
          return null;
        }
      }
    };
    entry.ref = refHolder;
    var r = new Ctor(canvas, function() { return refHolder.mesh; });
    entry.renderer = r;
    canvas.style.pointerEvents = "none";
    r.init().then(function(ok) {
      if (!ok) {
        vlog("error", "mountLedgerGeomFrame [" + fid + "]: renderer init FAILED");
        return;
      }
      vlog("info", "mountLedgerGeomFrame [" + fid + "]: renderer init OK, starting render loop");
      prewarmGeomRenderer(r);
      r.start();
      if (typeof ResizeObserver === "function") {
        var host = canvas.parentElement || canvas;
        entry.resizeObserver = new ResizeObserver(function () {
          if (entry.resizeRaf) { return; }
          entry.resizeRaf = requestAnimationFrame(function () {
            entry.resizeRaf = 0;
            syncCanvasSize(canvas);
            if (rec.dynamicAdapter) {
              rec.dynamicAdapter.onHostResize(host.clientWidth || 0, host.clientHeight || 0);
            }
            if (r && typeof r.onResize === "function") {
              r.onResize();
            }
          });
        });
        entry.resizeObserver.observe(host);
        if (rec.dynamicAdapter) {
          rec.dynamicAdapter.onHostResize(host.clientWidth || 0, host.clientHeight || 0);
        }
      }
      ensureGeomFrameEvents(fid);
      schedulePostGeomLayout();
    }).catch(function(err) {
      vlog("error", "mountLedgerGeomFrame [" + fid + "]: renderer init threw: " + (err && err.message ? err.message : String(err)));
    });
  }

  function requestDynamicGeomFrameUpdate(fid) {
    var rec = frameRecs[fid];
    if (!rec || !rec.dynamicAdapter) {
      vlog("warn", "requestDynamicGeomFrameUpdate [" + fid + "]: no dynamic geom frame mounted");
      return;
    }
    rec.dynamicAdapter.markDirty();
  }

  // ── Main render from JSON ─────────────────────────────────────────────────

  function renderFromJson(data) {
    if (!data || typeof data !== "object") {
      vlog("warn", "renderFromJson: data is null or not an object");
      return;
    }
    _lastDisplayPayload = data;

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
        drawOpList(get2d(sc), sz.w, sz.h, data.screen);
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
        if (isGeomClaimedFrame(fid)) {
          disableFrameCanvasEvents(fid);
          continue;
        }
        var cv = el.querySelector("canvas.vf-frame__draw-canvas");
        if (!cv) { continue; }
        var fsz = syncCanvasSize(cv);
        if (!fsz) { continue; }
        cv.__vfOps = frames[fid];
        attachFrameCanvasEvents(cv, fid);
        drawOpList(get2d(cv), fsz.w, fsz.h, frames[fid]);
      }
    }

    // Empty frames still need a live event surface.
    var frameEls = document.querySelectorAll(".vf-frame[data-vf-frame-id]");
    for (var i = 0; i < frameEls.length; i++) {
      var frameEl = frameEls[i];
      if (!(frameEl instanceof Element)) { continue; }
      var emptyFid = frameEl.getAttribute("data-vf-frame-id") || "";
      if (!emptyFid) { continue; }
      if (isGeomClaimedFrame(emptyFid)) {
        disableFrameCanvasEvents(emptyFid);
        continue;
      }
      var emptyCanvas = frameEl.querySelector("canvas.vf-frame__draw-canvas");
      if (!emptyCanvas) { continue; }
      if (!syncCanvasSize(emptyCanvas)) { continue; }
      if (!emptyCanvas.__vfOps) {
        emptyCanvas.__vfOps = [];
      }
      attachFrameCanvasEvents(emptyCanvas, emptyFid);
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

  function applyRuntimePacket(packet) {
    if (!packet || typeof packet !== "object") { return; }
    var kind = String(packet.kind || "");
    var payload = packet.payload;
    if (kind === "display.replace" && payload && payload.display && typeof payload.display === "object") {
      renderFromJson(payload.display);
    }
  }

  // ── Fetch + render cycle ──────────────────────────────────────────────────

  function displayJsonUrl() {
    if (typeof location === "undefined" || !location.href) { return "vf-display.json"; }
    var path = location.pathname || "/";
    var i = path.lastIndexOf("/");
    var base = i >= 0 ? path.substring(0, i+1) : "/";
    return base + "vf-display.json";
  }

  var _lastFetchFailed = false;
  var _fetchInFlight   = false;   // prevent fetch pile-up at 60 fps

  function loadAndRender() {
    if (typeof fetch === "undefined") {
      vlog("warn", "loadAndRender: fetch not available");
      return;
    }
    if (_fetchInFlight) { return; }   // previous frame's fetch not done yet — skip
    _fetchInFlight = true;
    var url = displayJsonUrl();        // no cache-buster — cache:"no-store" is enough
    fetch(url, { cache: "no-store" })
      .then(function(r) {
        if (!r.ok) {
          if (!_lastFetchFailed) {
            vlog("warn", "loadAndRender: vf-display.json fetch " + r.status + " (file may not exist yet)");
            _lastFetchFailed = true;
          }
          return null;
        }
        _lastFetchFailed = false;
        return r.text();
      })
      .then(function(t) {
        if (t == null) { return; }
        var o; try { o = JSON.parse(t); } catch(e) {
          vlog("error", "loadAndRender: JSON.parse failed: " + e.message + " (first 200 chars: " + t.slice(0,200) + ")");
          return;
        }
        renderFromJson(o);
      })
      .catch(function(err) {
        vlog("warn", "loadAndRender: fetch error: " + (err && err.message ? err.message : String(err)));
      })
      .finally(function() { _fetchInFlight = false; });
  }

  function redrawCurrentDisplay() {
    if (!_lastDisplayPayload) { return false; }
    renderFromJson(_lastDisplayPayload);
    return true;
  }

  function resolveRuntimeShellScriptUrl() {
    if (_vfDisplayScript && _vfDisplayScript.src && typeof URL !== "undefined") {
      try {
        var u = new URL(_vfDisplayScript.src, document.baseURI);
        u.pathname = u.pathname.replace(/vf-display\.js$/, "vf-runtime-shell.js");
        return u.toString();
      } catch (_) {}
    }
    return "vf-runtime-shell.js";
  }

  function ensureRuntimeShellLoaded() {
    if (global.VfRuntimeShell || typeof document === "undefined") { return; }
    if (document.querySelector('script[data-vf-runtime-shell-module="true"]')) { return; }
    var script = document.createElement("script");
    script.src = resolveRuntimeShellScriptUrl();
    script.async = false;
    script.setAttribute("data-vf-runtime-shell-module", "true");
    var parent = document.head || document.body || document.documentElement;
    if (!parent) { return; }
    parent.appendChild(script);
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
    loadAndRender: loadAndRender,
    applyRuntimePacket: applyRuntimePacket,
    redrawCurrentDisplay: redrawCurrentDisplay,
    mountDynamicGeomFrame: mountDynamicGeomFrame,
    mountLedgerGeomFrame: mountLedgerGeomFrame,
    requestDynamicGeomFrameUpdate: requestDynamicGeomFrameUpdate
  };
  ensureRuntimeShellLoaded();
  vlog("info", "VfDisplay registered");
})(typeof window !== "undefined" ? window : this);
