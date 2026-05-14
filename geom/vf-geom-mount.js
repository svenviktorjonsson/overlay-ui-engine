/**
 * Mount vf-geom WebGPU into a VfFrame panel (panel.body from VfFrame.mount).
 * Depends: vf-geom-math.js, vf-geom-core.js, vf-geom-wgpu.js
 */
(function (global) {
  "use strict";

  function vfLog(level, text) {
    var s = String(text);
    try {
      if (global.console) {
        if (level === "error" && global.console.error) {
          global.console.error(s);
        } else if (level === "warn" && global.console.warn) {
          global.console.warn(s);
        } else if (global.console.log) {
          global.console.log(s);
        }
      }
    } catch (e) {}
    try {
      if (global.chrome && global.chrome.webview && global.chrome.webview.postMessage) {
        global.chrome.webview.postMessage({ type: "vf_log", level: level, message: s, t: Date.now() });
        return;
      }
    } catch (e) {}
  }

  function sizeCanvasToHost(host, canvas) {
    var dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
    var r = host.getBoundingClientRect();
    var cssW = host.clientWidth > 0 ? host.clientWidth : r.width;
    var cssH = host.clientHeight > 0 ? host.clientHeight : r.height;
    var w = Math.max(1, Math.floor(cssW * dpr));
    var h = Math.max(1, Math.floor(cssH * dpr));
    /* WebGPU backbuffer: avoid configure() on 0×0 / 1×1 (invisible / invalid in WebView2). */
    if (r.width < 2 || r.height < 2) {
      w = Math.max(256, w);
      h = Math.max(256, h);
    } else {
      w = Math.max(64, w);
      h = Math.max(64, h);
    }
    if (canvas.width !== w) {
      canvas.width = w;
    }
    if (canvas.height !== h) {
      canvas.height = h;
    }
  }

  /**
   * @param {object} panel - VfFrame API object with .body
   * @param {string} presetId - key from VfGeomCore.getPreset
   * @param {{ minHeight?: number, expandToFit?: boolean }} [opts] - set expandToFit true to size the frame from body content (overrides fixed width/height on the root).
   * @returns {{ destroy: function(), canvas: HTMLCanvasElement, renderer: object }}
   */
  function mountInPanel(panel, presetId, opts) {
    opts = opts || {};
    var minH = typeof opts.minHeight === "number" ? opts.minHeight : 200;
    var expandToFit = opts.expandToFit === true;

    var host = document.createElement("div");
    host.className = "vf-geom-host";
    host.style.cssText =
      "position:relative;z-index:1;width:100%;min-height:" +
      minH +
      "px;flex:1 1 auto;overflow:hidden;box-sizing:border-box;";

    var canvas = document.createElement("canvas");
    canvas.setAttribute("aria-label", "vf-geom " + (presetId || "") + " view");
    canvas.style.cssText = "display:block;width:100%;height:100%;";
    host.appendChild(canvas);

    /* Sync canvas opacity to the nearest .vf-frame ancestor's alpha so the
       WebGPU content fades/shows correctly with the frame.  The WebGPU context
       already clears to a:0 (fully transparent), so canvas.style.opacity is
       the only multiplier we need. */
    var alphaObserver = null;
    function syncCanvasAlpha() {
      var el = canvas.parentNode;
      while (el && el !== document) {
        if (el.classList && el.classList.contains("vf-frame")) {
          var a = parseFloat(el.dataset && el.dataset.vfAlpha);
          canvas.style.opacity = isNaN(a) ? "1" : String(Math.max(0, Math.min(1, a)));
          return;
        }
        el = el.parentNode;
      }
      canvas.style.opacity = "1";
    }
    function attachAlphaObserver() {
      var el = canvas.parentNode;
      while (el && el !== document) {
        if (el.classList && el.classList.contains("vf-frame")) {
          if (typeof MutationObserver !== "undefined") {
            alphaObserver = new MutationObserver(syncCanvasAlpha);
            alphaObserver.observe(el, { attributes: true, attributeFilter: ["data-vf-alpha"] });
          }
          syncCanvasAlpha();
          return;
        }
        el = el.parentNode;
      }
    }
    if (panel && panel.body) {
      try {
        panel.body.classList.add("vf-geom__body");
      } catch (_) {}
      panel.body.appendChild(host);
      /* Attach after DOM insertion so we can walk up to .vf-frame */
      attachAlphaObserver();
    }

    var core = global.VfGeomCore;
    var Ctor = global.VfGeomWgpu;
    if (!core || !Ctor) {
      vfLog("error", "vf-geom: missing VfGeomCore or VfGeomWgpu (script order / load error).");
      var err = document.createElement("p");
      err.style.cssText = "padding:8px;font-size:12px;opacity:0.8;";
      err.textContent = "VfGeom: missing vf-geom-core or vf-geom-wgpu.";
      host.appendChild(err);
      return {
        destroy: function () {
          if (host.parentNode) {
            host.parentNode.removeChild(host);
          }
        },
        canvas: canvas,
        renderer: null,
      };
    }

    var mesh = core.getPreset(presetId);
    var r = new Ctor(canvas, function () {
      return mesh;
    });

    var ro = null;
    var roRaf = 0;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(function () {
        if (roRaf) {
          return;
        }
        roRaf = requestAnimationFrame(function () {
          roRaf = 0;
          sizeCanvasToHost(host, canvas);
          if (r && typeof r.onResize === "function") {
            r.onResize();
          }
        });
      });
      ro.observe(host);
    }

    function syncLayout() {
      sizeCanvasToHost(host, canvas);
      if (typeof r.onResize === "function") {
        r.onResize();
      }
    }
    syncLayout();

    function resyncLayoutSoon() {
      var step = 0;
      function tick() {
        step += 1;
        syncLayout();
        if (step < 5) {
          requestAnimationFrame(tick);
        }
      }
      requestAnimationFrame(tick);
    }

    function runInitAfterLayout() {
      var hasGpu = typeof navigator !== "undefined" && navigator.gpu;
      var br = host.getBoundingClientRect();
      vfLog(
        "info",
        "vf-geom start init preset=" +
          (presetId || "") +
          " hostCss=" +
          host.clientWidth +
          "x" +
          host.clientHeight +
          " rect=" +
          br.width.toFixed(0) +
          "x" +
          br.height.toFixed(0) +
          " canvasBuf=" +
          canvas.width +
          "x" +
          canvas.height +
          " gpu=" +
          hasGpu
      );
      syncLayout();
      r.init()
        .then(function (ok) {
          if (ok) {
            r.start();
            resyncLayoutSoon();
            vfLog("info", "vf-geom: WebGPU OK, preset=" + (presetId || "") + " canvas=" + canvas.width + "x" + canvas.height);
          } else {
            var msg =
              "WebGPU is not available (navigator.gpu or adapter/context). Use a current WebView2/Edge; vf-overlay adds --enable-unsafe-webgpu.";
            vfLog("error", "vf-geom init false: " + msg + " navigator.gpu=" + hasGpu);
            var p = document.createElement("p");
            p.className = "vf-geom__fallback";
            p.style.cssText = "position:absolute;inset:0;padding:8px;font-size:12px;overflow:auto;opacity:0.85;";
            p.textContent = msg;
            host.appendChild(p);
          }
          if (expandToFit && panel && typeof panel.expandToFitContent === "function") {
            panel.expandToFitContent();
          }
        })
        .catch(function (e) {
          var st = e && e.stack ? String(e.stack) : "";
          vfLog("error", "vf-geom init rejected: " + (e && e.message ? e.message : e) + (st ? "\n" + st : ""));
          var p = document.createElement("p");
          p.style.cssText = "padding:8px;font-size:12px;color:#faa;";
          p.textContent = String(e && e.message ? e.message : e);
          host.appendChild(p);
        });
    }

    /* Two animation frames: panel layout (%) often 0×0 on first tick — WebGPU would configure a blank swapchain. */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        runInitAfterLayout();
      });
    });

    if (global.VfFrame && typeof global.VfFrame.postNativeHostLayout === "function") {
      var el = document.getElementById("layer");
      if (el) {
        requestAnimationFrame(function () {
          try {
            global.VfFrame.postNativeHostLayout(el, { stageAlpha: 0 });
          } catch (_) {}
        });
      }
    }

    return {
      destroy: function () {
        if (roRaf) {
          try {
            cancelAnimationFrame(roRaf);
          } catch (_) {}
          roRaf = 0;
        }
        try {
          r.destroy();
        } catch (_) {}
        if (ro) {
          ro.disconnect();
        }
        if (alphaObserver) {
          alphaObserver.disconnect();
          alphaObserver = null;
        }
        if (host.parentNode) {
          host.parentNode.removeChild(host);
        }
      },
      canvas: canvas,
      renderer: r,
      resync: syncLayout,
    };
  }

  global.VfGeom = {
    mountInPanel: mountInPanel,
  };
})(typeof window !== "undefined" ? window : this);
