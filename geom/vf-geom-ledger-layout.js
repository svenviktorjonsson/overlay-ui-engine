/**
 * vf-geom-ledger-layout.js — explicit binary layouts for geometry ledger state.
 *
 * First layout:
 * - face/edge/vertex editing state
 * - fixed-size typed-array view over a shared state buffer
 *
 * This is the seam native/WASM producers should target.
 */
(function (global) {
  "use strict";

  if (global.VfGeomLedgerLayout) { return; }

  function fail(msg) {
    throw new Error("[vf-geom-ledger-layout] " + String(msg));
  }

  var FACE_EDGE_VERTEX_STATE_FORMAT = 1001;
  var SURFACE_HEIGHTFIELD_STATE_FORMAT = 1002;
  var F32_POINT_COUNT = 8;
  var I32_EDGE_COUNT = 8;
  var U8_SELECTION_EDGE_COUNT = 4;
  var U8_SELECTION_VERTEX_COUNT = 4;
  var U8_DRAG_VERTEX_COUNT = 4;

  function align4(offset) {
    var mod = offset % 4;
    return mod === 0 ? offset : (offset + (4 - mod));
  }

  var OFF_F32_POINTS = 0;
  var OFF_I32_EDGES = OFF_F32_POINTS + (F32_POINT_COUNT * Float32Array.BYTES_PER_ELEMENT);
  var OFF_U8_SELECTION_FACE = OFF_I32_EDGES + (I32_EDGE_COUNT * Int32Array.BYTES_PER_ELEMENT);
  var OFF_U8_SELECTION_EDGES = OFF_U8_SELECTION_FACE + 1;
  var OFF_U8_SELECTION_VERTICES = OFF_U8_SELECTION_EDGES + U8_SELECTION_EDGE_COUNT;
  var OFF_U8_HOVER_KIND = OFF_U8_SELECTION_VERTICES + U8_SELECTION_VERTEX_COUNT;
  var OFF_I32_HOVER_INDEX = align4(OFF_U8_HOVER_KIND + 1);
  var OFF_I32_LAST_OBJECT_ID = OFF_I32_HOVER_INDEX + Int32Array.BYTES_PER_ELEMENT;
  var OFF_I32_LAST_SIMPLEX_ID = OFF_I32_LAST_OBJECT_ID + Int32Array.BYTES_PER_ELEMENT;
  var OFF_U8_LAST_KIND = OFF_I32_LAST_SIMPLEX_ID + Int32Array.BYTES_PER_ELEMENT;
  var OFF_I32_LAST_INDEX = align4(OFF_U8_LAST_KIND + 1);
  var OFF_U8_DRAG_ACTIVE = OFF_I32_LAST_INDEX + Int32Array.BYTES_PER_ELEMENT;
  var OFF_U8_DRAG_KIND = OFF_U8_DRAG_ACTIVE + 1;
  var OFF_I32_DRAG_INDEX = align4(OFF_U8_DRAG_KIND + 1);
  var OFF_I32_DRAG_POINTER_ID = OFF_I32_DRAG_INDEX + Int32Array.BYTES_PER_ELEMENT;
  var OFF_U8_DRAG_VERTICES = OFF_I32_DRAG_POINTER_ID + Int32Array.BYTES_PER_ELEMENT;
  var FACE_EDGE_VERTEX_STATE_BYTE_LENGTH = OFF_U8_DRAG_VERTICES + U8_DRAG_VERTEX_COUNT;

  var OFF_I32_SURFACE_U_COUNT = 0;
  var OFF_I32_SURFACE_V_COUNT = OFF_I32_SURFACE_U_COUNT + Int32Array.BYTES_PER_ELEMENT;
  var OFF_I32_SURFACE_FRAME_INDEX = OFF_I32_SURFACE_V_COUNT + Int32Array.BYTES_PER_ELEMENT;
  var OFF_I32_SURFACE_BOUNDARY = OFF_I32_SURFACE_FRAME_INDEX + Int32Array.BYTES_PER_ELEMENT;
  var OFF_F32_SURFACE_PHASE = OFF_I32_SURFACE_BOUNDARY + Int32Array.BYTES_PER_ELEMENT;
  var OFF_F32_SURFACE_U_VALUES = align4(OFF_F32_SURFACE_PHASE + Float32Array.BYTES_PER_ELEMENT);

  function requirePositiveInt(value, name, minimum) {
    var out = Number(value) | 0;
    if (!Number.isFinite(Number(value)) || out !== Number(value) || out < minimum) {
      fail(name + " must be an integer >= " + String(minimum));
    }
    return out;
  }

  function surfaceHeightfieldOffsets(uCount, vCount) {
    var uLen = requirePositiveInt(uCount, "uCount", 2);
    var vLen = requirePositiveInt(vCount, "vCount", 2);
    var offV = OFF_F32_SURFACE_U_VALUES + (uLen * Float32Array.BYTES_PER_ELEMENT);
    var offH = offV + (vLen * Float32Array.BYTES_PER_ELEMENT);
    return {
      uCount: uLen,
      vCount: vLen,
      offUValues: OFF_F32_SURFACE_U_VALUES,
      offVValues: offV,
      offHeights: offH,
      byteLength: offH + (uLen * vLen * Float32Array.BYTES_PER_ELEMENT)
    };
  }

  function createFaceEdgeVertexStateBuffer(useSharedArrayBuffer) {
    var Ctor = useSharedArrayBuffer ? SharedArrayBuffer : ArrayBuffer;
    return new Ctor(FACE_EDGE_VERTEX_STATE_BYTE_LENGTH);
  }

  function createSurfaceHeightfieldStateBuffer(uCount, vCount, useSharedArrayBuffer) {
    var Ctor = useSharedArrayBuffer ? SharedArrayBuffer : ArrayBuffer;
    return new Ctor(surfaceHeightfieldOffsets(uCount, vCount).byteLength);
  }

  function bindFaceEdgeVertexState(buffer) {
    if (!(buffer instanceof ArrayBuffer) && !(typeof SharedArrayBuffer === "function" && buffer instanceof SharedArrayBuffer)) {
      fail("bindFaceEdgeVertexState requires ArrayBuffer or SharedArrayBuffer");
    }
    if (buffer.byteLength < FACE_EDGE_VERTEX_STATE_BYTE_LENGTH) {
      fail("face-edge-vertex state buffer too small");
    }

    var points = new Float32Array(buffer, OFF_F32_POINTS, F32_POINT_COUNT);
    var edgePairs = new Int32Array(buffer, OFF_I32_EDGES, I32_EDGE_COUNT);
    var selectionFace = new Uint8Array(buffer, OFF_U8_SELECTION_FACE, 1);
    var selectionEdges = new Uint8Array(buffer, OFF_U8_SELECTION_EDGES, U8_SELECTION_EDGE_COUNT);
    var selectionVertices = new Uint8Array(buffer, OFF_U8_SELECTION_VERTICES, U8_SELECTION_VERTEX_COUNT);
    var hoverKind = new Uint8Array(buffer, OFF_U8_HOVER_KIND, 1);
    var hoverIndex = new Int32Array(buffer, OFF_I32_HOVER_INDEX, 1);
    var lastObjectId = new Int32Array(buffer, OFF_I32_LAST_OBJECT_ID, 1);
    var lastSimplexId = new Int32Array(buffer, OFF_I32_LAST_SIMPLEX_ID, 1);
    var lastKind = new Uint8Array(buffer, OFF_U8_LAST_KIND, 1);
    var lastIndex = new Int32Array(buffer, OFF_I32_LAST_INDEX, 1);
    var dragActive = new Uint8Array(buffer, OFF_U8_DRAG_ACTIVE, 1);
    var dragKind = new Uint8Array(buffer, OFF_U8_DRAG_KIND, 1);
    var dragIndex = new Int32Array(buffer, OFF_I32_DRAG_INDEX, 1);
    var dragPointerId = new Int32Array(buffer, OFF_I32_DRAG_POINTER_ID, 1);
    var dragVertices = new Uint8Array(buffer, OFF_U8_DRAG_VERTICES, U8_DRAG_VERTEX_COUNT);

    function writeInitial(pointsInput, edgePairsInput) {
      var i;
      if (!Array.isArray(pointsInput) || pointsInput.length !== 4) {
        fail("writeInitial requires 4 points");
      }
      if (!Array.isArray(edgePairsInput) || edgePairsInput.length !== 4) {
        fail("writeInitial requires 4 edge pairs");
      }
      for (i = 0; i < 4; i += 1) {
        points[i * 2] = Number(pointsInput[i][0]) || 0;
        points[i * 2 + 1] = Number(pointsInput[i][1]) || 0;
      }
      for (i = 0; i < 4; i += 1) {
        edgePairs[i * 2] = Number(edgePairsInput[i][0]) | 0;
        edgePairs[i * 2 + 1] = Number(edgePairsInput[i][1]) | 0;
      }
      selectionFace[0] = 0;
      selectionEdges.fill(0);
      selectionVertices.fill(0);
      hoverKind[0] = 0;
      hoverIndex[0] = -1;
      lastObjectId[0] = 0;
      lastSimplexId[0] = -1;
      lastKind[0] = 0;
      lastIndex[0] = -1;
      dragActive[0] = 0;
      dragKind[0] = 0;
      dragIndex[0] = -1;
      dragPointerId[0] = 0;
      dragVertices.fill(0);
    }

    function toPlainState(kindName) {
      var plainPoints = [];
      var plainEdges = [];
      var i;
      for (i = 0; i < 4; i += 1) {
        plainPoints.push([points[i * 2], points[i * 2 + 1]]);
        plainEdges.push([edgePairs[i * 2], edgePairs[i * 2 + 1]]);
      }
      return {
        points: plainPoints,
        edgePairs: plainEdges,
        selection: {
          faceSelected: !!selectionFace[0],
          edgeSelected: Array.from(selectionEdges, function (v) { return !!v; }),
          vertexSelected: Array.from(selectionVertices, function (v) { return !!v; }),
        },
        hover: { kind: kindName(hoverKind[0]), index: hoverIndex[0] },
        lastHit: {
          objectId: lastObjectId[0],
          simplexId: lastSimplexId[0],
          kind: kindName(lastKind[0]),
          index: lastIndex[0],
        },
        drag: {
          active: !!dragActive[0],
          kind: kindName(dragKind[0]),
          index: dragIndex[0],
          pointerId: dragPointerId[0] || null,
          vertices: Array.from(dragVertices, function (v) { return !!v; }),
        },
      };
    }

    function writePlainState(plainState, kindCode) {
      plainState = plainState || {};
      var i;
      var pointsIn = Array.isArray(plainState.points) ? plainState.points : null;
      var edgesIn = Array.isArray(plainState.edgePairs) ? plainState.edgePairs : null;
      if (pointsIn && pointsIn.length === 4) {
        for (i = 0; i < 4; i += 1) {
          points[i * 2] = Number(pointsIn[i][0]) || 0;
          points[i * 2 + 1] = Number(pointsIn[i][1]) || 0;
        }
      }
      if (edgesIn && edgesIn.length === 4) {
        for (i = 0; i < 4; i += 1) {
          edgePairs[i * 2] = Number(edgesIn[i][0]) | 0;
          edgePairs[i * 2 + 1] = Number(edgesIn[i][1]) | 0;
        }
      }
      var selection = plainState.selection || {};
      selectionFace[0] = selection.faceSelected ? 1 : 0;
      for (i = 0; i < 4; i += 1) {
        selectionEdges[i] = selection.edgeSelected && selection.edgeSelected[i] ? 1 : 0;
        selectionVertices[i] = selection.vertexSelected && selection.vertexSelected[i] ? 1 : 0;
      }
      var hover = plainState.hover || {};
      hoverKind[0] = kindCode(hover.kind || "none");
      hoverIndex[0] = Number.isFinite(Number(hover.index)) ? (Number(hover.index) | 0) : -1;
      var lastHit = plainState.lastHit || {};
      lastObjectId[0] = Number(lastHit.objectId) | 0;
      lastSimplexId[0] = Number.isFinite(Number(lastHit.simplexId)) ? (Number(lastHit.simplexId) | 0) : -1;
      lastKind[0] = kindCode(lastHit.kind || "none");
      lastIndex[0] = Number.isFinite(Number(lastHit.index)) ? (Number(lastHit.index) | 0) : -1;
      var drag = plainState.drag || {};
      dragActive[0] = drag.active ? 1 : 0;
      dragKind[0] = kindCode(drag.kind || "none");
      dragIndex[0] = Number.isFinite(Number(drag.index)) ? (Number(drag.index) | 0) : -1;
      dragPointerId[0] = drag.pointerId == null ? 0 : (Number(drag.pointerId) | 0);
      for (i = 0; i < 4; i += 1) {
        dragVertices[i] = drag.vertices && drag.vertices[i] ? 1 : 0;
      }
    }

    return {
      buffer: buffer,
      points: points,
      edgePairs: edgePairs,
      selectionFace: selectionFace,
      selectionEdges: selectionEdges,
      selectionVertices: selectionVertices,
      hoverKind: hoverKind,
      hoverIndex: hoverIndex,
      lastObjectId: lastObjectId,
      lastSimplexId: lastSimplexId,
      lastKind: lastKind,
      lastIndex: lastIndex,
      dragActive: dragActive,
      dragKind: dragKind,
      dragIndex: dragIndex,
      dragPointerId: dragPointerId,
      dragVertices: dragVertices,
      writeInitial: writeInitial,
      writePlainState: writePlainState,
      toPlainState: toPlainState,
    };
  }

  function bindSurfaceHeightfieldState(buffer, uCount, vCount) {
    var layout = surfaceHeightfieldOffsets(uCount, vCount);
    if (!(buffer instanceof ArrayBuffer) && !(typeof SharedArrayBuffer === "function" && buffer instanceof SharedArrayBuffer)) {
      fail("bindSurfaceHeightfieldState requires ArrayBuffer or SharedArrayBuffer");
    }
    if (buffer.byteLength < layout.byteLength) {
      fail("surface-heightfield state buffer too small");
    }

    var uCountView = new Int32Array(buffer, OFF_I32_SURFACE_U_COUNT, 1);
    var vCountView = new Int32Array(buffer, OFF_I32_SURFACE_V_COUNT, 1);
    var frameIndex = new Int32Array(buffer, OFF_I32_SURFACE_FRAME_INDEX, 1);
    var boundaryCode = new Int32Array(buffer, OFF_I32_SURFACE_BOUNDARY, 1);
    var phase = new Float32Array(buffer, OFF_F32_SURFACE_PHASE, 1);
    var uValues = new Float32Array(buffer, layout.offUValues, layout.uCount);
    var vValues = new Float32Array(buffer, layout.offVValues, layout.vCount);
    var heights = new Float32Array(buffer, layout.offHeights, layout.uCount * layout.vCount);

    function writeInitial(nextUValues, nextVValues) {
      var i;
      if (!nextUValues || Number(nextUValues.length) !== layout.uCount) {
        fail("writeInitial requires uCount sampled u values");
      }
      if (!nextVValues || Number(nextVValues.length) !== layout.vCount) {
        fail("writeInitial requires vCount sampled v values");
      }
      uCountView[0] = layout.uCount;
      vCountView[0] = layout.vCount;
      frameIndex[0] = 0;
      boundaryCode[0] = 0;
      phase[0] = 0.0;
      for (i = 0; i < layout.uCount; i += 1) {
        uValues[i] = Number(nextUValues[i]) || 0.0;
      }
      for (i = 0; i < layout.vCount; i += 1) {
        vValues[i] = Number(nextVValues[i]) || 0.0;
      }
      heights.fill(0.0);
    }

    function validateCounts() {
      if ((uCountView[0] | 0) !== layout.uCount || (vCountView[0] | 0) !== layout.vCount) {
        fail("surface-heightfield ledger count header does not match requested dimensions");
      }
    }

    function toPlainState() {
      validateCounts();
      return {
        uCount: layout.uCount,
        vCount: layout.vCount,
        frameIndex: frameIndex[0] | 0,
        boundaryCode: boundaryCode[0] | 0,
        phase: Number(phase[0]) || 0.0,
        uValues: Array.from(uValues),
        vValues: Array.from(vValues),
        heights: Array.from(heights)
      };
    }

    return {
      buffer: buffer,
      uCount: uCountView,
      vCount: vCountView,
      frameIndex: frameIndex,
      boundaryCode: boundaryCode,
      phase: phase,
      uValues: uValues,
      vValues: vValues,
      heights: heights,
      writeInitial: writeInitial,
      toPlainState: toPlainState,
      byteLength: layout.byteLength
    };
  }

  global.VfGeomLedgerLayout = {
    FACE_EDGE_VERTEX_STATE_FORMAT: FACE_EDGE_VERTEX_STATE_FORMAT,
    FACE_EDGE_VERTEX_STATE_BYTE_LENGTH: FACE_EDGE_VERTEX_STATE_BYTE_LENGTH,
    createFaceEdgeVertexStateBuffer: createFaceEdgeVertexStateBuffer,
    bindFaceEdgeVertexState: bindFaceEdgeVertexState,
    SURFACE_HEIGHTFIELD_STATE_FORMAT: SURFACE_HEIGHTFIELD_STATE_FORMAT,
    surfaceHeightfieldStateByteLength: function (uCount, vCount) {
      return surfaceHeightfieldOffsets(uCount, vCount).byteLength;
    },
    createSurfaceHeightfieldStateBuffer: createSurfaceHeightfieldStateBuffer,
    bindSurfaceHeightfieldState: bindSurfaceHeightfieldState,
  };
})(typeof window !== "undefined" ? window : globalThis);
