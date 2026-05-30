(function(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./vf-axis3d-projection-kernel.js"));
    return;
  }
  root.VfAxis3DProjectionKernelAdapter = factory(root.VfAxis3DProjectionKernel);
})(typeof globalThis !== "undefined" ? globalThis : this, function(kernel) {
  "use strict";

  function createJsAxis3DProjectionKernelAdapter(deps, overrides) {
    overrides = overrides || {};
    var impl = kernel && typeof kernel.createProjectionKernel === "function"
      ? kernel.createProjectionKernel(deps || {})
      : {};
    return {
      projectedAxisInfos: overrides.projectedAxisInfos || impl.projectedAxisInfos,
      projectedAxisAngleDeg: overrides.projectedAxisAngleDeg || impl.projectedAxisAngleDeg,
      projectedAxisDiffDeg: overrides.projectedAxisDiffDeg || impl.projectedAxisDiffDeg,
      alignProjectedAxisToScreenSnap: overrides.alignProjectedAxisToScreenSnap || impl.alignProjectedAxisToScreenSnap,
      nearestAxisSnapAngleDeg: overrides.nearestAxisSnapAngleDeg || impl.nearestAxisSnapAngleDeg,
      normalizeUndirectedAngleDeg: overrides.normalizeUndirectedAngleDeg || impl.normalizeUndirectedAngleDeg
    };
  }

  return {
    createJsAxis3DProjectionKernelAdapter: createJsAxis3DProjectionKernelAdapter
  };
});
