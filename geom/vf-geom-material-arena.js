/**
 * vf-geom-material-arena.js — deep seam for scene-local material policy.
 *
 * Geometry producers can reference compact material ids instead of threading
 * per-part render policy inline. The arena resolves light model, alpha, depth,
 * and base color in one place, and can also stamp colors into packed buffers.
 */
(function (global) {
  "use strict";

  var RUNTIME_ASSET_VERSION = String(global.__vfRuntimeAssetVersion || "");
  if (global.VfGeomMaterialArena) {
    var existingVersion = String(global.VfGeomMaterialArena.__vfRuntimeAssetVersion || "");
    if (existingVersion !== RUNTIME_ASSET_VERSION) {
      throw new Error(
        "[vf-geom-material-arena] stale module already loaded: existing version " +
        existingVersion + " requested version " + RUNTIME_ASSET_VERSION
      );
    }
    return;
  }

  function fail(message) {
    throw new Error("[vf-geom-material-arena] " + String(message));
  }

  function toColorArray(source, fallback) {
    var input = source;
    if (!input) {
      input = fallback || [1, 1, 1, 1];
    }
    if (input instanceof Float32Array && input.length >= 4) {
      return new Float32Array([input[0], input[1], input[2], input[3]]);
    }
    if (!Array.isArray(input) || input.length < 4) {
      fail("material color must be a 4-element array");
    }
    return new Float32Array([
      Number(input[0]) || 0,
      Number(input[1]) || 0,
      Number(input[2]) || 0,
      Number(input[3]) || 0
    ]);
  }

  function normalizeMaterial(id, spec) {
    var source = spec || {};
    var baseColor = toColorArray(source.base_color || source.color, [1, 1, 1, 1]);
    var alpha = source.alpha != null ? Number(source.alpha) : baseColor[3];
    if (!(alpha >= 0)) { alpha = baseColor[3]; }
    return {
      id: String(id),
      base_color: baseColor,
      alpha: alpha,
      transparent: source.transparent === true || alpha < 0.999,
      depth_write: source.depth_write === true,
      light_model: source.light_model == null ? null : String(source.light_model)
    };
  }

  function clonePart(part) {
    var out = {};
    for (var key in part) {
      if (Object.prototype.hasOwnProperty.call(part, key)) {
        out[key] = part[key];
      }
    }
    return out;
  }

  function createArena(spec) {
    var source = spec || {};
    var normalized = Object.create(null);
    var keys = Object.keys(source);
    for (var i = 0; i < keys.length; i += 1) {
      var id = keys[i];
      normalized[id] = normalizeMaterial(id, source[id]);
    }

    function requireMaterial(materialId) {
      var id = String(materialId || "");
      var material = normalized[id];
      if (!material) {
        fail("unknown material id " + JSON.stringify(id));
      }
      return material;
    }

    function resolvePart(part) {
      if (!part || typeof part !== "object") {
        return part;
      }
      var materialId = part.material_id;
      if (materialId == null || materialId === "") {
        return part;
      }
      var material = requireMaterial(materialId);
      var resolved = clonePart(part);
      resolved.alpha = material.alpha;
      resolved.transparent = material.transparent;
      resolved.depth_write = material.depth_write;
      if (material.light_model != null) {
        resolved.light_model = material.light_model;
      } else if (resolved.light_model == null) {
        delete resolved.light_model;
      }
      if (resolved.color == null) {
        resolved.color = Array.prototype.slice.call(material.base_color);
      }
      return resolved;
    }

    function resolveScene(scene) {
      if (!scene || !Array.isArray(scene.parts)) {
        return scene;
      }
      var resolvedParts = new Array(scene.parts.length);
      var changed = false;
      for (var i = 0; i < scene.parts.length; i += 1) {
        var current = scene.parts[i];
        var resolved = resolvePart(current);
        resolvedParts[i] = resolved;
        changed = changed || resolved !== current;
      }
      if (!changed) {
        return scene;
      }
      var nextScene = clonePart(scene);
      nextScene.parts = resolvedParts;
      return nextScene;
    }

    function colorArray(materialId) {
      return requireMaterial(materialId).base_color;
    }

    function stampPackedColors(target, stride, colorOffset, materialId) {
      var color = colorArray(materialId);
      for (var offset = colorOffset; offset < target.length; offset += stride) {
        target[offset] = color[0];
        target[offset + 1] = color[1];
        target[offset + 2] = color[2];
        target[offset + 3] = color[3];
      }
    }

    return {
      get: requireMaterial,
      colorArray: colorArray,
      resolvePart: resolvePart,
      resolveScene: resolveScene,
      stampPackedColors: stampPackedColors
    };
  }

  function resolveScene(scene) {
    if (!scene || !scene.materials) {
      return scene;
    }
    var arena = scene.materials && typeof scene.materials.resolveScene === "function"
      ? scene.materials
      : createArena(scene.materials);
    return arena.resolveScene(scene);
  }

  global.VfGeomMaterialArena = {
    __vfRuntimeAssetVersion: RUNTIME_ASSET_VERSION,
    createArena: createArena,
    resolveScene: resolveScene
  };
})(typeof window !== "undefined" ? window : this);
