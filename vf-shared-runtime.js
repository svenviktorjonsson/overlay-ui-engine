(function(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(root || globalThis);
    return;
  }
  var api = factory(root || globalThis);
  root.VfSharedRuntime = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(global) {
  "use strict";

  var MAT4_F32 = 16;
  var GEOMETRY_F64 = 3;
  var DIRTY_NONE = -1;

  function makeIdentityMat4View(view, offset) {
    for (var i = 0; i < MAT4_F32; i += 1) {
      view[offset + i] = 0;
    }
    view[offset + 0] = 1;
    view[offset + 5] = 1;
    view[offset + 10] = 1;
    view[offset + 15] = 1;
  }

  function copyTypedRange(view, start, endInclusive, stride) {
    if (start < 0 || endInclusive < start) {
      return view.constructor.from([]);
    }
    var begin = start * stride;
    var end = (endInclusive + 1) * stride;
    return view.slice(begin, end);
  }

  function makeDirtyTracker() {
    return {
      version: 0,
      min: DIRTY_NONE,
      max: DIRTY_NONE
    };
  }

  function markDirty(tracker, index) {
    tracker.version += 1;
    if (tracker.min === DIRTY_NONE || index < tracker.min) {
      tracker.min = index;
    }
    if (tracker.max === DIRTY_NONE || index > tracker.max) {
      tracker.max = index;
    }
  }

  function clearDirty(tracker) {
    tracker.min = DIRTY_NONE;
    tracker.max = DIRTY_NONE;
  }

  function consumeDirty(tracker) {
    clearDirty(tracker);
    return {
      version: tracker.version,
      min: DIRTY_NONE,
      max: DIRTY_NONE
    };
  }

  function cloneDirty(tracker) {
    return {
      version: tracker.version,
      min: tracker.min,
      max: tracker.max
    };
  }

  function createTransformArena(capacity) {
    capacity = Math.max(0, capacity | 0);
    var buffer = new SharedArrayBuffer(Math.max(1, capacity * MAT4_F32) * Float32Array.BYTES_PER_ELEMENT);
    var mat4 = new Float32Array(buffer);
    var dirty = makeDirtyTracker();

    for (var slot = 0; slot < capacity; slot += 1) {
      makeIdentityMat4View(mat4, slot * MAT4_F32);
    }

    function setTranslate2D(slotIndex, x, y) {
      var slotOffset = (slotIndex | 0) * MAT4_F32;
      makeIdentityMat4View(mat4, slotOffset);
      mat4[slotOffset + 12] = Number(x) || 0;
      mat4[slotOffset + 13] = Number(y) || 0;
      markDirty(dirty, slotIndex | 0);
    }

    function setAnchoredTranslate2D(slotIndex, pointerX, pointerY, anchorX, anchorY) {
      setTranslate2D(slotIndex, (Number(pointerX) || 0) - (Number(anchorX) || 0), (Number(pointerY) || 0) - (Number(anchorY) || 0));
    }

    function rendererView() {
      return {
        capacity: capacity,
        buffer: buffer,
        copyDirtyMat4: function() {
          return {
            range: cloneDirty(dirty),
            data: copyTypedRange(mat4, dirty.min, dirty.max, MAT4_F32)
          };
        },
        consumeDirtyRange: function() {
          return consumeDirty(dirty);
        }
      };
    }

    return {
      buffer: buffer,
      mat4: mat4,
      capacity: function() { return capacity; },
      setTranslate2D: setTranslate2D,
      setAnchoredTranslate2D: setAnchoredTranslate2D,
      dirtyRange: function() { return cloneDirty(dirty); },
      copyDirtyMat4: function() {
        var range = cloneDirty(dirty);
        clearDirty(dirty);
        return {
          range: range,
          data: copyTypedRange(mat4, range.min, range.max, MAT4_F32)
        };
      },
      rendererView: rendererView
    };
  }

  function createGeometryArena(capacity) {
    capacity = Math.max(0, capacity | 0);
    var buffer = new SharedArrayBuffer(Math.max(1, capacity * GEOMETRY_F64) * Float64Array.BYTES_PER_ELEMENT);
    var xyz = new Float64Array(buffer);
    var dirty = makeDirtyTracker();

    function setVertex(index, x, y, z) {
      var i = (index | 0) * GEOMETRY_F64;
      xyz[i + 0] = Number(x) || 0;
      xyz[i + 1] = Number(y) || 0;
      xyz[i + 2] = Number(z) || 0;
      markDirty(dirty, index | 0);
    }

    function vertex(index) {
      var i = (index | 0) * GEOMETRY_F64;
      return [xyz[i + 0], xyz[i + 1], xyz[i + 2]];
    }

    function rendererView() {
      return {
        capacity: capacity,
        buffer: buffer,
        copyDirtyVertices: function() {
          return {
            range: cloneDirty(dirty),
            data: copyTypedRange(xyz, dirty.min, dirty.max, GEOMETRY_F64)
          };
        },
        consumeDirtyRange: function() {
          return consumeDirty(dirty);
        }
      };
    }

    return {
      buffer: buffer,
      xyz: xyz,
      capacity: function() { return capacity; },
      setVertex: setVertex,
      vertex: vertex,
      dirtyRange: function() { return cloneDirty(dirty); },
      copyDirtyVertices: function() {
        var range = cloneDirty(dirty);
        return {
          range: range,
          data: copyTypedRange(xyz, range.min, range.max, GEOMETRY_F64)
        };
      },
      consumeDirtyRange: function() {
        return consumeDirty(dirty);
      },
      rendererView: rendererView
    };
  }

  function normalizeHover(hover) {
    hover = hover || {};
    return {
      frame: hover.frame == null ? -1 : hover.frame | 0,
      object: hover.object == null ? -1 : hover.object | 0,
      face: hover.face == null ? -1 : hover.face | 0,
      edge: hover.edge == null ? -1 : hover.edge | 0,
      vertex: hover.vertex == null ? -1 : hover.vertex | 0
    };
  }

  function createEventArena(capacity) {
    capacity = Math.max(1, capacity | 0);
    var buffer = new SharedArrayBuffer(128 * capacity);
    var f64 = new Float64Array(buffer, 0, Math.floor(buffer.byteLength / Float64Array.BYTES_PER_ELEMENT));
    var i32 = new Int32Array(buffer, 64, Math.floor((buffer.byteLength - 64) / Int32Array.BYTES_PER_ELEMENT));
    var latest = {
      cursorPx: [0, 0],
      pointerAnchorPx: [0, 0],
      localCursor: [0, 0],
      localAnchor: [0, 0],
      pointerDown: false,
      buttons: 0,
      keyMask: 0,
      sequence: 0,
      timeMs: 0,
      hover: normalizeHover()
    };

    function writeInputSample(sample) {
      sample = sample || {};
      latest = {
        cursorPx: (sample.cursorPx || [0, 0]).slice(0, 2),
        pointerAnchorPx: (sample.pointerAnchorPx || [0, 0]).slice(0, 2),
        localCursor: (sample.localCursor || [0, 0]).slice(0, 2),
        localAnchor: (sample.localAnchor || [0, 0]).slice(0, 2),
        pointerDown: !!sample.pointerDown,
        buttons: sample.buttons == null ? 0 : sample.buttons | 0,
        keyMask: sample.keyMask == null ? 0 : sample.keyMask | 0,
        sequence: sample.sequence == null ? latest.sequence + 1 : sample.sequence | 0,
        timeMs: sample.timeMs == null ? 0 : Number(sample.timeMs) || 0,
        hover: normalizeHover(sample.hover)
      };

      f64[0] = latest.cursorPx[0];
      f64[1] = latest.cursorPx[1];
      f64[2] = latest.pointerAnchorPx[0];
      f64[3] = latest.pointerAnchorPx[1];
      f64[4] = latest.localCursor[0];
      f64[5] = latest.localCursor[1];
      f64[6] = latest.localAnchor[0];
      f64[7] = latest.localAnchor[1];
      f64[8] = latest.timeMs;

      i32[0] = latest.pointerDown ? 1 : 0;
      i32[1] = latest.buttons;
      i32[2] = latest.keyMask;
      i32[3] = latest.sequence;
      i32[4] = latest.hover.frame;
      i32[5] = latest.hover.object;
      i32[6] = latest.hover.face;
      i32[7] = latest.hover.edge;
      i32[8] = latest.hover.vertex;
    }

    function readerView() {
      return {
        buffer: buffer,
        f64: f64,
        i32: i32,
        latestSample: function() {
          return {
            cursorPx: latest.cursorPx.slice(),
            pointerAnchorPx: latest.pointerAnchorPx.slice(),
            localCursor: latest.localCursor.slice(),
            localAnchor: latest.localAnchor.slice(),
            pointerDown: latest.pointerDown,
            buttons: latest.buttons,
            keyMask: latest.keyMask,
            sequence: latest.sequence,
            timeMs: latest.timeMs,
            hover: {
              frame: latest.hover.frame,
              object: latest.hover.object,
              face: latest.hover.face,
              edge: latest.hover.edge,
              vertex: latest.hover.vertex
            }
          };
        }
      };
    }

    return {
      buffer: buffer,
      capacity: function() { return capacity; },
      writeInputSample: writeInputSample,
      readerView: readerView
    };
  }

  return {
    MAT4_F32: MAT4_F32,
    GEOMETRY_F64: GEOMETRY_F64,
    createTransformArena: createTransformArena,
    createGeometryArena: createGeometryArena,
    createEventArena: createEventArena
  };
});
