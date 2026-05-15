/**
 * vf-geom-ledger.js — typed geometry state ledger.
 *
 * Small deep seam:
 * - mutations update typed state
 * - callers read versioned state
 * - render adapters build presentation from the ledger
 *
 * This is still JS-owned today, but it matches the final direction much better
 * than event handlers directly rebuilding scene payloads.
 */
(function (global) {
  "use strict";

  if (global.VfGeomLedger) { return; }

  function fail(msg) {
    throw new Error("[vf-geom-ledger] " + String(msg));
  }

  function kindCode(kind) {
    if (kind === "face") { return 1; }
    if (kind === "edge") { return 2; }
    if (kind === "vertex") { return 3; }
    return 0;
  }

  function kindName(code) {
    if (code === 1) { return "face"; }
    if (code === 2) { return "edge"; }
    if (code === 3) { return "vertex"; }
    return "none";
  }

  function cloneValue(value) {
    if (typeof global.structuredClone === "function") {
      return global.structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
  }

  function createStore(options) {
    options = options || {};
    if (!Object.prototype.hasOwnProperty.call(options, "state")) {
      fail("createStore requires options.state");
    }
    if (typeof options.buildSnapshot !== "function") {
      fail("createStore requires options.buildSnapshot(state)");
    }

    var state = cloneValue(options.state);
    var buildSnapshot = options.buildSnapshot;
    var revision = 0;
    var presentedRevision = -1;
    var snapshotRevision = -1;
    var cachedSnapshot = null;
    var listeners = [];

    function notify() {
      for (var i = 0; i < listeners.length; i += 1) {
        try {
          listeners[i](revision);
        } catch (_) {}
      }
    }

    function invalidate() {
      revision += 1;
      cachedSnapshot = null;
      snapshotRevision = -1;
      notify();
      return revision;
    }

    return {
      readState: function () {
        return state;
      },
      replaceState: function (nextState) {
        state = cloneValue(nextState);
        return invalidate();
      },
      mutate: function (mutator) {
        if (typeof mutator !== "function") {
          fail("store.mutate requires a function");
        }
        mutator(state);
        return invalidate();
      },
      touch: function () {
        return invalidate();
      },
      revision: function () {
        return revision;
      },
      presentedRevision: function () {
        return presentedRevision;
      },
      needsPresentation: function () {
        return revision !== presentedRevision;
      },
      snapshot: function () {
        if (snapshotRevision === revision && cachedSnapshot !== null) {
          return cachedSnapshot;
        }
        cachedSnapshot = buildSnapshot(state);
        snapshotRevision = revision;
        return cachedSnapshot;
      },
      markPresented: function () {
        presentedRevision = revision;
      },
      subscribe: function (listener) {
        if (typeof listener !== "function") {
          fail("store.subscribe requires a function");
        }
        listeners.push(listener);
        return function unsubscribe() {
          var idx = listeners.indexOf(listener);
          if (idx >= 0) {
            listeners.splice(idx, 1);
          }
        };
      }
    };
  }

  function createTransportStore(options) {
    options = options || {};
    var transport = options.transport;
    var buildSnapshot = options.buildSnapshot;
    if (!transport || typeof transport.readHeader !== "function") {
      fail("createTransportStore requires options.transport with readHeader()");
    }
    if (typeof transport.readStateView !== "function") {
      fail("createTransportStore requires transport.readStateView()");
    }
    if (typeof transport.readSnapshot !== "function" && typeof buildSnapshot !== "function") {
      fail("createTransportStore requires transport.readSnapshot() or options.buildSnapshot(stateView, header)");
    }
    if (typeof transport.ackPresented !== "function") {
      fail("createTransportStore requires transport.ackPresented(revision)");
    }

    var listeners = [];

    function notify(revision) {
      for (var i = 0; i < listeners.length; i += 1) {
        try {
          listeners[i](revision);
        } catch (_) {}
      }
    }

    function currentRevision() {
      var header = transport.readHeader();
      return Number(header && header.revision) || 0;
    }

    return {
      readState: function () {
        return transport.readStateView();
      },
      mutate: function (mutator) {
        if (typeof transport.mutate !== "function") {
          fail("transport-backed ledger does not support mutate()");
        }
        var nextRevision = transport.mutate(mutator);
        notify(Number(nextRevision) || currentRevision());
        return nextRevision;
      },
      touch: function () {
        if (typeof transport.touch !== "function") {
          fail("transport-backed ledger does not support touch()");
        }
        var nextRevision = transport.touch();
        notify(Number(nextRevision) || currentRevision());
        return nextRevision;
      },
      revision: function () {
        return currentRevision();
      },
      presentedRevision: function () {
        var header = transport.readHeader();
        return Number(header && header.presentedRevision);
      },
      needsPresentation: function () {
        return this.revision() !== this.presentedRevision();
      },
      snapshot: function () {
        if (typeof transport.readSnapshot === "function") {
          return transport.readSnapshot();
        }
        var header = transport.readHeader();
        return buildSnapshot(transport.readStateView(), header);
      },
      markPresented: function () {
        transport.ackPresented(this.revision());
      },
      subscribe: function (listener) {
        if (typeof listener !== "function") {
          fail("transportStore.subscribe requires a function");
        }
        listeners.push(listener);
        return function unsubscribe() {
          var idx = listeners.indexOf(listener);
          if (idx >= 0) {
            listeners.splice(idx, 1);
          }
        };
      }
    };
  }

  function createRafPresenter(store, present) {
    if (!store || typeof store.snapshot !== "function" || typeof store.subscribe !== "function") {
      fail("createRafPresenter requires a store created by createStore");
    }
    if (typeof present !== "function") {
      fail("createRafPresenter requires a present(snapshot, meta) function");
    }

    var disposed = false;
    var rafId = 0;

    function request() {
      if (disposed || rafId) { return; }
      rafId = global.requestAnimationFrame(function (ts) {
        rafId = 0;
        if (disposed || !store.needsPresentation()) { return; }
        var snapshot = store.snapshot();
        present(snapshot, {
          revision: store.revision(),
          presentedRevision: store.presentedRevision(),
          timestamp: ts
        });
        store.markPresented();
        if (store.needsPresentation()) {
          request();
        }
      });
    }

    var unsubscribe = store.subscribe(function () {
      request();
    });

    return {
      request: request,
      dispose: function () {
        disposed = true;
        if (rafId) {
          global.cancelAnimationFrame(rafId);
          rafId = 0;
        }
        unsubscribe();
      }
    };
  }

  function createFaceEdgeVertexController(options) {
    options = options || {};
    var rawPoints = Array.isArray(options.points) ? options.points : null;
    var rawEdges = Array.isArray(options.edgePairs) ? options.edgePairs : null;
    var dragConfig = options.dragConfig && typeof options.dragConfig === "object" ? options.dragConfig : null;
    if (!rawPoints || rawPoints.length !== 4) {
      fail("createFaceEdgeVertexController requires 4 points");
    }
    if (!rawEdges || rawEdges.length !== 4) {
      fail("createFaceEdgeVertexController requires 4 edge pairs");
    }

    function createInitialState() {
      return {
        points: rawPoints.map(function (p) { return [Number(p[0]) || 0, Number(p[1]) || 0]; }),
        edgePairs: rawEdges.map(function (p) { return [Number(p[0]) | 0, Number(p[1]) | 0]; }),
        selection: {
          faceSelected: false,
          edgeSelected: [false, false, false, false],
          vertexSelected: [false, false, false, false]
        },
        hover: { kind: "none", index: -1 },
        lastHit: { objectId: 0, simplexId: -1, kind: "none", index: -1 },
        drag: {
          active: false,
          kind: "none",
          index: -1,
          pointerId: null,
          vertices: [false, false, false, false]
        }
      };
    }

    function targetFromObjectId(objectId) {
      var oid = Number(objectId) || 0;
      if (!(oid > 0)) { return { kind: "none", index: -1 }; }
      if (oid === 1) { return { kind: "face", index: 0 }; }
      if (oid >= 2 && oid <= 5) { return { kind: "edge", index: oid - 2 }; }
      if (oid >= 6 && oid <= 9) { return { kind: "vertex", index: oid - 6 }; }
      return { kind: "none", index: -1 };
    }

    function clearSelection(state) {
      state.selection.faceSelected = false;
      state.selection.edgeSelected = [false, false, false, false];
      state.selection.vertexSelected = [false, false, false, false];
    }

    function hasShift(event) {
      return !!(event && (event.shiftKey || event.shift));
    }

    function hasCtrl(event) {
      return !!(event && (event.ctrlKey || event.ctrl));
    }

    function isSelected(state, kind, index) {
      if (kind === "face") { return !!state.selection.faceSelected; }
      if (kind === "edge") { return !!state.selection.edgeSelected[index]; }
      if (kind === "vertex") { return !!state.selection.vertexSelected[index]; }
      return false;
    }

    function setSelected(state, kind, index, on) {
      if (kind === "face") { state.selection.faceSelected = !!on; }
      if (kind === "edge" && index >= 0) { state.selection.edgeSelected[index] = !!on; }
      if (kind === "vertex" && index >= 0) { state.selection.vertexSelected[index] = !!on; }
    }

    function applySelection(state, target, event) {
      if (target.kind === "none") {
        clearSelection(state);
        return;
      }
      if (hasShift(event)) {
        setSelected(state, target.kind, target.index, true);
        return;
      }
      if (hasCtrl(event)) {
        setSelected(state, target.kind, target.index, !isSelected(state, target.kind, target.index));
        return;
      }
      if ((dragConfig == null || dragConfig.preserve_selected_on_plain_down !== false) && isSelected(state, target.kind, target.index)) {
        return;
      }
      clearSelection(state);
      setSelected(state, target.kind, target.index, true);
    }

    function edgeTouchesVertex(state, edgeIndex, vertexIndex) {
      var pair = state.edgePairs[edgeIndex];
      return pair[0] === vertexIndex || pair[1] === vertexIndex;
    }

    function anyTrue(values) {
      for (var i = 0; i < values.length; i += 1) {
        if (values[i]) { return true; }
      }
      return false;
    }

    function applyVertexList(mask, indices) {
      if (!Array.isArray(indices)) { return; }
      for (var i = 0; i < indices.length; i += 1) {
        var idx = Number(indices[i]);
        if (Number.isFinite(idx) && idx >= 0 && idx < 4) {
          mask[idx] = true;
        }
      }
    }

    function computeDragMask(state) {
      if (dragConfig) {
        var configMask = [false, false, false, false];
        if (state.selection.faceSelected) {
          applyVertexList(configMask, dragConfig.face_vertices);
        }
        for (var edgeSel = 0; edgeSel < 4; edgeSel += 1) {
          if (state.selection.edgeSelected[edgeSel]) {
            applyVertexList(configMask, dragConfig.edge_vertices && dragConfig.edge_vertices[edgeSel]);
          }
        }
        for (var vertexSel = 0; vertexSel < 4; vertexSel += 1) {
          if (state.selection.vertexSelected[vertexSel]) {
            applyVertexList(configMask, dragConfig.vertex_vertices && dragConfig.vertex_vertices[vertexSel]);
          }
        }
        return configMask;
      }
      if (state.selection.faceSelected) {
        return [true, true, true, true];
      }
      var mask = [false, false, false, false];
      for (var i = 0; i < 4; i += 1) {
        if (state.selection.vertexSelected[i]) {
          mask[i] = true;
        }
      }
      for (var edgeIndex = 0; edgeIndex < 4; edgeIndex += 1) {
        if (!state.selection.edgeSelected[edgeIndex]) { continue; }
        for (var vertexIndex = 0; vertexIndex < 4; vertexIndex += 1) {
          if (edgeTouchesVertex(state, edgeIndex, vertexIndex)) {
            mask[vertexIndex] = true;
          }
        }
      }
      return mask;
    }

    function translateSelected(state, dx, dy) {
      for (var i = 0; i < 4; i += 1) {
        if (!state.drag.vertices[i]) { continue; }
        state.points[i] = [state.points[i][0] + Number(dx || 0), state.points[i][1] + Number(dy || 0)];
      }
    }

    function resetDrag(state) {
      state.drag.active = false;
      state.drag.kind = "none";
      state.drag.index = -1;
      state.drag.pointerId = null;
      state.drag.vertices = [false, false, false, false];
    }

    function overlayAlpha(state, kind, index) {
      if (isSelected(state, kind, index)) { return 0.6; }
      if (state.hover.kind === kind && state.hover.index === index) { return 0.4; }
      return 0.0;
    }

    function buildDebugText(state) {
      function formatMask(values) {
        return values.map(function (value) { return value ? "1" : "0"; }).join(",");
      }
      return [
        "hover=" + state.hover.kind + ":" + state.hover.index,
        "lastHit=" + state.lastHit.objectId + ":" + state.lastHit.simplexId + " => " + state.lastHit.kind + ":" + state.lastHit.index,
        "faceSelected=" + String(state.selection.faceSelected),
        "edgeSelected=" + formatMask(state.selection.edgeSelected),
        "vertexSelected=" + formatMask(state.selection.vertexSelected),
        "drag.active=" + String(state.drag.active),
        "drag.kind=" + state.drag.kind + ":" + state.drag.index,
        "dragMask=" + formatMask(state.drag.vertices),
        "points=" + state.points.map(function (p) {
          return "(" + p[0].toFixed(3) + "," + p[1].toFixed(3) + ")";
        }).join(" ")
      ].join("\n");
    }

    function applyEvent(state, payload) {
      var target = targetFromObjectId(Number(payload && payload.object_id || 0));
      if (payload.event === "hover" || payload.event === "move") {
        var hoverChanged = state.hover.kind !== target.kind || Number(state.hover.index) !== Number(target.index);
        state.lastHit = {
          objectId: Number(payload.object_id || 0),
          simplexId: Number(payload.simplex_id || -1),
          kind: target.kind,
          index: target.index
        };
        state.hover = target;
        return { geometryDirty: hoverChanged };
      }
      state.lastHit = {
        objectId: Number(payload.object_id || 0),
        simplexId: Number(payload.simplex_id || -1),
        kind: target.kind,
        index: target.index
      };
      if (payload.event === "down") {
        var prevHoverKind = state.hover.kind;
        var prevHoverIndex = state.hover.index;
        var prevFaceSelected = !!state.selection.faceSelected;
        var prevEdgeSelected = state.selection.edgeSelected.slice();
        var prevVertexSelected = state.selection.vertexSelected.slice();
        state.hover = target;
        applySelection(state, target, payload);
        state.drag.vertices = computeDragMask(state);
        state.drag.active = target.kind !== "none" && anyTrue(state.drag.vertices) && !hasShift(payload) && !hasCtrl(payload);
        state.drag.kind = state.drag.active ? target.kind : "none";
        state.drag.index = state.drag.active ? target.index : -1;
        state.drag.pointerId = state.drag.active ? Number(payload.pointerId || 0) : null;
        var selectionChanged =
          prevFaceSelected !== !!state.selection.faceSelected ||
          prevHoverKind !== state.hover.kind ||
          Number(prevHoverIndex) !== Number(state.hover.index) ||
          prevEdgeSelected.join(",") !== state.selection.edgeSelected.join(",") ||
          prevVertexSelected.join(",") !== state.selection.vertexSelected.join(",");
        return { geometryDirty: selectionChanged };
      }
      if (payload.event === "up") {
        var wasDragging = !!state.drag.active;
        resetDrag(state);
        return { geometryDirty: wasDragging };
      }
      if (payload.event === "drag") {
        if (!state.drag.active || !anyTrue(state.drag.vertices)) {
          return { geometryDirty: false };
        }
        translateSelected(state, payload.dx_norm, payload.dy_norm);
        return { geometryDirty: true };
      }
      return { geometryDirty: false };
    }

    return {
      createInitialState: createInitialState,
      targetFromObjectId: targetFromObjectId,
      overlayAlpha: overlayAlpha,
      buildDebugText: buildDebugText,
      applyEvent: applyEvent
    };
  }

  function createFaceEdgeVertex(options) {
    options = options || {};
    var rawPoints = Array.isArray(options.points) ? options.points : null;
    var rawEdges = Array.isArray(options.edgePairs) ? options.edgePairs : null;
    if (!rawPoints || rawPoints.length !== 4) {
      fail("points must contain exactly 4 vertices");
    }
    if (!rawEdges || rawEdges.length !== 4) {
      fail("edgePairs must contain exactly 4 pairs");
    }

    var points = new Float32Array(8);
    for (var i = 0; i < 4; i++) {
      var p = rawPoints[i];
      points[i * 2] = Number(p[0]) || 0;
      points[i * 2 + 1] = Number(p[1]) || 0;
    }

    var edgePairs = new Int32Array(8);
    for (var e = 0; e < 4; e++) {
      var pair = rawEdges[e];
      edgePairs[e * 2] = Number(pair[0]) | 0;
      edgePairs[e * 2 + 1] = Number(pair[1]) | 0;
    }

    var selectionEdges = new Uint8Array(4);
    var selectionVertices = new Uint8Array(4);
    var dragVertices = new Uint8Array(4);

    var ledger = {
      version: 1,
      points: points,
      edgePairs: edgePairs,
      selectionFace: 0,
      selectionEdges: selectionEdges,
      selectionVertices: selectionVertices,
      hoverKind: 0,
      hoverIndex: -1,
      lastObjectId: 0,
      lastSimplexId: -1,
      lastKind: 0,
      lastIndex: -1,
      dragActive: 0,
      dragKind: 0,
      dragIndex: -1,
      dragPointerId: 0,
      dragVertices: dragVertices,

      bump: function () {
        this.version += 1;
      },

      point: function (index) {
        var i0 = index * 2;
        return [this.points[i0], this.points[i0 + 1]];
      },

      edgePair: function (index) {
        var i0 = index * 2;
        return [this.edgePairs[i0], this.edgePairs[i0 + 1]];
      },

      targetFromObjectId: function (objectId) {
        var oid = Number(objectId) || 0;
        if (!(oid > 0)) { return { kind: "none", index: -1 }; }
        if (oid === 1) { return { kind: "face", index: 0 }; }
        if (oid >= 2 && oid <= 5) { return { kind: "edge", index: oid - 2 }; }
        if (oid >= 6 && oid <= 9) { return { kind: "vertex", index: oid - 6 }; }
        return { kind: "none", index: -1 };
      },

      setLastHit: function (objectId, simplexId) {
        var target = this.targetFromObjectId(objectId);
        this.lastObjectId = Number(objectId) || 0;
        this.lastSimplexId = Number(simplexId);
        if (!Number.isFinite(this.lastSimplexId)) { this.lastSimplexId = -1; }
        this.lastKind = kindCode(target.kind);
        this.lastIndex = target.index;
      },

      setHover: function (kind, index) {
        var nextKind = kindCode(kind);
        var nextIndex = Number(index);
        if (!Number.isFinite(nextIndex)) { nextIndex = -1; }
        if (this.hoverKind === nextKind && this.hoverIndex === nextIndex) {
          return false;
        }
        this.hoverKind = nextKind;
        this.hoverIndex = nextIndex;
        this.bump();
        return true;
      },

      clearSelection: function () {
        var changed = !!this.selectionFace;
        this.selectionFace = 0;
        for (var i = 0; i < 4; i++) {
          if (this.selectionEdges[i] || this.selectionVertices[i]) { changed = true; }
          this.selectionEdges[i] = 0;
          this.selectionVertices[i] = 0;
        }
        if (changed) { this.bump(); }
      },

      isSelected: function (kind, index) {
        if (kind === "face") { return !!this.selectionFace; }
        if (kind === "edge") { return !!this.selectionEdges[index]; }
        if (kind === "vertex") { return !!this.selectionVertices[index]; }
        return false;
      },

      setSelected: function (kind, index, on) {
        var next = on ? 1 : 0;
        if (kind === "face") {
          if (this.selectionFace !== next) {
            this.selectionFace = next;
            this.bump();
          }
          return;
        }
        if (kind === "edge" && index >= 0 && index < 4) {
          if (this.selectionEdges[index] !== next) {
            this.selectionEdges[index] = next;
            this.bump();
          }
          return;
        }
        if (kind === "vertex" && index >= 0 && index < 4) {
          if (this.selectionVertices[index] !== next) {
            this.selectionVertices[index] = next;
            this.bump();
          }
        }
      },

      applySelection: function (target, mods) {
        mods = mods || {};
        if (!target || target.kind === "none") {
          this.clearSelection();
          return;
        }
        if (mods.shiftKey) {
          this.setSelected(target.kind, target.index, true);
          return;
        }
        if (mods.ctrlKey) {
          this.setSelected(target.kind, target.index, !this.isSelected(target.kind, target.index));
          return;
        }
        var hadSelection = this.selectionFace || this.selectionEdges[0] || this.selectionEdges[1] || this.selectionEdges[2] || this.selectionEdges[3] || this.selectionVertices[0] || this.selectionVertices[1] || this.selectionVertices[2] || this.selectionVertices[3];
        this.selectionFace = 0;
        this.selectionEdges.fill(0);
        this.selectionVertices.fill(0);
        if (hadSelection) { this.bump(); }
        this.setSelected(target.kind, target.index, true);
      },

      edgeTouchesVertex: function (edgeIndex, vertexIndex) {
        var i0 = edgeIndex * 2;
        return this.edgePairs[i0] === vertexIndex || this.edgePairs[i0 + 1] === vertexIndex;
      },

      computeDragMask: function () {
        var changed = false;
        var mask = this.dragVertices;
        for (var i = 0; i < 4; i++) {
          var next = 0;
          if (this.selectionFace) {
            next = 1;
          } else if (this.selectionVertices[i]) {
            next = 1;
          } else {
            for (var e = 0; e < 4; e++) {
              if (this.selectionEdges[e] && this.edgeTouchesVertex(e, i)) {
                next = 1;
                break;
              }
            }
          }
          if (mask[i] !== next) {
            mask[i] = next;
            changed = true;
          }
        }
        if (changed) { this.bump(); }
      },

      beginDrag: function (target, mods, pointerId) {
        mods = mods || {};
        this.computeDragMask();
        var active = !!target && target.kind !== "none" && !!(this.dragVertices[0] || this.dragVertices[1] || this.dragVertices[2] || this.dragVertices[3]) && !mods.shiftKey && !mods.ctrlKey;
        var nextKind = active ? kindCode(target.kind) : 0;
        var nextIndex = active ? target.index : -1;
        var nextPointer = active ? (Number(pointerId) || 0) : 0;
        if (this.dragActive !== (active ? 1 : 0) || this.dragKind !== nextKind || this.dragIndex !== nextIndex || this.dragPointerId !== nextPointer) {
          this.dragActive = active ? 1 : 0;
          this.dragKind = nextKind;
          this.dragIndex = nextIndex;
          this.dragPointerId = nextPointer;
          this.bump();
        }
      },

      endDrag: function () {
        var changed = !!this.dragActive || this.dragKind !== 0 || this.dragIndex !== -1 || this.dragPointerId !== 0 || this.dragVertices[0] || this.dragVertices[1] || this.dragVertices[2] || this.dragVertices[3];
        this.dragActive = 0;
        this.dragKind = 0;
        this.dragIndex = -1;
        this.dragPointerId = 0;
        this.dragVertices.fill(0);
        if (changed) { this.bump(); }
      },

      translateDrag: function (dx, dy) {
        if (!this.dragActive) { return false; }
        var mx = Number(dx) || 0;
        var my = Number(dy) || 0;
        if (!mx && !my) { return false; }
        for (var i = 0; i < 4; i++) {
          if (!this.dragVertices[i]) { continue; }
          var i0 = i * 2;
          this.points[i0] += mx;
          this.points[i0 + 1] += my;
        }
        this.bump();
        return true;
      },

      overlayAlpha: function (kind, index) {
        if (this.isSelected(kind, index)) { return 0.6; }
        if (kindCode(kind) === this.hoverKind && index === this.hoverIndex) { return 0.4; }
        return 0.0;
      },

      debugSnapshot: function () {
        var outPoints = [];
        for (var i = 0; i < 4; i++) {
          outPoints.push([this.points[i * 2], this.points[i * 2 + 1]]);
        }
        return {
          hoverKind: kindName(this.hoverKind),
          hoverIndex: this.hoverIndex,
          lastKind: kindName(this.lastKind),
          lastIndex: this.lastIndex,
          lastObjectId: this.lastObjectId,
          lastSimplexId: this.lastSimplexId,
          selectionFace: !!this.selectionFace,
          selectionEdges: Array.prototype.slice.call(this.selectionEdges),
          selectionVertices: Array.prototype.slice.call(this.selectionVertices),
          dragActive: !!this.dragActive,
          dragKind: kindName(this.dragKind),
          dragIndex: this.dragIndex,
          dragVertices: Array.prototype.slice.call(this.dragVertices),
          points: outPoints
        };
      }
    };

    return ledger;
  }

  function createFaceEdgeVertexSharedStore(options) {
    options = options || {};
    if (!global.VfGeomLedgerLayout) {
      fail("createFaceEdgeVertexSharedStore requires VfGeomLedgerLayout");
    }
    if (!global.VfGeomLedgerTransport || typeof global.VfGeomLedgerTransport.createSharedBufferTransport !== "function") {
      fail("createFaceEdgeVertexSharedStore requires shared-buffer transport support");
    }

    var headerBuffer = options.headerBuffer || null;
    var stateBuffer = options.stateBuffer || null;
    var ownsBuffers = !headerBuffer && !stateBuffer;
    if (ownsBuffers) {
      if (typeof SharedArrayBuffer !== "function") {
        fail("createFaceEdgeVertexSharedStore cannot allocate buffers without SharedArrayBuffer");
      }
      headerBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * global.VfGeomLedgerTransport.HEADER_SLOT_COUNT);
      stateBuffer = global.VfGeomLedgerLayout.createFaceEdgeVertexStateBuffer(true);
    } else if (!headerBuffer || !stateBuffer) {
      fail("createFaceEdgeVertexSharedStore requires both headerBuffer and stateBuffer when binding existing buffers");
    }

    var header = new Int32Array(headerBuffer);
    var bound = global.VfGeomLedgerLayout.bindFaceEdgeVertexState(stateBuffer);
    var controller = createFaceEdgeVertexController(options);
    var state = ownsBuffers
      ? controller.createInitialState()
      : bound.toPlainState(kindName);
    if (ownsBuffers) {
      bound.writeInitial(state.points, state.edgePairs);
      bound.writePlainState(state, kindCode);
      header[global.VfGeomLedgerTransport.HEADER_SLOT_REVISION] = 0;
      header[global.VfGeomLedgerTransport.HEADER_SLOT_PRESENTED_REVISION] = -1;
      header[global.VfGeomLedgerTransport.HEADER_SLOT_STATE_BYTE_LENGTH] = stateBuffer.byteLength;
      header[global.VfGeomLedgerTransport.HEADER_SLOT_STATE_FORMAT] = global.VfGeomLedgerLayout.FACE_EDGE_VERTEX_STATE_FORMAT;
      header[global.VfGeomLedgerTransport.HEADER_SLOT_FLAGS] = 0;
      header[global.VfGeomLedgerTransport.HEADER_SLOT_ERROR_CODE] = 0;
    }

    var transport = global.VfGeomLedgerTransport.createSharedBufferTransport({
      headerBuffer: headerBuffer,
      stateBuffer: stateBuffer,
    });
    var listeners = [];
    var snapshotRevision = -1;
    var cachedSnapshot = null;
    var localRevision = 0;
    var presentedLocalRevision = -1;

    function notify(meta) {
      for (var i = 0; i < listeners.length; i += 1) {
        try {
          listeners[i](meta || {});
        } catch (_) {}
      }
    }

    function currentRevision() {
      return transport.readHeader().revision;
    }

    function syncState(meta) {
      meta = meta || {};
      bound.writePlainState(state, kindCode);
      localRevision += 1;
      cachedSnapshot = null;
      snapshotRevision = -1;
      if (meta.geometryDirty !== false) {
        transport.writeRevision(currentRevision() + 1);
      }
    }

    return {
      transport: transport,
      readState: function () {
        return state;
      },
      mutate: function (mutator) {
        if (typeof mutator !== "function") {
          fail("shared face-edge-vertex store mutate requires a function");
        }
        var result = mutator(state);
        var meta = (result && typeof result === "object")
          ? { geometryDirty: result.geometryDirty !== false }
          : { geometryDirty: true };
        syncState(meta);
        notify({
          geometryDirty: meta.geometryDirty,
          revision: localRevision,
          geometryRevision: currentRevision()
        });
        return localRevision;
      },
      touch: function () {
        syncState({ geometryDirty: true });
        notify({
          geometryDirty: true,
          revision: localRevision,
          geometryRevision: currentRevision()
        });
        return localRevision;
      },
      revision: function () {
        return localRevision;
      },
      presentedRevision: function () {
        return presentedLocalRevision;
      },
      needsPresentation: function () {
        return localRevision !== presentedLocalRevision;
      },
      snapshot: function () {
        var headerNow = transport.readHeader();
        if (snapshotRevision === localRevision && cachedSnapshot !== null) {
          return cachedSnapshot;
        }
        var plain = bound.toPlainState(kindName);
        cachedSnapshot = (typeof options.buildSnapshot === "function")
          ? options.buildSnapshot(plain, headerNow, bound)
          : plain;
        snapshotRevision = localRevision;
        return cachedSnapshot;
      },
      markPresented: function () {
        presentedLocalRevision = localRevision;
        transport.ackPresented(currentRevision());
      },
      subscribe: function (listener) {
        if (typeof listener !== "function") {
          fail("shared face-edge-vertex store subscribe requires a function");
        }
        listeners.push(listener);
        return function unsubscribe() {
          var idx = listeners.indexOf(listener);
          if (idx >= 0) {
            listeners.splice(idx, 1);
          }
        };
      }
    };
  }

  function createParametricSurfaceGridSharedStore(options) {
    options = options || {};
    if (!global.VfGeomLedgerLayout) {
      fail("createParametricSurfaceGridSharedStore requires VfGeomLedgerLayout");
    }
    if (!global.VfGeomLedgerTransport || typeof global.VfGeomLedgerTransport.createSharedBufferTransport !== "function") {
      fail("createParametricSurfaceGridSharedStore requires shared-buffer transport support");
    }

    var uValuesInput = options.uValues;
    var vValuesInput = options.vValues;
    if (!uValuesInput || !vValuesInput) {
      fail("createParametricSurfaceGridSharedStore requires uValues and vValues");
    }
    var uCount = Number(uValuesInput.length) | 0;
    var vCount = Number(vValuesInput.length) | 0;
    if (uCount < 2 || vCount < 2) {
      fail("createParametricSurfaceGridSharedStore requires at least a 2x2 sampled grid");
    }
    if (typeof options.buildSnapshot !== "function") {
      fail("createParametricSurfaceGridSharedStore requires buildSnapshot(bound, header)");
    }

    var headerBuffer = options.headerBuffer || null;
    var stateBuffer = options.stateBuffer || null;
    var ownsBuffers = !headerBuffer && !stateBuffer;
    if (ownsBuffers) {
      var useShared = typeof SharedArrayBuffer === "function";
      headerBuffer = useShared
        ? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * global.VfGeomLedgerTransport.HEADER_SLOT_COUNT)
        : new ArrayBuffer(Int32Array.BYTES_PER_ELEMENT * global.VfGeomLedgerTransport.HEADER_SLOT_COUNT);
      stateBuffer = global.VfGeomLedgerLayout.createSurfaceHeightfieldStateBuffer(uCount, vCount, useShared);
    } else if (!headerBuffer || !stateBuffer) {
      fail("createParametricSurfaceGridSharedStore requires both headerBuffer and stateBuffer when binding existing buffers");
    }

    var header = new Int32Array(headerBuffer);
    var bound = global.VfGeomLedgerLayout.bindSurfaceHeightfieldState(stateBuffer, uCount, vCount);
    if (ownsBuffers) {
      bound.writeInitial(uValuesInput, vValuesInput);
      header[global.VfGeomLedgerTransport.HEADER_SLOT_REVISION] = 0;
      header[global.VfGeomLedgerTransport.HEADER_SLOT_PRESENTED_REVISION] = -1;
      header[global.VfGeomLedgerTransport.HEADER_SLOT_STATE_BYTE_LENGTH] = stateBuffer.byteLength;
      header[global.VfGeomLedgerTransport.HEADER_SLOT_STATE_FORMAT] = global.VfGeomLedgerLayout.SURFACE_HEIGHTFIELD_STATE_FORMAT;
      header[global.VfGeomLedgerTransport.HEADER_SLOT_FLAGS] = 0;
      header[global.VfGeomLedgerTransport.HEADER_SLOT_ERROR_CODE] = 0;
    }

    var transport = global.VfGeomLedgerTransport.createSharedBufferTransport({
      headerBuffer: headerBuffer,
      stateBuffer: stateBuffer,
    });
    var listeners = [];
    var localRevision = 0;
    var presentedLocalRevision = -1;
    var snapshotRevision = -1;
    var cachedSnapshot = null;

    function notify(meta) {
      for (var i = 0; i < listeners.length; i += 1) {
        try {
          listeners[i](meta || {});
        } catch (_) {}
      }
    }

    function currentGeometryRevision() {
      return transport.readHeader().revision;
    }

    function invalidate(meta) {
      localRevision += 1;
      cachedSnapshot = null;
      snapshotRevision = -1;
      transport.writeRevision(currentGeometryRevision() + 1);
      notify({
        geometryDirty: !(meta && meta.geometryDirty === false),
        revision: localRevision,
        geometryRevision: currentGeometryRevision()
      });
      return localRevision;
    }

    return {
      transport: transport,
      boundState: bound,
      readState: function () {
        return bound;
      },
      mutate: function (mutator) {
        if (typeof mutator !== "function") {
          fail("surface heightfield shared store mutate requires a function");
        }
        var result = mutator(bound);
        return invalidate(result && typeof result === "object" ? result : { geometryDirty: true });
      },
      touch: function () {
        return invalidate({ geometryDirty: true });
      },
      revision: function () {
        return localRevision;
      },
      presentedRevision: function () {
        return presentedLocalRevision;
      },
      needsPresentation: function () {
        return localRevision !== presentedLocalRevision;
      },
      snapshot: function () {
        if (snapshotRevision === localRevision && cachedSnapshot !== null) {
          return cachedSnapshot;
        }
        cachedSnapshot = options.buildSnapshot(bound, transport.readHeader());
        snapshotRevision = localRevision;
        return cachedSnapshot;
      },
      markPresented: function () {
        presentedLocalRevision = localRevision;
        transport.ackPresented(currentGeometryRevision());
      },
      subscribe: function (listener) {
        if (typeof listener !== "function") {
          fail("surface heightfield shared store subscribe requires a function");
        }
        listeners.push(listener);
        return function unsubscribe() {
          var idx = listeners.indexOf(listener);
          if (idx >= 0) {
            listeners.splice(idx, 1);
          }
        };
      }
    };
  }

  global.VfGeomLedger = {
    kindCode: kindCode,
    kindName: kindName,
    createStore: createStore,
    createTransportStore: createTransportStore,
    createRafPresenter: createRafPresenter,
    createFaceEdgeVertexController: createFaceEdgeVertexController,
    createFaceEdgeVertex: createFaceEdgeVertex,
    createFaceEdgeVertexSharedStore: createFaceEdgeVertexSharedStore,
    createParametricSurfaceGridSharedStore: createParametricSurfaceGridSharedStore,
    createSurfaceHeightfieldSharedStore: createParametricSurfaceGridSharedStore
  };
})(typeof window !== "undefined" ? window : this);
