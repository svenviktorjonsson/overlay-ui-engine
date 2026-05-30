/**
 * Vektor Flow — floating frame shell (drag header, minimize, resize grip, close).
 *
 * @see vektorflow/ui/ir.py for the Python-side scene / command stream.
 */
(function (global) {
  "use strict";

  function getOrigin() {
    if (typeof location !== "undefined" && location && location.origin) {
      return location.origin;
    }
    var p =
      (typeof global !== "undefined" && global.__agentPort) ||
      (typeof window !== "undefined" && window.__agentPort);
    if (p) {
      return "http://127.0.0.1:" + String(p);
    }
    return "http://127.0.0.1";
  }

  function enqueueFrameEvent(obj) {
    var s = JSON.stringify(obj);
    var url = getOrigin() + "/api/enqueue";
    if (typeof fetch === "function") {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line: s }),
        mode: "cors",
        cache: "no-store",
      }).catch(function () {});
    }
  }

  const VfFrame = {
    /**
     * Parse frame alpha from JSON (number or numeric string). Default `fallback` if missing/invalid.
     * @param {unknown} v
     * @param {number} fallback
     */
    _coerceAlpha(v, fallback) {
      if (v == null || v === "") return fallback;
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(0, Math.min(1, n));
    },

    /**
     * One of 8: bl,bc,br, tl,tc,tr, cl,cr (no center-only / cc). Matches vektorflow.ui.ir.parse_dock_location.
     * @param {string} raw
     * @returns {string} canonical 2-letter key
     */
    normalizeDockLocationKey(raw) {
      let t = String(raw == null ? "bl" : raw)
        .trim()
        .toLowerCase()
        .replace(/[\s\-_]/g, "");
      if (t === "" || t === "cc" || t === "c" || t === "center" || t === "centre") {
        console.warn("VfFrame: invalid dock_location, using bl");
        return "bl";
      }
      if (t === "bottom") t = "bl";
      else if (t === "top") t = "tl";
      else if (t === "left") t = "cl";
      else if (t === "right") t = "cr";
      const eight = { bl: 1, bc: 1, br: 1, tl: 1, tc: 1, tr: 1, cl: 1, cr: 1 };
      if (eight[t]) return t;
      const longMap = {
        bottomleft: "bl",
        bottomcenter: "bc",
        bottomright: "br",
        topleft: "tl",
        topcenter: "tc",
        topright: "tr",
        centerleft: "cl",
        centerright: "cr",
        leftcenter: "cl",
        rightcenter: "cr",
        lefttop: "tl",
        leftbottom: "bl",
        righttop: "tr",
        rightbottom: "br",
        topleftcorner: "tl",
        bottomleftcorner: "bl",
      };
      if (longMap[t]) return longMap[t];
      if (t.length === 2) {
        const canons = Object.keys(eight);
        for (let i = 0; i < canons.length; i++) {
          const c = canons[i];
          if (c.length === 2 && [...t].sort().join() === [...c].sort().join()) return c;
        }
      }
      console.warn("VfFrame: unknown dock_location, using bl:", raw);
      return "bl";
    },

    /**
     * Plain text for minimized bar / tooltips (strip $$ … $$ segments).
     * @param {string} raw
     */
    plainTitleForChrome(raw) {
      if (raw == null) return "";
      return String(raw)
        .replace(/\$\$[\s\S]*?\$\$/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    },

    /**
     * Render title: plain text, or text + KaTeX for segments between $$ and $$ (requires window.katex).
     * @param {HTMLElement} el
     * @param {string} raw
     */
    renderTitleToEl(el, raw) {
      el.innerHTML = "";
      const s = raw != null ? String(raw) : "";
      if (!s) return;
      const katex = typeof window !== "undefined" && window.katex;
      const marks = s.match(/\$\$/g);
      if (!katex || !marks || marks.length % 2 !== 0) {
        el.textContent = s;
        return;
      }
      const parts = s.split("$$");
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) {
          if (parts[i]) el.appendChild(document.createTextNode(parts[i]));
        } else {
          const span = document.createElement("span");
          span.className = "vf-frame__title-math";
          try {
            span.innerHTML = katex.renderToString(parts[i].trim(), {
              displayMode: false,
              throwOnError: false,
            });
          } catch (_) {
            span.textContent = "$$" + parts[i] + "$$";
          }
          el.appendChild(span);
        }
      }
    },

    createMinimizeButton(extraClass) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "vf-min-btn" + (extraClass ? " " + extraClass : "");
      btn.setAttribute("aria-label", "Minimize or restore");
      const bar = document.createElement("span");
      bar.className = "vf-min-btn__bar";
      bar.setAttribute("aria-hidden", "true");
      btn.appendChild(bar);
      return btn;
    },

    createCloseButton() {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "vf-close-btn";
      btn.setAttribute("aria-label", "Close");
      btn.appendChild(document.createTextNode("\u2715"));
      return btn;
    },

    /**
     * WebView2 vf-overlay: send ``layout`` (hit regions + stage alpha) to native. The HTTP server
     * reads the scene from ``web/`` next to vf-overlay.exe, not only from the repo; without this
     * message the host can stay in pass-through mode for the whole client.
     * @param {HTMLElement} layer
     * @param {{ stageAlpha?: number }} o
     */
    postNativeHostLayout(layer, o) {
      o = o || {};
      const wv = typeof globalThis !== "undefined" && globalThis.chrome && globalThis.chrome.webview;
      if (!wv || typeof wv.postMessage !== "function" || !layer) return;
      const sa = typeof o.stageAlpha === "number" ? Math.max(0, Math.min(1, o.stageAlpha)) : 1;
      const scope = (typeof document !== "undefined" && document && document.querySelectorAll)
        ? document
        : layer;
      const nodes = scope ? scope.querySelectorAll(".vf-frame") : [];
      const hitRegions = [];
      function paintPadDipForElement(el) {
        if (!(el instanceof HTMLElement)) return 2;
        let pad = 24;
        try {
          const cs = globalThis.getComputedStyle ? globalThis.getComputedStyle(el) : null;
          const bs = cs && cs.boxShadow ? String(cs.boxShadow) : "";
          if (bs && bs !== "none") {
            const nums = bs.match(/-?\d*\.?\d+px/g);
            if (nums && nums.length) {
              let mx = 0;
              for (let i = 0; i < nums.length; i++) {
                const v = Math.abs(parseFloat(nums[i]));
                if (Number.isFinite(v) && v > mx) mx = v;
              }
              pad = Math.max(pad, Math.ceil(mx));
            }
          }
        } catch (_) {}
        return pad;
      }
      function pushRectWithPad(r, pad) {
        if (!r) return;
        if (r.width < 1 || r.height < 1) return;
        hitRegions.push({
          left: Math.floor(r.left - pad),
          top: Math.floor(r.top - pad),
          right: Math.ceil(r.right + pad),
          bottom: Math.ceil(r.bottom + pad),
        });
      }
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (!(el instanceof HTMLElement)) continue;
        if (el.classList.contains("vf-frame--pass-through")) continue;
        const r = el.getBoundingClientRect();
        pushRectWithPad(r, paintPadDipForElement(el));
      }
      const displayRegions = globalThis && Array.isArray(globalThis.__vfDisplayHitRegions)
        ? globalThis.__vfDisplayHitRegions
        : null;
      if (displayRegions && displayRegions.length) {
        for (let i = 0; i < displayRegions.length; i++) {
          const rr = displayRegions[i];
          if (!rr || typeof rr !== "object") continue;
          const l = Number(rr.left);
          const t = Number(rr.top);
          const r = Number(rr.right);
          const b = Number(rr.bottom);
          if (!Number.isFinite(l) || !Number.isFinite(t) || !Number.isFinite(r) || !Number.isFinite(b)) continue;
          if (r <= l || b <= t) continue;
          hitRegions.push({
            left: Math.floor(l),
            top: Math.floor(t),
            right: Math.ceil(r),
            bottom: Math.ceil(b),
          });
        }
      }
      if (Array.isArray(o.hitRegions)) {
        for (let i = 0; i < o.hitRegions.length; i++) {
          const rr = o.hitRegions[i];
          if (!rr || typeof rr !== "object") continue;
          const l = Number(rr.left);
          const t = Number(rr.top);
          const r = Number(rr.right);
          const b = Number(rr.bottom);
          if (!Number.isFinite(l) || !Number.isFinite(t) || !Number.isFinite(r) || !Number.isFinite(b)) continue;
          if (r <= l || b <= t) continue;
          pushRectWithPad({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t }, 2);
        }
      }
      wv.postMessage({
        type: "layout",
        stageAlpha: sa,
        contentHidden: hitRegions.length === 0,
        toolbarPx: 160,
        hitRegions: hitRegions,
      });
    },

    /**
     * Minimized frames: eight dock positions (data-vf-min-dock) bl|bc|br|tl|tc|tr|cl|cr.
     * Frames that share a corner stack **perpendicularly** (e.g. bottom strip: vertical
     * stack from the edge) so each title bar is its own strip — not one wide row “together”.
     */
    layoutMinimizedDock(layer) {
      if (!layer) return;
      const g = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : null;
      const gap = 6;
      const isNestedLayer = !!(layer && layer.classList && layer.classList.contains("vf-frame__overlay"));
      const lcs = global.getComputedStyle ? global.getComputedStyle(layer) : null;
      const padL = isNestedLayer ? 0 : Math.max(0, Math.round(parseFloat(lcs && lcs.paddingLeft ? lcs.paddingLeft : "0") || 0));
      const padR = isNestedLayer ? 0 : Math.max(0, Math.round(parseFloat(lcs && lcs.paddingRight ? lcs.paddingRight : "0") || 0));
      const padT = isNestedLayer ? 0 : Math.max(0, Math.round(parseFloat(lcs && lcs.paddingTop ? lcs.paddingTop : "0") || 0));
      const padB = isNestedLayer ? 0 : Math.max(0, Math.round(parseFloat(lcs && lcs.paddingBottom ? lcs.paddingBottom : "0") || 0));
      const all = Array.from(layer.children).filter(function (n) {
        return (
          n instanceof HTMLElement &&
          n.classList.contains("vf-frame") &&
          n.classList.contains("vf-frame--minimized")
        );
      });
      const by = { bl: [], bc: [], br: [], tl: [], tc: [], tr: [], cl: [], cr: [] };
      for (let i = 0; i < all.length; i++) {
        const fr = all[i];
        if (!(fr instanceof HTMLElement)) continue;
        // Docking source of truth is min-dock (from spec.dock_location / dock_loc).
        // Do not read placement/anchor metadata here.
        const k = VfFrame.normalizeDockLocationKey(
          (fr.dataset.vfMinDock || "bl")
        );
        if (by[k]) by[k].push(fr);
        else by.bl.push(fr);
      }
      requestAnimationFrame(function () {
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (el instanceof HTMLElement) {
            void el.offsetWidth;
          }
        }
        requestAnimationFrame(function () {
          const vw = layer && layer.clientWidth ? layer.clientWidth : (g && g.innerWidth ? g.innerWidth : 800);
          const vh = layer && layer.clientHeight ? layer.clientHeight : (g && g.innerHeight ? g.innerHeight : 600);
          const cw = Math.max(0, vw - padL - padR);
          const ch = Math.max(0, vh - padT - padB);
          function clampX(x, w) {
            const maxX = Math.max(padL, padL + cw - w);
            return Math.min(maxX, Math.max(padL, x));
          }
          function clampY(y, h) {
            const maxY = Math.max(padT, padT + ch - h);
            return Math.min(maxY, Math.max(padT, y));
          }
          function place(fr, l, t) {
            fr.style.left = Math.round(l) + "px";
            fr.style.top = Math.round(t) + "px";
            fr.style.right = "auto";
            fr.style.bottom = "auto";
          }
          /** Stack along the bottom edge: each frame gets its own horizontal strip, stacked upward. */
          function stackBottomLeft(nodes) {
            if (!nodes || nodes.length === 0) return;
            let b = padB;
            for (let j = 0; j < nodes.length; j++) {
              const fr = nodes[j];
              const h = fr.getBoundingClientRect().height;
              place(fr, padL, clampY(vh - b - h, h));
              b += h + gap;
            }
          }
          function stackBottomCenter(nodes) {
            if (!nodes || nodes.length === 0) return;
            let b = padB;
            for (let j = 0; j < nodes.length; j++) {
              const fr = nodes[j];
              const w = fr.getBoundingClientRect().width;
              const h = fr.getBoundingClientRect().height;
              const lx = padL + (cw - w) * 0.5;
              place(fr, clampX(lx, w), clampY(vh - b - h, h));
              b += h + gap;
            }
          }
          function stackBottomRight(nodes) {
            if (!nodes || nodes.length === 0) return;
            let b = padB;
            for (let j = 0; j < nodes.length; j++) {
              const fr = nodes[j];
              const w = fr.getBoundingClientRect().width;
              const h = fr.getBoundingClientRect().height;
              place(fr, clampX(vw - padR - w, w), clampY(vh - b - h, h));
              b += h + gap;
            }
          }
          /** Stack along the top edge: strips laid out downward. */
          function stackTopLeft(nodes) {
            if (!nodes || nodes.length === 0) return;
            let t = padT;
            for (let j = 0; j < nodes.length; j++) {
              const fr = nodes[j];
              const h = fr.getBoundingClientRect().height;
              place(fr, padL, clampY(t, h));
              t += h + gap;
            }
          }
          function stackTopCenter(nodes) {
            if (!nodes || nodes.length === 0) return;
            let t = padT;
            for (let j = 0; j < nodes.length; j++) {
              const fr = nodes[j];
              const w = fr.getBoundingClientRect().width;
              const h = fr.getBoundingClientRect().height;
              const lx = padL + (cw - w) * 0.5;
              place(fr, clampX(lx, w), clampY(t, h));
              t += h + gap;
            }
          }
          function stackTopRight(nodes) {
            if (!nodes || nodes.length === 0) return;
            let t = padT;
            for (let j = 0; j < nodes.length; j++) {
              const fr = nodes[j];
              const w = fr.getBoundingClientRect().width;
              const h = fr.getBoundingClientRect().height;
              place(fr, clampX(vw - padR - w, w), clampY(t, h));
              t += h + gap;
            }
          }
          function colLeftSide(nodes) {
            let y = padT;
            for (let j = 0; j < nodes.length; j++) {
              const fr = nodes[j];
              const h = fr.getBoundingClientRect().height;
              place(fr, padL, clampY(y, h));
              y += h + gap;
            }
          }
          function colRightSide(nodes) {
            let y = padT;
            for (let j = 0; j < nodes.length; j++) {
              const fr = nodes[j];
              const w = fr.getBoundingClientRect().width;
              const h = fr.getBoundingClientRect().height;
              place(fr, clampX(vw - padR - w, w), clampY(y, h));
              y += h + gap;
            }
          }
          stackBottomLeft(by.bl);
          stackBottomCenter(by.bc);
          stackBottomRight(by.br);
          stackTopLeft(by.tl);
          stackTopCenter(by.tc);
          stackTopRight(by.tr);
          colLeftSide(by.cl);
          colRightSide(by.cr);
          VfFrame.notifyHostMinimizedLayout(layer);
        });
      });
    },

    /**
     * @param {HTMLElement} layer
     * @returns {{ x: number, y: number, width: number, height: number } | null}
     */
    minimizedClientUnionRect(layer) {
      const nodes = Array.from(layer.children).filter(function (n) {
        return (
          n instanceof HTMLElement &&
          n.classList.contains("vf-frame") &&
          n.classList.contains("vf-frame--minimized")
        );
      });
      if (!nodes || nodes.length === 0) return null;
      let l0 = Infinity;
      let t0 = Infinity;
      let r0 = -Infinity;
      let b0 = -Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (!(el instanceof HTMLElement)) continue;
        const b = el.getBoundingClientRect();
        l0 = Math.min(l0, b.left);
        t0 = Math.min(t0, b.top);
        r0 = Math.max(r0, b.right);
        b0 = Math.max(b0, b.bottom);
      }
      if (l0 === Infinity) return null;
      return { x: l0, y: t0, width: r0 - l0, height: b0 - t0 };
    },

    /**
     * After minimize / dock layout: refresh native **hit regions** only.
     * The desktop overlay host stays **full-size and transparent** — we do not send ``vf-dock``
     * (no window resize); that is handled only in static ``web/vf-ui``, not in native code here.
     * @param {HTMLElement} layer
     */
    notifyHostMinimizedLayout(layer) {
      if (typeof VfFrame.postNativeHostLayout === "function" && layer) {
        VfFrame.postNativeHostLayout(layer, { stageAlpha: 0 });
      }
    },

    /**
     * After restoring a frame: same as above — full host; only update ``layout`` hit tests.
     * @param {HTMLElement} layer
     */
    notifyHostRestored(layer) {
      if (typeof VfFrame.postNativeHostLayout === "function" && layer) {
        VfFrame.postNativeHostLayout(layer, { stageAlpha: 0 });
      }
    },

    /**
     * Move the native host window (WebView2) by screen-pixel deltas — required when the
     * frame fills the view (in-layer drag has nowhere to go).
     * @param {HTMLElement[]} dragSurfaces
     * @param {{ onDragStart?: () => void }} o
     */
    attachHostWindowDrag(dragSurfaces, o) {
      const wv = typeof window !== "undefined" && window.chrome && window.chrome.webview;
      if (!wv || typeof wv.postMessage !== "function") return;
      let drag = null;
      const onDown = (e) => {
        if (e.target.closest && e.target.closest("button")) return;
        if (e.button !== 0) return;
        if (o.onDragStart) o.onDragStart();
        /* Native side uses integer dx/dy; subpixel per-event motion must accumulate or small moves
         * round to 0 and the window lags the cursor. */
        drag = { pid: e.pointerId, lx: e.screenX, ly: e.screenY, accX: 0, accY: 0 };
        try {
          (e.currentTarget || e.target).setPointerCapture(e.pointerId);
        } catch (_) {}
        e.preventDefault();
      };
      const onMove = (e) => {
        if (!drag || e.pointerId !== drag.pid) return;
        const dx = e.screenX - drag.lx;
        const dy = e.screenY - drag.ly;
        drag.lx = e.screenX;
        drag.ly = e.screenY;
        if (dx === 0 && dy === 0) return;
        drag.accX += dx;
        drag.accY += dy;
        const ix = Math.trunc(drag.accX);
        const iy = Math.trunc(drag.accY);
        if (ix === 0 && iy === 0) return;
        drag.accX -= ix;
        drag.accY -= iy;
        try {
          wv.postMessage({ type: "vf-move", dx: ix, dy: iy });
        } catch (_) {}
      };
      const onUp = (e) => {
        if (!drag || e.pointerId !== drag.pid) return;
        if (Math.abs(drag.accX) > 0.001 || Math.abs(drag.accY) > 0.001) {
          const rx = Math.round(drag.accX);
          const ry = Math.round(drag.accY);
          if (rx !== 0 || ry !== 0) {
            try {
              wv.postMessage({ type: "vf-move", dx: rx, dy: ry });
            } catch (_) {}
          }
        }
        try {
          (e.currentTarget || e.target).releasePointerCapture(e.pointerId);
        } catch (_) {}
        drag = null;
      };
      for (let i = 0; i < dragSurfaces.length; i++) {
        const el = dragSurfaces[i];
        if (!el) continue;
        el.addEventListener("pointerdown", onDown);
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
        el.addEventListener("pointercancel", onUp);
      }
    },

    /**
     * @param {{ root: HTMLElement, header: HTMLElement, layer: HTMLElement, onDragStart?: () => void, onDragMove?: () => void, onDragEnd?: () => void, shouldIgnoreDrag?: (e: PointerEvent) => boolean }} o
     */
    attachHeaderDrag(o) {
      const { root, header, layer } = o;
      let drag = null;
      let blockWheel = null;
      function _parseCssPosPx(v, base) {
        if (v == null) return NaN;
        const s = String(v).trim().toLowerCase();
        if (!s || s === "auto") return NaN;
        if (s.endsWith("%")) {
          const p = Number.parseFloat(s.slice(0, -1));
          if (!Number.isFinite(p)) return NaN;
          return (base * p) / 100;
        }
        const n = Number.parseFloat(s);
        return Number.isFinite(n) ? n : NaN;
      }
      function endDrag(e) {
        if (!drag || e.pointerId !== drag.pid) return;
        try {
          header.releasePointerCapture(e.pointerId);
        } catch (_) {}
        if (blockWheel) {
          try {
            layer.removeEventListener("wheel", blockWheel, true);
          } catch (_) {}
          blockWheel = null;
        }
        drag = null;
        if (o.onDragEnd) o.onDragEnd();
      }
      header.addEventListener("pointerdown", (e) => {
        if (o.shouldIgnoreDrag && o.shouldIgnoreDrag(e)) return;
        if (e.target.closest("button")) return;
        if (e.button !== 0) return;
        if (o.onDragStart) o.onDragStart();
        const cs = global.getComputedStyle ? global.getComputedStyle(root) : null;
        let left0 = _parseCssPosPx(cs ? cs.left : "", layer.clientWidth);
        let top0 = _parseCssPosPx(cs ? cs.top : "", layer.clientHeight);
        if (!Number.isFinite(left0)) left0 = root.offsetLeft;
        if (!Number.isFinite(top0)) top0 = root.offsetTop;
        drag = {
          pid: e.pointerId,
          left: Math.round(left0),
          top: Math.round(top0),
          lastX: e.clientX,
          lastY: e.clientY,
          fixedPos: false,
        };
        blockWheel = function (ev) {
          if (!drag) return;
          if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        };
        try {
          layer.addEventListener("wheel", blockWheel, { passive: false, capture: true });
        } catch (_) {}
        try {
          header.setPointerCapture(e.pointerId);
        } catch (_) {}
        e.preventDefault();
      });
      header.addEventListener("pointermove", (e) => {
        if (!drag || e.pointerId !== drag.pid) return;
        const dx = e.clientX - drag.lastX;
        const dy = e.clientY - drag.lastY;
        if (dx === 0 && dy === 0) return;
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        if (!drag.fixedPos) {
          root.style.left = drag.left + "px";
          root.style.top = drag.top + "px";
          root.style.right = "auto";
          root.style.bottom = "auto";
          drag.fixedPos = true;
        }
        const isNestedLayer = !!(layer && layer.classList && layer.classList.contains("vf-frame__overlay"));
        const lcs = global.getComputedStyle ? global.getComputedStyle(layer) : null;
        const padL = isNestedLayer ? 0 : Math.max(0, Math.round(parseFloat(lcs && lcs.paddingLeft ? lcs.paddingLeft : "0") || 0));
        const padR = isNestedLayer ? 0 : Math.max(0, Math.round(parseFloat(lcs && lcs.paddingRight ? lcs.paddingRight : "0") || 0));
        const padT = isNestedLayer ? 0 : Math.max(0, Math.round(parseFloat(lcs && lcs.paddingTop ? lcs.paddingTop : "0") || 0));
        const padB = isNestedLayer ? 0 : Math.max(0, Math.round(parseFloat(lcs && lcs.paddingBottom ? lcs.paddingBottom : "0") || 0));
        const minL = padL;
        const minT = padT;
        const maxL = Math.max(minL, layer.clientWidth - root.offsetWidth - padR);
        const maxT = Math.max(minT, layer.clientHeight - root.offsetHeight - padB);
        let nl = drag.left + dx;
        let nt = drag.top + dy;
        nl = Math.min(maxL, Math.max(minL, nl));
        nt = Math.min(maxT, Math.max(minT, nt));
        drag.left = nl;
        drag.top = nt;
        root.style.left = nl + "px";
        root.style.top = nt + "px";
        e.preventDefault();
        if (o.onDragMove) o.onDragMove();
      });
      header.addEventListener("pointerup", endDrag);
      header.addEventListener("pointercancel", endDrag);
    },

    attachRootPointerToFront(root, bringToFront) {
      root.addEventListener(
        "pointerdown",
        () => {
          bringToFront();
        },
        true
      );
    },

    /**
     * @param {HTMLElement} layer - positioned container (e.g. position:relative; inset 0)
     * @param {{ id?: string, title?: string, titleAlign?: "left"|"center"|"right", draggable?: boolean, inLayerDrag?: boolean, dockable?: boolean, resizable?: boolean, closable?: boolean, alpha?: number, zIndexBase?: number, master?: boolean, dockLocation?: string, onFrameRemoved?: () => void, exitWhenLastFrameClosed?: boolean }} options
     *   WebView2: by default ``inLayerDrag`` is on (set ``inLayerDrag: false`` to move the native window via ``vf-move`` when the frame fills the view).
     *   With ``master: true``, the close control removes all other ``.vf-frame``s in
     *   this layer, then this frame, then posts one host ``close``; otherwise each
     *   frame is moved and docked independently.
     *   With ``exitWhenLastFrameClosed: true`` (WebView2): after this frame is removed, if the layer
     *   has no other ``.vf-frame``, the host is asked to close (``postMessage`` ``{ type: "close" }``).
     */
    mount(layer, options) {
      const opt = options || {};
      const id = opt.id || "vf-frame-" + Math.random().toString(36).slice(2, 9);
      const title = opt.title != null ? String(opt.title) : "";
      const frameless = opt.frameless === true;
      const ta = opt.titleAlign;
      const titleAlign = ta === "center" || ta === "right" ? ta : "left";
      const draggable = opt.draggable !== false;
      const dockable =
        opt.dockable !== false && (opt.minimizable !== false);
      const resizable = opt.resizable !== false;
      const closable = opt.closable !== false;
      const aspect = opt.aspect != null ? String(opt.aspect).trim().toLowerCase() : "";
      const alpha = VfFrame._coerceAlpha(opt.alpha, 1);
      const master = opt.master === true;
      const exitWhenLastFrameClosed = opt.exitWhenLastFrameClosed === true;
      let zCounter = typeof opt.zIndexBase === "number" ? opt.zIndexBase : 1000;
      const rawDockStr =
        opt.dockLocation != null
          ? String(opt.dockLocation)
          : opt.dockLoc != null
            ? String(opt.dockLoc)
            : opt.minimizedDock != null
              ? String(opt.minimizedDock)
              : "bl";
      const minDock = VfFrame.normalizeDockLocationKey(rawDockStr);

      function syncPointerPassThrough() {
        let th = 0.01;
        if (typeof window !== "undefined" && typeof window.__VF_ALPHA_THRESHOLD__ === "number") {
          th = window.__VF_ALPHA_THRESHOLD__;
        }
        root.classList.toggle("vf-frame--pass-through", alpha < th);
      }

      const root = document.createElement("div");
      root.className = "vf-frame";
      root.classList.toggle("vf-frame--resizable", resizable && !frameless);
      root.classList.toggle("vf-frame--frameless", frameless);
      root.dataset.vfFrameId = id;
      root.dataset.vfMinDock = minDock;
      if (aspect) { root.dataset.vfAspect = aspect; }
      /* Opacity on whole root would dim title/KaTeX; only shell rgba use --vf-ui-alpha. */
      root.style.opacity = "1";
      root.style.setProperty("--vf-ui-alpha", String(alpha));
      root.dataset.vfAlpha = String(alpha);
      syncPointerPassThrough();

      const head = document.createElement("div");
      head.className = "vf-frame__header vf-frame__header--title-" + titleAlign;

      const dragHandle = document.createElement("div");
      dragHandle.className = "vf-frame__drag-handle";
      dragHandle.setAttribute("role", "button");
      dragHandle.setAttribute("tabindex", "0");
      dragHandle.setAttribute("aria-label", "Drag window");
      dragHandle.setAttribute("title", "Drag window");
      dragHandle.dataset.vfDragHandle = "1";
      dragHandle.textContent = "::::";

      const titleEl = document.createElement("span");
      titleEl.className = "vf-frame__title";

      function scheduleRenderTitle() {
        function tryRender() {
          VfFrame.renderTitleToEl(titleEl, title);
        }
        tryRender();
        if (typeof window !== "undefined" && !window.katex) {
          let n = 0;
          const id = window.setInterval(function () {
            n += 1;
            if (window.katex) {
              window.clearInterval(id);
              tryRender();
            } else if (n > 120) {
              window.clearInterval(id);
            }
          }, 50);
        }
      }
      scheduleRenderTitle();

      const headEnd = document.createElement("div");
      headEnd.className = "vf-frame__header-actions";

      const btnMin = dockable ? VfFrame.createMinimizeButton() : null;
      const btnClose = closable ? VfFrame.createCloseButton() : null;
      if (btnMin) headEnd.appendChild(btnMin);
      if (btnClose) headEnd.appendChild(btnClose);

      head.appendChild(dragHandle);
      head.appendChild(titleEl);
      if (btnMin || btnClose) {
        head.appendChild(headEnd);
      }

      const body = document.createElement("div");
      body.className = "vf-frame__body";
      const hasBodyContent = Array.isArray(opt.body) ? opt.body.length > 0 : !!opt.body;
      if (!hasBodyContent) {
        body.classList.add("vf-frame__body--empty");
      }
      if (opt.bodyTransparent === true) {
        body.classList.add("vf-frame__body--transparent");
      }
      const drawCanvas = document.createElement("canvas");
      drawCanvas.className = "vf-frame__draw-canvas";
      drawCanvas.setAttribute("aria-hidden", "true");
      body.appendChild(drawCanvas);

      const minibar = document.createElement("div");
      minibar.className = "vf-frame__minibar";
      minibar.hidden = true;
      const miniText = document.createElement("span");
      miniText.className = "vf-frame__minibar-text";
      minibar.appendChild(miniText);

      const resizeGrip = document.createElement("div");
      resizeGrip.className = "vf-frame__resize-grip";
      resizeGrip.setAttribute("aria-hidden", "true");

      if (!frameless) {
        root.appendChild(head);
      }
      root.appendChild(minibar);
      root.appendChild(body);
      if (!frameless) {
        root.appendChild(resizeGrip);
      }

      layer.appendChild(root);

      function bringToFront() {
        zCounter += 1;
        root.style.zIndex = String(zCounter);
      }

      let minimized = false;
      let layoutBeforeMin = null;
      /** @type {{ left: string, top: string, classUserSized: boolean } | null} */
      let posBeforeMin = null;

      function headerHeight() {
        return head.getBoundingClientRect().height || 32;
      }

      function minContentHeight() {
        return headerHeight() + 24;
      }

      function syncMinBtnGlyph() {
        if (!btnMin) return;
        btnMin.setAttribute("aria-label", minimized ? "Restore" : "Minimize");
        btnMin.replaceChildren();
        if (minimized) {
          const sq = document.createElement("span");
          sq.className = "vf-min-btn__square";
          sq.setAttribute("aria-hidden", "true");
          btnMin.appendChild(sq);
        } else {
          const bar = document.createElement("span");
          bar.className = "vf-min-btn__bar";
          bar.setAttribute("aria-hidden", "true");
          btnMin.appendChild(bar);
        }
      }

      function setMinimized(v) {
        if (!dockable) return;
        minimized = !!v;
        root.classList.toggle("vf-frame--minimized", minimized);
        const isNestedLayer = !!(layer && layer.classList && layer.classList.contains("vf-frame__overlay"));
        body.style.display = minimized ? "none" : "";
        /* Docked mode uses the real header (banner) only; minibar is unused. */
        if (minibar) {
          minibar.hidden = true;
          minibar.style.display = "none";
        }
        if (resizable) resizeGrip.style.display = minimized ? "none" : "";
        syncMinBtnGlyph();
        if (minimized) {
          posBeforeMin = {
            left: root.style.left,
            top: root.style.top,
            classUserSized: root.classList.contains("vf-frame--user-sized"),
          };
          if (root.classList.contains("vf-frame--user-sized")) {
            layoutBeforeMin = { w: root.style.width, h: root.style.height };
          } else {
            layoutBeforeMin = null;
          }
          root.classList.remove("vf-frame--user-sized");
          // Nested frames must dock in parent-local coordinates and follow parent moves.
          // Top-level frames keep viewport-fixed docking.
          root.style.position = isNestedLayer ? "absolute" : "fixed";
          /* Docked strip = same chrome as the normal header (title + actions only). */
          root.style.width = "max-content";
          root.style.height = "auto";
          root.style.maxWidth = "200px";
          root.style.right = "auto";
          if (minibar) minibar.style.display = "none";
          VfFrame.layoutMinimizedDock(layer);
          enqueueFrameEvent({
            frameId: String(id),
            event: "frame.docked",
            data: { dock: String(minDock), minimized: true },
          });
        } else {
          root.style.position = "";
          if (posBeforeMin) {
            root.style.left = posBeforeMin.left;
            root.style.top = posBeforeMin.top;
            root.style.right = "";
            root.style.bottom = "";
            if (posBeforeMin.classUserSized) {
              root.classList.add("vf-frame--user-sized");
            } else {
              root.classList.remove("vf-frame--user-sized");
            }
          }
          posBeforeMin = null;
          root.style.maxWidth = "";
          if (layoutBeforeMin) {
            root.style.width = layoutBeforeMin.w;
            root.style.height = layoutBeforeMin.h;
          } else {
            root.style.width = "";
            root.style.height = "";
            root.classList.remove("vf-frame--user-sized");
          }
          layoutBeforeMin = null;
          VfFrame.notifyHostRestored(layer);
          try {
            root.dispatchEvent(
              new CustomEvent("vf-frame-restore", { bubbles: true, cancelable: false })
            );
            if (typeof window !== "undefined" && window.requestAnimationFrame) {
              window.requestAnimationFrame(function () {
                try {
                  window.dispatchEvent(new Event("resize"));
                } catch (_) {}
              });
            }
          } catch (_) {}
        }
      }

      if (btnMin) {
        syncMinBtnGlyph();
        btnMin.addEventListener("click", (e) => {
          e.stopPropagation();
          setMinimized(!minimized);
        });
      }

      if (btnClose) {
        btnClose.addEventListener("click", (e) => {
          e.stopPropagation();
          if (master) {
            const wv = window.chrome && window.chrome.webview;
            /* Close every other frame first, then this one; one host `close`. */
            layer._vfMasterTeardown = true;
            try {
              for (const el of Array.from(layer.querySelectorAll(".vf-frame"))) {
                if (el === root) continue;
                const p = el.__vfPanel;
                if (p && typeof p.destroy === "function") p.destroy();
              }
              if (wv && typeof wv.postMessage === "function") {
                wv.postMessage({ type: "close" });
              }
              api.destroy();
            } finally {
              layer._vfMasterTeardown = false;
            }
            return;
          }
          api.destroy();
        });
      }

      const wv0 = typeof window !== "undefined" && window.chrome && window.chrome.webview;
      /* In WebView2, default: drag the frame *inside* the view (1:1 with clientX).
       * Opt out with inLayerDrag: false to post vf-move and move the native host (only needed when
       * the frame is full-bleed and has no room in-layer; small vf-move subpixels were rounding to
       * 0 in native, causing stutter and non-1:1 feel). */
      const inLayerDrag = wv0 ? opt.inLayerDrag !== false : opt.inLayerDrag === true;
      const useHostWindowDrag = !!(
        draggable &&
        !frameless &&
        !inLayerDrag &&
        wv0 &&
        typeof wv0.postMessage === "function"
      );
      let hostLayoutRafId = 0;
      function postHitRegionsToHostImpl() {
        const wv = typeof window !== "undefined" && window.chrome && window.chrome.webview;
        if (!wv || typeof wv.postMessage !== "function") return;
        if (typeof VfFrame.postNativeHostLayout === "function") {
          VfFrame.postNativeHostLayout(layer, { stageAlpha: 0 });
        }
      }
      /** At most one layout post per frame while idle updates run; drag/resize paths can call immediate post. */
      function schedulePostHitRegionsToHost() {
        if (hostLayoutRafId) {
          return;
        }
        hostLayoutRafId = requestAnimationFrame(function () {
          hostLayoutRafId = 0;
          postHitRegionsToHostImpl();
        });
      }
      function flushPostHitRegionsToHost() {
        if (hostLayoutRafId) {
          cancelAnimationFrame(hostLayoutRafId);
          hostLayoutRafId = 0;
        }
        postHitRegionsToHostImpl();
      }

      if (useHostWindowDrag) {
        VfFrame.attachHostWindowDrag([head, minibar, dragHandle], { onDragStart: bringToFront });
      } else if (draggable && !frameless) {
        /* vf-overlay: keep region lock-step with pointer movement to avoid visible crop lag. */
        VfFrame.attachHeaderDrag({
          root,
          header: head,
          layer,
          onDragStart: bringToFront,
          onDragMove: postHitRegionsToHostImpl,
          onDragEnd: function () {
            flushPostHitRegionsToHost();
            enqueueFrameEvent({
              frameId: String(id),
              event: "frame.dragged",
              data: {
                left: root.style.left || "",
                top: root.style.top || "",
                width: root.style.width || "",
                height: root.style.height || "",
              },
            });
          },
        });
      }

      function attachPointerToFront(el) {
        if (!el) return;
        el.addEventListener(
          "pointerdown",
          () => {
            bringToFront();
          },
          true
        );
      }
      attachPointerToFront(head);
      attachPointerToFront(body);
      attachPointerToFront(minibar);
      if (resizable && !frameless) attachPointerToFront(resizeGrip);

      let resizeState = null;
      function onResizeMove(e) {
        if (!resizeState || e.pointerId !== resizeState.pid) return;
        const dx = e.clientX - resizeState.sx;
        const dy = e.clientY - resizeState.sy;
        let nw = resizeState.sw + dx;
        let nh = resizeState.sh + dy;
        nw = Math.max(resizeState.minW, nw);
        nh = Math.max(resizeState.minH, nh);
        root.classList.add("vf-frame--user-sized");
        root.style.width = Math.round(nw) + "px";
        root.style.height = Math.round(nh) + "px";
        postHitRegionsToHostImpl();
      }
      function onResizeEnd(e) {
        if (!resizeState || e.pointerId !== resizeState.pid) return;
        try {
          resizeGrip.releasePointerCapture(e.pointerId);
        } catch (_) {}
        resizeState = null;
        flushPostHitRegionsToHost();
        enqueueFrameEvent({
          frameId: String(id),
          event: "frame.resized",
          data: {
            left: root.style.left || "",
            top: root.style.top || "",
            width: root.style.width || "",
            height: root.style.height || "",
          },
        });
      }
      if (resizable && !frameless) {
        resizeGrip.addEventListener("pointerdown", (e) => {
          if (minimized) return;
          if (e.button !== 0) return;
          e.stopPropagation();
          e.preventDefault();
          bringToFront();
          const r = root.getBoundingClientRect();
          const minW = 200;
          const minH = minContentHeight();
          resizeState = {
            pid: e.pointerId,
            sx: e.clientX,
            sy: e.clientY,
            sw: r.width,
            sh: r.height,
            minW,
            minH,
          };
          try {
            resizeGrip.setPointerCapture(e.pointerId);
          } catch (_) {}
        });
        resizeGrip.addEventListener("pointermove", onResizeMove);
        resizeGrip.addEventListener("pointerup", onResizeEnd);
        resizeGrip.addEventListener("pointercancel", onResizeEnd);
      }

      function expandToFitContent() {
        /** @type {HTMLElement} */
        const b = body;
        const w = Math.max(b.scrollWidth + 8, 200);
        const h = Math.max(headerHeight() + b.scrollHeight + 8, minContentHeight());
        root.classList.add("vf-frame--user-sized");
        root.style.width = w + "px";
        root.style.height = h + "px";
      }

      const api = {
        id,
        root,
        header: head,
        titleEl,
        body,
        bringToFront,
        setMinimized,
        expandToFitContent,
        syncPointerPassThrough,
        renderTitle: scheduleRenderTitle,
        destroy() {
          if (typeof opt.onBeforeDestroy === "function") {
            try {
              opt.onBeforeDestroy(api);
            } catch (_) {}
          }
          root.remove();
          if (dockable) {
            try {
              VfFrame.layoutMinimizedDock(layer);
            } catch (_) {}
          }
          if (exitWhenLastFrameClosed && layer) {
            try {
              const rest = layer.querySelectorAll(".vf-frame");
              if (rest && rest.length === 0) {
                const wv = typeof globalThis !== "undefined" && globalThis.chrome && globalThis.chrome.webview;
                if (wv && typeof wv.postMessage === "function") {
                  wv.postMessage(JSON.stringify({ type: "close" }));
                }
              }
            } catch (_) {}
          }
          if (typeof opt.onFrameRemoved === "function") {
            try {
              opt.onFrameRemoved();
            } catch (_) {}
          }
        },
        close() {
          api.destroy();
        },
      };

      root.__vfPanel = api;

      bringToFront();
      return api;
    },
  };

  VfFrame.normalizeMinimizedDockKey = VfFrame.normalizeDockLocationKey;
  global.VfFrame = VfFrame;
})(typeof window !== "undefined" ? window : this);
