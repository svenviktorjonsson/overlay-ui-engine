/**
 * VKF — declarative widget bodies + host event queue (POST /api/enqueue).
 * State patches: vf-ui-state.json (polled) — from Python :meth:`Screen.widget_set`.
 */
(function (global) {
  "use strict";

  var reg = {};
  var lastStateText = "";
  var pollTimer = 0;
  var started = false;

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

  function enqueueEvent(obj) {
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

  function ensureRegFrame(fid) {
    if (!reg[fid]) {
      reg[fid] = {};
    }
    return reg[fid];
  }

  function storeWidget(fid, wid, o) {
    ensureRegFrame(fid)[wid] = o;
  }

  function clearFrameWidgets(fid) {
    delete reg[fid];
  }

  function applyPropsToNode(fid, wid, p) {
    if (!p || typeof p !== "object") return;
    var r = reg[fid] && reg[fid][wid];
    if (!r) return;
    if (p.text != null) {
      if (r.type === "label" && r.labelEl) {
        r.labelEl.textContent = String(p.text);
      }
      if (r.type === "textarea" && r.el) {
        r.el.value = String(p.text);
      }
      if (r.type === "input" && r.el) {
        r.el.value = String(p.text);
      }
    }
    if (p.label != null && (r.type === "button" || r.type === "checkbox") && r.el) {
      if (r.type === "button") {
        r.el.textContent = String(p.label);
      } else if (r.caption) {
        r.caption.textContent = String(p.label);
      }
    }
    if (p.checked != null && r.type === "checkbox" && r.el) {
      r.el.checked = !!p.checked;
    }
    if (p.value != null && r.type === "slider" && r.el) {
      var n = Number(p.value);
      if (Number.isFinite(n)) {
        r.el.value = String(n);
        if (r.valueLabel) {
          r.valueLabel.textContent = r.el.value;
        }
      }
    }
  }

  function loadAndApplyState() {
    if (typeof fetch === "undefined") return;
    fetch("vf-ui-state.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) return;
        return r.text();
      })
      .then(function (t) {
        if (t == null || t === lastStateText) return;
        lastStateText = t;
        var o;
        try {
          o = JSON.parse(t);
        } catch (_) {
          return;
        }
        if (!o || typeof o !== "object") return;
        for (var fid in o) {
          if (!Object.prototype.hasOwnProperty.call(o, fid)) continue;
          var wmap = o[fid];
          if (!wmap || typeof wmap !== "object") continue;
          for (var wid in wmap) {
            if (!Object.prototype.hasOwnProperty.call(wmap, wid)) continue;
            applyPropsToNode(String(fid), String(wid), wmap[wid]);
          }
        }
      })
      .catch(function () {});
  }

  function startStatePoll() {
    if (started) return;
    started = true;
    if (typeof window !== "undefined" && window.setInterval) {
      loadAndApplyState();
      pollTimer = window.setInterval(loadAndApplyState, 300);
    }
  }

  function onFrameClose(fid) {
    enqueueEvent({ frameId: String(fid), event: "frame.closed", data: {} });
  }

  function mountOne(panel, frameId, spec) {
    var w = (spec && spec.id != null) ? String(spec.id) : "";
    if (!w) {
      w = "w_" + String(Math.random()).slice(2, 8);
    }
    var t = (spec && spec.type) != null ? String(spec.type) : "label";
    if (t === "label") {
      var le = document.createElement("div");
      le.className = "vf-w-label";
      le.textContent = spec.text != null ? String(spec.text) : "";
      storeWidget(frameId, w, { type: "label", labelEl: le, id: w });
      return le;
    }
    if (t === "button") {
      var b = document.createElement("button");
      b.className = "vf-w-btn";
      b.type = "button";
      b.textContent = spec.label != null ? String(spec.label) : "Button";
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        enqueueEvent({
          frameId: String(frameId),
          widgetId: w,
          event: "button.pressed",
          data: {},
        });
      });
      storeWidget(frameId, w, { type: "button", el: b, id: w });
      return b;
    }
    if (t === "checkbox") {
      var row = document.createElement("label");
      row.className = "vf-w-check";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = spec.checked === true;
      var cap = document.createElement("span");
      cap.className = "vf-w-check-cap";
      cap.textContent = spec.label != null ? String(spec.label) : "";
      row.appendChild(cb);
      row.appendChild(cap);
      cb.addEventListener("change", function () {
        enqueueEvent({
          frameId: String(frameId),
          widgetId: w,
          event: "checkbox.toggled",
          data: { checked: !!cb.checked },
        });
      });
      storeWidget(frameId, w, { type: "checkbox", el: cb, caption: cap, id: w });
      return row;
    }
    if (t === "slider") {
      var row = document.createElement("div");
      row.className = "vf-w-slider";
      var rng = document.createElement("input");
      rng.className = "vf-w-range";
      rng.type = "range";
      var mn = spec.min != null ? Number(spec.min) : 0;
      var mx = spec.max != null ? Number(spec.max) : 1;
      var st = spec.step != null ? Number(spec.step) : 0.01;
      rng.min = String(Number.isFinite(mn) ? mn : 0);
      rng.max = String(Number.isFinite(mx) ? mx : 1);
      rng.step = String(Number.isFinite(st) && st > 0 ? st : 0.01);
      var vv = spec.value != null ? Number(spec.value) : 0;
      rng.value = String(Number.isFinite(vv) ? vv : 0);
      var vl = document.createElement("span");
      vl.className = "vf-w-slider-val";
      vl.textContent = rng.value;
      rng.addEventListener("input", function () {
        vl.textContent = rng.value;
        enqueueEvent({
          frameId: String(frameId),
          widgetId: w,
          event: "slider.value_changed",
          data: { value: Number(rng.value) },
        });
      });
      row.appendChild(rng);
      row.appendChild(vl);
      storeWidget(frameId, w, { type: "slider", el: rng, valueLabel: vl, id: w });
      return row;
    }
    if (t === "input") {
      var inp = document.createElement("input");
      inp.className = "vf-w-input";
      inp.type = "text";
      if (spec.placeholder) {
        inp.placeholder = String(spec.placeholder);
      }
      inp.value = spec.text != null ? String(spec.text) : "";
      var lastT = inp.value;
      inp.addEventListener("input", function () {
        var v = inp.value;
        if (v !== lastT) {
          lastT = v;
          enqueueEvent({
            frameId: String(frameId),
            widgetId: w,
            event: "input_field.text_changed",
            data: { text: v },
          });
        }
      });
      inp.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          enqueueEvent({
            frameId: String(frameId),
            widgetId: w,
            event: "input_field.text_entered",
            data: { text: String(inp.value) },
          });
        }
      });
      storeWidget(frameId, w, { type: "input", el: inp, id: w });
      return inp;
    }
    if (t === "textarea") {
      var ta = document.createElement("textarea");
      ta.className = "vf-w-textarea";
      ta.rows = 4;
      ta.value = spec.text != null ? String(spec.text) : "";
      var last2 = ta.value;
      ta.addEventListener("input", function () {
        var v2 = ta.value;
        if (v2 !== last2) {
          last2 = v2;
          enqueueEvent({
            frameId: String(frameId),
            widgetId: w,
            event: "text_area.text_changed",
            data: { text: v2 },
          });
        }
      });
      storeWidget(frameId, w, { type: "textarea", el: ta, id: w });
      return ta;
    }
    if (t === "dropdown") {
      var sel = document.createElement("select");
      sel.className = "vf-w-select";
      var opts = spec.options;
      if (Array.isArray(opts)) {
        for (var j = 0; j < opts.length; j++) {
          var o = document.createElement("option");
          o.value = String(j);
          o.textContent = String(opts[j]);
          sel.appendChild(o);
        }
      }
      var vi = spec.value != null ? parseInt(String(spec.value), 10) : 0;
      if (!Number.isFinite(vi) || vi < 0) {
        vi = 0;
      }
      if (sel.options.length > 0) {
        sel.selectedIndex = Math.min(vi, sel.options.length - 1);
      }
      sel.addEventListener("change", function () {
        var ix = sel.selectedIndex;
        var la = sel.options[ix] ? sel.options[ix].textContent : "";
        enqueueEvent({
          frameId: String(frameId),
          widgetId: w,
          event: "dropdown.item_changed",
          data: { index: ix, text: String(la) },
        });
      });
      storeWidget(frameId, w, { type: "dropdown", el: sel, id: w });
      return sel;
    }
    var d = document.createElement("div");
    d.className = "vf-w-unknown";
    d.textContent = "?" + t;
    return d;
  }

  function applyGridSlot(node, spec) {
    if (!node || !spec || !Array.isArray(spec.grid) || spec.grid.length !== 4) return;
    var row = Number(spec.grid[0]);
    var col = Number(spec.grid[1]);
    var rowSpan = Number(spec.grid[2]);
    var colSpan = Number(spec.grid[3]);
    if (!Number.isFinite(row) || !Number.isFinite(col) || !Number.isFinite(rowSpan) || !Number.isFinite(colSpan)) return;
    if (row < 0 || col < 0 || rowSpan <= 0 || colSpan <= 0) return;
    node.style.gridRow = String(Math.floor(row) + 1) + " / span " + String(Math.floor(rowSpan));
    node.style.gridColumn = String(Math.floor(col) + 1) + " / span " + String(Math.floor(colSpan));
  }

  function ensureDrawCanvas(body) {
    var c = body.querySelector("canvas.vf-frame__draw-canvas");
    if (c) {
      if (body.firstChild !== c) {
        body.insertBefore(c, body.firstChild);
      }
      return c;
    }
    c = document.createElement("canvas");
    c.className = "vf-frame__draw-canvas";
    c.setAttribute("aria-hidden", "true");
    body.insertBefore(c, body.firstChild);
    return c;
  }

  function mount(panel, frameId, bodyArr, bodyLayout) {
    if (!panel || !panel.body) return;
    clearFrameWidgets(String(frameId));
    var body = panel.body;
    ensureDrawCanvas(body);
    var ch = body.firstChild;
    while (ch) {
      var next = ch.nextSibling;
      if (!ch.classList || !ch.classList.contains("vf-frame__draw-canvas")) {
        body.removeChild(ch);
      }
      ch = next;
    }
    body.classList.remove("vf-w-stack", "vf-w-grid");
    if (bodyLayout && bodyLayout.type === "grid") {
      body.classList.add("vf-w-grid");
      var rows = Number(bodyLayout.rows);
      var cols = Number(bodyLayout.cols);
      body.style.setProperty("--vf-grid-rows", String(Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 1));
      body.style.setProperty("--vf-grid-cols", String(Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 1));
    } else {
      body.classList.add("vf-w-stack");
      body.style.removeProperty("--vf-grid-rows");
      body.style.removeProperty("--vf-grid-cols");
    }
    if (!Array.isArray(bodyArr) || bodyArr.length === 0) {
      if (typeof panel.expandToFitContent === "function") {
        panel.expandToFitContent();
      }
      return;
    }
    for (var i = 0; i < bodyArr.length; i++) {
      var node = mountOne(panel, String(frameId), bodyArr[i]);
      if (node) {
        applyGridSlot(node, bodyArr[i]);
        body.appendChild(node);
      }
    }
    if (typeof panel.expandToFitContent === "function") {
      panel.expandToFitContent();
    }
  }

  global.VfWidgets = {
    mount: mount,
    onFrameClose: onFrameClose,
    enqueue: enqueueEvent,
    startStatePoll: startStatePoll,
    clearFrame: clearFrameWidgets,
  };
})(typeof window !== "undefined" ? window : this);
