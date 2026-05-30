(function(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./vf-vkf-ui-math.js"));
    return;
  }
  root.VfVkfUiKernel = factory(root.VfVkfUiMath);
})(typeof globalThis !== "undefined" ? globalThis : this, function(math) {
  "use strict";

  function worldPointAt(state, index) {
    if (state.worldPoints) {
      return state.worldPoints[index];
    }
    return state.worldPoint(index);
  }

  function vertexPickRadiusAt(state, index) {
    if (state.vertexPickRadii) {
      return state.vertexPickRadii[index] == null ? 0 : state.vertexPickRadii[index];
    }
    return state.vertexPickRadiusAt(index);
  }

  function edgePickRadiusAt(state, index) {
    if (state.edgePickRadii) {
      return state.edgePickRadii[index] == null ? 0 : state.edgePickRadii[index];
    }
    return state.edgePickRadiusAt(index);
  }

  function rotateScaleTransform(state) {
    var angle = Number(state && state.angle || 0);
    var scale = Number(state && state.scale == null ? 1 : state.scale);
    var origo = math.cloneVec2(state && state.origo);
    var matrix = state.matrix.slice();
    var offset = state.offset.slice();
    var c = Math.cos(angle) * scale;
    var s = Math.sin(angle) * scale;
    var transform = [c, -s, s, c];
    var nextMatrix = math.matMul2(transform, matrix);
    var shifted = math.sub2(offset, origo);
    var rotated = math.matVec2(transform, shifted);
    var nextOffset = math.add2(origo, rotated);
    return { matrix: nextMatrix, offset: nextOffset };
  }

  function scaleEdgeTransform(state) {
    var edgeA = state.edgeA;
    var edgeB = state.edgeB;
    var tangent = math.normalize2(math.sub2(edgeB, edgeA));
    var normal = [-tangent[1], tangent[0]];
    var scale = Number(state && state.scale == null ? 1 : state.scale);
    var origo = math.cloneVec2(state && state.origo);
    var matrix = state.matrix.slice();
    var offset = state.offset.slice();
    var n0 = normal[0];
    var n1 = normal[1];
    var tangentScale = 1;
    var transform = [
      tangentScale + (scale - tangentScale) * n0 * n0,
      (scale - tangentScale) * n0 * n1,
      (scale - tangentScale) * n1 * n0,
      tangentScale + (scale - tangentScale) * n1 * n1
    ];
    var nextMatrix = math.matMul2(transform, matrix);
    var shifted = math.sub2(offset, origo);
    var nextOffset = math.add2(origo, math.matVec2(transform, shifted));
    return { matrix: nextMatrix, offset: nextOffset };
  }

  function moveVertexToLocalCursor(state) {
    var coords = state.coords;
    var vertex = state.vertex | 0;
    var localCursor = state.localCursor;
    var inv = math.invert2(state.matrix);
    var nextInner = math.matVec2(inv, [localCursor[0] - state.offset[0], localCursor[1] - state.offset[1]]);
    var nextX = coords.x.slice();
    var nextY = coords.y.slice();
    nextX[vertex] = nextInner[0];
    nextY[vertex] = nextInner[1];
    return { x: nextX, y: nextY, z: coords.z.slice() };
  }

  function translateEdgeVertices(state) {
    var coords = state.coords;
    var edge = state.edge.slice();
    var localTrans = state.localTrans;
    var inv = math.invert2(state.matrix);
    var innerDelta = math.matVec2(inv, localTrans);
    var nextX = coords.x.slice();
    var nextY = coords.y.slice();
    for (var i = 0; i < edge.length; i += 1) {
      var vertex = edge[i];
      nextX[vertex] += innerDelta[0];
      nextY[vertex] += innerDelta[1];
    }
    return { x: nextX, y: nextY, z: coords.z.slice() };
  }

  function pickVertexIndex(state) {
    for (var i = 0; i < state.vertices.length; i += 1) {
      var vertexIndex = state.vertices[i];
      var vertexPoint = worldPointAt(state, vertexIndex);
      if (math.length2(math.sub2(state.point, vertexPoint)) <= vertexPickRadiusAt(state, vertexIndex)) {
        return vertexIndex;
      }
    }
    return -1;
  }

  function pickEdgeIndex(state) {
    for (var i = 0; i < state.edges.length; i += 1) {
      var edge = state.edges[i];
      var edgeDistance = math.distancePointToSegment(state.point, worldPointAt(state, edge[0]), worldPointAt(state, edge[1]));
      if (edgeDistance.distance <= edgePickRadiusAt(state, i)) {
        return i;
      }
    }
    return -1;
  }

  function pickFaceIndex(state) {
    for (var i = 0; i < state.faces.length; i += 1) {
      var polygon = state.faces[i].map(function(index) { return worldPointAt(state, index); });
      if (math.pointInPolygon(state.point, polygon)) {
        return i;
      }
    }
    return -1;
  }

  return {
    rotateScaleTransform: rotateScaleTransform,
    scaleEdgeTransform: scaleEdgeTransform,
    moveVertexToLocalCursor: moveVertexToLocalCursor,
    translateEdgeVertices: translateEdgeVertices,
    pickVertexIndex: pickVertexIndex,
    pickEdgeIndex: pickEdgeIndex,
    pickFaceIndex: pickFaceIndex
  };
});
