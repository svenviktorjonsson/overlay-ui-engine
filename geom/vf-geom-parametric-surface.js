/**
 * vf-geom-parametric-surface.js — deep seam for sampled grid surface geometry.
 *
 * Owns topology packing, overlay instance layout, and dynamic z/normal updates
 * for sampled parametric surfaces. Scene modules provide sampled axis values,
 * heights, and material ids.
 */
(function (global) {
  "use strict";

  var RUNTIME_ASSET_VERSION = String(global.__vfRuntimeAssetVersion || "");
  if (global.VfGeomParametricSurface) {
    var existingVersion = String(global.VfGeomParametricSurface.__vfRuntimeAssetVersion || "");
    if (existingVersion !== RUNTIME_ASSET_VERSION) {
      throw new Error(
        "[vf-geom-parametric-surface] stale module already loaded: existing version " +
        existingVersion + " requested version " + RUNTIME_ASSET_VERSION
      );
    }
    return;
  }

  function fail(message) {
    throw new Error("[vf-geom-parametric-surface] " + String(message));
  }

  function buildSurfaceSubdivLayout(subdiv) {
    var subcellCount = subdiv * subdiv;
    var layout = new Float32Array(subcellCount * 6);
    var offset = 0;
    for (var sv = 0; sv < subdiv; sv += 1) {
      var t0 = sv / subdiv;
      var t1 = (sv + 1) / subdiv;
      var tm = (t0 + t1) * 0.5;
      for (var su = 0; su < subdiv; su += 1) {
        var s0 = su / subdiv;
        var s1 = (su + 1) / subdiv;
        var sm = (s0 + s1) * 0.5;
        layout[offset] = s0; offset += 1;
        layout[offset] = s1; offset += 1;
        layout[offset] = sm; offset += 1;
        layout[offset] = t0; offset += 1;
        layout[offset] = t1; offset += 1;
        layout[offset] = tm; offset += 1;
      }
    }
    return layout;
  }

  function writeStaticVertexRaw(target, offset, px, py) {
    target[offset] = px;
    target[offset + 1] = py;
  }

  function writeDynamicVertexState(target, offset, pz, nx, ny, nz) {
    target[offset + 2] = pz;
    target[offset + 3] = nx;
    target[offset + 4] = ny;
    target[offset + 5] = nz;
  }

  function makeSphereTemplate(latSeg, lonSeg) {
    var vertexCount = (latSeg + 1) * (lonSeg + 1);
    var vertices = new Float32Array(vertexCount * 10);
    var offset = 0;
    for (var j = 0; j <= latSeg; j += 1) {
      var v = j / latSeg;
      var phi = v * Math.PI;
      var sp = Math.sin(phi);
      var cp = Math.cos(phi);
      for (var i = 0; i <= lonSeg; i += 1) {
        var u = i / lonSeg;
        var th = u * Math.PI * 2;
        var nx = sp * Math.cos(th);
        var ny = cp;
        var nz = sp * Math.sin(th);
        vertices[offset] = nx;
        vertices[offset + 1] = ny;
        vertices[offset + 2] = nz;
        vertices[offset + 3] = nx;
        vertices[offset + 4] = ny;
        vertices[offset + 5] = nz;
        offset += 10;
      }
    }
    var row = lonSeg + 1;
    var indices = new Uint32Array(latSeg * lonSeg * 6);
    var indexOffset = 0;
    for (var y = 0; y < latSeg; y += 1) {
      for (var x = 0; x < lonSeg; x += 1) {
        var a = (y * row) + x;
        var b = a + 1;
        var c = a + row;
        var d = c + 1;
        indices[indexOffset] = a; indexOffset += 1;
        indices[indexOffset] = c; indexOffset += 1;
        indices[indexOffset] = b; indexOffset += 1;
        indices[indexOffset] = b; indexOffset += 1;
        indices[indexOffset] = c; indexOffset += 1;
        indices[indexOffset] = d; indexOffset += 1;
      }
    }
    return { vertices: vertices, indices: indices };
  }

  function makeCylinderTemplate(seg) {
    var ringCount = seg + 1;
    var vertexCount = ringCount * 2;
    var vertices = new Float32Array(vertexCount * 10);
    var offset = 0;
    for (var i = 0; i <= seg; i += 1) {
      var th = (i / seg) * Math.PI * 2;
      var ct = Math.cos(th);
      var st = Math.sin(th);
      vertices[offset] = ct;
      vertices[offset + 1] = st;
      vertices[offset + 2] = 0.0;
      vertices[offset + 3] = ct;
      vertices[offset + 4] = st;
      vertices[offset + 5] = 0.0;
      offset += 10;
      vertices[offset] = ct;
      vertices[offset + 1] = st;
      vertices[offset + 2] = 1.0;
      vertices[offset + 3] = ct;
      vertices[offset + 4] = st;
      vertices[offset + 5] = 0.0;
      offset += 10;
    }
    var indices = new Uint32Array(seg * 6);
    var indexOffset = 0;
    for (var s = 0; s < seg; s += 1) {
      var p0 = s * 2;
      var p1 = p0 + 1;
      var p2 = p0 + 2;
      var p3 = p0 + 3;
      indices[indexOffset] = p0; indexOffset += 1;
      indices[indexOffset] = p1; indexOffset += 1;
      indices[indexOffset] = p2; indexOffset += 1;
      indices[indexOffset] = p2; indexOffset += 1;
      indices[indexOffset] = p1; indexOffset += 1;
      indices[indexOffset] = p3; indexOffset += 1;
    }
    return { vertices: vertices, indices: indices };
  }

  function createGridSurfaceArena(options) {
    options = options || {};
    var uValues = options.uValues;
    var vValues = options.vValues;
    var materials = options.materials;
    if (!(uValues instanceof Float32Array) || !(vValues instanceof Float32Array)) {
      fail("createGridSurfaceArena requires Float32Array uValues and vValues");
    }
    if (uValues.length < 2 || vValues.length < 2) {
      fail("createGridSurfaceArena requires at least a 2x2 sampled grid");
    }
    if (!materials || typeof materials.colorArray !== "function") {
      fail("createGridSurfaceArena requires a material arena");
    }

    var uCount = uValues.length;
    var vCount = vValues.length;
    var faceSubdiv = Math.max(1, Number(options.faceSubdivisions || 1) | 0);
    var showEdges = options.showEdges !== false;
    var showVertices = options.showVertices === true;
    var edgeWidth = Number(options.edgeWidth || 1.0);
    var vertexSize = Number(options.vertexSize || 0.12);
    var faceMaterialId = String(options.faceMaterialId || "surface");
    var edgeMaterialId = String(options.edgeMaterialId || "edge");
    var vertexMaterialId = String(options.vertexMaterialId || "vertex");
    var surfaceLayout = buildSurfaceSubdivLayout(faceSubdiv);

    var surfaceMesh = makeTriangleMesh();
    var edgeMesh = showEdges ? makeEdgeMesh() : null;
    var vertexMesh = showVertices ? makeVertexMesh() : null;

    function makeTriangleMesh() {
      var cellCount = (uCount - 1) * (vCount - 1);
      var quadCount = cellCount * faceSubdiv * faceSubdiv;
      var vertexCount = quadCount * 6;
      var vertices = new Float32Array(vertexCount * 10);
      var indices = new Uint32Array(vertexCount);
      for (var vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
        indices[vertexIndex] = vertexIndex;
      }
      seedSurfaceVertexLayout(vertices);
      materials.stampPackedColors(vertices, 10, 6, faceMaterialId);
      return {
        type: "field_mesh",
        id: "surface",
        material_id: faceMaterialId,
        topology: "triangle-list",
        transparent: false,
        depth_write: true,
        pickable: false,
        static_indices: true,
        vertices: vertices,
        indices: indices
      };
    }

    function seedSurfaceVertexLayout(vertices) {
      var offset = 0;
      for (var vIndex = 0; vIndex < vCount - 1; vIndex += 1) {
        var ay = vValues[vIndex];
        var cy = vValues[vIndex + 1];
        for (var uIndex = 0; uIndex < uCount - 1; uIndex += 1) {
          var ax = uValues[uIndex];
          var bx = uValues[uIndex + 1];
          var abx = bx - ax;
          var acy = cy - ay;
          for (var layoutOffset = 0; layoutOffset < surfaceLayout.length; layoutOffset += 6) {
            var s0 = surfaceLayout[layoutOffset];
            var s1 = surfaceLayout[layoutOffset + 1];
            var t0 = surfaceLayout[layoutOffset + 3];
            var t1 = surfaceLayout[layoutOffset + 4];
            writeStaticVertexRaw(vertices, offset, ax + (abx * s0), ay + (acy * t0)); offset += 10;
            writeStaticVertexRaw(vertices, offset, ax + (abx * s1), ay + (acy * t0)); offset += 10;
            writeStaticVertexRaw(vertices, offset, ax + (abx * s0), ay + (acy * t1)); offset += 10;
            writeStaticVertexRaw(vertices, offset, ax + (abx * s1), ay + (acy * t0)); offset += 10;
            writeStaticVertexRaw(vertices, offset, ax + (abx * s1), ay + (acy * t1)); offset += 10;
            writeStaticVertexRaw(vertices, offset, ax + (abx * s0), ay + (acy * t1)); offset += 10;
          }
        }
      }
    }

    function makeEdgeMesh() {
      var segmentCount = ((uCount - 1) * vCount) + ((vCount - 1) * uCount);
      var template = makeCylinderTemplate(20);
      var instances = new Float32Array(segmentCount * 12);
      seedEdgeInstanceLayout(instances);
      return {
        id: "grid",
        material_id: edgeMaterialId,
        topology: "triangle-list",
        instance_kind: "cylinder-list",
        instance_count: segmentCount,
        transparent: false,
        depth_write: true,
        pickable: false,
        vertices: template.vertices,
        indices: template.indices,
        instances: instances
      };
    }

    function seedEdgeInstanceLayout(instances) {
      var color = materials.colorArray(edgeMaterialId);
      var offset = 0;
      for (var row = 0; row < vCount; row += 1) {
        var v = vValues[row];
        for (var col = 0; col < uCount - 1; col += 1) {
          instances[offset] = uValues[col]; offset += 1;
          instances[offset] = v; offset += 1;
          offset += 1;
          instances[offset] = edgeWidth; offset += 1;
          instances[offset] = uValues[col + 1]; offset += 1;
          instances[offset] = v; offset += 1;
          offset += 1;
          instances[offset] = 0.0; offset += 1;
          instances[offset] = color[0]; offset += 1;
          instances[offset] = color[1]; offset += 1;
          instances[offset] = color[2]; offset += 1;
          instances[offset] = color[3]; offset += 1;
        }
      }
      for (var col2 = 0; col2 < uCount; col2 += 1) {
        var u = uValues[col2];
        for (var row2 = 0; row2 < vCount - 1; row2 += 1) {
          instances[offset] = u; offset += 1;
          instances[offset] = vValues[row2]; offset += 1;
          offset += 1;
          instances[offset] = edgeWidth; offset += 1;
          instances[offset] = u; offset += 1;
          instances[offset] = vValues[row2 + 1]; offset += 1;
          offset += 1;
          instances[offset] = 0.0; offset += 1;
          instances[offset] = color[0]; offset += 1;
          instances[offset] = color[1]; offset += 1;
          instances[offset] = color[2]; offset += 1;
          instances[offset] = color[3]; offset += 1;
        }
      }
    }

    function makeVertexMesh() {
      var vertexCount = uCount * vCount;
      var template = makeSphereTemplate(12, 18);
      var instances = new Float32Array(vertexCount * 8);
      seedVertexInstanceLayout(instances);
      return {
        id: "vertices",
        material_id: vertexMaterialId,
        topology: "triangle-list",
        instance_kind: "sphere-list",
        instance_count: vertexCount,
        transparent: false,
        depth_write: true,
        pickable: false,
        vertices: template.vertices,
        indices: template.indices,
        instances: instances
      };
    }

    function seedVertexInstanceLayout(instances) {
      var color = materials.colorArray(vertexMaterialId);
      var offset = 0;
      for (var vIndex = 0; vIndex < vCount; vIndex += 1) {
        var v = vValues[vIndex];
        for (var uIndex = 0; uIndex < uCount; uIndex += 1) {
          instances[offset] = uValues[uIndex]; offset += 1;
          instances[offset] = v; offset += 1;
          offset += 1;
          instances[offset] = vertexSize; offset += 1;
          instances[offset] = color[0]; offset += 1;
          instances[offset] = color[1]; offset += 1;
          instances[offset] = color[2]; offset += 1;
          instances[offset] = color[3]; offset += 1;
        }
      }
    }

    function rebuildSurface(bound) {
      var vertices = surfaceMesh.vertices;
      var offset = 0;
      var heights = bound.heights;
      var layout = surfaceLayout;
      for (var vIndex = 0; vIndex < vCount - 1; vIndex += 1) {
        var ay = bound.vValues[vIndex];
        var cy = bound.vValues[vIndex + 1];
        var rowOffset = vIndex * uCount;
        var nextRowOffset = rowOffset + uCount;
        for (var uIndex = 0; uIndex < uCount - 1; uIndex += 1) {
          var ax = bound.uValues[uIndex];
          var bx = bound.uValues[uIndex + 1];
          var az = heights[rowOffset + uIndex];
          var bz = heights[rowOffset + uIndex + 1];
          var cz = heights[nextRowOffset + uIndex];
          var dz = heights[nextRowOffset + uIndex + 1];
          var abx = bx - ax;
          var abz = bz - az;
          var acy = cy - ay;
          var acz = cz - az;
          var qz = az - bz - cz + dz;
          for (var layoutOffset = 0; layoutOffset < layout.length; layoutOffset += 6) {
            var s0 = layout[layoutOffset];
            var s1 = layout[layoutOffset + 1];
            var sm = layout[layoutOffset + 2];
            var t0 = layout[layoutOffset + 3];
            var t1 = layout[layoutOffset + 4];
            var tm = layout[layoutOffset + 5];
            var p00z = az + (abz * s0) + (acz * t0) + (qz * s0 * t0);
            var p10z = az + (abz * s1) + (acz * t0) + (qz * s1 * t0);
            var p01z = az + (abz * s0) + (acz * t1) + (qz * s0 * t1);
            var p11z = az + (abz * s1) + (acz * t1) + (qz * s1 * t1);
            var tx = abx;
            var ty = 0.0;
            var tz = abz + (qz * tm);
            var bxn = 0.0;
            var byn = acy;
            var bzn = acz + (qz * sm);
            var nx = (ty * bzn) - (tz * byn);
            var ny = (tz * bxn) - (tx * bzn);
            var nz = (tx * byn) - (ty * bxn);
            var nlen = Math.sqrt((nx * nx) + (ny * ny) + (nz * nz)) || 1.0;
            nx /= nlen;
            ny /= nlen;
            nz /= nlen;
            writeDynamicVertexState(vertices, offset, p00z, nx, ny, nz); offset += 10;
            writeDynamicVertexState(vertices, offset, p10z, nx, ny, nz); offset += 10;
            writeDynamicVertexState(vertices, offset, p01z, nx, ny, nz); offset += 10;
            writeDynamicVertexState(vertices, offset, p10z, nx, ny, nz); offset += 10;
            writeDynamicVertexState(vertices, offset, p11z, nx, ny, nz); offset += 10;
            writeDynamicVertexState(vertices, offset, p01z, nx, ny, nz); offset += 10;
          }
        }
      }
      surfaceMesh.__revision = Number(surfaceMesh.__revision || 0) + 1;
    }

    function rebuildEdges(bound) {
      if (!edgeMesh) { return; }
      var instances = edgeMesh.instances;
      var heights = bound.heights;
      var offset = 0;
      for (var row = 0; row < vCount; row += 1) {
        var rowOffset = row * uCount;
        for (var col = 0; col < uCount - 1; col += 1) {
          instances[offset + 2] = heights[rowOffset + col];
          instances[offset + 6] = heights[rowOffset + col + 1];
          offset += 12;
        }
      }
      for (var col2 = 0; col2 < uCount; col2 += 1) {
        for (var row2 = 0; row2 < vCount - 1; row2 += 1) {
          var rowOffset2 = row2 * uCount;
          instances[offset + 2] = heights[rowOffset2 + col2];
          instances[offset + 6] = heights[rowOffset2 + uCount + col2];
          offset += 12;
        }
      }
      edgeMesh.__revision = Number(edgeMesh.__revision || 0) + 1;
    }

    function rebuildVertices(bound) {
      if (!vertexMesh) { return; }
      var instances = vertexMesh.instances;
      var heights = bound.heights;
      var offset = 2;
      for (var heightIndex = 0; heightIndex < heights.length; heightIndex += 1) {
        instances[offset] = heights[heightIndex];
        offset += 8;
      }
      vertexMesh.__revision = Number(vertexMesh.__revision || 0) + 1;
    }

    return {
      surfaceMesh: surfaceMesh,
      edgeMesh: edgeMesh,
      vertexMesh: vertexMesh,
      parts: function () {
        var out = [surfaceMesh];
        if (edgeMesh) { out.push(edgeMesh); }
        if (vertexMesh) { out.push(vertexMesh); }
        return out;
      },
      rebuild: function (bound) {
        rebuildSurface(bound);
        rebuildEdges(bound);
        rebuildVertices(bound);
      }
    };
  }

  global.VfGeomParametricSurface = {
    __vfRuntimeAssetVersion: RUNTIME_ASSET_VERSION,
    createGridSurfaceArena: createGridSurfaceArena
  };
})(typeof window !== "undefined" ? window : this);
