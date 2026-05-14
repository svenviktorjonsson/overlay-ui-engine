(function (global) {
  "use strict";

  var HEADER_I32 = 16;
  var MAT4_F32 = 16;
  var GEOMETRY_F64 = 3;
  var HEADER_BYTES = HEADER_I32 * Int32Array.BYTES_PER_ELEMENT;
  var EVENT_HEADER_I32 = 8;
  var EVENT_F64 = 9;
  var EVENT_I32 = 9;

  var H_CAPACITY = 0;
  var H_DIRTY_VERSION = 1;
  var H_DIRTY_MIN = 2;
  var H_DIRTY_MAX = 3;

  var EH_CAPACITY = 0;
  var EH_WRITE_INDEX = 1;
  var EH_COUNT = 2;
  var EH_LATEST_SLOT = 3;

  var EF_CURSOR_X = 0;
  var EF_CURSOR_Y = 1;
  var EF_TIME_MS = 2;
  var EF_POINTER_ANCHOR_X = 3;
  var EF_POINTER_ANCHOR_Y = 4;
  var EF_LOCAL_CURSOR_X = 5;
  var EF_LOCAL_CURSOR_Y = 6;
  var EF_LOCAL_ANCHOR_X = 7;
  var EF_LOCAL_ANCHOR_Y = 8;

  var EI_SEQUENCE = 0;
  var EI_POINTER_DOWN = 1;
  var EI_BUTTONS = 2;
  var EI_KEY_MASK = 3;
  var EI_HOVER_FRAME = 4;
  var EI_HOVER_OBJECT = 5;
  var EI_HOVER_FACE = 6;
  var EI_HOVER_EDGE = 7;
  var EI_HOVER_VERTEX = 8;

  function requireSharedArrayBuffer() {
    if (typeof SharedArrayBuffer === "undefined") {
      throw new Error("SharedArrayBuffer is required for the VKF shared UI runtime");
    }
  }

  function identityMat4(out, offset) {
    for (var i = 0; i < MAT4_F32; i++) {
      out[offset + i] = 0;
    }
    out[offset + 0] = 1;
    out[offset + 5] = 1;
    out[offset + 10] = 1;
    out[offset + 15] = 1;
  }

  function markDirty(header, slot) {
    var min = Atomics.load(header, H_DIRTY_MIN);
    var max = Atomics.load(header, H_DIRTY_MAX);
    if (min < 0 || slot < min) {
      Atomics.store(header, H_DIRTY_MIN, slot);
    }
    if (max < 0 || slot > max) {
      Atomics.store(header, H_DIRTY_MAX, slot);
    }
    Atomics.add(header, H_DIRTY_VERSION, 1);
  }

  function assertSlot(arena, slot) {
    var cap = arena.capacity();
    if (slot < 0 || slot >= cap) {
      throw new RangeError("transform slot out of range: " + slot);
    }
  }

  function createTransformArena(capacity) {
    requireSharedArrayBuffer();
    var cap = Math.max(1, capacity | 0);
    var bytes = HEADER_BYTES + cap * MAT4_F32 * Float32Array.BYTES_PER_ELEMENT;
    var buffer = new SharedArrayBuffer(bytes);
    var header = new Int32Array(buffer, 0, HEADER_I32);
    var mat4 = new Float32Array(buffer, HEADER_BYTES, cap * MAT4_F32);
    Atomics.store(header, H_CAPACITY, cap);
    Atomics.store(header, H_DIRTY_VERSION, 0);
    Atomics.store(header, H_DIRTY_MIN, -1);
    Atomics.store(header, H_DIRTY_MAX, -1);
    for (var slot = 0; slot < cap; slot++) {
      identityMat4(mat4, slot * MAT4_F32);
    }
    return new TransformArena(buffer, header, mat4);
  }

  function createGeometryArena(capacity) {
    requireSharedArrayBuffer();
    var cap = Math.max(1, capacity | 0);
    var bytes = HEADER_BYTES + cap * GEOMETRY_F64 * Float64Array.BYTES_PER_ELEMENT;
    var buffer = new SharedArrayBuffer(bytes);
    var header = new Int32Array(buffer, 0, HEADER_I32);
    var vertices = new Float64Array(buffer, HEADER_BYTES, cap * GEOMETRY_F64);
    Atomics.store(header, H_CAPACITY, cap);
    Atomics.store(header, H_DIRTY_VERSION, 0);
    Atomics.store(header, H_DIRTY_MIN, -1);
    Atomics.store(header, H_DIRTY_MAX, -1);
    return new GeometryArena(buffer, header, vertices);
  }

  function createEventArena(capacity) {
    requireSharedArrayBuffer();
    var cap = Math.max(1, capacity | 0);
    var headerBytes = EVENT_HEADER_I32 * Int32Array.BYTES_PER_ELEMENT;
    var f64Bytes = cap * EVENT_F64 * Float64Array.BYTES_PER_ELEMENT;
    var i32Bytes = cap * EVENT_I32 * Int32Array.BYTES_PER_ELEMENT;
    var buffer = new SharedArrayBuffer(headerBytes + f64Bytes + i32Bytes);
    var header = new Int32Array(buffer, 0, EVENT_HEADER_I32);
    var f64 = new Float64Array(buffer, headerBytes, cap * EVENT_F64);
    var i32 = new Int32Array(buffer, headerBytes + f64Bytes, cap * EVENT_I32);
    Atomics.store(header, EH_CAPACITY, cap);
    Atomics.store(header, EH_WRITE_INDEX, 0);
    Atomics.store(header, EH_COUNT, 0);
    Atomics.store(header, EH_LATEST_SLOT, -1);
    for (var slot = 0; slot < cap; slot++) {
      writeHover(i32, slot, null);
    }
    return new EventArena(buffer, header, f64, i32);
  }

  function TransformArena(buffer, header, mat4) {
    this.buffer = buffer;
    this.header = header;
    this.mat4 = mat4;
  }

  function GeometryArena(buffer, header, vertices) {
    this.buffer = buffer;
    this.header = header;
    this.vertices = vertices;
  }

  function EventArena(buffer, header, f64, i32) {
    this.buffer = buffer;
    this.header = header;
    this.f64 = f64;
    this.i32 = i32;
  }

  function eventF64Offset(slot) {
    return slot * EVENT_F64;
  }

  function eventI32Offset(slot) {
    return slot * EVENT_I32;
  }

  function intOrDefault(value, fallback) {
    var number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return number | 0;
  }

  function writeHover(i32, slot, hover) {
    var offset = eventI32Offset(slot);
    hover = hover || {};
    i32[offset + EI_HOVER_FRAME] = intOrDefault(hover.frame, -1);
    i32[offset + EI_HOVER_OBJECT] = intOrDefault(hover.object, -1);
    i32[offset + EI_HOVER_FACE] = intOrDefault(hover.face, -1);
    i32[offset + EI_HOVER_EDGE] = intOrDefault(hover.edge, -1);
    i32[offset + EI_HOVER_VERTEX] = intOrDefault(hover.vertex, -1);
  }

  function readEventSample(arena, slot) {
    var f64Offset = eventF64Offset(slot);
    var i32Offset = eventI32Offset(slot);
    return {
      cursorPx: [
        arena.f64[f64Offset + EF_CURSOR_X],
        arena.f64[f64Offset + EF_CURSOR_Y]
      ],
      pointerAnchorPx: [
        arena.f64[f64Offset + EF_POINTER_ANCHOR_X],
        arena.f64[f64Offset + EF_POINTER_ANCHOR_Y]
      ],
      localCursor: [
        arena.f64[f64Offset + EF_LOCAL_CURSOR_X],
        arena.f64[f64Offset + EF_LOCAL_CURSOR_Y]
      ],
      localAnchor: [
        arena.f64[f64Offset + EF_LOCAL_ANCHOR_X],
        arena.f64[f64Offset + EF_LOCAL_ANCHOR_Y]
      ],
      pointerDown: arena.i32[i32Offset + EI_POINTER_DOWN] !== 0,
      buttons: arena.i32[i32Offset + EI_BUTTONS],
      keyMask: arena.i32[i32Offset + EI_KEY_MASK],
      sequence: arena.i32[i32Offset + EI_SEQUENCE],
      timeMs: arena.f64[f64Offset + EF_TIME_MS],
      hover: {
        frame: arena.i32[i32Offset + EI_HOVER_FRAME],
        object: arena.i32[i32Offset + EI_HOVER_OBJECT],
        face: arena.i32[i32Offset + EI_HOVER_FACE],
        edge: arena.i32[i32Offset + EI_HOVER_EDGE],
        vertex: arena.i32[i32Offset + EI_HOVER_VERTEX]
      }
    };
  }

  TransformArena.prototype.capacity = function () {
    return Atomics.load(this.header, H_CAPACITY);
  };

  TransformArena.prototype.setMat4 = function (slot, values) {
    assertSlot(this, slot);
    if (!values || values.length < MAT4_F32) {
      throw new TypeError("setMat4 expects 16 numeric values");
    }
    var offset = slot * MAT4_F32;
    for (var i = 0; i < MAT4_F32; i++) {
      this.mat4[offset + i] = Number(values[i]) || 0;
    }
    markDirty(this.header, slot);
  };

  TransformArena.prototype.setTranslate2D = function (slot, x, y) {
    assertSlot(this, slot);
    var offset = slot * MAT4_F32;
    identityMat4(this.mat4, offset);
    this.mat4[offset + 12] = Number(x) || 0;
    this.mat4[offset + 13] = Number(y) || 0;
    markDirty(this.header, slot);
  };

  TransformArena.prototype.setAnchoredTranslate2D = function (slot, cursorX, cursorY, anchorX, anchorY) {
    this.setTranslate2D(
      slot,
      (Number(cursorX) || 0) - (Number(anchorX) || 0),
      (Number(cursorY) || 0) - (Number(anchorY) || 0)
    );
  };

  TransformArena.prototype.dirtyRange = function () {
    return {
      version: Atomics.load(this.header, H_DIRTY_VERSION),
      min: Atomics.load(this.header, H_DIRTY_MIN),
      max: Atomics.load(this.header, H_DIRTY_MAX)
    };
  };

  TransformArena.prototype.consumeDirtyRange = function () {
    var range = this.dirtyRange();
    Atomics.store(this.header, H_DIRTY_MIN, -1);
    Atomics.store(this.header, H_DIRTY_MAX, -1);
    return range;
  };

  TransformArena.prototype.copyDirtyMat4 = function () {
    var range = this.consumeDirtyRange();
    if (range.min < 0 || range.max < range.min) {
      return { range: range, data: new Float32Array(0) };
    }
    var start = range.min * MAT4_F32;
    var end = (range.max + 1) * MAT4_F32;
    return {
      range: range,
      data: this.mat4.slice(start, end)
    };
  };

  TransformArena.prototype.rendererView = function () {
    var arena = this;
    return {
      buffer: arena.buffer,
      mat4: arena.mat4,
      capacity: arena.capacity(),
      dirtyRange: function () {
        return arena.dirtyRange();
      },
      consumeDirtyRange: function () {
        return arena.consumeDirtyRange();
      },
      copyDirtyMat4: function () {
        return arena.copyDirtyMat4();
      }
    };
  };

  GeometryArena.prototype.capacity = function () {
    return Atomics.load(this.header, H_CAPACITY);
  };

  GeometryArena.prototype.setVertex = function (index, x, y, z) {
    var cap = this.capacity();
    if (index < 0 || index >= cap) {
      throw new RangeError("geometry vertex out of range: " + index);
    }
    var offset = index * GEOMETRY_F64;
    this.vertices[offset + 0] = Number(x) || 0;
    this.vertices[offset + 1] = Number(y) || 0;
    this.vertices[offset + 2] = Number(z) || 0;
    markDirty(this.header, index);
  };

  GeometryArena.prototype.vertex = function (index) {
    var cap = this.capacity();
    if (index < 0 || index >= cap) {
      throw new RangeError("geometry vertex out of range: " + index);
    }
    var offset = index * GEOMETRY_F64;
    return [
      this.vertices[offset + 0],
      this.vertices[offset + 1],
      this.vertices[offset + 2]
    ];
  };

  GeometryArena.prototype.dirtyRange = function () {
    return {
      version: Atomics.load(this.header, H_DIRTY_VERSION),
      min: Atomics.load(this.header, H_DIRTY_MIN),
      max: Atomics.load(this.header, H_DIRTY_MAX)
    };
  };

  GeometryArena.prototype.consumeDirtyRange = function () {
    var range = this.dirtyRange();
    Atomics.store(this.header, H_DIRTY_MIN, -1);
    Atomics.store(this.header, H_DIRTY_MAX, -1);
    return range;
  };

  GeometryArena.prototype.copyDirtyVertices = function () {
    var range = this.consumeDirtyRange();
    if (range.min < 0 || range.max < range.min) {
      return { range: range, data: new Float64Array(0) };
    }
    var start = range.min * GEOMETRY_F64;
    var end = (range.max + 1) * GEOMETRY_F64;
    return {
      range: range,
      data: this.vertices.slice(start, end)
    };
  };

  GeometryArena.prototype.rendererView = function () {
    var arena = this;
    return {
      buffer: arena.buffer,
      vertices: arena.vertices,
      capacity: arena.capacity(),
      dirtyRange: function () {
        return arena.dirtyRange();
      },
      consumeDirtyRange: function () {
        return arena.consumeDirtyRange();
      },
      copyDirtyVertices: function () {
        return arena.copyDirtyVertices();
      }
    };
  };

  EventArena.prototype.capacity = function () {
    return Atomics.load(this.header, EH_CAPACITY);
  };

  EventArena.prototype.writeInputSample = function (sample) {
    sample = sample || {};
    var cap = this.capacity();
    var writeIndex = Atomics.load(this.header, EH_WRITE_INDEX);
    var slot = writeIndex % cap;
    var cursorPx = sample.cursorPx || [0, 0];
    var pointerAnchorPx = sample.pointerAnchorPx || cursorPx;
    var localCursor = sample.localCursor || cursorPx;
    var localAnchor = sample.localAnchor || pointerAnchorPx;
    var f64Offset = eventF64Offset(slot);
    var i32Offset = eventI32Offset(slot);

    this.f64[f64Offset + EF_CURSOR_X] = Number(cursorPx[0]) || 0;
    this.f64[f64Offset + EF_CURSOR_Y] = Number(cursorPx[1]) || 0;
    this.f64[f64Offset + EF_TIME_MS] = Number(sample.timeMs) || 0;
    this.f64[f64Offset + EF_POINTER_ANCHOR_X] = Number(pointerAnchorPx[0]) || 0;
    this.f64[f64Offset + EF_POINTER_ANCHOR_Y] = Number(pointerAnchorPx[1]) || 0;
    this.f64[f64Offset + EF_LOCAL_CURSOR_X] = Number(localCursor[0]) || 0;
    this.f64[f64Offset + EF_LOCAL_CURSOR_Y] = Number(localCursor[1]) || 0;
    this.f64[f64Offset + EF_LOCAL_ANCHOR_X] = Number(localAnchor[0]) || 0;
    this.f64[f64Offset + EF_LOCAL_ANCHOR_Y] = Number(localAnchor[1]) || 0;
    this.i32[i32Offset + EI_SEQUENCE] = intOrDefault(sample.sequence, 0);
    this.i32[i32Offset + EI_POINTER_DOWN] = sample.pointerDown ? 1 : 0;
    this.i32[i32Offset + EI_BUTTONS] = intOrDefault(sample.buttons, 0);
    this.i32[i32Offset + EI_KEY_MASK] = intOrDefault(sample.keyMask, 0);
    writeHover(this.i32, slot, sample.hover);

    Atomics.store(this.header, EH_LATEST_SLOT, slot);
    Atomics.store(this.header, EH_WRITE_INDEX, writeIndex + 1);
    Atomics.store(this.header, EH_COUNT, Math.min(cap, writeIndex + 1));
  };

  EventArena.prototype.latestSample = function () {
    var slot = Atomics.load(this.header, EH_LATEST_SLOT);
    if (slot < 0) {
      return null;
    }
    return readEventSample(this, slot);
  };

  EventArena.prototype.readerView = function () {
    var arena = this;
    return {
      buffer: arena.buffer,
      f64: arena.f64,
      i32: arena.i32,
      capacity: arena.capacity(),
      latestSample: function () {
        return arena.latestSample();
      }
    };
  };

  global.VfSharedRuntime = {
    HEADER_I32: HEADER_I32,
    MAT4_F32: MAT4_F32,
    GEOMETRY_F64: GEOMETRY_F64,
    EVENT_F64: EVENT_F64,
    EVENT_I32: EVENT_I32,
    createTransformArena: createTransformArena,
    createGeometryArena: createGeometryArena,
    createEventArena: createEventArena
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.VfSharedRuntime;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
