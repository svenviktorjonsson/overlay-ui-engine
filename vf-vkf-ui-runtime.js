(function (global) {
  "use strict";

  var MAT4_F32 = 16;
  var MOUSE_MOVE = 1;
  var MOUSE_DOWN = 2;
  var MOUSE_UP = 3;
  var MOUSE_DRAG = 4;
  var HOVER_OBJECT = 1;
  var HOVER_FACE = 2;
  var HOVER_EDGE = 4;
  var HOVER_VERTEX = 8;
  var CANONICAL_RENDER_ATTRS = Object.freeze({
    pos: true,
    color: true,
    normal: true,
    uv: true,
    radius: true,
    width: true,
    visible: true
  });

  function numberOrZero(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function intOrDefault(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n | 0 : fallback;
  }

  function finiteOrDefault(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function valueOrDefault(value, fallback) {
    return value != null ? value : fallback;
  }

  function copyNumericVector(value, name) {
    if (value == null) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new TypeError(name + " expects an array");
    }
    return value.map(function (entry) {
      return numberOrZero(entry);
    });
  }

  function setIndexedNumericValue(values, index, value) {
    while (values.length < index) {
      values.push(undefined);
    }
    values[index] = numberOrZero(value);
  }

  function copyIndexedNumericValues(baseName, spec, options) {
    var out = copyNumericVector(
      valueOrDefault(options[baseName + "_vector"], spec[baseName + "_vector"]),
      baseName + "_vector"
    );
    [spec, options].forEach(function (source) {
      Object.keys(source || {}).forEach(function (key) {
        var prefix = baseName + "_";
        if (key.indexOf(prefix) !== 0 || key === baseName + "_vector") {
          return;
        }
        var suffix = key.slice(prefix.length);
        if (!/^\d+$/.test(suffix)) {
          return;
        }
        setIndexedNumericValue(out, Number(suffix), source[key]);
      });
    });
    return out;
  }

  function rectFromArray(rect) {
    if (!rect || rect.length < 4) {
      throw new TypeError("rect expects [x, y, w, h]");
    }
    return {
      x: numberOrZero(rect[0]),
      y: numberOrZero(rect[1]),
      w: numberOrZero(rect[2]),
      h: numberOrZero(rect[3])
    };
  }

  function normalizedHover(sample) {
    var hover = sample && sample.hover ? sample.hover : {};
    var out = {
      frame_id: intOrDefault(hover.frame_id != null ? hover.frame_id : hover.frame, -1),
      object_id: intOrDefault(hover.object_id != null ? hover.object_id : hover.object, -1),
      face_id: intOrDefault(hover.face_id != null ? hover.face_id : hover.face, -1),
      edge_id: intOrDefault(hover.edge_id != null ? hover.edge_id : hover.edge, -1),
      vertex_id: intOrDefault(hover.vertex_id != null ? hover.vertex_id : hover.vertex, -1)
    };
    out.mask = intOrDefault(hover.mask, hoverMask(out));
    out.kind = intOrDefault(hover.kind_id != null ? hover.kind_id : hover.kind, hoverKind(out));
    return Object.freeze(out);
  }

  function eventKind(sample) {
    if (!sample) {
      return MOUSE_MOVE;
    }
    if (sample.pointerDown && sample.buttons) {
      return MOUSE_DRAG;
    }
    return sample.pointerDown ? MOUSE_DOWN : MOUSE_MOVE;
  }

  function eventFromSample(sample) {
    sample = sample || {};
    var cursor = sample.cursorPx || [0, 0];
    var anchor = sample.pointerAnchorPx || cursor;
    var localCursor = sample.localCursor || cursor;
    var localAnchor = sample.localAnchor || anchor;
    return Object.freeze({
      event: eventKind(sample),
      cursor: Object.freeze([numberOrZero(cursor[0]), numberOrZero(cursor[1])]),
      local_cursor: Object.freeze([numberOrZero(localCursor[0]), numberOrZero(localCursor[1])]),
      local_anchor: Object.freeze([numberOrZero(localAnchor[0]), numberOrZero(localAnchor[1])]),
      trans: Object.freeze([
        numberOrZero(cursor[0]) - numberOrZero(anchor[0]),
        numberOrZero(cursor[1]) - numberOrZero(anchor[1])
      ]),
      local_trans: Object.freeze([
        numberOrZero(localCursor[0]) - numberOrZero(localAnchor[0]),
        numberOrZero(localCursor[1]) - numberOrZero(localAnchor[1])
      ]),
      hover: normalizedHover(sample),
      buttons: intOrDefault(sample.buttons, 0),
      key_mask: intOrDefault(sample.keyMask, 0),
      sequence: intOrDefault(sample.sequence, 0),
      time_ms: numberOrZero(sample.timeMs)
    });
  }

  function makeHover(objectId, vertexId, edgeId, faceId) {
    var hover = {
      object_id: objectId,
      vertex_id: vertexId == null ? -1 : vertexId,
      edge_id: edgeId == null ? -1 : edgeId,
      face_id: faceId == null ? -1 : faceId
    };
    hover.mask = hoverMask(hover);
    hover.kind = hoverKind(hover);
    return Object.freeze(hover);
  }

  function hoverMask(hover) {
    var mask = 0;
    if (hover.object_id >= 0) {
      mask |= HOVER_OBJECT;
    }
    if (hover.face_id >= 0) {
      mask |= HOVER_FACE;
    }
    if (hover.edge_id >= 0) {
      mask |= HOVER_EDGE;
    }
    if (hover.vertex_id >= 0) {
      mask |= HOVER_VERTEX;
    }
    return mask;
  }

  function hoverKind(hover) {
    if (hover.vertex_id >= 0) {
      return HOVER_VERTEX;
    }
    if (hover.edge_id >= 0) {
      return HOVER_EDGE;
    }
    if (hover.face_id >= 0) {
      return HOVER_FACE;
    }
    if (hover.object_id >= 0) {
      return HOVER_OBJECT;
    }
    return 0;
  }

  function dot2(ax, ay, bx, by) {
    return ax * bx + ay * by;
  }

  function dist2(ax, ay, bx, by) {
    var dx = ax - bx;
    var dy = ay - by;
    return dx * dx + dy * dy;
  }

  function pointSegmentDistance(point, a, b) {
    var px = point[0];
    var py = point[1];
    var ax = a[0];
    var ay = a[1];
    var bx = b[0];
    var by = b[1];
    var vx = bx - ax;
    var vy = by - ay;
    var len2 = vx * vx + vy * vy;
    var t = len2 > 0 ? Math.max(0, Math.min(1, dot2(px - ax, py - ay, vx, vy) / len2)) : 0;
    return Math.sqrt(dist2(px, py, ax + vx * t, ay + vy * t));
  }

  function closestPointOnSegment(point, a, b) {
    var px = point[0];
    var py = point[1];
    var ax = a[0];
    var ay = a[1];
    var bx = b[0];
    var by = b[1];
    var vx = bx - ax;
    var vy = by - ay;
    var len2 = vx * vx + vy * vy;
    var t = len2 > 0 ? Math.max(0, Math.min(1, dot2(px - ax, py - ay, vx, vy) / len2)) : 0;
    return [ax + vx * t, ay + vy * t];
  }

  function pointInPolygon(point, polygon) {
    var x = point[0];
    var y = point[1];
    var inside = false;
    for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      var xi = polygon[i][0];
      var yi = polygon[i][1];
      var xj = polygon[j][0];
      var yj = polygon[j][1];
      var intersects = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi);
      if (intersects) {
        inside = !inside;
      }
    }
    return inside;
  }

  function copyRect(rect) {
    return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  }

  function RectRef(runtime, panel, slot, id, rect, color, parent) {
    this.runtime = runtime;
    this.panel = panel;
    this.slot = slot;
    this.id = id;
    this.local = rect;
    this.world = copyRect(rect);
    this.color = color || [1, 1, 1, 1];
    this.parent = parent || null;
    this.children = [];
  }

  RectRef.prototype._sync_world = function () {
    if (this.parent) {
      var parentWorld = this.parent.world;
      this.world.x = parentWorld.x + this.local.x;
      this.world.y = parentWorld.y + this.local.y;
    } else {
      this.world.x = this.local.x;
      this.world.y = this.local.y;
    }
    this.world.w = this.local.w;
    this.world.h = this.local.h;
    this.runtime.arena.setTranslate2D(this.slot, this.world.x, this.world.y);
    for (var i = 0; i < this.children.length; i++) {
      this.children[i]._sync_world();
    }
  };

  RectRef.prototype.world_rect = function () {
    return copyRect(this.world);
  };

  RectRef.prototype.translate = function (args) {
    args = args || {};
    var trans = args.trans || [numberOrZero(args.dx), numberOrZero(args.dy)];
    this.local.x += numberOrZero(trans[0]);
    this.local.y += numberOrZero(trans[1]);
    this._sync_world();
    return this;
  };

  RectRef.prototype.add_rect = function (rectArray, options) {
    return this.panel._add_rect(rectArray, options, this);
  };

  function copyIndexList(values, arity, name) {
    if (!Array.isArray(values)) {
      throw new TypeError(name + " expects an array of indices");
    }
    return values.map(function (entry) {
      var tuple = Array.isArray(entry) ? entry : [entry];
      if (arity != null && tuple.length !== arity) {
        throw new TypeError(name + " expects index tuples of length " + arity);
      }
      return tuple.map(function (value) {
        var index = Number(value);
        if (!Number.isInteger(index) || index < 0) {
          throw new TypeError(name + " indices must be non-negative integers");
        }
        return index;
      });
    });
  }

  function coordsFromSpec(spec) {
    spec = spec || {};
    var x = Array.isArray(spec.x) ? spec.x.map(numberOrZero) : [];
    var y = Array.isArray(spec.y) ? spec.y.map(numberOrZero) : [];
    var z = Array.isArray(spec.z) ? spec.z.map(numberOrZero) : [];
    var n = Math.max(x.length, y.length, z.length);
    if (n <= 0) {
      throw new TypeError("add expects at least one coordinate vector");
    }
    while (x.length < n) { x.push(0); }
    while (y.length < n) { y.push(0); }
    while (z.length < n) { z.push(0); }
    return { x: x, y: y, z: z };
  }

  function isSystemControlProp(key) {
    return [
      "bounds",
      "box",
      "aspect",
      "normalized",
      "origin",
      "topology"
    ].indexOf(key) >= 0;
  }

  function copySystemProps(spec, options) {
    var props = Object.create(null);
    [spec || {}, options || {}].forEach(function (source) {
      Object.keys(source).forEach(function (key) {
        if (!isSystemControlProp(key)) {
          props[key] = source[key];
        }
      });
    });
    return props;
  }

  function copyProjectionMap(map) {
    var out = {};
    Object.keys(map || {}).forEach(function (key) {
      out[key] = map[key];
    });
    return out;
  }

  function validateEmbeddingMap(map) {
    Object.keys(map || {}).forEach(function (key) {
      if (!CANONICAL_RENDER_ATTRS[key]) {
        throw new TypeError("embedding output '" + key + "' is not a canonical render attr");
      }
    });
  }

  function initialBoundsFrom(coords) {
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var i = 0; i < coords.x.length; i++) {
      var x = numberOrZero(coords.x[i]);
      var y = numberOrZero(coords.y[i]);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return {
      x: Number.isFinite(minX) ? minX : 0,
      y: Number.isFinite(minY) ? minY : 0,
      w: Number.isFinite(maxX - minX) ? maxX - minX : 0,
      h: Number.isFinite(maxY - minY) ? maxY - minY : 0
    };
  }

  function meshOptionsFrom(spec, options) {
    spec = spec || {};
    options = options || {};
    return {
      face_color: options.face_color || spec.face_color || options.color || spec.color || [1, 1, 1, 1],
      edge_color: options.edge_color || spec.edge_color || [1, 1, 1, 1],
      vertex_color: options.vertex_color || spec.vertex_color || [1, 1, 1, 1],
      volume_color: options.volume_color || spec.volume_color || [1, 1, 1, 1],
      edge_style: valueOrDefault(options.edge_style, spec.edge_style),
      edge_unit_length: valueOrDefault(options.edge_unit_length, spec.edge_unit_length),
      vertex_style: valueOrDefault(options.vertex_style, spec.vertex_style),
      vertex_radius: options.vertex_radius != null ? options.vertex_radius :
        options.vertex_width != null ? options.vertex_width :
        spec.vertex_radius != null ? spec.vertex_radius : spec.vertex_width,
      vertex_radius_values: copyIndexedNumericValues("vertex_radius", spec, options),
      edge_radius: options.edge_radius != null ? options.edge_radius :
        options.edge_width != null ? options.edge_width :
        spec.edge_radius != null ? spec.edge_radius : spec.edge_width,
      edge_width_values: copyIndexedNumericValues("edge_width", spec, options),
      vertex_pick_radius: options.vertex_pick_radius != null ? options.vertex_pick_radius : spec.vertex_pick_radius,
      edge_pick_radius: options.edge_pick_radius != null ? options.edge_pick_radius : spec.edge_pick_radius,
      edge_scale: options.edge_scale != null ? options.edge_scale : spec.edge_scale,
      bounds: options.bounds || options.box || spec.bounds || spec.box,
      aspect: options.aspect || spec.aspect || "stretch",
      normalized: options.normalized != null ? options.normalized : spec.normalized,
      origin: options.origin || spec.origin
    };
  }

  function MeshRef(runtime, panel, slot, id, coords, options, parent, spec) {
    options = options || {};
    this.runtime = runtime;
    this.panel = panel;
    this.slot = slot;
    this.id = id;
    this.parent = parent || null;
    this.children = [];
    this.coords = coords;
    this.props = copySystemProps(spec || {}, options);
    this.projections = [];
    this.embeddings = [];
    this.offset = [0, 0, 0];
    this.origin = options.origin || [0, 0, 0];
    this.normalized = options.normalized !== false;
    this.aspect = options.aspect || "stretch";
    this.initial_bounds = initialBoundsFrom(coords);
    this.bounds = options.bounds ? rectFromArray(options.bounds) : null;
    this.basis = [1, 0, 0, 1];
    this.vertices = [];
    this.edges = [];
    this.faces = [];
    this.volumes = [];
    this.volume_policy = "filled";
    this.face_color = options.face_color || [1, 1, 1, 1];
    this.edge_color = options.edge_color || [1, 1, 1, 1];
    this.vertex_color = options.vertex_color || [1, 1, 1, 1];
    this.volume_color = options.volume_color || [1, 1, 1, 1];
    this.edge_style = options.edge_style;
    this.edge_unit_length = finiteOrDefault(options.edge_unit_length, 1);
    this.vertex_style = options.vertex_style;
    this.vertex_radius = finiteOrDefault(options.vertex_radius, 4);
    this.vertex_radius_values = (options.vertex_radius_values || []).slice();
    this.edge_radius = finiteOrDefault(
      options.edge_radius != null ? options.edge_radius : options.edge_scale,
      2
    );
    this.edge_width = this.edge_radius;
    this.edge_width_values = (options.edge_width_values || []).slice();
    this.vertex_pick_radius = Math.max(this.vertex_radius, finiteOrDefault(options.vertex_pick_radius, 5));
    this.edge_pick_radius = Math.max(this.edge_radius, finiteOrDefault(options.edge_pick_radius, 5));
    this.geometry_version = 0;
    this.geometry_offset = -1;
    if (runtime.geometryArena && typeof runtime.geometryArena.setVertex === "function") {
      var start = runtime.nextGeometryVertex;
      var count = this.coords.x.length;
      if (start + count > runtime.geometryArena.capacity()) {
        throw new RangeError("geometry arena does not have capacity for mesh vertices");
      }
      this.geometry_offset = start;
      runtime.nextGeometryVertex += count;
      for (var i = 0; i < count; i++) {
        this._write_geometry_vertex(i);
      }
    }
  }

  MeshRef.prototype._write_geometry_vertex = function (index) {
    if (this.geometry_offset < 0 || !this.runtime.geometryArena) {
      return;
    }
    this.runtime.geometryArena.setVertex(
      this.geometry_offset + index,
      numberOrZero(this.coords.x[index]),
      numberOrZero(this.coords.y[index]),
      numberOrZero(this.coords.z[index])
    );
  };

  MeshRef.prototype.add_vertices = function (indices) {
    this.vertices = copyIndexList(indices, 1, "add_vertices").map(function (tuple) {
      return tuple[0];
    });
    return this;
  };

  MeshRef.prototype.add_edges = function (indices) {
    this.edges = copyIndexList(indices, 2, "add_edges");
    return this;
  };

  MeshRef.prototype.add_faces = function (indices) {
    this.faces = copyIndexList(indices, null, "add_faces");
    return this;
  };

  MeshRef.prototype.add_volumes = function (indices) {
    this.volumes = copyIndexList(indices, null, "add_volumes");
    this.volume_policy = "filled";
    return this;
  };

  MeshRef.prototype.add_simplices = function (simplices) {
    simplices = simplices || {};
    if (simplices.vertices) {
      this.add_vertices(simplices.vertices);
    }
    if (simplices.edges) {
      this.add_edges(simplices.edges);
    }
    if (simplices.faces) {
      this.add_faces(simplices.faces);
    }
    if (simplices.volumes) {
      this.add_volumes(simplices.volumes);
    }
    if (!simplices.vertices) {
      this._derive_vertices_from_topology();
    }
    return this;
  };

  MeshRef.prototype._derive_vertices_from_topology = function () {
    var seen = Object.create(null);
    var out = [];
    function mark(index) {
      if (!seen[index]) {
        seen[index] = true;
        out.push(index);
      }
    }
    [this.edges, this.faces, this.volumes].forEach(function (cells) {
      cells.forEach(function (cell) {
        cell.forEach(mark);
      });
    });
    out.sort(function (a, b) { return a - b; });
    this.vertices = out;
  };

  MeshRef.prototype.add = function (spec, options) {
    return this.panel._add_mesh(spec, options, this);
  };

  MeshRef.prototype.prop = function (name) {
    return this.props[String(name)];
  };

  MeshRef.prototype.set_prop = function (name, value) {
    this.props[String(name)] = value;
    return this;
  };

  MeshRef.prototype.add_projection = function (projection) {
    this.projections.push(copyProjectionMap(projection || {}));
    return this;
  };

  MeshRef.prototype.add_embedding = function (embedding) {
    validateEmbeddingMap(embedding || {});
    this.embeddings.push(copyProjectionMap(embedding || {}));
    return this;
  };

  MeshRef.prototype.local_bounds = function () {
    if (this.normalized) {
      return { x: -1, y: -1, w: 2, h: 2 };
    }
    return {
      x: this.initial_bounds.x,
      y: this.initial_bounds.y,
      w: this.initial_bounds.w,
      h: this.initial_bounds.h
    };
  };

  MeshRef.prototype._base_rect = function () {
    if (this.bounds) {
      return this.bounds;
    }
    if (this.normalized) {
      return { x: -1, y: -1, w: 2, h: 2 };
    }
    return this.local_bounds();
  };

  MeshRef.prototype._base_point = function (inner) {
    var t = this._base_transform();
    return [
      t.cx + numberOrZero(inner[0]) * t.sx,
      t.cy + numberOrZero(inner[1]) * t.sy,
      numberOrZero(inner[2])
    ];
  };

  MeshRef.prototype._base_transform = function () {
    if (!this.normalized) {
      return { cx: 0, cy: 0, sx: 1, sy: 1 };
    }
    var r = this._base_rect();
    var sx = r.w / 2;
    var sy = r.h / 2;
    if (this.aspect === "equal") {
      var s = Math.max(Math.abs(sx), Math.abs(sy));
      sx = sx < 0 ? -s : s;
      sy = sy < 0 ? -s : s;
    }
    return {
      cx: r.x + r.w / 2,
      cy: r.y + r.h / 2,
      sx: sx,
      sy: this.parent ? sy : -sy
    };
  };

  MeshRef.prototype._inner_from_base_point = function (point) {
    if (!this.normalized) {
      return [
        numberOrZero(point[0]),
        numberOrZero(point[1]),
        numberOrZero(point[2])
      ];
    }
    var r = this._base_rect();
    var sx = r.w / 2;
    var sy = r.h / 2;
    if (this.aspect === "equal") {
      var s = Math.max(Math.abs(sx), Math.abs(sy));
      sx = sx < 0 ? -s : s;
      sy = sy < 0 ? -s : s;
    }
    if (Math.abs(sx) < 1e-9 || Math.abs(sy) < 1e-9) {
      return [0, 0, numberOrZero(point[2])];
    }
    return [
      (numberOrZero(point[0]) - (r.x + r.w / 2)) / sx,
      this.parent
        ? (numberOrZero(point[1]) - (r.y + r.h / 2)) / sy
        : ((r.y + r.h / 2) - numberOrZero(point[1])) / sy,
      numberOrZero(point[2])
    ];
  };

  MeshRef.prototype.world_point = function (index) {
    return this.world_inner_point([
      numberOrZero(this.coords.x[index]),
      numberOrZero(this.coords.y[index]),
      numberOrZero(this.coords.z[index])
    ]);
  };

  MeshRef.prototype.world_inner_point = function (inner) {
    var base = this._base_point(inner);
    var originBase = this._base_point(this.origin);
    var lx = base[0] - originBase[0];
    var ly = base[1] - originBase[1];
    var local = [
      originBase[0] + this.offset[0] + this.basis[0] * lx + this.basis[2] * ly,
      originBase[1] + this.offset[1] + this.basis[1] * lx + this.basis[3] * ly,
      base[2] + this.offset[2]
    ];
    return this.parent && typeof this.parent.world_inner_point === "function"
      ? this.parent.world_inner_point(local)
      : local;
  };

  MeshRef.prototype._parent_point_from_world = function (point) {
    return this.parent && typeof this.parent.inner_from_world === "function"
      ? this.parent.inner_from_world(point)
      : point;
  };

  MeshRef.prototype._parent_point_from_inner = function (inner) {
    var base = this._base_point(inner);
    var originBase = this._base_point(this.origin);
    var lx = base[0] - originBase[0];
    var ly = base[1] - originBase[1];
    return [
      originBase[0] + this.offset[0] + this.basis[0] * lx + this.basis[2] * ly,
      originBase[1] + this.offset[1] + this.basis[1] * lx + this.basis[3] * ly,
      base[2] + this.offset[2]
    ];
  };

  MeshRef.prototype.inner_from_world = function (point) {
    var parentPoint = this.parent && typeof this.parent.inner_from_world === "function"
      ? this.parent.inner_from_world(point)
      : point;
    return this._inner_from_parent_point(parentPoint);
  };

  MeshRef.prototype._inner_from_parent_point = function (parentPoint) {
    var originBase = this._base_point(this.origin);
    var x = numberOrZero(parentPoint[0]) - originBase[0] - this.offset[0];
    var y = numberOrZero(parentPoint[1]) - originBase[1] - this.offset[1];
    var det = this.basis[0] * this.basis[3] - this.basis[2] * this.basis[1];
    if (Math.abs(det) < 1e-9) {
      return [
        numberOrZero(this.origin[0]),
        numberOrZero(this.origin[1]),
        0
      ];
    }
    var lx = (this.basis[3] * x - this.basis[2] * y) / det;
    var ly = (-this.basis[1] * x + this.basis[0] * y) / det;
    return this._inner_from_base_point([
      lx + originBase[0],
      ly + originBase[1],
      0
    ]);
  };

  MeshRef.prototype.world_points = function () {
    var out = [];
    for (var i = 0; i < this.coords.x.length; i++) {
      out.push(this.world_point(i));
    }
    return out;
  };

  MeshRef.prototype.vertex_radius_at = function (index) {
    var value = this.vertex_radius_values[intOrDefault(index, -1)];
    return value != null ? value : this.vertex_radius;
  };

  MeshRef.prototype.edge_width_at = function (index) {
    var value = this.edge_width_values[intOrDefault(index, -1)];
    return value != null ? value : this.edge_width;
  };

  MeshRef.prototype.edge_radius_at = function (index) {
    return this.edge_width_at(index);
  };

  MeshRef.prototype.translate = function (args) {
    args = args || {};
    var trans = args.trans || [numberOrZero(args.dx), numberOrZero(args.dy), numberOrZero(args.dz)];
    var dx = numberOrZero(trans[0]);
    var dy = numberOrZero(trans[1]);
    this.offset[0] += dx;
    this.offset[1] += dy;
    this.offset[2] += numberOrZero(trans[2]);
    this._sync_transform();
    return this;
  };

  MeshRef.prototype.move_vertex = function (args) {
    args = args || {};
    var vertex = intOrDefault(args.vertex, -1);
    if (vertex < 0 || vertex >= this.coords.x.length) {
      return this;
    }
    var trans = args.local_trans || args.trans || [0, 0, 0];
    var current = this._parent_point_from_inner([
      numberOrZero(this.coords.x[vertex]),
      numberOrZero(this.coords.y[vertex]),
      numberOrZero(this.coords.z[vertex])
    ]);
    var target = args.local_cursor || [
      current[0] + numberOrZero(trans[0]),
      current[1] + numberOrZero(trans[1]),
      current[2] + numberOrZero(trans[2])
    ];
    var inner = this._inner_from_parent_point(target);
    this.coords.x[vertex] = inner[0];
    this.coords.y[vertex] = inner[1];
    this.coords.z[vertex] = inner[2];
    this.geometry_version++;
    this._write_geometry_vertex(vertex);
    return this;
  };

  MeshRef.prototype.translate_edge = function (args) {
    args = args || {};
    var edge = intOrDefault(args.edge, -1);
    if (edge < 0 || edge >= this.edges.length) {
      return this;
    }
    var pair = this.edges[edge];
    var trans = args.local_trans || args.trans || [0, 0, 0];
    for (var i = 0; i < pair.length; i++) {
      var vertex = pair[i];
      var current = this._parent_point_from_inner([
        numberOrZero(this.coords.x[vertex]),
        numberOrZero(this.coords.y[vertex]),
        numberOrZero(this.coords.z[vertex])
      ]);
      var inner = this._inner_from_parent_point([
        current[0] + numberOrZero(trans[0]),
        current[1] + numberOrZero(trans[1]),
        current[2] + numberOrZero(trans[2])
      ]);
      this.coords.x[vertex] = inner[0];
      this.coords.y[vertex] = inner[1];
      this.coords.z[vertex] = inner[2];
      this._write_geometry_vertex(vertex);
    }
    this.geometry_version++;
    return this;
  };

  MeshRef.prototype._local_matrix2d = function () {
    var t = this._base_transform();
    var originBase = this._base_point(this.origin);
    var cx = t.cx - originBase[0];
    var cy = t.cy - originBase[1];
    return {
      a: this.basis[0] * t.sx,
      b: this.basis[1] * t.sx,
      c: this.basis[2] * t.sy,
      d: this.basis[3] * t.sy,
      tx: originBase[0] + this.offset[0] + this.basis[0] * cx + this.basis[2] * cy,
      ty: originBase[1] + this.offset[1] + this.basis[1] * cx + this.basis[3] * cy,
      tz: this.offset[2]
    };
  };

  MeshRef.prototype._world_matrix2d = function () {
    var local = this._local_matrix2d();
    if (!this.parent || typeof this.parent._world_matrix2d !== "function") {
      return local;
    }
    var parent = this.parent._world_matrix2d();
    return {
      a: parent.a * local.a + parent.c * local.b,
      b: parent.b * local.a + parent.d * local.b,
      c: parent.a * local.c + parent.c * local.d,
      d: parent.b * local.c + parent.d * local.d,
      tx: parent.a * local.tx + parent.c * local.ty + parent.tx,
      ty: parent.b * local.tx + parent.d * local.ty + parent.ty,
      tz: parent.tz + local.tz
    };
  };

  MeshRef.prototype._sync_transform = function () {
    var m = this._world_matrix2d();
    this.runtime.arena.setMat4(this.slot, [
      m.a, m.b, 0, 0,
      m.c, m.d, 0, 0,
      0, 0, 1, 0,
      m.tx, m.ty, m.tz, 1
    ]);
    for (var i = 0; i < this.children.length; i++) {
      this.children[i]._sync_transform();
    }
  };

  MeshRef.prototype._translation_from_basis = function (basis) {
    var b00 = basis[0];
    var b10 = basis[1];
    var b01 = basis[2];
    var b11 = basis[3];
    var originBase = this._base_point(this.origin);
    return {
      x: this.offset[0] + originBase[0] - (b00 * originBase[0] + b01 * originBase[1]),
      y: this.offset[1] + originBase[1] - (b10 * originBase[0] + b11 * originBase[1])
    };
  };

  MeshRef.prototype._apply_linear_transform_around_point = function (m00, m01, m10, m11, origo) {
    origo = origo || [0, 0];
    var originBase = this._base_point(this.origin);
    var ox = numberOrZero(origo[0]);
    var oy = numberOrZero(origo[1]);
    var basis = [this.basis[0], this.basis[1], this.basis[2], this.basis[3]];
    var oldT = this._translation_from_basis(basis);
    var newT = [
      m00 * oldT.x + m01 * oldT.y + ox - (m00 * ox + m01 * oy),
      m10 * oldT.x + m11 * oldT.y + oy - (m10 * ox + m11 * oy)
    ];
    var oldA = basis[0];
    var oldB = basis[1];
    var oldC = basis[2];
    var oldD = basis[3];
    this.basis[0] = m00 * oldA + m01 * oldB;
    this.basis[1] = m10 * oldA + m11 * oldB;
    this.basis[2] = m00 * oldC + m01 * oldD;
    this.basis[3] = m10 * oldC + m11 * oldD;
    this.offset[0] = newT[0] - originBase[0] + (this.basis[0] * originBase[0] + this.basis[2] * originBase[1]);
    this.offset[1] = newT[1] - originBase[1] + (this.basis[1] * originBase[0] + this.basis[3] * originBase[1]);
  };

  MeshRef.prototype.rotate_scale_at_vertex = function (args) {
    args = args || {};
    var vertex = intOrDefault(args.vertex, -1);
    if (vertex < 0 || vertex >= this.coords.x.length) {
      return this;
    }
    var origo = args.origo || this.world_inner_point(this.origin);
    var hasAngle = args.angle != null;
    var hasScale = args.scale != null || args.value != null;
    if (!hasAngle && !hasScale) {
      return this;
    }
    var angle = finiteOrDefault(args.angle, 0);
    var scale = finiteOrDefault(args.scale, args.value != null ? args.value : 1);
    var cos = Math.cos(angle);
    var sin = Math.sin(angle);
    var s00 = scale * cos;
    var s01 = -scale * sin;
    var s10 = scale * sin;
    var s11 = scale * cos;
    this._apply_linear_transform_around_point(s00, s01, s10, s11, origo);
    this._sync_transform();
    return this;
  };

  MeshRef.prototype.scale_edge = function (args) {
    args = args || {};
    var edge = intOrDefault(args.edge, -1);
    if (edge < 0 || edge >= this.edges.length) {
      return this;
    }
    var origo = args.origo || this.world_inner_point(this.origin);
    var factor = finiteOrDefault(args.scale, args.value != null ? args.value : null);
    var angle = finiteOrDefault(args.angle, null);
    if (factor == null) {
      return this;
    }
    var pair = this.edges[edge];
    var a = this._parent_point_from_inner([
      numberOrZero(this.coords.x[pair[0]]),
      numberOrZero(this.coords.y[pair[0]]),
      numberOrZero(this.coords.z[pair[0]])
    ]);
    var b = this._parent_point_from_inner([
      numberOrZero(this.coords.x[pair[1]]),
      numberOrZero(this.coords.y[pair[1]]),
      numberOrZero(this.coords.z[pair[1]])
    ]);
    var ex = b[0] - a[0];
    var ey = b[1] - a[1];
    var angleSet = angle != null;
    if (angleSet) {
      var edgeAngle = numberOrZero(angle);
      ex = Math.cos(edgeAngle);
      ey = Math.sin(edgeAngle);
    }
    var len = Math.sqrt(ex * ex + ey * ey) || 1;
    var nx = -ey / len;
    var ny = ex / len;
    factor = finiteOrDefault(factor, 1);
    var minScale = 1e-6;
    if (Math.abs(factor) < minScale) {
      factor = factor < 0 ? -minScale : minScale;
    }
    var k = factor - 1;
    var s00 = 1 + k * nx * nx;
    var s01 = k * nx * ny;
    var s10 = k * ny * nx;
    var s11 = 1 + k * ny * ny;
    this._apply_linear_transform_around_point(s00, s01, s10, s11, origo);
    this._sync_transform();
    return this;
  };

  MeshRef.prototype.pick = function (point) {
    var i;
    for (i = this.vertices.length - 1; i >= 0; i--) {
      var vertexId = this.vertices[i];
      var p = this.world_point(vertexId);
      if (Math.sqrt(dist2(point[0], point[1], p[0], p[1])) <= this.vertex_pick_radius) {
        return { ref: this, hover: makeHover(this.id, vertexId, -1, -1) };
      }
    }
    for (i = this.edges.length - 1; i >= 0; i--) {
      var edge = this.edges[i];
      if (pointSegmentDistance(point, this.world_point(edge[0]), this.world_point(edge[1])) <= this.edge_pick_radius) {
        return { ref: this, hover: makeHover(this.id, -1, i, -1) };
      }
    }
    for (i = this.faces.length - 1; i >= 0; i--) {
      var face = this.faces[i].map(this.world_point.bind(this));
      if (pointInPolygon(point, face)) {
        return { ref: this, hover: makeHover(this.id, -1, -1, i) };
      }
    }
    return null;
  };

  MeshRef.prototype.visible_volume_surfaces = function () {
    return {
      policy: this.volume_policy,
      surfaces: "first_last_per_dimension"
    };
  };

  MeshRef.prototype.set_overlay = function (options) {
    options = options || {};
    if (options.vertex_radius != null || options.vertex_width != null) {
      this.vertex_radius = finiteOrDefault(
        options.vertex_radius != null ? options.vertex_radius : options.vertex_width,
        this.vertex_radius
      );
      this.vertex_pick_radius = Math.max(this.vertex_radius, this.vertex_pick_radius);
    }
    if (options.edge_radius != null || options.edge_width != null || options.edge_scale != null) {
      this.edge_radius = finiteOrDefault(
        options.edge_radius != null ? options.edge_radius :
          options.edge_width != null ? options.edge_width : options.edge_scale,
        this.edge_radius
      );
      this.edge_width = this.edge_radius;
      this.edge_pick_radius = Math.max(this.edge_radius, this.edge_pick_radius);
    }
    if (options.vertex_radius_vector != null) {
      this.vertex_radius_values = copyNumericVector(options.vertex_radius_vector, "vertex_radius_vector");
    }
    if (options.edge_width_vector != null) {
      this.edge_width_values = copyNumericVector(options.edge_width_vector, "edge_width_vector");
    }
    Object.keys(options).forEach(function (key) {
      var match = /^vertex_radius_(\d+)$/.exec(key);
      if (match) {
        setIndexedNumericValue(this.vertex_radius_values, Number(match[1]), options[key]);
      }
      match = /^edge_width_(\d+)$/.exec(key);
      if (match) {
        setIndexedNumericValue(this.edge_width_values, Number(match[1]), options[key]);
      }
    }, this);
    if (options.vertex_pick_radius != null) {
      this.vertex_pick_radius = Math.max(this.vertex_radius, finiteOrDefault(options.vertex_pick_radius, this.vertex_pick_radius));
    }
    if (options.edge_pick_radius != null) {
      this.edge_pick_radius = Math.max(this.edge_radius, finiteOrDefault(options.edge_pick_radius, this.edge_pick_radius));
    }
    if (options.face_color) {
      this.face_color = options.face_color;
    }
    if (options.edge_color) {
      this.edge_color = options.edge_color;
    }
    if (options.vertex_color) {
      this.vertex_color = options.vertex_color;
    }
    if (options.volume_color) {
      this.volume_color = options.volume_color;
    }
    if (options.edge_style != null) {
      this.edge_style = options.edge_style;
    }
    if (options.edge_unit_length != null) {
      this.edge_unit_length = finiteOrDefault(options.edge_unit_length, this.edge_unit_length);
    }
    if (options.vertex_style != null) {
      this.vertex_style = options.vertex_style;
    }
    return this;
  };

  function PanelRef(runtime, id, options) {
    this.runtime = runtime;
    this.id = id;
    this.options = options || {};
    this.rect = null;
    this.objects = Object.create(null);
  }

  PanelRef.prototype._add_rect = function (rectArray, options, parent) {
    var rect = rectFromArray(rectArray);
    var slot = this.runtime.nextSlot++;
    if (slot >= this.runtime.arena.capacity()) {
      throw new RangeError("transform arena does not have capacity for another object");
    }
    var ref = new RectRef(
      this.runtime,
      this,
      slot,
      slot,
      rect,
      options && (options.face_color || options.color),
      parent || null
    );
    if (parent) {
      parent.children.push(ref);
    }
    this.objects[ref.id] = ref;
    this.runtime.rects.push(ref);
    ref._sync_world();
    return ref;
  };

  PanelRef.prototype.add_rect = function (rectArray, options) {
    return this._add_rect(rectArray, options, null);
  };

  PanelRef.prototype.add = function (spec, options) {
    return this._add_mesh(spec, options, null);
  };

  PanelRef.prototype._add_mesh = function (spec, options, parent) {
    var slot = this.runtime.nextSlot++;
    if (slot >= this.runtime.arena.capacity()) {
      throw new RangeError("transform arena does not have capacity for another object");
    }
    var ref = new MeshRef(
      this.runtime,
      this,
      slot,
      slot,
      coordsFromSpec(spec),
      meshOptionsFrom(spec, options),
      parent || null,
      spec
    );
    if (parent) {
      parent.children.push(ref);
    }
    this.objects[ref.id] = ref;
    this.runtime.meshes.push(ref);
    ref._sync_transform();
    return ref;
  };

  PanelRef.prototype.get = function (hover) {
    if (!hover || hover.object_id == null || hover.object_id < 0) {
      return null;
    }
    return this.objects[hover.object_id] || null;
  };

  PanelRef.prototype.pick = function (point) {
    if (!point || point.length < 2) {
      return null;
    }
    var x = numberOrZero(point[0]);
    var y = numberOrZero(point[1]);
    for (var i = this.runtime.rects.length - 1; i >= 0; i--) {
      var ref = this.runtime.rects[i];
      if (ref.panel !== this) {
        continue;
      }
      var r = ref.world;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        return ref;
      }
    }
    for (var m = this.runtime.meshes.length - 1; m >= 0; m--) {
      var hit = this.runtime.meshes[m].pick([x, y]);
      if (hit) {
        return hit;
      }
    }
    return null;
  };

  function Display(runtime) {
    this.runtime = runtime;
    this.nextFrameId = 0;
    this.last_frame = null;
    this.width = runtime.width;
    this.height = runtime.height;
  }

  Display.prototype.set_size = function (size) {
    size = size || {};
    this.width = numberOrZero(size.width != null ? size.width : this.width);
    this.height = numberOrZero(size.height != null ? size.height : this.height);
    return this;
  };

  Display.prototype.frame = function (options) {
    var panel = new PanelRef(this.runtime, this.nextFrameId++, options || {});
    this.last_frame = panel;
    return panel;
  };

  Display.prototype.add_frame = function (panel, rectArray) {
    panel.rect = rectFromArray(rectArray);
    return panel;
  };

  function EventQueue(eventArena) {
    this.eventArena = eventArena;
  }

  EventQueue.prototype.get = function () {
    return eventFromSample(this.eventArena.latestSample());
  };

  function Cursor() {
    this.mode = "default";
  }

  Cursor.prototype.set_mode = function (mode) {
    this.mode = String(mode || "default");
    return this.mode;
  };

  function Keyboard() {
    this.modifiers = {
      ctrl: false,
      shift: false,
      alt: false,
      meta: false
    };
  }

  Keyboard.prototype.set_modifiers = function (mods) {
    mods = mods || {};
    this.modifiers.ctrl = !!mods.ctrl;
    this.modifiers.shift = !!mods.shift;
    this.modifiers.alt = !!mods.alt;
    this.modifiers.meta = !!mods.meta;
    return this.modifiers;
  };

  Keyboard.prototype.set_mask = function (mask) {
    mask = intOrDefault(mask, 0);
    return this.set_modifiers({
      ctrl: (mask & 1) !== 0,
      shift: (mask & 2) !== 0,
      alt: (mask & 4) !== 0,
      meta: (mask & 8) !== 0
    });
  };

  function createVkfUiRuntime(options) {
    var opts = options || {};
    if (!opts.arena || typeof opts.arena.setTranslate2D !== "function") {
      throw new TypeError("createVkfUiRuntime requires a transform arena");
    }
    if (!opts.eventArena || typeof opts.eventArena.latestSample !== "function") {
      throw new TypeError("createVkfUiRuntime requires an event arena");
    }
    var runtime = {
      arena: opts.arena,
      eventArena: opts.eventArena,
      geometryArena: opts.geometryArena || null,
      width: numberOrZero(opts.width),
      height: numberOrZero(opts.height),
      nextSlot: 0,
      nextGeometryVertex: 0,
      rects: [],
      meshes: []
    };
    runtime.ui = Object.freeze({
      MOUSE_MOVE: MOUSE_MOVE,
      MOUSE_DOWN: MOUSE_DOWN,
      MOUSE_UP: MOUSE_UP,
      MOUSE_DRAG: MOUSE_DRAG,
      HOVER_OBJECT: HOVER_OBJECT,
      HOVER_FACE: HOVER_FACE,
      HOVER_EDGE: HOVER_EDGE,
      HOVER_VERTEX: HOVER_VERTEX,
      display: new Display(runtime),
      events: new EventQueue(opts.eventArena),
      cursor: new Cursor(),
      keyboard: new Keyboard()
    });
    return runtime;
  }

  global.VfVkfUiRuntime = {
    MAT4_F32: MAT4_F32,
    HOVER_OBJECT: HOVER_OBJECT,
    HOVER_FACE: HOVER_FACE,
    HOVER_EDGE: HOVER_EDGE,
    HOVER_VERTEX: HOVER_VERTEX,
    createVkfUiRuntime: createVkfUiRuntime
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.VfVkfUiRuntime;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

