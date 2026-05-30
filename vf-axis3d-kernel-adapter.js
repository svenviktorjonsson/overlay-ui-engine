(function(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./vf-axis3d-kernel.js"));
    return;
  }
  root.VfAxis3DKernelAdapter = factory(root.VfAxis3DKernel);
})(typeof globalThis !== "undefined" ? globalThis : this, function(kernel) {
  "use strict";

  function createJsAxis3DKernelAdapter(overrides) {
    overrides = overrides || {};
    return {
      rotationCenter: overrides.rotationCenter || (kernel && kernel.rotationCenter),
      screenBasis: overrides.screenBasis || (kernel && kernel.screenBasis),
      applyWorldRotation: overrides.applyWorldRotation || (kernel && kernel.applyWorldRotation),
      cloneCamera: overrides.cloneCamera || (kernel && kernel.cloneCamera),
      alignAxisToViewSnap: overrides.alignAxisToViewSnap || (kernel && kernel.alignAxisToViewSnap),
      dragWorldDelta: overrides.dragWorldDelta || (kernel && kernel.dragWorldDelta),
      boxDragDataDelta: overrides.boxDragDataDelta || (kernel && kernel.boxDragDataDelta)
    };
  }

  return {
    createJsAxis3DKernelAdapter: createJsAxis3DKernelAdapter
  };
});
