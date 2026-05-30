/**
 * vf-geom-frame-adapter.js — deep seam for dynamic geom-frame scene ownership.
 *
 * One adapter per frame:
 * - owns provider invocation
 * - owns dirty/version state
 * - owns host-size invalidation
 * - materializes one unified scene for the renderer
 *
 * This keeps vf-display.js focused on host/renderer orchestration instead of
 * carrying ad hoc dynamic geom state fields on frame records.
 */
(function (global) {
  "use strict";

  var RUNTIME_ASSET_VERSION = String(global.__vfRuntimeAssetVersion || "");
  if (global.VfGeomFrameAdapter) {
    var existingVersion = String(global.VfGeomFrameAdapter.__vfRuntimeAssetVersion || "");
    if (existingVersion !== RUNTIME_ASSET_VERSION) {
      throw new Error(
        "[vf-geom-frame-adapter] stale module already loaded: existing version " +
        existingVersion + " requested version " + RUNTIME_ASSET_VERSION
      );
    }
    return;
  }

  function fail(msg) {
    throw new Error("[vf-geom-frame-adapter] " + String(msg));
  }

  function createAdapter(options) {
    options = options || {};
    var provider = options.provider;
    var buildScene = options.buildScene;
    if (typeof provider !== "function") {
      fail("createAdapter requires options.provider()");
    }
    if (typeof buildScene !== "function") {
      fail("createAdapter requires options.buildScene(geomSpec)");
    }

    var dirty = true;
    var scene = null;
    var hostSizeKey = "";
    var revision = 0;

    function invalidate() {
      dirty = true;
      revision += 1;
    }

    return {
      revision: function () {
        return revision;
      },
      isDirty: function () {
        return dirty;
      },
      hostSizeKey: function () {
        return hostSizeKey;
      },
      markDirty: function () {
        invalidate();
      },
      replaceProvider: function (nextProvider) {
        if (typeof nextProvider !== "function") {
          fail("replaceProvider requires a function");
        }
        provider = nextProvider;
        invalidate();
      },
      onHostResize: function (width, height) {
        var nextKey = String(Math.max(0, Number(width) || 0)) + "x" + String(Math.max(0, Number(height) || 0));
        if (nextKey === hostSizeKey) {
          return false;
        }
        hostSizeKey = nextKey;
        invalidate();
        return true;
      },
      currentScene: function () {
        if (!dirty && scene) {
          return scene;
        }
        var geomSpec = provider();
        if (!geomSpec || (!Array.isArray(geomSpec.meshes) && !Array.isArray(geomSpec.parts))) {
          fail("provider returned invalid geom spec");
        }
        var nextScene = buildScene(geomSpec, scene);
        if (!nextScene) {
          fail("buildScene did not produce a scene");
        }
        nextScene.__revision = revision;
        scene = nextScene;
        dirty = false;
        return scene;
      }
    };
  }

  function createLedgerAdapter(options) {
    options = options || {};
    var ledger = options.ledger;
    var selectGeomSpec = options.selectGeomSpec;
    if (!ledger || typeof ledger.snapshot !== "function") {
      fail("createLedgerAdapter requires options.ledger with snapshot()");
    }
    if (selectGeomSpec != null && typeof selectGeomSpec !== "function") {
      fail("createLedgerAdapter selectGeomSpec must be a function when provided");
    }

    var adapter = createAdapter({
      provider: function () {
        var snapshot = ledger.snapshot();
        if (typeof selectGeomSpec === "function") {
          return selectGeomSpec(snapshot);
        }
        return snapshot && snapshot.geomSpec;
      },
      buildScene: options.buildScene
    });

    var unsubscribe = null;
    if (typeof ledger.subscribe === "function") {
      unsubscribe = ledger.subscribe(function (meta) {
        if (meta && meta.geometryDirty === false) {
          return;
        }
        adapter.markDirty();
      });
    }

    return {
      revision: adapter.revision,
      isDirty: adapter.isDirty,
      hostSizeKey: adapter.hostSizeKey,
      markDirty: adapter.markDirty,
      onHostResize: adapter.onHostResize,
      currentScene: adapter.currentScene,
      dispose: function () {
        if (typeof unsubscribe === "function") {
          unsubscribe();
          unsubscribe = null;
        }
      }
    };
  }

  function createPointerDispatch() {
    function resetState(state) {
      state.seq = 0;
      state.inFlight = false;
      state.latestReq = null;
      state.lastPositiveHit = null;
      state.lastEmittedHitKey = "";
      state.emptySeq = 0;
      state.latestPointerReq = null;
      state.pointerRaf = 0;
    }

    function createState() {
      var state = {};
      resetState(state);
      return state;
    }

    function queueRequest(state, req) {
      state.seq += 1;
      req.seq = state.seq;
      if (req.evtType === "hover" || req.evtType === "move") {
        state.latestPointerReq = req;
      }
      state.latestReq = req;
      return req;
    }

    function beginLatest(state) {
      if (!state || state.inFlight || !state.latestReq) {
        return null;
      }
      var req = state.latestReq;
      state.latestReq = null;
      state.inFlight = true;
      return req;
    }

    function finish(state) {
      if (state) {
        state.inFlight = false;
      }
    }

    function resolve(state, req, hit) {
      if (!state) {
        return { action: "drop", hit: hit };
      }
      var isPointerStream = req.evtType === "hover" || req.evtType === "move";
      var isStale = req.seq !== state.seq;
      if (isStale && !isPointerStream) {
        return { action: "stale", hit: hit };
      }
      if (isStale && isPointerStream && !(Number(hit.object_id || 0) > 0)) {
        return { action: "stale", hit: hit };
      }
      var finalHit = hit;
      if (Number(hit.object_id || 0) > 0) {
        state.lastPositiveHit = Object.assign({}, hit);
        state.emptySeq = 0;
      } else if (req.evtType === "hover" || req.evtType === "move") {
        if (state.lastPositiveHit) {
          state.emptySeq += 1;
        }
      if (state.lastPositiveHit && state.emptySeq < 2) {
          return { action: "confirm-empty", hit: hit };
        }
        state.lastPositiveHit = null;
        state.emptySeq = 0;
        if (samePointerHit(state, req, hit)) {
          return { action: "drop", hit: hit };
        }
        rememberPointerHit(state, req, hit);
        return { action: "emit", hit: hit };
      }
      if (isPointerStream && samePointerHit(state, req, finalHit)) {
        return { action: "drop", hit: finalHit };
      }
      if (isPointerStream) {
        rememberPointerHit(state, req, finalHit);
      }
      return { action: "emit", hit: finalHit };
    }

    function pointerHitKey(req, hit) {
      return [
        String(req && req.evtType || ""),
        String(hit && hit.frame_id || ""),
        String(Number(hit && hit.object_id || 0)),
        String(Number(hit && hit.simplex_id || 0)),
        String(Number(hit && hit.pick_id || 0))
      ].join("|");
    }

    function samePointerHit(state, req, hit) {
      return !!state && state.lastEmittedHitKey === pointerHitKey(req, hit);
    }

    function rememberPointerHit(state, req, hit) {
      if (!state) { return; }
      state.lastEmittedHitKey = pointerHitKey(req, hit);
    }

    return {
      createState: createState,
      resetState: resetState,
      queueRequest: queueRequest,
      beginLatest: beginLatest,
      finish: finish,
      resolve: resolve
    };
  }

  function createPickArbitrator(options) {
    options = options || {};
    var emptyHit = typeof options.emptyHit === "function" ? options.emptyHit : function (frameX, frameY, fid) {
      return {
        type: "vf_event",
        x: frameX,
        y: frameY,
        frame_id: fid,
        object_id: 0,
        simplex_id: 0,
        pick_id: 0,
        pick_mask_representation: 0,
        pick_mask_carrier: 0,
        pick_mask_content: 0,
        pick_mask_exact: 0
      };
    };

    function pickFrame(args, cb) {
      args = args || {};
      var fid = args.fid;
      var entries = Array.isArray(args.entries) ? args.entries : [];
      var clientX = Number(args.clientX) || 0;
      var clientY = Number(args.clientY) || 0;
      var frameRect = args.frameRect || null;
      var frameX = frameRect ? (clientX - frameRect.left) : 0;
      var frameY = frameRect ? (clientY - frameRect.top) : 0;
      var pending = 0;
      var bestHit = null;
      var finished = false;
      var settleTimer = 0;

      function emitBestOrEmpty() {
        if (finished) { return; }
        finished = true;
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = 0;
        }
        if (!bestHit) {
          cb(emptyHit(frameX, frameY, fid));
          return;
        }
        if (bestHit.__layerIdx != null) {
          delete bestHit.__layerIdx;
        }
        cb(bestHit);
      }

      function scheduleSettle() {
        if (finished || settleTimer) { return; }
        settleTimer = setTimeout(function () {
          emitBestOrEmpty();
        }, 8);
      }

      for (var idx = entries.length - 1; idx >= 0; idx -= 1) {
        var entry = entries[idx];
        if (!entry || !entry.renderer || !entry.canvas) {
          continue;
        }
        var canvas = entry.canvas;
        var rect = canvas.getBoundingClientRect();
        if (!rect || clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
          continue;
        }
        var sx = canvas.width / (rect.width || 1);
        var sy = canvas.height / (rect.height || 1);
        var px = (clientX - rect.left) * sx;
        var py = (clientY - rect.top) * sy;
        pending += 1;
        (function (layerIdx, renderer, pickX, pickY) {
          renderer.pickAt(pickX, pickY, function (oid, sid, _cx, _cy, pickMeta) {
            if (finished) { return; }
            if (Number(oid) > 0 && (!bestHit || layerIdx > bestHit.__layerIdx)) {
              bestHit = {
                type: "vf_event",
                x: frameX,
                y: frameY,
                frame_id: fid,
                object_id: Number(oid) || 0,
                simplex_id: Number(sid) || 0,
                pick_id: 0,
                pick_mask_representation: 0,
                pick_mask_carrier: 0,
                pick_mask_content: 0,
                pick_mask_exact: 0,
                __layerIdx: layerIdx
              };
            }
            pending -= 1;
            if (bestHit && bestHit.__layerIdx === entries.length - 1) {
              emitBestOrEmpty();
              return;
            }
            if (Number(oid) > 0) {
              scheduleSettle();
            }
            if (pending === 0) {
              emitBestOrEmpty();
            }
          });
        })(idx, entry.renderer, px, py);
      }

      if (pending === 0) {
        cb(emptyHit(frameX, frameY, fid));
      }
    }

    return {
      pickFrame: pickFrame
    };
  }

  function createPointerRuntime(options) {
    options = options || {};
    var dispatch = options.dispatch;
    var performPick = options.performPick;
    var emit = options.emit;
    var requestAnimationFrameFn = options.requestAnimationFrame || global.requestAnimationFrame;
    var cancelAnimationFrameFn = options.cancelAnimationFrame || global.cancelAnimationFrame;
    if (!dispatch || typeof dispatch.createState !== "function") {
      fail("createPointerRuntime requires a pointer dispatch");
    }
    if (typeof performPick !== "function") {
      fail("createPointerRuntime requires performPick(req, cb)");
    }
    if (typeof emit !== "function") {
      fail("createPointerRuntime requires emit(hit, req)");
    }
    if (typeof requestAnimationFrameFn !== "function") {
      fail("createPointerRuntime requires requestAnimationFrame");
    }
    if (typeof cancelAnimationFrameFn !== "function") {
      fail("createPointerRuntime requires cancelAnimationFrame");
    }

    var state = dispatch.createState();

    function isPointerStreamReq(req) {
      return !!req && (req.evtType === "hover" || req.evtType === "move");
    }

    function schedulePointerRun() {
      if (!state || state.inFlight || state.pointerRaf) { return; }
      state.pointerRaf = requestAnimationFrameFn(function () {
        if (!state) { return; }
        state.pointerRaf = 0;
        runLatestReq();
      });
    }

    function runAfterFinish() {
      if (!state || !state.latestReq) { return; }
      runLatestReq();
    }

    function runLatestReq() {
      if (!state || state.inFlight || !state.latestReq) { return; }
      var req = dispatch.beginLatest(state);
      if (!req) { return; }
      function completePick(hit) {
        if (!state) { return; }
        var outcome = dispatch.resolve(state, req, hit);
        if (outcome.action === "confirm-empty") {
          dispatch.finish(state);
          if (!state.latestReq) {
            state.latestReq = req;
          }
          schedulePointerRun();
          return;
        }
        dispatch.finish(state);
        if (outcome.action === "stale") {
          runAfterFinish();
          return;
        }
        if (outcome.action === "drop") {
          runAfterFinish();
          return;
        }
        emit(outcome.hit, req);
        runAfterFinish();
      }
      performPick(req, completePick);
    }

    return {
      state: function () {
        return state;
      },
      enqueue: function (req) {
        if (!state) { return; }
        dispatch.queueRequest(state, req);
        if (isPointerStreamReq(req)) {
          schedulePointerRun();
          return;
        }
        if (state.pointerRaf) {
          cancelAnimationFrameFn(state.pointerRaf);
          state.pointerRaf = 0;
        }
        runLatestReq();
      },
      leave: function (emptyHit) {
        if (!state) { return; }
        if (state.pointerRaf) {
          cancelAnimationFrameFn(state.pointerRaf);
          state.pointerRaf = 0;
        }
        dispatch.resetState(state);
        emit(emptyHit, { evtType: "leave", mods: {}, extra: {} });
      },
      dispose: function () {
        if (!state) { return; }
        if (state.pointerRaf) {
          cancelAnimationFrameFn(state.pointerRaf);
          state.pointerRaf = 0;
        }
        dispatch.resetState(state);
      }
    };
  }

  global.VfGeomFrameAdapter = {
    __vfRuntimeAssetVersion: RUNTIME_ASSET_VERSION,
    createAdapter: createAdapter,
    createLedgerAdapter: createLedgerAdapter,
    createPointerDispatch: createPointerDispatch,
    createPickArbitrator: createPickArbitrator,
    createPointerRuntime: createPointerRuntime
  };
})(typeof window !== "undefined" ? window : globalThis);
