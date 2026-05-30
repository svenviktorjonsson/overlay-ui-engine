(function(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./vf-vkf-ui-kernel.js"));
    return;
  }
  root.VfVkfUiKernelAdapter = factory(root.VfVkfUiKernel);
})(typeof globalThis !== "undefined" ? globalThis : this, function(kernel) {
  "use strict";

  function createJsKernelAdapter(overrides) {
    overrides = overrides || {};
    return {
      rotateScaleTransform: overrides.rotateScaleTransform || kernel.rotateScaleTransform,
      scaleEdgeTransform: overrides.scaleEdgeTransform || kernel.scaleEdgeTransform,
      moveVertexToLocalCursor: overrides.moveVertexToLocalCursor || kernel.moveVertexToLocalCursor,
      translateEdgeVertices: overrides.translateEdgeVertices || kernel.translateEdgeVertices,
      pickVertexIndex: overrides.pickVertexIndex || kernel.pickVertexIndex,
      pickEdgeIndex: overrides.pickEdgeIndex || kernel.pickEdgeIndex,
      pickFaceIndex: overrides.pickFaceIndex || kernel.pickFaceIndex
    };
  }

  return {
    createJsKernelAdapter: createJsKernelAdapter
  };
});
