(function(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      root || globalThis,
      require("./vf-shared-runtime.js"),
      require("./vf-vkf-ui-math.js"),
      require("./vf-vkf-ui-kernel.js"),
      require("./vf-vkf-ui-kernel-adapter.js")
    );
    return;
  }
  root.VfVkfUiRuntime = factory(root || globalThis, root.VfSharedRuntime, root.VfVkfUiMath, root.VfVkfUiKernel, root.VfVkfUiKernelAdapter);
})(typeof globalThis !== "undefined" ? globalThis : this, function(global, shared, math, kernel, kernelAdapterModule) {
  "use strict";

  var HOVER_OBJECT = 1;
  var HOVER_FACE = 2;
  var HOVER_EDGE = 4;
  var HOVER_VERTEX = 8;
  var cloneVec2 = math.cloneVec2;
  var cloneVec3 = math.cloneVec3;
  var matMul2 = math.matMul2;
  var matVec2 = math.matVec2;
  var invert2 = math.invert2;
  var add2 = math.add2;
  var sub2 = math.sub2;
  var length2 = math.length2;
  var normalize2 = math.normalize2;
  var pointInPolygon = math.pointInPolygon;
  var distancePointToSegment = math.distancePointToSegment;

  function parseIndexedOverrides(spec, vectorKey, directKey) {
    var values = [];
    var maxIndex = -1;
    var vector = spec && spec[vectorKey];
    if (Array.isArray(vector)) {
      for (var i = 0; i < vector.length; i += 1) {
        values[i] = Number(vector[i]);
        maxIndex = i > maxIndex ? i : maxIndex;
      }
    }
    if (spec) {
      Object.keys(spec).forEach(function(key) {
        if (key.indexOf(directKey + "_") !== 0) { return; }
        var index = Number(key.slice(directKey.length + 1));
        if (Number.isFinite(index)) {
          values[index] = Number(spec[key]);
          maxIndex = index > maxIndex ? index : maxIndex;
        }
      });
    }
    if (maxIndex >= 0) {
      for (var fill = 0; fill <= maxIndex; fill += 1) {
        if (!Object.prototype.hasOwnProperty.call(values, fill)) {
          values[fill] = undefined;
        }
      }
    }
    return values;
  }

  function mergeOverlaySpec(base, extra) {
    var merged = {};
    var key;
    for (key in base) {
      if (Object.prototype.hasOwnProperty.call(base, key)) {
        merged[key] = base[key];
      }
    }
    for (key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) {
        merged[key] = extra[key];
      }
    }
    return merged;
  }

  function canonicalHoverForObject(object, hoverExtra) {
    hoverExtra = hoverExtra || {};
    var hover = {
      object_id: object.id,
      vertex_id: hoverExtra.vertex_id == null ? -1 : hoverExtra.vertex_id,
      edge_id: hoverExtra.edge_id == null ? -1 : hoverExtra.edge_id,
      face_id: hoverExtra.face_id == null ? -1 : hoverExtra.face_id,
      mask: HOVER_OBJECT,
      kind: HOVER_OBJECT
    };
    if (hover.face_id >= 0) {
      hover.mask |= HOVER_FACE;
      hover.kind = HOVER_FACE;
    }
    if (hover.edge_id >= 0) {
      hover.mask |= HOVER_EDGE;
      hover.kind = HOVER_EDGE;
    }
    if (hover.vertex_id >= 0) {
      hover.mask |= HOVER_VERTEX;
      hover.kind = HOVER_VERTEX;
    }
    return hover;
  }

  function createAllocator(limit) {
    var nextValue = 0;
    return function allocate() {
      var value = nextValue;
      nextValue += 1;
      if (value >= limit) {
        throw new Error("allocator capacity exceeded");
      }
      return value;
    };
  }

  function createVkfUiRuntime(options) {
    options = options || {};
    var arena = options.arena;
    var geometryArena = options.geometryArena || null;
    var eventArena = options.eventArena;
    var kernelAdapter = options.kernelAdapter || kernelAdapterModule.createJsKernelAdapter();
    var allocSlot = createAllocator(arena.capacity());
    var allocObjectId = createAllocator(1 << 30);
    var allocGeometry = geometryArena ? createAllocator(geometryArena.capacity()) : null;
    var objectById = new Map();
    var eventReader = eventArena.readerView();

    function registerObject(object) {
      objectById.set(object.id, object);
      return object;
    }

    function writeObjectTransform(object) {
      var anchor = object.transformAnchorWorld();
      arena.setTranslate2D(object.slot, anchor[0], anchor[1]);
      object.children.forEach(function(child) {
        if (child.kind === "mesh" || child.kind === "rect") {
          writeObjectTransform(child);
        }
      });
    }

    function writeGeometryVertex(mesh, index) {
      if (!geometryArena || mesh.geometry_offset == null) { return; }
      geometryArena.setVertex(
        mesh.geometry_offset + index,
        mesh.coords.x[index] || 0,
        mesh.coords.y[index] || 0,
        mesh.coords.z[index] || 0
      );
    }

    function writeGeometryAll(mesh) {
      if (!geometryArena || mesh.geometry_offset == null) { return; }
      for (var i = 0; i < mesh.coords.x.length; i += 1) {
        writeGeometryVertex(mesh, i);
      }
    }

    function RectObject(panel, parent, rect, opts) {
      this.kind = "rect";
      this.panel = panel;
      this.parent = parent || null;
      this.children = [];
      this.id = allocObjectId();
      this.slot = allocSlot();
      this.offset = [rect[0], rect[1]];
      this.size = [rect[2], rect[3]];
      this.color = opts && opts.color ? opts.color.slice() : [1, 1, 1, 1];
      if (parent) {
        parent.children.push(this);
      }
      registerObject(this);
      writeObjectTransform(this);
    }

    RectObject.prototype.parentWorldOrigin = function() {
      if (!this.parent) { return [0, 0]; }
      if (this.parent.kind === "rect") {
        var parentRect = this.parent.world_rect();
        return [parentRect.x, parentRect.y];
      }
      return this.parent.world_inner_point([0, 0, 0]).slice(0, 2);
    };

    RectObject.prototype.world_rect = function() {
      var origin = this.parentWorldOrigin();
      return {
        x: origin[0] + this.offset[0],
        y: origin[1] + this.offset[1],
        w: this.size[0],
        h: this.size[1]
      };
    };

    RectObject.prototype.transformAnchorWorld = function() {
      var rect = this.world_rect();
      return [rect.x, rect.y];
    };

    RectObject.prototype.translate = function(options) {
      var trans = cloneVec2(options && options.trans);
      this.offset[0] += trans[0];
      this.offset[1] += trans[1];
      writeObjectTransform(this);
    };

    RectObject.prototype.add_rect = function(rect, opts) {
      return new RectObject(this.panel, this, rect, opts || {});
    };

    function MeshObject(panel, parent, spec, opts) {
      this.kind = "mesh";
      this.panel = panel;
      this.parent = parent || null;
      this.children = [];
      this.id = allocObjectId();
      this.slot = allocSlot();
      this.geometry_version = 0;
      this.vertices = [];
      this.edges = [];
      this.faces = [];
      this.volumes = [];
      this.volume_policy = "filled";
      this.projections = [];
      this.embeddings = [];
      this.props = {};
      this.origin = cloneVec3(spec.origin || [0, 0, 0]);
      this.coords = {
        x: (spec.x || []).map(Number),
        y: (spec.y || []).map(Number),
        z: (spec.z || []).map(Number)
      };
      while (this.coords.z.length < this.coords.x.length) {
        this.coords.z.push(0);
      }
      this.initial_bounds = computeBounds(this.coords);
      this.bounds = Array.isArray(spec.bounds) ? spec.bounds.slice() : null;
      this.offset = [0, 0];
      this.matrix = [1, 0, 0, 1];
      this.face_color = cloneColor(spec.face_color || (opts && opts.face_color) || [1, 1, 1, 0]);
      this.edge_color = cloneColor(spec.edge_color || (opts && opts.edge_color) || [1, 1, 1, 1]);
      this.vertex_color = cloneColor(spec.vertex_color || (opts && opts.vertex_color) || [1, 1, 1, 1]);
      this.volume_color = cloneColor(spec.volume_color || (opts && opts.volume_color) || [1, 1, 1, 0]);
      this.edge_style = spec.edge_style || (opts && opts.edge_style) || "";
      this.edge_unit_length = Number(spec.edge_unit_length || (opts && opts.edge_unit_length) || 6);
      this.vertex_style = spec.vertex_style || (opts && opts.vertex_style) || "disc";
      this.vertex_radius = Number(spec.vertex_radius || (opts && opts.vertex_radius) || 4);
      this.edge_radius = Number(spec.edge_radius || spec.edge_width || (opts && (opts.edge_radius || opts.edge_width)) || 2);
      this.vertex_pick_radius = Number(spec.vertex_pick_radius || (opts && opts.vertex_pick_radius) || Math.max(5, this.vertex_radius));
      this.edge_pick_radius = Number(spec.edge_pick_radius || (opts && opts.edge_pick_radius) || Math.max(5, this.edge_radius));
      this.vertex_radius_values = parseIndexedOverrides(mergeOverlaySpec(opts || {}, spec || {}), "vertex_radius_vector", "vertex_radius");
      this.edge_width_values = parseIndexedOverrides(mergeOverlaySpec(opts || {}, spec || {}), "edge_width_vector", "edge_width");
      if (parent) {
        parent.children.push(this);
      }
      initProps(this, spec);
      initMeshTransform(this);
      if (geometryArena) {
        this.geometry_offset = allocGeometry();
        for (var i = 1; i < this.coords.x.length; i += 1) {
          allocGeometry();
        }
        writeGeometryAll(this);
      } else {
        this.geometry_offset = null;
      }
      registerObject(this);
      writeObjectTransform(this);
    }

    function cloneColor(value) {
      return Array.isArray(value) ? value.slice() : [1, 1, 1, 1];
    }

    function computeBounds(coords) {
      if (!coords.x.length) {
        return { x: 0, y: 0, w: 0, h: 0 };
      }
      var minX = Math.min.apply(null, coords.x);
      var maxX = Math.max.apply(null, coords.x);
      var minY = Math.min.apply(null, coords.y);
      var maxY = Math.max.apply(null, coords.y);
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    function initProps(mesh, spec) {
      Object.keys(spec).forEach(function(key) {
        if (
          key === "x" || key === "y" || key === "z" || key === "bounds" || key === "origin" ||
          key === "face_color" || key === "edge_color" || key === "vertex_color" || key === "volume_color" ||
          key === "vertex_radius" || key === "edge_radius" || key === "edge_width" ||
          key === "vertex_pick_radius" || key === "edge_pick_radius" ||
          key === "vertex_style" || key === "edge_style" || key === "edge_unit_length" ||
          key === "vertex_radius_vector" || key === "edge_width_vector" ||
          key.indexOf("vertex_radius_") === 0 || key.indexOf("edge_width_") === 0 ||
          key === "normalized"
        ) {
          return;
        }
        mesh.props[key] = spec[key];
      });
    }

    function initMeshTransform(mesh) {
      if (!mesh.bounds) {
        mesh.matrix = [1, 0, 0, 1];
        mesh.offset = [0, 0];
        return;
      }
      var b = mesh.initial_bounds;
      var width = b.w || 1;
      var height = b.h || 1;
      var sx = mesh.bounds[2] / width;
      var sy = -mesh.bounds[3] / height;
      mesh.matrix = [sx, 0, 0, sy];
      mesh.offset = [
        mesh.bounds[0] - b.x * sx,
        mesh.bounds[1] - (b.y + b.h) * sy
      ];
    }

    MeshObject.prototype.transformAnchorWorld = function() {
      return this.world_inner_point([0, 0, 0]);
    };

    MeshObject.prototype._parent_point_from_inner = function(innerPoint) {
      var point = cloneVec3(innerPoint);
      var xy = matVec2(this.matrix, [point[0], point[1]]);
      return [xy[0] + this.offset[0], xy[1] + this.offset[1], point[2]];
    };

    MeshObject.prototype._inner_point_from_parent = function(parentPoint) {
      var inv = invert2(this.matrix);
      var xy = matVec2(inv, [parentPoint[0] - this.offset[0], parentPoint[1] - this.offset[1]]);
      return [xy[0], xy[1], parentPoint[2] || 0];
    };

    MeshObject.prototype.world_inner_point = function(innerPoint) {
      var parentPoint = this._parent_point_from_inner(innerPoint);
      if (this.parent && this.parent.kind === "mesh") {
        return this.parent.world_inner_point(parentPoint);
      }
      return parentPoint;
    };

    MeshObject.prototype.world_point = function(index) {
      return this.world_inner_point([
        this.coords.x[index] || 0,
        this.coords.y[index] || 0,
        this.coords.z[index] || 0
      ]);
    };

    MeshObject.prototype.world_points = function() {
      var out = [];
      for (var i = 0; i < this.coords.x.length; i += 1) {
        out.push(this.world_point(i));
      }
      return out;
    };

    MeshObject.prototype.translate = function(options) {
      var trans = cloneVec2(options && options.trans);
      this.offset[0] += trans[0];
      this.offset[1] += trans[1];
      writeObjectTransform(this);
    };

    MeshObject.prototype.rotate_scale_at_vertex = function(options) {
      var next = kernelAdapter.rotateScaleTransform({
        matrix: this.matrix,
        offset: this.offset,
        angle: options && options.angle,
        scale: options && options.scale,
        origo: options && options.origo
      });
      this.matrix = next.matrix;
      this.offset = next.offset;
      writeObjectTransform(this);
    };

    MeshObject.prototype.scale_edge = function(options) {
      var edge = this.edges[(options && options.edge) | 0] || [0, 0];
      var next = kernelAdapter.scaleEdgeTransform({
        matrix: this.matrix,
        offset: this.offset,
        edgeA: this._parent_point_from_inner([
        this.coords.x[edge[0]] || 0,
        this.coords.y[edge[0]] || 0,
        this.coords.z[edge[0]] || 0
      ]),
        edgeB: this._parent_point_from_inner([
        this.coords.x[edge[1]] || 0,
        this.coords.y[edge[1]] || 0,
        this.coords.z[edge[1]] || 0
      ]),
        scale: options && options.scale,
        origo: options && options.origo
      });
      this.matrix = next.matrix;
      this.offset = next.offset;
      writeObjectTransform(this);
    };

    MeshObject.prototype.move_vertex = function(options) {
      var vertex = (options && options.vertex) | 0;
      var localCursor = options && options.local_cursor;
      if (!localCursor && options && options.local_trans) {
        var current = this._parent_point_from_inner([
          this.coords.x[vertex] || 0,
          this.coords.y[vertex] || 0,
          this.coords.z[vertex] || 0
        ]);
        localCursor = [current[0] + options.local_trans[0], current[1] + options.local_trans[1]];
      }
      var nextCoords = kernelAdapter.moveVertexToLocalCursor({
        coords: this.coords,
        matrix: this.matrix,
        offset: this.offset,
        vertex: vertex,
        localCursor: localCursor
      });
      this.coords.x = nextCoords.x;
      this.coords.y = nextCoords.y;
      this.geometry_version += 1;
      writeGeometryVertex(this, vertex);
    };

    MeshObject.prototype.translate_edge = function(options) {
      var edge = this.edges[(options && options.edge) | 0] || [0, 0];
      var nextCoords = kernelAdapter.translateEdgeVertices({
        coords: this.coords,
        matrix: this.matrix,
        edge: edge,
        localTrans: cloneVec2(options && options.local_trans)
      });
      this.coords.x = nextCoords.x;
      this.coords.y = nextCoords.y;
      for (var i = 0; i < edge.length; i += 1) {
        writeGeometryVertex(this, edge[i]);
      }
      this.geometry_version += 1;
    };

    MeshObject.prototype.add = function(spec, opts) {
      return new MeshObject(this.panel, this, spec || {}, opts || {});
    };

    MeshObject.prototype.add_vertices = function(vertices) {
      this.vertices = vertices.slice();
      return this;
    };

    MeshObject.prototype.add_edges = function(edges) {
      this.edges = edges.map(function(edge) { return edge.slice(); });
      return this;
    };

    MeshObject.prototype.add_faces = function(faces) {
      this.faces = faces.map(function(face) { return face.slice(); });
      return this;
    };

    MeshObject.prototype.add_volumes = function(volumes) {
      if (!Array.isArray(volumes) || !volumes.length) { return this; }
      for (var i = 0; i < volumes.length; i += 1) {
        if (volumes[i].length >= 4) {
          this.volumes.push(volumes[i].slice());
        }
      }
      return this;
    };

    MeshObject.prototype.visible_volume_surfaces = function() {
      return { policy: this.volume_policy, surfaces: "first_last_per_dimension" };
    };

    MeshObject.prototype.set_overlay = function(spec) {
      spec = spec || {};
      if (spec.edge_style != null) { this.edge_style = spec.edge_style; }
      if (spec.edge_unit_length != null) { this.edge_unit_length = Number(spec.edge_unit_length); }
      if (spec.vertex_style != null) { this.vertex_style = spec.vertex_style; }
      if (spec.vertex_radius != null || spec.vertex_width != null) {
        this.vertex_radius = Number(spec.vertex_radius != null ? spec.vertex_radius : spec.vertex_width);
      }
      if (spec.edge_radius != null || spec.edge_width != null) {
        this.edge_radius = Number(spec.edge_radius != null ? spec.edge_radius : spec.edge_width);
      }
      if (spec.vertex_pick_radius != null) { this.vertex_pick_radius = Number(spec.vertex_pick_radius); }
      else if (spec.vertex_radius != null || spec.vertex_width != null) { this.vertex_pick_radius = Math.max(5, this.vertex_radius); }
      if (spec.edge_pick_radius != null) { this.edge_pick_radius = Number(spec.edge_pick_radius); }
      this.vertex_radius_values = parseIndexedOverrides(spec, "vertex_radius_vector", "vertex_radius");
      this.edge_width_values = parseIndexedOverrides(spec, "edge_width_vector", "edge_width");
    };

    MeshObject.prototype.vertex_radius_at = function(index) {
      return this.vertex_radius_values[index] == null ? this.vertex_radius : this.vertex_radius_values[index];
    };

    MeshObject.prototype.edge_width_at = function(index) {
      return this.edge_width_values[index] == null ? this.edge_radius : this.edge_width_values[index];
    };

    MeshObject.prototype.edge_radius_at = function(index) {
      return this.edge_width_at(index);
    };

    MeshObject.prototype.vertex_pick_radius_at = function(index) {
      var radius = this.vertex_radius_values[index];
      return Math.max(this.vertex_pick_radius, radius == null ? 0 : radius);
    };

    MeshObject.prototype.edge_pick_radius_at = function(index) {
      var radius = this.edge_width_values[index];
      return Math.max(this.edge_pick_radius, radius == null ? 0 : radius);
    };

    MeshObject.prototype.prop = function(name) {
      return this.props[name];
    };

    MeshObject.prototype.set_prop = function(name, value) {
      this.props[name] = value;
    };

    MeshObject.prototype.add_projection = function(projection) {
      this.projections.push(projection);
    };

    MeshObject.prototype.add_embedding = function(embedding) {
      var allowed = {
        pos: true,
        color: true,
        visible: true,
        size: true,
        radius: true,
        normal: true,
        temp: true
      };
      Object.keys(embedding).forEach(function(key) {
        if (!allowed[key]) {
          throw new Error("canonical render attr required");
        }
      });
      this.embeddings.push(embedding);
    };

    MeshObject.prototype.add_simplices = function(simplexSpec) {
      if (!this.vertices.length) {
        this.vertices = this.coords.x.map(function(_value, index) { return index; });
      }
      if (simplexSpec.edges) { this.edges = simplexSpec.edges.map(function(edge) { return edge.slice(); }); }
      if (simplexSpec.faces) { this.faces = simplexSpec.faces.map(function(face) { return face.slice(); }); }
    };

    function Frame(display, options) {
      this.display = display;
      this.title = options && options.title || "";
      this.children = [];
      this.viewport = [0, 0, 1, 1];
    }

    Frame.prototype.add_rect = function(rect, opts) {
      var object = new RectObject(this, null, rect, opts || {});
      this.children.push(object);
      return object;
    };

    Frame.prototype.add = function(spec, opts) {
      var mesh = new MeshObject(this, null, spec || {}, opts || {});
      this.children.push(mesh);
      return mesh;
    };

    Frame.prototype.get = function(ref) {
      if (ref == null) { return undefined; }
      var id = typeof ref === "number" ? ref : (ref.object_id != null ? ref.object_id : ref.id);
      return objectById.get(id);
    };

    Frame.prototype.pick = function(point) {
      var rectHit = pickRectObject(this.children, point);
      if (rectHit) {
        return rectHit;
      }
      var meshHit = pickMeshObject(this.children, point);
      if (meshHit) {
        return meshHit;
      }
      return undefined;
    };

    function pickRectObject(objects, point) {
      for (var i = objects.length - 1; i >= 0; i -= 1) {
        var object = objects[i];
        if (object.kind !== "rect") { continue; }
        var childHit = pickRectObject(object.children, point);
        if (childHit) { return childHit; }
        var rect = object.world_rect();
        if (point[0] >= rect.x && point[0] <= rect.x + rect.w && point[1] >= rect.y && point[1] <= rect.y + rect.h) {
          return object;
        }
      }
      return null;
    }

    function pickMeshObject(objects, point) {
      for (var i = objects.length - 1; i >= 0; i -= 1) {
        var object = objects[i];
        var childHit = object.children && object.children.length ? pickMeshObject(object.children, point) : null;
        if (childHit) { return childHit; }
        if (object.kind !== "mesh") { continue; }
        var hover = pickMeshHover(object, point);
        if (hover) {
          return { object: object, hover: hover };
        }
      }
      return null;
    }

    function pickMeshHover(mesh, point) {
      var worldPoints = mesh.world_points();
      var vertexPickRadii = [];
      var edgePickRadii = [];
      for (var i = 0; i < mesh.coords.x.length; i += 1) {
        vertexPickRadii[i] = mesh.vertex_pick_radius_at(i);
      }
      for (i = 0; i < mesh.edges.length; i += 1) {
        edgePickRadii[i] = mesh.edge_pick_radius_at(i);
      }
      var vertexIndex = kernelAdapter.pickVertexIndex({
        point: point,
        vertices: mesh.vertices,
        worldPoints: worldPoints,
        vertexPickRadii: vertexPickRadii
      });
      if (vertexIndex >= 0) {
        return canonicalHoverForObject(mesh, { vertex_id: vertexIndex });
      }
      var edgeIndex = kernelAdapter.pickEdgeIndex({
        point: point,
        edges: mesh.edges,
        worldPoints: worldPoints,
        edgePickRadii: edgePickRadii
      });
      if (edgeIndex >= 0) {
        return canonicalHoverForObject(mesh, { edge_id: edgeIndex });
      }
      var faceIndex = kernelAdapter.pickFaceIndex({
        point: point,
        faces: mesh.faces,
        worldPoints: worldPoints
      });
      if (faceIndex >= 0) {
        return canonicalHoverForObject(mesh, { face_id: faceIndex });
      }
      return null;
    }

    var display = {
      width: Number(options.width || 960),
      height: Number(options.height || 540),
      frames: [],
      set_size: function(size) {
        this.width = Number(size.width || this.width);
        this.height = Number(size.height || this.height);
      },
      frame: function(frameOptions) {
        return new Frame(display, frameOptions || {});
      },
      add_frame: function(frame, viewport) {
        frame.viewport = viewport.slice();
        this.frames.push(frame);
      }
    };

    function readLatestEvent() {
      var sample = eventReader.latestSample();
      var hoverObject = sample.hover && sample.hover.object != null ? objectById.get(sample.hover.object) : null;
      var hover = hoverObject ? canonicalHoverForObject(hoverObject, {
        vertex_id: sample.hover && sample.hover.vertex != null ? sample.hover.vertex : -1,
        edge_id: sample.hover && sample.hover.edge != null ? sample.hover.edge : -1,
        face_id: sample.hover && sample.hover.face != null ? sample.hover.face : -1
      }) : canonicalHoverForObject({ id: -1 }, {});
      if (hover.object_id < 0) {
        hover.mask = 0;
        hover.kind = 0;
      }
      return {
        event: sample.pointerDown ? ui.MOUSE_DRAG : ui.MOUSE_MOVE,
        hover: hover,
        trans: [
          (sample.cursorPx && sample.cursorPx[0] || 0) - (sample.pointerAnchorPx && sample.pointerAnchorPx[0] || 0),
          (sample.cursorPx && sample.cursorPx[1] || 0) - (sample.pointerAnchorPx && sample.pointerAnchorPx[1] || 0)
        ],
        local_cursor: sample.localCursor ? sample.localCursor.slice() : [0, 0],
        local_anchor: sample.localAnchor ? sample.localAnchor.slice() : [0, 0],
        local_trans: [
          (sample.localCursor && sample.localCursor[0] || 0) - (sample.localAnchor && sample.localAnchor[0] || 0),
          (sample.localCursor && sample.localCursor[1] || 0) - (sample.localAnchor && sample.localAnchor[1] || 0)
        ],
        key_mask: sample.keyMask || 0,
        buttons: sample.buttons || 0
      };
    }

    var ui = {
      MOUSE_DRAG: "mouse_drag",
      MOUSE_MOVE: "mouse_move",
      display: display,
      selection: undefined,
      cursor: {
        mode: "default",
        set_mode: function(mode) {
          this.mode = mode;
        }
      },
      keyboard: {
        mask: 0,
        modifiers: { ctrl: false, shift: false, alt: false, meta: false },
        set_mask: function(mask) {
          this.mask = mask | 0;
          this.modifiers = {
            ctrl: !!(this.mask & 1),
            shift: !!(this.mask & 2),
            alt: !!(this.mask & 4),
            meta: !!(this.mask & 8)
          };
        }
      },
      events: {
        get: function() {
          return readLatestEvent();
        }
      }
    };

    return {
      ui: ui
    };
  }

  return {
    HOVER_OBJECT: HOVER_OBJECT,
    HOVER_FACE: HOVER_FACE,
    HOVER_EDGE: HOVER_EDGE,
    HOVER_VERTEX: HOVER_VERTEX,
    createVkfUiRuntime: createVkfUiRuntime
  };
});
