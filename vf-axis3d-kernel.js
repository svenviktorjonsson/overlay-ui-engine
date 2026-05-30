(function(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.VfAxis3DKernel = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  "use strict";

  function vec3Array(v, fallback) {
    return [
      Number(v && v[0]),
      Number(v && v[1]),
      Number(v && v[2])
    ].map(function(n, i) {
      return Number.isFinite(n) ? n : Number((fallback || [0, 0, 0])[i] || 0);
    });
  }

  function dot3(a, b) {
    return (Number(a && a[0]) || 0) * (Number(b && b[0]) || 0) +
      (Number(a && a[1]) || 0) * (Number(b && b[1]) || 0) +
      (Number(a && a[2]) || 0) * (Number(b && b[2]) || 0);
  }

  function crossVec3(a, b) {
    var ax = Number(a && a[0]) || 0;
    var ay = Number(a && a[1]) || 0;
    var az = Number(a && a[2]) || 0;
    var bx = Number(b && b[0]) || 0;
    var by = Number(b && b[1]) || 0;
    var bz = Number(b && b[2]) || 0;
    return [
      ay * bz - az * by,
      az * bx - ax * bz,
      ax * by - ay * bx
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

  function axis3DBoxSpan(cfg, axis) {
    var lo = Number(cfg && cfg[axis + "_min"]);
    var hi = Number(cfg && cfg[axis + "_max"]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { return 1; }
    return Math.max(1e-9, hi - lo);
  }

  function rotationCenter(cfg) {
    if (cfg && String(cfg.mode || "crosshair").toLowerCase() === "box") {
      return [
        ((Number(cfg.x_min) || 0) + (Number(cfg.x_max) || 0)) * 0.5,
        ((Number(cfg.y_min) || 0) + (Number(cfg.y_max) || 0)) * 0.5,
        ((Number(cfg.z_min) || 0) + (Number(cfg.z_max) || 0)) * 0.5
      ];
    }
    return [0, 0, 0];
  }

  function screenBasis(camera, center) {
    var pos = vec3Array(camera && camera.pos, [4, 4, 5.657]);
    var target = Array.isArray(center) ? center.slice() : vec3Array(camera && camera.target, [0, 0, 0]);
    var upHint = normalizeVec3Local(camera && camera.up || [0, 0, 1], [0, 0, 1]);
    var forward = normalizeVec3Local([target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]], [0, 0, -1]);
    var right = normalizeVec3Local(crossVec3(forward, upHint), [1, 0, 0]);
    var up = normalizeVec3Local(crossVec3(right, forward), [0, 0, 1]);
    return { right: right, up: up, forward: forward };
  }

  function applyWorldRotation(camera, center, worldAxis, angleRad) {
    var axis = normalizeVec3Local(worldAxis, [0, 0, 1]);
    var pos = vec3Array(camera && camera.pos, [4, 4, 5.657]);
    var target = Array.isArray(center) ? center.slice() : [0, 0, 0];
    var offset = [pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]];
    var nextOffset = rotateVec3AroundAxis(offset, axis, angleRad);
    var nextUp = rotateVec3AroundAxis(vec3Array(camera && camera.up, [0, 0, 1]), axis, angleRad);
    camera.pos = [target[0] + nextOffset[0], target[1] + nextOffset[1], target[2] + nextOffset[2]];
    camera.target = target;
    camera.up = normalizeVec3Local(nextUp, [0, 0, 1]);
    return camera;
  }

  function cloneCamera(camera) {
    var out = Object.assign({}, camera || {});
    out.pos = vec3Array(camera && camera.pos, [4, 4, 5.657]);
    out.target = vec3Array(camera && camera.target, [0, 0, 0]);
    out.up = vec3Array(camera && camera.up, [0, 0, 1]);
    return out;
  }

  function alignAxisToViewSnap(camera, cfg, axisIndex, sign) {
    var center = rotationCenter(cfg || {});
    var pos = vec3Array(camera && camera.pos, [4, 4, 5.657]);
    var tgt = vec3Array(camera && camera.target, center);
    var forward = normalizeVec3Local([tgt[0] - pos[0], tgt[1] - pos[1], tgt[2] - pos[2]], [0, 0, -1]);
    var basisAxes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    var desired = basisAxes[axisIndex] ? basisAxes[axisIndex].slice() : [0, 0, 1];
    var desiredSign = Number(sign) || 1;
    desired = [desired[0] * desiredSign, desired[1] * desiredSign, desired[2] * desiredSign];
    var d = Math.max(-1, Math.min(1, dot3(forward, desired)));
    var angle = Math.acos(d);
    if (!(angle > 1e-6)) { return false; }
    var axis = crossVec3(forward, desired);
    var axisLen = Math.sqrt(dot3(axis, axis));
    if (!(axisLen > 1e-9)) {
      var basis = screenBasis(camera, center);
      axis = crossVec3(forward, basis.right);
      axisLen = Math.sqrt(dot3(axis, axis));
      if (!(axisLen > 1e-9)) { return false; }
    }
    applyWorldRotation(camera, center, [axis[0] / axisLen, axis[1] / axisLen, axis[2] / axisLen], angle);
    return true;
  }

  function dragWorldDelta(camera, width, height, dx, dy) {
    var pos = vec3Array(camera && camera.pos, [4, 4, 5.657]);
    var target = vec3Array(camera && camera.target, [0, 0, 0]);
    var upHint = normalizeVec3Local(camera && camera.up || [0, 0, 1], [0, 0, 1]);
    var backward = normalizeVec3Local([pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]], [0, 0, 1]);
    var right = normalizeVec3Local(crossVec3(upHint, backward), [1, 0, 0]);
    var up = normalizeVec3Local(crossVec3(backward, right), [0, 0, 1]);
    var h = Math.max(1, Number(height) || 1);
    var dist = Math.sqrt(dot3([pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]], [pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]]));
    var isOrtho = String(camera && camera.projection || "").toLowerCase() === "orthographic";
    var fov = (Number(camera && camera.fov) || 45) * Math.PI / 180;
    var worldPerPx = isOrtho
      ? (2 * Math.max(1e-6, Number(camera && camera.ortho_scale) || 2.5)) / h
      : (2 * dist * Math.tan(fov * 0.5)) / h;
    return [
      (-dx * right[0] + dy * up[0]) * worldPerPx,
      (-dx * right[1] + dy * up[1]) * worldPerPx,
      (-dx * right[2] + dy * up[2]) * worldPerPx
    ];
  }

  function boxDragDataDelta(camera, width, height, cfg, dx, dy) {
    var pos = vec3Array(camera && camera.pos, [4, 4, 5.657]);
    var target = vec3Array(camera && camera.target, [0, 0, 0]);
    var upHint = normalizeVec3Local(camera && camera.up || [0, 0, 1], [0, 0, 1]);
    var backward = normalizeVec3Local([pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]], [0, 0, 1]);
    var right = normalizeVec3Local(crossVec3(upHint, backward), [1, 0, 0]);
    var up = normalizeVec3Local(crossVec3(backward, right), [0, 0, 1]);
    var pxSpan = Math.max(1, Math.min(Number(width) || 1, Number(height) || 1));
    var dataSpan = Math.max(axis3DBoxSpan(cfg, "x"), axis3DBoxSpan(cfg, "y"), axis3DBoxSpan(cfg, "z"));
    var unitsPerPx = dataSpan / pxSpan;
    return [
      (-dx * right[0] + dy * up[0]) * unitsPerPx,
      (-dx * right[1] + dy * up[1]) * unitsPerPx,
      (-dx * right[2] + dy * up[2]) * unitsPerPx
    ];
  }

  return {
    rotationCenter: rotationCenter,
    screenBasis: screenBasis,
    applyWorldRotation: applyWorldRotation,
    cloneCamera: cloneCamera,
    alignAxisToViewSnap: alignAxisToViewSnap,
    dragWorldDelta: dragWorldDelta,
    boxDragDataDelta: boxDragDataDelta
  };
});
