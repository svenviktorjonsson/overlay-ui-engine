/**
 * vf-runtime-scene.js — scene mount/apply adapter for the runtime shell.
 */
(function(global) {
  "use strict";

  if (global.VfRuntimeScene) { return; }

  function countExitTrackedFrames(layer) {
    if (!layer || !layer.querySelectorAll) { return 0; }
    var nodes = layer.querySelectorAll(".vf-frame");
    var count = 0;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || !node.dataset) { continue; }
      if (node.dataset.vfExitCounted === "false") { continue; }
      count += 1;
    }
    return count;
  }

  function createAdapter(options) {
    options = options || {};
    var createRuntimeDependencies = options.createRuntimeDependencies || function() { return {}; };
    var runtimeLog = options.runtimeLog || function() {};
    var getLayer = options.getLayer || function() { return null; };
    var displayRefresh = options.displayRefresh || function() {};
    var isLegacyFallbackActive = options.isLegacyFallbackActive || function() { return false; };

    function syncNativeLayout() {
      var deps = createRuntimeDependencies();
      var layer = getLayer();
      if (!layer || !deps.frame || !deps.frame.postNativeHostLayout) { return; }
      deps.frame.postNativeHostLayout(layer, { stageAlpha: 0 });
    }

    function applySpecRectToPanel(panel, spec) {
      var deps = createRuntimeDependencies();
      var frame = deps.frame;
      if (!frame) { return; }
      var r = spec && spec.rect;
      var anch = spec && spec.anchor != null ? String(spec.anchor) : "tl";
      var x = r && typeof r.x === "number" ? r.x : 0;
      var y = r && typeof r.y === "number" ? r.y : 0;
      var w = r && typeof r.w === "number" ? r.w : 1;
      var h = r && typeof r.h === "number" ? r.h : 1;
      function clamp01(v) {
        return Math.max(0, Math.min(1, v));
      }
      x = clamp01(x);
      y = clamp01(y);
      w = clamp01(w);
      h = clamp01(h);
      var k = frame.normalizeDockLocationKey ? frame.normalizeDockLocationKey(anch) : "tl";
      var parentEl = panel.root.offsetParent || panel.root.parentElement || panel.root;
      var isNestedLayer = !!(parentEl && parentEl.classList && parentEl.classList.contains("vf-frame__overlay"));
      var cs = global.getComputedStyle ? global.getComputedStyle(parentEl) : null;
      var padL = isNestedLayer ? 0 : Math.max(0, Math.round(parseFloat(cs && cs.paddingLeft ? cs.paddingLeft : "0") || 0));
      var padR = isNestedLayer ? 0 : Math.max(0, Math.round(parseFloat(cs && cs.paddingRight ? cs.paddingRight : "0") || 0));
      var padT = isNestedLayer ? 0 : Math.max(0, Math.round(parseFloat(cs && cs.paddingTop ? cs.paddingTop : "0") || 0));
      var padB = isNestedLayer ? 0 : Math.max(0, Math.round(parseFloat(cs && cs.paddingBottom ? cs.paddingBottom : "0") || 0));
      var parentW = parentEl && parentEl.clientWidth ? parentEl.clientWidth : 1;
      var parentH = parentEl && parentEl.clientHeight ? parentEl.clientHeight : 1;
      var availW = Math.max(1, parentW - padL - padR);
      var availH = Math.max(1, parentH - padT - padB);
      var fw = Math.max(1, Math.round(w * availW));
      var fh = Math.max(1, Math.round(h * availH));
      var v = k.charAt(0);
      var hz = k.charAt(1);
      var ax = padL + x * availW;
      var ay = padT + y * availH;
      if (hz === "r") { ax = padL + (1 - x) * availW; }
      if (v === "b") { ay = padT + (1 - y) * availH; }
      var ox = hz === "r" ? fw : (hz === "c" ? fw * 0.5 : 0);
      var oy = v === "b" ? fh : (v === "c" ? fh * 0.5 : 0);
      var leftPx = Math.round(ax - ox);
      var topPx = Math.round(ay - oy);
      var minL = padL;
      var minT = padT;
      var maxL = Math.max(minL, parentW - padR - fw);
      var maxT = Math.max(minT, parentH - padB - fh);
      leftPx = Math.min(maxL, Math.max(minL, leftPx));
      topPx = Math.min(maxT, Math.max(minT, topPx));
      var root = panel.root;
      root.dataset.vfAnchor = k;
      root.style.left = leftPx + "px";
      root.style.top = topPx + "px";
      root.style.width = fw + "px";
      root.style.height = fh + "px";
      root.style.right = "auto";
      root.style.bottom = "auto";
      root.classList.add("vf-frame--user-sized");
      if (typeof panel.syncPointerPassThrough === "function") {
        panel.syncPointerPassThrough();
      }
      if (typeof panel.renderTitle === "function") {
        panel.renderTitle();
      }
    }

    function postExitToHost() {
      var wv = global.chrome && global.chrome.webview;
      if (wv && typeof wv.postMessage === "function") {
        wv.postMessage({ type: "close" });
      }
    }

    function ensureFrameOverlay(panel) {
      if (!panel || !panel.body) { return null; }
      var body = panel.body;
      var ov = null;
      for (var i = 0; i < body.children.length; i++) {
        var ch = body.children[i];
        if (ch && ch.classList && ch.classList.contains("vf-frame__overlay")) {
          ov = ch;
          break;
        }
      }
      if (ov) { return ov; }
      ov = document.createElement("div");
      ov.className = "vf-frame__overlay";
      body.appendChild(ov);
      return ov;
    }

    function applySceneCommands(data) {
      var deps = createRuntimeDependencies();
      var frame = deps.frame;
      var widgets = deps.widgets;
      var layer = getLayer();
      if (!Array.isArray(data)) {
        runtimeLog("warn", "applySceneCommands: expected array");
        return;
      }
      if (!layer || !frame) {
        runtimeLog("warn", "applySceneCommands: runtime shell not booted");
        return;
      }
      var upsertCount = data.filter(function(c) { return c && c.kind === "frame_upsert"; }).length;
      runtimeLog("info", "applySceneCommands: " + data.length + " commands, " + upsertCount + " frame_upserts");

      layer.innerHTML = "";
      var upserts = data.filter(function(c) {
        return c && c.kind === "frame_upsert" && c.payload && c.payload.spec;
      });
      var mounted = [];
      var panelById = Object.create(null);
      var pending = upserts.slice();
      var pass = 0;
      while (pending.length > 0) {
        pass += 1;
        var advanced = false;
        var nextPending = [];
        for (var i = 0; i < pending.length; i++) {
          var spec = pending[i].payload.spec;
          var flags = spec.flags || {};
          var id = spec.id != null ? String(spec.id) : "frame-" + i;
          var parentId = spec.parent_id != null ? String(spec.parent_id).trim() : "";
          if (parentId && !panelById[parentId]) {
            nextPending.push(pending[i]);
            continue;
          }
          var parentPanel = parentId ? panelById[parentId] : null;
          var mountLayer = parentPanel ? (ensureFrameOverlay(parentPanel) || layer) : layer;
          var rawTitle = spec.title != null ? String(spec.title).trim() : "";
          var rawName = spec.name != null ? String(spec.name).trim() : "";
          var title = rawTitle || rawName;
          var alpha = frame._coerceAlpha(spec.alpha, 1);
          var isMaster = spec.master === true;
          var tAlign = spec.title_align;
          var titleAlign = tAlign === "center" || tAlign === "right" || tAlign === "left" ? tAlign : "left";
          var rawDock = spec.dock_loc != null ? spec.dock_loc : spec.dock_location != null ? spec.dock_location : spec.minimized_dock;
          var dockLocation = frame.normalizeDockLocationKey(rawDock != null ? String(rawDock) : "bl");
          var dockable = flags.dockable !== false && flags.minimizable !== false;
          var panel = frame.mount(mountLayer, {
            id: id,
            title: title,
            titleAlign: titleAlign,
            aspect: spec.aspect != null ? String(spec.aspect) : null,
            inLayerDrag: true,
            draggable: flags.draggable !== false,
            dockable: dockable,
            resizable: flags.resizable !== false,
            closable: flags.closable !== false,
            alpha: alpha,
            master: isMaster,
            dockLocation: dockLocation,
            zIndexBase: 1000 + i * 2,
            onBeforeDestroy: function(frameId) {
              return function() {
                if (widgets && widgets.onFrameClose) {
                  widgets.onFrameClose(frameId);
                }
              };
            }(id),
            onFrameRemoved: function() {
              if (layer._vfMasterTeardown) { return; }
              if (countExitTrackedFrames(layer) === 0) {
                postExitToHost();
              }
            }
          });
          panel.root.dataset.vfExitCounted = spec.exit_counted === false ? "false" : "true";
          panelById[id] = panel;
          applySpecRectToPanel(panel, spec);
          mounted.push({ panel: panel, spec: spec });
          if (spec.body && Array.isArray(spec.body) && spec.body.length && widgets && widgets.mount) {
            widgets.mount(panel, id, spec.body, spec.body_layout);
          }
          advanced = true;
        }
        if (!advanced) {
          for (var j = 0; j < nextPending.length; j++) {
            var fallbackSpec = nextPending[j].payload.spec || {};
            var fallbackId = fallbackSpec.id != null ? String(fallbackSpec.id) : "frame?";
            var fallbackPanel = frame.mount(layer, {
              id: fallbackId,
              title: fallbackSpec.title != null ? String(fallbackSpec.title) : "",
              titleAlign: "left",
              inLayerDrag: true,
              draggable: true,
              dockable: true,
              resizable: true,
              closable: true,
              alpha: frame._coerceAlpha(fallbackSpec.alpha, 1),
              master: fallbackSpec.master === true,
              dockLocation: "bl",
              zIndexBase: 1000 + j * 2
            });
            panelById[fallbackId] = fallbackPanel;
            applySpecRectToPanel(fallbackPanel, fallbackSpec);
            mounted.push({ panel: fallbackPanel, spec: fallbackSpec });
            if (fallbackSpec.body && Array.isArray(fallbackSpec.body) && fallbackSpec.body.length && widgets && widgets.mount) {
              widgets.mount(fallbackPanel, fallbackId, fallbackSpec.body, fallbackSpec.body_layout);
            }
          }
          break;
        }
        pending = nextPending;
        if (pass > upserts.length + 2) { break; }
      }
      syncNativeLayout();
      if (isLegacyFallbackActive()) {
        displayRefresh();
      }
      global.requestAnimationFrame(function() {
        for (var m = 0; m < mounted.length; m++) {
          try { applySpecRectToPanel(mounted[m].panel, mounted[m].spec); } catch (_) {}
        }
      });
      global.requestAnimationFrame(function() {
        global.requestAnimationFrame(function() {
          for (var m = 0; m < mounted.length; m++) {
            try { applySpecRectToPanel(mounted[m].panel, mounted[m].spec); } catch (_) {}
          }
          syncNativeLayout();
          if (isLegacyFallbackActive()) {
            displayRefresh();
          }
        });
      });
    }

    return {
      syncNativeLayout: syncNativeLayout,
      applySceneCommands: applySceneCommands
    };
  }

  global.VfRuntimeScene = {
    createAdapter: createAdapter
  };
})(typeof window !== "undefined" ? window : this);
