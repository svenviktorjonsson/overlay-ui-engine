(function(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(root || globalThis, require("./vf-shared-runtime.js"));
    return;
  }
  var api = factory(root || globalThis, root.VfSharedRuntime);
  root.VfGpuRuntime = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(global, shared) {
  "use strict";

  function createTransformRenderer(options) {
    options = options || {};
    var arena = options.arena;
    var adapter = options.adapter;
    var byteOffset = Number(options.byteOffset) || 0;
    var view = arena.rendererView();

    return {
      flushDirtyTransforms: function() {
        var snapshot = view.copyDirtyMat4();
        if (snapshot.range.min < 0 || snapshot.range.max < snapshot.range.min) {
          return {
            version: snapshot.range.version,
            min: snapshot.range.min,
            max: snapshot.range.max,
            bytesWritten: 0
          };
        }
        var bytes = snapshot.data;
        var offset = byteOffset + snapshot.range.min * shared.MAT4_F32 * Float32Array.BYTES_PER_ELEMENT;
        adapter.writeBuffer(offset, bytes);
        view.consumeDirtyRange();
        return {
          version: snapshot.range.version,
          min: snapshot.range.min,
          max: snapshot.range.max,
          bytesWritten: bytes.byteLength
        };
      }
    };
  }

  function createWebGpuTransformAdapter(options) {
    options = options || {};
    var device = options.device;
    var buffer = options.buffer;
    return {
      writeBuffer: function(offset, floatView) {
        device.queue.writeBuffer(
          buffer,
          offset,
          floatView.buffer,
          floatView.byteOffset,
          floatView.byteLength
        );
      }
    };
  }

  function createWebGlTransformAdapter(options) {
    options = options || {};
    var gl = options.gl;
    var buffer = options.buffer;
    return {
      writeBuffer: function(offset, floatView) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, offset, floatView);
      }
    };
  }

  return {
    createTransformRenderer: createTransformRenderer,
    createWebGpuTransformAdapter: createWebGpuTransformAdapter,
    createWebGlTransformAdapter: createWebGlTransformAdapter
  };
});
