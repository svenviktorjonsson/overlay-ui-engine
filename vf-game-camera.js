(function (global) {
  "use strict";

  var _gameCameras = Object.create(null);

  function noop() {}
  function log(opts, level, text) {
    try {
      var fn = opts && typeof opts.log === "function" ? opts.log : noop;
      fn(level, text);
    } catch (_) {}
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

  function computeYawPitch(pos, target) {
    var f = vec3Norm(vec3Sub(target || [0, 0, 0], pos || [0, 0, 0]));
    return {
      yaw: Math.atan2(f[0], -f[2]),
      pitch: Math.asin(Math.max(-0.98, Math.min(0.98, f[1])))
    };
  }

  function forwardFromYawPitch(yaw, pitch) {
    var cp = Math.cos(pitch);
    return [
      Math.sin(yaw) * cp,
      Math.sin(pitch),
      -Math.cos(yaw) * cp
    ];
  }

  function postNativeCursorMode(mode) {
    try {
      if (global.chrome && global.chrome.webview && global.chrome.webview.postMessage) {
        global.chrome.webview.postMessage({ type: "vf-cursor", mode: String(mode || "default") });
      }
    } catch (_) {}
  }

  function sync(fid, camera) {
    if (!camera || !camera.controls || camera.controls.mode !== "game") { return null; }
    var key = String(fid);
    var st = _gameCameras[key];
    if (!st) {
      var yp = computeYawPitch(camera.pos, camera.target);
      st = {
        camera: camera,
        yaw: yp.yaw,
        pitch: yp.pitch,
        keys: Object.create(null),
        active: false,
        raf: 0,
        lastTime: 0
      };
      _gameCameras[key] = st;
    }
    st.camera = camera;
    st.controls = camera.controls || {};
    if (st.pos) {
      camera.pos = st.pos.slice();
      camera.target = st.target.slice();
    } else {
      st.pos = (camera.pos || [0, 0, 5]).slice();
      st.target = (camera.target || [0, 0, 0]).slice();
    }
    return st;
  }

  function updateTarget(st) {
    var f = forwardFromYawPitch(st.yaw, st.pitch);
    st.target = vec3Add(st.pos, f);
    if (st.camera) {
      st.camera.pos = st.pos.slice();
      st.camera.target = st.target.slice();
    }
  }

  function step(st, t) {
    if (!st.active && !Object.keys(st.keys).length) {
      st.raf = 0;
      st.lastTime = 0;
      return;
    }
    if (!st.lastTime) { st.lastTime = t; }
    var dt = Math.max(0.001, Math.min(0.05, (t - st.lastTime) / 1000));
    st.lastTime = t;

    var fwd = vec3Norm(forwardFromYawPitch(st.yaw, st.pitch));
    var right = vec3Norm(vec3Cross(fwd, [0, 1, 0]));
    if (vec3Len(right) < 1e-6) { right = [1, 0, 0]; }
    var move = [0, 0, 0];
    var keys = st.keys || {};
    if (keys.KeyW || keys.ArrowUp) { move = vec3Add(move, fwd); }
    if (keys.KeyS || keys.ArrowDown) { move = vec3Sub(move, fwd); }
    if (keys.KeyD || keys.ArrowRight) { move = vec3Add(move, right); }
    if (keys.KeyA || keys.ArrowLeft) { move = vec3Sub(move, right); }
    if (keys.Space || keys.KeyE) { move = vec3Add(move, [0, 1, 0]); }
    if (keys.ShiftLeft || keys.ShiftRight || keys.KeyQ) { move = vec3Sub(move, [0, 1, 0]); }
    if (vec3Len(move) > 1e-6) {
      var speed = Number((st.controls && st.controls.speed) || 3.0);
      st.pos = vec3Add(st.pos, vec3Scale(vec3Norm(move), speed * dt));
      updateTarget(st);
    }
    st.raf = requestAnimationFrame(function(now) { step(st, now); });
  }

  function setGameCursor(st, canvas, frameEl, active) {
    var hide = active && String((st.controls && st.controls.cursor) || "default") === "none";
    var css = hide ? "none" : "default";
    postNativeCursorMode(hide ? "none" : "default");
    document.documentElement.classList.toggle("vf-game-cursor-none", hide);
    document.body.classList.toggle("vf-game-cursor-none", hide);
    document.body.style.cursor = css;
    document.documentElement.style.cursor = css;
    canvas.style.cursor = css;
    if (frameEl && frameEl.style) { frameEl.style.cursor = css; }
    if (frameEl && frameEl.querySelectorAll) {
      var canvases = frameEl.querySelectorAll("canvas.vf-geom-canvas");
      for (var i = 0; i < canvases.length; i++) {
        canvases[i].style.cursor = css;
      }
    }
    if (active) {
      canvas.classList.add("vf-geom-canvas--game-active");
      if (frameEl && frameEl.classList) { frameEl.classList.add("vf-frame--game-active"); }
    } else {
      canvas.classList.remove("vf-geom-canvas--game-active");
      if (frameEl && frameEl.classList) { frameEl.classList.remove("vf-frame--game-active"); }
    }
  }

  function attach(canvas, fid, camera, opts) {
    if (!camera || !camera.controls || camera.controls.mode !== "game") { return; }
    var st = sync(fid, camera);
    if (!st || canvas.__vfGameCameraAttached) { return; }
    canvas.__vfGameCameraAttached = true;
    canvas.tabIndex = 0;
    var frameEl = opts && typeof opts.findFrameEl === "function" ? opts.findFrameEl(fid) : null;
    var hadPointerLock = false;
    var lastPointer = null;

    function applyCursor(active) { setGameCursor(st, canvas, frameEl, active); }
    applyCursor(false);

    function activate() {
      st.active = true;
      applyCursor(true);
      canvas.focus();
      if (!st.raf) {
        st.raf = requestAnimationFrame(function(now) { step(st, now); });
      }
    }
    function deactivate() {
      st.active = false;
      st.keys = Object.create(null);
      applyCursor(false);
    }
    function keyOf(e) {
      return String((e && e.code) || (e && e.key) || "");
    }

    function activateFromPointer(e) {
      activate();
      lastPointer = e && typeof e.clientX === "number" && typeof e.clientY === "number"
        ? { x: e.clientX, y: e.clientY }
        : null;
      if (e && typeof e.preventDefault === "function") { e.preventDefault(); }
      if (e && typeof e.stopPropagation === "function") { e.stopPropagation(); }
      try {
        if (e && e.pointerId != null && canvas.setPointerCapture) {
          canvas.setPointerCapture(e.pointerId);
        }
      } catch (_) {}
      try {
        if (canvas.requestPointerLock) { canvas.requestPointerLock(); }
      } catch (_) {}
    }

    function applyLookDelta(e) {
      if (!st.active && document.pointerLockElement !== canvas) { return; }
      var dx = Number(e.movementX || 0);
      var dy = Number(e.movementY || 0);
      if ((!dx && !dy) && lastPointer && typeof e.clientX === "number" && typeof e.clientY === "number") {
        dx = e.clientX - lastPointer.x;
        dy = e.clientY - lastPointer.y;
      }
      if (typeof e.clientX === "number" && typeof e.clientY === "number") {
        lastPointer = { x: e.clientX, y: e.clientY };
      }
      if (!dx && !dy) { return; }
      var sens = Number((st.controls && st.controls.sensitivity) || 0.0025);
      st.yaw += dx * sens;
      st.pitch = Math.max(-1.45, Math.min(1.45, st.pitch - dy * sens));
      updateTarget(st);
    }

    canvas.addEventListener("pointerdown", activateFromPointer, { passive: false });
    canvas.addEventListener("mousedown", activateFromPointer, { passive: false });

    global.addEventListener("keydown", function(e) {
      if (keyOf(e) === "Escape") {
        deactivate();
        try {
          if (document.exitPointerLock) { document.exitPointerLock(); }
        } catch (_) {}
        return;
      }
      if (!st.active && document.activeElement !== canvas) { return; }
      var k = keyOf(e);
      if (!k) { return; }
      st.keys[k] = true;
      activate();
      if (e && typeof e.preventDefault === "function") { e.preventDefault(); }
    }, { passive: false });

    global.addEventListener("keyup", function(e) {
      var k = keyOf(e);
      if (k) { delete st.keys[k]; }
    }, { passive: true });

    global.addEventListener("blur", deactivate, { passive: true });

    global.addEventListener("mousemove", function(e) {
      applyLookDelta(e);
    }, { passive: true });

    canvas.addEventListener("pointermove", function(e) {
      applyLookDelta(e);
      if (e && typeof e.preventDefault === "function") { e.preventDefault(); }
    }, { passive: false });

    document.addEventListener("pointerlockchange", function() {
      if (document.pointerLockElement === canvas) {
        hadPointerLock = true;
        activate();
      } else if (hadPointerLock) {
        hadPointerLock = false;
        deactivate();
      }
    }, { passive: true });

    log(opts, "info", "game camera controls attached: frame=" + fid);
  }

  function applyGlobalCursorMode(mode, cursorCss) {
    var css = typeof cursorCss === "function" ? cursorCss(mode || "default") : String(mode || "default");
    for (var key in _gameCameras) {
      if (_gameCameras[key] && _gameCameras[key].active &&
          String((_gameCameras[key].controls && _gameCameras[key].controls.cursor) || "default") === "none") {
        css = "none";
        break;
      }
    }
    var hide = css === "none";
    postNativeCursorMode(hide ? "none" : "default");
    document.documentElement.classList.toggle("vf-game-cursor-none", hide);
    document.body.classList.toggle("vf-game-cursor-none", hide);
    document.documentElement.style.cursor = css;
    document.body.style.cursor = css;
  }

  function getState(frameId) {
    var st = _gameCameras[String(frameId || "")];
    if (!st) { return null; }
    return {
      pos: st.pos ? st.pos.slice() : null,
      target: st.target ? st.target.slice() : null,
      active: !!st.active,
      yaw: st.yaw,
      pitch: st.pitch
    };
  }

  global.VfGameCamera = {
    sync: sync,
    attach: attach,
    applyGlobalCursorMode: applyGlobalCursorMode,
    getState: getState,
    __test: {
      computeYawPitch: computeYawPitch,
      forwardFromYawPitch: forwardFromYawPitch
    }
  };
})(typeof window !== "undefined" ? window : this);
