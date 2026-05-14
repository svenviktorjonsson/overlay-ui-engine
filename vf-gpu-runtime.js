(function (global) {
  "use strict";

  var MAT4_F32 = 16;
  var MAT4_BYTES = MAT4_F32 * Float32Array.BYTES_PER_ELEMENT;

  function assertAdapter(adapter) {
    if (!adapter || typeof adapter.writeBuffer !== "function") {
      throw new TypeError("GPU transform renderer expects an adapter with writeBuffer(offset, bytes)");
    }
  }

  function assertArena(arena) {
    if (!arena || typeof arena.copyDirtyMat4 !== "function") {
      throw new TypeError("GPU transform renderer expects a transform arena with copyDirtyMat4()");
    }
  }

  function cleanFlush(range) {
    return {
      version: range && typeof range.version === "number" ? range.version : 0,
      min: range && typeof range.min === "number" ? range.min : -1,
      max: range && typeof range.max === "number" ? range.max : -1,
      bytesWritten: 0
    };
  }

  function createTransformRenderer(options) {
    var opts = options || {};
    var arena = opts.arena || opts.transformArena;
    var adapter = opts.adapter;
    var byteOffset = Number(opts.byteOffset) || 0;

    assertArena(arena);
    assertAdapter(adapter);

    return {
      flushDirtyTransforms: function () {
        var copied = arena.copyDirtyMat4();
        var range = copied && copied.range;
        var data = copied && copied.data;
        if (!range || range.min < 0 || range.max < range.min || !data || data.length === 0) {
          return cleanFlush(range);
        }

        var offset = byteOffset + range.min * MAT4_BYTES;
        adapter.writeBuffer(offset, data);
        return {
          version: range.version,
          min: range.min,
          max: range.max,
          bytesWritten: data.byteLength
        };
      }
    };
  }

  function createWebGpuTransformAdapter(options) {
    var opts = options || {};
    var device = opts.device;
    var buffer = opts.buffer;
    if (!device || !device.queue || typeof device.queue.writeBuffer !== "function") {
      throw new TypeError("WebGPU transform adapter expects device.queue.writeBuffer");
    }
    if (!buffer) {
      throw new TypeError("WebGPU transform adapter expects a GPUBuffer");
    }
    return {
      writeBuffer: function (offset, bytes) {
        device.queue.writeBuffer(buffer, offset, bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }
    };
  }

  function createWebGlTransformAdapter(options) {
    var opts = options || {};
    var gl = opts.gl;
    var buffer = opts.buffer;
    var target = opts.target || (gl && gl.ARRAY_BUFFER);
    if (!gl || typeof gl.bindBuffer !== "function" || typeof gl.bufferSubData !== "function") {
      throw new TypeError("WebGL transform adapter expects bindBuffer and bufferSubData");
    }
    if (!buffer) {
      throw new TypeError("WebGL transform adapter expects a WebGLBuffer");
    }
    if (typeof target === "undefined") {
      throw new TypeError("WebGL transform adapter expects a buffer target");
    }
    return {
      writeBuffer: function (offset, bytes) {
        gl.bindBuffer(target, buffer);
        gl.bufferSubData(target, offset, bytes);
      }
    };
  }

  global.VfGpuRuntime = {
    MAT4_BYTES: MAT4_BYTES,
    createTransformRenderer: createTransformRenderer,
    createWebGpuTransformAdapter: createWebGpuTransformAdapter,
    createWebGlTransformAdapter: createWebGlTransformAdapter
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.VfGpuRuntime;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
