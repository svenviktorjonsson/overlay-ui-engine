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
  var _vfAxis3DKernel = global.VfAxis3DKernelAdapter &&
    typeof global.VfAxis3DKernelAdapter.createJsAxis3DKernelAdapter === "function"
      ? global.VfAxis3DKernelAdapter.createJsAxis3DKernelAdapter()
      : (global.VfAxis3DKernel || null);
  var _vfAxis3DProjectionKernelFactory = global.VfAxis3DProjectionKernelAdapter || global.VfAxis3DProjectionKernel || null;
  var _vfAxis3DProjectionKernel = null;

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
  var _vfPointerStreamInflight = false;
  var _vfPointerStreamPending = null;
  var _vfHostInputReady = false;
  var _vfHostInputReadyPosted = false;
  var _vfHostInputReadyTimer = 0;
  var _vfHostInputReadyToken = 0;

  function axis3DKernelMethod(name) {
    return _vfAxis3DKernel && typeof _vfAxis3DKernel[name] === "function"
      ? _vfAxis3DKernel[name]
      : null;
  }

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
      // Route vf_event traffic through HTTP even inside WebView. The native
      // postMessage event path is currently unstable under interaction, while
      // /api/enqueue already carries the same event payloads for the host.
      if (evt && evt.type !== "vf_event" &&
          typeof window !== "undefined" &&
          window.chrome && window.chrome.webview &&
          window.chrome.webview.postMessage) {
        window.chrome.webview.postMessage(evt);
        return;
      }
    } catch (_) {}
    var port = getApiPort();
    if (!port) { return; }  // no port yet — events queued until next hover/click
    var eventName = String(evt && evt.event || "").toLowerCase();
    if (eventName === "hover" || eventName === "move") {
      _vfPointerStreamPending = evt;
      flushPointerStreamEventQueue(port);
      return;
    }
    sendEventToOverlayQueue(port, evt);
  }

  function sendEventToOverlayQueue(port, evt) {
    var body = JSON.stringify({ line: JSON.stringify(evt) });
    try {
      fetch("http://127.0.0.1:" + port + "/api/enqueue", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    body,
      }).catch(function(){});
    } catch(_) {}
  }

  function flushPointerStreamEventQueue(port) {
    if (_vfPointerStreamInflight) { return; }
    if (!_vfPointerStreamPending) { return; }
    _vfPointerStreamInflight = true;
    var evt = _vfPointerStreamPending;
    _vfPointerStreamPending = null;
    var body = JSON.stringify({ line: JSON.stringify(evt) });
    try {
      fetch("http://127.0.0.1:" + port + "/api/enqueue", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    body,
      }).catch(function(){})
        .finally(function () {
          _vfPointerStreamInflight = false;
          if (_vfPointerStreamPending) {
            flushPointerStreamEventQueue(getApiPort() || port);
          }
        });
    } catch(_) {
      _vfPointerStreamInflight = false;
    }
  }

  function notifyHostInputReady() {
    if (_vfHostInputReadyPosted) { return; }
    var port = getApiPort();
    if (!port) { return; }
    _vfHostInputReadyPosted = true;
    try {
      fetch("http://127.0.0.1:" + port + "/api/ui-ready", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{\"source\":\"vf-display\"}"
      }).catch(function(){});
    } catch (_) {}
    _vfHostInputReady = true;
  }

  function scheduleHostInputReady() {
    if (_vfHostInputReadyPosted) { return; }
    _vfHostInputReady = false;
    _vfHostInputReadyToken += 1;
    var token = _vfHostInputReadyToken;
    if (_vfHostInputReadyTimer && typeof global.clearTimeout === "function") {
      global.clearTimeout(_vfHostInputReadyTimer);
    }
    _vfHostInputReadyTimer = global.setTimeout(function () {
      _vfHostInputReadyTimer = 0;
      if (token !== _vfHostInputReadyToken) { return; }
      requestAnimationFrame(function () {
        if (token !== _vfHostInputReadyToken) { return; }
        requestAnimationFrame(function () {
          if (token !== _vfHostInputReadyToken) { return; }
          notifyHostInputReady();
        });
      });
    }, 120);
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
    if (!_vfHostInputReadyPosted) {
      scheduleHostInputReady();
    }
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
    camera.__vf_live_mutated = true;
    geom.camera = camera;
    schedulePlotCameraUpdate(fid);
  }

  function copyLiveAxisTickState(nextCfg, prevCfg) {
    if (!nextCfg || !prevCfg || prevCfg.__vf_live_mutated !== true) { return; }
    nextCfg.x_min = prevCfg.x_min;
    nextCfg.x_max = prevCfg.x_max;
    nextCfg.y_min = prevCfg.y_min;
    nextCfg.y_max = prevCfg.y_max;
    if (Object.prototype.hasOwnProperty.call(prevCfg, "rotation_deg")) {
      nextCfg.rotation_deg = prevCfg.rotation_deg;
    }
    if (Object.prototype.hasOwnProperty.call(prevCfg, "__raw_rotation_deg")) {
      nextCfg.__raw_rotation_deg = prevCfg.__raw_rotation_deg;
    }
    if (Object.prototype.hasOwnProperty.call(prevCfg, "__frozen_box_tick_state")) {
      nextCfg.__frozen_box_tick_state = prevCfg.__frozen_box_tick_state;
    }
    nextCfg.__vf_live_mutated = true;
  }

  function carryForwardLiveGeomState(prevData, nextData) {
    if (!prevData || !nextData || !prevData.geom || !nextData.geom) { return; }
    var nextGeom = nextData.geom;
    var prevGeom = prevData.geom;
    var frameIds = Object.keys(nextGeom);
    for (var fi = 0; fi < frameIds.length; fi += 1) {
      var fid = frameIds[fi];
      var prevFrameGeom = prevGeom[fid];
      var nextFrameGeom = nextGeom[fid];
      if (!prevFrameGeom || !nextFrameGeom) { continue; }
      if (nextFrameGeom.camera && prevFrameGeom.camera && prevFrameGeom.camera.__vf_live_mutated === true) {
        nextFrameGeom.camera = Object.assign({}, nextFrameGeom.camera, prevFrameGeom.camera, { __vf_live_mutated: true });
      }
      var prevMeshes = Array.isArray(prevFrameGeom.meshes) ? prevFrameGeom.meshes : [];
      var nextMeshes = Array.isArray(nextFrameGeom.meshes) ? nextFrameGeom.meshes : [];
      if (!prevMeshes.length || !nextMeshes.length) { continue; }
      var prevById = {};
      for (var pm = 0; pm < prevMeshes.length; pm += 1) {
        var prevMesh = prevMeshes[pm];
        if (!prevMesh || !prevMesh.id) { continue; }
        prevById[String(prevMesh.id)] = prevMesh;
      }
      for (var nm = 0; nm < nextMeshes.length; nm += 1) {
        var nextMesh = nextMeshes[nm];
        if (!nextMesh || !nextMesh.id) { continue; }
        var prevMeshMatch = prevById[String(nextMesh.id)];
        if (!prevMeshMatch) { continue; }
        copyLiveAxisTickState(nextMesh.axis_ticks, prevMeshMatch.axis_ticks);
      }
    }
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

  function rotateVec3AroundAxis(v, axis, angleRad) {
    axis = normalizeVec3Local(axis, [0, 0, 1]);
    var c = Math.cos(Number(angleRad) || 0);
    var s = Math.sin(Number(angleRad) || 0);
    var d = dot3(axis, v);
    var cr = crossVec3(axis, v);
    return [
      v[0] * c + cr[0] * s + axis[0] * d * (1 - c),
      v[1] * c + cr[1] * s + axis[1] * d * (1 - c),
      v[2] * c + cr[2] * s + axis[2] * d * (1 - c)
    ];
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
    if (Array.isArray(rec.axis3DBoundaryLabelPool)) {
      for (var hi = 0; hi < rec.axis3DBoundaryLabelPool.length; hi += 1) {
        if (rec.axis3DBoundaryLabelPool[hi]) { rec.axis3DBoundaryLabelPool[hi].style.display = "none"; }
      }
    }
    return;
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
    var fallbackLo = center - span;
    var fallbackHi = center + span;
    return {
      lo: fallbackLo,
      hi: fallbackHi,
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

  function axis3DCrosshairTickStepCacheKey(cfg, w, h) {
    return [
      "v2",
      "w" + Math.round(Number(w) || 0),
      "h" + Math.round(Number(h) || 0),
      "m" + [cfg.x_mode || "linear", cfg.y_mode || "linear", cfg.z_mode || "linear"].join(","),
      "d" + String(Number(cfg.tick_dist) || 120),
      "min" + String(Number(cfg.min_tick_dist) || 72),
      "max" + String(Number(cfg.max_tick_dist) || 180),
      "fs" + String(Number(cfg.tick_label_font_size) || 11),
      "hints" + JSON.stringify(Array.isArray(cfg.tick_hints) ? cfg.tick_hints : [1, 2, 5])
    ].join(":");
  }

  function axis3DCrosshairTickSteps(fid, cfg, cam, target, axisInfos, w, h, rec3) {
    var stepKey = axis3DCrosshairTickStepCacheKey(cfg, w, h);
    if (rec3 && rec3.axis3DHelperStepCache && rec3.axis3DHelperStepCache.key === stepKey) {
      return rec3.axis3DHelperStepCache.axes || [];
    }
    var hints = Array.isArray(cfg.tick_hints) && cfg.tick_hints.length ? cfg.tick_hints : [1, 2, 5];
    var out = [];
    for (var ai = 0; ai < 3; ai += 1) {
      var axisName = ai === 0 ? "x" : ai === 1 ? "y" : "z";
      var tickMode = String(cfg[axisName + "_mode"] || cfg[axisName + "_tick_mode"] || "linear").toLowerCase();
      var range = axis3DVisibleRange(String(fid), cfg, cam, target, axisName);
      var dataPerPixel = (Number(range.hi) - Number(range.lo)) / Math.max(1, Number(range.pixelSpan) || Math.max(w, h));
      if (!(dataPerPixel > 0)) {
        var infoForStep = axisInfos && axisInfos[ai] || null;
        dataPerPixel = infoForStep && infoForStep.len > 1e-9 ? 1 / infoForStep.len : 1;
      }
      var step = chooseAxisTickStep(
        dataPerPixel,
        Number(cfg.tick_dist) || 120,
        hints,
        Number(cfg.min_tick_dist) || 72,
        Number(cfg.max_tick_dist) || 180
      );
      if (!isLogTickMode(tickMode)) {
        step = chooseReadableLinearTickStep(
          range.lo,
          range.hi,
          step,
          null,
          "linear",
          hints,
          Math.max(1, Number(range.pixelSpan) || Math.max(w, h)),
          Number(cfg.tick_dist) || 120,
          Number(cfg.min_tick_dist) || 72,
          Number(cfg.max_tick_dist) || 180,
          Number(cfg.tick_label_font_size) || 11
        );
      }
      out[ai] = { step: step, mode: tickMode };
    }
    if (rec3) { rec3.axis3DHelperStepCache = { key: stepKey, axes: out }; }
    return out;
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

  function normalizeUndirectedAngleDeg(angleDeg) {
    var angle = Number(angleDeg) || 0;
    while (angle < 0) { angle += 180; }
    while (angle >= 180) { angle -= 180; }
    return angle;
  }

  function undirectedAngleDiffDeg(aDeg, bDeg) {
    var a = normalizeUndirectedAngleDeg(aDeg);
    var b = normalizeUndirectedAngleDeg(bDeg);
    var diff = Math.abs(a - b);
    return Math.min(diff, 180 - diff);
  }

  function nearestAxisSnapAngleDeg(angleDeg, snapTargets) {
    var angle = normalizeUndirectedAngleDeg(angleDeg);
    var targets = Array.isArray(snapTargets) && snapTargets.length ? snapTargets : [0, 90];
    var best = targets[0];
    var bestDiff = undirectedAngleDiffDeg(angle, best);
    for (var i = 1; i < targets.length; i += 1) {
      var diff = undirectedAngleDiffDeg(angle, targets[i]);
      if (diff < bestDiff) {
        best = targets[i];
        bestDiff = diff;
      }
    }
    return { angleDeg: best, diffDeg: bestDiff };
  }

  function snapAngleDegWithinThreshold(rawAngleDeg, thresholdDeg, snapTargets) {
    var nearest = nearestAxisSnapAngleDeg(rawAngleDeg, snapTargets);
    return nearest.diffDeg <= Math.max(0, Number(thresholdDeg) || 0) ? nearest.angleDeg : rawAngleDeg;
  }

  function normalizeSignedAngleDeg(angleDeg) {
    var angle = Number(angleDeg) || 0;
    while (angle <= -180) { angle += 360; }
    while (angle > 180) { angle -= 360; }
    return angle;
  }

  function signedAngleDiffDeg(aDeg, bDeg) {
    return Math.abs(normalizeSignedAngleDeg(aDeg - bDeg));
  }

  function nearestSignedSnapAngleDeg(angleDeg, snapTargets) {
    var angle = normalizeSignedAngleDeg(angleDeg);
    var targets = Array.isArray(snapTargets) && snapTargets.length ? snapTargets : [-180, -90, 0, 90, 180];
    var best = targets[0];
    var bestDiff = signedAngleDiffDeg(angle, best);
    for (var i = 1; i < targets.length; i += 1) {
      var diff = signedAngleDiffDeg(angle, targets[i]);
      if (diff < bestDiff) {
        best = targets[i];
        bestDiff = diff;
      }
    }
    return { angleDeg: normalizeSignedAngleDeg(best), diffDeg: bestDiff };
  }

  function snapSignedAngleDegWithinThreshold(rawAngleDeg, thresholdDeg, snapTargets) {
    var nearest = nearestSignedSnapAngleDeg(rawAngleDeg, snapTargets);
    return nearest.diffDeg <= Math.max(0, Number(thresholdDeg) || 0) ? nearest.angleDeg : rawAngleDeg;
  }

  function axis3DCrosshairCollapsedMarkerState(camera) {
    var pos = vec3Array(camera && camera.pos, [0, 0, 1]);
    var tgt = vec3Array(camera && camera.target, [0, 0, 0]);
    var forward = normalizeVec3Local([tgt[0] - pos[0], tgt[1] - pos[1], tgt[2] - pos[2]], [0, 0, -1]);
    var basisList = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    var best = { axisIndex: 2, sign: 1, absDot: 0, angleDeg: 90 };
    var candidates = [];
    for (var axisIndex = 0; axisIndex < basisList.length; axisIndex += 1) {
      var dot = dot3(basisList[axisIndex], forward);
      var absDot = Math.max(0, Math.min(1, Math.abs(dot)));
      candidates[axisIndex] = {
        axisIndex: axisIndex,
        sign: dot >= 0 ? 1 : -1,
        absDot: absDot,
        angleDeg: Math.acos(absDot) * (180 / Math.PI)
      };
      if (absDot > best.absDot) {
        best = candidates[axisIndex];
      }
    }
    best.candidates = candidates;
    return best;
  }

  function axis3DCrosshairSnapState(rawOrientation, previousSnap, cfg) {
    var hideAngleDeg = Math.max(0, Number(cfg && cfg.axis_direction_hide_angle_deg) || 15);
    var snapAngleDeg = hideAngleDeg;
    var hysteresisDeg = Math.max(0, Number(cfg && cfg.axis_direction_snap_hysteresis_deg) || 2);
    if (!rawOrientation) {
      return {
        raw: null,
        snapped: null,
        hiddenAxisIndex: null,
        hideAngleDeg: hideAngleDeg,
        snapAngleDeg: snapAngleDeg,
        hysteresisDeg: hysteresisDeg
      };
    }
    var snapped = null;
    var previousCandidate = null;
    var previousStillCompetitive = false;
    if (previousSnap && rawOrientation.candidates && rawOrientation.candidates[previousSnap.axisIndex]) {
      previousCandidate = rawOrientation.candidates[previousSnap.axisIndex];
      previousStillCompetitive =
        Number(previousCandidate.angleDeg) <= (snapAngleDeg + hysteresisDeg) &&
        Number(previousCandidate.absDot) >= (Number(rawOrientation.absDot || 0) - 0.02);
    }
    if (previousStillCompetitive) {
      snapped = {
        axisIndex: previousCandidate.axisIndex,
        sign: previousCandidate.sign,
        angleDeg: previousCandidate.angleDeg
      };
    } else if (Number(rawOrientation.angleDeg) <= snapAngleDeg) {
      snapped = {
        axisIndex: rawOrientation.axisIndex,
        sign: rawOrientation.sign,
        angleDeg: rawOrientation.angleDeg
      };
    } else if (
      previousSnap &&
      previousSnap.axisIndex === rawOrientation.axisIndex &&
      Number(rawOrientation.angleDeg) < hideAngleDeg
    ) {
      snapped = {
        axisIndex: previousSnap.axisIndex,
        sign: previousSnap.sign,
        angleDeg: rawOrientation.angleDeg
      };
    }
    return {
      raw: rawOrientation,
      snapped: snapped,
      hiddenAxisIndex: Number(rawOrientation.angleDeg) < hideAngleDeg ? rawOrientation.axisIndex : null,
      hideAngleDeg: hideAngleDeg,
      snapAngleDeg: snapAngleDeg,
      hysteresisDeg: hysteresisDeg
    };
  }

  function axis3DProjectedAxisSnapState(axisInfos, previousState, cfg) {
    var snapAngleDeg = Math.max(0, Number(cfg && cfg.axis_projected_snap_angle_deg) || 5);
    var unsnapAngleDeg = Math.max(snapAngleDeg, Number(cfg && cfg.axis_projected_unsnap_angle_deg) || (snapAngleDeg + 3));
    var pairSnapAngleDeg = Math.max(
      snapAngleDeg,
      Number(cfg && cfg.axis_projected_pair_snap_angle_deg) || Math.max(snapAngleDeg + 4, 12)
    );
    var pairUnsnapAngleDeg = Math.max(
      pairSnapAngleDeg,
      Number(cfg && cfg.axis_projected_pair_unsnap_angle_deg) || Math.max(unsnapAngleDeg + 3, pairSnapAngleDeg + 2)
    );
    var previousRawAngles = Array.isArray(previousState)
      ? previousState
      : (previousState && Array.isArray(previousState.rawAngles) ? previousState.rawAngles : null);
    var previousPairs = previousState && previousState.pairedAxes ? previousState.pairedAxes : null;
    var previousSideSigns = previousState && previousState.sideSigns ? previousState.sideSigns : null;
    var rawAngles = [];
    var deltas = [];
    var hiddenAxes = {};
    var cardinalSnaps = {};
    var pairedAxes = {};
    var sideSigns = {};
    var pairTargets = {};
    var pairLeaders = {};
    for (var i = 0; i < axisInfos.length; i += 1) {
      var info = axisInfos[i];
      if (!info) { rawAngles[i] = null; deltas[i] = 0; continue; }
      var angleDeg = normalizeUndirectedAngleDeg(Math.atan2(info.uy, info.ux) * 180 / Math.PI);
      rawAngles[i] = angleDeg;
      deltas[i] = previousRawAngles && Number.isFinite(previousRawAngles[i])
        ? undirectedAngleDiffDeg(angleDeg, previousRawAngles[i])
        : 0;
      var nearest = nearestAxisSnapAngleDeg(angleDeg, [0, 90]);
      var prevCardinal = previousState && previousState.cardinalSnaps ? previousState.cardinalSnaps[i] : null;
      var samePrevCardinal = prevCardinal != null && Number(prevCardinal) === Number(nearest.angleDeg);
      if (nearest.diffDeg <= snapAngleDeg || (samePrevCardinal && nearest.diffDeg <= unsnapAngleDeg)) {
        cardinalSnaps[i] = nearest.angleDeg;
      }
    }
    for (var a = 0; a < rawAngles.length; a += 1) {
      if (!Number.isFinite(rawAngles[a])) { continue; }
      for (var b = a + 1; b < rawAngles.length; b += 1) {
        if (!Number.isFinite(rawAngles[b])) { continue; }
        var pairDiff = undirectedAngleDiffDeg(rawAngles[a], rawAngles[b]);
        var previouslyPaired = !!(previousPairs && (previousPairs[a] === b || previousPairs[b] === a));
        if (pairDiff > (previouslyPaired ? pairUnsnapAngleDeg : pairSnapAngleDeg)) { continue; }
        pairedAxes[a] = b;
        pairedAxes[b] = a;
        var leader = a;
        var follower = b;
        var deltaA = Math.abs(Number(deltas[a] || 0));
        var deltaB = Math.abs(Number(deltas[b] || 0));
        if (deltaA > deltaB + 1e-6) {
          leader = b;
          follower = a;
        } else if (Math.abs(deltaA - deltaB) <= 1e-6 && b < a) {
          leader = b;
          follower = a;
        }
        var sideA = previousSideSigns && Number(previousSideSigns[a]);
        var sideB = previousSideSigns && Number(previousSideSigns[b]);
        if (!((sideA === -1 && sideB === 1) || (sideA === 1 && sideB === -1))) {
          sideA = -1;
          sideB = 1;
        }
        sideSigns[a] = sideA;
        sideSigns[b] = sideB;
        pairTargets[follower] = rawAngles[leader];
        pairLeaders[follower] = leader;
      }
    }
    return {
      rawAngles: rawAngles,
      deltas: deltas,
      hiddenAxes: hiddenAxes,
      cardinalSnaps: cardinalSnaps,
      pairedAxes: pairedAxes,
      sideSigns: sideSigns,
      pairTargets: pairTargets,
      pairLeaders: pairLeaders,
      snapAngleDeg: snapAngleDeg,
      unsnapAngleDeg: unsnapAngleDeg,
      pairSnapAngleDeg: pairSnapAngleDeg,
      pairUnsnapAngleDeg: pairUnsnapAngleDeg
    };
  }

  function axis3DProjectedAxisSideSign(projectedSnapState, axisIndex, defaultSide) {
    var base = Number(defaultSide) || 0;
    if (!projectedSnapState || !projectedSnapState.sideSigns) { return base; }
    var forced = Number(projectedSnapState.sideSigns[axisIndex]);
    if (forced === 1 || forced === -1) { return forced; }
    return base;
  }

  function drawAxisCollapsedMarker(ctx, cfg, px, py, snappedOrientation, color3) {
    if (!ctx || !snappedOrientation) { return; }
    var r = Math.max(4, Number(cfg && cfg.tick_len_px) || 7);
    ctx.save();
    ctx.strokeStyle = "rgba(" + Math.round(color3[0] * 255) + "," + Math.round(color3[1] * 255) + "," + Math.round(color3[2] * 255) + "," + Math.max(0, Math.min(1, color3[3])) + ")";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = Math.max(0.5, Number(cfg && cfg.width) || 1);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    if (Number(snappedOrientation.sign) > 0) {
      var cr = Math.max(2.2, r * 0.48);
      ctx.moveTo(px - cr, py - cr);
      ctx.lineTo(px + cr, py + cr);
      ctx.moveTo(px + cr, py - cr);
      ctx.lineTo(px - cr, py + cr);
      ctx.stroke();
    } else {
      ctx.arc(px, py, Math.max(1.5, r * 0.28), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function axis3DRuntimeConfig(geom) {
    if (!geom) { return null; }
    if (geom.axis3d_runtime) { return geom.axis3d_runtime; }
    var layers = Array.isArray(geom.frame_layers) ? geom.frame_layers : [];
    for (var i = layers.length - 1; i >= 0; i -= 1) {
      var layer = layers[i] || {};
      if (String(layer.kind || "").toLowerCase() !== "axis") { continue; }
      if (Number(layer.dim) !== 3) { continue; }
      layer.mode = String(layer.variant || layer.mode || "crosshair").toLowerCase();
      return layer;
    }
    return null;
  }

  function axis3DBoxRuntime(geom) {
    var cfg = axis3DRuntimeConfig(geom);
    return cfg && String(cfg.mode || "crosshair").toLowerCase() === "box" ? cfg : null;
  }

  function axis3DDebugEnabled() {
    try {
      var env = global && global.process && global.process.env ? global.process.env : null;
      var raw = env ? String(env.VF_AXIS3D_DEBUG || "") : "";
      return raw && raw !== "0" && raw.toLowerCase() !== "false";
    } catch (_) {
      return false;
    }
  }

  function axis3DDebugLog(msg) {
    if (!axis3DDebugEnabled()) { return; }
    try { console.log("[axis3d]", msg); } catch (_) {}
  }

  function axis3DBoxSpan(cfg, axis) {
    var lo = Number(cfg[axis + "_min"]);
    var hi = Number(cfg[axis + "_max"]);
    return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? hi - lo : 1;
  }

  function axis3DBoxEqualAspect(cfg) {
    if (!cfg) { return true; }
    if (cfg.equal_aspect != null) { return cfg.equal_aspect !== false; }
    var aspect = String(cfg.aspect || "equal").toLowerCase();
    return aspect !== "auto" && aspect !== "fill" && aspect !== "none" && aspect !== "stretched" && aspect !== "stretch";
  }

  function axis3DBoxAspectPoint(cfg, p) {
    if (axis3DBoxEqualAspect(cfg)) { return p; }
    var spans = [axis3DBoxSpan(cfg, "x"), axis3DBoxSpan(cfg, "y"), axis3DBoxSpan(cfg, "z")];
    var maxSpan = Math.max(spans[0], spans[1], spans[2], 1e-12);
    var cx = ((Number(cfg.x_min) || 0) + (Number(cfg.x_max) || 0)) * 0.5;
    var cy = ((Number(cfg.y_min) || 0) + (Number(cfg.y_max) || 0)) * 0.5;
    var cz = ((Number(cfg.z_min) || 0) + (Number(cfg.z_max) || 0)) * 0.5;
    return [
      cx + ((Number(p[0]) - cx) / Math.max(1e-12, spans[0])) * maxSpan,
      cy + ((Number(p[1]) - cy) / Math.max(1e-12, spans[1])) * maxSpan,
      cz + ((Number(p[2]) - cz) / Math.max(1e-12, spans[2])) * maxSpan
    ];
  }

  function axis3DTranslateBoxRange(cfg, delta) {
    var axes = ["x", "y", "z"];
    for (var i = 0; i < axes.length; i += 1) {
      var axis = axes[i];
      var d = Number(delta[i]) || 0;
      var lo = Number(cfg[axis + "_min"]);
      var hi = Number(cfg[axis + "_max"]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) { continue; }
      cfg[axis + "_min"] = lo + d;
      cfg[axis + "_max"] = hi + d;
    }
  }

  function axis3DTranslateBoxAxisRange(cfg, axisIndex, delta) {
    var axis = axisIndex === 0 ? "x" : axisIndex === 1 ? "y" : "z";
    var d = Number(delta) || 0;
    var lo = Number(cfg[axis + "_min"]);
    var hi = Number(cfg[axis + "_max"]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) { return; }
    cfg[axis + "_min"] = lo + d;
    cfg[axis + "_max"] = hi + d;
  }

  function axis3DBoxRangeSnapshot(cfg) {
    return {
      x_min: Number(cfg.x_min),
      x_max: Number(cfg.x_max),
      y_min: Number(cfg.y_min),
      y_max: Number(cfg.y_max),
      z_min: Number(cfg.z_min),
      z_max: Number(cfg.z_max)
    };
  }

  function axis3DBoxApplyAxisDeltaFromSnapshot(cfg, snapshot, axisIndex, delta) {
    if (!snapshot) { axis3DTranslateBoxAxisRange(cfg, axisIndex, delta); return; }
    var axes = ["x", "y", "z"];
    for (var i = 0; i < axes.length; i += 1) {
      var restoreAxis = axes[i];
      var restoreLo = Number(snapshot[restoreAxis + "_min"]);
      var restoreHi = Number(snapshot[restoreAxis + "_max"]);
      if (Number.isFinite(restoreLo) && Number.isFinite(restoreHi) && restoreHi > restoreLo) {
        cfg[restoreAxis + "_min"] = restoreLo;
        cfg[restoreAxis + "_max"] = restoreHi;
      }
    }
    var axis = axisIndex === 0 ? "x" : axisIndex === 1 ? "y" : "z";
    var lo = Number(snapshot[axis + "_min"]);
    var hi = Number(snapshot[axis + "_max"]);
    var d = Number(delta) || 0;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) { return; }
    cfg[axis + "_min"] = lo + d;
    cfg[axis + "_max"] = hi + d;
  }

  function axis3DScaleBoxRange(cfg, factor) {
    factor = Math.max(1e-6, Math.min(1e6, Number(factor) || 1));
    var axes = ["x", "y", "z"];
    for (var i = 0; i < axes.length; i += 1) {
      var axis = axes[i];
      var lo = Number(cfg[axis + "_min"]);
      var hi = Number(cfg[axis + "_max"]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) { continue; }
      var c = (lo + hi) * 0.5;
      var half = Math.max(1e-12, (hi - lo) * factor * 0.5);
      cfg[axis + "_min"] = c - half;
      cfg[axis + "_max"] = c + half;
    }
  }

  function axis3DBoxRangePlan(cfg) {
    return {
      x_min: Number(cfg.x_min),
      x_max: Number(cfg.x_max),
      y_min: Number(cfg.y_min),
      y_max: Number(cfg.y_max),
      z_min: Number(cfg.z_min),
      z_max: Number(cfg.z_max)
    };
  }

  function axis3DApplyBoxRangePlan(cfg, start, target, a) {
    var keys = ["x_min", "x_max", "y_min", "y_max", "z_min", "z_max"];
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      cfg[k] = Number(start[k]) + (Number(target[k]) - Number(start[k])) * a;
    }
  }

  function axis3DBoxDragDataDelta(camera, body, cfg, dx, dy) {
    var boxDragDataDelta = axis3DKernelMethod("boxDragDataDelta");
    if (boxDragDataDelta) {
      var rect0 = body && body.getBoundingClientRect ? body.getBoundingClientRect() : { width: 1, height: 1 };
      return boxDragDataDelta(camera, Number(rect0.width) || 1, Number(rect0.height) || 1, cfg, dx, dy);
    }
    var pos = vec3Array(camera && camera.pos, [4, 4, 5.657]);
    var target = vec3Array(camera && camera.target, [0, 0, 0]);
    var upHint = normalizeVec3Local(camera && camera.up || [0, 0, 1], [0, 0, 1]);
    var backward = normalizeVec3Local([pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]], [0, 0, 1]);
    var right = normalizeVec3Local(crossVec3(upHint, backward), [1, 0, 0]);
    var up = normalizeVec3Local(crossVec3(backward, right), [0, 0, 1]);
    var rect = body && body.getBoundingClientRect ? body.getBoundingClientRect() : { width: 1, height: 1 };
    var pxSpan = Math.max(1, Math.min(Number(rect.width) || 1, Number(rect.height) || 1));
    var dataSpan = Math.max(axis3DBoxSpan(cfg, "x"), axis3DBoxSpan(cfg, "y"), axis3DBoxSpan(cfg, "z"));
    var unitsPerPx = dataSpan / pxSpan;
    return [
      (-dx * right[0] + dy * up[0]) * unitsPerPx,
      (-dx * right[1] + dy * up[1]) * unitsPerPx,
      (-dx * right[2] + dy * up[2]) * unitsPerPx
    ];
  }

  function axis3DRotationCenter(cfg) {
    var rotationCenter = axis3DKernelMethod("rotationCenter");
    if (rotationCenter) {
      return rotationCenter(cfg);
    }
    if (cfg && String(cfg.mode || "crosshair").toLowerCase() === "box") {
      return [
        ((Number(cfg.x_min) || 0) + (Number(cfg.x_max) || 0)) * 0.5,
        ((Number(cfg.y_min) || 0) + (Number(cfg.y_max) || 0)) * 0.5,
        ((Number(cfg.z_min) || 0) + (Number(cfg.z_max) || 0)) * 0.5
      ];
    }
    return [0, 0, 0];
  }

  function axis3DTrackballPoint(px, py, cx, cy, radius) {
    var dx = (Number(px) || 0) - (Number(cx) || 0);
    var dy = (Number(py) || 0) - (Number(cy) || 0);
    var r = Math.max(1, Number(radius) || 1);
    var nx = dx / r;
    var ny = -dy / r;
    var rr = nx * nx + ny * ny;
    if (rr <= 1) {
      return { inside: true, v: [nx, ny, Math.sqrt(Math.max(0, 1 - rr))] };
    }
    var len = Math.sqrt(rr);
    return { inside: false, v: [nx / len, ny / len, 0] };
  }

  function axis3DScreenBasis(camera, center) {
    var screenBasis = axis3DKernelMethod("screenBasis");
    if (screenBasis) {
      return screenBasis(camera, center);
    }
    var pos = vec3Array(camera && camera.pos, [4, 4, 5.657]);
    var target = Array.isArray(center) ? center.slice() : vec3Array(camera && camera.target, [0, 0, 0]);
    var upHint = normalizeVec3Local(camera && camera.up || [0, 0, 1], [0, 0, 1]);
    var forward = normalizeVec3Local([target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]], [0, 0, -1]);
    var right = normalizeVec3Local(crossVec3(forward, upHint), [1, 0, 0]);
    var up = normalizeVec3Local(crossVec3(right, forward), [0, 0, 1]);
    return { right: right, up: up, forward: forward };
  }

  function axis3DApplyWorldRotation(camera, center, worldAxis, angleRad) {
    var applyWorldRotation = axis3DKernelMethod("applyWorldRotation");
    if (applyWorldRotation) {
      return applyWorldRotation(camera, center, worldAxis, angleRad);
    }
    var axis = normalizeVec3Local(worldAxis, [0, 0, 1]);
    var pos = vec3Array(camera && camera.pos, [4, 4, 5.657]);
    var target = Array.isArray(center) ? center.slice() : [0, 0, 0];
    var offset = [pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]];
    var nextOffset = rotateVec3AroundAxis(offset, axis, angleRad);
    var nextUp = rotateVec3AroundAxis(vec3Array(camera && camera.up, [0, 0, 1]), axis, angleRad);
    camera.pos = [target[0] + nextOffset[0], target[1] + nextOffset[1], target[2] + nextOffset[2]];
    camera.target = target;
    camera.up = normalizeVec3Local(nextUp, [0, 0, 1]);
  }

  function axis3DCloneCamera(camera) {
    var cloneCamera = axis3DKernelMethod("cloneCamera");
    if (cloneCamera) {
      return cloneCamera(camera);
    }
    var out = Object.assign({}, camera || {});
    out.pos = vec3Array(camera && camera.pos, [4, 4, 5.657]);
    out.target = vec3Array(camera && camera.target, [0, 0, 0]);
    out.up = vec3Array(camera && camera.up, [0, 0, 1]);
    return out;
  }

  function axis3DProjectionKernelDeps() {
    return {
      rotationCenter: axis3DRotationCenter,
      projectWorldToPixel: projectWorldToPixel,
      clipPixelLineToRect: clipPixelLineToRect,
      cloneCamera: axis3DCloneCamera,
      screenBasis: axis3DScreenBasis,
      applyWorldRotation: axis3DApplyWorldRotation
    };
  }

  function ensureAxis3DProjectionKernel() {
    if (!_vfAxis3DProjectionKernel && _vfAxis3DProjectionKernelFactory &&
        typeof _vfAxis3DProjectionKernelFactory.createJsAxis3DProjectionKernelAdapter === "function") {
      _vfAxis3DProjectionKernel = _vfAxis3DProjectionKernelFactory.createJsAxis3DProjectionKernelAdapter(
        axis3DProjectionKernelDeps()
      );
    } else if (!_vfAxis3DProjectionKernel && _vfAxis3DProjectionKernelFactory &&
        typeof _vfAxis3DProjectionKernelFactory.createProjectionKernel === "function") {
      _vfAxis3DProjectionKernel = _vfAxis3DProjectionKernelFactory.createProjectionKernel(
        axis3DProjectionKernelDeps()
      );
    }
    return _vfAxis3DProjectionKernel;
  }

  function axis3DProjectionKernelMethod(name) {
    var kernel = ensureAxis3DProjectionKernel();
    return kernel && typeof kernel[name] === "function"
      ? kernel[name]
      : null;
  }

  function axis3DProjectedAxisInfos(camera, body, cfg) {
    var projectedAxisInfos = axis3DProjectionKernelMethod("projectedAxisInfos");
    if (projectedAxisInfos) {
      var rect0 = body && body.getBoundingClientRect ? body.getBoundingClientRect() : { width: 1, height: 1 };
      return projectedAxisInfos(camera, rect0, cfg);
    }
    var rect = body && body.getBoundingClientRect ? body.getBoundingClientRect() : { width: 1, height: 1 };
    var w = Math.max(1, Number(rect.width) || 1);
    var h = Math.max(1, Number(rect.height) || 1);
    var center = axis3DRotationCenter(cfg || {});
    var cam = Object.assign({}, camera || {}, {
      viewport_width_px: w,
      viewport_height_px: h
    });
    var p0 = projectWorldToPixel(cam, w, h, center);
    if (!p0) { return null; }
    var reach = Math.max(w, h) * 4.0;
    var axisInfos = [];
    function axisLineInfo(axisIndex) {
      var next = center.slice();
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
        centerValue: Number(center[axisIndex]) || 0
      };
    }
    for (var axisIndex = 0; axisIndex < 3; axisIndex += 1) {
      axisInfos[axisIndex] = axisLineInfo(axisIndex);
    }
    return {
      rect: rect,
      w: w,
      h: h,
      center: center,
      p0: p0,
      axisInfos: axisInfos
    };
  }

  function axis3DProjectedAxisAngleDeg(info) {
    var projectedAxisAngleDeg = axis3DProjectionKernelMethod("projectedAxisAngleDeg");
    if (projectedAxisAngleDeg) {
      return projectedAxisAngleDeg(info);
    }
    if (!info) { return null; }
    return normalizeUndirectedAngleDeg(Math.atan2(info.uy, info.ux) * 180 / Math.PI);
  }

  function axis3DProjectedAxisDiffDeg(camera, body, cfg, axisIndex, targetAngleDeg) {
    var projectedAxisDiffDeg = axis3DProjectionKernelMethod("projectedAxisDiffDeg");
    if (projectedAxisDiffDeg) {
      var rect1 = body && body.getBoundingClientRect ? body.getBoundingClientRect() : { width: 1, height: 1 };
      return projectedAxisDiffDeg(camera, rect1, cfg, axisIndex, targetAngleDeg);
    }
    var projected = axis3DProjectedAxisInfos(camera, body, cfg);
    if (!projected || !projected.axisInfos[axisIndex]) { return Infinity; }
    var angleDeg = axis3DProjectedAxisAngleDeg(projected.axisInfos[axisIndex]);
    return nearestAxisSnapAngleDeg(angleDeg, [targetAngleDeg]).diffDeg;
  }

  function axis3DAlignProjectedAxisToScreenSnap(camera, body, cfg, axisIndex, targetAngleDeg) {
    var alignProjectedAxisToScreenSnap = axis3DProjectionKernelMethod("alignProjectedAxisToScreenSnap");
    if (alignProjectedAxisToScreenSnap) {
      var rect2 = body && body.getBoundingClientRect ? body.getBoundingClientRect() : { width: 1, height: 1 };
      return alignProjectedAxisToScreenSnap(camera, rect2, cfg, axisIndex, targetAngleDeg);
    }
    var projected = axis3DProjectedAxisInfos(camera, body, cfg);
    if (!projected || !projected.axisInfos[axisIndex]) { return false; }
    var rawAngle = axis3DProjectedAxisAngleDeg(projected.axisInfos[axisIndex]);
    var nearest = nearestAxisSnapAngleDeg(rawAngle, [targetAngleDeg]);
    if (!(nearest.diffDeg > 1e-6)) { return false; }
    var magnitudeRad = nearest.diffDeg * Math.PI / 180;
    var best = null;
    for (var si = 0; si < 2; si += 1) {
      var sign = si === 0 ? 1 : -1;
      var trial = axis3DCloneCamera(camera);
      var basis = axis3DScreenBasis(trial, projected.center);
      axis3DApplyWorldRotation(trial, projected.center, basis.forward, sign * magnitudeRad);
      var diff = axis3DProjectedAxisDiffDeg(trial, body, cfg, axisIndex, targetAngleDeg);
      if (!best || diff < best.diff) {
        best = { sign: sign, diff: diff };
      }
    }
    if (!best) { return false; }
    var liveBasis = axis3DScreenBasis(camera, projected.center);
    axis3DApplyWorldRotation(camera, projected.center, liveBasis.forward, best.sign * magnitudeRad);
    return true;
  }

  function axis3DAlignAxisToViewSnap(camera, cfg, axisIndex, sign) {
    var alignAxisToViewSnap = axis3DKernelMethod("alignAxisToViewSnap");
    if (alignAxisToViewSnap) {
      return alignAxisToViewSnap(camera, cfg, axisIndex, sign);
    }
    var center = axis3DRotationCenter(cfg || {});
    var pos = vec3Array(camera && camera.pos, [4, 4, 5.657]);
    var tgt = vec3Array(camera && camera.target, center);
    var forward = normalizeVec3Local([tgt[0] - pos[0], tgt[1] - pos[1], tgt[2] - pos[2]], [0, 0, -1]);
    var basisAxes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    var desired = basisAxes[axisIndex] ? basisAxes[axisIndex].slice() : [0, 0, 1];
    var desiredSign = Number(sign) || 1;
    desired = [desired[0] * desiredSign, desired[1] * desiredSign, desired[2] * desiredSign];
    var dot = Math.max(-1, Math.min(1, dot3(forward, desired)));
    var angle = Math.acos(dot);
    if (!(angle > 1e-6)) { return false; }
    var axis = crossVec3(forward, desired);
    var axisLen = Math.sqrt(dot3(axis, axis));
    if (!(axisLen > 1e-9)) {
      var basis = axis3DScreenBasis(camera, center);
      axis = crossVec3(forward, basis.right);
      axisLen = Math.sqrt(dot3(axis, axis));
      if (!(axisLen > 1e-9)) { return false; }
    }
    axis3DApplyWorldRotation(camera, center, [axis[0] / axisLen, axis[1] / axisLen, axis[2] / axisLen], angle);
    return true;
  }

  function axis3DCameraFinite(camera) {
    if (!camera) { return false; }
    var pos = vec3Array(camera.pos, []);
    var target = vec3Array(camera.target, []);
    var up = vec3Array(camera.up, []);
    var values = pos.concat(target, up);
    for (var i = 0; i < values.length; i += 1) {
      if (!Number.isFinite(values[i])) { return false; }
    }
    return values.length >= 9;
  }

  function axis3DFormatCameraSummary(camera) {
    if (!camera) { return "camera=null"; }
    function fmt3(v) {
      var a = vec3Array(v, [0, 0, 0]);
      return "[" + a.map(function (n) {
        return Number.isFinite(n) ? Number(n).toFixed(4) : String(n);
      }).join(",") + "]";
    }
    return "pos=" + fmt3(camera.pos) + " target=" + fmt3(camera.target) + " up=" + fmt3(camera.up);
  }

  function axis3DLogRotateDiag(stage, camera, extra) {
    try {
      vlog("warn", "[axis3d-rotate] " + String(stage) + " " + axis3DFormatCameraSummary(camera) + (extra ? " " + String(extra) : ""));
    } catch (_) {}
  }

  function axis3DApplySnapPostConstraint(camera, cfg, body, dx, dy, dragState) {
    var projected = axis3DProjectedAxisInfos(camera, body, cfg);
    var snappedViewState = axis3DCrosshairSnapState(
      axis3DCrosshairCollapsedMarkerState(camera),
      dragState ? dragState.axis3DLockedViewSnap || null : null,
      cfg
    );
    if (dragState) {
      dragState.axis3DLockedViewSnap = snappedViewState.snapped;
    }
    if (dragState && (Number(dragState.sampleCount || 0) % 12) === 0) {
      axis3DLogRotateDiag(
        "pre-snap",
        camera,
        "viewSnap=" + JSON.stringify(snappedViewState && snappedViewState.snapped || null)
      );
    }
    if (snappedViewState && snappedViewState.snapped) {
      axis3DAlignAxisToViewSnap(camera, cfg, snappedViewState.snapped.axisIndex, snappedViewState.snapped.sign);
    }
    if (!axis3DCameraFinite(camera)) {
      axis3DLogRotateDiag("nonfinite-after-view-snap", camera, "dx=" + Number(dx || 0) + " dy=" + Number(dy || 0));
    }
    projected = axis3DProjectedAxisInfos(camera, body, cfg);
    if (!projected) { return false; }
    var axisInfos = projected.axisInfos;
    var projectedSnapState = axis3DProjectedAxisSnapState(
      axisInfos,
      dragState && Array.isArray(dragState.axis3DProjectedSnapRawAngles) ? dragState.axis3DProjectedSnapRawAngles : null,
      cfg
    );
    if (dragState) {
      dragState.axis3DProjectedSnapState = projectedSnapState;
    }
    var bestCardinal = null;
    for (var axisIndex = 0; axisIndex < axisInfos.length; axisIndex += 1) {
      var info = axisInfos[axisIndex];
      if (!info) { continue; }
      if (projectedSnapState.cardinalSnaps[axisIndex] == null) { continue; }
      var nx = -info.uy;
      var ny = info.ux;
      var component = (Number(dx) || 0) * nx + (Number(dy) || 0) * ny;
      if (!bestCardinal || Math.abs(component) > Math.abs(bestCardinal.component)) {
        bestCardinal = {
          axisIndex: axisIndex,
          targetAngleDeg: projectedSnapState.cardinalSnaps[axisIndex],
          component: component
        };
      }
    }
    if (!bestCardinal || Math.abs(bestCardinal.component) <= 1e-6) { return false; }
    var aligned = axis3DAlignProjectedAxisToScreenSnap(camera, body, cfg, bestCardinal.axisIndex, bestCardinal.targetAngleDeg);
    projected = axis3DProjectedAxisInfos(camera, body, cfg);
    if (projected && projected.axisInfos) {
      projectedSnapState = axis3DProjectedAxisSnapState(
        projected.axisInfos,
        dragState && dragState.axis3DProjectedSnapState ? dragState.axis3DProjectedSnapState : projectedSnapState,
        cfg
      );
      if (dragState) {
        dragState.axis3DProjectedSnapState = projectedSnapState;
      }
      var bestPairFollower = null;
      if (projectedSnapState && projectedSnapState.pairTargets) {
        for (var pairFollowerKey in projectedSnapState.pairTargets) {
          if (!Object.prototype.hasOwnProperty.call(projectedSnapState.pairTargets, pairFollowerKey)) { continue; }
          var followerIndex = Number(pairFollowerKey);
          var targetAngle = Number(projectedSnapState.pairTargets[pairFollowerKey]);
          if (!Number.isFinite(followerIndex) || !Number.isFinite(targetAngle)) { continue; }
          var followerDelta = Math.abs(Number(projectedSnapState.deltas && projectedSnapState.deltas[followerIndex] || 0));
          if (!bestPairFollower || followerDelta > bestPairFollower.delta) {
            bestPairFollower = {
              axisIndex: followerIndex,
              targetAngleDeg: targetAngle,
              delta: followerDelta
            };
          }
        }
      }
      if (bestPairFollower) {
        aligned = axis3DAlignProjectedAxisToScreenSnap(
          camera,
          body,
          cfg,
          bestPairFollower.axisIndex,
          bestPairFollower.targetAngleDeg
        ) || aligned;
      }
    }
    if (!axis3DCameraFinite(camera)) {
      axis3DLogRotateDiag(
        "nonfinite-after-projected-snap",
        camera,
        "cardinal=" + JSON.stringify(bestCardinal)
      );
    }
    return aligned;
  }

  function axis3DIncrementalRotateComponents(camera, cfg, dx, dy, body, dragState) {
    var rect = body && body.getBoundingClientRect ? body.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
    var w = Math.max(1, Number(rect.width) || 1);
    var h = Math.max(1, Number(rect.height) || 1);
    var scale = Math.PI / Math.max(120, Math.min(w, h));
    var center = axis3DRotationCenter(cfg || {});
    var basis = axis3DScreenBasis(camera, center);
    var moveX = Number(dx) || 0;
    var moveY = Number(dy) || 0;
    var sampleLen = Math.sqrt(moveX * moveX + moveY * moveY);
    if (!(sampleLen > 1e-6)) { return null; }
    var isBox = String(cfg && cfg.mode || "crosshair").toLowerCase() === "box";
    var snapState = isBox ? null : axis3DCrosshairSnapState(axis3DCrosshairCollapsedMarkerState(camera), null, cfg || {});
    var projected = axis3DProjectedAxisInfos(camera, body, cfg || {});
    if (!projected || !projected.p0) { return null; }
    var curPx = Number(dragState && dragState.x) - Number(rect.left || 0);
    var curPy = Number(dragState && dragState.y) - Number(rect.top || 0);
    var prevPx = curPx - moveX;
    var prevPy = curPy - moveY;
    var rx = curPx - projected.p0[0];
    var ry = curPy - projected.p0[1];
    var rLen = Math.sqrt(rx * rx + ry * ry);
    if (!(rLen > 1e-6)) {
      rx = prevPx - projected.p0[0];
      ry = prevPy - projected.p0[1];
      rLen = Math.sqrt(rx * rx + ry * ry);
    }
    if (!(rLen > 1e-6)) { return null; }
    var radialUx = rx / rLen;
    var radialUy = ry / rLen;
    var tangentialUx = radialUy;
    var tangentialUy = -radialUx;
    var tangentialComponent = moveX * tangentialUx + moveY * tangentialUy;
    var radialComponent = moveX * radialUx + moveY * radialUy;
    var tangentialAxis = basis.forward.slice();
    if (snapState && snapState.snapped) {
      var basisAxes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      var snappedAxis = basisAxes[snapState.snapped.axisIndex] || [0, 0, 1];
      tangentialAxis = [
        snappedAxis[0] * Number(snapState.snapped.sign || 1),
        snappedAxis[1] * Number(snapState.snapped.sign || 1),
        snappedAxis[2] * Number(snapState.snapped.sign || 1)
      ];
    }
    var coaxialAxis = tangentialAxis.slice();
    var radialWorld = normalizeVec3Local([
      basis.right[0] * radialUx + basis.up[0] * (-radialUy),
      basis.right[1] * radialUx + basis.up[1] * (-radialUy),
      basis.right[2] * radialUx + basis.up[2] * (-radialUy)
    ], basis.right);
    var radialAxis = crossVec3(coaxialAxis, radialWorld);
    var radialAxisLen = Math.sqrt(dot3(radialAxis, radialAxis));
    if (!(radialAxisLen > 1e-9)) {
      radialAxis = [0, 0, 0];
    } else {
      radialAxis = [radialAxis[0] / radialAxisLen, radialAxis[1] / radialAxisLen, radialAxis[2] / radialAxisLen];
    }
    return {
      scale: scale,
      center: center,
      tangentialComponent: tangentialComponent,
      radialComponent: radialComponent,
      tangentialAxis: tangentialAxis,
      radialAxis: radialAxis,
      snapState: snapState
    };
  }

  function axis3DChooseLockedWorldAxis(camera, cfg, body, startAxisIndex, dx, dy, dragState) {
    var totalState = Object.assign({}, dragState || {}, {
      x: Number(dragState && dragState.x) || 0,
      y: Number(dragState && dragState.y) || 0,
      pendingX: Number(dragState && dragState.x) || 0,
      pendingY: Number(dragState && dragState.y) || 0
    });
    var comps = axis3DIncrementalRotateComponents(camera, cfg, dx, dy, body, totalState);
    if (!comps) { return null; }
    var combined = [
      comps.tangentialAxis[0] * comps.tangentialComponent + comps.radialAxis[0] * comps.radialComponent,
      comps.tangentialAxis[1] * comps.tangentialComponent + comps.radialAxis[1] * comps.radialComponent,
      comps.tangentialAxis[2] * comps.tangentialComponent + comps.radialAxis[2] * comps.radialComponent
    ];
    var axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    var best = null;
    for (var i = 0; i < 3; i += 1) {
      if (i === startAxisIndex) { continue; }
      var score = Math.abs(dot3(combined, axes[i]));
      if (!best || score > best.score) {
        best = { axisIndex: i, score: score };
      }
    }
    return best && best.score > 1e-6 ? best : null;
  }

  function axis3DApplyRawDragRotation(rawCamera, cfg, dx, dy, body, dragState) {
    var comps = axis3DIncrementalRotateComponents(rawCamera, cfg || {}, dx, dy, body, dragState);
    if (!comps) { return; }
    if (
      dragState &&
      Number.isFinite(dragState.rotateStartAxisIndex) &&
      dragState.rotateLockMode == null &&
      Number(dragState.sampleCount || 0) < axisGestureSampleCount(cfg || {})
    ) {
      return;
    }
    if (
      dragState &&
      Number.isFinite(dragState.rotateStartAxisIndex) &&
      dragState.rotateLockMode == null &&
      Number(dragState.sampleCount || 0) >= axisGestureSampleCount(cfg || {})
    ) {
      dragState.rotateLockMode = axis3DChooseLockedWorldAxis(
        rawCamera,
        cfg || {},
        body,
        Number(dragState.rotateStartAxisIndex),
        Number(dragState.totalDx || 0),
        Number(dragState.totalDy || 0),
        dragState
      ) || { kind: "free", axisIndex: Number(dragState.rotateStartAxisIndex) };
    }

    if (dragState && dragState.rotateLockMode && dragState.rotateLockMode.kind !== "free") {
      var lockAxis = dragState.rotateLockMode;
      var basisAxis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]][lockAxis.axisIndex];
      var angle = dot3([
        comps.tangentialAxis[0] * comps.tangentialComponent * comps.scale + comps.radialAxis[0] * comps.radialComponent * comps.scale,
        comps.tangentialAxis[1] * comps.tangentialComponent * comps.scale + comps.radialAxis[1] * comps.radialComponent * comps.scale,
        comps.tangentialAxis[2] * comps.tangentialComponent * comps.scale + comps.radialAxis[2] * comps.radialComponent * comps.scale
      ], basisAxis);
      if (Math.abs(angle) <= 1e-6) { return; }
      axis3DApplyWorldRotation(
        rawCamera,
        comps.center,
        basisAxis,
        angle
      );
      return;
    }
    if (Math.abs(comps.tangentialComponent) > 1e-6) {
      axis3DApplyWorldRotation(rawCamera, comps.center, comps.tangentialAxis, comps.tangentialComponent * comps.scale);
    }
    if (Math.abs(comps.radialComponent) > 1e-6 && (Math.abs(comps.radialAxis[0]) + Math.abs(comps.radialAxis[1]) + Math.abs(comps.radialAxis[2])) > 1e-9) {
      axis3DApplyWorldRotation(rawCamera, comps.center, comps.radialAxis, comps.radialComponent * comps.scale);
    }
  }

  function axis3DRotateCameraDrag(camera, cfg, dx, dy, body, snap15, dragState) {
    if (dragState) {
      dragState.rawYawRad = NaN;
      dragState.rawPitchRad = NaN;
    }
    var rawCamera = dragState && dragState.axis3DRawCamera
      ? axis3DCloneCamera(dragState.axis3DRawCamera)
      : axis3DCloneCamera(camera);
    axis3DApplyRawDragRotation(rawCamera, cfg || {}, dx, dy, body, dragState);
    if (!axis3DCameraFinite(rawCamera)) {
      axis3DLogRotateDiag("nonfinite-after-raw-rotate", rawCamera, "dx=" + Number(dx || 0) + " dy=" + Number(dy || 0));
    }
    if (dragState) {
      dragState.axis3DRawCamera = axis3DCloneCamera(rawCamera);
    }
    camera.pos = rawCamera.pos.slice();
    camera.target = rawCamera.target.slice();
    camera.up = rawCamera.up.slice();
    axis3DApplySnapPostConstraint(camera, cfg || {}, body, dx, dy, dragState);
    if (!axis3DCameraFinite(camera)) {
      axis3DLogRotateDiag("nonfinite-after-rotate", camera, "dx=" + Number(dx || 0) + " dy=" + Number(dy || 0));
    }
  }

  function applyAxis3DSelectionZoom(fid, body, drag) {
    var geom = _lastDisplayPayload && _lastDisplayPayload.geom ? _lastDisplayPayload.geom[fid] : null;
    if (!geom) { return; }
    var cfg = axis3DBoxRuntime(geom);
    var rect = body && body.getBoundingClientRect ? body.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
    var w = Math.max(1, Number(rect.width) || 1);
    var h = Math.max(1, Number(rect.height) || 1);
    var x0 = Math.max(0, Math.min(w, Math.min(Number(drag.startX || 0), Number(drag.pendingX || drag.x || 0)) - Number(rect.left || 0)));
    var x1 = Math.max(0, Math.min(w, Math.max(Number(drag.startX || 0), Number(drag.pendingX || drag.x || 0)) - Number(rect.left || 0)));
    var y0 = Math.max(0, Math.min(h, Math.min(Number(drag.startY || 0), Number(drag.pendingY || drag.y || 0)) - Number(rect.top || 0)));
    var y1 = Math.max(0, Math.min(h, Math.max(Number(drag.startY || 0), Number(drag.pendingY || drag.y || 0)) - Number(rect.top || 0)));
    if ((x1 - x0) < 8 || (y1 - y0) < 8) { return; }
    var frac = Math.max((x1 - x0) / w, (y1 - y0) / h);
    frac = Math.max(0.02, Math.min(1, frac));
    if (cfg) {
      unfreezeAxis3DBoxTickPlacement(cfg);
      var start = axis3DBoxRangePlan(cfg);
      var target = {};
      var axes = ["x", "y", "z"];
      for (var ai = 0; ai < axes.length; ai += 1) {
        var axis = axes[ai];
        var lo = Number(start[axis + "_min"]);
        var hi = Number(start[axis + "_max"]);
        var c = (lo + hi) * 0.5;
        var half = (hi - lo) * frac * 0.5;
        target[axis + "_min"] = c - half;
        target[axis + "_max"] = c + half;
      }
      animateAxisRanges(300, function (a) {
        axis3DApplyBoxRangePlan(cfg, start, target, a);
        repaintAxis3DHelperLines(fid);
      });
      return;
    }
    animateAxisRanges(300, function (a) {
      mutateAxis3DCamera(fid, function (camera) {
        var factor = 1 - (1 - frac) * a;
        if (String(camera.projection || "").toLowerCase() === "orthographic") {
          camera.ortho_scale = Math.max(1e-6, Number(camera.ortho_scale || 2.5) * factor);
        }
      }, { skipTextOverlay: true });
      repaintAxis3DHelperLines(fid);
    });
  }

  function axis3DBoxScreenAxisDirections(camera, body, cfg) {
    var rect = body && body.getBoundingClientRect ? body.getBoundingClientRect() : { width: 1, height: 1 };
    var w = Math.max(1, Number(rect.width) || 1);
    var h = Math.max(1, Number(rect.height) || 1);
    var cam = Object.assign({}, camera || {}, {
      viewport_width_px: w,
      viewport_height_px: h
    });
    var cx = ((Number(cfg.x_min) || 0) + (Number(cfg.x_max) || 0)) * 0.5;
    var cy = ((Number(cfg.y_min) || 0) + (Number(cfg.y_max) || 0)) * 0.5;
    var cz = ((Number(cfg.z_min) || 0) + (Number(cfg.z_max) || 0)) * 0.5;
    var center = [cx, cy, cz];
    var p0 = projectWorldToPixel(cam, w, h, center);
    if (!p0) { return []; }
    var xMin = Number(cfg.x_min);
    var xMax = Number(cfg.x_max);
    var yMin = Number(cfg.y_min);
    var yMax = Number(cfg.y_max);
    var zMin = Number(cfg.z_min);
    var zMax = Number(cfg.z_max);
    var corners = [
      [xMin, yMin, zMin], [xMax, yMin, zMin], [xMin, yMax, zMin], [xMax, yMax, zMin],
      [xMin, yMin, zMax], [xMax, yMin, zMax], [xMin, yMax, zMax], [xMax, yMax, zMax]
    ].map(function (p) { return projectWorldToPixel(cam, w, h, axis3DBoxAspectPoint(cfg, p)); }).filter(function (p) {
      return p && Number.isFinite(p[0]) && Number.isFinite(p[1]);
    });
    var fitScale = 1;
    if (corners.length >= 2) {
      var minX = corners[0][0];
      var maxX = corners[0][0];
      var minY = corners[0][1];
      var maxY = corners[0][1];
      for (var ci = 1; ci < corners.length; ci += 1) {
        minX = Math.min(minX, corners[ci][0]);
        maxX = Math.max(maxX, corners[ci][0]);
        minY = Math.min(minY, corners[ci][1]);
        maxY = Math.max(maxY, corners[ci][1]);
      }
      var fitMargin = Math.max(24, Number(cfg.fit_margin_px) || 48);
      fitScale = Math.min(
        Math.max(1, w - 2 * fitMargin) / Math.max(1e-6, maxX - minX),
        Math.max(1, h - 2 * fitMargin) / Math.max(1e-6, maxY - minY)
      );
      if (!Number.isFinite(fitScale) || !(fitScale > 0)) { fitScale = 1; }
    }
    var spans = [axis3DBoxSpan(cfg, "x"), axis3DBoxSpan(cfg, "y"), axis3DBoxSpan(cfg, "z")];
    var out = [];
    for (var i = 0; i < 3; i += 1) {
      var p = center.slice();
      p[i] += spans[i] * 0.5;
      var p1 = projectWorldToPixel(cam, w, h, axis3DBoxAspectPoint(cfg, p));
      if (!p1) { continue; }
      var dx = p1[0] - p0[0];
      var dy = p1[1] - p0[1];
      var len = Math.sqrt(dx * dx + dy * dy);
      if (!(len > 1e-6)) { continue; }
      out.push({ axisIndex: i, ux: dx / len, uy: dy / len, pxPerUnit: (len * fitScale) / Math.max(1e-12, spans[i] * 0.5) });
    }
    return out;
  }

  function axis3DBoxPixelProjector(camera, w, h, cfg) {
    var cam = Object.assign({}, camera || {}, {
      viewport_width_px: w,
      viewport_height_px: h
    });
    var xMin = Number(cfg.x_min);
    var xMax = Number(cfg.x_max);
    var yMin = Number(cfg.y_min);
    var yMax = Number(cfg.y_max);
    var zMin = Number(cfg.z_min);
    var zMax = Number(cfg.z_max);
    if (![xMin, xMax, yMin, yMax, zMin, zMax].every(Number.isFinite)) { return null; }
    var corners = [
      [xMin, yMin, zMin], [xMax, yMin, zMin], [xMin, yMax, zMin], [xMax, yMax, zMin],
      [xMin, yMin, zMax], [xMax, yMin, zMax], [xMin, yMax, zMax], [xMax, yMax, zMax]
    ];
    var rawPixels = corners.map(function (p) { return projectWorldToPixel(cam, w, h, axis3DBoxAspectPoint(cfg, p)); });
    var finitePixels = rawPixels.filter(function (p) {
      return p && Number.isFinite(p[0]) && Number.isFinite(p[1]);
    });
    if (finitePixels.length < 2) { return null; }
    var minX = finitePixels[0][0];
    var maxX = finitePixels[0][0];
    var minY = finitePixels[0][1];
    var maxY = finitePixels[0][1];
    for (var i = 1; i < finitePixels.length; i += 1) {
      minX = Math.min(minX, finitePixels[i][0]);
      maxX = Math.max(maxX, finitePixels[i][0]);
      minY = Math.min(minY, finitePixels[i][1]);
      maxY = Math.max(maxY, finitePixels[i][1]);
    }
    var rawCx = (minX + maxX) * 0.5;
    var rawCy = (minY + maxY) * 0.5;
    var rawW = Math.max(1e-6, maxX - minX);
    var rawH = Math.max(1e-6, maxY - minY);
    var fitMargin = Math.max(24, Number(cfg.fit_margin_px) || 48);
    var fitScale = Math.min(
      Math.max(1, w - 2 * fitMargin) / rawW,
      Math.max(1, h - 2 * fitMargin) / rawH
    );
    if (!Number.isFinite(fitScale) || !(fitScale > 0)) { fitScale = 1; }
    return function projectBoxPixel(p) {
      var raw = projectWorldToPixel(cam, w, h, axis3DBoxAspectPoint(cfg, p));
      if (!raw) { return null; }
      return [
        (w * 0.5) + (raw[0] - rawCx) * fitScale,
        (h * 0.5) + (raw[1] - rawCy) * fitScale
      ];
    };
  }

  function axis3DScreenAxisDirections(camera, body, cfg) {
    var rect = body && body.getBoundingClientRect ? body.getBoundingClientRect() : { width: 1, height: 1 };
    var w = Math.max(1, Number(rect.width) || 1);
    var h = Math.max(1, Number(rect.height) || 1);
    var cam = Object.assign({}, camera || {}, {
      viewport_width_px: w,
      viewport_height_px: h
    });
    var origin = [0, 0, 0];
    var p0 = projectWorldToPixel(cam, w, h, origin);
    if (!p0) { return []; }
    var out = [];
    for (var i = 0; i < 3; i += 1) {
      var p = [0, 0, 0];
      p[i] = 1;
      var p1 = projectWorldToPixel(cam, w, h, p);
      if (!p1) { continue; }
      var dx = p1[0] - p0[0];
      var dy = p1[1] - p0[1];
      var len = Math.sqrt(dx * dx + dy * dy);
      if (!(len > 1e-6)) { continue; }
      out.push({ axisIndex: i, ux: dx / len, uy: dy / len });
    }
    return out;
  }

  function axis3DLockedDragAxisFromDirs(dirs, dx, dy, thresholdDeg) {
    var dragLen = Math.sqrt(dx * dx + dy * dy);
    if (!(dragLen > 1e-6)) { return null; }
    var thresholdCos = Math.cos((Number(thresholdDeg) || 5) * Math.PI / 180);
    var best = null;
    for (var i = 0; i < dirs.length; i += 1) {
      var d = dirs[i];
      var dot = ((Number(dx) || 0) * d.ux + (Number(dy) || 0) * d.uy) / dragLen;
      var score = Math.abs(dot);
      if (!best || score > best.score) {
        best = { axisIndex: d.axisIndex, dot: dot, score: score, ux: d.ux, uy: d.uy, pxPerUnit: d.pxPerUnit };
      }
    }
    if (!best || best.score < thresholdCos) { return null; }
    return best;
  }

  function axis3DLockedRotateAxisFromStartAxis(camera, body, cfg, axisIndex, dx, dy, thresholdDeg) {
    var dirs = axis3DScreenAxisDirections(camera, body, cfg || {});
    var dragLen = Math.sqrt(dx * dx + dy * dy);
    if (!(dragLen > 1e-6)) { return null; }
    var thresholdSin = Math.sin((Number(thresholdDeg) || 5) * Math.PI / 180);
    var startDir = null;
    for (var si = 0; si < dirs.length; si += 1) {
      if (dirs[si] && dirs[si].axisIndex === axisIndex) {
        startDir = dirs[si];
        break;
      }
    }
    var snapState = axis3DCrosshairSnapState(axis3DCrosshairCollapsedMarkerState(camera), null, cfg || {});
    if (
      snapState &&
      snapState.snapped &&
      snapState.snapped.axisIndex !== axisIndex &&
      startDir
    ) {
      dirs = dirs.slice();
      dirs.push({
        axisIndex: snapState.snapped.axisIndex,
        ux: startDir.ux,
        uy: startDir.uy,
        collapsed: true
      });
    }
    var best = null;
    for (var i = 0; i < dirs.length; i += 1) {
      var d = dirs[i];
      if (!d || d.axisIndex === axisIndex) { continue; }
      var along = ((Number(dx) || 0) * d.ux + (Number(dy) || 0) * d.uy) / dragLen;
      var tangentialScore = Math.sqrt(Math.max(0, 1 - along * along));
      if (!best || tangentialScore > best.score) {
        best = { axisIndex: d.axisIndex, ux: d.ux, uy: d.uy, score: tangentialScore };
      }
    }
    if (!best || best.score < thresholdSin) { return null; }
    return best;
  }

  function axis3DStartAxisLock(camera, body, cfg, clientX, clientY) {
    var rect = body && body.getBoundingClientRect ? body.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
    var w = Math.max(1, Number(rect.width) || 1);
    var h = Math.max(1, Number(rect.height) || 1);
    var px = Math.max(0, Math.min(w, Number(clientX || 0) - Number(rect.left || 0)));
    var py = Math.max(0, Math.min(h, Number(clientY || 0) - Number(rect.top || 0)));
    var threshold = axisStartLockDistancePx(cfg);
    var cam = Object.assign({}, camera || {}, { viewport_width_px: w, viewport_height_px: h });
    if (String(cfg && cfg.mode || "crosshair").toLowerCase() === "box") {
      var projector = axis3DBoxPixelProjector(cam, w, h, cfg || {});
      if (!projector) { return null; }
      var xMin = Number(cfg.x_min);
      var xMax = Number(cfg.x_max);
      var yMin = Number(cfg.y_min);
      var yMax = Number(cfg.y_max);
      var zMin = Number(cfg.z_min);
      var zMax = Number(cfg.z_max);
      var segments = [
        { axisIndex: 0, a: [xMin, yMin, zMin], b: [xMax, yMin, zMin] },
        { axisIndex: 1, a: [xMin, yMin, zMin], b: [xMin, yMax, zMin] },
        { axisIndex: 2, a: [xMin, yMin, zMin], b: [xMin, yMin, zMax] }
      ];
      var boxHits = [];
      for (var bi = 0; bi < segments.length; bi += 1) {
        var sa = projector(segments[bi].a);
        var sb = projector(segments[bi].b);
        if (!sa || !sb) { continue; }
        var sdist = pointSegmentDistancePx(px, py, sa[0], sa[1], sb[0], sb[1]);
        boxHits.push({ axisIndex: segments[bi].axisIndex, hit: sdist <= threshold, distance: sdist });
      }
      var boxHit = chooseUniqueAxisHit(boxHits);
      return boxHit ? boxHit.axisIndex : null;
    }
    var center = axis3DRotationCenter(cfg || {});
    var p0 = projectWorldToPixel(cam, w, h, center);
    if (!p0) { return null; }
    var dirs = axis3DScreenAxisDirections(cam, body, cfg || {});
    var hits = [];
    for (var i = 0; i < dirs.length; i += 1) {
      var d = dirs[i];
      var dist = pointLineDistancePx(px, py, p0[0], p0[1], d.ux, d.uy);
      hits.push({ axisIndex: d.axisIndex, hit: dist <= threshold, distance: dist });
    }
    var hit = chooseUniqueAxisHit(hits);
    return hit ? hit.axisIndex : null;
  }

  function axis3DBoxLockedDragAxis(camera, body, cfg, dx, dy, thresholdDeg) {
    var best = axis3DLockedDragAxisFromDirs(axis3DBoxScreenAxisDirections(camera, body, cfg), dx, dy, thresholdDeg);
    return best && best.pxPerUnit > 1e-9 ? best : null;
  }

  function axis3DBoxLockedDragDelta(camera, body, cfg, decisionDx, decisionDy, moveDx, moveDy, thresholdDeg) {
    var best = axis3DBoxLockedDragAxis(camera, body, cfg, decisionDx, decisionDy, thresholdDeg);
    if (!best) { return null; }
    var moveAlongAxis = ((Number(moveDx) || 0) * best.ux + (Number(moveDy) || 0) * best.uy);
    return {
      axisIndex: best.axisIndex,
      delta: -moveAlongAxis / best.pxPerUnit
    };
  }

  function axis3DBoxLockedTotalDragDelta(camera, body, cfg, decisionDx, decisionDy, thresholdDeg) {
    var best = axis3DBoxLockedDragAxis(camera, body, cfg, decisionDx, decisionDy, thresholdDeg);
    if (!best) { return null; }
    var totalAlongAxis = ((Number(decisionDx) || 0) * best.ux + (Number(decisionDy) || 0) * best.uy);
    return {
      axisIndex: best.axisIndex,
      delta: -totalAlongAxis / best.pxPerUnit
    };
  }

  function axis3DBoxFrozenTickValues(cfg, axisName) {
    var axis = String(axisName || "").toLowerCase();
    if (!cfg || (axis !== "x" && axis !== "y" && axis !== "z")) { return null; }
    var frozen = cfg.__frozen_tick_values || null;
    var values = frozen && frozen[axis];
    return Array.isArray(values) ? values.slice() : null;
  }

  function chooseNiceAxisStepNear(rawStep, hints) {
    var target = Math.max(1e-12, Math.abs(Number(rawStep) || 0));
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
        if (!(cand > 0)) { continue; }
        var score = Math.abs(Math.log(cand / target));
        if (score < bestScore) {
          bestScore = score;
          best = cand;
        }
      }
    }
    return best;
  }

  function axis3DBoxTickFreezePayload(camera, body, cfg) {
    if (!cfg || !camera) { return null; }
    var rect = body && body.getBoundingClientRect ? body.getBoundingClientRect() : { width: 1, height: 1 };
    var w = Math.max(1, Number(rect.width) || 1);
    var h = Math.max(1, Number(rect.height) || 1);
    var cam = Object.assign({}, camera || {}, {
      viewport_width_px: w,
      viewport_height_px: h
    });
    var xMin = Number(cfg.x_min);
    var xMax = Number(cfg.x_max);
    var yMin = Number(cfg.y_min);
    var yMax = Number(cfg.y_max);
    var zMin = Number(cfg.z_min);
    var zMax = Number(cfg.z_max);
    if (![xMin, xMax, yMin, yMax, zMin, zMax].every(Number.isFinite)) { return null; }
    var boxCorners = [
      [xMin, yMin, zMin], [xMax, yMin, zMin], [xMin, yMax, zMin], [xMax, yMax, zMin],
      [xMin, yMin, zMax], [xMax, yMin, zMax], [xMin, yMax, zMax], [xMax, yMax, zMax]
    ];
    var rawBoxPixels = boxCorners.map(function (p) { return projectWorldToPixel(cam, w, h, axis3DBoxAspectPoint(cfg, p)); });
    var finiteBoxPixels = rawBoxPixels.filter(function (p) {
      return p && Number.isFinite(p[0]) && Number.isFinite(p[1]);
    });
    if (finiteBoxPixels.length < 2) { return null; }
    var rawMinX = finiteBoxPixels[0][0];
    var rawMaxX = finiteBoxPixels[0][0];
    var rawMinY = finiteBoxPixels[0][1];
    var rawMaxY = finiteBoxPixels[0][1];
    for (var bp = 1; bp < finiteBoxPixels.length; bp += 1) {
      rawMinX = Math.min(rawMinX, finiteBoxPixels[bp][0]);
      rawMaxX = Math.max(rawMaxX, finiteBoxPixels[bp][0]);
      rawMinY = Math.min(rawMinY, finiteBoxPixels[bp][1]);
      rawMaxY = Math.max(rawMaxY, finiteBoxPixels[bp][1]);
    }
    var rawCx = (rawMinX + rawMaxX) * 0.5;
    var rawCy = (rawMinY + rawMaxY) * 0.5;
    var rawW = Math.max(1e-6, rawMaxX - rawMinX);
    var rawH = Math.max(1e-6, rawMaxY - rawMinY);
    var fitMargin = Math.max(24, Number(cfg.fit_margin_px) || 48);
    var fitW = Math.max(1, w - 2 * fitMargin);
    var fitH = Math.max(1, h - 2 * fitMargin);
    var fitScale = Math.min(fitW / rawW, fitH / rawH);
    if (!Number.isFinite(fitScale) || !(fitScale > 0)) { fitScale = 1; }
    function fitBoxPixel(p) {
      if (!p) { return null; }
      return [
        (w * 0.5) + (p[0] - rawCx) * fitScale,
        (h * 0.5) + (p[1] - rawCy) * fitScale
      ];
    }
    function projectBoxPoint(p) {
      return fitBoxPixel(projectWorldToPixel(cam, w, h, axis3DBoxAspectPoint(cfg, p)));
    }
    function boxEdgeInfo(axisIndex, a, b) {
      var pa = projectBoxPoint(a);
      var pb = projectBoxPoint(b);
      if (!pa || !pb) { return null; }
      var dx = pb[0] - pa[0];
      var dy = pb[1] - pa[1];
      var len = Math.sqrt(dx * dx + dy * dy);
      var lo = Number(a[axisIndex]);
      var hi = Number(b[axisIndex]);
      var span = Math.abs(hi - lo);
      if (!(span > 1e-12)) { return null; }
      return { len: len, lo: lo, hi: hi, span: span };
    }
    return {
      x: boxEdgeInfo(0, [xMin, yMin, zMin], [xMax, yMin, zMin]),
      y: boxEdgeInfo(1, [xMin, yMin, zMin], [xMin, yMax, zMin]),
      z: boxEdgeInfo(2, [xMin, yMin, zMin], [xMin, yMin, zMax])
    };
  }

  function freezeAxis3DBoxTickPlacement(cfg, camera, body) {
    if (!cfg) { return; }
    var hints = Array.isArray(cfg.tick_hints) && cfg.tick_hints.length ? cfg.tick_hints : [1, 2, 5];
    var projected = axis3DBoxTickFreezePayload(camera, body, cfg);
    var out = {};
    ["x", "y", "z"].forEach(function (axis) {
      var lo = Number(cfg[axis + "_min"]);
      var hi = Number(cfg[axis + "_max"]);
      if (!(hi > lo)) { out[axis] = []; return; }
      var mode = String(cfg[axis + "_mode"] || cfg[axis + "_tick_mode"] || "linear").toLowerCase();
      var span = Math.max(1e-12, hi - lo);
      var projectedInfo = projected && projected[axis] || null;
      var targetTickCount = Math.max(4, Math.min(10, Number(cfg.freeze_tick_count) || 7));
      if (!isLogTickMode(mode)) {
        var step = null;
        if (projectedInfo && projectedInfo.len > 1e-6) {
          var dataPerPixel = projectedInfo.span / Math.max(1, projectedInfo.len);
          step = chooseAxisTickStep(
            dataPerPixel,
            Number(cfg.tick_dist) || 120,
            hints,
            Number(cfg.min_tick_dist) || 72,
            Number(cfg.max_tick_dist) || 180
          );
          step = chooseReadableLinearTickStep(
            Math.min(projectedInfo.lo, projectedInfo.hi),
            Math.max(projectedInfo.lo, projectedInfo.hi),
            step,
            null,
            "linear",
            hints,
            Math.max(1, projectedInfo.len),
            Number(cfg.tick_dist) || 120,
            Number(cfg.min_tick_dist) || 72,
            Number(cfg.max_tick_dist) || 180,
            Number(cfg.tick_label_font_size) || 11
          );
        }
        if (!(Number(step) > 0)) {
          step = chooseNiceAxisStepNear(span / targetTickCount, hints);
        }
        var values = axis3DZeroAnchoredTickValues(lo, hi, step);
        if (values.length <= 1 && span > 1e-12) {
          values = axis3DZeroAnchoredTickValues(lo, hi, span / Math.max(2, targetTickCount));
        }
        out[axis] = values;
        return;
      }
      out[axis] = axisTickValuesForMode(
        lo,
        hi,
        chooseNiceAxisStepNear(span / targetTickCount, hints),
        null,
        mode,
        false,
        hints,
        targetTickCount * Math.max(1, Number(cfg.tick_dist) || 120),
        Number(cfg.tick_dist) || 120,
        Number(cfg.min_tick_dist) || 72,
        Number(cfg.max_tick_dist) || 180
      );
    });
    cfg.__frozen_tick_values = out;
  }

  function unfreezeAxis3DBoxTickPlacement(cfg) {
    if (cfg) { delete cfg.__frozen_tick_values; }
  }

  function pushAxis3DVertex(out, x, y, z, color) {
    out.push(Number(x) || 0, Number(y) || 0, Number(z) || 0, 0, 0, 1, color[0], color[1], color[2], color[3]);
  }

  function rebuildAxis3DLocalField(fid, skipUpdate, geomOverride) {
    var geom = geomOverride || (_lastDisplayPayload && _lastDisplayPayload.geom ? _lastDisplayPayload.geom[String(fid)] : null);
    var cfg = axis3DRuntimeConfig(geom);
    if (!geom || !cfg || !Array.isArray(geom.meshes) || !geom.meshes.length) { return; }
    if (String(cfg.mode || "crosshair").toLowerCase() === "box") {
      var boxMesh = geom.meshes[0];
      if (boxMesh) {
        boxMesh.axis3d_helper_lines = true;
        boxMesh.edge_width = Math.max(0.5, Number(cfg.width) || Number(boxMesh.edge_width) || 1);
        boxMesh.__dataRevision = Number(boxMesh.__dataRevision || 0) + 1;
        boxMesh.__revision = Number(boxMesh.__revision || 0) + 1;
      }
      geom.texts = [];
      if (skipUpdate === true) { return; }
      updateGeomFrame(String(fid), geom);
      return;
    }
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
    var baseX = axisCrosshairBaseValue(cfg, "x");
    var baseY = axisCrosshairBaseValue(cfg, "y");
    var baseZ = axisCrosshairBaseValue(cfg, "z");
    addLine([xRange.lo, baseY, baseZ], [xRange.hi, baseY, baseZ]);
    addLine([baseX, yRange.lo, baseZ], [baseX, yRange.hi, baseZ]);
    addLine([baseX, baseY, zRange.lo], [baseX, baseY, zRange.hi]);
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
    if (!geom || !axis3DRuntimeConfig(geom) || !Array.isArray(geom.meshes) || !geom.meshes.length) { return; }
    var frameEl = findFrameEl(geomTargetFrameId(fid));
    if (!frameEl) { return; }
    rebuildAxis3DLocalField(fid, true, geom);
    applyAxis3DBoundMeshes(geom);
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
    if (!geom || !axis3DRuntimeConfig(geom)) { return; }
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
    if (!rec || !geom || !axis3DRuntimeConfig(geom)) { return; }
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
    return specs.filter(function (spec) { return !isAxis3DHelperLineSpec(spec) && !spec.axis_plot3d; });
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
    var dragWorldDelta = axis3DKernelMethod("dragWorldDelta");
    if (dragWorldDelta) {
      var rect1 = body && body.getBoundingClientRect ? body.getBoundingClientRect() : { width: 1, height: 1 };
      return dragWorldDelta(camera, Number(rect1.width) || 1, Number(rect1.height) || 1, dx, dy);
    }
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

  function mutateAxisViewport(fid, mutator, options) {
    if (!_lastDisplayPayload || !_lastDisplayPayload.geom || !_lastDisplayPayload.geom[fid]) { return; }
    var geom = _lastDisplayPayload.geom[fid];
    var meshes = Array.isArray(geom.meshes) ? geom.meshes : [];
    var opts = options || {};
    var changed = false;
    for (var i = 0; i < meshes.length; i += 1) {
      var cfg = meshes[i] && meshes[i].axis_ticks;
      if (!cfg || meshes[i].axis_interactive === false) { continue; }
      mutator(cfg, meshes[i]);
      cfg.__vf_live_mutated = true;
      changed = true;
    }
    if (changed) {
      if (opts.scheduleFrameUpdate !== false) {
        schedulePlotCameraUpdate(fid);
      }
      var frameEl = findFrameEl(geomTargetFrameId(fid));
      if (frameEl) {
        drawSimple2DMarkerLineMeshes(fid, frameEl, meshes);
        if (opts.scheduleTextOverlay !== false) {
          scheduleGeomTextOverlayRender(String(fid), frameEl, geom);
        }
      }
    }
  }

  function axisGestureLock2D(dx, dy, thresholdDeg) {
    var len = Math.sqrt(dx * dx + dy * dy);
    if (!(len > 1e-6)) { return null; }
    var thresholdCos = Math.cos((Number(thresholdDeg) || 5) * Math.PI / 180);
    var sx = Math.abs(dx) / len;
    var sy = Math.abs(dy) / len;
    if (sx >= thresholdCos && sx >= sy) { return "x"; }
    if (sy >= thresholdCos && sy > sx) { return "y"; }
    return null;
  }

  function axisGestureSampleCount(cfg) {
    return Math.max(1, Math.floor(Number(cfg && cfg.axis_lock_sample_count) || 3));
  }

  function axisGestureLockAngle(cfg) {
    return Number(cfg && cfg.axis_lock_angle_deg) || 5;
  }

  function axisStartLockDistancePx(cfg) {
    return Math.max(1, Number(cfg && cfg.axis_lock_distance_px) || 10);
  }

  function pointSegmentDistancePx(px, py, ax, ay, bx, by) {
    var dx = bx - ax;
    var dy = by - ay;
    var lenSq = dx * dx + dy * dy;
    if (!(lenSq > 1e-12)) {
      var sx = px - ax;
      var sy = py - ay;
      return Math.sqrt(sx * sx + sy * sy);
    }
    var t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    var qx = ax + dx * t;
    var qy = ay + dy * t;
    var ex = px - qx;
    var ey = py - qy;
    return Math.sqrt(ex * ex + ey * ey);
  }

  function pointLineDistancePx(px, py, ax, ay, ux, uy) {
    return Math.abs((px - ax) * uy - (py - ay) * ux);
  }

  function chooseUniqueAxisHit(hits) {
    var best = null;
    var count = 0;
    for (var i = 0; i < hits.length; i += 1) {
      if (!hits[i] || hits[i].hit !== true) { continue; }
      count += 1;
      if (!best || hits[i].distance < best.distance) { best = hits[i]; }
    }
    return count === 1 ? best : null;
  }

  function axis2DStartAxisLock(mesh, cfg, px, py, w, h) {
    var threshold = axisStartLockDistancePx(cfg);
    var hits = [];
    if (mesh && mesh.axis_box === true) {
      var box = axisBoxRect(mesh, w, h);
      hits.push({ axis: "x", hit: pointSegmentDistancePx(px, py, box.left, box.bottom, box.right, box.bottom) <= threshold, distance: pointSegmentDistancePx(px, py, box.left, box.bottom, box.right, box.bottom) });
      hits.push({ axis: "y", hit: pointSegmentDistancePx(px, py, box.left, box.bottom, box.left, box.top) <= threshold, distance: pointSegmentDistancePx(px, py, box.left, box.bottom, box.left, box.top) });
    } else {
      var view = axisViewport(mesh, cfg, w, h);
      if (!view) { return null; }
      var yAxisPx = view.dataToY(axisCrosshairBaseValue(cfg, "y"));
      var xAxisPx = view.dataToX(axisCrosshairBaseValue(cfg, "x"));
      if (yAxisPx >= 0 && yAxisPx <= h) {
        hits.push({ axis: "x", hit: Math.abs(py - yAxisPx) <= threshold, distance: Math.abs(py - yAxisPx) });
      }
      if (xAxisPx >= 0 && xAxisPx <= w) {
        hits.push({ axis: "y", hit: Math.abs(px - xAxisPx) <= threshold, distance: Math.abs(px - xAxisPx) });
      }
    }
    var hit = chooseUniqueAxisHit(hits);
    return hit ? hit.axis : null;
  }

  function axis2DRotationDeg(cfg) {
    var raw = Number(cfg && cfg.__raw_rotation_deg);
    if (!Number.isFinite(raw)) { raw = Number(cfg && cfg.rotation_deg) || 0; }
    return snapSignedAngleDegWithinThreshold(raw, Number(cfg && cfg.rotation_snap_angle_deg) || 5, [-180, -90, 0, 90, 180]);
  }

  function axisCrosshairBaseValue(cfg, axis) {
    return isLogTickMode(cfg && cfg[axis + "_mode"]) ? 1 : 0;
  }

  function rotatePointAround(px, py, cx, cy, deg) {
    var a = (Number(deg) || 0) * Math.PI / 180;
    if (!a) { return [px, py]; }
    var c = Math.cos(a);
    var s = Math.sin(a);
    var dx = px - cx;
    var dy = py - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  }

  function axis2DRotationCenter(mesh, cfg, w, h) {
    if (mesh && mesh.axis_box === true) {
      var box = axisBoxRect(mesh, w, h);
      return [(box.left + box.right) * 0.5, (box.top + box.bottom) * 0.5];
    }
    var view = axisViewport(mesh, cfg, w, h);
    return view
      ? [view.dataToX(axisCrosshairBaseValue(cfg, "x")), view.dataToY(axisCrosshairBaseValue(cfg, "y"))]
      : [w * 0.5, h * 0.5];
  }

  function axis2DBoundaryAnchorInfo(px, py, cx, cy, inset, w, h) {
    var dx = px - cx;
    var dy = py - cy;
    var left = inset;
    var right = w - inset;
    var top = inset;
    var bottom = h - inset;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
      return { point: [px, py], side: null };
    }
    var t = Infinity;
    var side = null;
    if (dx > 1e-6) { t = Math.min(t, (right - cx) / dx); }
    else if (dx < -1e-6) { t = Math.min(t, (left - cx) / dx); }
    if (dy > 1e-6) { t = Math.min(t, (bottom - cy) / dy); }
    else if (dy < -1e-6) { t = Math.min(t, (top - cy) / dy); }
    if (!(t > 0) || !isFinite(t)) {
      return { point: [px, py], side: null };
    }
    var ax = cx + dx * t;
    var ay = cy + dy * t;
    var eps = 1e-3;
    if (Math.abs(ax - left) <= eps) { side = "left"; }
    else if (Math.abs(ax - right) <= eps) { side = "right"; }
    else if (Math.abs(ay - top) <= eps) { side = "top"; }
    else if (Math.abs(ay - bottom) <= eps) { side = "bottom"; }
    return { point: [ax, ay], side: side };
  }

  function axis2DBoundaryAnchorPoint(px, py, cx, cy, inset, w, h) {
    return axis2DBoundaryAnchorInfo(px, py, cx, cy, inset, w, h).point;
  }

  function normalizeUprightTextRotationDeg(deg) {
    var angle = normalizeSignedAngleDeg(deg);
    if (angle > 90) { angle -= 180; }
    else if (angle < -90) { angle += 180; }
    return angle;
  }

  function axisTextAnchorFromAxisOffset(dx, dy) {
    var ax = Math.abs(Number(dx) || 0);
    var ay = Math.abs(Number(dy) || 0);
    if (ax >= ay) {
      return {
        ha: (Number(dx) || 0) >= 0 ? "left" : "right",
        va: "center"
      };
    }
    return {
      ha: "center",
      va: (Number(dy) || 0) >= 0 ? "top" : "bottom"
    };
  }

  function axis2DPlaceBoundaryHorizontalLabel(item, center, axisBoundaryPoint, axisPoint, preBoundaryPoint, preferredNormal, boundaryInfo, w, h) {
    if (!item || !boundaryInfo || !axisBoundaryPoint || !axisPoint || !preBoundaryPoint) { return null; }
    var fontSize = Math.max(1, Number(item.font_size) || 12);
    var text = item.text != null ? String(item.text) : "";
    var boxW = Math.max(1, estimateTickLabelWidthPx(text, fontSize));
    var boxH = Math.max(1, fontSize);
    var ux = Number(axisBoundaryPoint[0]) - Number(center[0]);
    var uy = Number(axisBoundaryPoint[1]) - Number(center[1]);
    var uLen = Math.sqrt(ux * ux + uy * uy);
    if (!(uLen > 1e-6)) { return null; }
    ux /= Math.max(1e-6, uLen);
    uy /= Math.max(1e-6, uLen);
    var vx = preferredNormal
      ? Number(preferredNormal[0]) - Number(axisPoint[0])
      : Number(preBoundaryPoint[0]) - Number(axisPoint[0]);
    var vy = preferredNormal
      ? Number(preferredNormal[1]) - Number(axisPoint[1])
      : Number(preBoundaryPoint[1]) - Number(axisPoint[1]);
    var vDotU = vx * ux + vy * uy;
    var nx = vx - ux * vDotU;
    var ny = vy - uy * vDotU;
    var nLen = Math.sqrt(nx * nx + ny * ny);
    if (!(nLen > 1e-6)) {
      nx = -uy;
      ny = ux;
      nLen = 1;
    }
    nx /= nLen;
    ny /= nLen;
    var edgeGap = Math.max(0, Number(item.axis_gap_px) || nLen);
    var support = 0.5 * (Math.abs(nx) * boxW + Math.abs(ny) * boxH);
    var cx = Number(axisBoundaryPoint[0]) + nx * (edgeGap + support);
    var cy = Number(axisBoundaryPoint[1]) + ny * (edgeGap + support);
    var targetX = null;
    var targetY = null;
    if (boundaryInfo.side === "left") {
      targetX = Math.max(0, Number(item.boundary_inset_px) || 0) + boxW * 0.5;
    } else if (boundaryInfo.side === "right") {
      targetX = w - Math.max(0, Number(item.boundary_inset_px) || 0) - boxW * 0.5;
    } else if (boundaryInfo.side === "top") {
      targetY = Math.max(0, Number(item.boundary_inset_px) || 0) + boxH * 0.5;
    } else if (boundaryInfo.side === "bottom") {
      targetY = h - Math.max(0, Number(item.boundary_inset_px) || 0) - boxH * 0.5;
    }
    var t = 0;
    if (targetX != null && Math.abs(ux) > 1e-6) {
      t = (targetX - cx) / ux;
    } else if (targetY != null && Math.abs(uy) > 1e-6) {
      t = (targetY - cy) / uy;
    }
    return {
      x: cx + ux * t,
      y: cy + uy * t,
      rotate: 0,
      ha: "center",
      va: "center"
    };
  }

  function rotateAxis2DLabelSpecs(items, mesh, cfg, w, h) {
    var deg = axis2DRotationDeg(cfg);
    if (!deg || !Array.isArray(items) || !items.length) { return items; }
    var c = axis2DRotationCenter(mesh, cfg, w, h);
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      if (!item || item.pixel !== true) { continue; }
      var p = rotatePointAround(Number(item.x) || 0, Number(item.y) || 0, c[0], c[1], deg);
      var axisAnchor = item.axis_anchor_px != null && item.axis_anchor_py != null
        ? rotatePointAround(Number(item.axis_anchor_px) || 0, Number(item.axis_anchor_py) || 0, c[0], c[1], deg)
        : null;
      var preferredNormal = item.preferred_normal_dx != null && item.preferred_normal_dy != null && axisAnchor
        ? rotatePointAround(
            Number(item.axis_anchor_px) + Number(item.preferred_normal_dx || 0),
            Number(item.axis_anchor_py) + Number(item.preferred_normal_dy || 0),
            c[0],
            c[1],
            deg
          )
        : null;
      var boundaryInfo = null;
      if (item.boundary_anchor === true) {
        boundaryInfo = axis2DBoundaryAnchorInfo(
          axisAnchor ? axisAnchor[0] : p[0],
          axisAnchor ? axisAnchor[1] : p[1],
          c[0],
          c[1],
          Math.max(0, Number(item.boundary_inset_px) || 0),
          w,
          h
        );
        if (item.boundary_keep_offset === true && axisAnchor) {
          p = [
            boundaryInfo.point[0] + (p[0] - axisAnchor[0]),
            boundaryInfo.point[1] + (p[1] - axisAnchor[1])
          ];
        } else {
          p = boundaryInfo.point;
        }
      }
      if (item.solve_boundary_and_axis === true && boundaryInfo && axisAnchor) {
        var solved = axis2DPlaceBoundaryHorizontalLabel(item, c, boundaryInfo.point, axisAnchor, p, preferredNormal, boundaryInfo, w, h);
        if (solved) {
          item.x = solved.x;
          item.y = solved.y;
          item.rotate = solved.rotate;
          item.ha = solved.ha;
          item.va = solved.va;
          continue;
        }
      }
      item.x = p[0];
      item.y = p[1];
      var rotateDeg = item.keep_horizontal === true
        ? (Number(item.rotate) || 0)
        : (Number(item.rotate) || 0) + deg;
      if (item.keep_upright === true) {
        rotateDeg = normalizeUprightTextRotationDeg(rotateDeg);
      }
      item.rotate = rotateDeg;
      if (item.keep_horizontal === true && boundaryInfo && item.boundary_side_align === true) {
        if (boundaryInfo.side === "left") {
          item.ha = "left";
          item.va = "center";
        } else if (boundaryInfo.side === "right") {
          item.ha = "right";
          item.va = "center";
        } else if (boundaryInfo.side === "top") {
          item.ha = "center";
          item.va = "top";
        } else if (boundaryInfo.side === "bottom") {
          item.ha = "center";
          item.va = "bottom";
        }
      }
      if (item.anchor_to_axis === true && axisAnchor) {
        var anchor = axisTextAnchorFromAxisOffset(p[0] - axisAnchor[0], p[1] - axisAnchor[1]);
        item.ha = anchor.ha;
        item.va = anchor.va;
      }
    }
    return items;
  }

  function applyAxis2DRotationTransform(ctx, mesh, cfg, w, h) {
    var deg = axis2DRotationDeg(cfg);
    if (!deg) { return false; }
    var center = axis2DRotationCenter(mesh, cfg, w, h);
    var cx = center[0];
    var cy = center[1];
    ctx.translate(cx, cy);
    ctx.rotate(deg * Math.PI / 180);
    ctx.translate(-cx, -cy);
    return true;
  }

  function axis2DRotatedLocalBounds(mesh, cfg, w, h) {
    var deg = axis2DRotationDeg(cfg);
    if (!deg) { return { left: 0, right: w, top: 0, bottom: h, width: w, height: h }; }
    var center = axis2DRotationCenter(mesh, cfg, w, h);
    var pts = [
      rotatePointAround(0, 0, center[0], center[1], -deg),
      rotatePointAround(w, 0, center[0], center[1], -deg),
      rotatePointAround(w, h, center[0], center[1], -deg),
      rotatePointAround(0, h, center[0], center[1], -deg)
    ];
    var left = pts[0][0];
    var right = pts[0][0];
    var top = pts[0][1];
    var bottom = pts[0][1];
    for (var i = 1; i < pts.length; i += 1) {
      left = Math.min(left, pts[i][0]);
      right = Math.max(right, pts[i][0]);
      top = Math.min(top, pts[i][1]);
      bottom = Math.max(bottom, pts[i][1]);
    }
    var pad = Math.max(8, Number(cfg && cfg.len) || 7, Number(cfg && cfg.tick_label_font_size) || 11);
    return {
      left: left - pad,
      right: right + pad,
      top: top - pad,
      bottom: bottom + pad,
      width: Math.max(1, right - left + pad * 2),
      height: Math.max(1, bottom - top + pad * 2)
    };
  }

  function axis2DVisibleDataRangeFromLocalBounds(view, cfg, w, h, bounds, axis) {
    if (!view || !bounds) { return axis === "x" ? [view.vx0, view.vx1] : [view.vy0, view.vy1]; }
    if (axis === "x") {
      var ux0 = bounds.left / Math.max(1, w);
      var ux1 = bounds.right / Math.max(1, w);
      var x0 = axisUnitToValue(ux0, view.vx0, view.vx1, cfg.x_mode);
      var x1 = axisUnitToValue(ux1, view.vx0, view.vx1, cfg.x_mode);
      return [Math.min(x0, x1), Math.max(x0, x1)];
    }
    var uyTop = 1 - (bounds.bottom / Math.max(1, h));
    var uyBottom = 1 - (bounds.top / Math.max(1, h));
    var y0 = axisUnitToValue(uyTop, view.vy0, view.vy1, cfg.y_mode);
    var y1 = axisUnitToValue(uyBottom, view.vy0, view.vy1, cfg.y_mode);
    return [Math.min(y0, y1), Math.max(y0, y1)];
  }

  function axis2DCrosshairBoundaryLabelAnchor(view, cfg, w, h, axis, insetPx) {
    if (!view || !cfg) { return null; }
    var baseX = axisCrosshairBaseValue(cfg, "x");
    var baseY = axisCrosshairBaseValue(cfg, "y");
    var origin = view.dataToPoint(baseX, baseY);
    var dirPoint = axis === "x"
      ? view.dataToPoint(baseX + 1, baseY)
      : view.dataToPoint(baseX, baseY + 1);
    if (!origin || !dirPoint) { return null; }
    var dx = dirPoint[0] - origin[0];
    var dy = dirPoint[1] - origin[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    if (!(len > 1e-6)) { return null; }
    var ux = dx / len;
    var uy = dy / len;
    var clipped = clipPixelLineToRect(
      [origin[0] - ux * Math.max(w, h) * 4, origin[1] - uy * Math.max(w, h) * 4],
      [origin[0] + ux * Math.max(w, h) * 4, origin[1] + uy * Math.max(w, h) * 4],
      0,
      0,
      w,
      h
    );
    if (!clipped) { return null; }
    var positive = ((clipped[1][0] - origin[0]) * ux + (clipped[1][1] - origin[1]) * uy) >=
      ((clipped[0][0] - origin[0]) * ux + (clipped[0][1] - origin[1]) * uy) ? clipped[1] : clipped[0];
    var inset = Math.max(0, Number(insetPx) || 0);
    return {
      x: positive[0] - ux * inset,
      y: positive[1] - uy * inset,
      ux: ux,
      uy: uy
    };
  }

  function ensureAxisSelectionOverlay(body) {
    if (!body) { return null; }
    if (global.getComputedStyle && global.getComputedStyle(body).position === "static") {
      body.style.position = "relative";
    }
    var el = body.querySelector(":scope > .vf-axis-selection-overlay");
    if (!el) {
      el = document.createElement("div");
      el.className = "vf-axis-selection-overlay";
      el.style.position = "absolute";
      el.style.border = "1px dashed rgba(255,255,255,0.9)";
      el.style.background = "rgba(120,160,255,0.14)";
      el.style.pointerEvents = "none";
      el.style.display = "none";
      el.style.zIndex = "80";
      body.appendChild(el);
    }
    return el;
  }

  function updateAxisSelectionOverlay(body, drag) {
    var el = ensureAxisSelectionOverlay(body);
    if (!el || !drag) { return; }
    var x0 = Number(drag.startX || 0);
    var y0 = Number(drag.startY || 0);
    var x1 = Number(drag.pendingX || drag.x || x0);
    var y1 = Number(drag.pendingY || drag.y || y0);
    var rect = body && body.getBoundingClientRect ? body.getBoundingClientRect() : { left: 0, top: 0 };
    var left = Math.min(x0, x1) - Number(rect.left || 0);
    var top = Math.min(y0, y1) - Number(rect.top || 0);
    var width = Math.abs(x1 - x0);
    var height = Math.abs(y1 - y0);
    el.style.display = width >= 2 && height >= 2 ? "block" : "none";
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
    el.style.width = Math.round(width) + "px";
    el.style.height = Math.round(height) + "px";
  }

  function hideAxisSelectionOverlay(body) {
    var el = body && body.querySelector ? body.querySelector(":scope > .vf-axis-selection-overlay") : null;
    if (el) { el.style.display = "none"; }
  }

  function axis2DRangeSnapshot(cfg) {
    return {
      x_min: Number(cfg.x_min),
      x_max: Number(cfg.x_max),
      y_min: Number(cfg.y_min),
      y_max: Number(cfg.y_max)
    };
  }

  function axis2DRestoreUnlockedRange(cfg, snapshot, activeAxis) {
    if (!snapshot || !activeAxis) { return; }
    if (activeAxis !== "x" && Number.isFinite(snapshot.x_min) && Number.isFinite(snapshot.x_max)) {
      cfg.x_min = snapshot.x_min;
      cfg.x_max = snapshot.x_max;
    }
    if (activeAxis !== "y" && Number.isFinite(snapshot.y_min) && Number.isFinite(snapshot.y_max)) {
      cfg.y_min = snapshot.y_min;
      cfg.y_max = snapshot.y_max;
    }
  }

  function applyAxis2DSelectionZoom(fid, body, drag) {
    if (!_lastDisplayPayload || !_lastDisplayPayload.geom || !_lastDisplayPayload.geom[fid]) { return; }
    var geom = _lastDisplayPayload.geom[fid];
    var meshes = Array.isArray(geom.meshes) ? geom.meshes : [];
    var rect = body && body.getBoundingClientRect ? body.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
    var w = Math.max(1, Number(rect.width) || 1);
    var h = Math.max(1, Number(rect.height) || 1);
    var x0 = Math.max(0, Math.min(w, Math.min(Number(drag.startX || 0), Number(drag.pendingX || drag.x || 0)) - Number(rect.left || 0)));
    var x1 = Math.max(0, Math.min(w, Math.max(Number(drag.startX || 0), Number(drag.pendingX || drag.x || 0)) - Number(rect.left || 0)));
    var y0 = Math.max(0, Math.min(h, Math.min(Number(drag.startY || 0), Number(drag.pendingY || drag.y || 0)) - Number(rect.top || 0)));
    var y1 = Math.max(0, Math.min(h, Math.max(Number(drag.startY || 0), Number(drag.pendingY || drag.y || 0)) - Number(rect.top || 0)));
    if ((x1 - x0) < 8 || (y1 - y0) < 8) { return; }
    var plans = [];
    for (var i = 0; i < meshes.length; i += 1) {
      var mesh = meshes[i];
      var cfg = mesh && mesh.axis_ticks;
      if (!cfg || mesh.axis_interactive === false) { continue; }
      if (mesh.axis_box === true) { unfreezeAxis2DBoxTickPlacement(cfg); }
      var view = axisViewport(mesh, cfg, w, h);
      if (!view) { continue; }
      var box = axisBoxRect(mesh, w, h);
      var bx0 = mesh.axis_box === true ? Math.max(box.left, x0) : x0;
      var bx1 = mesh.axis_box === true ? Math.min(box.right, x1) : x1;
      var by0 = mesh.axis_box === true ? Math.max(box.top, y0) : y0;
      var by1 = mesh.axis_box === true ? Math.min(box.bottom, y1) : y1;
      if ((bx1 - bx0) < 4 || (by1 - by0) < 4) { continue; }
      var sx0 = mesh.axis_box === true ? (bx0 - box.left) / Math.max(1, box.width) : bx0 / w;
      var sx1 = mesh.axis_box === true ? (bx1 - box.left) / Math.max(1, box.width) : bx1 / w;
      var sy0 = mesh.axis_box === true ? (box.bottom - by1) / Math.max(1, box.height) : 1 - by1 / h;
      var sy1 = mesh.axis_box === true ? (box.bottom - by0) / Math.max(1, box.height) : 1 - by0 / h;
      var start = axis2DRangeSnapshot(cfg);
      plans.push({
        cfg: cfg,
        start: start,
        target: {
          x_min: start.x_min + sx0 * (start.x_max - start.x_min),
          x_max: start.x_min + sx1 * (start.x_max - start.x_min),
          y_min: start.y_min + sy0 * (start.y_max - start.y_min),
          y_max: start.y_min + sy1 * (start.y_max - start.y_min)
        }
      });
    }
    if (!plans.length) { return; }
    animateAxisRanges(260, function (a) {
      for (var pi = 0; pi < plans.length; pi += 1) {
        var p = plans[pi];
        p.cfg.x_min = p.start.x_min + (p.target.x_min - p.start.x_min) * a;
        p.cfg.x_max = p.start.x_max + (p.target.x_max - p.start.x_max) * a;
        p.cfg.y_min = p.start.y_min + (p.target.y_min - p.start.y_min) * a;
        p.cfg.y_max = p.start.y_max + (p.target.y_max - p.start.y_max) * a;
        p.cfg.__vf_live_mutated = true;
      }
      drawSimple2DMarkerLineMeshes(fid, findFrameEl(geomTargetFrameId(fid)), meshes);
      renderGeomTextOverlay(fid, findFrameEl(geomTargetFrameId(fid)), geom);
    }, function () { schedulePlotCameraUpdate(fid); });
  }

  function smooth01(t) {
    t = Math.max(0, Math.min(1, Number(t) || 0));
    var s = Math.sin(t * Math.PI * 0.5);
    return s * s;
  }

  function animateAxisRanges(durationMs, stepFn, doneFn) {
    var start = global.performance && typeof global.performance.now === "function" ? global.performance.now() : Date.now();
    function tick(now) {
      now = Number(now) || Date.now();
      var a = smooth01((now - start) / Math.max(1, Number(durationMs) || 240));
      stepFn(a);
      if (a < 1) {
        global.requestAnimationFrame(tick);
      } else if (typeof doneFn === "function") {
        doneFn();
      }
    }
    global.requestAnimationFrame(tick);
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
    body.addEventListener("contextmenu", function (e) {
      if (body.__vfAxis2DDragState) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

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
        if (mesh && mesh.axis_box === true) { unfreezeAxis2DBoxTickPlacement(cfg); }
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
          if (mesh && mesh.axis_box === true) {
            var lxAnchor = lx0 + ux * (lx1 - lx0);
            var lxSpan = (lx1 - lx0) * factor;
            applyLogRange(cfg, "x", lxAnchor - ux * lxSpan, lxAnchor + (1.0 - ux) * lxSpan);
          } else {
            var lxRadius = Math.max(1e-9, Math.abs(lx0), Math.abs(lx1)) * factor;
            applySymmetricCrosshairLogRange(cfg, "x", -lxRadius, lxRadius);
          }
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
          if (mesh && mesh.axis_box === true) {
            var lyAnchor = ly0 + uy * (ly1 - ly0);
            var lySpan = (ly1 - ly0) * factor;
            applyLogRange(cfg, "y", lyAnchor - uy * lySpan, lyAnchor + (1.0 - uy) * lySpan);
          } else {
            var lyRadius = Math.max(1e-9, Math.abs(ly0), Math.abs(ly1)) * factor;
            applySymmetricCrosshairLogRange(cfg, "y", -lyRadius, lyRadius);
          }
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
      var button = Number(e.button || 0);
      var action = e.ctrlKey && button === 0 ? "rotate" : e.ctrlKey && button === 2 ? "scale" : button === 0 ? "pan" : button === 2 ? "select" : "";
      if (!action) { return; }
      body.__vfAxis2DDragState = {
        x: Number(e.clientX) || 0,
        y: Number(e.clientY) || 0,
        startX: Number(e.clientX) || 0,
        startY: Number(e.clientY) || 0,
        action: action,
        totalDx: 0,
        totalDy: 0,
        sampleCount: 0,
        panMode: null,
        rangeSnapshots: null
      };
      if (action === "pan" || action === "scale") {
        var rect = body.getBoundingClientRect ? body.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
        var w = Math.max(1, Number(rect.width) || 1);
        var h = Math.max(1, Number(rect.height) || 1);
        var px = Math.max(0, Math.min(w, Number(e.clientX || 0) - Number(rect.left || 0)));
        var py = Math.max(0, Math.min(h, Number(e.clientY || 0) - Number(rect.top || 0)));
        var geom = _lastDisplayPayload && _lastDisplayPayload.geom ? _lastDisplayPayload.geom[fid] : null;
        var meshes = geom && Array.isArray(geom.meshes) ? geom.meshes : [];
        var axisHits = [];
        for (var mi = 0; mi < meshes.length; mi += 1) {
          var cfg = meshes[mi] && meshes[mi].axis_ticks;
          if (!cfg || meshes[mi].axis_interactive === false) { continue; }
          var axis = axis2DStartAxisLock(meshes[mi], cfg, px, py, w, h);
          if (axis) { axisHits.push(axis); }
        }
        var uniqueAxis = axisHits.length === 1 ? axisHits[0] : null;
        if (uniqueAxis) {
          body.__vfAxis2DDragState.panMode = { kind: "axis", axis: uniqueAxis };
        } else {
          body.__vfAxis2DDragState.panMode = { kind: "free" };
        }
      }
      try { body.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
      e.stopPropagation();
    });
    body.addEventListener("pointerup", function (e) {
      var drag = body.__vfAxis2DDragState;
      if (drag && drag.action === "select") {
        applyAxis2DSelectionZoom(fid, body, drag);
      } else if (drag) {
        schedulePlotCameraUpdate(fid);
        var frameEl = findFrameEl(geomTargetFrameId(fid));
        var geom = _lastDisplayPayload && _lastDisplayPayload.geom ? _lastDisplayPayload.geom[fid] : null;
        if (frameEl && geom) { scheduleGeomTextOverlayRender(String(fid), frameEl, geom); }
      }
      body.__vfAxis2DDragState = null;
      hideAxisSelectionOverlay(body);
      try { body.releasePointerCapture(e.pointerId); } catch (_) {}
    });
    body.addEventListener("pointercancel", function (e) {
      var drag = body.__vfAxis2DDragState;
      if (drag) {
        schedulePlotCameraUpdate(fid);
        var frameEl = findFrameEl(geomTargetFrameId(fid));
        var geom = _lastDisplayPayload && _lastDisplayPayload.geom ? _lastDisplayPayload.geom[fid] : null;
        if (frameEl && geom) { scheduleGeomTextOverlayRender(String(fid), frameEl, geom); }
      }
      body.__vfAxis2DDragState = null;
      hideAxisSelectionOverlay(body);
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
      drag.totalDx = Number(drag.totalDx || 0) + dx;
      drag.totalDy = Number(drag.totalDy || 0) + dy;
      drag.sampleCount = Number(drag.sampleCount || 0) + 1;
      if (drag.action === "select") {
        drag.pendingX = x;
        drag.pendingY = y;
        updateAxisSelectionOverlay(body, drag);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (drag.action === "scale") {
        mutateAxisViewport(fid, function (cfg) {
          unfreezeAxis2DBoxTickPlacement(cfg);
          var axis = drag.panMode && drag.panMode.kind === "axis" ? drag.panMode.axis : null;
          var factor = Math.exp((axis === "y" ? dy : dx) * 0.006);
          if (!axis || axis === "x") {
            var cx = (Number(cfg.x_min) + Number(cfg.x_max)) * 0.5;
            var hx = (Number(cfg.x_max) - Number(cfg.x_min)) * factor * 0.5;
            applyLinearRange(cfg, "x", cx - hx, cx + hx);
          }
          if (!axis || axis === "y") {
            var cy = (Number(cfg.y_min) + Number(cfg.y_max)) * 0.5;
            var hy = (Number(cfg.y_max) - Number(cfg.y_min)) * factor * 0.5;
            applyLinearRange(cfg, "y", cy - hy, cy + hy);
          }
        });
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (drag.action === "rotate") {
        var rectRot = body.getBoundingClientRect ? body.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
        var wRot = Math.max(1, Number(rectRot.width) || 1);
        var hRot = Math.max(1, Number(rectRot.height) || 1);
        var prevPx = (Number(drag.x) || 0) - (Number(rectRot.left) || 0) - dx;
        var prevPy = (Number(drag.y) || 0) - (Number(rectRot.top) || 0) - dy;
        var curPx = (Number(drag.x) || 0) - (Number(rectRot.left) || 0);
        var curPy = (Number(drag.y) || 0) - (Number(rectRot.top) || 0);
        mutateAxisViewport(fid, function (cfg, mesh) {
          if (mesh && mesh.axis_box === true && !cfg.__frozen_box_tick_state) {
            freezeAxis2DBoxTickPlacement(mesh, cfg, wRot, hRot);
          }
          var center = axis2DRotationCenter(mesh, cfg, wRot, hRot);
          var a0 = Math.atan2(prevPy - center[1], prevPx - center[0]);
          var a1 = Math.atan2(curPy - center[1], curPx - center[0]);
          var da = a1 - a0;
          while (da > Math.PI) { da -= Math.PI * 2; }
          while (da < -Math.PI) { da += Math.PI * 2; }
          if (!Number.isFinite(da) || Math.abs(prevPx - center[0]) + Math.abs(prevPy - center[1]) < 2 || Math.abs(curPx - center[0]) + Math.abs(curPy - center[1]) < 2) {
            da = dx * (Math.PI / Math.max(1, wRot));
          }
          var raw = Number(cfg.__raw_rotation_deg);
          if (!Number.isFinite(raw)) { raw = Number(cfg.rotation_deg) || 0; }
          raw += da * 180 / Math.PI;
          cfg.__raw_rotation_deg = raw;
          cfg.rotation_deg = raw;
        });
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (drag.action !== "pan") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      var rect = body.getBoundingClientRect ? body.getBoundingClientRect() : { width: 1, height: 1 };
      var w = Math.max(1, Number(rect.width) || 1);
      var h = Math.max(1, Number(rect.height) || 1);
      drag.__axis2DSnapshotIndex = 0;
      mutateAxisViewport(fid, function (cfg, mesh) {
        if (!drag.rangeSnapshots) { drag.rangeSnapshots = []; }
        if (!drag.rangeSnapshots.length) {
          var meshes = _lastDisplayPayload && _lastDisplayPayload.geom && _lastDisplayPayload.geom[fid] && Array.isArray(_lastDisplayPayload.geom[fid].meshes)
            ? _lastDisplayPayload.geom[fid].meshes
            : [];
          for (var si = 0; si < meshes.length; si += 1) {
            if (meshes[si] && meshes[si].axis_ticks) { drag.rangeSnapshots.push(axis2DRangeSnapshot(meshes[si].axis_ticks)); }
          }
        }
        var sampleNeed = axisGestureSampleCount(cfg);
        if (!drag.panMode && drag.sampleCount >= sampleNeed) {
          var lockedAxis = axisGestureLock2D(Number(drag.totalDx || 0), Number(drag.totalDy || 0), axisGestureLockAngle(cfg));
          drag.panMode = lockedAxis ? { kind: "axis", axis: lockedAxis } : { kind: "free" };
        }
        var activeAxis = drag.panMode && drag.panMode.kind === "axis" ? drag.panMode.axis : null;
        if (activeAxis) {
          var snapIndex = Number(drag.__axis2DSnapshotIndex || 0);
          axis2DRestoreUnlockedRange(cfg, drag.rangeSnapshots[snapIndex], activeAxis);
          drag.__axis2DSnapshotIndex = snapIndex + 1;
        }
        if (mesh && mesh.axis_box === true && drag.action !== "rotate") {
          unfreezeAxis2DBoxTickPlacement(cfg);
        }
        var view = axisViewport(mesh, cfg, w, h);
        if (!view) { return; }
        var box = axisBoxRect(mesh, w, h);
        var axisW = mesh && mesh.axis_box === true ? Math.max(1, box.width) : w;
        var axisH = mesh && mesh.axis_box === true ? Math.max(1, box.height) : h;
        if (activeAxis !== "y" && isLogTickMode(cfg.x_mode) && Number(cfg.x_min) > 0 && Number(cfg.x_max) > Number(cfg.x_min) && mesh && mesh.axis_box === true) {
          var px0 = Math.log(Number(cfg.x_min)) / Math.LN10;
          var px1 = Math.log(Number(cfg.x_max)) / Math.LN10;
          var pdx = (-dx / axisW) * (px1 - px0);
          applyLogRange(cfg, "x", px0 + pdx, px1 + pdx);
        } else if (activeAxis !== "y" && !isLogTickMode(cfg.x_mode)) {
          var unitsPerPxX = mesh && mesh.axis_box === true
            ? (Number(cfg.x_max) - Number(cfg.x_min)) / axisW
            : (view.vx1 - view.vx0) / w;
          var tx = -dx * unitsPerPxX;
          applyLinearRange(cfg, "x", Number(cfg.x_min) + tx, Number(cfg.x_max) + tx);
        }
        if (activeAxis !== "x" && isLogTickMode(cfg.y_mode) && Number(cfg.y_min) > 0 && Number(cfg.y_max) > Number(cfg.y_min) && mesh && mesh.axis_box === true) {
          var py0 = Math.log(Number(cfg.y_min)) / Math.LN10;
          var py1 = Math.log(Number(cfg.y_max)) / Math.LN10;
          var pdy = (dy / axisH) * (py1 - py0);
          applyLogRange(cfg, "y", py0 + pdy, py1 + pdy);
        } else if (activeAxis !== "x" && !isLogTickMode(cfg.y_mode)) {
          var unitsPerPxY = mesh && mesh.axis_box === true
            ? (Number(cfg.y_max) - Number(cfg.y_min)) / axisH
            : (view.vy1 - view.vy0) / h;
          var ty = dy * unitsPerPxY;
          applyLinearRange(cfg, "y", Number(cfg.y_min) + ty, Number(cfg.y_max) + ty);
        }
      }, {
        scheduleFrameUpdate: false,
        scheduleTextOverlay: true
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
    body.__vfAxis3DWheelState = null;
    body.addEventListener("contextmenu", function (e) {
      if (body.__vfAxis3DDragState) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

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
      drag.sampleCount = Number(drag.sampleCount || 0) + 1;
      var geom = _lastDisplayPayload && _lastDisplayPayload.geom ? _lastDisplayPayload.geom[fid] : null;
      try {
        if (drag.action === "rotate") {
          var rotCfg = axis3DBoxRuntime(geom);
          if (rotCfg && !rotCfg.__frozen_tick_values) {
            freezeAxis3DBoxTickPlacement(rotCfg, geom && geom.camera || {}, body);
          }
          mutateAxis3DCamera(fid, function (camera) {
            axis3DRotateCameraDrag(camera, axis3DRuntimeConfig(geom) || {}, dx, dy, body, drag.shiftKey === true, drag);
          }, { skipTextOverlay: true });
          var rotateCfg = axis3DRuntimeConfig(geom);
          if (rotateCfg && String(rotateCfg.mode || "crosshair").toLowerCase() !== "box") {
            refreshAxis3DRuntimeFrame(fid, true);
          } else {
            repaintAxis3DHelperLines(fid);
          }
          return;
        }
        if (drag.action === "scale") {
          var scaleCfg = axis3DBoxRuntime(geom);
          if (scaleCfg) {
            unfreezeAxis3DBoxTickPlacement(scaleCfg);
            var scaleCamera = geom.camera || {};
            var scaleDirs = axis3DBoxScreenAxisDirections(scaleCamera, body, scaleCfg);
            var scaleAxis = null;
            if (drag.boxPanMode && drag.boxPanMode.kind === "axis") {
              for (var sdi = 0; sdi < scaleDirs.length; sdi += 1) {
                if (scaleDirs[sdi].axisIndex === drag.boxPanMode.axisIndex) { scaleAxis = scaleDirs[sdi]; break; }
              }
            }
            var factor3 = Math.exp(((scaleAxis ? (dx * scaleAxis.ux + dy * scaleAxis.uy) : dx) || 0) * 0.006);
            var scaleAxes = scaleAxis ? [scaleAxis.axisIndex] : [0, 1, 2];
            for (var sai = 0; sai < scaleAxes.length; sai += 1) {
              var axisName = scaleAxes[sai] === 0 ? "x" : scaleAxes[sai] === 1 ? "y" : "z";
              var lo3 = Number(scaleCfg[axisName + "_min"]);
              var hi3 = Number(scaleCfg[axisName + "_max"]);
              var c3 = (lo3 + hi3) * 0.5;
              var h3 = (hi3 - lo3) * factor3 * 0.5;
              scaleCfg[axisName + "_min"] = c3 - h3;
              scaleCfg[axisName + "_max"] = c3 + h3;
            }
            repaintAxis3DHelperLines(fid);
          }
          return;
        }
        if (drag.action !== "pan") {
          repaintAxis3DHelperLines(fid);
          return;
        }
        var boxCfg = axis3DBoxRuntime(geom);
        if (boxCfg) {
          var cameraForBox = geom.camera || {};
          var totalDx = Number(drag.totalDx || 0);
          var totalDy = Number(drag.totalDy || 0);
          var startCfg = drag.boxStartRanges ? Object.assign({}, boxCfg, drag.boxStartRanges) : boxCfg;
          if (!drag.boxPanMode && drag.sampleCount >= axisGestureSampleCount(boxCfg)) {
            var firstLockedAxis = axis3DBoxLockedDragAxis(cameraForBox, body, startCfg, totalDx, totalDy, axisGestureLockAngle(boxCfg));
            drag.boxPanMode = firstLockedAxis
              ? { kind: "axis", axisIndex: firstLockedAxis.axisIndex }
              : { kind: "free" };
            axis3DDebugLog("mode=" + drag.boxPanMode.kind + (drag.boxPanMode.kind === "axis" ? " axis=" + drag.boxPanMode.axisIndex : ""));
          }
          if (drag.boxPanMode && drag.boxPanMode.kind === "axis") {
            var axis = drag.boxPanMode.axisIndex;
            var dirs = axis3DBoxScreenAxisDirections(cameraForBox, body, startCfg);
            var dir = null;
            for (var di = 0; di < dirs.length; di += 1) {
              if (dirs[di].axisIndex === axis) { dir = dirs[di]; break; }
            }
            if (dir && dir.pxPerUnit > 1e-9) {
              var totalAlongAxis = totalDx * dir.ux + totalDy * dir.uy;
              var delta = -totalAlongAxis / dir.pxPerUnit;
              axis3DDebugLog("locked axis=" + axis + " total=(" + totalDx.toFixed(2) + "," + totalDy.toFixed(2) + ") delta=" + Number(delta || 0).toPrecision(6));
              axis3DBoxApplyAxisDeltaFromSnapshot(boxCfg, drag.boxStartRanges, axis, delta);
            }
          } else if (drag.boxPanMode && drag.boxPanMode.kind === "free") {
            axis3DDebugLog("free total=(" + totalDx.toFixed(2) + "," + totalDy.toFixed(2) + ")");
            axis3DTranslateBoxRange(boxCfg, axis3DBoxDragDataDelta(cameraForBox, body, boxCfg, dx, dy));
          } else {
            axis3DTranslateBoxRange(boxCfg, axis3DBoxDragDataDelta(cameraForBox, body, boxCfg, dx, dy));
          }
          repaintAxis3DHelperLines(fid);
          return;
        }
        if (!drag.panMode) {
          var cfg3 = axis3DRuntimeConfig(geom) || {};
          if (drag.sampleCount >= axisGestureSampleCount(cfg3)) {
            var cameraForLock = geom && geom.camera || {};
            var locked3 = axis3DLockedDragAxisFromDirs(
              axis3DScreenAxisDirections(cameraForLock, body, cfg3),
              Number(drag.totalDx || 0),
              Number(drag.totalDy || 0),
              axisGestureLockAngle(cfg3)
            );
            drag.panMode = locked3 ? { kind: "axis", axisIndex: locked3.axisIndex } : { kind: "free" };
          }
        }
        mutateAxis3DCamera(fid, function (camera) {
          var delta = axis3DDragWorldDelta(camera, body, dx, dy);
          if (drag.panMode && drag.panMode.kind === "axis") {
            var axisIndex = drag.panMode.axisIndex;
            delta = [
              axisIndex === 0 ? delta[0] : 0,
              axisIndex === 1 ? delta[1] : 0,
              axisIndex === 2 ? delta[2] : 0
            ];
          }
          var pos = vec3Array(camera.pos, [4, 4, 5.657]);
          var target = vec3Array(camera.target, [0, 0, 0]);
          camera.pos = [pos[0] + delta[0], pos[1] + delta[1], pos[2] + delta[2]];
          camera.target = [target[0] + delta[0], target[1] + delta[1], target[2] + delta[2]];
        }, { skipTextOverlay: true });
        repaintAxis3DHelperLines(fid);
      } catch (err) {
        try { console.error("[axis3d drag]", err); } catch (_) {}
        unfreezeAxis3DBoxTickPlacement(axis3DBoxRuntime(geom));
        resetAxis3DVisualLayers(fid);
        body.__vfAxis3DDragState = null;
        hideAxisSelectionOverlay(body);
      }
    }

    function commitAxis3DDrag(drag) {
      if (!drag) { return; }
      flushAxis3DDrag();
      var geom = _lastDisplayPayload && _lastDisplayPayload.geom ? _lastDisplayPayload.geom[fid] : null;
      if (drag.action !== "rotate") {
        unfreezeAxis3DBoxTickPlacement(axis3DBoxRuntime(geom));
      }
      axis3DCommitAndRebuild(fid, body, drag);
      refreshAxis3DRuntimeFrame(fid, true);
    }

    function cancelAxis3DDragRaf(drag) {
      if (drag && drag.raf) {
        try { global.cancelAnimationFrame(drag.raf); } catch (_) {}
        drag.raf = 0;
      }
    }

    function cancelAxis3DWheelRaf(state) {
      if (state && state.raf) {
        try { global.cancelAnimationFrame(state.raf); } catch (_) {}
        state.raf = 0;
      }
    }

    function flushAxis3DWheel() {
      var wheel = body.__vfAxis3DWheelState;
      if (!wheel) { return; }
      wheel.raf = 0;
      body.__vfAxis3DWheelState = null;
      if (!_lastDisplayPayload || !_lastDisplayPayload.geom || !_lastDisplayPayload.geom[fid]) { return; }
      var totalDeltaY = Math.max(-600, Math.min(600, Number(wheel.deltaY || 0)));
      if (!totalDeltaY) { return; }
      var factor = Math.exp(totalDeltaY * 0.0028);
      var geom = _lastDisplayPayload && _lastDisplayPayload.geom ? _lastDisplayPayload.geom[fid] : null;
      var boxCfg = axis3DBoxRuntime(geom);
      if (boxCfg) {
        unfreezeAxis3DBoxTickPlacement(boxCfg);
        axis3DScaleBoxRange(boxCfg, factor);
        var recBox = frameRecs[String(fid)] || null;
        if (recBox) {
          recBox.axis3DHelperTickCache = null;
          recBox.axis3DHelperStepCache = null;
        }
        repaintAxis3DHelperLines(fid);
        return;
      }
      mutateAxis3DCamera(fid, function (camera) {
        var anchorBefore = axis3DCursorPlanePoint(camera, body, wheel.clientX, wheel.clientY);
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
        var anchorAfter = axis3DCursorPlanePoint(camera, body, wheel.clientX, wheel.clientY);
        if (anchorBefore && anchorAfter) {
          var tx = anchorBefore[0] - anchorAfter[0];
          var ty = anchorBefore[1] - anchorAfter[1];
          var tz = anchorBefore[2] - anchorAfter[2];
          if (Number.isFinite(tx) && Number.isFinite(ty) && Number.isFinite(tz)) {
            camera.target = [target[0] + tx, target[1] + ty, target[2] + tz];
            camera.pos = [nextPos[0] + tx, nextPos[1] + ty, nextPos[2] + tz];
          }
        }
        if (!axis3DCameraFinite(camera)) {
          axis3DLogRotateDiag("nonfinite-after-wheel", camera, "deltaY=" + Number(totalDeltaY || 0) + " samples=" + Number(wheel.sampleCount || 0));
        }
      }, { skipTextOverlay: true });
      var rec = frameRecs[String(fid)] || null;
      if (rec) {
        rec.axis3DHelperTickCache = null;
        rec.axis3DHelperStepCache = null;
      }
      repaintAxis3DHelperLines(fid);
    }

    body.addEventListener("wheel", function (e) {
      if (!_lastDisplayPayload || !_lastDisplayPayload.geom || !_lastDisplayPayload.geom[fid]) { return; }
      claimAxis3DEvent(e);
      try { e.__vfHandledWheel = true; } catch (_) {}
      if (body.__vfAxis3DDragState) {
        return;
      }
      var wheel = body.__vfAxis3DWheelState;
      if (!wheel) {
        wheel = {
          deltaY: 0,
          clientX: Number(e.clientX) || 0,
          clientY: Number(e.clientY) || 0,
          sampleCount: 0,
          raf: 0
        };
        body.__vfAxis3DWheelState = wheel;
      }
      wheel.deltaY = Number(wheel.deltaY || 0) + (Number(e.deltaY) || 0);
      wheel.clientX = Number(e.clientX) || 0;
      wheel.clientY = Number(e.clientY) || 0;
      wheel.sampleCount = Number(wheel.sampleCount || 0) + 1;
      if (!wheel.raf) {
        wheel.raf = global.requestAnimationFrame(function () {
          flushAxis3DWheel();
        });
      }
    }, { passive: false, capture: true });

    body.addEventListener("pointerdown", function (e) {
      var button = Number(e.button || 0);
      var action = e.ctrlKey && button === 0 ? "rotate" : e.ctrlKey && button === 2 ? "scale" : button === 0 ? "pan" : button === 2 ? "select" : "";
      if (!action) { return; }
      var x = Number(e.clientX) || 0;
      var y = Number(e.clientY) || 0;
      resetAxis3DVisualLayers(fid);
      var geom = _lastDisplayPayload && _lastDisplayPayload.geom ? _lastDisplayPayload.geom[fid] : null;
      var boxCfg = axis3DBoxRuntime(geom);
      if (boxCfg && action !== "rotate") { unfreezeAxis3DBoxTickPlacement(boxCfg); }
      var startAxisLock = null;
      if (action === "pan" || action === "scale" || action === "rotate") {
        startAxisLock = axis3DStartAxisLock(geom && geom.camera || {}, body, axis3DRuntimeConfig(geom) || {}, x, y);
      }
      cancelAxis3DWheelRaf(body.__vfAxis3DWheelState);
      body.__vfAxis3DWheelState = null;
      body.__vfAxis3DDragState = {
        x: x,
        y: y,
        pendingX: x,
        pendingY: y,
        action: action,
        totalDx: 0,
        totalDy: 0,
        sampleCount: 0,
        shiftKey: !!e.shiftKey,
        rawYawRad: NaN,
        rawPitchRad: NaN,
        axis3DRawCamera: axis3DCloneCamera(geom && geom.camera || {}),
        rotateStartAxisIndex: action === "rotate" ? startAxisLock : null,
        rotateLockMode: null,
        raf: 0,
        panMode: startAxisLock != null ? { kind: "axis", axisIndex: startAxisLock } : { kind: "free" },
        boxPanMode: startAxisLock != null ? { kind: "axis", axisIndex: startAxisLock } : { kind: "free" },
        boxStartRanges: boxCfg ? axis3DBoxRangeSnapshot(boxCfg) : null
      };
      try { body.setPointerCapture(e.pointerId); } catch (_) {}
      claimAxis3DEvent(e);
    }, true);
    body.addEventListener("pointerup", function (e) {
      var drag = body.__vfAxis3DDragState;
      cancelAxis3DDragRaf(body.__vfAxis3DDragState);
      if (drag && drag.action === "select") {
        applyAxis3DSelectionZoom(fid, body, drag);
      } else {
        commitAxis3DDrag(drag);
      }
      body.__vfAxis3DDragState = null;
      hideAxisSelectionOverlay(body);
      try { body.releasePointerCapture(e.pointerId); } catch (_) {}
      claimAxis3DEvent(e);
    }, true);
    body.addEventListener("pointercancel", function (e) {
      cancelAxis3DDragRaf(body.__vfAxis3DDragState);
      cancelAxis3DWheelRaf(body.__vfAxis3DWheelState);
      body.__vfAxis3DWheelState = null;
      var geom = _lastDisplayPayload && _lastDisplayPayload.geom ? _lastDisplayPayload.geom[fid] : null;
      unfreezeAxis3DBoxTickPlacement(axis3DBoxRuntime(geom));
      resetAxis3DVisualLayers(fid);
      body.__vfAxis3DDragState = null;
      hideAxisSelectionOverlay(body);
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
      drag.shiftKey = !!latestEvent.shiftKey;
      if (drag.action === "select") {
        updateAxisSelectionOverlay(body, drag);
      }
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

  function _setStandaloneDisplayContentPresent(present) {
    try {
      global.__vfHasStandaloneDisplayContent = !!present;
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

  function axisCrosshairTickValuesForMode(minValue, maxValue, step, explicitValues, mode, hints, pixelSpan, tickDist, minTickDist, maxTickDist) {
    var values = axisTickValuesNoZeroForMode(minValue, maxValue, step, explicitValues, mode, false, hints, pixelSpan, tickDist, minTickDist, maxTickDist);
    if (!isLogTickMode(mode)) { return values; }
    return values.filter(function (v) {
      return Math.abs((Number(v) || 0) - 1) > 1e-12;
    });
  }

  function axisCrosshairLogCoordinateToValue(coord, centerValue) {
    var c = Number(centerValue);
    if (!Number.isFinite(c) || c <= 0) { c = 1; }
    var exponent = Number(coord) - c;
    if (!Number.isFinite(exponent)) { return null; }
    if (exponent < LOG10_FLOAT_MIN || exponent > LOG10_FLOAT_MAX) { return null; }
    return Math.pow(10, exponent);
  }

  function axisCrosshairLogTickCoords(loCoord, hiCoord, step, hints, pixelSpan, tickDist, minTickDist, maxTickDist, centerValue) {
    var c = Number(centerValue);
    if (!Number.isFinite(c) || c <= 0) { c = 1; }
    var expLo = Number(loCoord) - c;
    var expHi = Number(hiCoord) - c;
    if (!Number.isFinite(expLo) || !Number.isFinite(expHi)) { return []; }
    if (expHi < expLo) {
      var t = expLo;
      expLo = expHi;
      expHi = t;
    }
    var expStep = Number(step);
    if (!(expStep > 0)) {
      expStep = chooseAxisTickStep(
        Math.max(1e-12, (expHi - expLo) / Math.max(1, Number(pixelSpan) || 1)),
        tickDist,
        hints,
        minTickDist,
        maxTickDist
      );
    }
    return axis3DZeroAnchoredTickValues(expLo, expHi, expStep)
      .filter(function (exp) { return Math.abs(Number(exp) || 0) > 1e-12; })
      .map(function (exp) {
        var value = Math.pow(10, Number(exp));
        return { coord: c + Number(exp), value: value };
      })
      .filter(function (tick) {
        return Number.isFinite(tick.coord) && Number.isFinite(tick.value) && tick.value > 0;
      });
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

  function axisUnitToValue(unit, minValue, maxValue, mode) {
    var u = Number(unit);
    var lo = Number(minValue);
    var hi = Number(maxValue);
    if (isLogTickMode(mode) && lo > 0 && hi > lo) {
      var l0 = Math.log(lo) / Math.LN10;
      var l1 = Math.log(hi) / Math.LN10;
      return Math.pow(10, l0 + u * (l1 - l0));
    }
    return lo + u * (hi - lo);
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

  function makeSymmetricLogRangeFromValues(loValue, hiValue) {
    var lo = Number(loValue);
    var hi = Number(hiValue);
    if (!(lo > 0) || !(hi > lo)) {
      return [0.1, 10.0];
    }
    var l0 = Math.log(lo) / Math.LN10;
    var l1 = Math.log(hi) / Math.LN10;
    var radius = Math.max(1, Math.abs(l0), Math.abs(l1));
    radius = Math.min(LOG10_FLOAT_MAX, Math.max(1e-9, radius));
    return [Math.pow(10, -radius), Math.pow(10, radius)];
  }

  function ensureSymmetricCrosshairLogRange(cfg, axis) {
    if (!cfg) { return; }
    var next = makeSymmetricLogRangeFromValues(cfg[axis + "_min"], cfg[axis + "_max"]);
    cfg[axis + "_min"] = next[0];
    cfg[axis + "_max"] = next[1];
  }

  function applySymmetricCrosshairLogRange(cfg, axis, l0, l1) {
    var a = Number(l0);
    var b = Number(l1);
    if (!Number.isFinite(a) || !Number.isFinite(b)) { return false; }
    var radius = Math.max(1e-9, Math.abs(a), Math.abs(b));
    var clamped = clampLogSpan(-radius, radius);
    if (!clamped) { return false; }
    cfg[axis + "_min"] = Math.pow(10, clamped[0]);
    cfg[axis + "_max"] = Math.pow(10, clamped[1]);
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
    var xLog = mesh && mesh.axis_box !== true && isLogTickMode(cfg.x_mode) && xMin > 0 && xMax > xMin;
    var yLog = mesh && mesh.axis_box !== true && isLogTickMode(cfg.y_mode) && yMin > 0 && yMax > yMin;
    var x0 = xLog ? Math.log(xMin) / Math.LN10 : xMin;
    var x1 = xLog ? Math.log(xMax) / Math.LN10 : xMax;
    var y0 = yLog ? Math.log(yMin) / Math.LN10 : yMin;
    var y1 = yLog ? Math.log(yMax) / Math.LN10 : yMax;
    var cx = xLog ? 0 : (x0 + x1) * 0.5;
    var cy = yLog ? 0 : (y0 + y1) * 0.5;
    var xSpan = x1 - x0;
    var ySpan = y1 - y0;
    if (String(mesh.aspect || "").toLowerCase() === "equal") {
      if (w >= h) {
        xSpan = xSpan * (w / Math.max(1, h));
      } else {
        ySpan = ySpan * (h / Math.max(1, w));
      }
    }
    var vx0Coord = cx - xSpan * 0.5;
    var vx1Coord = cx + xSpan * 0.5;
    var vy0Coord = cy - ySpan * 0.5;
    var vy1Coord = cy + ySpan * 0.5;
    var vx0 = xLog ? Math.pow(10, vx0Coord) : vx0Coord;
    var vx1 = xLog ? Math.pow(10, vx1Coord) : vx1Coord;
    var vy0 = yLog ? Math.pow(10, vy0Coord) : vy0Coord;
    var vy1 = yLog ? Math.pow(10, vy1Coord) : vy1Coord;
    return {
      vx0: vx0,
      vx1: vx1,
      vy0: vy0,
      vy1: vy1,
      dataToX: function (x) { return axisValueToUnit(x, vx0, vx1, cfg.x_mode) * w; },
      dataToY: function (y) { return h - (axisValueToUnit(y, vy0, vy1, cfg.y_mode) * h); },
      dataToPoint: function (x, y) {
        var px = axisValueToUnit(x, vx0, vx1, cfg.x_mode) * w;
        var py = h - (axisValueToUnit(y, vy0, vy1, cfg.y_mode) * h);
        return rotatePointAround(px, py, w * 0.5, h * 0.5, axis2DRotationDeg(cfg));
      }
    };
  }

  function findAxis2DBindController(meshes, bindId) {
    var target = String(bindId || "");
    if (!target || !Array.isArray(meshes)) { return null; }
    for (var i = 0; i < meshes.length; i += 1) {
      var mesh = meshes[i];
      if (!mesh || !mesh.axis_ticks) { continue; }
      if (String(mesh.axis_bind_id || "") !== target) { continue; }
      return mesh;
    }
    return null;
  }

  function axis2DPlotPointPx(mesh, controller, cfg, w, h, index) {
    var meta = mesh && mesh.axis_plot2d || null;
    if (!meta || !controller || !cfg) { return null; }
    var xs = Array.isArray(meta.x_values) ? meta.x_values : null;
    var ys = Array.isArray(meta.y_values) ? meta.y_values : null;
    var ix = Number(index) || 0;
    if (!xs || !ys || ix < 0 || ix >= xs.length || ix >= ys.length) { return null; }
    var xVal = Number(xs[ix]);
    var yVal = Number(ys[ix]);
    if (!Number.isFinite(xVal) || !Number.isFinite(yVal)) { return null; }
    if (controller.axis_box === true) {
      var box = axisBoxRect(controller, w, h);
      var px = box.left + axisValueToUnit(xVal, Number(cfg.x_min), Number(cfg.x_max), cfg.x_mode) * box.width;
      var py = box.bottom - axisValueToUnit(yVal, Number(cfg.y_min), Number(cfg.y_max), cfg.y_mode) * box.height;
      return [px, py];
    }
    var view = axisViewport(controller, cfg, w, h);
    if (!view) { return null; }
    return [view.dataToX(xVal), view.dataToY(yVal)];
  }

  function axis3DMapBoundValue(value, baseMin, baseMax, nextMin, nextMax) {
    var v = Number(value);
    var b0 = Number(baseMin);
    var b1 = Number(baseMax);
    var n0 = Number(nextMin);
    var n1 = Number(nextMax);
    if (!Number.isFinite(v) || !Number.isFinite(b0) || !Number.isFinite(b1) || !Number.isFinite(n0) || !Number.isFinite(n1)) {
      return v;
    }
    var span = b1 - b0;
    if (Math.abs(span) < 1e-9) { return (n0 + n1) * 0.5; }
    return n0 + ((v - b0) / span) * (n1 - n0);
  }

  function applyAxis3DBoundMeshes(geomSpec) {
    if (!geomSpec || !Array.isArray(geomSpec.meshes) || !geomSpec.meshes.length) { return; }
    var cfg = axis3DRuntimeConfig(geomSpec);
    if (!cfg || String(cfg.mode || "crosshair").toLowerCase() !== "box") { return; }
    for (var i = 0; i < geomSpec.meshes.length; i += 1) {
      var mesh = geomSpec.meshes[i];
      if (!mesh || !mesh.axis_plot3d || mesh.axis3d_helper_lines === true || !Array.isArray(mesh.vertices)) { continue; }
      if (!mesh.__axis3dPlotBaseVertices) {
        mesh.__axis3dPlotBaseVertices = mesh.vertices.slice();
        mesh.__axis3dPlotBaseRanges = {
          x_min: Number(cfg.x_min), x_max: Number(cfg.x_max),
          y_min: Number(cfg.y_min), y_max: Number(cfg.y_max),
          z_min: Number(cfg.z_min), z_max: Number(cfg.z_max)
        };
      }
      var baseVerts = Array.isArray(mesh.__axis3dPlotBaseVertices) ? mesh.__axis3dPlotBaseVertices : null;
      var baseRanges = mesh.__axis3dPlotBaseRanges || null;
      if (!baseVerts || !baseRanges) { continue; }
      var nextVerts = mesh.vertices.slice();
      for (var off = 0; off + 2 < nextVerts.length && off + 2 < baseVerts.length; off += 10) {
        nextVerts[off] = axis3DMapBoundValue(baseVerts[off], baseRanges.x_min, baseRanges.x_max, cfg.x_min, cfg.x_max);
        nextVerts[off + 1] = axis3DMapBoundValue(baseVerts[off + 1], baseRanges.y_min, baseRanges.y_max, cfg.y_min, cfg.y_max);
        nextVerts[off + 2] = axis3DMapBoundValue(baseVerts[off + 2], baseRanges.z_min, baseRanges.z_max, cfg.z_min, cfg.z_max);
      }
      mesh.vertices = nextVerts;
      mesh.__dataRevision = Number(mesh.__dataRevision || 0) + 1;
      mesh.__revision = Number(mesh.__revision || 0) + 1;
    }
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
        var frozen2DX = cfg.__frozen_box_tick_state && cfg.__frozen_box_tick_state.x || null;
        var xStep = frozen2DX && Number(frozen2DX.step) > 0
          ? Number(frozen2DX.step)
          : chooseAxisTickStep((xMax - xMin) / approxW, cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
        if (!(frozen2DX && Number(frozen2DX.step) > 0)) {
          xStep = chooseReadableLinearTickStep(xMin, xMax, xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, approxW, cfg.dist, cfg.min_dist, cfg.max_dist, cfg.tick_label_font_size);
        }
        var xs = frozen2DX && Array.isArray(frozen2DX.values)
          ? frozen2DX.values.slice()
          : axisTickValuesForMode(xMin, xMax, xStep, cfg.x_ticks, cfg.x_mode, false, cfg.hints, approxW, cfg.dist, cfg.min_dist, cfg.max_dist);
        var xOffsetValue = axisLabelOffset(xs, xMin, xMax);
        var xOffsetWidth = xOffsetValue ? estimateTickLabelWidthPx(formatOffsetLabel(xOffsetValue), fontSize) : 0;
        bottomMargin = Math.max(bottomMargin, tickLen + 10 + fontSize + labelAxisPad + labelFontSize);
        rightMargin = Math.max(rightMargin, xOffsetWidth + 8);
      }
      if (yMax > yMin) {
        var frozen2DY = cfg.__frozen_box_tick_state && cfg.__frozen_box_tick_state.y || null;
        var yStep = frozen2DY && Number(frozen2DY.step) > 0
          ? Number(frozen2DY.step)
          : chooseAxisTickStep((yMax - yMin) / approxH, cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
        var ys = frozen2DY && Array.isArray(frozen2DY.values)
          ? frozen2DY.values.slice()
          : axisTickValuesForMode(yMin, yMax, yStep, cfg.y_ticks, cfg.y_mode, false, cfg.hints, approxH, cfg.dist, cfg.min_dist, cfg.max_dist);
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
    var rawWidth = Math.max(1, right - left);
    var rawHeight = Math.max(1, bottom - top);
    var rotDeg = axis2DRotationDeg(cfg);
    if (Math.abs(rotDeg) > 1e-9) {
      var rad = rotDeg * Math.PI / 180;
      var c = Math.abs(Math.cos(rad));
      var s = Math.abs(Math.sin(rad));
      var fitScale = Math.min(
        rawWidth / Math.max(1e-6, rawWidth * c + rawHeight * s),
        rawHeight / Math.max(1e-6, rawWidth * s + rawHeight * c)
      );
      if (Number.isFinite(fitScale) && fitScale > 0 && fitScale < 1) {
        var fitWidth = rawWidth * fitScale;
        var fitHeight = rawHeight * fitScale;
        var cx = (left + right) * 0.5;
        var cy = (top + bottom) * 0.5;
        left = cx - fitWidth * 0.5;
        right = cx + fitWidth * 0.5;
        top = cy - fitHeight * 0.5;
        bottom = cy + fitHeight * 0.5;
      }
    }
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  }

  function freezeAxis2DBoxTickPlacement(mesh, cfg, w, h) {
    if (!mesh || mesh.axis_box !== true || !cfg) { return; }
    var box = axisBoxRect(Object.assign({}, mesh, { axis_ticks: Object.assign({}, cfg, { __frozen_box_tick_state: null }) }), w, h);
    var xMin = Number(cfg.x_min);
    var xMax = Number(cfg.x_max);
    var yMin = Number(cfg.y_min);
    var yMax = Number(cfg.y_max);
    var state = {};
    if (xMax > xMin) {
      var xStep = chooseAxisTickStep((xMax - xMin) / Math.max(1, box.width), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
      xStep = chooseReadableLinearTickStep(xMin, xMax, xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, box.width, cfg.dist, cfg.min_dist, cfg.max_dist, cfg.tick_label_font_size);
      state.x = {
        step: xStep,
        values: axisTickValuesForMode(xMin, xMax, xStep, cfg.x_ticks, cfg.x_mode, false, cfg.hints, box.width, cfg.dist, cfg.min_dist, cfg.max_dist)
      };
    }
    if (yMax > yMin) {
      var yStep = chooseAxisTickStep((yMax - yMin) / Math.max(1, box.height), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
      state.y = {
        step: yStep,
        values: axisTickValuesForMode(yMin, yMax, yStep, cfg.y_ticks, cfg.y_mode, false, cfg.hints, box.height, cfg.dist, cfg.min_dist, cfg.max_dist)
      };
    }
    cfg.__frozen_box_tick_state = state;
  }

  function unfreezeAxis2DBoxTickPlacement(cfg) {
    if (cfg) { delete cfg.__frozen_box_tick_state; }
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
      var localBounds = axis2DRotatedLocalBounds(mesh, cfg, w, h);
      var vx0 = view.vx0, vx1 = view.vx1, vy0 = view.vy0, vy1 = view.vy1;
      var xVisible = axis2DVisibleDataRangeFromLocalBounds(view, cfg, w, h, localBounds, "x");
      var yVisible = axis2DVisibleDataRangeFromLocalBounds(view, cfg, w, h, localBounds, "y");
      var dataToX = view.dataToX;
      var dataToY = view.dataToY;
      var yAxisPx = dataToY(axisCrosshairBaseValue(cfg, "y"));
      var xAxisPx = dataToX(axisCrosshairBaseValue(cfg, "x"));
      var tickLen = Math.max(0, Number(cfg.len) || 7);
      var xAlign = String(cfg.x_alignment || "center").toLowerCase();
      var yAlign = String(cfg.y_alignment || "center").toLowerCase();

      function tickOffsets(align, negativeName, positiveName) {
        if (align === negativeName) { return [-tickLen, 0]; }
        if (align === positiveName) { return [0, tickLen]; }
        return [-tickLen * 0.5, tickLen * 0.5];
      }

      var xStep = chooseAxisTickStep((xVisible[1] - xVisible[0]) / Math.max(1, localBounds.width), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
      xStep = chooseReadableLinearTickStep(xVisible[0], xVisible[1], xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, localBounds.width, cfg.dist, cfg.min_dist, cfg.max_dist, cfg.tick_label_font_size);
      var yStep = chooseAxisTickStep((yVisible[1] - yVisible[0]) / Math.max(1, localBounds.height), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
      if (yAxisPx >= localBounds.top - tickLen && yAxisPx <= localBounds.bottom + tickLen && xStep > 0) {
        var xo = tickOffsets(xAlign, "top", "bottom");
        var xs = axisCrosshairTickValuesForMode(xVisible[0], xVisible[1], xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, localBounds.width, cfg.dist, cfg.min_dist, cfg.max_dist);
        for (var xi = 0; xi < xs.length; xi += 1) {
          var xv = xs[xi];
          var xp = dataToX(xv);
          ctx.moveTo(xp, yAxisPx + xo[0]);
          ctx.lineTo(xp, yAxisPx + xo[1]);
        }
      }
      if (xAxisPx >= localBounds.left - tickLen && xAxisPx <= localBounds.right + tickLen && yStep > 0) {
        var yo = tickOffsets(yAlign, "left", "right");
        var ys = axisCrosshairTickValuesForMode(yVisible[0], yVisible[1], yStep, cfg.y_ticks, cfg.y_mode, cfg.hints, localBounds.height, cfg.dist, cfg.min_dist, cfg.max_dist);
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
      var frozenX = cfg.__frozen_box_tick_state && cfg.__frozen_box_tick_state.x || null;
      var frozenY = cfg.__frozen_box_tick_state && cfg.__frozen_box_tick_state.y || null;
      var xStep = frozenX && Number(frozenX.step) > 0
        ? Number(frozenX.step)
        : chooseAxisTickStep((Number(cfg.x_max) - Number(cfg.x_min)) / Math.max(1, box.width), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
      if (!(frozenX && Number(frozenX.step) > 0)) {
        xStep = chooseReadableLinearTickStep(Number(cfg.x_min), Number(cfg.x_max), xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, box.width, cfg.dist, cfg.min_dist, cfg.max_dist, cfg.tick_label_font_size);
      }
      var yStep = frozenY && Number(frozenY.step) > 0
        ? Number(frozenY.step)
        : chooseAxisTickStep((Number(cfg.y_max) - Number(cfg.y_min)) / Math.max(1, box.height), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
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
      var xs = frozenX && Array.isArray(frozenX.values)
        ? frozenX.values.slice()
        : axisTickValuesForMode(Number(cfg.x_min), Number(cfg.x_max), xStep, cfg.x_ticks, cfg.x_mode, false, cfg.hints, box.width, cfg.dist, cfg.min_dist, cfg.max_dist);
      for (var xi = 0; xi < xs.length; xi += 1) {
        var xp = dataToX(xs[xi]);
        ctx.moveTo(xp, box.bottom + xo[0]);
        ctx.lineTo(xp, box.bottom + xo[1]);
      }
      var yo = tickOffsets(yAlign, "right", "left");
      var ys = frozenY && Array.isArray(frozenY.values)
        ? frozenY.values.slice()
        : axisTickValuesForMode(Number(cfg.y_min), Number(cfg.y_max), yStep, cfg.y_ticks, cfg.y_mode, false, cfg.hints, box.height, cfg.dist, cfg.min_dist, cfg.max_dist);
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
      var localBounds = axis2DRotatedLocalBounds(mesh, cfg, w, h);
      var xVisible = axis2DVisibleDataRangeFromLocalBounds(view, cfg, w, h, localBounds, "x");
      var yVisible = axis2DVisibleDataRangeFromLocalBounds(view, cfg, w, h, localBounds, "y");
      var xStep = chooseAxisTickStep((xVisible[1] - xVisible[0]) / Math.max(1, localBounds.width), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
      xStep = chooseReadableLinearTickStep(xVisible[0], xVisible[1], xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, localBounds.width, cfg.dist, cfg.min_dist, cfg.max_dist, cfg.tick_label_font_size);
      var yStep = chooseAxisTickStep((yVisible[1] - yVisible[0]) / Math.max(1, localBounds.height), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
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
      var xs = axisCrosshairTickValuesForMode(xVisible[0], xVisible[1], xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, localBounds.width, cfg.dist, cfg.min_dist, cfg.max_dist);
      for (var xi = 0; xi < xs.length; xi += 1) {
        var xp = view.dataToX(xs[xi]);
        ctx.moveTo(xp, localBounds.top);
        ctx.lineTo(xp, localBounds.bottom);
      }
      var ys = axisCrosshairTickValuesForMode(yVisible[0], yVisible[1], yStep, cfg.y_ticks, cfg.y_mode, cfg.hints, localBounds.height, cfg.dist, cfg.min_dist, cfg.max_dist);
      for (var yi = 0; yi < ys.length; yi += 1) {
        var yp = view.dataToY(ys[yi]);
        ctx.moveTo(localBounds.left, yp);
        ctx.lineTo(localBounds.right, yp);
      }
      ctx.stroke();
      ctx.restore();
      void baseColor;
    }

    function drawAxisBoxGrid(mesh) {
      var cfg = mesh.axis_ticks || null;
      var box = axisBoxRect(mesh, w, h);
      var frozenX = cfg.__frozen_box_tick_state && cfg.__frozen_box_tick_state.x || null;
      var frozenY = cfg.__frozen_box_tick_state && cfg.__frozen_box_tick_state.y || null;
      var xStep = frozenX && Number(frozenX.step) > 0
        ? Number(frozenX.step)
        : chooseAxisTickStep((Number(cfg.x_max) - Number(cfg.x_min)) / Math.max(1, box.width), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
      if (!(frozenX && Number(frozenX.step) > 0)) {
        xStep = chooseReadableLinearTickStep(Number(cfg.x_min), Number(cfg.x_max), xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, box.width, cfg.dist, cfg.min_dist, cfg.max_dist, cfg.tick_label_font_size);
      }
      var yStep = frozenY && Number(frozenY.step) > 0
        ? Number(frozenY.step)
        : chooseAxisTickStep((Number(cfg.y_max) - Number(cfg.y_min)) / Math.max(1, box.height), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
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
      var xs = frozenX && Array.isArray(frozenX.values)
        ? frozenX.values.slice()
        : axisTickValuesForMode(Number(cfg.x_min), Number(cfg.x_max), xStep, cfg.x_ticks, cfg.x_mode, false, cfg.hints, box.width, cfg.dist, cfg.min_dist, cfg.max_dist);
      for (var xi = 0; xi < xs.length; xi += 1) {
        var xp = dataToX(xs[xi]);
        ctx.moveTo(xp, box.top);
        ctx.lineTo(xp, box.bottom);
      }
      var ys = frozenY && Array.isArray(frozenY.values)
        ? frozenY.values.slice()
        : axisTickValuesForMode(Number(cfg.y_min), Number(cfg.y_max), yStep, cfg.y_ticks, cfg.y_mode, false, cfg.hints, box.height, cfg.dist, cfg.min_dist, cfg.max_dist);
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
      var localBounds = axis2DRotatedLocalBounds(mesh, cfg, w, h);
      var yAxisPx = view.dataToY(axisCrosshairBaseValue(cfg, "y"));
      var xAxisPx = view.dataToX(axisCrosshairBaseValue(cfg, "x"));
      if (yAxisPx >= localBounds.top && yAxisPx <= localBounds.bottom) {
        ctx.moveTo(localBounds.left, yAxisPx);
        ctx.lineTo(localBounds.right, yAxisPx);
      }
      if (xAxisPx >= localBounds.left && xAxisPx <= localBounds.right) {
        ctx.moveTo(xAxisPx, localBounds.top);
        ctx.lineTo(xAxisPx, localBounds.bottom);
      }
      return true;
    }

    for (var m = 0; m < meshes.length; m += 1) {
      var mesh = meshes[m];
      var boundController = mesh && mesh.axis_plot2d ? findAxis2DBindController(meshes, mesh.axis_bind_id) : null;
      var drawController = boundController || mesh;
      var drawCfg = drawController && drawController.axis_ticks || {};
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
      applyAxis2DRotationTransform(ctx, drawController, drawCfg, w, h);
      if (boundController && drawController && drawController.axis_box === true) {
        var clipBox = axisBoxRect(drawController, w, h);
        ctx.beginPath();
        ctx.rect(clipBox.left, clipBox.top, clipBox.width, clipBox.height);
        ctx.clip();
      }
      if (!boundController) {
        drawAxisGrid(mesh, color);
      }
      ctx.beginPath();
      if (!(mesh.axis_box === true && drawAxisBoxFrame(mesh)) && !(mesh.axis_full_frame === true && drawAxisFullFrameLines(mesh))) {
        for (var i = 0; i + 1 < mesh.indices.length; i += 2) {
          var ia = Number(mesh.indices[i]) || 0;
          var ib = Number(mesh.indices[i + 1]) || 0;
          var a = boundController ? axis2DPlotPointPx(mesh, boundController, drawCfg, w, h, ia) : null;
          var b = boundController ? axis2DPlotPointPx(mesh, boundController, drawCfg, w, h, ib) : null;
          if (!a || !b) {
            var ao = ia * 10;
            var bo = ib * 10;
            if (ao + 1 >= mesh.vertices.length || bo + 1 >= mesh.vertices.length) { continue; }
            a = toPx(mesh.vertices[ao], mesh.vertices[ao + 1], mesh.aspect);
            b = toPx(mesh.vertices[bo], mesh.vertices[bo + 1], mesh.aspect);
          }
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
      if (!boundController) {
        drawAxisTicks(mesh);
      }
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

  function clipPixelSegmentToRect(a, b, left, top, right, bottom) {
    var ax = a[0], ay = a[1], bx = b[0], by = b[1];
    var dx = bx - ax, dy = by - ay;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) { return null; }
    var t0 = 0;
    var t1 = 1;
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
    if (!(t1 >= t0)) { return null; }
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
    var axis3DCfg = axis3DRuntimeConfig(geomSpec);
    if (geomSpec && axis3DCfg && camera && Array.isArray(camera.pos) && Array.isArray(camera.target)) {
      function strokeAxis3DPlotMeshProjected(mesh, projector) {
        if (!mesh || !mesh.axis_plot3d || !Array.isArray(mesh.vertices) || !Array.isArray(mesh.indices) || typeof projector !== "function") { return; }
        var lineColor = parseRuntimeColor(mesh.color || axis3DCfg.color || "white");
        ctx.save();
        ctx.strokeStyle = "rgba(" + Math.round(lineColor[0] * 255) + "," + Math.round(lineColor[1] * 255) + "," + Math.round(lineColor[2] * 255) + "," + Math.max(0, Math.min(1, lineColor[3])) + ")";
        ctx.lineWidth = Math.max(0.5, Number(mesh.edge_width || axis3DCfg.grid_width || 1));
        ctx.beginPath();
        for (var pi = 0; pi + 1 < mesh.indices.length; pi += 2) {
          var ia = (Number(mesh.indices[pi]) || 0) * 10;
          var ib = (Number(mesh.indices[pi + 1]) || 0) * 10;
          if (ia + 2 >= mesh.vertices.length || ib + 2 >= mesh.vertices.length) { continue; }
          var pa = projector([mesh.vertices[ia], mesh.vertices[ia + 1], mesh.vertices[ia + 2]]);
          var pb = projector([mesh.vertices[ib], mesh.vertices[ib + 1], mesh.vertices[ib + 2]]);
          if (!pa || !pb) { continue; }
          var seg = clipPixelSegmentToRect(pa, pb, 0, 0, w, h);
          if (!seg) { continue; }
          ctx.moveTo(seg[0][0], seg[0][1]);
          ctx.lineTo(seg[1][0], seg[1][1]);
        }
        ctx.stroke();
        ctx.restore();
      }

      var cfg = axis3DCfg || {};
      var cam = Object.assign({}, camera, {
        viewport_width_px: w,
        viewport_height_px: h
      });
      var target = [
        axisCrosshairBaseValue(cfg, "x"),
        axisCrosshairBaseValue(cfg, "y"),
        axisCrosshairBaseValue(cfg, "z")
      ];
      var p0 = projectWorldToPixel(cam, w, h, target);
      var rec3 = frameRecs[String(fid)] || null;
      var color3 = parseRuntimeColor(cfg.color || "white");
      if (String(cfg.mode || "crosshair").toLowerCase() === "box") {
        ctx.save();
        ctx.strokeStyle = "rgba(" + Math.round(color3[0] * 255) + "," + Math.round(color3[1] * 255) + "," + Math.round(color3[2] * 255) + "," + Math.max(0, Math.min(1, color3[3])) + ")";
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = Math.max(0.5, Number(cfg.width || (meshes[0] && meshes[0].edge_width) || 1));
        var xMin = Number(cfg.x_min);
        var xMax = Number(cfg.x_max);
        var yMin = Number(cfg.y_min);
        var yMax = Number(cfg.y_max);
        var zMin = Number(cfg.z_min);
        var zMax = Number(cfg.z_max);
        if ([xMin, xMax, yMin, yMax, zMin, zMax].every(Number.isFinite)) {
          var boxCorners = [
            [xMin, yMin, zMin], [xMax, yMin, zMin], [xMin, yMax, zMin], [xMax, yMax, zMin],
            [xMin, yMin, zMax], [xMax, yMin, zMax], [xMin, yMax, zMax], [xMax, yMax, zMax]
          ];
          var rawBoxPixels = boxCorners.map(function (p) { return projectWorldToPixel(cam, w, h, axis3DBoxAspectPoint(cfg, p)); });
          var finiteBoxPixels = rawBoxPixels.filter(function (p) {
            return p && Number.isFinite(p[0]) && Number.isFinite(p[1]);
          });
          if (finiteBoxPixels.length < 2) {
            ctx.restore();
            return;
          }
          var rawMinX = finiteBoxPixels[0][0];
          var rawMaxX = finiteBoxPixels[0][0];
          var rawMinY = finiteBoxPixels[0][1];
          var rawMaxY = finiteBoxPixels[0][1];
          for (var bp = 1; bp < finiteBoxPixels.length; bp += 1) {
            rawMinX = Math.min(rawMinX, finiteBoxPixels[bp][0]);
            rawMaxX = Math.max(rawMaxX, finiteBoxPixels[bp][0]);
            rawMinY = Math.min(rawMinY, finiteBoxPixels[bp][1]);
            rawMaxY = Math.max(rawMaxY, finiteBoxPixels[bp][1]);
          }
          var rawCx = (rawMinX + rawMaxX) * 0.5;
          var rawCy = (rawMinY + rawMaxY) * 0.5;
          var rawW = Math.max(1e-6, rawMaxX - rawMinX);
          var rawH = Math.max(1e-6, rawMaxY - rawMinY);
          var fitMargin = Math.max(24, Number(cfg.fit_margin_px) || 48);
          var fitW = Math.max(1, w - 2 * fitMargin);
          var fitH = Math.max(1, h - 2 * fitMargin);
          var fitScale = Math.min(fitW / rawW, fitH / rawH);
          if (!Number.isFinite(fitScale) || !(fitScale > 0)) { fitScale = 1; }
          function fitBoxPixel(p) {
            if (!p) { return null; }
            return [
              (w * 0.5) + (p[0] - rawCx) * fitScale,
              (h * 0.5) + (p[1] - rawCy) * fitScale
            ];
          }
          function projectBoxPoint(p) {
            return fitBoxPixel(projectWorldToPixel(cam, w, h, axis3DBoxAspectPoint(cfg, p)));
          }
          var boxPixels = rawBoxPixels.map(fitBoxPixel);
          var boxEdges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
          function strokeBoxSegment(a, b) {
            var pa = projectBoxPoint(a);
            var pb = projectBoxPoint(b);
            if (!pa || !pb) { return; }
            var clippedSeg = clipPixelSegmentToRect(pa, pb, 0, 0, w, h);
            if (!clippedSeg) { return; }
            ctx.moveTo(clippedSeg[0][0], clippedSeg[0][1]);
            ctx.lineTo(clippedSeg[1][0], clippedSeg[1][1]);
          }
          ctx.beginPath();
          for (var be = 0; be < boxEdges.length; be += 1) {
            var ep = boxEdges[be];
            var ea = boxPixels[ep[0]];
            var eb = boxPixels[ep[1]];
            if (!ea || !eb) { continue; }
            var ec = clipPixelSegmentToRect(ea, eb, 0, 0, w, h);
            if (!ec) { continue; }
            ctx.moveTo(ec[0][0], ec[0][1]);
            ctx.lineTo(ec[1][0], ec[1][1]);
          }
          ctx.stroke();

          var boxTextSpecs = [];
          function boxTickText(v, axisName, lo, hi) {
            var mode = String(cfg[axisName + "_mode"] || cfg[axisName + "_tick_mode"] || "linear").toLowerCase();
            if (isLogTickMode(mode)) {
              return axisTickLabelForMode(v, mode, Math.min(lo, hi), Math.max(lo, hi));
            }
            var s = Math.abs(v) < 1e-10 ? "0" : Number(v).toPrecision(12).replace(/\.?0+$/, "");
            return "$" + s + "$";
          }
          function boxEdgeInfo(axisIndex, a, b) {
            var pa = projectBoxPoint(a);
            var pb = projectBoxPoint(b);
            if (!pa || !pb) { return null; }
            var dx = pb[0] - pa[0];
            var dy = pb[1] - pa[1];
            var len = Math.sqrt(dx * dx + dy * dy);
            var lo = Number(a[axisIndex]);
            var hi = Number(b[axisIndex]);
            var span = Math.abs(hi - lo);
            if (!(span > 1e-12)) { return null; }
            return { axisIndex: axisIndex, pa: pa, pb: pb, len: len, ux: len > 1e-6 ? dx / len : 0, uy: len > 1e-6 ? dy / len : -1, lo: lo, hi: hi, span: span };
          }
          function drawCollapsedAxisMarker(info) {
            if (!info || info.len > 3) { return; }
            var r = Math.max(4, Number(cfg.tick_len_px) || 7);
            var pos = vec3Array(cam && cam.pos, [0, 0, 1]);
            var tgt = vec3Array(cam && cam.target, [0, 0, 0]);
            var forward = normalizeVec3Local([tgt[0] - pos[0], tgt[1] - pos[1], tgt[2] - pos[2]], [0, 0, -1]);
            var basis = info.axisIndex === 0 ? [1, 0, 0] : info.axisIndex === 1 ? [0, 1, 0] : [0, 0, 1];
            var positiveAway = dot3(basis, forward) > 0;
            ctx.beginPath();
            ctx.arc(info.pa[0], info.pa[1], r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            if (positiveAway) {
              var cr = Math.max(2.2, r * 0.48);
              ctx.moveTo(info.pa[0] - cr, info.pa[1] - cr);
              ctx.lineTo(info.pa[0] + cr, info.pa[1] + cr);
              ctx.moveTo(info.pa[0] + cr, info.pa[1] - cr);
              ctx.lineTo(info.pa[0] - cr, info.pa[1] + cr);
              ctx.stroke();
            } else {
              ctx.arc(info.pa[0], info.pa[1], Math.max(1.5, r * 0.28), 0, Math.PI * 2);
              ctx.fill();
            }
          }
          var boxTickCache = {};
          function getBoxTickInfo(axisName, axisIndex, a, b) {
            if (boxTickCache[axisName]) { return boxTickCache[axisName]; }
            var info = boxEdgeInfo(axisIndex, a, b);
            if (!info || info.len <= 3) {
              boxTickCache[axisName] = { info: info, values: [], collapsed: !!info };
              return boxTickCache[axisName];
            }
            var frozenValues = axis3DBoxFrozenTickValues(cfg, axisName);
            if (frozenValues) {
              boxTickCache[axisName] = {
                info: info,
                step: 0,
                values: frozenValues,
                collapsed: false
              };
              return boxTickCache[axisName];
            }
            var hints = Array.isArray(cfg.tick_hints) && cfg.tick_hints.length ? cfg.tick_hints : [1, 2, 5];
            var mode = String(cfg[axisName + "_mode"] || cfg[axisName + "_tick_mode"] || "linear").toLowerCase();
            var dataPerPixel = info.span / Math.max(1, info.len);
            var step = chooseAxisTickStep(
              dataPerPixel,
              Number(cfg.tick_dist) || 120,
              hints,
              Number(cfg.min_tick_dist) || 72,
              Number(cfg.max_tick_dist) || 180
            );
            if (!isLogTickMode(mode)) {
              step = chooseReadableLinearTickStep(
                Math.min(info.lo, info.hi),
                Math.max(info.lo, info.hi),
                step,
                null,
                "linear",
                hints,
                Math.max(1, info.len),
                Number(cfg.tick_dist) || 120,
                Number(cfg.min_tick_dist) || 72,
                Number(cfg.max_tick_dist) || 180,
                Number(cfg.tick_label_font_size) || 11
              );
            }
            boxTickCache[axisName] = {
              info: info,
              step: step,
              values: axisTickValuesForMode(
                Math.min(info.lo, info.hi),
                Math.max(info.lo, info.hi),
                step,
                null,
                mode,
                false,
                hints,
                Math.max(1, info.len),
                Number(cfg.tick_dist) || 120,
                Number(cfg.min_tick_dist) || 72,
                Number(cfg.max_tick_dist) || 180
              ),
              collapsed: false
            };
            return boxTickCache[axisName];
          }
          function drawBoxGridFromTicks() {
            if (cfg.grid !== true) { return; }
            function faceGridValues(axisName, axisIndex, a, b, lo, hi) {
              var values = getBoxTickInfo(axisName, axisIndex, a, b).values.slice();
              values.push(lo, hi);
              values = values
                .map(function (v) { return Number(v); })
                .filter(function (v) { return Number.isFinite(v) && v >= Math.min(lo, hi) - 1e-9 && v <= Math.max(lo, hi) + 1e-9; })
                .sort(function (a2, b2) { return a2 - b2; });
              var out = [];
              for (var vi = 0; vi < values.length; vi += 1) {
                if (!out.length || Math.abs(values[vi] - out[out.length - 1]) > 1e-9) { out.push(values[vi]); }
              }
              return out;
            }
            var xTicks = faceGridValues("x", 0, [xMin, yMin, zMin], [xMax, yMin, zMin], xMin, xMax);
            var yTicks = faceGridValues("y", 1, [xMin, yMin, zMin], [xMin, yMax, zMin], yMin, yMax);
            var zTicks = faceGridValues("z", 2, [xMin, yMin, zMin], [xMin, yMin, zMax], zMin, zMax);
            var alpha = Math.max(0, Math.min(1, Number(cfg.grid_alpha) || 0.16));
            ctx.save();
            ctx.strokeStyle = "rgba(" + Math.round(color3[0] * 255) + "," + Math.round(color3[1] * 255) + "," + Math.round(color3[2] * 255) + "," + alpha + ")";
            ctx.lineWidth = Math.max(0.5, Number(cfg.grid_width) || 1);
            ctx.beginPath();
            for (var zFace = 0; zFace < 2; zFace += 1) {
              var zPlane = zFace === 0 ? zMin : zMax;
              for (var yi = 0; yi < yTicks.length; yi += 1) {
                strokeBoxSegment([xMin, Number(yTicks[yi]), zPlane], [xMax, Number(yTicks[yi]), zPlane]);
              }
              for (var xi = 0; xi < xTicks.length; xi += 1) {
                strokeBoxSegment([Number(xTicks[xi]), yMin, zPlane], [Number(xTicks[xi]), yMax, zPlane]);
              }
            }
            for (var yFace = 0; yFace < 2; yFace += 1) {
              var yPlane = yFace === 0 ? yMin : yMax;
              for (var zi = 0; zi < zTicks.length; zi += 1) {
                strokeBoxSegment([xMin, yPlane, Number(zTicks[zi])], [xMax, yPlane, Number(zTicks[zi])]);
              }
              for (var xj = 0; xj < xTicks.length; xj += 1) {
                strokeBoxSegment([Number(xTicks[xj]), yPlane, zMin], [Number(xTicks[xj]), yPlane, zMax]);
              }
            }
            for (var xFace = 0; xFace < 2; xFace += 1) {
              var xPlane = xFace === 0 ? xMin : xMax;
              for (var zk = 0; zk < zTicks.length; zk += 1) {
                strokeBoxSegment([xPlane, yMin, Number(zTicks[zk])], [xPlane, yMax, Number(zTicks[zk])]);
              }
              for (var yj = 0; yj < yTicks.length; yj += 1) {
                strokeBoxSegment([xPlane, Number(yTicks[yj]), zMin], [xPlane, Number(yTicks[yj]), zMax]);
              }
            }
            ctx.stroke();
            ctx.restore();
          }
          function drawBoxTicks(axisName, axisIndex, a, b) {
            if (cfg.ticks === false) { return; }
            var tickInfo = getBoxTickInfo(axisName, axisIndex, a, b);
            var info = tickInfo.info;
            if (!info) { return; }
            if (info.len <= 3) {
              drawCollapsedAxisMarker(info);
              return;
            }
            var values = tickInfo.values;
            var tickLenPx = Math.max(3, Number(cfg.tick_len_px) || 7);
            var nx = -info.uy;
            var ny = info.ux;
            var align = String(cfg[axisName + "_tick_alignment"] || "negative").toLowerCase();
            var side = align === "positive" ? 1 : align === "center" || align === "centre" ? 0 : -1;
            ctx.beginPath();
            for (var vi = 0; vi < values.length; vi += 1) {
              var v = Number(values[vi]);
              var mode = String(cfg[axisName + "_mode"] || cfg[axisName + "_tick_mode"] || "linear").toLowerCase();
              var t = axisValueToUnit(v, info.lo, info.hi, mode);
              if (!Number.isFinite(t) || t < -1e-8 || t > 1 + 1e-8) { continue; }
              var px = info.pa[0] + (info.pb[0] - info.pa[0]) * t;
              var py = info.pa[1] + (info.pb[1] - info.pa[1]) * t;
              if (side === 0) {
                ctx.moveTo(px - nx * tickLenPx * 0.5, py - ny * tickLenPx * 0.5);
                ctx.lineTo(px + nx * tickLenPx * 0.5, py + ny * tickLenPx * 0.5);
                boxTextSpecs.push({ pixel: true, x: px + nx * (tickLenPx * 0.5 + 5), y: py + ny * (tickLenPx * 0.5 + 5), text: boxTickText(v, axisName, info.lo, info.hi), font_size: Number(cfg.tick_label_font_size) || 11, ha: "center", va: "center", color: cfg.color || "white" });
              } else {
                ctx.moveTo(px, py);
                ctx.lineTo(px + nx * tickLenPx * side, py + ny * tickLenPx * side);
                boxTextSpecs.push({ pixel: true, x: px + nx * side * (tickLenPx + 5), y: py + ny * side * (tickLenPx + 5), text: boxTickText(v, axisName, info.lo, info.hi), font_size: Number(cfg.tick_label_font_size) || 11, ha: "center", va: "center", color: cfg.color || "white" });
              }
            }
            ctx.stroke();
            var label = cfg[axisName + "_label"] || "";
            if (label) {
              var labelPad = Math.max(10, Number(cfg.label_offset_px) || 28);
              boxTextSpecs.push({ pixel: true, x: info.pb[0] + nx * side * labelPad, y: info.pb[1] + ny * side * labelPad, text: label, font_size: Number(cfg.label_font_size) || 14, ha: "center", va: "center", color: cfg.color || "white" });
            }
          }
          drawBoxGridFromTicks();
          drawBoxTicks("x", 0, [xMin, yMin, zMin], [xMax, yMin, zMin]);
          drawBoxTicks("y", 1, [xMin, yMin, zMin], [xMin, yMax, zMin]);
          drawBoxTicks("z", 2, [xMin, yMin, zMin], [xMin, yMin, zMax]);
          for (var boxMeshIndex = 0; boxMeshIndex < meshes.length; boxMeshIndex += 1) {
            if (meshes[boxMeshIndex] && meshes[boxMeshIndex].axis_plot3d) {
              strokeAxis3DPlotMeshProjected(meshes[boxMeshIndex], projectBoxPoint);
            }
          }
          geomSpec.texts = boxTextSpecs;
        }
        ctx.restore();
      } else
      if (p0) {
        if (!rec3) {
          rec3 = frameRecs[String(fid)] = frameRecs[String(fid)] || { entries: [] };
        }
        var rawOrientation = axis3DCrosshairCollapsedMarkerState(cam);
        var snapState = axis3DCrosshairSnapState(rawOrientation, rec3.axis3DHelperSnappedOrientation || null, cfg);
        rec3.axis3DHelperRawOrientation = snapState.raw;
        rec3.axis3DHelperSnappedOrientation = snapState.snapped;
        rec3.axis3DHelperSnapState = snapState;
        ctx.save();
        ctx.strokeStyle = "rgba(" + Math.round(color3[0] * 255) + "," + Math.round(color3[1] * 255) + "," + Math.round(color3[2] * 255) + "," + Math.max(0, Math.min(1, color3[3])) + ")";
        ctx.fillStyle = ctx.strokeStyle;
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
        for (var axisLineIndex = 0; axisLineIndex < 3; axisLineIndex += 1) {
          axisInfos[axisLineIndex] = axisLineInfo(axisLineIndex);
        }
        var projectedSnapState = axis3DProjectedAxisSnapState(axisInfos, rec3.axis3DProjectedSnapState || null, cfg);
        rec3.axis3DProjectedSnapState = projectedSnapState;
        for (var axisDrawIndex = 0; axisDrawIndex < 3; axisDrawIndex += 1) {
          var drawInfo = axisInfos[axisDrawIndex];
          if (!drawInfo) { continue; }
          if (snapState.snapped && snapState.snapped.axisIndex === axisDrawIndex) { continue; }
          var clipped = drawInfo.clipped;
          ctx.moveTo(clipped[0][0], clipped[0][1]);
          ctx.lineTo(clipped[1][0], clipped[1][1]);
        }
        ctx.stroke();
        if (snapState.snapped) {
          drawAxisCollapsedMarker(ctx, cfg, p0[0], p0[1], snapState.snapped, color3);
        }
        if (cfg.ticks !== false) {
          var stepAxes = axis3DCrosshairTickSteps(fid, cfg, cam, target, axisInfos, w, h, rec3);
          var tickAxes = [];
          var tickHints3D = Array.isArray(cfg.tick_hints) && cfg.tick_hints.length ? cfg.tick_hints : [1, 2, 5];
          for (var ai = 0; ai < axisInfos.length; ai += 1) {
            var infoForTicks = axisInfos[ai];
            var cachedStep = stepAxes[ai] || { step: 1, mode: "linear" };
            if (!infoForTicks) { tickAxes[ai] = { step: cachedStep.step, mode: cachedStep.mode, values: [] }; continue; }
            var c0 = infoForTicks.clipped[0];
            var c1 = infoForTicks.clipped[1];
            var d0 = (((c0[0] - p0[0]) * infoForTicks.ux) + ((c0[1] - p0[1]) * infoForTicks.uy)) / infoForTicks.len;
            var d1 = (((c1[0] - p0[0]) * infoForTicks.ux) + ((c1[1] - p0[1]) * infoForTicks.uy)) / infoForTicks.len;
            var lo = infoForTicks.centerValue + Math.min(d0, d1);
            var hi = infoForTicks.centerValue + Math.max(d0, d1);
            var pixelSpan = Math.sqrt(Math.pow(c1[0] - c0[0], 2) + Math.pow(c1[1] - c0[1], 2));
            var step = cachedStep.step;
            var tickMode = String(cachedStep.mode || "linear").toLowerCase();
            tickAxes[ai] = {
              step: step,
              lo: lo,
              hi: hi,
              mode: tickMode,
              values: isLogTickMode(tickMode)
                ? axisCrosshairLogTickCoords(lo, hi, step, tickHints3D, pixelSpan, Number(cfg.tick_dist) || 120, Number(cfg.min_tick_dist) || 72, Number(cfg.max_tick_dist) || 180, infoForTicks.centerValue)
                : axis3DZeroAnchoredTickValues(lo, hi, step)
            };
          }
          rec3.axis3DHelperTickCache = { key: "visible", axes: tickAxes };
          if (cfg.grid === true) {
            ctx.save();
            ctx.strokeStyle = "rgba(" + Math.round(color3[0] * 255) + "," + Math.round(color3[1] * 255) + "," + Math.round(color3[2] * 255) + "," + Math.max(0, Math.min(1, Number(cfg.grid_alpha) || 0.16)) + ")";
            ctx.lineWidth = Math.max(0.5, Number(cfg.grid_width) || 1);
            ctx.beginPath();
            var cachedAxes = rec3.axis3DHelperTickCache && rec3.axis3DHelperTickCache.axes ? rec3.axis3DHelperTickCache.axes : [];
            function cachedTickValues(axisIndex) {
              return cachedAxes[axisIndex] && Array.isArray(cachedAxes[axisIndex].values)
                ? cachedAxes[axisIndex].values
                : [];
            }
            function cachedTickCoord(tick) {
              if (tick && typeof tick === "object") { return Number(tick.coord); }
              return Number(tick);
            }
            function cachedVisibleAxisExtent(axisIndex) {
              var axis = cachedAxes[axisIndex] || null;
              if (!axis) { return null; }
              var values = Array.isArray(axis.values) ? axis.values.map(cachedTickCoord).filter(Number.isFinite) : [];
              if (values.length >= 2) {
                return [Math.min.apply(Math, values), Math.max.apply(Math, values)];
              }
              var lo = Number(axis.lo);
              var hi = Number(axis.hi);
              if (Number.isFinite(lo) && Number.isFinite(hi)) {
                return [Math.min(lo, hi), Math.max(lo, hi)];
              }
              return null;
            }
            function drawCrosshairGridLine(lineAxis, fixedA, fixedB, sourceAxis) {
              var lineInfo = axisInfos[lineAxis];
              if (!lineInfo) { return; }
              var extent = cachedVisibleAxisExtent(lineAxis);
              if (!extent || !(extent[1] > extent[0])) { return; }
              var axes = [0, 1, 2].filter(function (axisIndex) { return axisIndex !== lineAxis; });
              var p0Grid = target.slice();
              var p1Grid = target.slice();
              p0Grid[lineAxis] = extent[0];
              p1Grid[lineAxis] = extent[1];
              p0Grid[axes[0]] = fixedA;
              p0Grid[axes[1]] = fixedB;
              p1Grid[axes[0]] = fixedA;
              p1Grid[axes[1]] = fixedB;
              var pixel0 = projectWorldToPixel(cam, w, h, p0Grid);
              var pixel1 = projectWorldToPixel(cam, w, h, p1Grid);
              if (!pixel0 || !pixel1) { return; }
              var gridClip = clipPixelSegmentToRect(
                pixel0,
                pixel1,
                0,
                0,
                w,
                h
              );
              if (!gridClip) { return; }
              ctx.moveTo(gridClip[0][0], gridClip[0][1]);
              ctx.lineTo(gridClip[1][0], gridClip[1][1]);
            }
            var xTickGrid = cachedTickValues(0);
            var yTickGrid = cachedTickValues(1);
            var zTickGrid = cachedTickValues(2);
            var xPlaneBase = target[0];
            var yPlaneBase = target[1];
            var zPlaneBase = target[2];
            for (var gyx = 0; gyx < yTickGrid.length; gyx += 1) {
              drawCrosshairGridLine(0, cachedTickCoord(yTickGrid[gyx]), zPlaneBase, 1);
            }
            for (var gxy = 0; gxy < xTickGrid.length; gxy += 1) {
              drawCrosshairGridLine(1, cachedTickCoord(xTickGrid[gxy]), zPlaneBase, 0);
            }
            for (var gzx = 0; gzx < zTickGrid.length; gzx += 1) {
              drawCrosshairGridLine(0, yPlaneBase, cachedTickCoord(zTickGrid[gzx]), 2);
            }
            for (var gxz = 0; gxz < xTickGrid.length; gxz += 1) {
              drawCrosshairGridLine(2, cachedTickCoord(xTickGrid[gxz]), yPlaneBase, 0);
            }
            for (var gzy = 0; gzy < zTickGrid.length; gzy += 1) {
              drawCrosshairGridLine(1, xPlaneBase, cachedTickCoord(zTickGrid[gzy]), 2);
            }
            for (var gyz = 0; gyz < yTickGrid.length; gyz += 1) {
              drawCrosshairGridLine(2, xPlaneBase, cachedTickCoord(yTickGrid[gyz]), 1);
            }
            ctx.stroke();
            ctx.restore();
          }
          var tickLenPx = Math.max(3, Number(cfg.tick_len_px) || 7);
          var tickLabelSpecs = [];
          var axisNameLabelSpecs = [];
          var baseAxis3DTexts = Array.isArray(geomSpec.__axis3d_base_texts)
            ? geomSpec.__axis3d_base_texts.slice()
            : (Array.isArray(geomSpec.texts) ? geomSpec.texts.slice() : []);
          geomSpec.__axis3d_base_texts = baseAxis3DTexts.slice();
          var preservedAxis3DTexts = baseAxis3DTexts.filter(function (item) {
            return !(item && item.world === true && item.edge_anchor === true);
          });
          function axis3DNameLabelText(axisIndex) {
            var key = axisIndex === 0 ? "x_label" : axisIndex === 1 ? "y_label" : "z_label";
            var value = cfg[key];
            if (value == null || value === false) { return ""; }
            var text = String(value);
            return text && text !== "true" ? text : "";
          }
          function axis3DCollapsedLabelSpec(snappedOrientation) {
            if (!snappedOrientation) { return null; }
            var axisIndex = Number(snappedOrientation.axisIndex);
            var labelText = axis3DNameLabelText(axisIndex);
            if (!labelText) { return null; }
            var labelPad = Math.max(12, Number(cfg.label_axis_pad) || 28);
            var dir = axisIndex === 0
              ? [1, -1]
              : axisIndex === 1
                ? [-1, -1]
                : [1, 1];
            if (Number(snappedOrientation.sign) > 0) {
              dir = [-dir[0], -dir[1]];
            }
            var dx = dir[0] * labelPad;
            var dy = dir[1] * labelPad;
            var anchor = axisTextAnchorFromAxisOffset(dx, dy);
            return {
              pixel: true,
              keep_horizontal: true,
              x: p0[0] + dx,
              y: p0[1] + dy,
              text: labelText,
              font_size: Number(cfg.label_font_size) || 13,
              ha: anchor.ha,
              va: anchor.va,
              color: cfg.color || "white"
            };
          }
          function axis3DNameLabelSpec(axisIndex) {
            if (snapState.snapped && Number(snapState.snapped.axisIndex) === Number(axisIndex)) { return null; }
            var labelText = axis3DNameLabelText(axisIndex);
            if (!labelText) { return null; }
            var info = axisInfos[axisIndex];
            if (!info || !Array.isArray(info.clipped) || info.clipped.length < 2) { return null; }
            var axisBoundaryPoint = info.clipped[1];
            var labelFramePad = Math.max(0, Number(cfg.label_frame_pad) || 28);
            var labelAxisPad = Math.max(0, Number(cfg.label_axis_pad) || 28);
            var alignKey = axisIndex === 0 ? "x_tick_alignment" : axisIndex === 1 ? "y_tick_alignment" : "z_tick_alignment";
            var align = String(cfg[alignKey] || "negative").toLowerCase();
            var side = align === "positive" ? 1 : align === "center" || align === "centre" ? 0 : -1;
            if (side === 0) { side = -1; }
            side = axis3DProjectedAxisSideSign(projectedSnapState, axisIndex, side);
            var normalDx = -info.uy * side * labelAxisPad;
            var normalDy = info.ux * side * labelAxisPad;
            var boundaryInfo = axis2DBoundaryAnchorInfo(axisBoundaryPoint[0], axisBoundaryPoint[1], p0[0], p0[1], labelFramePad, w, h);
            var preferredNormalPoint = [
              axisBoundaryPoint[0] + normalDx,
              axisBoundaryPoint[1] + normalDy
            ];
            var solved = axis2DPlaceBoundaryHorizontalLabel(
              {
                text: labelText,
                font_size: Number(cfg.label_font_size) || 13,
                boundary_inset_px: labelFramePad,
                axis_gap_px: labelAxisPad
              },
              p0,
              boundaryInfo && boundaryInfo.point ? boundaryInfo.point : axisBoundaryPoint,
              axisBoundaryPoint,
              preferredNormalPoint,
              preferredNormalPoint,
              boundaryInfo,
              w,
              h
            );
            if (!solved) { return null; }
            return {
              pixel: true,
              keep_horizontal: true,
              x: solved.x,
              y: solved.y,
              text: labelText,
              font_size: Number(cfg.label_font_size) || 13,
              ha: solved.ha || "center",
              va: solved.va || "center",
              color: cfg.color || "white"
            };
          }
          for (var axisLabelIndex = 0; axisLabelIndex < 3; axisLabelIndex += 1) {
            var axisNameLabel = axis3DNameLabelSpec(axisLabelIndex);
            if (axisNameLabel) { axisNameLabelSpecs.push(axisNameLabel); }
          }
          var collapsedAxisLabel = axis3DCollapsedLabelSpec(snapState.snapped);
          if (collapsedAxisLabel) { axisNameLabelSpecs.push(collapsedAxisLabel); }
          for (var crosshairMeshIndex = 0; crosshairMeshIndex < meshes.length; crosshairMeshIndex += 1) {
            if (meshes[crosshairMeshIndex] && meshes[crosshairMeshIndex].axis_plot3d) {
              strokeAxis3DPlotMeshProjected(meshes[crosshairMeshIndex], function (p) { return projectWorldToPixel(cam, w, h, p); });
            }
          }
          function tickLabelText(v, mode, lo, hi) {
            if (isLogTickMode(mode)) {
              var lv = Math.max(Number.MIN_VALUE, Number(v) || Number.MIN_VALUE);
              var l0 = Number(lo) > 0 ? Number(lo) : lv / 1000;
              var l1 = Number(hi) > l0 ? Number(hi) : lv * 1000;
              return axisTickLabelForMode(lv, mode, l0, l1);
            }
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
            var tickMode2 = String(tickAxis.mode || "linear").toLowerCase();
            var tickValues = (Array.isArray(tickAxis.values) ? tickAxis.values : axis3DZeroAnchoredTickValues(tlo, thi, tickAxis.step)).filter(function (v) {
              if (isLogTickMode(tickMode2)) { return true; }
              return Math.abs(v) > 1e-10;
            });
            var nx = -tickInfo.uy;
            var ny = tickInfo.ux;
            var alignKey = ti === 0 ? "x_tick_alignment" : ti === 1 ? "y_tick_alignment" : "z_tick_alignment";
            var align = String(cfg[alignKey] || "negative").toLowerCase();
            var side = align === "positive" ? 1 : align === "center" || align === "centre" ? 0 : -1;
            side = axis3DProjectedAxisSideSign(projectedSnapState, ti, side);
            for (var vi = 0; vi < tickValues.length; vi += 1) {
              var rawTick = tickValues[vi];
              var coord = rawTick && typeof rawTick === "object" ? Number(rawTick.coord) : Number(rawTick);
              var labelValue = rawTick && typeof rawTick === "object" ? Number(rawTick.value) : coord;
              var tAxis = isLogTickMode(tickMode2)
                ? (coord - tlo) / Math.max(1e-12, thi - tlo)
                : axisValueToUnit(coord, tlo, thi, tickMode2);
              if (!Number.isFinite(tAxis)) { continue; }
              var px = tc0[0] + (tc1[0] - tc0[0]) * tAxis;
              var py = tc0[1] + (tc1[1] - tc0[1]) * tAxis;
              if (px < -tickLenPx || px > w + tickLenPx || py < -tickLenPx || py > h + tickLenPx) { continue; }
              if (side === 0) {
                ctx.moveTo(px - nx * tickLenPx * 0.5, py - ny * tickLenPx * 0.5);
                ctx.lineTo(px + nx * tickLenPx * 0.5, py + ny * tickLenPx * 0.5);
                var centeredAnchor = axisTextAnchorFromAxisOffset(nx * (tickLenPx * 0.5 + 5), ny * (tickLenPx * 0.5 + 5));
                tickLabelSpecs.push({
                  pixel: true,
                  x: px + nx * (tickLenPx * 0.5 + 5),
                  y: py + ny * (tickLenPx * 0.5 + 5),
                  text: tickLabelText(labelValue, tickMode2, tlo, thi),
                  font_size: Number(cfg.tick_label_font_size) || 11,
                  ha: centeredAnchor.ha,
                  va: centeredAnchor.va,
                  color: cfg.color || "white"
                });
              } else {
                ctx.moveTo(px, py);
                ctx.lineTo(px + nx * tickLenPx * side, py + ny * tickLenPx * side);
                var sidedAnchor = axisTextAnchorFromAxisOffset(nx * side * (tickLenPx + 5), ny * side * (tickLenPx + 5));
                tickLabelSpecs.push({
                  pixel: true,
                  x: px + nx * side * (tickLenPx + 5),
                  y: py + ny * side * (tickLenPx + 5),
                  text: tickLabelText(labelValue, tickMode2, tlo, thi),
                  font_size: Number(cfg.tick_label_font_size) || 11,
                  ha: sidedAnchor.ha,
                  va: sidedAnchor.va,
                  color: cfg.color || "white"
                });
              }
            }
          }
          ctx.stroke();
          geomSpec.texts = preservedAxis3DTexts.concat(axisNameLabelSpecs, tickLabelSpecs);
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

  function edgeAnchorPixelInfoFromWorld(camera, w, h, item) {
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
    var side = null;
    var eps = 1e-3;
    if (clipped) {
      if (Math.abs(p[0] - inset) <= eps) { side = "left"; }
      else if (Math.abs(p[0] - (w - inset)) <= eps) { side = "right"; }
      else if (Math.abs(p[1] - inset) <= eps) { side = "top"; }
      else if (Math.abs(p[1] - (h - inset)) <= eps) { side = "bottom"; }
    }
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
    return { point: p, side: side };
  }

  function edgeAnchorPixelFromWorld(camera, w, h, item) {
    var info = edgeAnchorPixelInfoFromWorld(camera, w, h, item);
    return info ? info.point : null;
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
    var localBounds = axis2DRotatedLocalBounds(mesh, cfg, w, h);
    var xVisible = axis2DVisibleDataRangeFromLocalBounds(view, cfg, w, h, localBounds, "x");
    var yVisible = axis2DVisibleDataRangeFromLocalBounds(view, cfg, w, h, localBounds, "y");
    var vx0 = view.vx0, vx1 = view.vx1, vy0 = view.vy0, vy1 = view.vy1;
    var dataToX = view.dataToX;
    var dataToY = view.dataToY;
    var yAxisPx = dataToY(axisCrosshairBaseValue(cfg, "y"));
    var xAxisPx = dataToX(axisCrosshairBaseValue(cfg, "x"));
    var tickLen = Math.max(0, Number(cfg.len) || 7);
    var xStep = chooseAxisTickStep((xVisible[1] - xVisible[0]) / Math.max(1, localBounds.width), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
    xStep = chooseReadableLinearTickStep(xVisible[0], xVisible[1], xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, localBounds.width, cfg.dist, cfg.min_dist, cfg.max_dist, cfg.tick_label_font_size);
    var yStep = chooseAxisTickStep((yVisible[1] - yVisible[0]) / Math.max(1, localBounds.height), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
    var out = [];
    var labelColor = mesh.color || "white";
    var xOffsetValue = 0;
    var yOffsetValue = 0;

    if (yAxisPx >= localBounds.top - tickLen && yAxisPx <= localBounds.bottom + tickLen && xStep > 0) {
      var xLabels = Array.isArray(cfg.x_tick_labels) ? cfg.x_tick_labels : null;
      var xTickPlacement = String(cfg.x_tick_label_placement || "below").toLowerCase();
      var xOffset = xTickPlacement === "above" ? -tickLen - 5 : tickLen + 5;
      var xVa = xTickPlacement === "above" ? "bottom" : "top";
      var xs = axisCrosshairTickValuesForMode(xVisible[0], xVisible[1], xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, localBounds.width, cfg.dist, cfg.min_dist, cfg.max_dist);
      xOffsetValue = axisLabelOffset(xs, xVisible[0], xVisible[1]);
      for (var xi = 0; xi < xs.length; xi += 1) {
        var xv = xs[xi];
        out.push({
          pixel: true,
          keep_horizontal: true,
          anchor_to_axis: true,
          axis_anchor_px: dataToX(xv),
          axis_anchor_py: yAxisPx,
          x: dataToX(xv),
          y: yAxisPx + xOffset,
          text: xLabels && xi < xLabels.length ? String(xLabels[xi]) : axisTickLabelWithOffset(xv, cfg.x_mode, xVisible[0], xVisible[1], xOffsetValue, xStep),
          font_size: Number(cfg.tick_label_font_size) || 11,
          ha: "center",
          va: xVa,
          color: labelColor
        });
      }
    }
    if (xAxisPx >= localBounds.left - tickLen && xAxisPx <= localBounds.right + tickLen && yStep > 0) {
      var yLabels = Array.isArray(cfg.y_tick_labels) ? cfg.y_tick_labels : null;
      var yTickPlacement = String(cfg.y_tick_label_placement || "left").toLowerCase();
      var yOffset = yTickPlacement === "right" ? tickLen + 5 : -tickLen - 5;
      var yHa = yTickPlacement === "right" ? "left" : "right";
      var ys = axisCrosshairTickValuesForMode(yVisible[0], yVisible[1], yStep, cfg.y_ticks, cfg.y_mode, cfg.hints, localBounds.height, cfg.dist, cfg.min_dist, cfg.max_dist);
      yOffsetValue = axisLabelOffset(ys, yVisible[0], yVisible[1]);
      for (var yi = 0; yi < ys.length; yi += 1) {
        var yv = ys[yi];
        out.push({
          pixel: true,
          keep_horizontal: true,
          anchor_to_axis: true,
          axis_anchor_px: xAxisPx,
          axis_anchor_py: dataToY(yv),
          x: xAxisPx + yOffset,
          y: dataToY(yv),
          text: yLabels && yi < yLabels.length ? String(yLabels[yi]) : axisTickLabelWithOffset(yv, cfg.y_mode, yVisible[0], yVisible[1], yOffsetValue, yStep),
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
        boundary_anchor: true,
        boundary_inset_px: labelFramePad,
        solve_boundary_and_axis: true,
        keep_horizontal: true,
        axis_anchor_px: w - labelFramePad,
        axis_anchor_py: yAxisPx,
        preferred_normal_dx: 0,
        preferred_normal_dy: xLabelBelow ? labelAxisPad : -labelAxisPad,
        axis_gap_px: labelAxisPad,
        x: w - labelFramePad,
        y: yAxisPx + (xLabelBelow ? labelAxisPad : -labelAxisPad),
        text: String(cfg.x_label),
        font_size: Number(cfg.label_font_size) || 13,
        ha: "center",
        va: "center",
        color: labelColor
      });
    }
    if (xOffsetValue !== 0) {
      out.push({
        pixel: true,
        boundary_anchor: true,
        boundary_inset_px: labelFramePad,
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
        boundary_anchor: true,
        boundary_inset_px: labelFramePad,
        solve_boundary_and_axis: true,
        keep_horizontal: true,
        axis_anchor_px: xAxisPx,
        axis_anchor_py: labelFramePad,
        preferred_normal_dx: yLabelRight ? labelAxisPad : -labelAxisPad,
        preferred_normal_dy: 0,
        axis_gap_px: labelAxisPad,
        x: xAxisPx + (yLabelRight ? labelAxisPad : -labelAxisPad),
        y: labelFramePad,
        text: String(cfg.y_label),
        font_size: Number(cfg.label_font_size) || 13,
        ha: "center",
        va: "center",
        color: labelColor
      });
    }
    if (yOffsetValue !== 0) {
      out.push({
        pixel: true,
        boundary_anchor: true,
        boundary_inset_px: labelFramePad,
        x: xAxisPx + (yLabelRight ? -labelAxisPad : labelAxisPad),
        y: labelFramePad,
        text: formatOffsetLabel(yOffsetValue),
        font_size: Number(cfg.tick_label_font_size) || 11,
        ha: yLabelRight ? "right" : "left",
        va: "top",
        color: labelColor
      });
    }
    return rotateAxis2DLabelSpecs(out, mesh, cfg, w, h);
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
    var frozenX = cfg.__frozen_box_tick_state && cfg.__frozen_box_tick_state.x || null;
    var frozenY = cfg.__frozen_box_tick_state && cfg.__frozen_box_tick_state.y || null;
    var xStep = frozenX && Number(frozenX.step) > 0
      ? Number(frozenX.step)
      : chooseAxisTickStep((xMax - xMin) / Math.max(1, box.width), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
    if (!(frozenX && Number(frozenX.step) > 0)) {
      xStep = chooseReadableLinearTickStep(xMin, xMax, xStep, cfg.x_ticks, cfg.x_mode, cfg.hints, box.width, cfg.dist, cfg.min_dist, cfg.max_dist, cfg.tick_label_font_size);
    }
    var yStep = frozenY && Number(frozenY.step) > 0
      ? Number(frozenY.step)
      : chooseAxisTickStep((yMax - yMin) / Math.max(1, box.height), cfg.dist, cfg.hints, cfg.min_dist, cfg.max_dist);
    var tickLen = Math.max(0, Number(cfg.len) || 7);
    var labelColor = mesh.color || "white";
    var dataToX = function (x) { return box.left + axisValueToUnit(x, xMin, xMax, cfg.x_mode) * box.width; };
    var dataToY = function (y) { return box.bottom - axisValueToUnit(y, yMin, yMax, cfg.y_mode) * box.height; };
    var out = [];

    var xLabels = Array.isArray(cfg.x_tick_labels) ? cfg.x_tick_labels : null;
    var xTickPlacement = String(cfg.x_tick_label_placement || "below").toLowerCase();
    var xOffset = xTickPlacement === "above" ? -tickLen - 5 : tickLen + 5;
    var xVa = xTickPlacement === "above" ? "bottom" : "top";
    var xs = frozenX && Array.isArray(frozenX.values)
      ? frozenX.values.slice()
      : axisTickValuesForMode(xMin, xMax, xStep, cfg.x_ticks, cfg.x_mode, false, cfg.hints, box.width, cfg.dist, cfg.min_dist, cfg.max_dist);
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
    var ys = frozenY && Array.isArray(frozenY.values)
      ? frozenY.values.slice()
      : axisTickValuesForMode(yMin, yMax, yStep, cfg.y_ticks, cfg.y_mode, false, cfg.hints, box.height, cfg.dist, cfg.min_dist, cfg.max_dist);
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
        keep_upright: true,
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
        keep_upright: true,
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
    return rotateAxis2DLabelSpecs(out, mesh, cfg, w, h);
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
        var edgeInfo = item && item.world === true && item.edge_anchor === true
          ? edgeAnchorPixelInfoFromWorld(geomSpec && geomSpec.camera || null, w, h, item)
          : null;
        var p = edgeInfo ? edgeInfo.point : geomTextToPx(item, w, h, geomSpec && geomSpec.camera || null);
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
        var ha = String(item.ha || "center").toLowerCase();
        var va = String(item.va || "center").toLowerCase();
        if (edgeInfo && geomSpec && geomSpec.axis3d_controls === true) {
          if (edgeInfo.side === "left") {
            ha = "left";
            va = "center";
          } else if (edgeInfo.side === "right") {
            ha = "right";
            va = "center";
          } else if (edgeInfo.side === "top") {
            ha = "center";
            va = "top";
          } else if (edgeInfo.side === "bottom") {
            ha = "center";
            va = "bottom";
          }
        }
        el.style.transform = "translate3d(" + String(p[0]) + "px," + String(p[1]) + "px,0) translate(" +
          (ha === "left" ? "0" : ha === "right" ? "-100%" : "-50%") +
          "," +
          (va === "top" ? "0" : va === "bottom" ? "-100%" : "-50%") +
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
    if (!_vfHostInputReadyPosted) {
      scheduleHostInputReady();
    }
    var frameEl = findFrameEl(geomTargetFrameId(fid));
    if (!frameEl) {
      vlog("warn", "updateGeomFrame [" + fid + "]: no DOM element .vf-frame[data-vf-frame-id=" + fid + "] found — frame not placed yet?");
      return;
    }
    ensurePlotCameraControls(String(fid), frameEl, geomSpec);
    ensureAxis3DControls(String(fid), frameEl, geomSpec);
    ensureAxis2DControls(String(fid), frameEl, geomSpec);
    updatePlotAnimation(String(fid), frameEl, geomSpec);
    if (geomSpec && axis3DRuntimeConfig(geomSpec) && !geomSpec.__axis3dRuntimePreparing) {
      geomSpec.__axis3dRuntimePreparing = true;
      try {
        rebuildAxis3DLocalField(String(fid), true, geomSpec);
        applyAxis3DBoundMeshes(geomSpec);
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
    if (geomSpec && axis3DRuntimeConfig(geomSpec)) {
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

  function ensurePositiveAxisRangeForLog(cfg, axis) {
    if (!cfg) { return; }
    var lo = Number(cfg[axis + "_min"]);
    var hi = Number(cfg[axis + "_max"]);
    if (lo > 0 && hi > lo) { return; }
    cfg[axis + "_min"] = 0.1;
    cfg[axis + "_max"] = 10.0;
  }

  function setAxisTickMode(fid, axis, mode) {
    fid = String(fid || "");
    axis = String(axis || "").toLowerCase();
    mode = String(mode || "linear").toLowerCase() === "log" ? "log" : "linear";
    if (!fid || (axis !== "x" && axis !== "y" && axis !== "z")) { return false; }
    var geom = _lastDisplayPayload && _lastDisplayPayload.geom ? _lastDisplayPayload.geom[fid] : null;
    if (!geom) { return false; }
    var changed = false;
    var meshes = Array.isArray(geom.meshes) ? geom.meshes : [];
    for (var mi = 0; mi < meshes.length; mi += 1) {
      var cfg = meshes[mi] && meshes[mi].axis_ticks;
      if (!cfg || (axis !== "x" && axis !== "y")) { continue; }
      cfg[axis + "_mode"] = mode;
      if (mode === "log") {
        if (meshes[mi] && meshes[mi].axis_box === true) {
          ensurePositiveAxisRangeForLog(cfg, axis);
        } else {
          ensureSymmetricCrosshairLogRange(cfg, axis);
        }
      }
      changed = true;
    }
    var cfg3 = axis3DRuntimeConfig(geom);
    if (cfg3) {
      cfg3[axis + "_mode"] = mode;
      cfg3[axis + "_tick_mode"] = mode;
      if (mode === "log") {
        if (String(cfg3.mode || "").toLowerCase() === "box") {
          ensurePositiveAxisRangeForLog(cfg3, axis);
        } else {
          ensureSymmetricCrosshairLogRange(cfg3, axis);
        }
      }
      var rec = frameRecs[fid] || null;
      if (rec) {
        rec.axis3DHelperTickCache = null;
        rec.axis3DHelperStepCache = null;
      }
      changed = true;
    }
    if (!changed) { return false; }
    var frameEl = findFrameEl(geomTargetFrameId(fid));
    if (cfg3) {
      repaintAxis3DHelperLines(fid);
    } else if (frameEl) {
      drawSimple2DMarkerLineMeshes(fid, frameEl, meshes);
      renderGeomTextOverlay(fid, frameEl, geom);
    }
    return true;
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
    carryForwardLiveGeomState(_lastDisplayPayload, data);
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
        var screenHitRegions = buildScreenHitRegions(data.screen, sz.w, sz.h);
        _setDisplayHitRegions(screenHitRegions);
        _setStandaloneDisplayContentPresent(
          (Array.isArray(data.screen) && data.screen.length > 0) ||
          (Array.isArray(screenHitRegions) && screenHitRegions.length > 0)
        );
        schedulePostGeomLayout();
      } else {
        _setDisplayHitRegions([]);
        _setStandaloneDisplayContentPresent(false);
      }
    } else {
      _setDisplayHitRegions([]);
      _setStandaloneDisplayContentPresent(false);
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

    if (!_vfHostInputReadyPosted) {
      scheduleHostInputReady();
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

  function redrawVisibleGeomFrames() {
    if (!_lastDisplayPayload || !_lastDisplayPayload.geom) { return false; }
    var geom = _lastDisplayPayload.geom;
    var frameIds = Object.keys(geom);
    var any = false;
    for (var i = 0; i < frameIds.length; i += 1) {
      var fid = frameIds[i];
      var frameEl = findFrameEl(geomTargetFrameId(fid));
      if (!frameEl) { continue; }
      var hidden = false;
      try {
        hidden = frameEl.style.display === "none" || (global.getComputedStyle && global.getComputedStyle(frameEl).display === "none");
      } catch (_) {}
      if (hidden) { continue; }
      updateGeomFrame(fid, geom[fid]);
      any = true;
    }
    return any;
  }

  function forEachLiveAxisConfig(visitor) {
    if (!_lastDisplayPayload || !_lastDisplayPayload.geom) { return 0; }
    var geom = _lastDisplayPayload.geom;
    var frameIds = Object.keys(geom);
    var count = 0;
    for (var fi = 0; fi < frameIds.length; fi += 1) {
      var frameGeom = geom[frameIds[fi]];
      var meshes = frameGeom && Array.isArray(frameGeom.meshes) ? frameGeom.meshes : [];
      for (var mi = 0; mi < meshes.length; mi += 1) {
        var cfg = meshes[mi] && meshes[mi].axis_ticks;
        if (!cfg) { continue; }
        visitor(cfg, meshes[mi], frameIds[fi], frameGeom);
        count += 1;
      }
      if (frameGeom && frameGeom.axis3d_runtime) {
        visitor(frameGeom.axis3d_runtime, null, frameIds[fi], frameGeom);
        count += 1;
      }
      var frameLayers = frameGeom && Array.isArray(frameGeom.frame_layers) ? frameGeom.frame_layers : [];
      for (var li = 0; li < frameLayers.length; li += 1) {
        var layer = frameLayers[li] || null;
        if (!layer) { continue; }
        if (String(layer.kind || "").toLowerCase() !== "axis") { continue; }
        visitor(layer, null, frameIds[fi], frameGeom);
        count += 1;
      }
    }
    return count;
  }

  function toggleAllAxisGridlines() {
    var anyEnabled = false;
    forEachLiveAxisConfig(function (cfg) {
      if (cfg.grid !== false) { anyEnabled = true; }
    });
    var nextEnabled = !anyEnabled;
    forEachLiveAxisConfig(function (cfg) {
      cfg.grid = nextEnabled;
    });
    redrawCurrentDisplay();
    return nextEnabled;
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

    function targetIsEditable(target) {
      if (!target) { return false; }
      if (target.isContentEditable) { return true; }
      var tag = String(target.tagName || "").toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select";
    }

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
    global.addEventListener("keydown", function(e) {
      var key = String(e && e.key || "").toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === "g" && !targetIsEditable(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        toggleAllAxisGridlines();
      }
    }, { passive: false, capture: true });
    vlog("info", "keyboard listeners attached");
  })();

  installGlobalWheelBridge();
  installGlobalDragBridge();
  global.VfDisplay = {
    renderFromJson: renderFromJson,
    loadAndRender: loadAndRender,
    applyRuntimePacket: applyRuntimePacket,
    redrawCurrentDisplay: redrawCurrentDisplay,
    redrawVisibleGeomFrames: redrawVisibleGeomFrames,
    mountDynamicGeomFrame: mountDynamicGeomFrame,
    mountOffscreenGeomFrame: mountOffscreenGeomFrame,
    mountLinkedMirrorTextureFrame: mountLinkedMirrorTextureFrame,
    mountLedgerGeomFrame: mountLedgerGeomFrame,
    requestDynamicGeomFrameUpdate: requestDynamicGeomFrameUpdate,
    dynamicGeomFrameCanAcceptUpdate: dynamicGeomFrameCanAcceptUpdate,
    geomFrameStatus: geomFrameStatus,
    geomFrameViewAspect: geomFrameViewAspect,
    setAxisTickMode: setAxisTickMode,
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
