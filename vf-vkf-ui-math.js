(function(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.VfVkfUiMath = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  "use strict";

  function cloneVec2(value) {
    return [Number(value && value[0] || 0), Number(value && value[1] || 0)];
  }

  function cloneVec3(value) {
    return [Number(value && value[0] || 0), Number(value && value[1] || 0), Number(value && value[2] || 0)];
  }

  function matMul2(a, b) {
    return [
      a[0] * b[0] + a[1] * b[2],
      a[0] * b[1] + a[1] * b[3],
      a[2] * b[0] + a[3] * b[2],
      a[2] * b[1] + a[3] * b[3]
    ];
  }

  function matVec2(a, v) {
    return [
      a[0] * v[0] + a[1] * v[1],
      a[2] * v[0] + a[3] * v[1]
    ];
  }

  function det2(a) {
    return a[0] * a[3] - a[1] * a[2];
  }

  function invert2(a) {
    var d = det2(a);
    if (Math.abs(d) < 1e-9) {
      return [1, 0, 0, 1];
    }
    return [
      canonicalZero(a[3] / d),
      canonicalZero(-a[1] / d),
      canonicalZero(-a[2] / d),
      canonicalZero(a[0] / d)
    ];
  }

  function canonicalZero(value) {
    return Object.is(value, -0) ? 0 : value;
  }

  function add2(a, b) {
    return [a[0] + b[0], a[1] + b[1]];
  }

  function sub2(a, b) {
    return [a[0] - b[0], a[1] - b[1]];
  }

  function scale2(v, s) {
    return [v[0] * s, v[1] * s];
  }

  function length2(v) {
    return Math.sqrt(v[0] * v[0] + v[1] * v[1]);
  }

  function normalize2(v) {
    var len = length2(v);
    if (len < 1e-9) {
      return [1, 0];
    }
    return [v[0] / len, v[1] / len];
  }

  function pointInPolygon(point, polygon) {
    var inside = false;
    for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      var xi = polygon[i][0];
      var yi = polygon[i][1];
      var xj = polygon[j][0];
      var yj = polygon[j][1];
      var intersect = ((yi > point[1]) !== (yj > point[1])) &&
        (point[0] < (xj - xi) * (point[1] - yi) / ((yj - yi) || 1e-9) + xi);
      if (intersect) {
        inside = !inside;
      }
    }
    return inside;
  }

  function distancePointToSegment(point, a, b) {
    var ab = sub2(b, a);
    var ap = sub2(point, a);
    var denom = ab[0] * ab[0] + ab[1] * ab[1];
    var t = denom > 0 ? (ap[0] * ab[0] + ap[1] * ab[1]) / denom : 0;
    if (t < 0) { t = 0; }
    if (t > 1) { t = 1; }
    var closest = [a[0] + ab[0] * t, a[1] + ab[1] * t];
    return { distance: length2(sub2(point, closest)), closest: closest };
  }

  return {
    cloneVec2: cloneVec2,
    cloneVec3: cloneVec3,
    matMul2: matMul2,
    matVec2: matVec2,
    det2: det2,
    invert2: invert2,
    add2: add2,
    sub2: sub2,
    scale2: scale2,
    length2: length2,
    normalize2: normalize2,
    pointInPolygon: pointInPolygon,
    distancePointToSegment: distancePointToSegment
  };
});
