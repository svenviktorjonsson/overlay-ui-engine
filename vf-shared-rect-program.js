(function (global) {
  "use strict";

  var vkfSource = "# VKF-driven topology hierarchy transform interaction.\n# Geometry coordinates are normalized: lower-left (-1,-1), upper-right (1,1).\n\nui: .ui\nt: .time\nevents: ui.events\nd: ui.display\nmath: .math\n\npanel: d.frame(\n  title: \"VKF topology transforms\",\n  draggable: true,\n  closable: true,\n  resizable: true,\n  dockable: true,\n  dock_loc: \"bl\",\n  alpha: 0.96,\n  master: true\n)\n\nd.add_frame(panel, [0, 0, d.width, d.height])\n\nroot_a: panel.add(\n  x: [-1, 1, 1, -1],\n  y: [-1, -1, 1, 1],\n  face_color: [0.9, 0.24, 0.16, 0.46],\n  edge_color: [0.98, 0.72, 0.2, 1],\n  vertex_color: [1, 0.2, 0.72, 1],\n  bounds: [80, 70, 220, 200],\n  origin: [0, 0, 0],\n  vertex_radius: 4,\n  edge_radius: 2\n)\nroot_a.add_vertices([0, 1, 2, 3])\nroot_a.add_edges([[0, 1], [1, 2], [2, 3], [3, 0]])\nroot_a.add_faces([[0, 1, 2, 3]])\n\nroot_a_face_hidden: root_a.add(\n  x: [-0.58, 0.58, 0.5, -0.5],\n  y: [-0.52, -0.42, 0.48, 0.56],\n  face_color: [0.9, 0.24, 0.16, 0],\n  edge_color: [0.98, 0.72, 0.2, 1],\n  vertex_color: [1, 0.2, 0.72, 1],\n  origin: [0, 0, 0],\n  vertex_radius: 4,\n  edge_radius: 2\n)\nroot_a_face_hidden.add_vertices([0, 1, 2, 3])\nroot_a_face_hidden.add_edges([[0, 1], [1, 2], [2, 3], [3, 0]])\nroot_a_face_hidden.add_faces([[0, 1, 2, 3]])\n\nroot_a_face_hidden_edge_hidden: root_a_face_hidden.add(\n  x: [-0.72, -0.24, -0.3, -0.66],\n  y: [-0.56, -0.5, -0.12, -0.06],\n  face_color: [0.9, 0.24, 0.16, 0.46],\n  edge_color: [0.98, 0.72, 0.2, 0],\n  vertex_color: [1, 0.2, 0.72, 1],\n  origin: [-0.48, -0.31, 0],\n  vertex_radius: 4,\n  edge_radius: 2\n)\nroot_a_face_hidden_edge_hidden.add_vertices([0, 1, 2, 3])\nroot_a_face_hidden_edge_hidden.add_edges([[0, 1], [1, 2], [2, 3], [3, 0]])\nroot_a_face_hidden_edge_hidden.add_faces([[0, 1, 2, 3]])\n\nroot_a_face_hidden_vertex_hidden: root_a_face_hidden.add(\n  x: [0.16, 0.66, 0.6, 0.22],\n  y: [0.04, 0.1, 0.48, 0.54],\n  face_color: [0.9, 0.24, 0.16, 0.46],\n  edge_color: [0.98, 0.72, 0.2, 1],\n  vertex_color: [1, 0.2, 0.72, 0],\n  origin: [0.41, 0.29, 0],\n  vertex_radius: 4,\n  edge_radius: 2\n)\nroot_a_face_hidden_vertex_hidden.add_vertices([0, 1, 2, 3])\nroot_a_face_hidden_vertex_hidden.add_edges([[0, 1], [1, 2], [2, 3], [3, 0]])\nroot_a_face_hidden_vertex_hidden.add_faces([[0, 1, 2, 3]])\n\nroot_b: panel.add(\n  x: [-1, 1, 1, -1],\n  y: [-1, -1, 1, 1],\n  face_color: [0.16, 0.74, 0.34, 0.46],\n  edge_color: [0.2, 1, 0.7, 1],\n  vertex_color: [1, 0.25, 0.78, 1],\n  bounds: [380, 70, 220, 200],\n  origin: [0, 0, 0],\n  vertex_radius: 4,\n  edge_radius: 2\n)\nroot_b.add_vertices([0, 1, 2, 3])\nroot_b.add_edges([[0, 1], [1, 2], [2, 3], [3, 0]])\nroot_b.add_faces([[0, 1, 2, 3]])\n\nroot_b_edge_hidden: root_b.add(\n  x: [-0.58, 0.58, 0.5, -0.5],\n  y: [-0.52, -0.42, 0.48, 0.56],\n  face_color: [0.16, 0.74, 0.34, 0.46],\n  edge_color: [0.2, 1, 0.7, 0],\n  vertex_color: [1, 0.25, 0.78, 1],\n  origin: [0, 0, 0],\n  vertex_radius: 4,\n  edge_radius: 2\n)\nroot_b_edge_hidden.add_vertices([0, 1, 2, 3])\nroot_b_edge_hidden.add_edges([[0, 1], [1, 2], [2, 3], [3, 0]])\nroot_b_edge_hidden.add_faces([[0, 1, 2, 3]])\n\nroot_b_edge_hidden_face_hidden: root_b_edge_hidden.add(\n  x: [-0.72, -0.24, -0.3, -0.66],\n  y: [-0.56, -0.5, -0.12, -0.06],\n  face_color: [0.16, 0.74, 0.34, 0],\n  edge_color: [0.2, 1, 0.7, 1],\n  vertex_color: [1, 0.25, 0.78, 1],\n  origin: [-0.48, -0.31, 0],\n  vertex_radius: 4,\n  edge_radius: 2\n)\nroot_b_edge_hidden_face_hidden.add_vertices([0, 1, 2, 3])\nroot_b_edge_hidden_face_hidden.add_edges([[0, 1], [1, 2], [2, 3], [3, 0]])\nroot_b_edge_hidden_face_hidden.add_faces([[0, 1, 2, 3]])\n\nroot_b_edge_hidden_vertex_hidden: root_b_edge_hidden.add(\n  x: [0.16, 0.66, 0.6, 0.22],\n  y: [0.04, 0.1, 0.48, 0.54],\n  face_color: [0.16, 0.74, 0.34, 0.46],\n  edge_color: [0.2, 1, 0.7, 1],\n  vertex_color: [1, 0.25, 0.78, 0],\n  origin: [0.41, 0.29, 0],\n  vertex_radius: 4,\n  edge_radius: 2\n)\nroot_b_edge_hidden_vertex_hidden.add_vertices([0, 1, 2, 3])\nroot_b_edge_hidden_vertex_hidden.add_edges([[0, 1], [1, 2], [2, 3], [3, 0]])\nroot_b_edge_hidden_vertex_hidden.add_faces([[0, 1, 2, 3]])\n\nroot_c: panel.add(\n  x: [-1, 1, 1, -1],\n  y: [-1, -1, 1, 1],\n  face_color: [0.22, 0.54, 0.96, 0.46],\n  edge_color: [0.12, 0.95, 0.95, 1],\n  vertex_color: [1, 0.82, 0.2, 1],\n  bounds: [680, 70, 220, 200],\n  origin: [0, 0, 0],\n  vertex_radius: 4,\n  edge_radius: 2\n)\nroot_c.add_vertices([0, 1, 2, 3])\nroot_c.add_edges([[0, 1], [1, 2], [2, 3], [3, 0]])\nroot_c.add_faces([[0, 1, 2, 3]])\n\nroot_c_vertex_hidden: root_c.add(\n  x: [-0.58, 0.58, 0.5, -0.5],\n  y: [-0.52, -0.42, 0.48, 0.56],\n  face_color: [0.22, 0.54, 0.96, 0.46],\n  edge_color: [0.12, 0.95, 0.95, 1],\n  vertex_color: [1, 0.82, 0.2, 0],\n  origin: [0, 0, 0],\n  vertex_radius: 4,\n  edge_radius: 2\n)\nroot_c_vertex_hidden.add_vertices([0, 1, 2, 3])\nroot_c_vertex_hidden.add_edges([[0, 1], [1, 2], [2, 3], [3, 0]])\nroot_c_vertex_hidden.add_faces([[0, 1, 2, 3]])\n\nroot_c_vertex_hidden_face_hidden: root_c_vertex_hidden.add(\n  x: [-0.72, -0.24, -0.3, -0.66],\n  y: [-0.56, -0.5, -0.12, -0.06],\n  face_color: [0.22, 0.54, 0.96, 0],\n  edge_color: [0.12, 0.95, 0.95, 1],\n  vertex_color: [1, 0.82, 0.2, 1],\n  origin: [-0.48, -0.31, 0],\n  vertex_radius: 4,\n  edge_radius: 2\n)\nroot_c_vertex_hidden_face_hidden.add_vertices([0, 1, 2, 3])\nroot_c_vertex_hidden_face_hidden.add_edges([[0, 1], [1, 2], [2, 3], [3, 0]])\nroot_c_vertex_hidden_face_hidden.add_faces([[0, 1, 2, 3]])\n\nroot_c_vertex_hidden_edge_hidden: root_c_vertex_hidden.add(\n  x: [0.16, 0.66, 0.6, 0.22],\n  y: [0.04, 0.1, 0.48, 0.54],\n  face_color: [0.22, 0.54, 0.96, 0.46],\n  edge_color: [0.12, 0.95, 0.95, 0],\n  vertex_color: [1, 0.82, 0.2, 1],\n  origin: [0.41, 0.29, 0],\n  vertex_radius: 4,\n  edge_radius: 2\n)\nroot_c_vertex_hidden_edge_hidden.add_vertices([0, 1, 2, 3])\nroot_c_vertex_hidden_edge_hidden.add_edges([[0, 1], [1, 2], [2, 3], [3, 0]])\nroot_c_vertex_hidden_edge_hidden.add_faces([[0, 1, 2, 3]])\n\ndrag_active: false\ndrag_hover: (object_id: -1, kind: -1, face_id: -1, edge_id: -1, vertex_id: -1, frame_id: -1)\ndrag_hover_valid: false\ndrag_origo: [0, 0]\ndrag_start_vertex_angle: 0\ndrag_start_vertex_radius: 1\ndrag_start_edge_normal: [0, 0]\ndrag_start_edge_ref: 1\n\nset_drag_from_hover(target_hover, e):\n  drag_hover: target_hover\n  drag_hover_valid: false\n  target: panel.get(target_hover)\n  target?\n    target_hover.kind?>\n      ui.HOVER_VERTEX =>\n        drag_hover: target_hover\n        drag_hover_valid: true\n        drag_active: true\n        drag_origo: target.world_inner_point(target.origin)\n        drag_vertex: target.world_point(target_hover.vertex_id)\n        drag_start_vertex_angle: math.atan2(drag_vertex.1 - drag_origo.1, drag_vertex.0 - drag_origo.0)\n        drag_start_vertex_radius: math.sqrt((drag_vertex.0 - drag_origo.0)^2 + (drag_vertex.1 - drag_origo.1)^2)\n      ui.HOVER_EDGE =>\n        drag_hover: target_hover\n        drag_hover_valid: true\n        drag_active: true\n        edge_indices: target.edges[target_hover.edge_id]\n        edge_a: target._parent_point_from_inner([target.x[edge_indices.0], target.y[edge_indices.0], target.z[edge_indices.0]])\n        edge_b: target._parent_point_from_inner([target.x[edge_indices.1], target.y[edge_indices.1], target.z[edge_indices.1]])\n        edge_ex: edge_b.0 - edge_a.0\n        edge_ey: edge_b.1 - edge_a.1\n        edge_len: math.sqrt(edge_ex^2 + edge_ey^2)\n        drag_origo: target.world_inner_point(target.origin)\n        drag_start_edge_normal: [-edge_ey / edge_len, edge_ex / edge_len]\n        edge_ref: (e.local_cursor.0 - drag_origo.0) * drag_start_edge_normal.0 + (e.local_cursor.1 - drag_origo.1) * drag_start_edge_normal.1\n        drag_start_edge_ref: edge_ref\n      ui.HOVER_FACE =>\n        drag_hover: target_hover\n        drag_hover_valid: true\n        drag_active: true\n      @|\n  @|\n\ndrag_target(target_hover, e, mods):\n  target: panel.get(target_hover)\n  target?\n    mods.ctrl?\n      target_hover.kind?>\n        ui.HOVER_VERTEX =>\n          target.move_vertex(vertex: target_hover.vertex_id, local_cursor: e.local_cursor, local_trans: e.local_trans)\n        ui.HOVER_EDGE =>\n          target.translate_edge(edge: target_hover.edge_id, local_trans: e.local_trans)\n      @|\n    target_hover.kind?>\n      ui.HOVER_VERTEX =>\n        target_vec: [e.local_cursor.0 - drag_origo.0, e.local_cursor.1 - drag_origo.1]\n        target_angle: math.atan2(target_vec.1, target_vec.0)\n        target_radius: math.sqrt(target_vec.0^2 + target_vec.1^2)\n        target.rotate_scale_at_vertex(\n          vertex: target_hover.vertex_id,\n          origo: drag_origo,\n          angle: target_angle - drag_start_vertex_angle,\n          scale: target_radius / drag_start_vertex_radius\n        )\n      ui.HOVER_EDGE =>\n        edge_scale: ((e.local_cursor.0 - drag_origo.0) * drag_start_edge_normal.0 + (e.local_cursor.1 - drag_origo.1) * drag_start_edge_normal.1) / drag_start_edge_ref\n        target.scale_edge(edge: target_hover.edge_id, origo: drag_origo, scale: edge_scale)\n      ui.HOVER_FACE =>\n        target.translate(trans: e.local_trans)\n\ndrag(e):\n  mods: ui.keyboard.modifiers\n  drag_hover_valid?\n    drag_target(drag_hover, e, mods)\n\n:: \"vkf topology ready\"\n\n(e: events.get())??>\n  ui.MOUSE_DOWN =>\n    ui.cursor.set_mode(\"closed_hand\")\n    drag_active: false\n    set_drag_from_hover(e.hover, e)\n  ui.MOUSE_MOVE =>\n    ui.cursor.set_mode(\"open_hand\")\n  ui.MOUSE_DRAG =>\n    drag(e)\n  ui.MOUSE_UP =>\n    drag_active: false\n    ui.cursor.set_mode(\"open_hand\")\n  t.sleep(0.016)\n";

  var roots = [{"name":"root_a","hidden":"face","bounds":[80,70,220,200],"face_color":[0.9,0.24,0.16,0.46],"edge_color":[0.98,0.72,0.2,1],"vertex_color":[1,0.2,0.72,1]},{"name":"root_b","hidden":"edge","bounds":[380,70,220,200],"face_color":[0.16,0.74,0.34,0.46],"edge_color":[0.2,1,0.7,1],"vertex_color":[1,0.25,0.78,1]},{"name":"root_c","hidden":"vertex","bounds":[680,70,220,200],"face_color":[0.22,0.54,0.96,0.46],"edge_color":[0.12,0.95,0.95,1],"vertex_color":[1,0.82,0.2,1]}];

  function colors(root, hidden) {
    var face = root.face_color.slice();
    var edge = root.edge_color.slice();
    var vertex = root.vertex_color.slice();
    if (hidden === "face") { face[3] = 0; }
    if (hidden === "edge") { edge[3] = 0; }
    if (hidden === "vertex") { vertex[3] = 0; }
    return { face_color: face, edge_color: edge, vertex_color: vertex };
  }

  function shape(level, side) {
    if (level === 0) { return { x: [-1, 1, 1, -1], y: [-1, -1, 1, 1], origin: [0, 0, 0] }; }
    if (level === 1) { return { x: [-0.58, 0.58, 0.50, -0.50], y: [-0.52, -0.42, 0.48, 0.56], origin: [0, 0, 0] }; }
    if (side === "left") { return { x: [-0.72, -0.24, -0.30, -0.66], y: [-0.56, -0.50, -0.12, -0.06], origin: [-0.48, -0.31, 0] }; }
    return { x: [0.16, 0.66, 0.60, 0.22], y: [0.04, 0.10, 0.48, 0.54], origin: [0.41, 0.29, 0] };
  }

  function addQuad(parent, root, spec, hidden, isRoot) {
    var c = colors(root, hidden);
    var mesh = parent.add({
      x: spec.x,
      y: spec.y,
      face_color: c.face_color,
      edge_color: c.edge_color,
      vertex_color: c.vertex_color,
      volume_color: c.face_color,
      bounds: isRoot ? root.bounds : undefined,
      origin: spec.origin,
      vertex_radius: 4,
      edge_radius: 2
    });
    mesh.add_vertices([0, 1, 2, 3]);
    mesh.add_edges([[0, 1], [1, 2], [2, 3], [3, 0]]);
    mesh.add_faces([[0, 1, 2, 3]]);
    return mesh;
  }

  function createVkfSharedRectProgram() {
    var panel = null;
    var activeTargets = [];
    var selectionState = Object.create(null);
    var dragStateByKey = Object.create(null);
    var currentDragContext = null;
    var wasPointerDown = false;
    function hoverKey(hover) {
      if (!hover || hover.object_id == null || hover.object_id < 0) {
        return null;
      }
      return [
        hover.frame_id != null ? hover.frame_id : -1,
        hover.object_id,
        hover.kind != null ? hover.kind : 0,
        hover.face_id != null ? hover.face_id : -1,
        hover.edge_id != null ? hover.edge_id : -1,
        hover.vertex_id != null ? hover.vertex_id : -1
      ].join(":");
    }

    function normalizeTarget(hover) {
      if (!hover || hover.object_id == null || hover.object_id < 0) {
        return null;
      }
      return {
        frame_id: hover.frame_id != null ? hover.frame_id : -1,
        object_id: hover.object_id,
        kind: hover.kind != null ? hover.kind : 0,
        face_id: hover.face_id != null ? hover.face_id : -1,
        edge_id: hover.edge_id != null ? hover.edge_id : -1,
        vertex_id: hover.vertex_id != null ? hover.vertex_id : -1
      };
    }

    function selectForPress(hover, modifiers) {
      var normalized = normalizeTarget(hover);
      if (!normalized) {
        selectionState = Object.create(null);
        dragStateByKey = Object.create(null);
        return [];
      }
      var key = hoverKey(normalized);
      modifiers = modifiers || {};
      if (modifiers.ctrl) {
        if (selectionState[key]) {
          delete selectionState[key];
        } else {
          selectionState[key] = normalized;
        }
      } else if (modifiers.shift) {
        selectionState[key] = normalized;
      } else {
        selectionState = Object.create(null);
        selectionState[key] = normalized;
      }
      return Object.keys(selectionState).map(function (entryKey) {
        return selectionState[entryKey];
      });
    }

    function dragStateFor(hover) {
      if (!hover) {
        return null;
      }
      return dragStateByKey[hoverKey(hover)] || null;
    }

    function setDragForHover(hover) {
      var selected = normalizeTarget(hover);
      if (!selected) {
        return;
      }
      var key = hoverKey(selected);
      var target = panel.get(selected);
      if (!target) {
        delete dragStateByKey[key];
        return;
      }
      var state = dragStateByKey[key];
      if (!state) {
        state = {
          origo: [0, 0],
          angle: 0,
          radius: 1,
          vertex_ready: false,
          edge_ready: false,
          edge_normal: [0, 0],
          edge_ref: 1
        };
        dragStateByKey[key] = state;
      }
      switch (selected.kind) {
        case apiHover("VERTEX"):
          state.vertex_ready = true;
          state.edge_ready = false;
          state.origo = target.world_inner_point(target.origin).slice(0, 2);
          var v = target.world_point(selected.vertex_id);
          var vx = v[0] - state.origo[0];
          var vy = v[1] - state.origo[1];
          state.angle = Math.atan2(vy, vx);
          state.radius = Math.max(1e-9, Math.sqrt(vx * vx + vy * vy));
          break;
        case apiHover("EDGE"):
          state.vertex_ready = false;
          state.edge_ready = true;
          if (!target.edges[selected.edge_id]) {
            state.edge_ready = false;
            break;
          }
          var edge = target.edges[selected.edge_id];
          var edgeA = target.world_point(edge[0]);
          var edgeB = target.world_point(edge[1]);
          var ex = edgeB[0] - edgeA[0];
          var ey = edgeB[1] - edgeA[1];
          var edgeLen = Math.sqrt(ex * ex + ey * ey) || 1;
          state.origo = target.world_inner_point(target.origin).slice(0, 2);
          state.edge_normal = [-ey / edgeLen, ex / edgeLen];
          if (!currentDragContext || !currentDragContext.local_cursor) {
            state.edge_ref = 1;
          } else {
            state.edge_ref = (currentDragContext.local_cursor[0] - state.origo[0]) * state.edge_normal[0] + (currentDragContext.local_cursor[1] - state.origo[1]) * state.edge_normal[1];
            if (!isFinite(state.edge_ref) || state.edge_ref === 0) {
              state.edge_ref = 1;
            }
          }
          break;
        default:
          state.vertex_ready = false;
          state.edge_ready = false;
      }
    }

  function dragTarget(selected, e, modifiers) {
      var target = panel.get(selected);
      if (!target) {
        return;
      }
      if (modifiers && modifiers.ctrl) {
        switch (selected.kind) {
          case apiHover("VERTEX"):
            target.move_vertex({ vertex: selected.vertex_id, local_cursor: e.local_cursor, local_trans: e.local_trans });
            break;
          case apiHover("EDGE"):
            target.translate_edge({ edge: selected.edge_id, local_trans: e.local_trans });
            break;
        }
        return;
      }
      switch (selected.kind) {
        case apiHover("VERTEX"):
          var state = dragStateFor(selected);
          if (!state || !state.vertex_ready) {
            return;
          }
          var vx = e.local_cursor[0] - state.origo[0];
          var vy = e.local_cursor[1] - state.origo[1];
          var targetRadius = Math.sqrt(vx * vx + vy * vy);
          var targetAngle = Math.atan2(vy, vx);
          target.rotate_scale_at_vertex({
            vertex: selected.vertex_id,
            origo: state.origo,
            angle: targetAngle - state.angle,
            scale: targetRadius / state.radius
          });
          break;
        case apiHover("EDGE"):
          var edgeState = dragStateFor(selected);
          if (!edgeState || !edgeState.edge_ready) {
            return;
          }
          var rel = [
            e.local_cursor[0] - edgeState.origo[0],
            e.local_cursor[1] - edgeState.origo[1]
          ];
          var edgeRef = rel[0] * edgeState.edge_normal[0] + rel[1] * edgeState.edge_normal[1];
          target.scale_edge({
            edge: selected.edge_id,
            origo: edgeState.origo,
            scale: edgeRef / edgeState.edge_ref
          });
          break;
        case apiHover("FACE"):
          target.translate({ trans: e.local_trans });
          break;
      }
    }

    var currentUi = null;

    function apiHover(kind) {
      return currentUi && currentUi["HOVER_" + kind];
    }

    return {
      source: vkfSource,
      init: function (api) {
        var ui = api.ui;
        currentUi = ui;
        panel = ui.display.frame({ title: "VKF topology transforms", draggable: true, closable: true, resizable: true, dockable: true, dock_loc: "bl", alpha: 0.96, master: true });
        ui.display.add_frame(panel, [0, 0, ui.display.width, ui.display.height]);
        for (var i = 0; i < roots.length; i++) {
          var root = roots[i];
          var rootMesh = addQuad(panel, root, shape(0), null, true);
          var child = addQuad(rootMesh, root, shape(1), root.hidden, false);
          var remaining = ["face", "edge", "vertex"].filter(function (kind) { return kind !== root.hidden; });
          addQuad(child, root, shape(2, "left"), remaining[0], false);
          addQuad(child, root, shape(2, "right"), remaining[1], false);
        }
      },
      update: function (input, api) {
        var ui = api.ui;
        currentUi = ui;
        var e = ui.events.get();
        currentDragContext = e;
        if (!input.pointerDown) {
          activeTargets = [];
          dragStateByKey = Object.create(null);
          wasPointerDown = false;
          return;
        }
        if (!panel.get(e.hover)) { return; }
        if (!wasPointerDown) {
          activeTargets = selectForPress(e.hover, ui.keyboard.modifiers);
          if (activeTargets.length <= 0) {
            activeTargets = [normalizeTarget(e.hover)];
          }
          for (var i = 0; i < activeTargets.length; i++) {
            setDragForHover(activeTargets[i]);
          }
          wasPointerDown = true;
        }
        for (var i = 0; i < activeTargets.length; i++) {
          dragTarget(activeTargets[i], e, ui.keyboard.modifiers);
        }
      }
    };
  }

  global.VfSharedRectProgram = { source: vkfSource, create: createVkfSharedRectProgram };
})(typeof globalThis !== "undefined" ? globalThis : this);

