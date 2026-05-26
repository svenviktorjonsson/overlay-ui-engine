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
 *   { type:"box|ellipsoid|torus|field_mesh", center:[x,y,z], scale:[sx,sy,sz], color:"red", rotation:[rx,ry,rz], texture:{...}, ... }
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
  if (!global.__vfFrameRenderers) {
    global.__vfFrameRenderers = Object.create(null);
  }
  var _lastPayloadSummary = "";   // cheap change-detect for log spam suppression
  var _lastDisplayPayload = null;
  var _plotCameraRaf = Object.create(null);
  var _geomTextFollow = Object.create(null);
  var _geomTextFollowRaf = 0;
  var _mathTextHtmlCache = Object.create(null);

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

  function frameAspectMode(frameEl) {
    try {
      return String(frameEl && frameEl.dataset && frameEl.dataset.vfAspect ? frameEl.dataset.vfAspect : "").trim().toLowerCase();
    } catch (_) {
      return "";
    }
  }

  function fittedFrameContentRect(frameEl, hostEl) {
    var rect = hostEl && typeof hostEl.getBoundingClientRect === "function"
      ? hostEl.getBoundingClientRect()
      : { left: 0, top: 0, width: 1, height: 1 };
    var width = Math.max(1, rect.width || 1);
    var height = Math.max(1, rect.height || 1);
    var localLeft = 0;
    var localTop = 0;
    if (frameAspectMode(frameEl) === "equal") {
      var fitSize = Math.max(1, Math.min(width, height));
      localLeft = (width - fitSize) * 0.5;
      localTop = (height - fitSize) * 0.5;
      width = fitSize;
      height = fitSize;
    }
    return {
      left: rect.left + localLeft,
      top: rect.top + localTop,
      width: width,
      height: height,
      localLeft: localLeft,
      localTop: localTop
    };
  }

  function geomFrameOverscanPx(fid, width, height) {
    return 0;
  }

  function geomFrameRenderRect(frameEl, hostEl, fid) {
    var fit = fittedFrameContentRect(frameEl, hostEl);
    var pad = geomFrameOverscanPx(fid, fit.width, fit.height);
    if (!(pad > 0)) { return fit; }
    return {
      left: fit.left - pad,
      top: fit.top - pad,
      width: fit.width + pad * 2,
      height: fit.height + pad * 2,
      localLeft: fit.localLeft - pad,
      localTop: fit.localTop - pad,
      overscan: pad
    };
  }

  function geomTargetFrameId(fid) {
    var text = String(fid || "");
    var sep = text.indexOf(":");
    return sep > 0 ? text.slice(0, sep) : text;
  }

  function geomTargetWidgetId(fid) {
    var text = String(fid || "");
    var sep = text.indexOf(":");
    return sep > 0 ? text.slice(sep + 1) : "";
  }

  function geomFrameHost(frameEl, fid) {
    var body = frameEl ? (frameEl.querySelector(".vf-frame__body") || frameEl) : null;
    if (!body || typeof body.querySelector !== "function") {
      return body || frameEl;
    }
    var widgetId = geomTargetWidgetId(fid);
    if (widgetId) {
      var widgets = global.VfWidgets;
      var record = widgets && typeof widgets.widgetRecord === "function"
        ? widgets.widgetRecord(geomTargetFrameId(fid), widgetId)
        : null;
      if (record && record.root) {
        return record.root;
      }
    }
    var panels = body.querySelectorAll("[data-vf-plot-panel='1']");
    for (var i = 0; i < panels.length; i += 1) {
      var candidate = panels[i];
      if (candidate && candidate.offsetParent !== null) {
        return candidate;
      }
    }
    var panel = panels[0] || null;
    if (panel) {
      return panel;
    }
    return body;
  }

  function ensureGeomFrameEvents(fid) {
    var frameEl = findFrameEl(geomTargetFrameId(fid));
    if (!frameEl) { return; }
    if (!global.__vfGeomFrameIds) {
      global.__vfGeomFrameIds = Object.create(null);
    }
    global.__vfGeomFrameIds[String(fid)] = true;
    disableFrameCanvasEvents(fid);
    var body = geomFrameHost(frameEl, fid);
    if (!body || body.__vfGeomFrameEventsAttached) { return; }
    var geomSpecForEvents = _lastDisplayPayload && _lastDisplayPayload.geom ? _lastDisplayPayload.geom[String(fid)] : null;
    if (geomSpecForEvents && geomSpecForEvents.axis3d_controls === true) {
      body.__vfGeomFrameEventsAttached = true;
      body.style.pointerEvents = "auto";
      vlog("info", "ensureGeomFrameEvents: frame=" + fid + " using axis3d controls, generic picking disabled");
      return;
    }
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
          postEvent(Object.assign({}, hit, { event: "leave" }));
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
      return fittedFrameContentRect(frameEl, body);
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
        if (frameBody && frameBody.__vfGeomFrameEventsAttached && !frameBody.__vfAxis3DControlsAttached) { return; }
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
        if (activeFrameBody && activeFrameBody.__vfGeomFrameEventsAttached && !activeFrameBody.__vfAxis3DControlsAttached) {
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
    var frameEl = canvas.closest ? canvas.closest(".vf-frame") : null;
    var hostEl = canvas.parentElement || canvas;
    var fid = frameEl && frameEl.getAttribute ? frameEl.getAttribute("data-vf-frame-id") : "";
    var fit = geomFrameRenderRect(frameEl, hostEl, fid);
    var w = Math.max(1, Math.floor(fit.width));
    var h = Math.max(1, Math.floor(fit.height));
    if (canvas.style) {
      canvas.style.left = Math.round(fit.localLeft) + "px";
      canvas.style.top = Math.round(fit.localTop) + "px";
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      canvas.style.right = "auto";
      canvas.style.bottom = "auto";
      canvas.style.inset = "auto";
    }
    if (canvas.width  !== w) { canvas.width  = w; }
    if (canvas.height !== h) { canvas.height = h; }
    return { w: w, h: h, left: fit.left, top: fit.top };
  }

  function findWidgetCanvas(fid, wid) {
    var widgets = global.VfWidgets;
    var record = widgets && typeof widgets.widgetRecord === "function"
      ? widgets.widgetRecord(fid, wid)
      : null;
    var el = record && record.el;
    if (el && String(el.tagName || "").toLowerCase() === "canvas") {
      return el;
    }
    var root = record && record.root;
    if (root && typeof root.querySelector === "function") {
      return root.querySelector("canvas");
    }
    return null;
  }

  function drawFrameOrWidgetOps(fid, ops) {
    var key = String(fid || "");
    var sep = key.indexOf(":");
    if (sep > 0) {
      var frameId = key.slice(0, sep);
      var widgetId = key.slice(sep + 1);
      var widgetCanvas = findWidgetCanvas(frameId, widgetId);
      if (!widgetCanvas) {
        vlog("warn", "renderFromJson: widget canvas [" + key + "] not found");
        return;
      }
      var wsz = syncCanvasSize(widgetCanvas);
      if (!wsz) { return; }
      widgetCanvas.__vfOps = ops;
      drawOpList(get2d(widgetCanvas), wsz.w, wsz.h, ops);
      return;
    }
    var el = findFrameEl(key);
    if (!el) {
      vlog("warn", "renderFromJson: 2D frame [" + key + "] not found in DOM");
      return;
    }
    if (isGeomClaimedFrame(key)) {
      disableFrameCanvasEvents(key);
      return;
    }
    var cv = el.querySelector("canvas.vf-frame__draw-canvas");
    if (!cv) { return; }
    var fsz = syncCanvasSize(cv);
    if (!fsz) { return; }
    cv.__vfOps = ops;
    attachFrameCanvasEvents(cv, key);
    drawOpList(get2d(cv), fsz.w, fsz.h, ops);
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
    if (spec && spec._modelMatrix) {
      return spec._modelMatrix;
    }
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

  function meshVec3At(vertices, index) {
    var o = index * 10;
    return [Number(vertices[o] || 0), Number(vertices[o + 1] || 0), Number(vertices[o + 2] || 0)];
  }

  function meshColorAt(vertices, index) {
    var o = index * 10;
    return [
      Number(vertices[o + 6] == null ? 0.8 : vertices[o + 6]),
      Number(vertices[o + 7] == null ? 0.8 : vertices[o + 7]),
      Number(vertices[o + 8] == null ? 0.8 : vertices[o + 8]),
      Number(vertices[o + 9] == null ? 1.0 : vertices[o + 9])
    ];
  }

  function norm3(x, y, z) {
    var l = Math.sqrt(x * x + y * y + z * z);
    if (l < 1e-9) { return [0, 0, 1]; }
    return [x / l, y / l, z / l];
  }

  function cross3(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }

  function dot3(a, b) {
    return (Number(a && a[0]) || 0) * (Number(b && b[0]) || 0) +
      (Number(a && a[1]) || 0) * (Number(b && b[1]) || 0) +
      (Number(a && a[2]) || 0) * (Number(b && b[2]) || 0);
  }

  var sphereTemplateCache = Object.create(null);
  var cylinderTemplateCache = Object.create(null);

  function getSphereTemplate(latSeg, lonSeg) {
    var key = String(latSeg) + "x" + String(lonSeg);
    var cached = sphereTemplateCache[key];
    if (cached) { return cached; }
    var verts = [];
    var idx = [];
    for (var j = 0; j <= latSeg; j++) {
      var v = j / latSeg;
      var phi = v * Math.PI;
      var sp = Math.sin(phi);
      var cp = Math.cos(phi);
      for (var i = 0; i <= lonSeg; i++) {
        var u = i / lonSeg;
        var th = u * Math.PI * 2;
        var nx = sp * Math.cos(th);
        var ny = cp;
        var nz = sp * Math.sin(th);
        verts.push(nx, ny, nz);
      }
    }
    var row = lonSeg + 1;
    for (var y = 0; y < latSeg; y++) {
      for (var x = 0; x < lonSeg; x++) {
        var a = y * row + x;
        var b = a + 1;
        var c = a + row;
        var d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    cached = {
      verts: verts,
      idx: idx
    };
    sphereTemplateCache[key] = cached;
    return cached;
  }

  function getCylinderTemplate(seg) {
    var key = String(seg);
    var cached = cylinderTemplateCache[key];
    if (cached) { return cached; }
    var ring = [];
    var idx = [];
    for (var i = 0; i <= seg; i++) {
      var th = (i / seg) * Math.PI * 2;
      ring.push(Math.cos(th), Math.sin(th));
    }
    for (var s = 0; s < seg; s++) {
      var p0 = s * 2;
      var p1 = p0 + 1;
      var p2 = p0 + 2;
      var p3 = p0 + 3;
      idx.push(p0, p1, p2, p2, p1, p3);
    }
    cached = {
      ring: ring,
      idx: idx
    };
    cylinderTemplateCache[key] = cached;
    return cached;
  }

  function appendSphereMesh(outVerts, outIdx, center, radius, color, latSeg, lonSeg) {
    radius = Number(radius);
    if (!(radius > 0)) { return; }
    latSeg = latSeg || 10;
    lonSeg = lonSeg || 16;
    var template = getSphereTemplate(latSeg, lonSeg);
    var base = Math.floor(outVerts.length / 10);
    for (var i = 0; i < template.verts.length; i += 3) {
      var nx = template.verts[i];
      var ny = template.verts[i + 1];
      var nz = template.verts[i + 2];
      outVerts.push(
        center[0] + radius * nx, center[1] + radius * ny, center[2] + radius * nz,
        nx, ny, nz,
        color[0], color[1], color[2], color[3]
      );
    }
    for (var k = 0; k < template.idx.length; k += 1) {
      outIdx.push(base + template.idx[k]);
    }
  }

  function appendCylinderMesh(outVerts, outIdx, a, b, radius, color, seg) {
    radius = Number(radius);
    if (!(radius > 0)) { return; }
    seg = seg || 18;
    var template = getCylinderTemplate(seg);
    var dir = norm3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    var ref = Math.abs(dir[1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
    var u = norm3.apply(null, cross3(dir, ref));
    var v = cross3(dir, u);
    var base = Math.floor(outVerts.length / 10);
    for (var i = 0; i < template.ring.length; i += 2) {
      var ct = template.ring[i];
      var st = template.ring[i + 1];
      var nx = u[0] * ct + v[0] * st;
      var ny = u[1] * ct + v[1] * st;
      var nz = u[2] * ct + v[2] * st;
      outVerts.push(
        a[0] + radius * nx, a[1] + radius * ny, a[2] + radius * nz,
        nx, ny, nz,
        color[0], color[1], color[2], color[3],
        b[0] + radius * nx, b[1] + radius * ny, b[2] + radius * nz,
        nx, ny, nz,
        color[0], color[1], color[2], color[3]
      );
    }
    for (var k = 0; k < template.idx.length; k += 1) {
      outIdx.push(base + template.idx[k]);
    }
  }

    function createExpandedOverlayMesh(spec, kind, vertexFloatCount, indexCount, spheres, cylinders) {
      return {
        id: String(spec.id || "combined_field_overlays"),
        mode3d: true,
        label: String(spec.id || "combined_field_overlays"),
      vertices: new Float32Array(vertexFloatCount),
      indices: new Uint32Array(indexCount),
      topology: "triangle-list",
      camera: null,
      lights: [],
      center: [0, 0, 0],
      rotation: [0, 0, 0],
        scale: [1, 1, 1],
        alpha: 1,
        transparent: false,
        overlay_expanded: true,
        overlay_counts: { spheres: spheres, cylinders: cylinders },
        __cacheKind: kind
      };
    }

    function fieldMeshRenderMode(spec) {
      var mode = String((spec && spec.render_mode) || "proxy_geometry").toLowerCase();
      if (mode === "line" || mode === "native_line" || mode === "line-list" || mode === "line_list") { return "line"; }
      return mode === "marker_impostor" ? "marker_impostor" : "proxy_geometry";
    }

    function fieldMeshMarkerSpace(spec) {
      var mode = fieldMeshRenderMode(spec);
      var space = String((spec && spec.marker_space) || (mode === "marker_impostor" ? "pixel" : "world")).toLowerCase();
      return space === "pixel" ? "pixel" : "world";
    }

  function buildExpandedPointMesh(spec, camera, lights) {
    var sizingCamera = camera && camera._marker_size_camera ? camera._marker_size_camera : camera;
    var verts = spec.vertices || [];
    var inds = spec.indices || [];
    var vertexRadius = Number(spec.vertex_size || 0);
    if (!(vertexRadius > 0) || !inds.length) { return null; }
    var template = getSphereTemplate(12, 18);
    var templateVertCount = Math.floor(template.verts.length / 3);
    var templateIdxCount = template.idx.length;
    var pointCount = inds.length;
    var vertexCount = pointCount * templateVertCount;
    var indexCount = pointCount * templateIdxCount;
    var mesh = spec.__overlayExpandedMesh;
    if (
      !mesh ||
      mesh.__cacheKind !== "point-list" ||
      mesh.__sourceCount !== pointCount ||
      mesh.__radius !== vertexRadius ||
      !mesh.vertices ||
      mesh.vertices.length !== vertexCount * 10 ||
      !mesh.indices ||
      mesh.indices.length !== indexCount
    ) {
      mesh = createExpandedOverlayMesh(spec, "point-list", vertexCount * 10, indexCount, pointCount, 0);
      for (var pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
        var baseVertex = pointIndex * templateVertCount;
        var indexBase = pointIndex * templateIdxCount;
        for (var indexIndex = 0; indexIndex < templateIdxCount; indexIndex += 1) {
          mesh.indices[indexBase + indexIndex] = baseVertex + template.idx[indexIndex];
        }
      }
      mesh.__sourceCount = pointCount;
      mesh.__radius = vertexRadius;
      spec.__overlayExpandedMesh = mesh;
    }
    var out = mesh.vertices;
    var outOffset = 0;
    var scales = Array.isArray(spec.vertex_scale) ? spec.vertex_scale : null;
    var globalScale = scales ? null : Number(spec.vertex_scale == null ? 1.0 : spec.vertex_scale);
    var viewportHeight = markerViewportHeight(sizingCamera, Number(sizingCamera && sizingCamera.viewport_height_px) || 0);
    var markerSpace = fieldMeshMarkerSpace(spec);
      for (var pi = 0; pi < pointCount; pi += 1) {
      var sourceIndex = Number(inds[pi]) * 10;
      var px = Number(verts[sourceIndex] || 0);
      var py = Number(verts[sourceIndex + 1] || 0);
        var pz = Number(verts[sourceIndex + 2] || 0);
        var sizeScale = scales ? Number(scales[pi] == null ? 1.0 : scales[pi]) : globalScale;
        if (!(sizeScale > 0)) { sizeScale = 1.0; }
        var radius = markerSpace === "pixel"
          ? impostorWorldRadius(sizingCamera, viewportHeight, [px, py, pz], vertexRadius * sizeScale)
          : (vertexRadius * sizeScale);
      var cr = Number(verts[sourceIndex + 6] == null ? 0.8 : verts[sourceIndex + 6]);
      var cg = Number(verts[sourceIndex + 7] == null ? 0.8 : verts[sourceIndex + 7]);
      var cb = Number(verts[sourceIndex + 8] == null ? 0.8 : verts[sourceIndex + 8]);
      var ca = Number(verts[sourceIndex + 9] == null ? 1.0 : verts[sourceIndex + 9]);
      for (var tv = 0; tv < template.verts.length; tv += 3) {
          var nx = template.verts[tv];
          var ny = template.verts[tv + 1];
          var nz = template.verts[tv + 2];
          out[outOffset] = px + (radius * nx);
          out[outOffset + 1] = py + (radius * ny);
          out[outOffset + 2] = pz + (radius * nz);
        out[outOffset + 3] = nx;
        out[outOffset + 4] = ny;
        out[outOffset + 5] = nz;
        out[outOffset + 6] = cr;
        out[outOffset + 7] = cg;
        out[outOffset + 8] = cb;
        out[outOffset + 9] = ca;
        outOffset += 10;
      }
    }
    mesh.camera = camera || null;
    mesh.lights = lights || [];
    mesh.interpolation = spec.interpolation === true;
    mesh.__revision = Number(mesh.__revision || 0) + 1;
    return mesh;
  }

  function buildExpandedLineMesh(spec, camera, lights) {
    var sizingCamera = camera && camera._marker_size_camera ? camera._marker_size_camera : camera;
    var verts = spec.vertices || [];
    var inds = spec.indices || [];
    var edgeRadius = Number(spec.edge_width || 0);
    var vertexWidths = Array.isArray(spec.vertex_widths) ? spec.vertex_widths : null;
    var hasVertexWidths = !!(vertexWidths && vertexWidths.some(function (value) { return Number(value) > 0; }));
    if (!(edgeRadius > 0) && !hasVertexWidths) { return null; }
    if (inds.length < 2) { return null; }
    var edgeCaps = spec.edge_caps === true;
    var cylinderTemplate = getCylinderTemplate(20);
    var cylinderVertCount = Math.floor(cylinderTemplate.ring.length / 2) * 2;
    var cylinderIdxCount = cylinderTemplate.idx.length;
    var capTemplate = edgeCaps ? getSphereTemplate(10, 14) : null;
    var capVertCount = capTemplate ? Math.floor(capTemplate.verts.length / 3) : 0;
    var capIdxCount = capTemplate ? capTemplate.idx.length : 0;
    var segmentCount = Math.floor(inds.length / 2);
    var vertexCount = segmentCount * (cylinderVertCount + (edgeCaps ? (capVertCount * 2) : 0));
    var indexCount = segmentCount * (cylinderIdxCount + (edgeCaps ? (capIdxCount * 2) : 0));
    var mesh = spec.__overlayExpandedMesh;
    if (
      !mesh ||
      mesh.__cacheKind !== "line-list" ||
      mesh.__sourceCount !== segmentCount ||
      mesh.__radius !== edgeRadius ||
      mesh.__hasVertexWidths !== hasVertexWidths ||
      mesh.__edgeCaps !== edgeCaps ||
      !mesh.vertices ||
      mesh.vertices.length !== vertexCount * 10 ||
      !mesh.indices ||
      mesh.indices.length !== indexCount
    ) {
      mesh = createExpandedOverlayMesh(
        spec,
        "line-list",
        vertexCount * 10,
        indexCount,
        edgeCaps ? segmentCount * 2 : 0,
        segmentCount
      );
      var vertexBase = 0;
      var indexBase = 0;
      for (var segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
        for (var cylIndex = 0; cylIndex < cylinderIdxCount; cylIndex += 1) {
          mesh.indices[indexBase + cylIndex] = vertexBase + cylinderTemplate.idx[cylIndex];
        }
        indexBase += cylinderIdxCount;
        vertexBase += cylinderVertCount;
        if (edgeCaps) {
          for (var capAIndex = 0; capAIndex < capIdxCount; capAIndex += 1) {
            mesh.indices[indexBase + capAIndex] = vertexBase + capTemplate.idx[capAIndex];
          }
          indexBase += capIdxCount;
          vertexBase += capVertCount;
          for (var capBIndex = 0; capBIndex < capIdxCount; capBIndex += 1) {
            mesh.indices[indexBase + capBIndex] = vertexBase + capTemplate.idx[capBIndex];
          }
          indexBase += capIdxCount;
          vertexBase += capVertCount;
        }
      }
      mesh.__sourceCount = segmentCount;
      mesh.__radius = edgeRadius;
      mesh.__hasVertexWidths = hasVertexWidths;
      mesh.__edgeCaps = edgeCaps;
      spec.__overlayExpandedMesh = mesh;
    }
    var out = mesh.vertices;
    var outOffset = 0;
    var viewportHeight = markerViewportHeight(sizingCamera, Number(sizingCamera && sizingCamera.viewport_height_px) || 0);
    var markerSpace = fieldMeshMarkerSpace(spec);
    for (var segment = 0; segment < segmentCount; segment += 1) {
      var aSource = Number(inds[segment * 2]) * 10;
      var bSource = Number(inds[(segment * 2) + 1]) * 10;
      var ax = Number(verts[aSource] || 0);
      var ay = Number(verts[aSource + 1] || 0);
      var az = Number(verts[aSource + 2] || 0);
      var bx = Number(verts[bSource] || 0);
      var by = Number(verts[bSource + 1] || 0);
      var bz = Number(verts[bSource + 2] || 0);
        var cr = Number(verts[aSource + 6] == null ? 0.8 : verts[aSource + 6]);
        var cg = Number(verts[aSource + 7] == null ? 0.8 : verts[aSource + 7]);
        var cb = Number(verts[aSource + 8] == null ? 0.8 : verts[aSource + 8]);
        var ca = Number(verts[aSource + 9] == null ? 1.0 : verts[aSource + 9]);
        var aWidth = hasVertexWidths ? Number(vertexWidths[Number(inds[segment * 2])] || 0) : edgeRadius;
        var bWidth = hasVertexWidths ? Number(vertexWidths[Number(inds[(segment * 2) + 1])] || 0) : edgeRadius;
        var edgeRadiusWorldA = markerSpace === "pixel"
          ? impostorWorldRadius(sizingCamera, viewportHeight, [ax, ay, az], aWidth)
          : aWidth;
        var edgeRadiusWorldB = markerSpace === "pixel"
          ? impostorWorldRadius(sizingCamera, viewportHeight, [bx, by, bz], bWidth)
          : bWidth;
        var dir = norm3(bx - ax, by - ay, bz - az);
      var ref = Math.abs(dir[1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
      var u = norm3.apply(null, cross3(dir, ref));
      var v = cross3(dir, u);
      for (var ringIndex = 0; ringIndex < cylinderTemplate.ring.length; ringIndex += 2) {
        var ct = cylinderTemplate.ring[ringIndex];
        var st = cylinderTemplate.ring[ringIndex + 1];
        var nx = (u[0] * ct) + (v[0] * st);
        var ny = (u[1] * ct) + (v[1] * st);
        var nz = (u[2] * ct) + (v[2] * st);
        out[outOffset] = ax + (edgeRadiusWorldA * nx);
        out[outOffset + 1] = ay + (edgeRadiusWorldA * ny);
        out[outOffset + 2] = az + (edgeRadiusWorldA * nz);
        out[outOffset + 3] = nx;
        out[outOffset + 4] = ny;
        out[outOffset + 5] = nz;
        out[outOffset + 6] = cr;
        out[outOffset + 7] = cg;
        out[outOffset + 8] = cb;
        out[outOffset + 9] = ca;
        outOffset += 10;
        out[outOffset] = bx + (edgeRadiusWorldB * nx);
        out[outOffset + 1] = by + (edgeRadiusWorldB * ny);
        out[outOffset + 2] = bz + (edgeRadiusWorldB * nz);
        out[outOffset + 3] = nx;
        out[outOffset + 4] = ny;
        out[outOffset + 5] = nz;
        out[outOffset + 6] = cr;
        out[outOffset + 7] = cg;
        out[outOffset + 8] = cb;
        out[outOffset + 9] = ca;
        outOffset += 10;
      }
      if (edgeCaps) {
        for (var capVertA = 0; capVertA < capTemplate.verts.length; capVertA += 3) {
          var cax = capTemplate.verts[capVertA];
          var cay = capTemplate.verts[capVertA + 1];
          var caz = capTemplate.verts[capVertA + 2];
          out[outOffset] = ax + (edgeRadiusWorldA * cax);
          out[outOffset + 1] = ay + (edgeRadiusWorldA * cay);
          out[outOffset + 2] = az + (edgeRadiusWorldA * caz);
          out[outOffset + 3] = cax;
          out[outOffset + 4] = cay;
          out[outOffset + 5] = caz;
          out[outOffset + 6] = cr;
          out[outOffset + 7] = cg;
          out[outOffset + 8] = cb;
          out[outOffset + 9] = ca;
          outOffset += 10;
        }
        for (var capVertB = 0; capVertB < capTemplate.verts.length; capVertB += 3) {
          var cbx = capTemplate.verts[capVertB];
          var cby = capTemplate.verts[capVertB + 1];
          var cbz = capTemplate.verts[capVertB + 2];
          out[outOffset] = bx + (edgeRadiusWorldB * cbx);
          out[outOffset + 1] = by + (edgeRadiusWorldB * cby);
          out[outOffset + 2] = bz + (edgeRadiusWorldB * cbz);
          out[outOffset + 3] = cbx;
          out[outOffset + 4] = cby;
          out[outOffset + 5] = cbz;
          out[outOffset + 6] = cr;
          out[outOffset + 7] = cg;
          out[outOffset + 8] = cb;
          out[outOffset + 9] = ca;
          outOffset += 10;
        }
      }
    }
    mesh.camera = camera || null;
    mesh.lights = lights || [];
    mesh.interpolation = spec.interpolation === true;
    mesh.__revision = Number(mesh.__revision || 0) + 1;
    return mesh;
  }

  function buildAnalyticPointImpostorMesh(spec, camera, lights) {
    var sizingCamera = camera && camera._marker_size_camera ? camera._marker_size_camera : camera;
    var verts = spec.vertices || [];
    var inds = spec.indices || [];
    var vertexRadius = Number(spec.vertex_size || 0);
    if (!(vertexRadius > 0) || !inds.length) { return null; }
    var mesh = spec.__analyticImpostorMesh;
    if (!mesh || mesh.__cacheKind !== "point-impostor") {
      mesh = {
        id: String(spec.id || "point_impostor"),
        mode3d: spec.mode3d === false ? false : true,
        label: String(spec.id || "point_impostor"),
        vertices: new Float32Array([
          -1, -1, 0,  0, 0, 1,  1, 1, 1, 1,
           1, -1, 0,  0, 0, 1,  1, 1, 1, 1,
           1,  1, 0,  0, 0, 1,  1, 1, 1, 1,
          -1,  1, 0,  0, 0, 1,  1, 1, 1, 1
        ]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
        topology: "triangle-list",
        camera: null,
        lights: [],
        center: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        alpha: 1,
        transparent: true,
        overlay_expanded: true,
        instance_kind: "point-impostor",
        static_vertices: true,
        static_indices: true,
        __cacheKind: "point-impostor"
      };
      spec.__analyticImpostorMesh = mesh;
    }
    mesh.mode3d = spec.mode3d === false ? false : true;
    var pointCount = inds.length;
    var inst = new Float32Array(pointCount * 8);
    var scales = Array.isArray(spec.vertex_scale) ? spec.vertex_scale : null;
    var globalScale = scales ? null : Number(spec.vertex_scale == null ? 1.0 : spec.vertex_scale);
    var viewportHeight = markerViewportHeight(sizingCamera, Number(sizingCamera && sizingCamera.viewport_height_px) || 0);
    var markerSpace = fieldMeshMarkerSpace(spec);
    for (var pi = 0; pi < pointCount; pi += 1) {
      var sourceIndex = Number(inds[pi]) * 10;
      var px = Number(verts[sourceIndex] || 0);
      var py = Number(verts[sourceIndex + 1] || 0);
      var pz = Number(verts[sourceIndex + 2] || 0);
      var sizeScale = scales ? Number(scales[pi] == null ? 1.0 : scales[pi]) : globalScale;
      if (!(sizeScale > 0)) { sizeScale = 1.0; }
      var radius = markerSpace === "pixel"
        ? impostorWorldRadius(sizingCamera, viewportHeight, [px, py, pz], vertexRadius * sizeScale)
        : (vertexRadius * sizeScale);
      var cr = Number(verts[sourceIndex + 6] == null ? 0.8 : verts[sourceIndex + 6]);
      var cg = Number(verts[sourceIndex + 7] == null ? 0.8 : verts[sourceIndex + 7]);
      var cb = Number(verts[sourceIndex + 8] == null ? 0.8 : verts[sourceIndex + 8]);
      var ca = Number(verts[sourceIndex + 9] == null ? 1.0 : verts[sourceIndex + 9]);
      var base = pi * 8;
      inst[base + 0] = px;
      inst[base + 1] = py;
      inst[base + 2] = pz;
      inst[base + 3] = radius;
      inst[base + 4] = cr;
      inst[base + 5] = cg;
      inst[base + 6] = cb;
      inst[base + 7] = ca;
    }
    mesh.instances = inst;
    mesh.instance_count = pointCount;
    mesh.camera = camera || null;
    mesh.lights = lights || [];
    mesh.alpha = meshAlpha(spec);
    mesh.depth_write = spec.depth_write === true;
    mesh.interpolation = spec.interpolation === true;
    mesh.pickable = false;
    mesh.__revision = Number(mesh.__revision || 0) + 1;
    return mesh;
  }

  function buildAnalyticLineImpostorMesh(spec, camera, lights) {
    var sizingCamera = camera && camera._marker_size_camera ? camera._marker_size_camera : camera;
    var verts = spec.vertices || [];
    var inds = spec.indices || [];
    var edgeRadius = Number(spec.edge_width || 0);
    var vertexWidths = Array.isArray(spec.vertex_widths) ? spec.vertex_widths : null;
    var hasVertexWidths = !!(vertexWidths && vertexWidths.some(function (value) { return Number(value) > 0; }));
    if (!(edgeRadius > 0) && !hasVertexWidths) { return null; }
    if (inds.length < 2) { return null; }
    var mesh = spec.__analyticImpostorMesh;
    if (!mesh || mesh.__cacheKind !== "line-impostor") {
      mesh = {
        id: String(spec.id || "line_impostor"),
        mode3d: spec.mode3d === false ? false : true,
        label: String(spec.id || "line_impostor"),
        vertices: new Float32Array([
          -1, 0, 0,  0, 0, 1,  1, 1, 1, 1,
           1, 0, 0,  0, 0, 1,  1, 1, 1, 1,
          -1, 1, 0,  0, 0, 1,  1, 1, 1, 1,
           1, 1, 0,  0, 0, 1,  1, 1, 1, 1
        ]),
        indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
        topology: "triangle-list",
        camera: null,
        lights: [],
        center: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        alpha: 1,
        transparent: true,
        overlay_expanded: true,
        instance_kind: "line-impostor",
        static_vertices: true,
        static_indices: true,
        __cacheKind: "line-impostor"
      };
      spec.__analyticImpostorMesh = mesh;
    }
    mesh.mode3d = spec.mode3d === false ? false : true;
    var segmentCount = Math.floor(inds.length / 2);
    var inst = new Float32Array(segmentCount * 12);
    var viewportHeight = markerViewportHeight(sizingCamera, Number(sizingCamera && sizingCamera.viewport_height_px) || 0);
    var markerSpace = fieldMeshMarkerSpace(spec);
    for (var si = 0; si < segmentCount; si += 1) {
      var aIdx = Number(inds[si * 2]);
      var bIdx = Number(inds[(si * 2) + 1]);
      var aBase = aIdx * 10;
      var bBase = bIdx * 10;
      var ax = Number(verts[aBase] || 0);
      var ay = Number(verts[aBase + 1] || 0);
      var az = Number(verts[aBase + 2] || 0);
      var bx = Number(verts[bBase] || 0);
      var by = Number(verts[bBase + 1] || 0);
      var bz = Number(verts[bBase + 2] || 0);
      if (spec.axis_screen_extend === true && mesh.mode3d !== false) {
        var extended = extendSegmentToScreenInset(
          sizingCamera,
          viewportHeight,
          [ax, ay, az],
          [bx, by, bz],
          axisScreenInsetPx(spec)
        );
        ax = extended[0][0]; ay = extended[0][1]; az = extended[0][2];
        bx = extended[1][0]; by = extended[1][1]; bz = extended[1][2];
      }
      var aWidth = hasVertexWidths ? Number(vertexWidths[aIdx] || 0) : edgeRadius;
      var bWidth = hasVertexWidths ? Number(vertexWidths[bIdx] || 0) : edgeRadius;
      var aRadius = markerSpace === "pixel"
        ? impostorWorldRadius(sizingCamera, viewportHeight, [ax, ay, az], aWidth)
        : aWidth;
      var bRadius = markerSpace === "pixel"
        ? impostorWorldRadius(sizingCamera, viewportHeight, [bx, by, bz], bWidth)
        : bWidth;
      var cr = Number(verts[aBase + 6] == null ? 0.8 : verts[aBase + 6]);
      var cg = Number(verts[aBase + 7] == null ? 0.8 : verts[aBase + 7]);
      var cb = Number(verts[aBase + 8] == null ? 0.8 : verts[aBase + 8]);
      var ca = Number(verts[aBase + 9] == null ? 1.0 : verts[aBase + 9]);
      var base = si * 12;
      inst[base + 0] = ax;
      inst[base + 1] = ay;
      inst[base + 2] = az;
      inst[base + 3] = aRadius;
      inst[base + 4] = bx;
      inst[base + 5] = by;
      inst[base + 6] = bz;
      inst[base + 7] = bRadius;
      inst[base + 8] = cr;
      inst[base + 9] = cg;
      inst[base + 10] = cb;
      inst[base + 11] = ca;
    }
    mesh.instances = inst;
    mesh.instance_count = segmentCount;
    mesh.camera = camera || null;
    mesh.lights = lights || [];
    mesh.alpha = meshAlpha(spec);
    mesh.depth_write = spec.depth_write === true;
    mesh.interpolation = spec.interpolation === true;
    mesh.pickable = false;
    mesh.__revision = Number(mesh.__revision || 0) + 1;
    return mesh;
  }

  function buildCombinedTriangleMesh(specs, camera, lights) {
    var sizingCamera = camera && camera._marker_size_camera ? camera._marker_size_camera : camera;
    if (Array.isArray(specs) && specs.length === 1) {
      var singleSpec = specs[0] || {};
      if (singleSpec.type === "field_mesh") {
        var singleTopology = String(singleSpec.topology || "");
        if (singleTopology === "point-list") {
          return buildExpandedPointMesh(singleSpec, camera, lights);
        }
        if (singleTopology === "line-list") {
          return buildExpandedLineMesh(singleSpec, camera, lights);
        }
      }
    }
    if (!Array.isArray(specs) || !specs.length) { return null; }
    var outVerts = [];
    var outIdx = [];
    var spheres = 0;
    var cylinders = 0;
    var viewportHeight = markerViewportHeight(sizingCamera, Number(sizingCamera && sizingCamera.viewport_height_px) || 0);
    for (var si = 0; si < specs.length; si++) {
      var spec = specs[si] || {};
      if (spec.type !== "field_mesh") { return null; }
      var verts = spec.vertices || [];
      var inds = spec.indices || [];
      var topology = String(spec.topology || "");
      var vertexRadius = Number(spec.vertex_size || 0);
      var edgeRadius = Number(spec.edge_width || 0);
      var markerSpace = fieldMeshMarkerSpace(spec);
      if (topology === "point-list" && vertexRadius > 0) {
        var pointScales = Array.isArray(spec.vertex_scale) ? spec.vertex_scale : null;
        var pointGlobalScale = pointScales ? null : Number(spec.vertex_scale == null ? 1.0 : spec.vertex_scale);
        for (var pi = 0; pi < inds.length; pi++) {
          var vi = Number(inds[pi]);
            var pointCenter = meshVec3At(verts, vi);
            var pointScale = pointScales ? Number(pointScales[pi] == null ? 1.0 : pointScales[pi]) : pointGlobalScale;
            if (!(pointScale > 0)) { pointScale = 1.0; }
            appendSphereMesh(
              outVerts,
              outIdx,
              pointCenter,
              markerSpace === "pixel"
                ? impostorWorldRadius(sizingCamera, viewportHeight, pointCenter, vertexRadius * pointScale)
                : (vertexRadius * pointScale),
              meshColorAt(verts, vi),
              20,
              32
            );
          spheres += 1;
        }
      } else if (topology === "line-list" && (edgeRadius > 0 || (Array.isArray(spec.vertex_widths) && spec.vertex_widths.length > 0))) {
        var edgeCaps = spec.edge_caps === true;
        for (var ei = 0; ei + 1 < inds.length; ei += 2) {
          var aIdx = Number(inds[ei]);
          var bIdx = Number(inds[ei + 1]);
            var pa = meshVec3At(verts, aIdx);
            var pb = meshVec3At(verts, bIdx);
            var col = meshColorAt(verts, aIdx);
            var aWidth = Array.isArray(spec.vertex_widths) ? Number(spec.vertex_widths[aIdx] || 0) : edgeRadius;
            var bWidth = Array.isArray(spec.vertex_widths) ? Number(spec.vertex_widths[bIdx] || 0) : edgeRadius;
            var edgeRadiusWorld = markerSpace === "pixel"
              ? Math.max(
                  impostorWorldRadius(sizingCamera, viewportHeight, pa, aWidth),
                  impostorWorldRadius(sizingCamera, viewportHeight, pb, bWidth)
                )
              : Math.max(aWidth, bWidth);
            appendCylinderMesh(outVerts, outIdx, pa, pb, edgeRadiusWorld, col, 32);
            if (edgeCaps) {
              appendSphereMesh(outVerts, outIdx, pa, edgeRadiusWorld, col, 16, 24);
              appendSphereMesh(outVerts, outIdx, pb, edgeRadiusWorld, col, 16, 24);
              spheres += 2;
          }
          cylinders += 1;
        }
      } else {
        return null;
      }
    }
    if (!outIdx.length) { return null; }
    return {
      id: "combined_field_overlays",
      mode3d: true,
      label: "combined_field_overlays",
      vertices: new Float32Array(outVerts),
      indices: new Uint32Array(outIdx),
      topology: "triangle-list",
      camera: camera || null,
      lights: lights || [],
      center: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      alpha: 1,
      transparent: false,
      overlay_expanded: true,
      overlay_counts: { spheres: spheres, cylinders: cylinders }
    };
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
    if (camera && Array.isArray(camera.view_matrix) && camera.view_matrix.length === 16) {
      var view = camera.view_matrix;
      var bx = -(Number(view[8]) || 0);
      var by = -(Number(view[9]) || 0);
      var bz = -(Number(view[10]) || 0);
      var bl = Math.sqrt((bx * bx) + (by * by) + (bz * bz));
      if (bl > 1e-9) {
        return [bx / bl, by / bl, bz / bl];
      }
    }
    var pos = (camera && Array.isArray(camera.pos)) ? camera.pos : [0, 0, 5];
    var target = (camera && Array.isArray(camera.target)) ? camera.target : [0, 0, 0];
    var fx = target[0] - pos[0];
    var fy = target[1] - pos[1];
    var fz = target[2] - pos[2];
    var fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (fl < 1e-9) { return [0, 0, -1]; }
    return [fx / fl, fy / fl, fz / fl];
  }

  function cameraDepth(camera, point) {
    var cam = camera || null;
    var p = [
      Number(point && point[0] || 0),
      Number(point && point[1] || 0),
      Number(point && point[2] || 0)
    ];
    if (cam && Array.isArray(cam.view_matrix) && cam.view_matrix.length === 16) {
      var view = cam.view_matrix;
      var z = (Number(view[2]) * p[0]) + (Number(view[6]) * p[1]) + (Number(view[10]) * p[2]) + Number(view[14]);
      return Math.max(1e-3, -z);
    }
    if (!cam || !Array.isArray(cam.pos)) {
      return 1e-3;
    }
    var forward = cameraForward(cam);
    var dx = p[0] - Number(cam.pos[0] || 0);
    var dy = p[1] - Number(cam.pos[1] || 0);
    var dz = p[2] - Number(cam.pos[2] || 0);
    return Math.max(1e-3, (dx * forward[0]) + (dy * forward[1]) + (dz * forward[2]));
  }

  function cameraVerticalScale(camera) {
    var cam = camera || null;
    if (cam && Array.isArray(cam.projection_matrix) && cam.projection_matrix.length === 16) {
      var scaleY = Math.abs(Number(cam.projection_matrix[5]) || 0);
      if (scaleY > 1e-6) { return scaleY; }
    }
    var fovDeg = Number(cam && cam.fov || 34);
    var fovRad = Math.max(1e-4, fovDeg * Math.PI / 180);
    return 1.0 / Math.tan(fovRad * 0.5);
  }

  function impostorWorldRadius(camera, viewportHeightPx, point, pixelRadius) {
    var pxRadius = Number(pixelRadius || 0);
    if (!(pxRadius > 0)) { return 0; }
    var cam = camera || null;
    var viewportHeight = Number(viewportHeightPx || 0);
    if (!cam || !(viewportHeight > 0)) {
      return pxRadius;
    }
    var depth = cameraDepth(cam, point);
    var verticalScale = cameraVerticalScale(cam);
    var worldPerPixel = (2 * depth) / (viewportHeight * Math.max(1e-6, verticalScale));
    return pxRadius * worldPerPixel;
  }

  function markerViewportHeight(camera, fallbackHeightPx) {
    var ref = Number(camera && camera.viewport_marker_reference_height_px || 0);
    if (ref > 0) { return ref; }
    return Number(fallbackHeightPx || 0);
  }

  function lookAtMatrixLocal(eye, target, up) {
    var z = norm3(Number(eye[0]) - Number(target[0]), Number(eye[1]) - Number(target[1]), Number(eye[2]) - Number(target[2]));
    var x = norm3.apply(null, cross3(up || [0, 1, 0], z));
    var y = cross3(z, x);
    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1
    ]);
  }

  function perspectiveZ01MatrixLocal(fovDeg, aspect, near, far) {
    var f = 1.0 / Math.tan((Number(fovDeg) || 45) * Math.PI / 360.0);
    var nf = 1.0 / (Number(near) - Number(far));
    return new Float32Array([
      f / Math.max(1e-6, Number(aspect) || 1), 0, 0, 0,
      0, f, 0, 0,
      0, 0, Number(far) * nf, -1,
      0, 0, Number(near) * Number(far) * nf, 0
    ]);
  }

  function orthographicZ01MatrixLocal(scale, aspect, near, far) {
    var sy = Math.max(1e-6, Number(scale) || 2.5);
    var sx = sy * Math.max(1e-6, Number(aspect) || 1);
    var l = -sx, r = sx, b = -sy, t = sy;
    var nf = 1.0 / (Number(near) - Number(far));
    return new Float32Array([
      2 / (r - l), 0, 0, 0,
      0, 2 / (t - b), 0, 0,
      0, 0, nf, 0,
      -(r + l) / (r - l), -(t + b) / (t - b), Number(near) * nf, 1
    ]);
  }

  function cameraProjectionMatrixLocal(camera, aspect) {
    if (camera && Array.isArray(camera.projection_matrix) && camera.projection_matrix.length === 16) {
      return camera.projection_matrix;
    }
    if (String(camera && camera.projection || "").toLowerCase() === "orthographic") {
      return orthographicZ01MatrixLocal(Number(camera && camera.ortho_scale || 2.5), aspect, 0.05, 500);
    }
    return perspectiveZ01MatrixLocal(Number(camera && camera.fov || 45), aspect, 0.05, 500);
  }

  function mat4MulLocal(a, b) {
    var out = new Float32Array(16);
    for (var c = 0; c < 4; c += 1) {
      for (var r = 0; r < 4; r += 1) {
        out[c * 4 + r] =
          a[0 * 4 + r] * b[c * 4 + 0] +
          a[1 * 4 + r] * b[c * 4 + 1] +
          a[2 * 4 + r] * b[c * 4 + 2] +
          a[3 * 4 + r] * b[c * 4 + 3];
      }
    }
    return out;
  }

  function projectWorldToClipLocal(mvp, point) {
    var x = Number(point[0]) || 0, y = Number(point[1]) || 0, z = Number(point[2]) || 0;
    return [
      (mvp[0] * x) + (mvp[4] * y) + (mvp[8] * z) + mvp[12],
      (mvp[1] * x) + (mvp[5] * y) + (mvp[9] * z) + mvp[13],
      (mvp[2] * x) + (mvp[6] * y) + (mvp[10] * z) + mvp[14],
      (mvp[3] * x) + (mvp[7] * y) + (mvp[11] * z) + mvp[15]
    ];
  }

  function segmentPointAt(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  function clipHomogeneousLineToInset(ca, cb, insetX, insetY) {
    var t0 = -Infinity;
    var t1 = Infinity;
    var dx = cb[0] - ca[0], dy = cb[1] - ca[1], dz = cb[2] - ca[2], dw = cb[3] - ca[3];
    function addLower(f0, f1) {
      var d = f1 - f0;
      if (Math.abs(d) < 1e-12) { return f0 >= 0; }
      var t = -f0 / d;
      if (d > 0) { t0 = Math.max(t0, t); }
      else { t1 = Math.min(t1, t); }
      return t0 <= t1;
    }
    if (!addLower(ca[0] - (-1 + insetX) * ca[3], (ca[0] + dx) - (-1 + insetX) * (ca[3] + dw))) { return null; }
    if (!addLower((1 - insetX) * ca[3] - ca[0], (1 - insetX) * (ca[3] + dw) - (ca[0] + dx))) { return null; }
    if (!addLower(ca[1] - (-1 + insetY) * ca[3], (ca[1] + dy) - (-1 + insetY) * (ca[3] + dw))) { return null; }
    if (!addLower((1 - insetY) * ca[3] - ca[1], (1 - insetY) * (ca[3] + dw) - (ca[1] + dy))) { return null; }
    if (!addLower(ca[2], ca[2] + dz)) { return null; }
    if (!addLower(ca[3] - ca[2], (ca[3] + dw) - (ca[2] + dz))) { return null; }
    if (!addLower(ca[3] - 1e-6, (ca[3] + dw) - 1e-6)) { return null; }
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || !(t1 > t0)) { return null; }
    return [t0, t1];
  }

  function extendSegmentToScreenInset(camera, viewportHeightPx, a, b, insetPx) {
    if (!camera || !Array.isArray(camera.pos) || !Array.isArray(camera.target)) { return [a, b]; }
    var viewportW = Math.max(1, Number(camera.viewport_width_px || viewportHeightPx) || 1);
    var viewportH = Math.max(1, Number(viewportHeightPx) || 1);
    var aspect = viewportW / viewportH;
    var view = Array.isArray(camera.view_matrix) && camera.view_matrix.length === 16
      ? camera.view_matrix
      : lookAtMatrixLocal(camera.pos, camera.target, camera.up || [0, 1, 0]);
    var proj = cameraProjectionMatrixLocal(camera, aspect);
    var mvp = mat4MulLocal(proj, view);
    var insetX = Math.max(0, Number(insetPx) || 0) / viewportW * 2.0;
    var insetY = Math.max(0, Number(insetPx) || 0) / viewportH * 2.0;
    var clipped = clipHomogeneousLineToInset(projectWorldToClipLocal(mvp, a), projectWorldToClipLocal(mvp, b), insetX, insetY);
    if (!clipped) { return [a, b]; }
    return [segmentPointAt(a, b, clipped[0]), segmentPointAt(a, b, clipped[1])];
  }

    function applyImpostorViewBias(camera, viewportHeightPx, point, pixelBias) {
      var biasPx = Number(pixelBias || 0);
      if (!(biasPx > 0)) { return [Number(point[0] || 0), Number(point[1] || 0), Number(point[2] || 0)]; }
      var cam = camera || null;
      if (!cam || !Array.isArray(cam.pos)) {
        return [Number(point[0] || 0), Number(point[1] || 0), Number(point[2] || 0)];
      }
      var worldBias = impostorWorldRadius(camera, viewportHeightPx, point, biasPx);
      if (!(worldBias > 0)) {
        return [Number(point[0] || 0), Number(point[1] || 0), Number(point[2] || 0)];
      }
      var vx = Number(cam.pos[0] || 0) - Number(point[0] || 0);
      var vy = Number(cam.pos[1] || 0) - Number(point[1] || 0);
      var vz = Number(cam.pos[2] || 0) - Number(point[2] || 0);
      var vlen = Math.sqrt((vx * vx) + (vy * vy) + (vz * vz));
      if (!(vlen > 1e-9)) {
        return [Number(point[0] || 0), Number(point[1] || 0), Number(point[2] || 0)];
      }
      return [
        Number(point[0] || 0) + ((vx / vlen) * worldBias),
        Number(point[1] || 0) + ((vy / vlen) * worldBias),
        Number(point[2] || 0) + ((vz / vlen) * worldBias)
      ];
    }

    function applyImpostorViewBiasToSegment(camera, viewportHeightPx, a, b, pixelBias) {
      var midpoint = [
        (Number(a[0] || 0) + Number(b[0] || 0)) * 0.5,
        (Number(a[1] || 0) + Number(b[1] || 0)) * 0.5,
        (Number(a[2] || 0) + Number(b[2] || 0)) * 0.5
      ];
      var biasedMidpoint = applyImpostorViewBias(camera, viewportHeightPx, midpoint, pixelBias);
      var dx = biasedMidpoint[0] - midpoint[0];
      var dy = biasedMidpoint[1] - midpoint[1];
      var dz = biasedMidpoint[2] - midpoint[2];
      return [
        [Number(a[0] || 0) + dx, Number(a[1] || 0) + dy, Number(a[2] || 0) + dz],
        [Number(b[0] || 0) + dx, Number(b[1] || 0) + dy, Number(b[2] || 0) + dz]
      ];
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

  function buildUnifiedFrameScene(specs, camera, lights, lightFlares) {
    if (!Array.isArray(specs) || !specs.length) { return null; }
    var parts = [];
    for (var i = 0; i < specs.length; i++) {
      var mesh = buildSingleMesh(specs[i], camera, lights);
      if (!mesh) {
        vlog("warn", "buildUnifiedFrameScene: buildSingleMesh returned null at index=" + i + " type=" + String(specs[i] && specs[i].type || ""));
        return null;
      }
      mesh.object_id = Number(specs[i] && specs[i].object_id) || (i + 1);
      if (!mesh.indices || !mesh.indices.length) {
        vlog("warn", "buildUnifiedFrameScene: part has zero indices at index=" + i + " id=" + String(mesh.id || i) + " type=" + String(specs[i] && specs[i].type || ""));
        throw new Error("buildUnifiedFrameScene: part has zero indices: " + String(mesh.id || i));
      }
      if (!mesh.vertices || !mesh.vertices.length) {
        vlog("warn", "buildUnifiedFrameScene: part has zero vertices at index=" + i + " id=" + String(mesh.id || i) + " type=" + String(specs[i] && specs[i].type || ""));
        throw new Error("buildUnifiedFrameScene: part has zero vertices: " + String(mesh.id || i));
      }
      parts.push(mesh);
    }
    return {
      id: "unified_frame_scene",
      parts: parts,
      source_specs: specs.slice(),
      camera: camera || null,
      lights: lights || [],
      light_flares: lightFlares || null,
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
    var dataRev = Number(spec && spec.__dataRevision || 0) || 0;
    var cameraRev = meshNeedsCameraRebuild(spec) ? cameraRevisionKey(camera) : "";
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
      var topology = String(spec.topology || "");
      var renderMode = fieldMeshRenderMode(spec);
      if (spec.instance_kind && spec.instances && Number(spec.instance_count || 0) > 0) {
        mesh = {
          id: spec.id || "field_mesh",
          mode3d: spec.mode3d === false ? false : true,
          label: spec.id || "field_mesh",
          vertices: (verts instanceof Float32Array) ? verts : new Float32Array(verts),
          indices: (inds instanceof Uint32Array) ? inds : new Uint32Array(inds),
          instances: (spec.instances instanceof Float32Array) ? spec.instances : new Float32Array(spec.instances),
          instance_count: Math.max(0, Number(spec.instance_count || 0) | 0),
          instance_kind: String(spec.instance_kind || ""),
          static_vertices: spec.static_vertices === true,
          static_indices: spec.static_indices === true,
          topology: spec.topology || "triangle-list",
          transparent: spec.transparent === true,
          overlay_expanded: spec.overlay_expanded === true,
          pickable: spec.pickable === true
        };
      } else if (topology === "point-list") {
        mesh = renderMode === "marker_impostor"
          ? buildAnalyticPointImpostorMesh(spec, camera, lights)
          : buildExpandedPointMesh(spec, camera, lights);
      } else if (
        topology === "line-list" &&
        renderMode !== "line" &&
        (
          Number(spec.edge_width || 0) > 0 ||
          (Array.isArray(spec.vertex_widths) && spec.vertex_widths.length > 0)
        )
      ) {
        mesh = renderMode === "marker_impostor"
          ? buildAnalyticLineImpostorMesh(spec, camera, lights)
          : buildExpandedLineMesh(spec, camera, lights);
      }
      if (meshAlpha(spec) < 0.999 && renderMode !== "marker_impostor") {
        mesh = buildCombinedTriangleMesh([spec], camera, lights);
      }
      if (!mesh) {
        if (
          topology === "line-list" &&
          renderMode === "line" &&
          spec.axis_screen_extend === true &&
          spec.mode3d !== false &&
          camera
        ) {
          var segmentCountRaw = Math.floor(inds.length / 2);
          var extendedVerts = new Float32Array(segmentCountRaw * 20);
          var extendedInds = new Uint32Array(segmentCountRaw * 2);
          var viewportHeightRaw = markerViewportHeight(camera, Number(camera && camera.viewport_height_px) || 0);
          for (var esi = 0; esi < segmentCountRaw; esi += 1) {
            var aIdxRaw = Number(inds[esi * 2]);
            var bIdxRaw = Number(inds[(esi * 2) + 1]);
            var aBaseRaw = aIdxRaw * 10;
            var bBaseRaw = bIdxRaw * 10;
            var axRaw = Number(verts[aBaseRaw] || 0);
            var ayRaw = Number(verts[aBaseRaw + 1] || 0);
            var azRaw = Number(verts[aBaseRaw + 2] || 0);
            var bxRaw = Number(verts[bBaseRaw] || 0);
            var byRaw = Number(verts[bBaseRaw + 1] || 0);
            var bzRaw = Number(verts[bBaseRaw + 2] || 0);
            var extendedRaw = extendSegmentToScreenInset(
              camera,
              viewportHeightRaw,
              [axRaw, ayRaw, azRaw],
              [bxRaw, byRaw, bzRaw],
              axisScreenInsetPx(spec)
            );
            var outA = esi * 20;
            var outB = outA + 10;
            for (var ec = 0; ec < 10; ec += 1) {
              extendedVerts[outA + ec] = Number(verts[aBaseRaw + ec] == null ? 0 : verts[aBaseRaw + ec]);
              extendedVerts[outB + ec] = Number(verts[bBaseRaw + ec] == null ? 0 : verts[bBaseRaw + ec]);
            }
            extendedVerts[outA] = extendedRaw[0][0];
            extendedVerts[outA + 1] = extendedRaw[0][1];
            extendedVerts[outA + 2] = extendedRaw[0][2];
            extendedVerts[outB] = extendedRaw[1][0];
            extendedVerts[outB + 1] = extendedRaw[1][1];
            extendedVerts[outB + 2] = extendedRaw[1][2];
            extendedInds[esi * 2] = esi * 2;
            extendedInds[(esi * 2) + 1] = (esi * 2) + 1;
          }
          mesh = {
            id: spec.id || "field_mesh",
            mode3d: true,
            label: spec.id || "field_mesh",
            vertices: extendedVerts,
            indices: extendedInds,
            topology: "line-list",
          };
        }
      }
      if (!mesh) {
        mesh = {
          id: spec.id || "field_mesh",
          mode3d: spec.mode3d === false ? false : true,
          label: spec.id || "field_mesh",
          vertices: (verts instanceof Float32Array) ? verts : new Float32Array(verts),
          indices: (inds instanceof Uint32Array) ? inds : new Uint32Array(inds),
          topology: spec.topology || "triangle-list",
        };
      }
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
    // Field point/line overlays are expanded into world-space impostor meshes.
    // Do not apply the source field TRS a second time.
    // Prefer the built mesh TRS first so dynamic/native scene builders can
    // animate transforms through properties without baking a model matrix.
    out.center   = out.overlay_expanded ? [0,0,0] : (mesh.center   || spec.center   || [0,0,0]);
    out.rotation = out.overlay_expanded ? [0,0,0] : (mesh.rotation || spec.rotation || [0,0,0]);
    out.scale    = out.overlay_expanded ? [1,1,1] : (mesh.scale    || spec.scale    || [1,1,1]);
    out.alpha    = meshAlpha(spec);
    out.transparent = spec.transparent === true || out.alpha < 0.999;
    out.depth_write = spec.depth_write === true;
    out.no_lighting = spec.no_lighting === true || spec.receives_lighting === false;
    out.interpolation = spec.interpolation === true || mesh.interpolation === true;
    out.light_model = spec.light_model || mesh.light_model || null;
    out.blend_mode = spec.blend_mode || mesh.blend_mode || null;
    out.no_cull = spec.no_cull === true || mesh.no_cull === true;
    out.light_flares = spec.light_flares || mesh.light_flares || null;
    out.texture = spec.texture || mesh.texture || null;
    out.surface_system = spec.surface_system || mesh.surface_system || null;
    out.kind = mesh.kind || spec.kind || null;
    out.size = mesh.size || spec.size || null;
    out.tracks = spec.tracks || mesh.tracks || null;
    out.animation_timing = spec.animation_timing || mesh.animation_timing || null;
    out.shadow_hull = Array.isArray(spec.shadow_hull) ? spec.shadow_hull : (Array.isArray(mesh.shadow_hull) ? mesh.shadow_hull : []);
    out.shadow_hulls = Array.isArray(spec.shadow_hulls) ? spec.shadow_hulls : (Array.isArray(mesh.shadow_hulls) ? mesh.shadow_hulls : []);
    out.shadow_softness = Number.isFinite(Number(spec.shadow_softness))
      ? Number(spec.shadow_softness)
      : (Number.isFinite(Number(mesh.shadow_softness)) ? Number(mesh.shadow_softness) : 0.0);
    out.shadow_softnesses = Array.isArray(spec.shadow_softnesses)
      ? spec.shadow_softnesses
      : (Array.isArray(mesh.shadow_softnesses) ? mesh.shadow_softnesses : []);
    if (cameraRev || dataRev) {
      if (!spec.__cameraRevisionIds) { spec.__cameraRevisionIds = Object.create(null); }
      var revKey = String(cameraRev || "static") + ":data:" + String(dataRev);
      if (spec.__cameraRevisionIds[revKey] == null) {
        spec.__cameraRevisionIds[revKey] = Object.keys(spec.__cameraRevisionIds).length + 1;
      }
      out.__revision = Number(spec.__cameraRevisionIds[revKey]);
    }
    out._modelMatrix = mesh._modelMatrix || (
      out.overlay_expanded
        ? meshModelMatrix({ center: [0,0,0], rotation: [0,0,0], scale: [1,1,1] })
        : meshModelMatrix(mesh.center !== undefined || mesh.rotation !== undefined || mesh.scale !== undefined ? mesh : spec)
    );  // fallback if VfGeomMath.mat4ModelTRS absent
    return out;
  }

  // ── Per-frame renderer management ─────────────────────────────────────────

  function ensureGeomCanvas(frameEl, idx, fid) {
    if (!frameEl) { return null; }
    var body = geomFrameHost(frameEl, fid);
    var cls  = "vf-geom-canvas-" + idx;
    var existing = body.querySelector("canvas." + cls);
    if (existing) {
      layoutGeomCanvas(frameEl, existing, fid);
      return existing;
    }
    var c = document.createElement("canvas");
    c.className = "vf-geom-canvas " + cls;
    c.style.cssText = "display:block;position:absolute;left:0;top:0;width:100%;height:100%;z-index:" + (10 + idx) + ";pointer-events:auto;background:transparent;";
    body.style.position = "relative";
    body.style.pointerEvents = "auto";
    body.appendChild(c);
    layoutGeomCanvas(frameEl, c, fid);
    vlog("info", "ensureGeomCanvas: created canvas idx=" + idx + " for frame body (body w=" + body.offsetWidth + " h=" + body.offsetHeight + ")");
    return c;
  }

  function layoutGeomCanvas(frameEl, canvas, fid) {
    if (!frameEl || !canvas) { return; }
    var body = geomFrameHost(frameEl, fid);
    var rect = geomFrameRenderRect(frameEl, body, fid);
    if (body && body.style) { body.style.overflow = "hidden"; }
    canvas.style.left = Math.round(rect.localLeft || 0) + "px";
    canvas.style.top = Math.round(rect.localTop || 0) + "px";
    canvas.style.width = Math.round(rect.width || 1) + "px";
    canvas.style.height = Math.round(rect.height || 1) + "px";
  }

  function vec3Array(value, fallback) {
    return Array.isArray(value) && value.length >= 3
      ? [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0]
      : fallback.slice();
  }

  function plotCameraDistance(camera) {
    var pos = vec3Array(camera && camera.pos, [0, -4, 2.6]);
    var target = vec3Array(camera && camera.target, [0, 0, 0]);
    var dx = pos[0] - target[0];
    var dy = pos[1] - target[1];
    var dz = pos[2] - target[2];
    return Math.max(0.05, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }

  function schedulePlotCameraUpdate(fid) {
    if (_plotCameraRaf[fid]) { return; }
    _plotCameraRaf[fid] = global.requestAnimationFrame(function () {
      _plotCameraRaf[fid] = 0;
      if (!_lastDisplayPayload || !_lastDisplayPayload.geom || !_lastDisplayPayload.geom[fid]) { return; }
      updateGeomFrame(fid, _lastDisplayPayload.geom[fid]);
    });
  }

  function scheduleGeomTextOverlayRender(fid, frameEl, geomSpec) {
    if (!frameEl) { return; }
    if (!frameRecs[fid]) { frameRecs[fid] = { entries: [] }; }
    var rec = frameRecs[fid];
    rec.pendingTextFrameEl = frameEl;
    rec.pendingTextGeomSpec = geomSpec;
    if (rec.textOverlayRaf) { return; }
    rec.textOverlayRaf = global.requestAnimationFrame(function () {
      rec.textOverlayRaf = 0;
      renderGeomTextOverlay(fid, rec.pendingTextFrameEl || frameEl, rec.pendingTextGeomSpec || geomSpec);
    });
  }

  function mutatePlotCamera(fid, mutator) {
    if (!_lastDisplayPayload || !_lastDisplayPayload.geom || !_lastDisplayPayload.geom[fid]) { return; }
    var geom = _lastDisplayPayload.geom[fid];
    var camera = Object.assign({}, geom.camera || {});
    mutator(camera, geom);
    geom.camera = camera;
    schedulePlotCameraUpdate(fid);
  }

  function crossVec3(a, b) {
    return [
      (Number(a[1]) || 0) * (Number(b[2]) || 0) - (Number(a[2]) || 0) * (Number(b[1]) || 0),
      (Number(a[2]) || 0) * (Number(b[0]) || 0) - (Number(a[0]) || 0) * (Number(b[2]) || 0),
      (Number(a[0]) || 0) * (Number(b[1]) || 0) - (Number(a[1]) || 0) * (Number(b[0]) || 0)
    ];
  }

  function normalizeVec3Local(v, fallback) {
    var x = Number(v && v[0]) || 0;
    var y = Number(v && v[1]) || 0;
    var z = Number(v && v[2]) || 0;
    var len = Math.sqrt(x * x + y * y + z * z);
    if (!(len > 1e-9)) { return (fallback || [0, 0, 1]).slice(); }
    return [x / len, y / len, z / len];
  }

  function applyAxis3DCameraToLiveRenderers(fid, camera) {
    var rec = frameRecs[String(fid)] || null;
    if (!rec || !Array.isArray(rec.entries)) { return; }
    for (var i = 0; i < rec.entries.length; i += 1) {
      var entry = rec.entries[i] || null;
      var liveMesh = entry && entry.ref && entry.ref.mesh ? entry.ref.mesh : null;
      if (!liveMesh) { continue; }
      liveMesh.camera = Object.assign({}, camera || {});
    }
  }

  function translateGeomTextOverlayLayer(fid, dx, dy) {
    var rec = frameRecs[String(fid)] || null;
    if (!rec || !rec.pendingTextFrameEl) { return; }
    var layer = ensureGeomTextOverlay(rec.pendingTextFrameEl, String(fid));
    if (!layer) { return; }
    rec.textOverlayPanX = Number(rec.textOverlayPanX || 0) + (Number(dx) || 0);
    rec.textOverlayPanY = Number(rec.textOverlayPanY || 0) + (Number(dy) || 0);
    var content = layer.__vfGeomTextContent || layer;
    content.style.transform = "translate3d(" + rec.textOverlayPanX + "px," + rec.textOverlayPanY + "px,0)";
  }

  function updateAxis3DBoundaryLabels(fid) {
    var rec = frameRecs[String(fid)] || null;
    var geom = _lastDisplayPayload && _lastDisplayPayload.geom ? _lastDisplayPayload.geom[String(fid)] : null;
    if (!rec || !rec.pendingTextFrameEl || !geom || geom.axis3d_controls !== true) { return; }
    var frameEl = rec.pendingTextFrameEl;
    var layer = ensureGeomTextOverlay(frameEl, String(fid));
    if (!layer) { return; }
    var fit = fittedFrameContentRect(frameEl, geomFrameHost(frameEl, fid));
    var w = Math.max(1, Math.round(fit.width || 1));
    var h = Math.max(1, Math.round(fit.height || 1));
    var texts = Array.isArray(geom.texts) ? geom.texts : [];
    var pool = Array.isArray(rec.axis3DBoundaryLabelPool) ? rec.axis3DBoundaryLabelPool : [];
    rec.axis3DBoundaryLabelPool = pool;
    var used = 0;
    for (var i = 0; i < texts.length; i += 1) {
      var item = texts[i] || {};
      if (item.edge_anchor !== true || item.world !== true) { continue; }
      var p = geomTextToPx(item, w, h, geom.camera || null);
      if (!p) { continue; }
      var el = pool[used];
      if (!el || el.parentNode !== layer) {
        el = document.createElement("div");
        el.className = "vf-geom-text-overlay__item vf-geom-text-overlay__boundary-label";
        el.style.position = "absolute";
        el.style.left = "0px";
        el.style.top = "0px";
        el.style.lineHeight = "1";
        el.style.whiteSpace = "nowrap";
        el.style.textShadow = "0 1px 2px rgba(0,0,0,0.65)";
        el.style.willChange = "transform";
        pool[used] = el;
        layer.appendChild(el);
      }
      used += 1;
      el.style.display = "";
      var color = parseRuntimeColor(item.color || "white");
      el.style.color = "rgba(" + Math.round(color[0] * 255) + "," + Math.round(color[1] * 255) + "," + Math.round(color[2] * 255) + "," + Math.max(0, Math.min(1, color[3])) + ")";
      el.style.fontSize = String(Math.max(1, Number(item.font_size) || 12)) + "px";
      var rotation = Number(item.rotate) || 0;
      el.style.transform = "translate3d(" + String(p[0]) + "px," + String(p[1]) + "px,0) translate(" +
        (String(item.ha || "center").toLowerCase() === "left" ? "0" : String(item.ha || "center").toLowerCase() === "right" ? "-100%" : "-50%") +
        "," +
        (String(item.va || "center").toLowerCase() === "top" ? "0" : String(item.va || "center").toLowerCase() === "bottom" ? "-100%" : "-50%") +
        ")" + (rotation ? " rotate(" + String(rotation) + "deg)" : "");
      var textValue = item.text != null ? String(item.text) : "";
      if (el.dataset.vfGeomTextValue !== textValue) {
        renderMathText(el, textValue);
        el.dataset.vfGeomTextValue = textValue;
      }
    }
    for (var pi = used; pi < pool.length; pi += 1) {
      if (pool[pi]) { pool[pi].style.display = "none"; }
    }
  }

  function resetGeomTextOverlayLayerTransform(fid) {
    var rec = frameRecs[String(fid)] || null;
    if (!rec) { return; }
    rec.textOverlayPanX = 0;
    rec.textOverlayPanY = 0;
    if (rec.pendingTextFrameEl) {
      var layer = ensureGeomTextOverlay(rec.pendingTextFrameEl, String(fid));
      if (layer) {
        layer.style.transform = "";
        if (layer.__vfGeomTextContent) { layer.__vfGeomTextContent.style.transform = ""; }
      }
    }
  }

  function translateAxis3DVisualLayers(fid, dx, dy) {
    var rec = frameRecs[String(fid)] || null;
    if (!rec) { return; }
    rec.axis3DVisualPanX = Number(rec.axis3DVisualPanX || 0) + (Number(dx) || 0);
    rec.axis3DVisualPanY = Number(rec.axis3DVisualPanY || 0) + (Number(dy) || 0);
    var transform = "translate3d(" + rec.axis3DVisualPanX + "px," + rec.axis3DVisualPanY + "px,0)";
    if (Array.isArray(rec.entries)) {
      for (var i = 0; i < rec.entries.length; i += 1) {
        var canvas = rec.entries[i] && rec.entries[i].canvas;
        if (canvas) { canvas.style.transform = transform; }
      }
    }
  }

  function resetAxis3DVisualLayers(fid) {
    var rec = frameRecs[String(fid)] || null;
    if (!rec) { return; }
    rec.axis3DVisualPanX = 0;
    rec.axis3DVisualPanY = 0;
    if (Array.isArray(rec.entries)) {
      for (var i = 0; i < rec.entries.length; i += 1) {
        var canvas = rec.entries[i] && rec.entries[i].canvas;
        if (canvas) { canvas.style.transform = ""; }
      }
    }
    resetGeomTextOverlayLayerTransform(fid);
  }

  function axis3DNiceTickStep(raw) {
    raw = Math.abs(Number(raw) || 0);
    if (!(raw > 0)) { return 1; }
    var power = Math.pow(10, Math.floor(Math.log10(raw)));
    var hints = [1, 2, 5, 10];
    for (var i = 0; i < hints.length; i += 1) {
      var candidate = hints[i] * power;
      if (raw <= candidate) { return candidate; }
    }
    return 10 * power;
  }

  function axis3DPixelsPerUnit(camera, w, h, point) {
    var cam = camera || {};
    var height = Math.max(1, Number(h) || 1);
    if (String(cam.projection || "").toLowerCase() === "orthographic") {
      return height / (2 * Math.max(1e-9, Number(cam.ortho_scale) || 2.5));
    }
    var depth = cameraDepth(cam, point || (cam.target || [0, 0, 0]));
    var verticalScale = cameraVerticalScale(cam);
    return (height * Math.max(1e-9, verticalScale)) / (2 * Math.max(1e-9, depth));
  }

  function axis3DFrameSize(fid) {
    var frameEl = findFrameEl(geomTargetFrameId(fid));
    var body = frameEl ? geomFrameHost(frameEl, fid) : null;
    var fit = frameEl ? fittedFrameContentRect(frameEl, body) : { width: 800, height: 600 };
    return {
      w: Math.max(1, Number(fit.width) || 800),
      h: Math.max(1, Number(fit.height) || 600)
    };
  }

  function axis3DVisibleRange(fid, cfg, camera, target, axis) {
    var sz = axis3DFrameSize(fid);
    var w = sz.w;
    var h = sz.h;
    var axisIndex = axis === "x" ? 0 : axis === "y" ? 1 : 2;
    var configuredExtent = Math.max(1e-6, Number(cfg && cfg.tick_extent) || 8);
    var tgt = vec3Array(camera && camera.target, target || [0, 0, 0]);
    var center = Number(tgt[axisIndex]) || 0;
    var cam = camera ? Object.assign({}, camera, {
      viewport_width_px: w,
      viewport_height_px: h
    }) : camera;
    if (cam && Array.isArray(cam.pos) && Array.isArray(cam.target)) {
      var frustumLo = null;
      var frustumHi = null;
      var configuredSpan = Math.max(configuredExtent, 1024);
      var frustumA = [0, 0, 0];
      var frustumB = [0, 0, 0];
      frustumA[axisIndex] = center - configuredSpan;
      frustumB[axisIndex] = center + configuredSpan;
      var frustumClipped = extendSegmentToScreenInset(cam, h, frustumA, frustumB, 0);
      if (frustumClipped && frustumClipped[0] && frustumClipped[1]) {
        var f0 = Number(frustumClipped[0][axisIndex]);
        var f1 = Number(frustumClipped[1][axisIndex]);
        if (Number.isFinite(f0) && Number.isFinite(f1) && Math.abs(f1 - f0) > 1e-9) {
          frustumLo = Math.min(f0, f1);
          frustumHi = Math.max(f0, f1);
        }
      }
      var axisPoint = tgt.slice();
      var axisNext = tgt.slice();
      axisNext[axisIndex] += 1;
      var p0 = projectWorldToPixel(cam, w, h, axisPoint);
      var p1 = projectWorldToPixel(cam, w, h, axisNext);
      if (p0 && p1) {
        var dx = p1[0] - p0[0];
        var dy = p1[1] - p0[1];
        var lenSq = (dx * dx) + (dy * dy);
        if (lenSq > 1e-10) {
          var len = Math.sqrt(lenSq);
          var reach = Math.max(w, h) * 4.0;
          var clippedPx = clipPixelLineToRect(
            [p0[0] - (dx / len) * reach, p0[1] - (dy / len) * reach],
            [p0[0] + (dx / len) * reach, p0[1] + (dy / len) * reach],
            0,
            0,
            w,
            h
          );
          if (clippedPx && clippedPx[0] && clippedPx[1]) {
            var da = (((clippedPx[0][0] - p0[0]) * dx) + ((clippedPx[0][1] - p0[1]) * dy)) / lenSq;
            var db = (((clippedPx[1][0] - p0[0]) * dx) + ((clippedPx[1][1] - p0[1]) * dy)) / lenSq;
            var lo = center + Math.min(da, db);
            var hi = center + Math.max(da, db);
            var pixelSpan = Math.sqrt(
              Math.pow(clippedPx[1][0] - clippedPx[0][0], 2) +
              Math.pow(clippedPx[1][1] - clippedPx[0][1], 2)
            );
            if (frustumLo != null && frustumHi != null) {
              lo = Math.max(lo, frustumLo);
              hi = Math.min(hi, frustumHi);
            }
            if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
              return { lo: lo, hi: hi, pixelSpan: Math.max(1, pixelSpan), w: w, h: h };
            }
          }
        }
      }
    }
    var aspect = w / Math.max(1, h);
    var dist = Math.max(1e-6, plotCameraDistance(camera || {}));
    var fov = (Number(camera && camera.fov) || 45) * Math.PI / 180;
    var halfHeight = String(camera && camera.projection || "").toLowerCase() === "orthographic"
      ? Math.max(1e-6, Number(camera && camera.ortho_scale) || 2.5)
      : dist * Math.tan(fov * 0.5);
    var halfWidth = halfHeight * aspect;
    var viewRadius = Math.sqrt((halfWidth * halfWidth) + (halfHeight * halfHeight));
    var span = Math.max(configuredExtent, viewRadius);
    return {
      lo: center - span,
      hi: center + span,
      pixelSpan: Math.max(1, Math.max(w, h) * (span / Math.max(1e-9, viewRadius))),
      w: w,
      h: h
    };
  }

  function axis3DAdaptiveTickStep(fid, cfg, camera, target, axis, range) {
    var visible = range || axis3DVisibleRange(fid, cfg, camera, target, axis);
    var w = visible.w || 800;
    var h = visible.h || 600;
    var pxPerUnit = Math.max(
      1e-9,
      Math.abs(Number(visible.pixelSpan) || 0) / Math.max(1e-9, Math.abs(Number(visible.hi) - Number(visible.lo)))
    );
    if (!(pxPerUnit > 0)) {
      var fallbackRange = Number(cfg[axis + "_max"]) - Number(cfg[axis + "_min"]);
      return axis3DNiceTickStep(fallbackRange / 5);
    }
    var lo = Number(visible.lo);
    var hi = Number(visible.hi);
    var pixelSpan = Math.max(1, Number(visible.pixelSpan) || ((hi - lo) * pxPerUnit));
    var dataPerPixel = 1 / pxPerUnit;
    var hints = Array.isArray(cfg.tick_hints) && cfg.tick_hints.length ? cfg.tick_hints : [1, 2, 5];
    var step = chooseAxisTickStep(
      dataPerPixel,
      Number(cfg.tick_dist) || 120,
      hints,
      Number(cfg.min_tick_dist) || 0,
      Number(cfg.max_tick_dist) || 0
    );
    return chooseReadableLinearTickStep(
      lo,
      hi,
      step,
      null,
      "linear",
      hints,
      pixelSpan,
      Number(cfg.tick_dist) || 120,
      Number(cfg.min_tick_dist) || 0,
      Number(cfg.max_tick_dist) || 0,
      Number(cfg.tick_label_font_size) || 11
    );
  }

  function axis3DTickValues(lo, hi, step) {
    step = Math.abs(Number(step) || 0);
    if (!(step > 0)) { return []; }
    var out = [];
    var value = Math.ceil(Number(lo) / step) * step;
    var eps = step * 1e-8;
    var guard = 0;
    while (value <= Number(hi) + eps && guard < 1000) {
      out.push(Math.abs(value) < eps ? 0 : value);
      value += step;
      guard += 1;
    }
    return out;
  }

  function axis3DZeroAnchoredTickValues(lo, hi, step) {
    step = Math.abs(Number(step) || 0);
    if (!(step > 0)) { return []; }
    lo = Number(lo);
    hi = Number(hi);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { return []; }
    if (hi < lo) {
      var tmp = lo;
      lo = hi;
      hi = tmp;
    }
    var out = [];
    var eps = step * 1e-8;
    var value = Math.ceil((lo - eps) / step) * step;
    var guard = 0;
    while (value <= hi + eps && guard < 2000) {
      out.push(Math.abs(value) < eps ? 0 : value);
      value += step;
      guard += 1;
    }
    return out;
  }

  function pushAxis3DVertex(out, x, y, z, color) {
    out.push(Number(x) || 0, Number(y) || 0, Number(z) || 0, 0, 0, 1, color[0], color[1], color[2], color[3]);
  }

  function rebuildAxis3DLocalField(fid, skipUpdate, geomOverride) {
    var geom = geomOverride || (_lastDisplayPayload && _lastDisplayPayload.geom ? _lastDisplayPayload.geom[String(fid)] : null);
    var cfg = geom && geom.axis3d_runtime;
    if (!geom || !cfg || !Array.isArray(geom.meshes) || !geom.meshes.length) { return; }
    var camera = geom.camera || {};
    var target = vec3Array(camera.target, [0, 0, 0]);
    var color = parseRuntimeColor(cfg.color || "white");
    var verts = [];
    var inds = [];
    function addLine(a, b) {
        var base = verts.length / 10;
      pushAxis3DVertex(verts, a[0], a[1], a[2], color);
      pushAxis3DVertex(verts, b[0], b[1], b[2], color);
      inds.push(base, base + 1);
    }
    var xRange = axis3DVisibleRange(String(fid), cfg, camera, target, "x");
    var yRange = axis3DVisibleRange(String(fid), cfg, camera, target, "y");
    var zRange = axis3DVisibleRange(String(fid), cfg, camera, target, "z");
    addLine([xRange.lo, 0, 0], [xRange.hi, 0, 0]);
    addLine([0, yRange.lo, 0], [0, yRange.hi, 0]);
    addLine([0, 0, zRange.lo], [0, 0, zRange.hi]);
    var mesh = geom.meshes[0];
    mesh.vertices = verts;
    mesh.indices = inds;
    mesh.axis3d_helper_lines = true;
    mesh.edge_width = Math.max(0.5, Number(cfg.width) || Number(mesh.edge_width) || 1);
    mesh.__dataRevision = Number(mesh.__dataRevision || 0) + 1;
    mesh.__revision = Number(mesh.__revision || 0) + 1;
    geom.texts = [];
    if (skipUpdate === true) { return; }
    updateGeomFrame(String(fid), geom);
  }

  function refreshAxis3DRuntimeFrame(fid, renderOverlay) {
    fid = String(fid);
    var geom = _lastDisplayPayload && _lastDisplayPayload.geom ? _lastDisplayPayload.geom[fid] : null;
    if (!geom || !geom.axis3d_runtime || !Array.isArray(geom.meshes) || !geom.meshes.length) { return; }
    var frameEl = findFrameEl(geomTargetFrameId(fid));
    if (!frameEl) { return; }
    rebuildAxis3DLocalField(fid, true, geom);
    var rec = frameRecs[fid] || null;
    if (rec && Array.isArray(rec.entries)) {
      var fit = fittedFrameContentRect(frameEl, geomFrameHost(frameEl, fid));
      var effectiveCamera = geom.camera
        ? Object.assign({}, geom.camera, {
            viewport_width_px: Math.max(1, Math.round(fit.width || 1)),
            viewport_height_px: Math.max(1, Math.round(fit.height || 1))
          })
        : null;
      var lights = Array.isArray(geom.lights) ? geom.lights : [];
      var visibleMeshes = renderableGeomSpecs(geom.meshes);
      for (var i = 0; i < rec.entries.length && i < visibleMeshes.length; i += 1) {
        var entry = rec.entries[i] || null;
        if (!entry) { continue; }
        var liveMesh = buildSingleMesh(visibleMeshes[i], effectiveCamera, lights);
        if (!liveMesh) { continue; }
        liveMesh.__revision = Number(visibleMeshes[i].__revision || visibleMeshes[i].__dataRevision || 0);
        if (!entry.ref) { entry.ref = { mesh: liveMesh }; }
        else { entry.ref.mesh = liveMesh; }
        if (entry.renderer) {
          entry.renderer._lastMesh = null;
          entry.renderer._lastMeshRevision = NaN;
        }
      }
    }
    if (renderOverlay !== false) {
      var fitForAxisLines = fittedFrameContentRect(frameEl, geomFrameHost(frameEl, fid));
      renderGeomLineOverlay(
        fid,
        frameEl,
        geom,
        Math.max(1, Math.round(fitForAxisLines.width || 1)),
        Math.max(1, Math.round(fitForAxisLines.height || 1))
      );
      renderGeomTextOverlay(fid, frameEl, geom);
    }
  }

  function repaintAxis3DHelperLines(fid) {
    fid = String(fid);
    var geom = _lastDisplayPayload && _lastDisplayPayload.geom ? _lastDisplayPayload.geom[fid] : null;
    if (!geom || !geom.axis3d_runtime) { return; }
    var frameEl = findFrameEl(geomTargetFrameId(fid));
    if (!frameEl) { return; }
    var fit = fittedFrameContentRect(frameEl, geomFrameHost(frameEl, fid));
    renderGeomLineOverlay(
      fid,
      frameEl,
      geom,
      Math.max(1, Math.round(fit.width || 1)),
      Math.max(1, Math.round(fit.height || 1))
    );
    renderGeomTextOverlay(fid, frameEl, geom);
  }

  function commitAxis3DHelperPanOffset(fid, body) {
    fid = String(fid);
    var rec = frameRecs[fid] || null;
    var geom = _lastDisplayPayload && _lastDisplayPayload.geom ? _lastDisplayPayload.geom[fid] : null;
    if (!rec || !geom || !geom.axis3d_runtime) { return; }
    var dx = Number(rec.axis3DHelperPanX || 0);
    var dy = Number(rec.axis3DHelperPanY || 0);
    if (!dx && !dy) { return; }
    mutateAxis3DCamera(fid, function (camera) {
      var delta = axis3DDragWorldDelta(camera, body, dx, dy);
      var pos = vec3Array(camera.pos, [4, 4, 5.657]);
      var target = vec3Array(camera.target, [0, 0, 0]);
      camera.pos = [pos[0] + delta[0], pos[1] + delta[1], pos[2] + delta[2]];
      camera.target = [target[0] + delta[0], target[1] + delta[1], target[2] + delta[2]];
    }, { skipTextOverlay: true });
    rec.axis3DHelperPanX = 0;
    rec.axis3DHelperPanY = 0;
  }

  function axis3DCommitAndRebuild(fid, body, drag) {
    if (!drag) { return; }
    drag.totalDx = 0;
    drag.totalDy = 0;
    drag.x = Number(drag.pendingX || drag.x || 0);
    drag.y = Number(drag.pendingY || drag.y || 0);
    resetAxis3DVisualLayers(fid);
    rebuildAxis3DLocalField(fid);
  }

  function mutateAxis3DCamera(fid, mutator, options) {
    if (!_lastDisplayPayload || !_lastDisplayPayload.geom || !_lastDisplayPayload.geom[fid]) { return; }
    var geom = _lastDisplayPayload.geom[fid];
    var camera = Object.assign({}, geom.camera || {});
    mutator(camera, geom);
    geom.camera = camera;
    applyAxis3DCameraToLiveRenderers(fid, camera);
    if (options && options.skipTextOverlay === true) { return; }
    resetGeomTextOverlayLayerTransform(fid);
    var frameEl = findFrameEl(geomTargetFrameId(fid));
    if (frameEl) {
      scheduleGeomTextOverlayRender(String(fid), frameEl, geom);
    }
  }

  function cameraRevisionKey(camera) {
    if (!camera) { return ""; }
    function fmt(value) {
      var n = Number(value);
      return Number.isFinite(n) ? n.toFixed(5) : "0.00000";
    }
    var pos = vec3Array(camera.pos, [0, 0, 0]);
    var target = vec3Array(camera.target, [0, 0, 0]);
    var up = vec3Array(camera.up, [0, 0, 1]);
    return [
      fmt(pos[0]), fmt(pos[1]), fmt(pos[2]),
      fmt(target[0]), fmt(target[1]), fmt(target[2]),
      fmt(up[0]), fmt(up[1]), fmt(up[2]),
      fmt(camera.viewport_width_px), fmt(camera.viewport_height_px),
      fmt(camera.fov), fmt(camera.ortho_scale), String(camera.projection || "")
    ].join(":");
  }

  function meshNeedsCameraRebuild(spec) {
    if (!spec) { return false; }
    return spec.axis_screen_extend === true ||
      String(spec.marker_space || "").toLowerCase() === "pixel" ||
      String(spec.render_mode || "").toLowerCase() === "marker_impostor";
  }

  function isAxis3DHelperLineSpec(spec) {
    return !!(spec && spec.axis3d_helper_lines === true);
  }

  function renderableGeomSpecs(specs) {
    if (!Array.isArray(specs)) { return []; }
    return specs.filter(function (spec) { return !isAxis3DHelperLineSpec(spec); });
  }

  function textPointIsNearViewport(p, w, h, pad) {
    if (!p) { return false; }
    var margin = Math.max(24, Number(pad) || 96);
    return Number(p[0]) >= -margin &&
      Number(p[0]) <= Number(w) + margin &&
      Number(p[1]) >= -margin &&
      Number(p[1]) <= Number(h) + margin;
  }

  function axis3DCursorPlanePoint(camera, body, clientX, clientY) {
    if (!camera || !body || !body.getBoundingClientRect) { return null; }
    var rect = body.getBoundingClientRect();
    var w = Math.max(1, Number(rect.width) || 1);
    var h = Math.max(1, Number(rect.height) || 1);
    var px = Math.max(0, Math.min(w, (Number(clientX) || 0) - (Number(rect.left) || 0)));
    var py = Math.max(0, Math.min(h, (Number(clientY) || 0) - (Number(rect.top) || 0)));
    var ndcX = (px / w) * 2.0 - 1.0;
    var ndcY = 1.0 - (py / h) * 2.0;
    var pos = vec3Array(camera.pos, [4, 4, 5.657]);
    var target = vec3Array(camera.target, [0, 0, 0]);
    var upHint = normalizeVec3Local(camera.up || [0, 0, 1], [0, 0, 1]);
    var forward = normalizeVec3Local([target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]], [0, 0, -1]);
    var right = normalizeVec3Local(crossVec3(forward, upHint), [1, 0, 0]);
    var up = normalizeVec3Local(crossVec3(right, forward), [0, 0, 1]);
    var aspect = w / h;
    if (String(camera.projection || "").toLowerCase() === "orthographic") {
      var orthoScale = Math.max(1e-6, Number(camera.ortho_scale) || 2.5);
      return [
        target[0] + right[0] * ndcX * orthoScale * aspect + up[0] * ndcY * orthoScale,
        target[1] + right[1] * ndcX * orthoScale * aspect + up[1] * ndcY * orthoScale,
        target[2] + right[2] * ndcX * orthoScale * aspect + up[2] * ndcY * orthoScale
      ];
    }
    var fov = (Number(camera.fov) || 45) * Math.PI / 180;
    var tanHalf = Math.tan(fov * 0.5);
    var ray = normalizeVec3Local([
      forward[0] + right[0] * ndcX * tanHalf * aspect + up[0] * ndcY * tanHalf,
      forward[1] + right[1] * ndcX * tanHalf * aspect + up[1] * ndcY * tanHalf,
      forward[2] + right[2] * ndcX * tanHalf * aspect + up[2] * ndcY * tanHalf
    ], forward);
    var denom = dot3(ray, forward);
    if (Math.abs(denom) < 1e-9) { return target; }
    var t = dot3([target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]], forward) / denom;
    if (!Number.isFinite(t)) { return target; }
    return [pos[0] + ray[0] * t, pos[1] + ray[1] * t, pos[2] + ray[2] * t];
  }

  function axis3DDragWorldDelta(camera, body, dx, dy) {
    var pos = vec3Array(camera && camera.pos, [4, 4, 5.657]);
    var target = vec3Array(camera && camera.target, [0, 0, 0]);
    var upHint = normalizeVec3Local(camera && camera.up || [0, 0, 1], [0, 0, 1]);
    var backward = normalizeVec3Local([pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]], [0, 0, 1]);
    var right = normalizeVec3Local(crossVec3(upHint, backward), [1, 0, 0]);
    var up = normalizeVec3Local(crossVec3(backward, right), [0, 0, 1]);
    var dist = plotCameraDistance(camera || {});
    var rect = body && body.getBoundingClientRect ? body.getBoundingClientRect() : { height: 1 };
    var h = Math.max(1, Number(rect && rect.height) || 1);
    var isOrtho = String(camera && camera.projection || "").toLowerCase() === "orthographic";
    var fov = (Number(camera && camera.fov) || 45) * Math.PI / 180;
    var worldPerPx = isOrtho
      ? (2 * Math.max(1e-6, Number(camera && camera.ortho_scale) || 2.5)) / h
      : (2 * dist * Math.tan(fov * 0.5)) / h;
    return [
      ((-Number(dx || 0) * right[0]) + (Number(dy || 0) * up[0])) * worldPerPx,
      ((-Number(dx || 0) * right[1]) + (Number(dy || 0) * up[1])) * worldPerPx,
      ((-Number(dx || 0) * right[2]) + (Number(dy || 0) * up[2])) * worldPerPx
    ];
  }

  function translateAxis3DScene(fid, delta) {
    if (!_lastDisplayPayload || !_lastDisplayPayload.geom || !_lastDisplayPayload.geom[fid]) { return false; }
    var geom = _lastDisplayPayload.geom[fid];
    var dx = Number(delta && delta[0]) || 0;
    var dy = Number(delta && delta[1]) || 0;
    var dz = Number(delta && delta[2]) || 0;
    if (!dx && !dy && !dz) { return false; }
    var meshes = Array.isArray(geom.meshes) ? geom.meshes : [];
    var rec = frameRecs[String(fid)] || null;
    var changed = false;
    for (var mi = 0; mi < meshes.length; mi += 1) {
      var mesh = meshes[mi] || {};
      if (String(mesh.topology || "") !== "line-list" || String(mesh.render_mode || "") !== "line") { continue; }
      var verts = mesh.vertices || null;
      if (!verts || !Number.isFinite(Number(verts.length)) || verts.length < 3) { continue; }
      for (var vi = 0; vi + 2 < verts.length; vi += 10) {
        verts[vi] = Number(verts[vi] || 0) + dx;
        verts[vi + 1] = Number(verts[vi + 1] || 0) + dy;
        verts[vi + 2] = Number(verts[vi + 2] || 0) + dz;
      }
      mesh.__dataRevision = Number(mesh.__dataRevision || 0) + 1;
      var entry = rec && rec.entries && rec.entries[mi] ? rec.entries[mi] : null;
      var liveMesh = entry && entry.ref && entry.ref.mesh ? entry.ref.mesh : null;
      var liveVerts = liveMesh && liveMesh.vertices ? liveMesh.vertices : null;
      if (liveVerts && liveVerts.length === verts.length) {
        for (var lvi = 0; lvi + 2 < liveVerts.length; lvi += 10) {
          liveVerts[lvi] = Number(liveVerts[lvi] || 0) + dx;
          liveVerts[lvi + 1] = Number(liveVerts[lvi + 1] || 0) + dy;
          liveVerts[lvi + 2] = Number(liveVerts[lvi + 2] || 0) + dz;
        }
        liveMesh.__revision = Number(liveMesh.__revision || 0) + 1;
        if (entry.renderer) {
          entry.renderer._lastMeshRevision = -1;
        }
      }
      changed = true;
    }
    var texts = Array.isArray(geom.texts) ? geom.texts : [];
    for (var ti = 0; ti < texts.length; ti += 1) {
      var item = texts[ti] || {};
      if (item.world !== true) { continue; }
      item.x = Number(item.x || 0) + dx;
      item.y = Number(item.y || 0) + dy;
      item.z = Number(item.z || 0) + dz;
      changed = true;
    }
    if (changed) { schedulePlotCameraUpdate(fid); }
    return changed;
  }

  function mutateAxisViewport(fid, mutator) {
    if (!_lastDisplayPayload || !_lastDisplayPayload.geom || !_lastDisplayPayload.geom[fid]) { return; }
    var geom = _lastDisplayPayload.geom[fid];
    var meshes = Array.isArray(geom.meshes) ? geom.meshes : [];
    var changed = false;
    for (var i = 0; i < meshes.length; i += 1) {
      var cfg = meshes[i] && meshes[i].axis_ticks;
      if (!cfg || meshes[i].axis_interactive === false) { continue; }
      mutator(cfg, meshes[i]);
      changed = true;
    }
    if (changed) {
      schedulePlotCameraUpdate(fid);
    }
  }

  function ensureAxis2DControls(fid, frameEl, geomSpec) {
    var meshes = geomSpec && Array.isArray(geomSpec.meshes) ? geomSpec.meshes : [];
    var enabled = false;
    for (var i = 0; i < meshes.length; i += 1) {
      if (meshes[i] && meshes[i].axis_ticks && meshes[i].axis_interactive !== false) {
        enabled = true;
        break;
      }
    }
    if (!enabled) { return; }
    var body = geomFrameHost(frameEl, fid);
    if (!body || body.__vfAxis2DControlsAttached) { return; }
    body.__vfAxis2DControlsAttached = true;
    body.__vfAxis2DDragState = null;

    body.addEventListener("wheel", function (e) {
      if (!_lastDisplayPayload || !_lastDisplayPayload.geom || !_lastDisplayPayload.geom[fid]) { return; }
      e.preventDefault();
      e.stopPropagation();
      var factor = Math.exp(Math.max(-400, Math.min(400, Number(e.deltaY) || 0)) * 0.0012);
      var rect = body.getBoundingClientRect ? body.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
      var w = Math.max(1, Number(rect.width) || 1);
      var h = Math.max(1, Number(rect.height) || 1);
      var px = Math.max(0, Math.min(w, (Number(e.clientX) || 0) - (Number(rect.left) || 0)));
      var py = Math.max(0, Math.min(h, (Number(e.clientY) || 0) - (Number(rect.top) || 0)));
      mutateAxisViewport(fid, function (cfg, mesh) {
        var xMin = Number(cfg.x_min);
        var xMax = Number(cfg.x_max);
        var yMin = Number(cfg.y_min);
        var yMax = Number(cfg.y_max);
        if (!(xMax > xMin) || !(yMax > yMin)) { return; }
        var view = axisViewport(mesh, cfg, w, h);
        if (!view) { return; }
        var box = axisBoxRect(mesh, w, h);
        var ux = mesh && mesh.axis_box === true
          ? Math.max(0, Math.min(1, (px - box.left) / Math.max(1, box.width)))
          : Math.max(0, Math.min(1, px / w));
        var uy = mesh && mesh.axis_box === true
          ? Math.max(0, Math.min(1, (box.bottom - py) / Math.max(1, box.height)))
          : Math.max(0, Math.min(1, 1.0 - (py / h)));

        if (isLogTickMode(cfg.x_mode) && xMin > 0 && xMax > xMin) {
          var lx0 = Math.log(xMin) / Math.LN10;
          var lx1 = Math.log(xMax) / Math.LN10;
          var lxAnchor = lx0 + ux * (lx1 - lx0);
          var lxSpan = (lx1 - lx0) * factor;
          applyLogRange(cfg, "x", lxAnchor - ux * lxSpan, lxAnchor + (1.0 - ux) * lxSpan);
        } else {
          var dataX = view.vx0 + (px / w) * (view.vx1 - view.vx0);
          var visibleSpanX = (view.vx1 - view.vx0) * factor;
          var nextVx0 = dataX - (px / w) * visibleSpanX;
          var nextCenterX = nextVx0 + visibleSpanX * 0.5;
          var aspectX = String(mesh && mesh.aspect || "").toLowerCase() === "equal" && w >= h ? w / Math.max(1, h) : 1;
          var hx = ((xMax - xMin) * factor) * 0.5;
          if (aspectX > 1) {
            hx = (visibleSpanX / aspectX) * 0.5;
          }
          applyLinearRange(cfg, "x", nextCenterX - hx, nextCenterX + hx);
        }
        if (isLogTickMode(cfg.y_mode) && yMin > 0 && yMax > yMin) {
          var ly0 = Math.log(yMin) / Math.LN10;
          var ly1 = Math.log(yMax) / Math.LN10;
          var lyAnchor = ly0 + uy * (ly1 - ly0);
          var lySpan = (ly1 - ly0) * factor;
          applyLogRange(cfg, "y", lyAnchor - uy * lySpan, lyAnchor + (1.0 - uy) * lySpan);
        } else {
          var dataY = view.vy1 - (py / h) * (view.vy1 - view.vy0);
          var visibleSpanY = (view.vy1 - view.vy0) * factor;
          var nextVy1 = dataY + (py / h) * visibleSpanY;
          var nextCenterY = nextVy1 - visibleSpanY * 0.5;
          var aspectY = String(mesh && mesh.aspect || "").toLowerCase() === "equal" && h > w ? h / Math.max(1, w) : 1;
          var hy = ((yMax - yMin) * factor) * 0.5;
          if (aspectY > 1) {
            hy = (visibleSpanY / aspectY) * 0.5;
          }
          applyLinearRange(cfg, "y", nextCenterY - hy, nextCenterY + hy);
        }
      });
    }, { passive: false });

    body.addEventListener("pointerdown", function (e) {
      if (Number(e.button || 0) !== 0) { return; }
      body.__vfAxis2DDragState = { x: Number(e.clientX) || 0, y: Number(e.clientY) || 0 };
      try { body.setPointerCapture(e.pointerId); } catch (_) {}
      e.stopPropagation();
    });
    body.addEventListener("pointerup", function (e) {
      body.__vfAxis2DDragState = null;
      try { body.releasePointerCapture(e.pointerId); } catch (_) {}
    });
    body.addEventListener("pointercancel", function (e) {
      body.__vfAxis2DDragState = null;
      try { body.releasePointerCapture(e.pointerId); } catch (_) {}
    });
    body.addEventListener("pointermove", function (e) {
      var drag = body.__vfAxis2DDragState;
      if (!drag) { return; }
      var x = Number(e.clientX) || 0;
      var y = Number(e.clientY) || 0;
      var dx = x - drag.x;
      var dy = y - drag.y;
      drag.x = x;
      drag.y = y;
      if (!dx && !dy) { return; }
      e.stopPropagation();
      var rect = body.getBoundingClientRect ? body.getBoundingClientRect() : { width: 1, height: 1 };
      var w = Math.max(1, Number(rect.width) || 1);
      var h = Math.max(1, Number(rect.height) || 1);
      mutateAxisViewport(fid, function (cfg, mesh) {
        var view = axisViewport(mesh, cfg, w, h);
        if (!view) { return; }
        var box = axisBoxRect(mesh, w, h);
        var axisW = mesh && mesh.axis_box === true ? Math.max(1, box.width) : w;
        var axisH = mesh && mesh.axis_box === true ? Math.max(1, box.height) : h;
        if (isLogTickMode(cfg.x_mode) && Number(cfg.x_min) > 0 && Number(cfg.x_max) > Number(cfg.x_min)) {
          var px0 = Math.log(Number(cfg.x_min)) / Math.LN10;
          var px1 = Math.log(Number(cfg.x_max)) / Math.LN10;
          var pdx = (-dx / axisW) * (px1 - px0);
          applyLogRange(cfg, "x", px0 + pdx, px1 + pdx);
        } else {
          var unitsPerPxX = mesh && mesh.axis_box === true
            ? (Number(cfg.x_max) - Number(cfg.x_min)) / axisW
            : (view.vx1 - view.vx0) / w;
          var tx = -dx * unitsPerPxX;
          applyLinearRange(cfg, "x", Number(cfg.x_min) + tx, Number(cfg.x_max) + tx);
        }
        if (isLogTickMode(cfg.y_mode) && Number(cfg.y_min) > 0 && Number(cfg.y_max) > Number(cfg.y_min)) {
          var py0 = Math.log(Number(cfg.y_min)) / Math.LN10;
          var py1 = Math.log(Number(cfg.y_max)) / Math.LN10;
          var pdy = (dy / axisH) * (py1 - py0);
          applyLogRange(cfg, "y", py0 + pdy, py1 + pdy);
        } else {
          var unitsPerPxY = mesh && mesh.axis_box === true
            ? (Number(cfg.y_max) - Number(cfg.y_min)) / axisH
            : (view.vy1 - view.vy0) / h;
          var ty = dy * unitsPerPxY;
          applyLinearRange(cfg, "y", Number(cfg.y_min) + ty, Number(cfg.y_max) + ty);
        }
      });
    });
  }

  function ensurePlotCameraControls(fid, frameEl, geomSpec) {
    if (!geomSpec || geomSpec.plot_controls !== true) { return; }
    var body = geomFrameHost(frameEl, fid);
    if (!body || body.__vfPlotCameraControlsAttached) { return; }
    body.__vfPlotCameraControlsAttached = true;
    body.__vfPlotDragState = null;

    body.addEventListener("wheel", function (e) {
      if (!_lastDisplayPayload || !_lastDisplayPayload.geom || !_lastDisplayPayload.geom[fid]) { return; }
      e.preventDefault();
      e.stopPropagation();
      var factor = Math.exp(Math.max(-400, Math.min(400, Number(e.deltaY) || 0)) * 0.0012);
      mutatePlotCamera(fid, function (camera) {
        var pos = vec3Array(camera.pos, [0, -4, 2.6]);
        var target = vec3Array(camera.target, [0, 0, 0]);
        camera.pos = [
          target[0] + (pos[0] - target[0]) * factor,
          target[1] + (pos[1] - target[1]) * factor,
          target[2] + (pos[2] - target[2]) * factor
        ];
      });
    }, { passive: false });

    body.addEventListener("pointerdown", function (e) {
      if (Number(e.button || 0) !== 0) { return; }
      body.__vfPlotDragState = { x: Number(e.clientX) || 0, y: Number(e.clientY) || 0 };
      try { body.setPointerCapture(e.pointerId); } catch (_) {}
      e.stopPropagation();
    });
    body.addEventListener("pointerup", function (e) {
      body.__vfPlotDragState = null;
      try { body.releasePointerCapture(e.pointerId); } catch (_) {}
    });
    body.addEventListener("pointercancel", function (e) {
      body.__vfPlotDragState = null;
      try { body.releasePointerCapture(e.pointerId); } catch (_) {}
    });
    body.addEventListener("pointermove", function (e) {
      var drag = body.__vfPlotDragState;
      if (!drag) { return; }
      var x = Number(e.clientX) || 0;
      var y = Number(e.clientY) || 0;
      var dx = x - drag.x;
      var dy = y - drag.y;
      drag.x = x;
      drag.y = y;
      if (!dx && !dy) { return; }
      e.stopPropagation();
      mutatePlotCamera(fid, function (camera, geom) {
        var kind = String((geom && geom.plot_kind) || "curve");
        var pos = vec3Array(camera.pos, [0, -4, 2.6]);
        var target = vec3Array(camera.target, [0, 0, 0]);
        var dist = plotCameraDistance(camera);
        if (kind === "surface") {
          var vx = pos[0] - target[0];
          var vy = pos[1] - target[1];
          var vz = pos[2] - target[2];
          var yaw = Math.atan2(vy, vx) - dx * 0.008;
          var pitch = Math.asin(Math.max(-0.94, Math.min(0.94, vz / Math.max(dist, 1e-6)))) + dy * 0.006;
          pitch = Math.max(-1.25, Math.min(1.25, pitch));
          var cp = Math.cos(pitch);
          camera.pos = [
            target[0] + Math.cos(yaw) * cp * dist,
            target[1] + Math.sin(yaw) * cp * dist,
            target[2] + Math.sin(pitch) * dist
          ];
        } else {
          var scale = dist * 0.0015;
          var tx = -dx * scale;
          var ty = dy * scale;
          camera.target = [target[0] + tx, target[1] + ty, target[2]];
          camera.pos = [pos[0] + tx, pos[1] + ty, pos[2]];
        }
      });
    });
  }

  function ensureAxis3DControls(fid, frameEl, geomSpec) {
    if (!geomSpec || geomSpec.axis3d_controls !== true) { return; }
    var body = geomFrameHost(frameEl, fid);
    if (!body || body.__vfAxis3DControlsAttached) { return; }
    body.__vfAxis3DControlsAttached = true;
    body.__vfAxis3DDragState = null;

    function claimAxis3DEvent(e) {
      if (!e) { return; }
      if (typeof e.preventDefault === "function") { e.preventDefault(); }
      if (typeof e.stopImmediatePropagation === "function") { e.stopImmediatePropagation(); }
      else if (typeof e.stopPropagation === "function") { e.stopPropagation(); }
    }

    function flushAxis3DDrag() {
      var drag = body.__vfAxis3DDragState;
      if (!drag) { return; }
      drag.raf = 0;
      var dx = Number(drag.pendingX || 0) - Number(drag.x || 0);
      var dy = Number(drag.pendingY || 0) - Number(drag.y || 0);
      drag.x = Number(drag.pendingX || 0);
      drag.y = Number(drag.pendingY || 0);
      if (!dx && !dy) { return; }
      drag.totalDx = Number(drag.totalDx || 0) + dx;
      drag.totalDy = Number(drag.totalDy || 0) + dy;
      mutateAxis3DCamera(fid, function (camera) {
        var delta = axis3DDragWorldDelta(camera, body, dx, dy);
        var pos = vec3Array(camera.pos, [4, 4, 5.657]);
        var target = vec3Array(camera.target, [0, 0, 0]);
        camera.pos = [pos[0] + delta[0], pos[1] + delta[1], pos[2] + delta[2]];
        camera.target = [target[0] + delta[0], target[1] + delta[1], target[2] + delta[2]];
      }, { skipTextOverlay: true });
      repaintAxis3DHelperLines(fid);
    }

    function commitAxis3DDrag(drag) {
      if (!drag) { return; }
      flushAxis3DDrag();
      axis3DCommitAndRebuild(fid, body, drag);
      refreshAxis3DRuntimeFrame(fid, true);
    }

    function cancelAxis3DDragRaf(drag) {
      if (drag && drag.raf) {
        try { global.cancelAnimationFrame(drag.raf); } catch (_) {}
        drag.raf = 0;
      }
    }

    body.addEventListener("wheel", function (e) {
      if (!_lastDisplayPayload || !_lastDisplayPayload.geom || !_lastDisplayPayload.geom[fid]) { return; }
      claimAxis3DEvent(e);
      try { e.__vfHandledWheel = true; } catch (_) {}
      var factor = Math.exp(Math.max(-600, Math.min(600, Number(e.deltaY) || 0)) * 0.0028);
      mutateAxis3DCamera(fid, function (camera) {
        var anchorBefore = axis3DCursorPlanePoint(camera, body, e.clientX, e.clientY);
        var isOrtho = String(camera.projection || "").toLowerCase() === "orthographic";
        var pos = vec3Array(camera.pos, [4, 4, 5.657]);
        var target = vec3Array(camera.target, [0, 0, 0]);
        var nextPos = isOrtho ? pos.slice() : [
          target[0] + (pos[0] - target[0]) * factor,
          target[1] + (pos[1] - target[1]) * factor,
          target[2] + (pos[2] - target[2]) * factor
        ];
        if (isOrtho) {
          camera.ortho_scale = Math.max(1e-6, Number(camera.ortho_scale || 2.5) * factor);
        }
        camera.pos = nextPos;
        var anchorAfter = axis3DCursorPlanePoint(camera, body, e.clientX, e.clientY);
        if (anchorBefore && anchorAfter) {
          var tx = anchorBefore[0] - anchorAfter[0];
          var ty = anchorBefore[1] - anchorAfter[1];
          var tz = anchorBefore[2] - anchorAfter[2];
          if (Number.isFinite(tx) && Number.isFinite(ty) && Number.isFinite(tz)) {
            camera.target = [target[0] + tx, target[1] + ty, target[2] + tz];
            camera.pos = [nextPos[0] + tx, nextPos[1] + ty, nextPos[2] + tz];
          }
        }
      }, { skipTextOverlay: true });
      var rec = frameRecs[String(fid)] || null;
      if (rec) { rec.axis3DHelperTickCache = null; }
      repaintAxis3DHelperLines(fid);
    }, { passive: false, capture: true });

    body.addEventListener("pointerdown", function (e) {
      if (Number(e.button || 0) !== 0) { return; }
      var x = Number(e.clientX) || 0;
      var y = Number(e.clientY) || 0;
      resetAxis3DVisualLayers(fid);
      body.__vfAxis3DDragState = { x: x, y: y, pendingX: x, pendingY: y, totalDx: 0, totalDy: 0, raf: 0 };
      try { body.setPointerCapture(e.pointerId); } catch (_) {}
      claimAxis3DEvent(e);
    }, true);
    body.addEventListener("pointerup", function (e) {
      var drag = body.__vfAxis3DDragState;
      cancelAxis3DDragRaf(body.__vfAxis3DDragState);
      commitAxis3DDrag(drag);
      body.__vfAxis3DDragState = null;
      try { body.releasePointerCapture(e.pointerId); } catch (_) {}
      claimAxis3DEvent(e);
    }, true);
    body.addEventListener("pointercancel", function (e) {
      cancelAxis3DDragRaf(body.__vfAxis3DDragState);
      resetAxis3DVisualLayers(fid);
      body.__vfAxis3DDragState = null;
      try { body.releasePointerCapture(e.pointerId); } catch (_) {}
      claimAxis3DEvent(e);
    }, true);
    body.addEventListener("pointermove", function (e) {
      var drag = body.__vfAxis3DDragState;
      if (!drag) { return; }
      var latestEvent = e;
      if (e && typeof e.getCoalescedEvents === "function") {
        var coalesced = e.getCoalescedEvents();
        if (coalesced && coalesced.length) {
          latestEvent = coalesced[coalesced.length - 1] || e;
        }
      }
      var x = Number(latestEvent.clientX) || 0;
      var y = Number(latestEvent.clientY) || 0;
      drag.pendingX = x;
      drag.pendingY = y;
      claimAxis3DEvent(e);
      if (!drag.raf) {
        drag.raf = global.requestAnimationFrame(function () {
          flushAxis3DDrag();
        });
      }
    }, true);
  }

  function updatePlotAnimation(fid, frameEl, geomSpec) {
    var body = geomFrameHost(frameEl, fid);
    if (!body) { return; }
    var animate = !!(geomSpec && geomSpec.plot_animate === true);
    if (!animate) {
      if (body.__vfPlotTimeTimer) {
        global.clearTimeout(body.__vfPlotTimeTimer);
        body.__vfPlotTimeTimer = 0;
      }
      return;
    }
    body.__vfPlotTimeSpec = {
      min: Number(geomSpec.plot_t_min || 0),
      max: Number(geomSpec.plot_t_max || 1),
      count: Math.max(2, Math.floor(Number(geomSpec.plot_t_count || 90))),
      started: body.__vfPlotTimeSpec && body.__vfPlotTimeSpec.started ? body.__vfPlotTimeSpec.started : Date.now()
    };
    if (body.__vfPlotTimeTimer) { return; }
    function tick() {
      body.__vfPlotTimeTimer = 0;
      var spec = body.__vfPlotTimeSpec;
      if (!spec) { return; }
      var span = spec.max - spec.min;
      if (!Number.isFinite(span) || span === 0) { span = 1; }
      var idx = Math.floor(((Date.now() - spec.started) / 1000) * 24) % spec.count;
      var a = spec.count <= 1 ? 0 : idx / (spec.count - 1);
      postEvent({
        type: "vf_event",
        event: "plot.time_tick",
        frame_id: geomTargetFrameId(fid),
        widget_id: geomTargetWidgetId(fid) || "plot_panel",
        data: { value: spec.min + a * span }
      });
      body.__vfPlotTimeTimer = global.setTimeout(tick, 42);
    }
    tick();
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
      var frameEl = findFrameEl(geomTargetFrameId(fid));
      if (!frameEl) { continue; }
      var body = geomFrameHost(frameEl, fid);
      var rect = fittedFrameContentRect(frameEl, body);
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

  function collectRendererErrors(entries) {
    var out = [];
    for (var i = 0; i < entries.length; i += 1) {
      var renderer = entries[i] && entries[i].renderer;
      var runtimeError = renderer && typeof renderer._runtimeError === "string"
        ? renderer._runtimeError.trim()
        : "";
      if (runtimeError) { out.push(runtimeError); }
    }
    return out;
  }

  function geomFrameStatus(fid) {
    var rec = frameRecs[String(fid)] || null;
    var entries = rec && Array.isArray(rec.entries) ? rec.entries : [];
    var renderers = 0;
    var runningRenderers = 0;
    var initFailures = [];
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i] || null;
      if (entry && entry.initError) {
        initFailures.push(String(entry.initError));
      }
      var renderer = entry && entry.renderer;
      if (!renderer) { continue; }
      renderers += 1;
      if (renderer._running) {
        runningRenderers += 1;
      }
    }
    var frameEl = findFrameEl(geomTargetFrameId(fid));
    var canvases = frameEl ? frameEl.querySelectorAll("canvas.vf-geom-canvas").length : 0;
    return {
      hasFrame: !!frameEl,
      entryCount: entries.length,
      renderers: renderers,
      runningRenderers: runningRenderers,
      canvasCount: Number(canvases) || 0,
      initFailures: initFailures,
      runtimeFailures: collectRendererErrors(entries),
      lastWgpuError: global.__vfGeomWgpuLastError || "",
      lastWgpuLog: global.__vfGeomWgpuLastLog || ""
    };
  }

  function geomFrameViewAspect(fid) {
    var frameEl = findFrameEl(geomTargetFrameId(fid));
    if (!frameEl) { return 1.0; }
    var body = geomFrameHost(frameEl, fid);
    var rect = fittedFrameContentRect(frameEl, body);
    return Math.max(1e-4, Number(rect.width || 1) / Math.max(1, Number(rect.height || 1)));
  }

  async function analyzeSurfaceTextures(fid, threshold) {
    var rec = frameRecs[String(fid)] || null;
    if (!rec || !Array.isArray(rec.entries)) { return []; }
    var out = [];
    for (var i = 0; i < rec.entries.length; i += 1) {
      var entry = rec.entries[i];
      var renderer = entry && entry.renderer;
      if (!renderer || typeof renderer._debugAnalyzeSurfaceTextures !== "function") { continue; }
      var rendererOut = await renderer._debugAnalyzeSurfaceTextures(threshold);
      if (Array.isArray(rendererOut)) {
        out = out.concat(rendererOut);
      }
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

  function isSimple2DMarkerLineMesh(mesh) {
    return !!(
      mesh &&
      mesh.mode3d === false &&
      String(mesh.render_mode || "") === "marker_impostor" &&
      String(mesh.marker_space || "") === "pixel" &&
      String(mesh.topology || "") === "line-list" &&
      Array.isArray(mesh.vertices) &&
      Array.isArray(mesh.indices)
    );
  }

  function stopGeomFrameRenderers(fid) {
    var rec = frameRecs[fid];
    if (!rec || !rec.entries) { return; }
    for (var j = 0; j < rec.entries.length; j += 1) {
      try {
        if (rec.entries[j].renderer && rec.entries[j].renderer.stop) {
          rec.entries[j].renderer.stop();
        }
      } catch (_) {}
      try {
        if (rec.entries[j].resizeObserver) {
          rec.entries[j].resizeObserver.disconnect();
        }
      } catch (_) {}
      try {
        if (rec.entries[j].resizeRaf) {
          cancelAnimationFrame(rec.entries[j].resizeRaf);
        }
      } catch (_) {}
      try {
        if (rec.entries[j].canvas && rec.entries[j].canvas.parentNode) {
          rec.entries[j].canvas.parentNode.removeChild(rec.entries[j].canvas);
        }
      } catch (_) {}
    }
    rec.entries.length = 0;
    if (rec.simple2DResizeObserver) {
      try { rec.simple2DResizeObserver.disconnect(); } catch (_) {}
      rec.simple2DResizeObserver = null;
    }
    if (rec.simple2DResizeRaf) {
      try { cancelAnimationFrame(rec.simple2DResizeRaf); } catch (_) {}
      rec.simple2DResizeRaf = 0;
    }
  }

  function tickDistanceBand(tickDist, minTickDist, maxTickDist) {
    var target = Math.max(1, Number(tickDist) || 72);
    var lo = Number(minTickDist);
    var hi = Number(maxTickDist);
    if (!(lo > 0)) { lo = target * 0.72; }
    if (!(hi > lo)) { hi = target * 1.45; }
    return { target: target, min: lo, max: hi };
  }

  function tickSpacingScore(px, band) {
    var spacing = Math.max(1e-9, Number(px) || 0);
    if (spacing >= band.min && spacing <= band.max) {
      var center = Math.sqrt(band.min * band.max);
      return Math.abs(Math.log(spacing / center)) * 0.01;
    }
    if (spacing < band.min) {
      return Math.log(band.min / spacing);
    }
    return Math.log(spacing / band.max);
  }

  function chooseAxisTickStep(dataPerPixel, tickDist, hints, minTickDist, maxTickDist) {
    var band = tickDistanceBand(tickDist, minTickDist, maxTickDist);
    var target = Math.max(1e-12, Math.abs(Number(dataPerPixel) || 0) * Math.max(1, Number(tickDist) || 72));
    var rawHints = Array.isArray(hints) && hints.length ? hints : [1, 2, 5];
    var cleanHints = [];
    for (var hi = 0; hi < rawHints.length; hi += 1) {
      var hv = Math.abs(Number(rawHints[hi]) || 0);
      if (hv > 0) { cleanHints.push(hv); }
    }
    if (!cleanHints.length) { cleanHints = [1, 2, 5]; }
    var pow = Math.floor(Math.log(target) / Math.LN10);
    var best = cleanHints[0] * Math.pow(10, pow);
    var bestScore = Infinity;
    for (var pi = pow - 1; pi <= pow + 1; pi += 1) {
      var scale = Math.pow(10, pi);
      for (var ci = 0; ci < cleanHints.length; ci += 1) {
        var cand = cleanHints[ci] * scale;
          var spacingPx = cand / Math.max(1e-12, Math.abs(Number(dataPerPixel) || 0));
          var score = tickSpacingScore(spacingPx, band);
          if (score < bestScore) {
          bestScore = score;
          best = cand;
        }
      }
    }
    return best;
  }

  function stripMathLabelText(label) {
    return String(label || "")
      .replace(/\$/g, "")
      .replace(/\\cdot/g, "*")
      .replace(/\{|\}/g, "");
  }

  function estimateTickLabelWidthPx(label, fontSize) {
    var text = stripMathLabelText(label);
    return Math.max(1, text.length) * Math.max(1, Number(fontSize) || 11) * 0.58 + 8;
  }

  function maxEstimatedTickLabelWidthPx(values, mode, minValue, maxValue, offset, step, fontSize) {
    var maxW = 0;
    for (var i = 0; i < values.length; i += 1) {
      var label = axisTickLabelWithOffset(values[i], mode, minValue, maxValue, offset, step);
      maxW = Math.max(maxW, estimateTickLabelWidthPx(label, fontSize));
    }
    return maxW;
  }

  function chooseReadableLinearTickStep(minValue, maxValue, step, explicitValues, mode, hints, pixelSpan, tickDist, minTickDist, maxTickDist, fontSize) {
    var current = Math.max(1e-12, Math.abs(Number(step) || 0));
    var span = Math.max(1, Number(pixelSpan) || 1);
    var dataPerPixel = (Number(maxValue) - Number(minValue)) / span;
    var explicit = explicitAxisTicks(explicitValues);
    if (explicit || !(dataPerPixel > 0)) { return current; }
    var rawHints = Array.isArray(hints) && hints.length ? hints : [1, 2, 5];
    var safeMinDist = Math.max(1, Number(minTickDist) || 0);
    for (var tries = 0; tries < 12; tries += 1) {
      var vals = axisTickValuesForMode(minValue, maxValue, current, null, mode, false, hints, span, tickDist, minTickDist, maxTickDist);
      if (vals.length < 2) { return current; }
      var off = axisLabelOffset(vals, minValue, maxValue);
      var labelMinDist = maxEstimatedTickLabelWidthPx(vals, mode, minValue, maxValue, off, current, fontSize) + 8;
      var spacingPx = current / Math.max(1e-12, Math.abs(dataPerPixel));
      if (spacingPx >= Math.max(safeMinDist, labelMinDist)) { return current; }
      current = chooseAxisTickStep(dataPerPixel, Math.max(Number(tickDist) || 72, labelMinDist), rawHints, Math.max(safeMinDist, labelMinDist), maxTickDist);
      if (!(current > 0)) { return step; }
      dataPerPixel = (Number(maxValue) - Number(minValue)) / span;
    }
    return current;
  }

  function firstAxisTick(minValue, step) {
    return Math.ceil((minValue - (step * 1e-9)) / step) * step;
  }

  function explicitAxisTicks(values) {
    if (!Array.isArray(values)) { return null; }
    var out = [];
    for (var i = 0; i < values.length; i += 1) {
      var v = Number(values[i]);
      if (Number.isFinite(v)) { out.push(v); }
    }
    return out;
  }

  function axisTickValues(minValue, maxValue, step, explicitValues) {
    var out = [];
    var explicit = explicitAxisTicks(explicitValues);
    var maxTicks = 1000;
    if (explicit) {
      for (var i = 0; i < explicit.length && out.length < maxTicks; i += 1) {
        var ev = explicit[i];
        if (ev >= minValue - step * 1e-9 && ev <= maxValue + step * 1e-9 && Math.abs(ev) >= step * 1e-10) {
          out.push(ev);
        }
      }
      return out;
    }
    for (var v = firstAxisTick(minValue, step); v <= maxValue + step * 1e-9 && out.length < maxTicks; v += step) {
      out.push(v);
    }
    return out;
  }

  function axisTickValuesNoZero(minValue, maxValue, step, explicitValues) {
    var raw = axisTickValues(minValue, maxValue, step, explicitValues);
    var out = [];
    for (var i = 0; i < raw.length; i += 1) {
      if (Math.abs(raw[i]) >= step * 1e-10) { out.push(raw[i]); }
    }
    return out;
  }

  function decimalPlacesForStep(step) {
    var s = Math.abs(Number(step) || 0);
    if (!Number.isFinite(s) || s <= 0) { return null; }
    var text = String(Number(s.toPrecision(12)));
    var exp = text.match(/e([+-]?\d+)$/i);
    if (exp) {
      return Math.max(0, -Number(exp[1]));
    }
    var dot = text.indexOf(".");
    return dot >= 0 ? Math.min(12, text.length - dot - 1) : 0;
  }

  function snapTickValueForLabel(value, step) {
    var v = Number(value) || 0;
    var s = Math.abs(Number(step) || 0);
    if (!Number.isFinite(s) || s <= 0) { return v; }
    return Math.round(v / s) * s;
  }

  function formatAxisTickLabel(value, step) {
    var v = Number(value) || 0;
    var decimals = decimalPlacesForStep(step);
    if (decimals !== null) {
      v = snapTickValueForLabel(v, step);
    }
    if (Math.abs(v) < 1e-12) { v = 0; }
    var av = Math.abs(v);
    if (av !== 0 && (av < 0.01 || av >= 1e4)) {
      return "$" + formatScientificBody(v) + "$";
    }
    if (decimals !== null) {
      if (decimals === 0 || Math.abs(v - Math.round(v)) < 1e-12) {
        return "$" + String(Math.round(v)) + "$";
      }
      return "$" + Number(v.toFixed(decimals)).toFixed(decimals).replace(/\.?0+$/, "") + "$";
    }
    if (Math.abs(v - Math.round(v)) < 1e-12) { return "$" + String(Math.round(v)) + "$"; }
    return "$" + String(Number(v.toPrecision(6))) + "$";
  }

  function formatScientificBody(value) {
    var v = Number(value) || 0;
    if (v === 0) { return "0"; }
    var sign = v < 0 ? "-" : "";
    var av = Math.abs(v);
    if (av >= 0.01 && av < 1e4) {
      return sign + String(Number(av.toPrecision(6)));
    }
    var exponent = Math.floor(Math.log(av) / Math.LN10);
    var mantissa = Number((av / Math.pow(10, exponent)).toPrecision(6));
    if (Math.abs(mantissa - 10) < 1e-8) {
      mantissa = 1;
      exponent += 1;
    }
    if (Math.abs(mantissa - 1) < 1e-8) {
      return sign + "10^{" + String(exponent) + "}";
    }
    return sign + String(mantissa) + " \\cdot 10^{" + String(exponent) + "}";
  }

  function formatOffsetLabel(offset) {
    var v = Number(offset) || 0;
    if (v === 0) { return ""; }
    return "$" + (v > 0 ? "+ " : "- ") + formatScientificBody(Math.abs(v)) + "$";
  }

  function axisLabelOffset(values, minValue, maxValue) {
    if (!Array.isArray(values) || values.length < 2) { return 0; }
    var lo = Number(minValue);
    var hi = Number(maxValue);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) { return 0; }
    var minDelta = Infinity;
    for (var i = 1; i < values.length; i += 1) {
      var d = Math.abs(Number(values[i]) - Number(values[i - 1]));
      if (d > 0 && d < minDelta) { minDelta = d; }
    }
    if (!Number.isFinite(minDelta) || minDelta <= 0) { return 0; }
    var center = (lo + hi) * 0.5;
    if (Math.abs(center) / minDelta < 1e5) { return 0; }
    var offset = Math.floor(lo / minDelta) * minDelta;
    if (!Number.isFinite(offset) || offset === 0) { return 0; }
    return offset;
  }

  function axisTickLabelWithOffset(value, mode, minValue, maxValue, offset, step) {
    var off = Number(offset) || 0;
    if (off !== 0) {
      var delta = Number(value) - off;
      if (Math.abs(delta) < Math.abs(Number(value) || 0) * 1e-12) { delta = 0; }
      return formatAxisTickLabel(delta, step);
    }
    if (!isLogTickMode(mode) || isSubDecadePositiveRange(minValue, maxValue)) {
      return formatAxisTickLabel(value, step);
    }
    return axisTickLabelForMode(value, mode, minValue, maxValue);
  }

  function formatLogAxisTickLabel(value, minValue, maxValue) {
    var v = Number(value) || 0;
    if (v === 0) { return ""; }
    var lo = Math.abs(Number(minValue) || 0);
    var hi = Math.abs(Number(maxValue) || 0);
    var rangeRatio = lo > 0 && hi > lo ? hi / lo : Infinity;
    if (rangeRatio < 10) {
      return formatAxisTickLabel(value);
    }
    var av = Math.abs(v);
    if (av >= 0.01 && av < 1e4) {
      return "$" + (v < 0 ? "-" : "") + String(Number(av.toPrecision(6))) + "$";
    }
    return "$" + formatScientificBody(v) + "$";
  }

  function isSubDecadePositiveRange(minValue, maxValue) {
    var lo = Number(minValue);
    var hi = Number(maxValue);
    return lo > 0 && hi > lo && hi / lo < 10;
  }

  function isLogTickMode(mode) {
    return String(mode || "linear").toLowerCase() === "log";
  }

  function positiveLogTickValues(minValue, maxValue, explicitValues, hints) {
    var explicit = explicitAxisTicks(explicitValues);
    if (explicit) {
      var filtered = [];
      for (var ei = 0; ei < explicit.length; ei += 1) {
        if (explicit[ei] > 0 && explicit[ei] >= minValue * (1 - 1e-6) && explicit[ei] <= maxValue * (1 + 1e-6)) {
          filtered.push(explicit[ei]);
        }
      }
      return filtered;
    }
    var minV = Math.max(Number.MIN_VALUE, Number(minValue) || 0);
    var maxV = Number(maxValue) || 0;
    if (!(maxV > minV) || minV <= 0) { return []; }
    var pixelSpan = Math.max(1, Number(arguments[4]) || 1);
    var targetPx = Math.max(1, Number(arguments[5]) || 72);
    var band = tickDistanceBand(targetPx, arguments[6], arguments[7]);
    var rawHints = Array.isArray(hints) && hints.length ? hints : [1, 2, 5];
    var cleanHints = [];
    for (var hi = 0; hi < rawHints.length; hi += 1) {
      var hv = Math.abs(Number(rawHints[hi]) || 0);
      if (hv > 0 && hv <= 5) { cleanHints.push(hv); }
    }
    if (!cleanHints.length) { cleanHints = [1, 2, 5]; }
    cleanHints.sort(function (a, b) { return a - b; });
    function mantissasForHint(hint) {
      var jump = Math.max(1.0, Number(hint) || 1.0);
      var values = [1.0];
      var cur = 1.0;
      if (jump > 1.0 && jump < 10.0) {
        cur = jump;
        if (cur <= 5.0) { values.push(cur); }
      }
      while (true) {
        var next = cur + jump;
        if (!(next < 10.0)) { break; }
        // Do not leave a smaller final gap to the next power of ten.
        if ((10.0 - next) < jump - 1e-9) { break; }
        if (next <= 5.0) { values.push(next); }
        cur = next;
      }
      return values;
    }

    var patternCandidates = [];
    for (var hi = 0; hi < cleanHints.length; hi += 1) {
      var h = cleanHints[hi];
      patternCandidates.push({ hint: h, mantissas: mantissasForHint(h) });
    }
    if (!patternCandidates.length) {
      patternCandidates = [{ hint: 5, mantissas: [1, 5] }];
    }
    var bestPattern = patternCandidates[patternCandidates.length - 1];
    var bestScore = Infinity;

    function ticksForPattern(pattern) {
      var values = [];
      var seen = Object.create(null);
      function addTick(v) {
        if (!(v > 0) || v < minV * (1 - 1e-6) || v > maxV * (1 + 1e-6)) { return; }
        var key = String(Number(v.toPrecision(12)));
        if (seen[key]) { return; }
        seen[key] = true;
        values.push(v);
      }
      var e0 = Math.floor(Math.log(minV) / Math.LN10) - 1;
      var e1 = Math.ceil(Math.log(maxV) / Math.LN10) + 1;
      var decadeStep = Math.max(1, Number(pattern.decadeStep) || 1);
      var firstE = Math.ceil((e0 - decadeStep * 1e-9) / decadeStep) * decadeStep;
      for (var e = firstE; e <= e1 && values.length < 10000; e += decadeStep) {
        var scale = Math.pow(10, e);
        addTick(scale);
        if (decadeStep === 1) {
          for (var mi = 0; mi < pattern.mantissas.length && values.length < 10000; mi += 1) {
            var v = pattern.mantissas[mi] * scale;
            addTick(v);
          }
        }
      }
      values.sort(function (a, b) { return a - b; });
      return values;
    }

    function avgPatternPixelDistance(pattern) {
      var values = [];
      var decadeStep = Math.max(1, Number(pattern.decadeStep) || 1);
      for (var e = 0; e <= 24 && values.length < 1000; e += decadeStep) {
        var scale = Math.pow(10, e);
        values.push(scale);
        if (decadeStep === 1) {
          for (var mi = 0; mi < pattern.mantissas.length; mi += 1) {
            values.push(pattern.mantissas[mi] * scale);
          }
        }
      }
      values.sort(function (a, b) { return a - b; });
      if (values.length < 2) { return Infinity; }
      var ratio = Math.max(1.000001, maxV / minV);
      var l0 = 0;
      var l1 = Math.log(ratio) / Math.LN10;
      var prev = (Math.log(values[0]) / Math.LN10 - l0) / Math.max(1e-12, l1 - l0) * pixelSpan;
      var total = 0;
      var count = 0;
      for (var i = 1; i < values.length; i += 1) {
        var cur = (Math.log(values[i]) / Math.LN10 - l0) / Math.max(1e-12, l1 - l0) * pixelSpan;
        total += Math.abs(cur - prev);
        count += 1;
        prev = cur;
      }
      return count ? total / count : Infinity;
    }

    var logRange = Math.max(0, Math.log(maxV / minV) / Math.LN10);
    var exponentSteps = [1];
    var stepSeen = { "1": true };
    var stepLimit = Math.max(1, Math.min(300, Math.ceil(logRange)));
    for (var dhi = 0; dhi < cleanHints.length; dhi += 1) {
      var baseStep = Math.max(1, Math.round(cleanHints[dhi]));
      var decadeScale = 1;
      var s = baseStep * decadeScale;
      while (s <= stepLimit) {
        var skey = String(s);
        if (!stepSeen[skey]) {
          stepSeen[skey] = true;
          exponentSteps.push(s);
        }
        if (decadeScale > stepLimit / 10) { break; }
        decadeScale *= 10;
        s = baseStep * decadeScale;
      }
    }
    exponentSteps.sort(function (a, b) { return a - b; });
    var expandedPatterns = [];
    for (var epi = 0; epi < exponentSteps.length; epi += 1) {
      for (var ppi = 0; ppi < patternCandidates.length; ppi += 1) {
        expandedPatterns.push({
          hint: patternCandidates[ppi].hint,
          mantissas: patternCandidates[ppi].mantissas,
          decadeStep: exponentSteps[epi],
        });
      }
    }

    for (var pi = 0; pi < expandedPatterns.length; pi += 1) {
      var candidate = ticksForPattern(expandedPatterns[pi]);
      if (!candidate.length) { continue; }
      var avgPx = avgPatternPixelDistance(expandedPatterns[pi]);
      var score = Math.abs(Math.log(Math.max(1e-9, avgPx) / targetPx));
      score = tickSpacingScore(avgPx, band);
      if (candidate.length === 1) {
        score += 3.0;
      }
      if (score < bestScore) {
        bestScore = score;
        bestPattern = expandedPatterns[pi];
      }
    }
    return ticksForPattern(bestPattern).slice(0, 1000);
  }

  function signedLogTickValues(minValue, maxValue, explicitValues, hints, pixelSpan, tickDist, minTickDist, maxTickDist) {
    var explicit = explicitAxisTicks(explicitValues);
    if (explicit) {
      var filtered = [];
      for (var ei = 0; ei < explicit.length; ei += 1) {
        if (explicit[ei] !== 0 && explicit[ei] >= minValue && explicit[ei] <= maxValue) {
          filtered.push(explicit[ei]);
        }
      }
      return filtered;
    }
    var out = [];
    var maxAbs = Math.max(Math.abs(Number(minValue) || 0), Math.abs(Number(maxValue) || 0));
    var crossingZeroMinAbs = maxAbs > 0 ? maxAbs / 1000 : 1;
    if (minValue < 0) {
      var negMinAbs = maxValue >= 0
        ? crossingZeroMinAbs
        : Math.max(Number.MIN_VALUE, Math.abs(maxValue));
      var negMaxAbs = Math.abs(minValue);
      var neg = positiveLogTickValues(negMinAbs, negMaxAbs, null, hints, pixelSpan, tickDist, minTickDist, maxTickDist);
      for (var ni = neg.length - 1; ni >= 0; ni -= 1) {
        var nv = -neg[ni];
        if (nv >= minValue && nv <= maxValue) { out.push(nv); }
      }
    }
    if (maxValue > 0) {
      var posMin = minValue <= 0
        ? crossingZeroMinAbs
        : Math.max(Number.MIN_VALUE, minValue);
      var pos = positiveLogTickValues(posMin, maxValue, null, hints, pixelSpan, tickDist, minTickDist, maxTickDist);
      for (var pi = 0; pi < pos.length; pi += 1) {
        if (pos[pi] >= minValue && pos[pi] <= maxValue) { out.push(pos[pi]); }
      }
    }
    return out;
  }

  function axisTickValuesForMode(minValue, maxValue, step, explicitValues, mode, signedLog, hints, pixelSpan, tickDist, minTickDist, maxTickDist) {
    if (isLogTickMode(mode)) {
      if (!signedLog && isSubDecadePositiveRange(minValue, maxValue)) {
        return axisTickValues(minValue, maxValue, step, explicitValues);
      }
      return signedLog
        ? signedLogTickValues(minValue, maxValue, explicitValues, hints, pixelSpan, tickDist, minTickDist, maxTickDist)
        : positiveLogTickValues(minValue, maxValue, explicitValues, hints, pixelSpan, tickDist, minTickDist, maxTickDist);
    }
    return axisTickValues(minValue, maxValue, step, explicitValues);
  }

  function axisTickValuesNoZeroForMode(minValue, maxValue, step, explicitValues, mode, signedLog, hints, pixelSpan, tickDist, minTickDist, maxTickDist) {
    if (isLogTickMode(mode)) {
      if (!signedLog && isSubDecadePositiveRange(minValue, maxValue)) {
        return axisTickValuesNoZero(minValue, maxValue, step, explicitValues);
      }
      return signedLog
        ? signedLogTickValues(minValue, maxValue, explicitValues, hints, pixelSpan, tickDist, minTickDist, maxTickDist)
        : positiveLogTickValues(minValue, maxValue, explicitValues, hints, pixelSpan, tickDist, minTickDist, maxTickDist);
    }
    return axisTickValuesNoZero(minValue, maxValue, step, explicitValues);
  }

  function axisTickLabelForMode(value, mode, minValue, maxValue) {
    return isLogTickMode(mode) ? formatLogAxisTickLabel(value, minValue, maxValue) : formatAxisTickLabel(value);
  }

  function axisValueToUnit(value, minValue, maxValue, mode) {
    var v = Number(value);
    var lo = Number(minValue);
    var hi = Number(maxValue);
    if (isLogTickMode(mode) && v > 0 && lo > 0 && hi > lo) {
      var l0 = Math.log(lo) / Math.LN10;
      var l1 = Math.log(hi) / Math.LN10;
      return ((Math.log(v) / Math.LN10) - l0) / Math.max(1e-12, l1 - l0);
    }
    return (v - lo) / Math.max(1e-12, hi - lo);
  }

  var LOG10_FLOAT_MIN = -307;
  var LOG10_FLOAT_MAX = 307;

  function clampLogSpan(l0, l1) {
    var a = Number(l0);
    var b = Number(l1);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return null;
    }
    if (b < a) {
      var t = a;
      a = b;
      b = t;
    }
    var span = b - a;
    var maxSpan = LOG10_FLOAT_MAX - LOG10_FLOAT_MIN;
    if (span >= maxSpan) {
      return [LOG10_FLOAT_MIN, LOG10_FLOAT_MAX];
    }
    if (a < LOG10_FLOAT_MIN) {
      b += LOG10_FLOAT_MIN - a;
      a = LOG10_FLOAT_MIN;
    }
    if (b > LOG10_FLOAT_MAX) {
      a -= b - LOG10_FLOAT_MAX;
      b = LOG10_FLOAT_MAX;
    }
    a = Math.max(LOG10_FLOAT_MIN, Math.min(LOG10_FLOAT_MAX, a));
    b = Math.max(LOG10_FLOAT_MIN, Math.min(LOG10_FLOAT_MAX, b));
    if (!(b > a)) { return null; }
    return [a, b];
  }

  function applyLogRange(cfg, axis, l0, l1) {
    var clamped = clampLogSpan(l0, l1);
    if (!clamped) { return false; }
    var lo = Math.pow(10, clamped[0]);
    var hi = Math.pow(10, clamped[1]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo) || lo <= 0) {
      return false;
    }
    cfg[axis + "_min"] = lo;
    cfg[axis + "_max"] = hi;
    return true;
  }

  var LINEAR_FLOAT_LIMIT = 1e300;

  function clampLinearSpan(a, b) {
    var lo = Number(a);
    var hi = Number(b);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      return null;
    }
    if (hi < lo) {
      var t = lo;
      lo = hi;
      hi = t;
    }
    var span = hi - lo;
    if (!Number.isFinite(span) || span >= LINEAR_FLOAT_LIMIT * 2) {
      return [-LINEAR_FLOAT_LIMIT, LINEAR_FLOAT_LIMIT];
    }
    if (lo < -LINEAR_FLOAT_LIMIT) {
      hi += -LINEAR_FLOAT_LIMIT - lo;
      lo = -LINEAR_FLOAT_LIMIT;
    }
    if (hi > LINEAR_FLOAT_LIMIT) {
      lo -= hi - LINEAR_FLOAT_LIMIT;
      hi = LINEAR_FLOAT_LIMIT;
    }
    lo = Math.max(-LINEAR_FLOAT_LIMIT, Math.min(LINEAR_FLOAT_LIMIT, lo));
    hi = Math.max(-LINEAR_FLOAT_LIMIT, Math.min(LINEAR_FLOAT_LIMIT, hi));
    if (!(hi > lo)) { return null; }
    return [lo, hi];
  }

  function applyLinearRange(cfg, axis, lo, hi) {
    var clamped = clampLinearSpan(lo, hi);
    if (!clamped) { return false; }
    cfg[axis + "_min"] = clamped[0];
    cfg[axis + "_max"] = clamped[1];
    return true;
  }

  function axisViewport(mesh, cfg, w, h) {
    var xMin = Number(cfg.x_min);
    var xMax = Number(cfg.x_max);
    var yMin = Number(cfg.y_min);
    var yMax = Number(cfg.y_max);
    if (!(xMax > xMin) || !(yMax > yMin)) { return null; }
    var cx = (xMin + xMax) * 0.5;
    var cy = (yMin + yMax) * 0.5;
    var xSpan = xMax - xMin;
    var ySpan = yMax - yMin;
    if (String(mesh.aspect || "").toLowerCase() === "equal") {
      if (w >= h) {
        xSpan = xSpan * (w / Math.max(1, h));
      } else {
        ySpan = ySpan * (h / Math.max(1, w));
      }
    }
    var vx0 = cx - xSpan * 0.5;
    var vx1 = cx + xSpan * 0.5;
    var vy0 = cy - ySpan * 0.5;
    var vy1 = cy + ySpan * 0.5;
    return {
      vx0: vx0,
      vx1: vx1,
      vy0: vy0,
      vy1: vy1,
      dataToX: function (x) { return ((x - vx0) / Math.max(1e-12, vx1 - vx0)) * w; },
      dataToY: function (y) { return h - (((y - vy0) / Math.max(1e-12, vy1 - vy0)) * h); }
    };
  }

  function axisBoxRect(mesh, w, h) {
    if (!mesh || mesh.axis_box !== true) {
      return { left: 0, top: 0, right: w, bottom: h, width: w, height: h };
    }
    var m = Math.max(0, Number(mesh.axis_margin_px) || 42);
    var leftMargin = m;
    var rightMargin = m;
    var topMargin = m;
    var bottomMargin = m;
    var cfg = mesh.axis_ticks || null;
    if (cfg && cfg.enabled !== false) {
      var tickLen = Math.max(0, Number(cfg.len) || 7);
      var fontSize = Number(cfg.tick_label_font_size) || 11;
      var labelFontSize = Number(cfg.label_font_size) || 13;
      var labelAxisPad = Math.max(0, Number(cfg.label_axis_pad) || 34);
      var approxW = Math.max(1, w - 2 * m);
      var approxH = Math.max(1, h - 2 * m);
      var xMin = Number(cfg.x_min);
      var xMax = Number(cfg.x_max);
      var yMin = Number(cfg.y_min);
      var yMax = Number(cfg.y_max);
      if (xMax > xMin) {
        var xStep = chooseAxisTickStep((xMax - xMin) / approxW, cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
        xStep = chooseReadableLinearTickStep(xMin, xMax, xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, approxW, cfg.dist, cfg.min_dist, cfg.max_dist, cfg.tick_label_font_size);
        var xs = axisTickValuesForMode(xMin, xMax, xStep, cfg.x_ticks, cfg.x_mode, false, cfg.hints, approxW, cfg.dist, cfg.min_dist, cfg.max_dist);
        var xOffsetValue = axisLabelOffset(xs, xMin, xMax);
        var xOffsetWidth = xOffsetValue ? estimateTickLabelWidthPx(formatOffsetLabel(xOffsetValue), fontSize) : 0;
        bottomMargin = Math.max(bottomMargin, tickLen + 10 + fontSize + labelAxisPad + labelFontSize);
        rightMargin = Math.max(rightMargin, xOffsetWidth + 8);
      }
      if (yMax > yMin) {
        var yStep = chooseAxisTickStep((yMax - yMin) / approxH, cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
        var ys = axisTickValuesForMode(yMin, yMax, yStep, cfg.y_ticks, cfg.y_mode, false, cfg.hints, approxH, cfg.dist, cfg.min_dist, cfg.max_dist);
        var yOffsetValue = axisLabelOffset(ys, yMin, yMax);
        var yLabelWidth = maxEstimatedTickLabelWidthPx(ys, cfg.y_mode, yMin, yMax, yOffsetValue, yStep, fontSize);
        var yOffsetWidth = yOffsetValue ? estimateTickLabelWidthPx(formatOffsetLabel(yOffsetValue), fontSize) : 0;
        var yLabelGap = Math.max(8, Math.min(14, labelAxisPad));
        var yNeed = tickLen + 8 + Math.max(yLabelWidth, yOffsetWidth) + yLabelGap + (cfg.y_label ? labelFontSize : 0);
        if (String(cfg.y_tick_label_placement || "left").toLowerCase() === "right") {
          rightMargin = Math.max(rightMargin, yNeed);
        } else {
          leftMargin = Math.max(leftMargin, yNeed);
        }
        topMargin = Math.max(topMargin, fontSize + 12);
      }
    }
    var left = Math.min(w - 1, Math.max(0, leftMargin));
    var top = Math.min(h - 1, Math.max(0, topMargin));
    var right = Math.max(left + 1, w - Math.max(0, rightMargin));
    var bottom = Math.max(top + 1, h - Math.max(0, bottomMargin));
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  }

  function drawSimple2DMarkerLineMeshes(fid, frameEl, meshes) {
    var body = geomFrameHost(frameEl, fid);
    var canvas = body ? body.querySelector("canvas.vf-frame__draw-canvas") : null;
    if (!canvas) { return false; }
    var sz = syncCanvasSize(canvas);
    if (!sz || !sz.w || !sz.h) { return false; }
    var ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) { return false; }
    var w = canvas.width || sz.w;
    var h = canvas.height || sz.h;
    ctx.clearRect(0, 0, w, h);

    function toPx(x, y, aspect) {
      var px, py;
      if (String(aspect || "").toLowerCase() === "equal") {
        var s = Math.min(w, h) * 0.5;
        px = (w * 0.5) + (Number(x) || 0) * s;
        py = (h * 0.5) - (Number(y) || 0) * s;
      } else {
        px = ((Number(x) || 0) + 1.0) * 0.5 * w;
        py = (1.0 - ((Number(y) || 0) + 1.0) * 0.5) * h;
      }
      return [px, py];
    }

    function drawAxisTicks(mesh) {
      var cfg = mesh.axis_ticks || null;
      if (!cfg || cfg.enabled === false) { return; }
      if (mesh.axis_box === true) {
        drawAxisBoxTicks(mesh);
        return;
      }
      var xMin = Number(cfg.x_min);
      var xMax = Number(cfg.x_max);
      var yMin = Number(cfg.y_min);
      var yMax = Number(cfg.y_max);
      if (!(xMax > xMin) || !(yMax > yMin)) { return; }
      var view = axisViewport(mesh, cfg, w, h);
      if (!view) { return; }
      var vx0 = view.vx0, vx1 = view.vx1, vy0 = view.vy0, vy1 = view.vy1;
      var dataToX = view.dataToX;
      var dataToY = view.dataToY;
      var yAxisPx = dataToY(0);
      var xAxisPx = dataToX(0);
      var tickLen = Math.max(0, Number(cfg.len) || 7);
      var xAlign = String(cfg.x_alignment || "center").toLowerCase();
      var yAlign = String(cfg.y_alignment || "center").toLowerCase();

      function tickOffsets(align, negativeName, positiveName) {
        if (align === negativeName) { return [-tickLen, 0]; }
        if (align === positiveName) { return [0, tickLen]; }
        return [-tickLen * 0.5, tickLen * 0.5];
      }

      var xStep = chooseAxisTickStep((vx1 - vx0) / Math.max(1, w), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
      xStep = chooseReadableLinearTickStep(vx0, vx1, xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, w, cfg.dist, cfg.min_dist, cfg.max_dist, cfg.tick_label_font_size);
      var yStep = chooseAxisTickStep((vy1 - vy0) / Math.max(1, h), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
      if (yAxisPx >= -tickLen && yAxisPx <= h + tickLen && xStep > 0) {
        var xo = tickOffsets(xAlign, "top", "bottom");
        var xs = axisTickValuesNoZeroForMode(vx0, vx1, xStep, cfg.x_ticks, cfg.x_mode, true, cfg.hints, w, cfg.dist, cfg.min_dist, cfg.max_dist);
        for (var xi = 0; xi < xs.length; xi += 1) {
          var xv = xs[xi];
          var xp = dataToX(xv);
          ctx.moveTo(xp, yAxisPx + xo[0]);
          ctx.lineTo(xp, yAxisPx + xo[1]);
        }
      }
      if (xAxisPx >= -tickLen && xAxisPx <= w + tickLen && yStep > 0) {
        var yo = tickOffsets(yAlign, "left", "right");
        var ys = axisTickValuesNoZeroForMode(vy0, vy1, yStep, cfg.y_ticks, cfg.y_mode, true, cfg.hints, h, cfg.dist, cfg.min_dist, cfg.max_dist);
        for (var yi = 0; yi < ys.length; yi += 1) {
          var yv = ys[yi];
          var yp = dataToY(yv);
          ctx.moveTo(xAxisPx + yo[0], yp);
          ctx.lineTo(xAxisPx + yo[1], yp);
        }
      }
    }

    function drawAxisBoxTicks(mesh) {
      var cfg = mesh.axis_ticks || null;
      var box = axisBoxRect(mesh, w, h);
      var xStep = chooseAxisTickStep((Number(cfg.x_max) - Number(cfg.x_min)) / Math.max(1, box.width), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
      xStep = chooseReadableLinearTickStep(Number(cfg.x_min), Number(cfg.x_max), xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, box.width, cfg.dist, cfg.min_dist, cfg.max_dist, cfg.tick_label_font_size);
      var yStep = chooseAxisTickStep((Number(cfg.y_max) - Number(cfg.y_min)) / Math.max(1, box.height), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
      var tickLen = Math.max(0, Number(cfg.len) || 7);
      var xAlign = String(cfg.x_alignment || "center").toLowerCase();
      var yAlign = String(cfg.y_alignment || "center").toLowerCase();
      var dataToX = function (x) { return box.left + axisValueToUnit(x, cfg.x_min, cfg.x_max, cfg.x_mode) * box.width; };
      var dataToY = function (y) { return box.bottom - axisValueToUnit(y, cfg.y_min, cfg.y_max, cfg.y_mode) * box.height; };

      function tickOffsets(align, insideName, outsideName) {
        if (align === insideName) { return [-tickLen, 0]; }
        if (align === outsideName) { return [0, tickLen]; }
        return [-tickLen * 0.5, tickLen * 0.5];
      }

      var xo = tickOffsets(xAlign, "top", "bottom");
      var xs = axisTickValuesForMode(Number(cfg.x_min), Number(cfg.x_max), xStep, cfg.x_ticks, cfg.x_mode, false, cfg.hints, box.width, cfg.dist, cfg.min_dist, cfg.max_dist);
      for (var xi = 0; xi < xs.length; xi += 1) {
        var xp = dataToX(xs[xi]);
        ctx.moveTo(xp, box.bottom + xo[0]);
        ctx.lineTo(xp, box.bottom + xo[1]);
      }
      var yo = tickOffsets(yAlign, "right", "left");
      var ys = axisTickValuesForMode(Number(cfg.y_min), Number(cfg.y_max), yStep, cfg.y_ticks, cfg.y_mode, false, cfg.hints, box.height, cfg.dist, cfg.min_dist, cfg.max_dist);
      for (var yi = 0; yi < ys.length; yi += 1) {
        var yp = dataToY(ys[yi]);
        ctx.moveTo(box.left + yo[0], yp);
        ctx.lineTo(box.left + yo[1], yp);
      }
    }

    function drawAxisGrid(mesh, baseColor) {
      var cfg = mesh.axis_ticks || null;
      if (!cfg || cfg.enabled === false || cfg.grid !== true) { return; }
      if (mesh.axis_box === true) {
        drawAxisBoxGrid(mesh);
        return;
      }
      var view = axisViewport(mesh, cfg, w, h);
      if (!view) { return; }
      var xStep = chooseAxisTickStep((view.vx1 - view.vx0) / Math.max(1, w), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
      xStep = chooseReadableLinearTickStep(view.vx0, view.vx1, xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, w, cfg.dist, cfg.min_dist, cfg.max_dist, cfg.tick_label_font_size);
      var yStep = chooseAxisTickStep((view.vy1 - view.vy0) / Math.max(1, h), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
      var alpha = Math.max(0, Math.min(1, Number(cfg.grid_alpha) || 0.18));
      var gridColor = parseRuntimeColor(cfg.grid_color || mesh.color || "white");
      ctx.save();
      ctx.strokeStyle = "rgba(" +
        Math.round(gridColor[0] * 255) + "," +
        Math.round(gridColor[1] * 255) + "," +
        Math.round(gridColor[2] * 255) + "," +
        Math.max(0, Math.min(1, gridColor[3] * alpha)) + ")";
      ctx.lineWidth = Math.max(0.5, Number(cfg.grid_width) || 1);
      ctx.beginPath();
      var xs = axisTickValuesNoZeroForMode(view.vx0, view.vx1, xStep, cfg.x_ticks, cfg.x_mode, true, cfg.hints, w, cfg.dist, cfg.min_dist, cfg.max_dist);
      for (var xi = 0; xi < xs.length; xi += 1) {
        var xp = view.dataToX(xs[xi]);
        ctx.moveTo(xp, 0);
        ctx.lineTo(xp, h);
      }
      var ys = axisTickValuesNoZeroForMode(view.vy0, view.vy1, yStep, cfg.y_ticks, cfg.y_mode, true, cfg.hints, h, cfg.dist, cfg.min_dist, cfg.max_dist);
      for (var yi = 0; yi < ys.length; yi += 1) {
        var yp = view.dataToY(ys[yi]);
        ctx.moveTo(0, yp);
        ctx.lineTo(w, yp);
      }
      ctx.stroke();
      ctx.restore();
      void baseColor;
    }

    function drawAxisBoxGrid(mesh) {
      var cfg = mesh.axis_ticks || null;
      var box = axisBoxRect(mesh, w, h);
      var xStep = chooseAxisTickStep((Number(cfg.x_max) - Number(cfg.x_min)) / Math.max(1, box.width), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
      xStep = chooseReadableLinearTickStep(Number(cfg.x_min), Number(cfg.x_max), xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, box.width, cfg.dist, cfg.min_dist, cfg.max_dist, cfg.tick_label_font_size);
      var yStep = chooseAxisTickStep((Number(cfg.y_max) - Number(cfg.y_min)) / Math.max(1, box.height), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
      var alpha = Math.max(0, Math.min(1, Number(cfg.grid_alpha) || 0.18));
      var gridColor = parseRuntimeColor(cfg.grid_color || mesh.color || "white");
      var dataToX = function (x) { return box.left + axisValueToUnit(x, cfg.x_min, cfg.x_max, cfg.x_mode) * box.width; };
      var dataToY = function (y) { return box.bottom - axisValueToUnit(y, cfg.y_min, cfg.y_max, cfg.y_mode) * box.height; };
      ctx.save();
      ctx.strokeStyle = "rgba(" +
        Math.round(gridColor[0] * 255) + "," +
        Math.round(gridColor[1] * 255) + "," +
        Math.round(gridColor[2] * 255) + "," +
        Math.max(0, Math.min(1, gridColor[3] * alpha)) + ")";
      ctx.lineWidth = Math.max(0.5, Number(cfg.grid_width) || 1);
      ctx.beginPath();
      var xs = axisTickValuesForMode(Number(cfg.x_min), Number(cfg.x_max), xStep, cfg.x_ticks, cfg.x_mode, false, cfg.hints, box.width, cfg.dist, cfg.min_dist, cfg.max_dist);
      for (var xi = 0; xi < xs.length; xi += 1) {
        var xp = dataToX(xs[xi]);
        ctx.moveTo(xp, box.top);
        ctx.lineTo(xp, box.bottom);
      }
      var ys = axisTickValuesForMode(Number(cfg.y_min), Number(cfg.y_max), yStep, cfg.y_ticks, cfg.y_mode, false, cfg.hints, box.height, cfg.dist, cfg.min_dist, cfg.max_dist);
      for (var yi = 0; yi < ys.length; yi += 1) {
        var yp = dataToY(ys[yi]);
        ctx.moveTo(box.left, yp);
        ctx.lineTo(box.right, yp);
      }
      ctx.stroke();
      ctx.restore();
    }

    function drawAxisBoxFrame(mesh) {
      if (mesh.axis_box !== true) { return false; }
      var box = axisBoxRect(mesh, w, h);
      ctx.moveTo(box.left, box.bottom);
      ctx.lineTo(box.right, box.bottom);
      ctx.lineTo(box.right, box.top);
      ctx.lineTo(box.left, box.top);
      ctx.lineTo(box.left, box.bottom);
      return true;
    }

    function drawAxisFullFrameLines(mesh) {
      var cfg = mesh.axis_ticks || null;
      var view = cfg ? axisViewport(mesh, cfg, w, h) : null;
      if (!view) { return false; }
      var yAxisPx = view.dataToY(0);
      var xAxisPx = view.dataToX(0);
      if (yAxisPx >= 0 && yAxisPx <= h) {
        ctx.moveTo(0, yAxisPx);
        ctx.lineTo(w, yAxisPx);
      }
      if (xAxisPx >= 0 && xAxisPx <= w) {
        ctx.moveTo(xAxisPx, 0);
        ctx.lineTo(xAxisPx, h);
      }
      return true;
    }

    for (var m = 0; m < meshes.length; m += 1) {
      var mesh = meshes[m];
      var color = parseRuntimeColor(mesh.color || "white");
      ctx.save();
      ctx.strokeStyle = "rgba(" +
        Math.round(color[0] * 255) + "," +
        Math.round(color[1] * 255) + "," +
        Math.round(color[2] * 255) + "," +
        Math.max(0, Math.min(1, color[3])) + ")";
      ctx.lineWidth = Math.max(0.5, Number(mesh.edge_width || 1));
      ctx.lineCap = "butt";
      ctx.lineJoin = "miter";
      drawAxisGrid(mesh, color);
      ctx.beginPath();
      if (!(mesh.axis_box === true && drawAxisBoxFrame(mesh)) && !(mesh.axis_full_frame === true && drawAxisFullFrameLines(mesh))) {
        for (var i = 0; i + 1 < mesh.indices.length; i += 2) {
          var ia = Number(mesh.indices[i]) || 0;
          var ib = Number(mesh.indices[i + 1]) || 0;
          var ao = ia * 10;
          var bo = ib * 10;
          if (ao + 1 >= mesh.vertices.length || bo + 1 >= mesh.vertices.length) { continue; }
          var a = toPx(mesh.vertices[ao], mesh.vertices[ao + 1], mesh.aspect);
          var b = toPx(mesh.vertices[bo], mesh.vertices[bo + 1], mesh.aspect);
          if (mesh.axis_full_frame === true) {
            if (Math.abs(a[1] - b[1]) <= 1e-6) {
              a[0] = 0;
              b[0] = w;
            } else if (Math.abs(a[0] - b[0]) <= 1e-6) {
              a[1] = 0;
              b[1] = h;
            }
          }
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
        }
      }
      drawAxisTicks(mesh);
      ctx.stroke();
      ctx.restore();
    }
    return true;
  }

  function ensureGeomTextOverlay(frameEl, fid) {
    var doc = frameEl && frameEl.ownerDocument || document;
    var root = doc && doc.body ? doc.body : geomFrameHost(frameEl, fid);
    if (!root) { return null; }
    var layer = null;
    var existing = root.querySelectorAll ? root.querySelectorAll(".vf-geom-text-overlay") : [];
    for (var li = 0; li < existing.length; li += 1) {
      if (String(existing[li].dataset && existing[li].dataset.vfGeomTextFid || "") === String(fid)) {
        layer = existing[li];
        break;
      }
    }
    if (!layer) {
      layer = doc.createElement("div");
      layer.className = "vf-geom-text-overlay";
      layer.dataset.vfGeomTextFid = String(fid);
      layer.style.position = "fixed";
      layer.style.zIndex = "2147483000";
      layer.style.pointerEvents = "none";
      layer.style.overflow = "hidden";
      root.appendChild(layer);
    }
    if (!layer.__vfGeomTextContent) {
      var content = doc.createElement("div");
      content.className = "vf-geom-text-overlay__content";
      content.style.position = "absolute";
      content.style.left = "0";
      content.style.top = "0";
      content.style.width = "100%";
      content.style.height = "100%";
      content.style.pointerEvents = "none";
      content.style.overflow = "visible";
      content.style.willChange = "transform";
      while (layer.firstChild) {
        content.appendChild(layer.firstChild);
      }
      layer.appendChild(content);
      layer.__vfGeomTextContent = content;
    }
    return layer;
  }

  function axisScreenInsetPx(spec) {
    if (!spec || spec.axis_screen_inset_px == null) { return 20; }
    var value = Number(spec.axis_screen_inset_px);
    return Number.isFinite(value) ? Math.max(0, value) : 20;
  }

  function rememberGeomTextOverlay(fid, layer, frameEl, geomSpec, w, h) {
    if (!layer || !frameEl) { return; }
    _geomTextFollow[String(fid)] = {
      layer: layer,
      frameEl: frameEl,
      geomSpec: geomSpec,
      w: Math.max(1, Math.round(Number(w) || 1)),
      h: Math.max(1, Math.round(Number(h) || 1))
    };
    ensureGeomTextFollowLoop();
  }

  function updateGeomTextOverlayRect(fid) {
    var rec = _geomTextFollow[String(fid)];
    if (!rec || !rec.layer || !rec.frameEl) { delete _geomTextFollow[String(fid)]; return; }
    var fit = fittedFrameContentRect(rec.frameEl, geomFrameHost(rec.frameEl, fid));
    var w = Math.max(1, Math.round(fit.width || 1));
    var h = Math.max(1, Math.round(fit.height || 1));
    rec.layer.style.left = Math.round(fit.left || 0) + "px";
    rec.layer.style.top = Math.round(fit.top || 0) + "px";
    rec.layer.style.width = w + "px";
    rec.layer.style.height = h + "px";
    if (rec.w !== w || rec.h !== h) {
      rec.w = w;
      rec.h = h;
      renderGeomTextOverlay(fid, rec.frameEl, rec.geomSpec);
    }
  }

  function ensureGeomTextFollowLoop() {
    if (_geomTextFollowRaf || typeof global.requestAnimationFrame !== "function") { return; }
    var tick = function () {
      _geomTextFollowRaf = 0;
      var any = false;
      for (var fid in _geomTextFollow) {
        if (!Object.prototype.hasOwnProperty.call(_geomTextFollow, fid)) { continue; }
        any = true;
        updateGeomTextOverlayRect(fid);
      }
      if (any) { _geomTextFollowRaf = global.requestAnimationFrame(tick); }
    };
    _geomTextFollowRaf = global.requestAnimationFrame(tick);
  }

  function ensureGeomLineOverlay(frameEl, fid) {
    var body = geomFrameHost(frameEl, fid);
    if (!body) { return null; }
    if (global.getComputedStyle && global.getComputedStyle(body).position === "static") {
      body.style.position = "relative";
    }
    var canvas = body.querySelector(":scope > canvas.vf-geom-line-overlay");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "vf-geom-line-overlay";
      canvas.style.position = "absolute";
      canvas.style.inset = "0";
      canvas.style.zIndex = "45";
      canvas.style.pointerEvents = "none";
      canvas.style.background = "transparent";
      body.appendChild(canvas);
    }
    return canvas;
  }

  function projectWorldToPixel(camera, w, h, point) {
    if (!camera || !Array.isArray(camera.pos) || !Array.isArray(camera.target)) { return null; }
    var view = Array.isArray(camera.view_matrix) && camera.view_matrix.length === 16
      ? camera.view_matrix
      : lookAtMatrixLocal(camera.pos, camera.target, camera.up || [0, 1, 0]);
    var proj = cameraProjectionMatrixLocal(camera, Math.max(1e-6, w / Math.max(1, h)));
    var clip = projectWorldToClipLocal(mat4MulLocal(proj, view), point);
    if (!(clip && Math.abs(clip[3]) > 1e-9)) { return null; }
    var ndcX = clip[0] / clip[3];
    var ndcY = clip[1] / clip[3];
    if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) { return null; }
    return [(ndcX + 1.0) * 0.5 * w, (1.0 - (ndcY + 1.0) * 0.5) * h];
  }

  function clipPixelLineToRect(a, b, left, top, right, bottom) {
    var ax = a[0], ay = a[1], bx = b[0], by = b[1];
    var dx = bx - ax, dy = by - ay;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) { return null; }
    var t0 = -Infinity;
    var t1 = Infinity;
    function clip(p, q) {
      if (Math.abs(p) < 1e-12) { return q >= 0; }
      var r = q / p;
      if (p < 0) {
        if (r > t1) { return false; }
        if (r > t0) { t0 = r; }
      } else {
        if (r < t0) { return false; }
        if (r < t1) { t1 = r; }
      }
      return true;
    }
    if (!clip(-dx, ax - left)) { return null; }
    if (!clip(dx, right - ax)) { return null; }
    if (!clip(-dy, ay - top)) { return null; }
    if (!clip(dy, bottom - ay)) { return null; }
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || !(t1 > t0)) { return null; }
    return [
      [ax + dx * t0, ay + dy * t0],
      [ax + dx * t1, ay + dy * t1]
    ];
  }

  function renderGeomLineOverlay(fid, frameEl, geomSpec, w, h) {
    var canvas = ensureGeomLineOverlay(frameEl, fid);
    if (!canvas) { return; }
    canvas.width = Math.max(1, Math.round(w));
    canvas.height = Math.max(1, Math.round(h));
    canvas.style.width = Math.max(1, Math.round(w)) + "px";
    canvas.style.height = Math.max(1, Math.round(h)) + "px";
    var ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) { return; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var camera = geomSpec && geomSpec.camera || null;
    var meshes = geomSpec && Array.isArray(geomSpec.meshes) ? geomSpec.meshes : [];
    if (geomSpec && geomSpec.axis3d_runtime && camera && Array.isArray(camera.pos) && Array.isArray(camera.target)) {
      var cfg = geomSpec.axis3d_runtime || {};
      var cam = Object.assign({}, camera, {
        viewport_width_px: w,
        viewport_height_px: h
      });
      var target = [0, 0, 0];
      var p0 = projectWorldToPixel(cam, w, h, target);
      var rec3 = frameRecs[String(fid)] || null;
      var color3 = parseRuntimeColor(cfg.color || "white");
      if (p0) {
        ctx.save();
        ctx.strokeStyle = "rgba(" + Math.round(color3[0] * 255) + "," + Math.round(color3[1] * 255) + "," + Math.round(color3[2] * 255) + "," + Math.max(0, Math.min(1, color3[3])) + ")";
        ctx.lineWidth = Math.max(0.5, Number(cfg.width || (meshes[0] && meshes[0].edge_width) || 1));
        ctx.beginPath();
        var reach = Math.max(w, h) * 4.0;
        var axisInfos = [];
        function axisLineInfo(axisIndex) {
          var next = target.slice();
          next[axisIndex] += 1;
          var p1 = projectWorldToPixel(cam, w, h, next);
          if (!p1) { return null; }
          var dx = p1[0] - p0[0];
          var dy = p1[1] - p0[1];
          var len = Math.sqrt((dx * dx) + (dy * dy));
          if (!(len > 1e-6)) { return null; }
          var clipped = clipPixelLineToRect(
            [p0[0] - (dx / len) * reach, p0[1] - (dy / len) * reach],
            [p0[0] + (dx / len) * reach, p0[1] + (dy / len) * reach],
            0,
            0,
            w,
            h
          );
          if (!clipped) { return null; }
          return {
            axisIndex: axisIndex,
            len: len,
            ux: dx / len,
            uy: dy / len,
            clipped: clipped,
            centerValue: Number(target[axisIndex]) || 0
          };
        }
        function drawAxisLine(axisIndex) {
          var info = axisLineInfo(axisIndex);
          axisInfos[axisIndex] = info;
          if (!info) { return; }
          var clipped = info.clipped;
          ctx.moveTo(clipped[0][0], clipped[0][1]);
          ctx.lineTo(clipped[1][0], clipped[1][1]);
        }
        drawAxisLine(0);
        drawAxisLine(1);
        drawAxisLine(2);
        ctx.stroke();
        if (cfg.ticks !== false) {
          var recKey = cameraRevisionKey(Object.assign({}, cam, { target: [0, 0, 0] })) + ":w" + w + ":h" + h;
          if (!rec3) {
            rec3 = frameRecs[String(fid)] = frameRecs[String(fid)] || { entries: [] };
          }
          if (!rec3.axis3DHelperTickCache || rec3.axis3DHelperTickCache.key !== recKey) {
            var tickAxes = [];
            for (var ai = 0; ai < axisInfos.length; ai += 1) {
              var infoForTicks = axisInfos[ai];
              if (!infoForTicks) { tickAxes[ai] = { step: 1 }; continue; }
              var c0 = infoForTicks.clipped[0];
              var c1 = infoForTicks.clipped[1];
              var d0 = (((c0[0] - p0[0]) * infoForTicks.ux) + ((c0[1] - p0[1]) * infoForTicks.uy)) / infoForTicks.len;
              var d1 = (((c1[0] - p0[0]) * infoForTicks.ux) + ((c1[1] - p0[1]) * infoForTicks.uy)) / infoForTicks.len;
              var lo = infoForTicks.centerValue + Math.min(d0, d1);
              var hi = infoForTicks.centerValue + Math.max(d0, d1);
              var pixelSpan = Math.sqrt(Math.pow(c1[0] - c0[0], 2) + Math.pow(c1[1] - c0[1], 2));
              var dataPerPixel = 1 / Math.max(1e-9, infoForTicks.len);
              var hints = Array.isArray(cfg.tick_hints) && cfg.tick_hints.length ? cfg.tick_hints : [1, 2, 5];
              var step = chooseAxisTickStep(
                dataPerPixel,
                Number(cfg.tick_dist) || 120,
                hints,
                Number(cfg.min_tick_dist) || 72,
                Number(cfg.max_tick_dist) || 180
              );
              step = chooseReadableLinearTickStep(
                lo,
                hi,
                step,
                null,
                "linear",
                hints,
                pixelSpan,
                Number(cfg.tick_dist) || 120,
                Number(cfg.min_tick_dist) || 72,
                Number(cfg.max_tick_dist) || 180,
                Number(cfg.tick_label_font_size) || 11
              );
              tickAxes[ai] = { step: step };
            }
            rec3.axis3DHelperTickCache = { key: recKey, axes: tickAxes };
          }
          var tickLenPx = Math.max(3, Number(cfg.tick_len_px) || 7);
          var tickLabelSpecs = [];
          function tickLabelText(v) {
            var s = Math.abs(v) < 1e-10 ? "0" : Number(v).toPrecision(12).replace(/\.?0+$/, "");
            return "$" + s + "$";
          }
          ctx.beginPath();
          for (var ti = 0; ti < axisInfos.length; ti += 1) {
            var tickInfo = axisInfos[ti];
            var tickAxis = rec3.axis3DHelperTickCache && rec3.axis3DHelperTickCache.axes ? rec3.axis3DHelperTickCache.axes[ti] : null;
            if (!tickInfo || !tickAxis || !(Number(tickAxis.step) > 0)) { continue; }
            var tc0 = tickInfo.clipped[0];
            var tc1 = tickInfo.clipped[1];
            var td0 = (((tc0[0] - p0[0]) * tickInfo.ux) + ((tc0[1] - p0[1]) * tickInfo.uy)) / tickInfo.len;
            var td1 = (((tc1[0] - p0[0]) * tickInfo.ux) + ((tc1[1] - p0[1]) * tickInfo.uy)) / tickInfo.len;
            var tlo = tickInfo.centerValue + Math.min(td0, td1);
            var thi = tickInfo.centerValue + Math.max(td0, td1);
            var tickValues = axis3DZeroAnchoredTickValues(tlo, thi, tickAxis.step).filter(function (v) { return Math.abs(v) > 1e-10; });
            var nx = -tickInfo.uy;
            var ny = tickInfo.ux;
            var alignKey = ti === 0 ? "x_tick_alignment" : ti === 1 ? "y_tick_alignment" : "z_tick_alignment";
            var align = String(cfg[alignKey] || "negative").toLowerCase();
            var side = align === "positive" ? 1 : align === "center" || align === "centre" ? 0 : -1;
            for (var vi = 0; vi < tickValues.length; vi += 1) {
              var v = Number(tickValues[vi]);
              var scalar = (v - tickInfo.centerValue) * tickInfo.len;
              var px = p0[0] + tickInfo.ux * scalar;
              var py = p0[1] + tickInfo.uy * scalar;
              if (px < -tickLenPx || px > w + tickLenPx || py < -tickLenPx || py > h + tickLenPx) { continue; }
              if (side === 0) {
                ctx.moveTo(px - nx * tickLenPx * 0.5, py - ny * tickLenPx * 0.5);
                ctx.lineTo(px + nx * tickLenPx * 0.5, py + ny * tickLenPx * 0.5);
                tickLabelSpecs.push({
                  pixel: true,
                  x: px + nx * (tickLenPx * 0.5 + 5),
                  y: py + ny * (tickLenPx * 0.5 + 5),
                  text: tickLabelText(v),
                  font_size: Number(cfg.tick_label_font_size) || 11,
                  ha: "center",
                  va: "center",
                  color: cfg.color || "white"
                });
              } else {
                ctx.moveTo(px, py);
                ctx.lineTo(px + nx * tickLenPx * side, py + ny * tickLenPx * side);
                tickLabelSpecs.push({
                  pixel: true,
                  x: px + nx * side * (tickLenPx + 5),
                  y: py + ny * side * (tickLenPx + 5),
                  text: tickLabelText(v),
                  font_size: Number(cfg.tick_label_font_size) || 11,
                  ha: "center",
                  va: "center",
                  color: cfg.color || "white"
                });
              }
            }
          }
          ctx.stroke();
          geomSpec.texts = tickLabelSpecs;
        }
        ctx.restore();
      }
    }
    for (var mi = 0; mi < meshes.length; mi += 1) {
      var mesh = meshes[mi] || {};
      if (mesh.axis3d_helper_lines === true) { continue; }
      if (mesh.axis_screen_extend !== true || mesh.mode3d === false || String(mesh.topology || "") !== "line-list") { continue; }
      var verts = mesh.vertices || [];
      var inds = mesh.indices || [];
      var color = parseRuntimeColor(mesh.color || "white");
      ctx.save();
      ctx.strokeStyle = "rgba(" + Math.round(color[0] * 255) + "," + Math.round(color[1] * 255) + "," + Math.round(color[2] * 255) + "," + Math.max(0, Math.min(1, color[3])) + ")";
      ctx.lineWidth = Math.max(0.5, Number(mesh.edge_width || 1));
      ctx.beginPath();
      var inset = axisScreenInsetPx(mesh);
      for (var ii = 0; ii + 1 < inds.length; ii += 2) {
        var ai = Number(inds[ii]) * 10;
        var bi = Number(inds[ii + 1]) * 10;
        if (ai + 2 >= verts.length || bi + 2 >= verts.length) { continue; }
        var pa = projectWorldToPixel(camera, w, h, [Number(verts[ai] || 0), Number(verts[ai + 1] || 0), Number(verts[ai + 2] || 0)]);
        var pb = projectWorldToPixel(camera, w, h, [Number(verts[bi] || 0), Number(verts[bi + 1] || 0), Number(verts[bi + 2] || 0)]);
        if (!pa || !pb) { continue; }
        var clipped = clipPixelLineToRect(pa, pb, inset, inset, w - inset, h - inset);
        if (!clipped) { continue; }
        ctx.moveTo(clipped[0][0], clipped[0][1]);
        ctx.lineTo(clipped[1][0], clipped[1][1]);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  function renderMathText(el, raw) {
    el.innerHTML = "";
    var s = raw != null ? String(raw) : "";
    if (!s) { return; }
    var katex = typeof global !== "undefined" ? global.katex : null;
    if (!katex || s.indexOf("$") < 0) {
      el.textContent = s;
      return;
    }
    if (_mathTextHtmlCache[s] != null) {
      el.innerHTML = _mathTextHtmlCache[s];
      return;
    }
    var scratch = document.createElement("span");
    var i = 0;
    while (i < s.length) {
      var start = s.indexOf("$", i);
      if (start < 0) {
        scratch.appendChild(document.createTextNode(s.slice(i)));
        break;
      }
      if (start > i) {
        scratch.appendChild(document.createTextNode(s.slice(i, start)));
      }
      var display = s.slice(start, start + 2) === "$$";
      var marker = display ? "$$" : "$";
      var bodyStart = start + marker.length;
      var end = s.indexOf(marker, bodyStart);
      if (end < 0) {
        scratch.appendChild(document.createTextNode(s.slice(start)));
        break;
      }
      var span = document.createElement("span");
      span.className = display ? "vf-geom-text-math vf-geom-text-math-display" : "vf-geom-text-math";
      try {
        span.innerHTML = katex.renderToString(String(s.slice(bodyStart, end) || "").trim(), {
          displayMode: display,
          throwOnError: false
        });
      } catch (_) {
        span.textContent = marker + s.slice(bodyStart, end) + marker;
      }
      scratch.appendChild(span);
      i = end + marker.length;
    }
    _mathTextHtmlCache[s] = scratch.innerHTML;
    el.innerHTML = scratch.innerHTML;
  }

  function edgeAnchorPixelFromWorld(camera, w, h, item) {
    var target = [Number(item.x) || 0, Number(item.y) || 0, Number(item.z) || 0];
    var origin = Array.isArray(item.anchor_origin) && item.anchor_origin.length >= 3
      ? [Number(item.anchor_origin[0]) || 0, Number(item.anchor_origin[1]) || 0, Number(item.anchor_origin[2]) || 0]
      : [0, 0, 0];
    var po = projectWorldToPixel(camera, w, h, origin);
    var dxw = target[0] - origin[0];
    var dyw = target[1] - origin[1];
    var dzw = target[2] - origin[2];
    var dlw = Math.sqrt(dxw * dxw + dyw * dyw + dzw * dzw);
    var directionTarget = dlw > 1e-9
      ? [origin[0] + (dxw / dlw), origin[1] + (dyw / dlw), origin[2] + (dzw / dlw)]
      : target;
    var pt = projectWorldToPixel(camera, w, h, directionTarget);
    if (!po || !pt) { return null; }
    var inset = Math.max(0, Number(item.inset_px || 20));
    var clipped = clipPixelLineToRect(po, pt, inset, inset, w - inset, h - inset);
    var p = clipped ? clipped[1] : pt;
    var offset = Math.max(0, Number(item.offset_px || 0));
    if (offset > 0) {
      var dx = pt[0] - po[0];
      var dy = pt[1] - po[1];
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len > 1e-6) {
        var nx = -dy / len;
        var ny = dx / len;
        var cx = w * 0.5;
        var cy = h * 0.5;
        var sign = ((p[0] + nx * offset - cx) * (p[0] - cx) + (p[1] + ny * offset - cy) * (p[1] - cy)) >=
          ((p[0] - nx * offset - cx) * (p[0] - cx) + (p[1] - ny * offset - cy) * (p[1] - cy)) ? 1 : -1;
        p = [p[0] + nx * offset * sign, p[1] + ny * offset * sign];
      }
    }
    return p;
  }

  function geomTextToPx(item, w, h, camera) {
    if (item && item.pixel === true) {
      return [Number(item.x) || 0, Number(item.y) || 0];
    }
    if (item && item.world === true) {
      if (item.edge_anchor === true) {
        var anchored = edgeAnchorPixelFromWorld(camera, w, h, item);
        if (anchored) { return anchored; }
      }
      var projected = projectWorldToPixel(camera, w, h, [Number(item.x) || 0, Number(item.y) || 0, Number(item.z) || 0]);
      if (projected) { return projected; }
      return null;
    }
    var aspect = String(item && item.aspect || "").toLowerCase();
    var x = Number(item && item.x) || 0;
    var y = Number(item && item.y) || 0;
    if (aspect === "equal") {
      var s = Math.min(w, h) * 0.5;
      return [(w * 0.5) + x * s, (h * 0.5) - y * s];
    }
    return [((x + 1.0) * 0.5) * w, (1.0 - ((y + 1.0) * 0.5)) * h];
  }

  function collectAxisTickLabelSpecs(mesh, w, h) {
    var cfg = mesh && mesh.axis_ticks || null;
    if (!cfg || cfg.enabled === false) { return []; }
    if (mesh.axis_box === true) {
      return collectAxisBoxLabelSpecs(mesh, w, h);
    }
    var view = axisViewport(mesh, cfg, w, h);
    if (!view) { return []; }
    var vx0 = view.vx0, vx1 = view.vx1, vy0 = view.vy0, vy1 = view.vy1;
    var dataToX = view.dataToX;
    var dataToY = view.dataToY;
    var yAxisPx = dataToY(0);
    var xAxisPx = dataToX(0);
    var tickLen = Math.max(0, Number(cfg.len) || 7);
    var xStep = chooseAxisTickStep((vx1 - vx0) / Math.max(1, w), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
    xStep = chooseReadableLinearTickStep(vx0, vx1, xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, w, cfg.dist, cfg.min_dist, cfg.max_dist, cfg.tick_label_font_size);
    var yStep = chooseAxisTickStep((vy1 - vy0) / Math.max(1, h), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
    var out = [];
    var labelColor = mesh.color || "white";
    var xOffsetValue = 0;
    var yOffsetValue = 0;

    if (yAxisPx >= -tickLen && yAxisPx <= h + tickLen && xStep > 0) {
      var xLabels = Array.isArray(cfg.x_tick_labels) ? cfg.x_tick_labels : null;
      var xTickPlacement = String(cfg.x_tick_label_placement || "below").toLowerCase();
      var xOffset = xTickPlacement === "above" ? -tickLen - 5 : tickLen + 5;
      var xVa = xTickPlacement === "above" ? "bottom" : "top";
      var xs = axisTickValuesNoZeroForMode(vx0, vx1, xStep, cfg.x_ticks, cfg.x_mode, true, cfg.hints, w, cfg.dist, cfg.min_dist, cfg.max_dist);
      xOffsetValue = axisLabelOffset(xs, vx0, vx1);
      for (var xi = 0; xi < xs.length; xi += 1) {
        var xv = xs[xi];
        out.push({
          pixel: true,
          x: dataToX(xv),
          y: yAxisPx + xOffset,
          text: xLabels && xi < xLabels.length ? String(xLabels[xi]) : axisTickLabelWithOffset(xv, cfg.x_mode, vx0, vx1, xOffsetValue, xStep),
          font_size: Number(cfg.tick_label_font_size) || 11,
          ha: "center",
          va: xVa,
          color: labelColor
        });
      }
    }
    if (xAxisPx >= -tickLen && xAxisPx <= w + tickLen && yStep > 0) {
      var yLabels = Array.isArray(cfg.y_tick_labels) ? cfg.y_tick_labels : null;
      var yTickPlacement = String(cfg.y_tick_label_placement || "left").toLowerCase();
      var yOffset = yTickPlacement === "right" ? tickLen + 5 : -tickLen - 5;
      var yHa = yTickPlacement === "right" ? "left" : "right";
      var ys = axisTickValuesNoZeroForMode(vy0, vy1, yStep, cfg.y_ticks, cfg.y_mode, true, cfg.hints, h, cfg.dist, cfg.min_dist, cfg.max_dist);
      yOffsetValue = axisLabelOffset(ys, vy0, vy1);
      for (var yi = 0; yi < ys.length; yi += 1) {
        var yv = ys[yi];
        out.push({
          pixel: true,
          x: xAxisPx + yOffset,
          y: dataToY(yv),
          text: yLabels && yi < yLabels.length ? String(yLabels[yi]) : axisTickLabelWithOffset(yv, cfg.y_mode, vy0, vy1, yOffsetValue, yStep),
          font_size: Number(cfg.tick_label_font_size) || 11,
          ha: yHa,
          va: "center",
          color: labelColor
        });
      }
    }
    var xLabelPlacement = String(cfg.x_label_placement || cfg.x_tick_label_placement || "below").toLowerCase();
    var xLabelBelow = xLabelPlacement !== "above";
    var yLabelPlacement = String(cfg.y_label_placement || cfg.y_tick_label_placement || "left").toLowerCase();
    var yLabelRight = yLabelPlacement === "right";
    var labelFramePad = Math.max(0, Number(cfg.label_frame_pad) || 20);
    var labelAxisPad = Math.max(0, Number(cfg.label_axis_pad) || 34);
    if (cfg.x_label) {
      out.push({
        pixel: true,
        x: w - labelFramePad,
        y: yAxisPx + (xLabelBelow ? labelAxisPad : -labelAxisPad),
        text: String(cfg.x_label),
        font_size: Number(cfg.label_font_size) || 13,
        ha: "right",
        va: xLabelBelow ? "top" : "bottom",
        color: labelColor
      });
    }
    if (xOffsetValue !== 0) {
      out.push({
        pixel: true,
        x: w - labelFramePad,
        y: yAxisPx + (xLabelBelow ? -labelAxisPad : labelAxisPad),
        text: formatOffsetLabel(xOffsetValue),
        font_size: Number(cfg.tick_label_font_size) || 11,
        ha: "right",
        va: xLabelBelow ? "bottom" : "top",
        color: labelColor
      });
    }
    if (cfg.y_label) {
      out.push({
        pixel: true,
        x: xAxisPx + (yLabelRight ? labelAxisPad : -labelAxisPad),
        y: labelFramePad,
        text: String(cfg.y_label),
        font_size: Number(cfg.label_font_size) || 13,
        ha: yLabelRight ? "left" : "right",
        va: "top",
        rotate: yLabelRight ? 90 : -90,
        color: labelColor
      });
    }
    if (yOffsetValue !== 0) {
      out.push({
        pixel: true,
        x: xAxisPx + (yLabelRight ? -labelAxisPad : labelAxisPad),
        y: labelFramePad,
        text: formatOffsetLabel(yOffsetValue),
        font_size: Number(cfg.tick_label_font_size) || 11,
        ha: yLabelRight ? "right" : "left",
        va: "top",
        color: labelColor
      });
    }
    return out;
  }

  function collectAxisBoxLabelSpecs(mesh, w, h) {
    var cfg = mesh && mesh.axis_ticks || null;
    if (!cfg || cfg.enabled === false) { return []; }
    var box = axisBoxRect(mesh, w, h);
    var xMin = Number(cfg.x_min);
    var xMax = Number(cfg.x_max);
    var yMin = Number(cfg.y_min);
    var yMax = Number(cfg.y_max);
    if (!(xMax > xMin) || !(yMax > yMin)) { return []; }
    var xStep = chooseAxisTickStep((xMax - xMin) / Math.max(1, box.width), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
    xStep = chooseReadableLinearTickStep(xMin, xMax, xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, box.width, cfg.dist, cfg.min_dist, cfg.max_dist, cfg.tick_label_font_size);
    var yStep = chooseAxisTickStep((yMax - yMin) / Math.max(1, box.height), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
    var tickLen = Math.max(0, Number(cfg.len) || 7);
    var labelColor = mesh.color || "white";
    var dataToX = function (x) { return box.left + axisValueToUnit(x, xMin, xMax, cfg.x_mode) * box.width; };
    var dataToY = function (y) { return box.bottom - axisValueToUnit(y, yMin, yMax, cfg.y_mode) * box.height; };
    var out = [];

    var xLabels = Array.isArray(cfg.x_tick_labels) ? cfg.x_tick_labels : null;
    var xTickPlacement = String(cfg.x_tick_label_placement || "below").toLowerCase();
    var xOffset = xTickPlacement === "above" ? -tickLen - 5 : tickLen + 5;
    var xVa = xTickPlacement === "above" ? "bottom" : "top";
    var xs = axisTickValuesForMode(xMin, xMax, xStep, cfg.x_ticks, cfg.x_mode, false, cfg.hints, box.width, cfg.dist, cfg.min_dist, cfg.max_dist);
    var xOffsetValue = axisLabelOffset(xs, xMin, xMax);
    var xLabelAxisPad = Math.max(0, Number(cfg.label_axis_pad) || 34);
    for (var xi = 0; xi < xs.length; xi += 1) {
      out.push({
        pixel: true,
        x: dataToX(xs[xi]),
        y: box.bottom + xOffset,
        text: xLabels && xi < xLabels.length ? String(xLabels[xi]) : axisTickLabelWithOffset(xs[xi], cfg.x_mode, xMin, xMax, xOffsetValue, xStep),
        font_size: Number(cfg.tick_label_font_size) || 11,
        ha: "center",
        va: xVa,
        color: labelColor
      });
    }

    var yLabels = Array.isArray(cfg.y_tick_labels) ? cfg.y_tick_labels : null;
    var yTickPlacement = String(cfg.y_tick_label_placement || "left").toLowerCase();
    var yOffset = yTickPlacement === "right" ? tickLen + 5 : -tickLen - 5;
    var yHa = yTickPlacement === "right" ? "left" : "right";
    var ys = axisTickValuesForMode(yMin, yMax, yStep, cfg.y_ticks, cfg.y_mode, false, cfg.hints, box.height, cfg.dist, cfg.min_dist, cfg.max_dist);
    var yOffsetValue = axisLabelOffset(ys, yMin, yMax);
    var yLabelAxisPad = Math.max(0, Number(cfg.label_axis_pad) || 34);
    var yTickLabelWidth = yLabels
      ? Math.max.apply(null, yLabels.map(function (label) { return estimateTickLabelWidthPx(label, Number(cfg.tick_label_font_size) || 11); }).concat([0]))
      : maxEstimatedTickLabelWidthPx(ys, cfg.y_mode, yMin, yMax, yOffsetValue, yStep, Number(cfg.tick_label_font_size) || 11);
    for (var yi = 0; yi < ys.length; yi += 1) {
      out.push({
        pixel: true,
        x: box.left + yOffset,
        y: dataToY(ys[yi]),
        text: yLabels && yi < yLabels.length ? String(yLabels[yi]) : axisTickLabelWithOffset(ys[yi], cfg.y_mode, yMin, yMax, yOffsetValue, yStep),
        font_size: Number(cfg.tick_label_font_size) || 11,
        ha: yHa,
        va: "center",
        color: labelColor
      });
    }

    if (cfg.x_label) {
      out.push({
        pixel: true,
        x: (box.left + box.right) * 0.5,
        y: box.bottom + xLabelAxisPad,
        text: String(cfg.x_label),
        font_size: Number(cfg.label_font_size) || 13,
        ha: "center",
        va: "top",
        color: labelColor
      });
    }
    if (xOffsetValue !== 0) {
      out.push({
        pixel: true,
        x: box.right,
        y: box.bottom + xLabelAxisPad,
        text: formatOffsetLabel(xOffsetValue),
        font_size: Number(cfg.tick_label_font_size) || 11,
        ha: "right",
        va: "top",
        color: labelColor
      });
    }
    if (cfg.y_label) {
      var yLabelGap = Math.max(8, Math.min(14, yLabelAxisPad));
      var yLabelOutsidePad = tickLen + 8 + yTickLabelWidth + yLabelGap;
      out.push({
        pixel: true,
        x: yTickPlacement === "right" ? box.left + yLabelOutsidePad : box.left - yLabelOutsidePad,
        y: (box.top + box.bottom) * 0.5,
        text: String(cfg.y_label),
        font_size: Number(cfg.label_font_size) || 13,
        ha: "center",
        va: "center",
        rotate: yTickPlacement === "right" ? 90 : -90,
        color: labelColor
      });
    }
    if (yOffsetValue !== 0) {
      out.push({
        pixel: true,
        x: box.left + yOffset,
        y: box.top - 4,
        text: formatOffsetLabel(yOffsetValue),
        font_size: Number(cfg.tick_label_font_size) || 11,
        ha: yHa,
        va: "bottom",
        color: labelColor
      });
    }
    return out;
  }

  function renderGeomTextOverlay(fid, frameEl, geomSpec) {
    try {
      var incomingTexts = geomSpec && Array.isArray(geomSpec.texts) ? geomSpec.texts.length : 0;
      var layer = ensureGeomTextOverlay(frameEl, fid);
      if (!layer) {
        if (incomingTexts) { vlog("warn", "renderGeomTextOverlay [" + fid + "]: no overlay layer"); }
        return;
      }
      var fit = fittedFrameContentRect(frameEl, geomFrameHost(frameEl, fid));
      var w = Math.max(1, Math.round(fit.width || 1));
      var h = Math.max(1, Math.round(fit.height || 1));
      layer.style.left = Math.round(fit.left || 0) + "px";
      layer.style.top = Math.round(fit.top || 0) + "px";
      layer.style.width = w + "px";
      layer.style.height = h + "px";
      var contentLayer = layer.__vfGeomTextContent || layer;
      contentLayer.style.transform = "";
      rememberGeomTextOverlay(fid, layer, frameEl, geomSpec, w, h);
      var items = [];
      var texts = geomSpec && Array.isArray(geomSpec.texts) ? geomSpec.texts : [];
      for (var ti = 0; ti < texts.length; ti += 1) {
        if (geomSpec && geomSpec.axis3d_controls === true && texts[ti] && texts[ti].edge_anchor === true) { continue; }
        items.push(texts[ti]);
      }
      var meshes = geomSpec && Array.isArray(geomSpec.meshes) ? geomSpec.meshes : [];
      for (var mi = 0; mi < meshes.length; mi += 1) {
        if (!(meshes[mi] && meshes[mi].axis_ticks)) { continue; }
        var tickTexts = collectAxisTickLabelSpecs(meshes[mi], w, h);
        for (var ai = 0; ai < tickTexts.length; ai += 1) { items.push(tickTexts[ai]); }
      }
      if (!frameRecs[String(fid)]) { frameRecs[String(fid)] = { entries: [] }; }
      var rec = frameRecs[String(fid)];
      rec.textOverlayPanX = 0;
      rec.textOverlayPanY = 0;
      var pool = Array.isArray(rec.textOverlayPool) ? rec.textOverlayPool : [];
      rec.textOverlayPool = pool;
      var used = 0;
      var firstPos = null;
      var keepAllAxis3DLabels = !!(geomSpec && geomSpec.axis3d_controls === true);
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i] || {};
        var p = geomTextToPx(item, w, h, geomSpec && geomSpec.camera || null);
        if (!p) { continue; }
        if (!keepAllAxis3DLabels && !textPointIsNearViewport(p, w, h, 112)) { continue; }
        if (!firstPos) { firstPos = p.slice ? p.slice(0, 2) : p; }
        var color = parseRuntimeColor(item.color || "white");
        var el = pool[used];
        if (!el || el.parentNode !== contentLayer) {
          el = document.createElement("div");
          el.className = "vf-geom-text-overlay__item";
          el.style.position = "absolute";
          el.style.lineHeight = "1";
          el.style.whiteSpace = "nowrap";
          el.style.textShadow = "0 1px 2px rgba(0,0,0,0.65)";
          el.style.willChange = "transform";
          pool[used] = el;
          contentLayer.appendChild(el);
        }
        used += 1;
        el.style.display = "";
        if (el.dataset.vfGeomTextPositioned !== "1") {
          el.style.left = "0px";
          el.style.top = "0px";
          el.dataset.vfGeomTextPositioned = "1";
        }
        el.style.color = "rgba(" + Math.round(color[0] * 255) + "," + Math.round(color[1] * 255) + "," + Math.round(color[2] * 255) + "," + Math.max(0, Math.min(1, color[3])) + ")";
        el.style.fontSize = String(Math.max(1, Number(item.font_size) || 12)) + "px";
        var rotation = Number(item.rotate) || 0;
        el.style.transform = "translate3d(" + String(p[0]) + "px," + String(p[1]) + "px,0) translate(" +
          (String(item.ha || "center").toLowerCase() === "left" ? "0" : String(item.ha || "center").toLowerCase() === "right" ? "-100%" : "-50%") +
          "," +
          (String(item.va || "center").toLowerCase() === "top" ? "0" : String(item.va || "center").toLowerCase() === "bottom" ? "-100%" : "-50%") +
          ")" + (rotation ? " rotate(" + String(rotation) + "deg)" : "");
        var textValue = item.text != null ? String(item.text) : "";
        if (el.dataset.vfGeomTextValue !== textValue) {
          renderMathText(el, textValue);
          el.dataset.vfGeomTextValue = textValue;
        }
      }
      for (var pi = used; pi < pool.length; pi += 1) {
        if (pool[pi]) { pool[pi].style.display = "none"; }
      }
      updateAxis3DBoundaryLabels(fid);
    } catch (err) {
      vlog("error", "renderGeomTextOverlay [" + fid + "] failed: " + (err && err.stack ? err.stack : err && err.message ? err.message : String(err)));
    }
  }

  function mountSimple2DMarkerRenderer(fid, frameEl, geomSpec) {
    var specs = geomSpec && geomSpec.__renderableMeshes ? geomSpec.__renderableMeshes : (geomSpec && geomSpec.meshes ? geomSpec.meshes : []);
    if (!frameRecs[fid]) { frameRecs[fid] = { entries: [] }; }
    var rec = frameRecs[fid];
    stopGeomFrameRenderers(fid);
    rec.simple2DMeshes = specs;
    rec.simple2DGeomSpec = geomSpec;
    rec.simple2DFrameEl = frameEl;
    if (!drawSimple2DMarkerLineMeshes(fid, frameEl, rec.simple2DMeshes)) {
      return false;
    }
    renderGeomTextOverlay(fid, frameEl, geomSpec);
    if (typeof ResizeObserver === "function") {
      var host = geomFrameHost(frameEl, fid) || frameEl;
      rec.simple2DResizeObserver = new ResizeObserver(function () {
        if (rec.simple2DResizeRaf) { return; }
        rec.simple2DResizeRaf = requestAnimationFrame(function () {
          rec.simple2DResizeRaf = 0;
          drawSimple2DMarkerLineMeshes(fid, rec.simple2DFrameEl || frameEl, rec.simple2DMeshes || specs);
          renderGeomTextOverlay(fid, rec.simple2DFrameEl || frameEl, rec.simple2DGeomSpec || geomSpec);
        });
      });
      rec.simple2DResizeObserver.observe(host);
    }
    return true;
  }

  function updateGeomFrame(fid, geomSpec) {
    var frameEl = findFrameEl(geomTargetFrameId(fid));
    if (!frameEl) {
      vlog("warn", "updateGeomFrame [" + fid + "]: no DOM element .vf-frame[data-vf-frame-id=" + fid + "] found — frame not placed yet?");
      return;
    }
    ensurePlotCameraControls(String(fid), frameEl, geomSpec);
    ensureAxis3DControls(String(fid), frameEl, geomSpec);
    ensureAxis2DControls(String(fid), frameEl, geomSpec);
    updatePlotAnimation(String(fid), frameEl, geomSpec);
    if (geomSpec && geomSpec.axis3d_runtime && !geomSpec.__axis3dRuntimePreparing) {
      geomSpec.__axis3dRuntimePreparing = true;
      try {
        rebuildAxis3DLocalField(String(fid), true, geomSpec);
      } finally {
        geomSpec.__axis3dRuntimePreparing = false;
      }
    }

    var specs   = geomSpec.meshes || [];
    var renderableSpecs = renderableGeomSpecs(specs);
    var camera  = geomSpec.camera || null;
    var lights  = geomSpec.lights || [];
    var textCount = geomSpec && Array.isArray(geomSpec.texts) ? geomSpec.texts.length : 0;
    var simple2DMarkers = renderableSpecs.length > 0 && !camera && !lights.length && renderableSpecs.every(isSimple2DMarkerLineMesh);
    if (simple2DMarkers) {
      geomSpec.__renderableMeshes = renderableSpecs;
      if (mountSimple2DMarkerRenderer(fid, frameEl, geomSpec)) {
        delete geomSpec.__renderableMeshes;
        return;
      }
      delete geomSpec.__renderableMeshes;
    }

    var Ctor = global.VfGeomWgpu;
    if (!Ctor) {
      vlog("warn", "updateGeomFrame [" + fid + "]: VfGeomWgpu not loaded — geom skipped");
      return;
    }
    var effectiveCamera = camera
      ? (function () {
          var fit = fittedFrameContentRect(frameEl, geomFrameHost(frameEl, fid));
          return Object.assign({}, camera, {
            viewport_width_px: Math.max(1, Math.round(fit.width || 1)),
            viewport_height_px: Math.max(1, Math.round(fit.height || 1))
          });
        })()
      : null;
    var unifiedScene = geomSpec && geomSpec.unified_renderer === true
      ? buildUnifiedFrameScene(renderableSpecs, effectiveCamera, lights, geomSpec.light_flares || null)
      : null;
    var combinedTransparent = !unifiedScene && geomSpec && geomSpec.combine_transparent === true && renderableSpecs.length > 1
      ? buildCombinedTransparentMesh(renderableSpecs, effectiveCamera, lights)
      : null;
    var renderSpecs = unifiedScene
      ? [{ __mesh: unifiedScene, type: "unified_frame_scene" }]
      : combinedTransparent
      ? [{ __mesh: combinedTransparent, type: "combined_transparent" }]
      : renderableSpecs;

    if (!frameRecs[fid]) { frameRecs[fid] = { entries: [] }; }
    var rec = frameRecs[fid];
    var summary = "meshes=" + specs.length +
      (renderableSpecs.length !== specs.length ? " renderable=" + renderableSpecs.length : "") +
      (unifiedScene ? " (unified frame renderer)" : "") +
      (combinedTransparent ? " (combined transparent pass)" : "") +
      " camera=" + (camera ? JSON.stringify(camera.pos) : "none") +
      " lights=" + lights.length +
      " texts=" + textCount;
    if (rec._lastSummary !== summary) {
      rec._lastSummary = summary;
      vlog("info", "updateGeomFrame [" + fid + "]: " + summary);
    }

    for (var i = 0; i < renderSpecs.length; i++) {
      var spec = renderSpecs[i];
      var mesh = spec.__mesh || buildSingleMesh(spec, effectiveCamera, lights);
      if (!mesh) {
        vlog("warn", "updateGeomFrame [" + fid + "]: mesh " + i + " build failed, skipping");
        continue;
      }

      if (i < rec.entries.length) {
        var existingEntry = rec.entries[i] || null;
        if (!existingEntry) { continue; }
        if (!existingEntry.ref) { existingEntry.ref = { mesh: null }; }
        existingEntry.ref.mesh = mesh;
        if (existingEntry.canvas) {
          existingEntry.canvas.style.opacity = String(mesh.alpha == null ? 1 : mesh.alpha);
        }
        // log only on first few updates to avoid spam
        if (existingEntry._logCount == null) { existingEntry._logCount = 0; }
        existingEntry._logCount++;
        if (existingEntry._logCount <= 3) {
          vlog("info", "updateGeomFrame [" + fid + "]: updated renderer " + i +
            " center=" + JSON.stringify(spec.center) +
            " scale=" + JSON.stringify(spec.scale) +
            " rot=" + JSON.stringify(spec.rotation || [0,0,0]));
        }
      } else {
        // Spawn new renderer
        var canvas = ensureGeomCanvas(frameEl, i, fid);
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
          r._frameId = String(fidInner);
          global.__vfFrameRenderers[String(fidInner)] = r;
          entry.canvas = cv;
          cv.style.opacity = String(mesh.alpha == null ? 1 : mesh.alpha);
          cv.style.pointerEvents = "none";
          // Assign stable object_id (1-based: 0 means "no object")
          r._objectId = meshIdx + 1;
          r.init().then(function(ok) {
            if (!ok) {
              entry.initError = global.__vfGeomWgpuLastError || "renderer init returned false";
              vlog("error", "updateGeomFrame [" + fidInner + "]: renderer " + meshIdx + " init FAILED (WebGPU unavailable?)");
            } else {
              entry.initError = "";
              vlog("info", "updateGeomFrame [" + fidInner + "]: renderer " + meshIdx + " init OK, starting render loop");
              prewarmGeomRenderer(r);
              r.start();
              if (typeof ResizeObserver === "function") {
                var host = cv.parentElement || cv;
                entry.resizeObserver = new ResizeObserver(function () {
                  if (entry.resizeRaf) { return; }
                  entry.resizeRaf = requestAnimationFrame(function () {
                    entry.resizeRaf = 0;
                    layoutGeomCanvas(frameEl, cv, fid);
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
            entry.initError = (err && err.message ? err.message : String(err));
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
      if (rec.entries[j]) {
        if (!rec.entries[j].ref) { rec.entries[j].ref = { mesh: null }; }
        rec.entries[j].ref.mesh = null;
      }
    }
    rec.entries.length = renderSpecs.length;
    if (geomSpec && geomSpec.axis3d_runtime) {
      var fitForAxisLines = fittedFrameContentRect(frameEl, geomFrameHost(frameEl, fid));
      renderGeomLineOverlay(
        fid,
        frameEl,
        geomSpec,
        Math.max(1, Math.round(fitForAxisLines.width || 1)),
        Math.max(1, Math.round(fitForAxisLines.height || 1))
      );
    }
    scheduleGeomTextOverlayRender(fid, frameEl, geomSpec);
    // Notify native host of updated hit regions (geom canvases)
    schedulePostGeomLayout();
  }

  function parseRuntimeColor(color) {
    if (color && typeof color === "object" && color.length >= 3) {
      return [
        Number(color[0]) || 0,
        Number(color[1]) || 0,
        Number(color[2]) || 0,
        color.length >= 4 ? Number(color[3]) || 0 : 1
      ];
    }
    var s = String(color || "").trim().toLowerCase();
    var named = {
      white: [1, 1, 1, 1],
      black: [0, 0, 0, 1],
      red: [1, 0.1, 0.1, 1],
      green: [0.15, 0.85, 0.15, 1],
      blue: [0.15, 0.35, 1, 1],
      yellow: [1, 0.9, 0.1, 1],
      cyan: [0.1, 0.9, 0.9, 1],
      magenta: [0.9, 0.1, 0.9, 1],
      orange: [1, 0.5, 0.05, 1],
      gray: [0.5, 0.5, 0.5, 1],
      grey: [0.5, 0.5, 0.5, 1]
    };
    if (named[s]) { return named[s].slice(); }
    if (s.charAt(0) === "#") {
      var h = s.slice(1);
      if (h.length === 3) { h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; }
      var n = parseInt(h, 16);
      if (Number.isFinite(n)) {
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
      }
    }
    throw new Error("geom.color.patch received unsupported color: " + String(color));
  }

  function paintVertexBufferColor(vertices, color) {
    if (!vertices || vertices.length < 10) { return false; }
    for (var offset = 6; offset + 3 < vertices.length; offset += 10) {
      vertices[offset] = color[0];
      vertices[offset + 1] = color[1];
      vertices[offset + 2] = color[2];
      vertices[offset + 3] = color[3];
    }
    return true;
  }

  function patchDisplaySpecColor(fid, objectId, color) {
    if (!_lastDisplayPayload || !_lastDisplayPayload.geom) { return; }
    var geom = _lastDisplayPayload.geom[String(fid)];
    if (!geom || !Array.isArray(geom.meshes)) { return; }
    var spec = geom.meshes[objectId - 1];
    if (!spec) { return; }
    spec.color = color.slice();
    paintVertexBufferColor(spec.vertices, color);
  }

  function patchRendererPartColor(entry, objectId, color) {
    if (!entry || !entry.renderer) { return false; }
    var renderer = entry.renderer;
    var mesh = entry.ref && entry.ref.mesh;
    var wrote = false;
    if (mesh && Array.isArray(mesh.parts)) {
      var gpuParts = Array.isArray(renderer._parts) ? renderer._parts : [];
      for (var i = 0; i < mesh.parts.length; i++) {
        var partMesh = mesh.parts[i];
        var partObjectId = Number(partMesh && partMesh.object_id || (i + 1)) || (i + 1);
        if (partObjectId !== objectId) { continue; }
        if (!paintVertexBufferColor(partMesh.vertices, color)) { return false; }
        partMesh.color = color.slice();
        partMesh.__revision = Number(partMesh.__revision || 0) + 1;
        var gpuPart = gpuParts[i];
        if (gpuPart && gpuPart.vb && renderer._device && renderer._device.queue) {
          renderer._device.queue.writeBuffer(gpuPart.vb, 0, partMesh.vertices);
          gpuPart.mesh = partMesh;
        }
        wrote = true;
      }
      if (wrote) {
        mesh.__revision = Number(mesh.__revision || 0) + 1;
      }
      return wrote;
    }
    var rendererObjectId = Number(renderer._objectId || 1) || 1;
    if (objectId !== rendererObjectId || !mesh) { return false; }
    if (!paintVertexBufferColor(mesh.vertices, color)) { return false; }
    mesh.color = color.slice();
    mesh.__revision = Number(mesh.__revision || 0) + 1;
    if (renderer._vb && renderer._device && renderer._device.queue) {
      renderer._device.queue.writeBuffer(renderer._vb, 0, mesh.vertices);
    }
    return true;
  }

  function applyGeomColorPatch(payload) {
    if (!payload || typeof payload !== "object") { return; }
    var fid = String(payload.frame_id || "");
    var objectId = Number(payload.object_id || 0);
    if (!fid || !(objectId > 0)) {
      throw new Error("geom.color.patch requires frame_id and positive object_id");
    }
    var color = parseRuntimeColor(payload.color);
    patchDisplaySpecColor(fid, objectId, color);
    var rec = frameRecs[fid];
    if (!rec || !Array.isArray(rec.entries)) {
      vlog("warn", "geom.color.patch [" + fid + "]: frame renderer not ready for object_id=" + objectId);
      return;
    }
    var patched = false;
    for (var i = 0; i < rec.entries.length; i++) {
      patched = patchRendererPartColor(rec.entries[i], objectId, color) || patched;
    }
    if (!patched) {
      vlog("warn", "geom.color.patch [" + fid + "]: object_id=" + objectId + " was not present in live GPU parts");
    }
  }

  function _buildDynamicGeomScene(geomSpec) {
    var MaterialArena = global.VfGeomMaterialArena || null;
    if (geomSpec && Array.isArray(geomSpec.parts)) {
      return MaterialArena && typeof MaterialArena.resolveScene === "function"
        ? MaterialArena.resolveScene(geomSpec)
        : geomSpec;
    }
    if (!geomSpec || !Array.isArray(geomSpec.meshes)) {
      throw new Error("dynamic geom provider returned invalid spec");
    }
    var scene = geomSpec && geomSpec.unified_renderer === true
      ? buildUnifiedFrameScene(geomSpec.meshes, geomSpec.camera || null, geomSpec.lights || [], geomSpec.light_flares || null)
      : null;
    if (!scene) {
      throw new Error("dynamic geom provider did not produce a unified scene");
    }
    if (geomSpec.materials && MaterialArena && typeof MaterialArena.resolveScene === "function") {
      scene.materials = geomSpec.materials;
      return MaterialArena.resolveScene(scene);
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
    r._frameId = String(fid);
    global.__vfFrameRenderers[String(fid)] = r;
    canvas.style.pointerEvents = "none";
    r.init().then(function(ok) {
      if (!ok) {
        entry.initError = global.__vfGeomWgpuLastError || "renderer init returned false";
        vlog("error", "mountDynamicGeomFrame [" + fid + "]: renderer init FAILED");
        return;
      }
      entry.initError = "";
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
      entry.initError = (err && err.message ? err.message : String(err));
      vlog("error", "mountDynamicGeomFrame [" + fid + "]: renderer init threw: " + (err && err.message ? err.message : String(err)));
    });
  }

  function mountOffscreenGeomFrame(fid, provider, width, height) {
    if (typeof provider !== "function") {
      throw new Error("mountOffscreenGeomFrame(" + String(fid) + "): provider must be a function");
    }
    var Ctor = global.VfGeomWgpu;
    if (!Ctor) {
      throw new Error("mountOffscreenGeomFrame(" + String(fid) + "): VfGeomWgpu not loaded");
    }
    var AdapterCtor = global.VfGeomFrameAdapter;
    if (!AdapterCtor || typeof AdapterCtor.createAdapter !== "function") {
      throw new Error("mountOffscreenGeomFrame(" + String(fid) + "): VfGeomFrameAdapter not loaded");
    }
    if (!frameRecs[fid]) { frameRecs[fid] = { entries: [] }; }
    var rec = frameRecs[fid];
    if (!rec.dynamicAdapter) {
      rec.dynamicAdapter = AdapterCtor.createAdapter({
        provider: provider,
        buildScene: _buildDynamicGeomScene
      });
    } else {
      rec.dynamicAdapter.replaceProvider(provider);
    }
    var targetW = Math.max(1, Math.round(Number(width || 1) || 1));
    var targetH = Math.max(1, Math.round(Number(height || 1) || 1));
    rec.offscreenWidth = targetW;
    rec.offscreenHeight = targetH;
    if (!rec.offscreenCanvas) {
      var canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.position = "fixed";
      canvas.style.left = "-10000px";
      canvas.style.top = "-10000px";
      canvas.style.width = targetW + "px";
      canvas.style.height = targetH + "px";
      canvas.style.pointerEvents = "none";
      canvas.setAttribute("aria-hidden", "true");
      document.body.appendChild(canvas);
      rec.offscreenCanvas = canvas;
    } else {
      rec.offscreenCanvas.width = targetW;
      rec.offscreenCanvas.height = targetH;
      rec.offscreenCanvas.style.width = targetW + "px";
      rec.offscreenCanvas.style.height = targetH + "px";
    }
    if (rec.entries.length > 0 && rec.entries[0] && rec.entries[0].renderer) {
      var existing = rec.entries[0].renderer;
      global.__vfFrameRenderers[String(fid)] = existing;
      if (rec.dynamicAdapter) {
        rec.dynamicAdapter.onHostResize(rec.offscreenWidth, rec.offscreenHeight);
        rec.dynamicAdapter.markDirty();
      }
      if (existing && existing._device && typeof existing.onResize === "function") {
        existing.onResize();
      }
      return;
    }
    var entry = { renderer: null, ref: null, _logCount: 0, resizeObserver: null, resizeRaf: 0, canvas: rec.offscreenCanvas };
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
    var r = new Ctor(rec.offscreenCanvas, function() { return refHolder.mesh; });
    entry.renderer = r;
    r._frameId = String(fid);
    r._offscreenFrame = true;
    r._debugSetFrameTextureTargetSize = function (w, h) {
      var nextW = Math.max(1, Math.round(Number(w || 1) || 1));
      var nextH = Math.max(1, Math.round(Number(h || 1) || 1));
      if (rec.offscreenWidth === nextW && rec.offscreenHeight === nextH) {
        return;
      }
      rec.offscreenWidth = nextW;
      rec.offscreenHeight = nextH;
      if (rec.offscreenCanvas) {
        rec.offscreenCanvas.width = nextW;
        rec.offscreenCanvas.height = nextH;
        rec.offscreenCanvas.style.width = nextW + "px";
        rec.offscreenCanvas.style.height = nextH + "px";
      }
      if (rec.dynamicAdapter) {
        rec.dynamicAdapter.onHostResize(nextW, nextH);
      }
      if (r && r._device && typeof r.onResize === "function") {
        r.onResize();
      }
    };
    global.__vfFrameRenderers[String(fid)] = r;
    r.init().then(function(ok) {
      if (!ok) {
        entry.initError = global.__vfGeomWgpuLastError || "renderer init returned false";
        vlog("error", "mountOffscreenGeomFrame [" + fid + "]: renderer init FAILED");
        return;
      }
      entry.initError = "";
      vlog("info", "mountOffscreenGeomFrame [" + fid + "]: renderer init OK, using on-demand renders");
      prewarmGeomRenderer(r);
      if (rec.dynamicAdapter) {
        rec.dynamicAdapter.onHostResize(rec.offscreenWidth, rec.offscreenHeight);
      }
      try { r._renderContent(performance.now()); } catch (_) {}
    }).catch(function(err) {
      entry.initError = (err && err.message ? err.message : String(err));
      vlog("error", "mountOffscreenGeomFrame [" + fid + "]: renderer init threw: " + (err && err.message ? err.message : String(err)));
    });
  }

  var LINKED_TEXTURE_SHADER = `
struct Flip {
  flip_u : f32,
  flip_v : f32,
}
@group(0) @binding(0) var texSampler : sampler;
@group(0) @binding(1) var texColor : texture_2d<f32>;
@group(0) @binding(2) var<uniform> flip : Flip;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vsMain(@builtin(vertex_index) vid : u32) -> VOut {
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
fn fsMain(in : VOut) -> @location(0) vec4<f32> {
  var uv = in.uv;
  if (flip.flip_u > 0.5) {
    uv.x = 1.0 - uv.x;
  }
  if (flip.flip_v > 0.5) {
    uv.y = 1.0 - uv.y;
  }
  return textureSampleLevel(texColor, texSampler, uv, 0.0);
}
`;

  function mountLinkedMirrorTextureFrame(fid, sourceFrameId, mirrorMeshId) {
    var frameEl = findFrameEl(geomTargetFrameId(fid));
    if (!frameEl) {
      throw new Error("mountLinkedMirrorTextureFrame(" + String(fid) + "): frame DOM element not found");
    }
    if (!frameRecs[fid]) { frameRecs[fid] = { entries: [] }; }
    if (!global.__vfGeomFrameIds) {
      global.__vfGeomFrameIds = Object.create(null);
    }
    global.__vfGeomFrameIds[String(fid)] = true;
    disableFrameCanvasEvents(fid);
    var rec = frameRecs[fid];
    var canvas = ensureGeomCanvas(frameEl, 0);
    if (!canvas) {
      throw new Error("mountLinkedMirrorTextureFrame(" + String(fid) + "): could not create canvas");
    }
    var AdapterApi = global.VfGeomWgpuUtil;
    if (!AdapterApi || typeof AdapterApi.getSharedWgpu !== "function") {
      throw new Error("mountLinkedMirrorTextureFrame(" + String(fid) + "): shared WebGPU API unavailable");
    }
    canvas.style.pointerEvents = "none";
    var entry = rec.entries[0] || { renderer: null, ref: null, resizeObserver: null, resizeRaf: 0, canvas: canvas };
    entry.canvas = canvas;
    entry.textureSource = { frameId: String(sourceFrameId || ""), meshId: String(mirrorMeshId || "") };
    rec.entries = [entry];
    if (entry._textureLoopActive) {
      ensureGeomFrameEvents(fid);
      schedulePostGeomLayout();
      return;
    }

    function clearFallback2d() {
      if (entry._linkedTextureGpuReady && !entry._fallback2dCtx) {
        return;
      }
      if (!entry._fallback2dCtx) {
        entry._fallback2dCtx = canvas.getContext("2d", { alpha: true });
      }
      var fallbackCtx = entry._fallback2dCtx;
      if (!fallbackCtx) {
        syncCanvasSize(canvas);
        return;
      }
      syncCanvasSize(canvas);
      fallbackCtx.clearRect(0, 0, canvas.width, canvas.height);
      fallbackCtx.fillStyle = "rgba(0,0,0,1)";
      fallbackCtx.fillRect(0, 0, canvas.width, canvas.height);
    }

    async function ensureGpuViewer() {
      if (entry._linkedTextureGpuReady) { return true; }
      var sg = await AdapterApi.getSharedWgpu();
      if (!sg || !sg.device || !sg.surfaceSampler) { return false; }
      var gpuCtx = canvas.getContext("webgpu");
      if (!gpuCtx) { return false; }
      entry._linkedTextureShared = sg;
      entry._linkedTextureCtx = gpuCtx;
      entry._linkedTextureFormat = sg.format;
      gpuCtx.configure({ device: sg.device, format: sg.format, alphaMode: "premultiplied" });
      entry._linkedTextureFlipBuf = sg.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      entry._linkedTextureBindLayout = sg.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
        ]
      });
      entry._linkedTexturePipeline = sg.device.createRenderPipeline({
        layout: sg.device.createPipelineLayout({ bindGroupLayouts: [entry._linkedTextureBindLayout] }),
        vertex: {
          module: sg.device.createShaderModule({ code: LINKED_TEXTURE_SHADER }),
          entryPoint: "vsMain"
        },
        fragment: {
          module: sg.device.createShaderModule({ code: LINKED_TEXTURE_SHADER }),
          entryPoint: "fsMain",
          targets: [{ format: sg.format }]
        },
        primitive: { topology: "triangle-strip" }
      });
      entry._linkedTextureGpuReady = true;
      return true;
    }

    function ensureTextureBindGroup(surfaceRef) {
      if (!entry._linkedTextureGpuReady || !entry._linkedTextureShared || !surfaceRef || !surfaceRef.view) { return null; }
      if (
        entry._linkedTextureBindGroup &&
        entry._linkedTextureBoundView === surfaceRef.view &&
        entry._linkedTextureBoundFlipU === !!surfaceRef.flipU &&
        entry._linkedTextureBoundFlipV === !!surfaceRef.flipV
      ) {
        return entry._linkedTextureBindGroup;
      }
      var sg = entry._linkedTextureShared;
      var flipData = new Float32Array([surfaceRef.flipU ? 1.0 : 0.0, surfaceRef.flipV ? 1.0 : 0.0, 0.0, 0.0]);
      sg.device.queue.writeBuffer(entry._linkedTextureFlipBuf, 0, flipData);
      entry._linkedTextureBindGroup = sg.device.createBindGroup({
        layout: entry._linkedTextureBindLayout,
        entries: [
          { binding: 0, resource: sg.surfaceSampler },
          { binding: 1, resource: surfaceRef.view },
          { binding: 2, resource: { buffer: entry._linkedTextureFlipBuf } }
        ]
      });
      entry._linkedTextureBoundView = surfaceRef.view;
      entry._linkedTextureBoundFlipU = !!surfaceRef.flipU;
      entry._linkedTextureBoundFlipV = !!surfaceRef.flipV;
      return entry._linkedTextureBindGroup;
    }

    async function drawFrame() {
      if (!entry._textureLoopActive) { return; }
      syncCanvasSize(canvas);
      var sourceRec = frameRecs[String(sourceFrameId)] || null;
      var sourceEntries = sourceRec && Array.isArray(sourceRec.entries) ? sourceRec.entries : [];
      var renderer = sourceEntries[0] && sourceEntries[0].renderer ? sourceEntries[0].renderer : null;
      if (!renderer || typeof renderer._debugGetSurfaceTextureRef !== "function") {
        syncCanvasSize(canvas);
        entry._textureRaf = requestAnimationFrame(function () { drawFrame(); });
        return;
      }
      try {
        var gpuReady = await ensureGpuViewer();
        var surface = renderer._debugGetSurfaceTextureRef(String(mirrorMeshId || ""));
        if (!gpuReady || !surface || !surface.view) {
          syncCanvasSize(canvas);
          entry._textureRaf = requestAnimationFrame(function () { drawFrame(); });
          return;
        }
        var bg = ensureTextureBindGroup(surface);
        if (!bg) {
          syncCanvasSize(canvas);
          entry._textureRaf = requestAnimationFrame(function () { drawFrame(); });
          return;
        }
        var sg = entry._linkedTextureShared;
        var gpuCtx = entry._linkedTextureCtx;
        var enc = sg.device.createCommandEncoder();
        var pass = enc.beginRenderPass({
          colorAttachments: [{
            view: gpuCtx.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear",
            storeOp: "store"
          }]
        });
        pass.setPipeline(entry._linkedTexturePipeline);
        pass.setBindGroup(0, bg);
        pass.draw(4, 1, 0, 0);
        pass.end();
        sg.device.queue.submit([enc.finish()]);
      } catch (err) {
        vlog("error", "mountLinkedMirrorTextureFrame [" + fid + "]: " + (err && err.message ? err.message : String(err)));
        clearFallback2d();
      }
      entry._textureRaf = requestAnimationFrame(function () { drawFrame(); });
    }

    entry._textureLoopActive = true;
    syncCanvasSize(canvas);
    if (typeof ResizeObserver === "function") {
      var host = canvas.parentElement || canvas;
      entry.resizeObserver = new ResizeObserver(function () {
        if (entry.resizeRaf) { return; }
        entry.resizeRaf = requestAnimationFrame(function () {
          entry.resizeRaf = 0;
          syncCanvasSize(canvas);
        });
      });
      entry.resizeObserver.observe(host);
    }
    ensureGeomFrameEvents(fid);
    schedulePostGeomLayout();
    drawFrame();
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
    r._frameId = String(fid);
    global.__vfFrameRenderers[String(fid)] = r;
    canvas.style.pointerEvents = "none";
    r.init().then(function(ok) {
      if (!ok) {
        entry.initError = global.__vfGeomWgpuLastError || "renderer init returned false";
        vlog("error", "mountLedgerGeomFrame [" + fid + "]: renderer init FAILED");
        return;
      }
      entry.initError = "";
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
      entry.initError = (err && err.message ? err.message : String(err));
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
    var entry = rec.entries && rec.entries[0];
    var renderer = entry && entry.renderer;
    if (
      renderer &&
      renderer._offscreenFrame === true &&
      renderer._device &&
      typeof renderer._renderContent === "function"
    ) {
      try { renderer._renderContent(performance.now()); } catch (_) {}
    }
  }

  function dynamicGeomFrameCanAcceptUpdate(fid) {
    var rec = frameRecs[fid];
    if (!rec || !rec.dynamicAdapter || typeof rec.dynamicAdapter.isDirty !== "function") {
      return false;
    }
    return !rec.dynamicAdapter.isDirty();
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
        drawFrameOrWidgetOps(fid, frames[fid]);
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
      return;
    }
    if (kind === "geom.color.patch") {
      applyGeomColorPatch(payload);
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
    mountOffscreenGeomFrame: mountOffscreenGeomFrame,
    mountLinkedMirrorTextureFrame: mountLinkedMirrorTextureFrame,
    mountLedgerGeomFrame: mountLedgerGeomFrame,
    requestDynamicGeomFrameUpdate: requestDynamicGeomFrameUpdate,
    dynamicGeomFrameCanAcceptUpdate: dynamicGeomFrameCanAcceptUpdate,
    geomFrameStatus: geomFrameStatus,
    geomFrameViewAspect: geomFrameViewAspect,
    __test: {
      buildSingleMesh: buildSingleMesh,
      buildCombinedTriangleMesh: buildCombinedTriangleMesh,
      buildCombinedTransparentMesh: buildCombinedTransparentMesh,
      analyzeSurfaceTextures: analyzeSurfaceTextures
    }
  };
  ensureRuntimeShellLoaded();
  vlog("info", "VfDisplay registered");
})(typeof window !== "undefined" ? window : this);
