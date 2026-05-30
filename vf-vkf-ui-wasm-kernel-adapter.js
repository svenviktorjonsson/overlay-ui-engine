(function(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./vf-vkf-ui-kernel.js"),
      require("./vf-vkf-ui-wasm-module-factory.js")
    );
    return;
  }
  root.VfVkfUiWasmKernelAdapter = factory(root.VfVkfUiKernel, root.VfVkfUiWasmModuleFactory);
})(typeof globalThis !== "undefined" ? globalThis : this, function(kernel, wasmFactory) {
  "use strict";

  var FLOAT64_SLOT_COUNT = 64;
  var FLOAT64_BYTES = Float64Array.BYTES_PER_ELEMENT;
  var EXPORT_NAMES = wasmFactory && wasmFactory.EXPORT_NAMES ? wasmFactory.EXPORT_NAMES : {
    rotateScaleTransform: "vf_vkf_ui_rotate_scale_transform",
    scaleEdgeTransform: "vf_vkf_ui_scale_edge_transform",
    moveVertexToLocalCursor: "vf_vkf_ui_move_vertex_to_local_cursor",
    translateEdgeVertices: "vf_vkf_ui_translate_edge_vertices",
    pickVertexIndex: "vf_vkf_ui_pick_vertex_index",
    pickEdgeIndex: "vf_vkf_ui_pick_edge_index",
    pickFaceIndex: "vf_vkf_ui_pick_face_index"
  };

  function createScratch(options) {
    options = options || {};
    var memory = options.memory || null;
    if (memory && memory.buffer instanceof ArrayBuffer) {
      var availableSlots = Math.max(1, Math.floor(memory.buffer.byteLength / FLOAT64_BYTES));
      return {
        buffer: memory.buffer,
        view: new Float64Array(memory.buffer, 0, availableSlots),
        ptr: 0
      };
    }
    var buffer = new ArrayBuffer(FLOAT64_SLOT_COUNT * FLOAT64_BYTES);
    return {
      buffer: buffer,
      view: new Float64Array(buffer),
      ptr: 0
    };
  }

  function createWasmKernelAdapter(options) {
    options = options || {};
    var exportsObject = options.exports || {};
    var fallback = options.fallbackKernel || kernel;
    var scratch = createScratch(options);

    function rotateScaleTransform(state) {
      if (typeof exportsObject[EXPORT_NAMES.rotateScaleTransform] !== "function") {
        return fallback.rotateScaleTransform(state);
      }
      var f = scratch.view;
      f[0] = state.matrix[0];
      f[1] = state.matrix[1];
      f[2] = state.matrix[2];
      f[3] = state.matrix[3];
      f[4] = state.offset[0];
      f[5] = state.offset[1];
      f[6] = Number(state.angle || 0);
      f[7] = Number(state.scale == null ? 1 : state.scale);
      f[8] = Number(state.origo && state.origo[0] || 0);
      f[9] = Number(state.origo && state.origo[1] || 0);
      exportsObject[EXPORT_NAMES.rotateScaleTransform](scratch.ptr);
      return {
        matrix: [f[10], f[11], f[12], f[13]],
        offset: [f[14], f[15]]
      };
    }

    function scaleEdgeTransform(state) {
      if (typeof exportsObject[EXPORT_NAMES.scaleEdgeTransform] !== "function") {
        return fallback.scaleEdgeTransform(state);
      }
      var f = scratch.view;
      f[0] = state.matrix[0];
      f[1] = state.matrix[1];
      f[2] = state.matrix[2];
      f[3] = state.matrix[3];
      f[4] = state.offset[0];
      f[5] = state.offset[1];
      f[6] = Number(state.edgeA && state.edgeA[0] || 0);
      f[7] = Number(state.edgeA && state.edgeA[1] || 0);
      f[8] = Number(state.edgeB && state.edgeB[0] || 0);
      f[9] = Number(state.edgeB && state.edgeB[1] || 0);
      f[10] = Number(state.scale == null ? 1 : state.scale);
      f[11] = Number(state.origo && state.origo[0] || 0);
      f[12] = Number(state.origo && state.origo[1] || 0);
      exportsObject[EXPORT_NAMES.scaleEdgeTransform](scratch.ptr);
      return {
        matrix: [f[13], f[14], f[15], f[16]],
        offset: [f[17], f[18]]
      };
    }

    function moveVertexToLocalCursor(state) {
      if (typeof exportsObject[EXPORT_NAMES.moveVertexToLocalCursor] !== "function") {
        return fallback.moveVertexToLocalCursor(state);
      }
      var result = exportsObject[EXPORT_NAMES.moveVertexToLocalCursor](state, scratch.ptr, scratch.view);
      if (result) {
        return result;
      }
      if (!state || !state.coords || !Array.isArray(state.coords.x) || !Array.isArray(state.coords.y) || !Array.isArray(state.coords.z)) {
        return fallback.moveVertexToLocalCursor(state);
      }
      var count = state.coords.x.length;
      var required = 4 + count * 3;
      if (required > scratch.view.length) {
        return fallback.moveVertexToLocalCursor(state);
      }
      var f = scratch.view;
      f[0] = count;
      f[1] = Number(state.vertex || 0);
      f[2] = Number(state.localCursor && state.localCursor[0] || 0);
      f[3] = Number(state.localCursor && state.localCursor[1] || 0);
      for (var i = 0; i < count; i += 1) {
        f[4 + i] = Number(state.coords.x[i] || 0);
        f[4 + count + i] = Number(state.coords.y[i] || 0);
        f[4 + count * 2 + i] = Number(state.coords.z[i] || 0);
      }
      exportsObject[EXPORT_NAMES.moveVertexToLocalCursor](scratch.ptr);
      var nextX = new Array(count);
      var nextY = new Array(count);
      var nextZ = new Array(count);
      for (i = 0; i < count; i += 1) {
        nextX[i] = Number(f[4 + i]);
        nextY[i] = Number(f[4 + count + i]);
        nextZ[i] = Number(f[4 + count * 2 + i]);
      }
      return { x: nextX, y: nextY, z: nextZ };
    }

    function translateEdgeVertices(state) {
      if (typeof exportsObject[EXPORT_NAMES.translateEdgeVertices] !== "function") {
        return fallback.translateEdgeVertices(state);
      }
      var result = exportsObject[EXPORT_NAMES.translateEdgeVertices](state, scratch.ptr, scratch.view);
      if (result) {
        return result;
      }
      if (!state || !state.coords || !Array.isArray(state.coords.x) || !Array.isArray(state.coords.y) || !Array.isArray(state.coords.z)) {
        return fallback.translateEdgeVertices(state);
      }
      var count = state.coords.x.length;
      var edgeCount = state.edge ? state.edge.length : 0;
      var required = 3 + edgeCount + count * 3;
      if (required > scratch.view.length) {
        return fallback.translateEdgeVertices(state);
      }
      var f = scratch.view;
      f[0] = count;
      f[1] = edgeCount;
      f[2] = Number(state.localTrans && state.localTrans[0] || 0);
      f[3] = Number(state.localTrans && state.localTrans[1] || 0);
      var cursor = 4;
      var i;
      for (i = 0; i < edgeCount; i += 1) {
        f[cursor + i] = Number(state.edge[i] || 0);
      }
      cursor += edgeCount;
      for (i = 0; i < count; i += 1) {
        f[cursor + i] = Number(state.coords.x[i] || 0);
        f[cursor + count + i] = Number(state.coords.y[i] || 0);
        f[cursor + count * 2 + i] = Number(state.coords.z[i] || 0);
      }
      exportsObject[EXPORT_NAMES.translateEdgeVertices](scratch.ptr);
      var nextX = new Array(count);
      var nextY = new Array(count);
      var nextZ = new Array(count);
      for (i = 0; i < count; i += 1) {
        nextX[i] = Number(f[cursor + i]);
        nextY[i] = Number(f[cursor + count + i]);
        nextZ[i] = Number(f[cursor + count * 2 + i]);
      }
      return { x: nextX, y: nextY, z: nextZ };
    }

    function writePointList(view, startIndex, points) {
      for (var i = 0; i < points.length; i += 1) {
        view[startIndex + i * 2] = Number(points[i][0] || 0);
        view[startIndex + i * 2 + 1] = Number(points[i][1] || 0);
      }
    }

    function pickVertexIndex(state) {
      if (typeof exportsObject[EXPORT_NAMES.pickVertexIndex] !== "function" || !state.worldPoints || !state.vertexPickRadii) {
        return fallback.pickVertexIndex(state);
      }
      var f = scratch.view;
      var count = state.vertices.length;
      f[0] = Number(state.point[0] || 0);
      f[1] = Number(state.point[1] || 0);
      f[2] = count;
      for (var i = 0; i < count; i += 1) {
        var vertexIndex = state.vertices[i];
        var base = 3 + i * 3;
        f[base] = Number(state.worldPoints[vertexIndex][0] || 0);
        f[base + 1] = Number(state.worldPoints[vertexIndex][1] || 0);
        f[base + 2] = Number(state.vertexPickRadii[vertexIndex] || 0);
      }
      exportsObject[EXPORT_NAMES.pickVertexIndex](scratch.ptr);
      var result = f[3 + count * 3];
      return Number(result == null ? -1 : result);
    }

    function pickEdgeIndex(state) {
      if (typeof exportsObject[EXPORT_NAMES.pickEdgeIndex] !== "function" || !state.worldPoints || !state.edgePickRadii) {
        return fallback.pickEdgeIndex(state);
      }
      var f = scratch.view;
      var count = state.edges.length;
      f[0] = Number(state.point[0] || 0);
      f[1] = Number(state.point[1] || 0);
      f[2] = count;
      for (var i = 0; i < count; i += 1) {
        var edge = state.edges[i];
        var base = 3 + i * 5;
        f[base] = Number(state.worldPoints[edge[0]][0] || 0);
        f[base + 1] = Number(state.worldPoints[edge[0]][1] || 0);
        f[base + 2] = Number(state.worldPoints[edge[1]][0] || 0);
        f[base + 3] = Number(state.worldPoints[edge[1]][1] || 0);
        f[base + 4] = Number(state.edgePickRadii[i] || 0);
      }
      exportsObject[EXPORT_NAMES.pickEdgeIndex](scratch.ptr);
      var result = f[3 + count * 5];
      return Number(result == null ? -1 : result);
    }

    function pickFaceIndex(state) {
      if (typeof exportsObject[EXPORT_NAMES.pickFaceIndex] !== "function" || !state.worldPoints) {
        return fallback.pickFaceIndex(state);
      }
      var f = scratch.view;
      var faceCount = state.faces.length;
      f[0] = Number(state.point[0] || 0);
      f[1] = Number(state.point[1] || 0);
      f[2] = faceCount;
      var cursor = 3;
      for (var i = 0; i < faceCount; i += 1) {
        var face = state.faces[i];
        f[cursor] = face.length;
        cursor += 1;
        for (var j = 0; j < face.length; j += 1) {
          var index = face[j];
          f[cursor] = Number(state.worldPoints[index][0] || 0);
          f[cursor + 1] = Number(state.worldPoints[index][1] || 0);
          cursor += 2;
        }
      }
      exportsObject[EXPORT_NAMES.pickFaceIndex](scratch.ptr);
      var result = f[cursor];
      return Number(result == null ? -1 : result);
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
  }

  return {
    FLOAT64_SLOT_COUNT: FLOAT64_SLOT_COUNT,
    createWasmKernelAdapter: createWasmKernelAdapter
  };
});
