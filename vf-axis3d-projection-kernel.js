(function(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.VfAxis3DProjectionKernel = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  "use strict";

  function normalizeUndirectedAngleDeg(angleDeg) {
    var angle = Number(angleDeg) || 0;
    while (angle <= -90) { angle += 180; }
    while (angle > 90) { angle -= 180; }
    return angle;
  }

  function nearestAxisSnapAngleDeg(angleDeg, targets) {
    var angle = normalizeUndirectedAngleDeg(angleDeg);
    var best = { angleDeg: angle, diffDeg: Infinity };
    for (var i = 0; i < targets.length; i += 1) {
      var target = normalizeUndirectedAngleDeg(targets[i]);
      var diff = Math.abs(normalizeUndirectedAngleDeg(angle - target));
      if (diff < best.diffDeg) {
        best = { angleDeg: target, diffDeg: diff };
      }
    }
    return best;
  }

  function createProjectionKernel(deps) {
    deps = deps || {};
    var rotationCenter = deps.rotationCenter;
    var projectWorldToPixel = deps.projectWorldToPixel;
    var clipPixelLineToRect = deps.clipPixelLineToRect;
    var cloneCamera = deps.cloneCamera;
    var screenBasis = deps.screenBasis;
    var applyWorldRotation = deps.applyWorldRotation;

    function projectedAxisInfos(camera, rectLike, cfg) {
      var rect = rectLike || { width: 1, height: 1 };
      var w = Math.max(1, Number(rect.width) || 1);
      var h = Math.max(1, Number(rect.height) || 1);
      var center = rotationCenter(cfg || {});
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
          0, 0, w, h
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
      return { rect: rect, w: w, h: h, center: center, p0: p0, axisInfos: axisInfos };
    }

    function projectedAxisAngleDeg(info) {
      if (!info) { return null; }
      return normalizeUndirectedAngleDeg(Math.atan2(info.uy, info.ux) * 180 / Math.PI);
    }

    function projectedAxisDiffDeg(camera, rectLike, cfg, axisIndex, targetAngleDeg) {
      var projected = projectedAxisInfos(camera, rectLike, cfg);
      if (!projected || !projected.axisInfos[axisIndex]) { return Infinity; }
      var angleDeg = projectedAxisAngleDeg(projected.axisInfos[axisIndex]);
      return nearestAxisSnapAngleDeg(angleDeg, [targetAngleDeg]).diffDeg;
    }

    function alignProjectedAxisToScreenSnap(camera, rectLike, cfg, axisIndex, targetAngleDeg) {
      var projected = projectedAxisInfos(camera, rectLike, cfg);
      if (!projected || !projected.axisInfos[axisIndex]) { return false; }
      var rawAngle = projectedAxisAngleDeg(projected.axisInfos[axisIndex]);
      var nearest = nearestAxisSnapAngleDeg(rawAngle, [targetAngleDeg]);
      if (!(nearest.diffDeg > 1e-6)) { return false; }
      var magnitudeRad = nearest.diffDeg * Math.PI / 180;
      var best = null;
      for (var si = 0; si < 2; si += 1) {
        var sign = si === 0 ? 1 : -1;
        var trial = cloneCamera(camera);
        var basis = screenBasis(trial, projected.center);
        applyWorldRotation(trial, projected.center, basis.forward, sign * magnitudeRad);
        var diff = projectedAxisDiffDeg(trial, rectLike, cfg, axisIndex, targetAngleDeg);
        if (!best || diff < best.diff) {
          best = { sign: sign, diff: diff };
        }
      }
      if (!best) { return false; }
      var liveBasis = screenBasis(camera, projected.center);
      applyWorldRotation(camera, projected.center, liveBasis.forward, best.sign * magnitudeRad);
      return true;
    }

    return {
      projectedAxisInfos: projectedAxisInfos,
      projectedAxisAngleDeg: projectedAxisAngleDeg,
      projectedAxisDiffDeg: projectedAxisDiffDeg,
      alignProjectedAxisToScreenSnap: alignProjectedAxisToScreenSnap,
      nearestAxisSnapAngleDeg: nearestAxisSnapAngleDeg,
      normalizeUndirectedAngleDeg: normalizeUndirectedAngleDeg
    };
  }

  return {
    createProjectionKernel: createProjectionKernel,
    nearestAxisSnapAngleDeg: nearestAxisSnapAngleDeg,
    normalizeUndirectedAngleDeg: normalizeUndirectedAngleDeg
  };
});
