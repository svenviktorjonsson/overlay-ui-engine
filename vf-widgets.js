/**
 * VKF — declarative widget bodies + host event queue (POST /api/enqueue).
 * Preferred runtime path: explicit packet application from vf-runtime-packets.json.
 * Legacy fallback: vf-ui-state.json polling.
 */
(function (global) {
  "use strict";

  var reg = {};
  var lastStateText = "";
  var pollTimer = 0;
  var started = false;
  var buttonGroups = [];
  var buttonGroupState = Object.create(null);

  function buttonGroupStateKey(frameId, widgetId) {
    return String(frameId || "") + "::" + String(widgetId || "");
  }

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
    if (!obj || typeof obj !== "object") {
      obj = {};
    }
    if (obj.type == null) {
      obj.type = "vf_event";
    }
    if (obj.frame_id == null && obj.frameId != null) {
      obj.frame_id = String(obj.frameId);
    }
    if (obj.widget_id == null && obj.widgetId != null) {
      obj.widget_id = String(obj.widgetId);
    }
    try {
      // Keep vf_event traffic off the native WebMessage input path for now.
      // Widget/host events can travel over /api/enqueue just like the
      // non-WebView fallback, while non-vf_event host chrome messages still
      // use postMessage elsewhere.
      if (obj.type !== "vf_event" &&
          typeof window !== "undefined" &&
          window.chrome && window.chrome.webview &&
          window.chrome.webview.postMessage) {
        window.chrome.webview.postMessage(obj);
        return;
      }
    } catch (_) {}
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
    if (Array.isArray(buttonGroups) && buttonGroups.length) {
      buttonGroups = buttonGroups.filter(function (record) {
        return !(record && String(record.frameId || "") === String(fid || ""));
      });
    }
  }

  function makeDebouncedEmitter(delayMs) {
    var delay = Math.max(0, Number(delayMs || 0));
    var timer = 0;
    return function (eventObj) {
      if (!(delay > 0) || typeof window === "undefined" || typeof window.setTimeout !== "function") {
        enqueueEvent(eventObj);
        return;
      }
      if (timer && typeof window.clearTimeout === "function") {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(function () {
        timer = 0;
        enqueueEvent(eventObj);
      }, delay);
    };
  }

  function replaceSelectOptions(sel, opts, valueIndex) {
    if (!sel) return;
    while (sel.firstChild) {
      sel.removeChild(sel.firstChild);
    }
    if (Array.isArray(opts)) {
      for (var j = 0; j < opts.length; j++) {
        var o = document.createElement("option");
        o.value = String(j);
        o.textContent = String(opts[j]);
        sel.appendChild(o);
      }
    }
    var vi = Number(valueIndex);
    if (!Number.isFinite(vi) || vi < 0) {
      vi = 0;
    }
    if (sel.options.length > 0) {
      sel.selectedIndex = Math.min(Math.floor(vi), sel.options.length - 1);
    }
  }

  function replaceDatalistOptions(listEl, opts) {
    if (!listEl) return;
    while (listEl.firstChild) {
      listEl.removeChild(listEl.firstChild);
    }
    if (Array.isArray(opts)) {
      for (var j = 0; j < opts.length; j++) {
        var o = document.createElement("option");
        o.value = String(opts[j]);
        listEl.appendChild(o);
      }
    }
  }

  function setWidgetVisibility(node, visible) {
    if (!node) return;
    node.style.display = visible === false ? "none" : "";
  }

  function applyWidgetLayoutClasses(node, spec) {
    if (!node || !spec) return;
    if (spec.compact === true) {
      node.classList.add("vf-w-compact");
    }
    var align = spec.align != null ? String(spec.align).toLowerCase() : "";
    if (align === "left" || align === "start") {
      node.classList.add("vf-w-align-left");
    } else if (align === "right" || align === "end") {
      node.classList.add("vf-w-align-right");
    } else if (align === "center") {
      node.classList.add("vf-w-align-center");
    } else if (align === "stretch" || align === "fill") {
      node.classList.add("vf-w-align-stretch");
    }
  }

  function renderLabelText(el, raw) {
    if (!el) return;
    el.innerHTML = "";
    var s = raw != null ? String(raw) : "";
    if (!s) return;
    var katex = typeof window !== "undefined" ? window.katex : null;
    if (!katex || s.indexOf("$") < 0) {
      el.textContent = s;
      return;
    }
    var i = 0;
    while (i < s.length) {
      var start = s.indexOf("$", i);
      if (start < 0) {
        el.appendChild(document.createTextNode(s.slice(i)));
        break;
      }
      if (start > i) {
        el.appendChild(document.createTextNode(s.slice(i, start)));
      }
      var display = s.slice(start, start + 2) === "$$";
      var marker = display ? "$$" : "$";
      var bodyStart = start + marker.length;
      var end = s.indexOf(marker, bodyStart);
      if (end < 0) {
        el.appendChild(document.createTextNode(s.slice(start)));
        break;
      }
      var span = document.createElement("span");
      span.className = display ? "vf-w-label-math vf-w-label-math-display" : "vf-w-label-math";
      try {
        span.innerHTML = katex.renderToString(String(s.slice(bodyStart, end) || "").trim(), {
          displayMode: display,
          throwOnError: false
        });
      } catch (_) {
        span.textContent = marker + s.slice(bodyStart, end) + marker;
      }
      el.appendChild(span);
      i = end + marker.length;
    }
  }

  function setSliderRangeProp(el, key, value) {
    if (!el || value == null) return;
    var n = Number(value);
    if (Number.isFinite(n)) {
      el[key] = String(n);
    }
  }

  function applyPropsToNode(fid, wid, p) {
    if (!p || typeof p !== "object") return;
    var r = reg[fid] && reg[fid][wid];
    if (!r) return;
    if (p.visible != null) {
      setWidgetVisibility(r.root || r.el || r.labelEl, !!p.visible);
    }
    if (p.append_text != null && r.type === "textarea" && r.el) {
      var seq = Number(p.append_seq || 0);
      if (!Number.isFinite(seq)) seq = 0;
      if (!r.lastAppendSeq || seq > r.lastAppendSeq) {
        r.el.value = String(r.el.value || "") + String(p.append_text);
        r.el.scrollTop = r.el.scrollHeight;
        r.lastAppendSeq = seq;
      }
    }
    if (p.text != null) {
      if (r.type === "label" && r.labelEl) {
        renderLabelText(r.labelEl, p.text);
      }
      if (r.type === "textarea" && r.el) {
        r.el.value = String(p.text);
        r.el.scrollTop = r.el.scrollHeight;
      }
      if (r.type === "input" && r.el) {
        r.el.value = String(p.text);
      }
      if (r.type === "combobox" && r.el) {
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
      setSliderRangeProp(r.el, "min", p.min);
      setSliderRangeProp(r.el, "max", p.max);
      setSliderRangeProp(r.el, "step", p.step);
      var n = Number(p.value);
      if (Number.isFinite(n)) {
        r.el.value = String(n);
        if (r.valueLabel) {
          r.valueLabel.textContent = r.el.value;
        }
      }
    } else if (r.type === "slider" && r.el) {
      setSliderRangeProp(r.el, "min", p.min);
      setSliderRangeProp(r.el, "max", p.max);
      setSliderRangeProp(r.el, "step", p.step);
    }
    if (r.type === "dropdown" && r.el) {
      if (p.options != null) {
        replaceSelectOptions(r.el, p.options, p.value);
      } else if (p.value != null) {
        var ix = Number(p.value);
        if (Number.isFinite(ix) && ix >= 0 && r.el.options.length > 0) {
          r.el.selectedIndex = Math.min(Math.floor(ix), r.el.options.length - 1);
        }
      }
    }
    if (r.type === "combobox") {
      if (p.options != null) {
        replaceDatalistOptions(r.listEl, p.options);
      }
      if (p.value != null && r.el && r.listValues && Array.isArray(r.listValues)) {
        var comboIndex = Number(p.value);
        if (Number.isFinite(comboIndex) && comboIndex >= 0 && comboIndex < r.listValues.length) {
          r.el.value = String(r.listValues[Math.floor(comboIndex)]);
        }
      }
      if (p.options != null && Array.isArray(p.options)) {
        r.listValues = p.options.slice();
      }
    }
    if (r.type === "color_picker" && r.el) {
      if (p.value != null) {
        r.el.value = String(p.value);
      }
    }
    if (r.type === "stackframe" && r.root) {
      if (p.active != null) {
        setStackFrameActive(r, String(p.active));
      } else if (p.value != null && Array.isArray(r.childKeys)) {
        var activeIndex = Number(p.value);
        if (Number.isFinite(activeIndex) && activeIndex >= 0 && activeIndex < r.childKeys.length) {
          setStackFrameActive(r, String(r.childKeys[Math.floor(activeIndex)]));
        }
      }
    }
    if (r.type === "button_group" && r.root) {
      if (p.active != null) {
        setButtonGroupActive(r, String(p.active), false);
      } else if (p.value != null && Array.isArray(r.options)) {
        var bgIndex = Number(p.value);
        if (Number.isFinite(bgIndex) && bgIndex >= 0 && bgIndex < r.options.length) {
          setButtonGroupActive(r, String(r.options[Math.floor(bgIndex)].value), false);
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

  function applyStateObject(o) {
    if (!o || typeof o !== "object") return;
    for (var fid in o) {
      if (!Object.prototype.hasOwnProperty.call(o, fid)) continue;
      var byId = o[fid];
      if (!byId || typeof byId !== "object") continue;
      for (var wid in byId) {
        if (!Object.prototype.hasOwnProperty.call(byId, wid)) continue;
        applyPropsToNode(String(fid), String(wid), byId[wid]);
      }
    }
  }

  function applyRuntimePacket(packet) {
    if (!packet || typeof packet !== "object") return;
    var kind = String(packet.kind || "");
    var payload = packet.payload;
    if (kind === "ui_state.replace" && payload && typeof payload.state === "object") {
      applyStateObject(payload.state);
      return;
    }
    if (kind === "widget.append_text" && payload) {
      applyPropsToNode(String(payload.frame_id || ""), String(payload.widget_id || ""), {
        append_text: payload.text,
        append_seq: payload.append_seq
      });
    }
  }

  function startStatePoll() {
    if (started) return;
    started = true;
    if (typeof window !== "undefined" && window.setInterval) {
      loadAndApplyState();
      pollTimer = window.setInterval(loadAndApplyState, 16);
    }
  }

  function stopStatePoll() {
    if (!started) return;
    started = false;
    if (pollTimer && typeof window !== "undefined" && window.clearInterval) {
      window.clearInterval(pollTimer);
    }
    pollTimer = 0;
  }

  function onFrameClose(fid) {
    enqueueEvent({ frameId: String(fid), event: "frame.closed", data: {} });
  }

  function widgetRecord(frameId, widgetId) {
    var frame = reg[String(frameId || "")];
    return frame ? frame[String(widgetId || "")] || null : null;
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
      applyWidgetLayoutClasses(le, spec);
      renderLabelText(le, spec.text != null ? String(spec.text) : "");
      setWidgetVisibility(le, spec.visible !== false);
      storeWidget(frameId, w, { type: "label", labelEl: le, root: le, id: w });
      return le;
    }
    if (t === "plot_panel") {
      var panel = document.createElement("div");
      panel.className = "vf-w-plot-panel";
      applyWidgetLayoutClasses(panel, spec);
      panel.setAttribute("data-vf-plot-panel", "1");
      var canvas = document.createElement("canvas");
      canvas.className = "vf-w-plot-panel__canvas";
      canvas.setAttribute("aria-hidden", "true");
      panel.appendChild(canvas);
      setWidgetVisibility(panel, spec.visible !== false);
      storeWidget(frameId, w, { type: "plot_panel", el: canvas, root: panel, id: w });
      return panel;
    }
    if (t === "stackframe") {
      var stack = document.createElement("div");
      stack.className = "vf-w-stackframe";
      applyWidgetLayoutClasses(stack, spec);
      var children = Array.isArray(spec.children) ? spec.children : [];
      var childKeys = [];
      var childNodes = Object.create(null);
      for (var si = 0; si < children.length; si++) {
        var childSpec = children[si] || {};
        var childKey = childSpec.key != null
          ? String(childSpec.key)
          : (childSpec.id != null ? String(childSpec.id) : String(si));
        var childNode = mountOne(panel, frameId, childSpec);
        if (!childNode) { continue; }
        childNode.classList.add("vf-w-stackframe__child");
        childNode.setAttribute("data-vf-stack-key", childKey);
        childKeys.push(childKey);
        childNodes[childKey] = childNode;
        stack.appendChild(childNode);
      }
      var record = { type: "stackframe", root: stack, id: w, childKeys: childKeys, childNodes: childNodes, active: "" };
      storeWidget(frameId, w, record);
      setStackFrameActive(record, spec.active != null ? String(spec.active) : (childKeys[0] || ""));
      setWidgetVisibility(stack, spec.visible !== false);
      return stack;
    }
    if (t === "button") {
      var b = document.createElement("button");
      b.className = "vf-w-btn";
      applyWidgetLayoutClasses(b, spec);
      b.type = "button";
      b.textContent = spec.label != null ? String(spec.label) : "Button";
      var lastButtonEmitAt = 0;
      function emitButtonPressed(e) {
        var now = (global.performance && typeof global.performance.now === "function")
          ? global.performance.now()
          : Date.now();
        if (now - lastButtonEmitAt < 120) { return; }
        lastButtonEmitAt = now;
        if (e && typeof e.stopPropagation === "function") { e.stopPropagation(); }
        enqueueEvent({
          frameId: String(frameId),
          widgetId: w,
          event: "button.pressed",
          data: {},
        });
      }
      b.addEventListener("pointerup", function (e) {
        if (e && Number(e.button || 0) !== 0) { return; }
        emitButtonPressed(e);
      });
      b.addEventListener("click", function (e) {
        emitButtonPressed(e);
      });
      setWidgetVisibility(b, spec.visible !== false);
      storeWidget(frameId, w, { type: "button", el: b, root: b, id: w });
      return b;
    }
    if (t === "button_group") {
      var group = document.createElement("div");
      group.className = "vf-w-button-group";
      applyWidgetLayoutClasses(group, spec);
      group.setAttribute("role", "group");
      var opts = Array.isArray(spec.options) ? spec.options : [];
      var buttons = Object.create(null);
      var normalized = [];
      for (var oi = 0; oi < opts.length; oi++) {
        var opt = opts[oi] || {};
        var value = opt.value != null ? String(opt.value) : String(oi);
        var btn = document.createElement("button");
        btn.className = "vf-w-button-group__btn";
        btn.type = "button";
        btn.textContent = opt.label != null ? String(opt.label) : value;
        btn.setAttribute("data-vf-button-group-value", value);
        group.appendChild(btn);
        buttons[value] = btn;
        normalized.push({
          value: value,
          label: opt.label != null ? String(opt.label) : value,
          targetFrame: opt.target_frame != null ? String(opt.target_frame) : (opt.targetFrame != null ? String(opt.targetFrame) : "")
        });
        btn.addEventListener("click", function (e) {
          var v = this.getAttribute("data-vf-button-group-value") || "";
          setButtonGroupActive(record, v, true);
          if (e && typeof e.stopPropagation === "function") { e.stopPropagation(); }
        });
      }
      var record = {
        type: "button_group",
        root: group,
        id: w,
        frameId: String(frameId),
        options: normalized,
        buttons: buttons,
        active: ""
      };
      storeWidget(frameId, w, record);
      buttonGroups.push(record);
      var remembered = buttonGroupState[buttonGroupStateKey(frameId, w)];
      var initialActive = remembered != null
        ? String(remembered)
        : (spec.active != null ? String(spec.active) : (normalized[0] ? normalized[0].value : ""));
      setButtonGroupActive(record, initialActive, false);
      setWidgetVisibility(group, spec.visible !== false);
      return group;
    }
    if (t === "checkbox") {
      var row = document.createElement("label");
      row.className = "vf-w-check";
      applyWidgetLayoutClasses(row, spec);
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = spec.checked === true;
      var cap = document.createElement("span");
      cap.className = "vf-w-check-cap";
      cap.textContent = spec.label != null ? String(spec.label) : "";
      row.appendChild(cb);
      row.appendChild(cap);
      cb.addEventListener("change", function () {
        if ((spec.axis_log_target_frame || spec.axis_log_target_frames) && spec.axis) {
          try {
            if (global.VfDisplay && typeof global.VfDisplay.setAxisTickMode === "function") {
              var targets = Array.isArray(spec.axis_log_target_frames) ? spec.axis_log_target_frames : [spec.axis_log_target_frame];
              for (var ti = 0; ti < targets.length; ti += 1) {
                if (targets[ti] != null) {
                  global.VfDisplay.setAxisTickMode(String(targets[ti]), String(spec.axis), cb.checked ? "log" : "linear");
                }
              }
            }
          } catch (_) {}
        }
        enqueueEvent({
          frameId: String(frameId),
          widgetId: w,
          event: "checkbox.toggled",
          data: { checked: !!cb.checked },
        });
      });
      setWidgetVisibility(row, spec.visible !== false);
      storeWidget(frameId, w, { type: "checkbox", el: cb, caption: cap, root: row, id: w });
      return row;
    }
    if (t === "slider") {
      var row = document.createElement("div");
      row.className = "vf-w-slider";
      applyWidgetLayoutClasses(row, spec);
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
      setWidgetVisibility(row, spec.visible !== false);
      storeWidget(frameId, w, { type: "slider", el: rng, valueLabel: vl, root: row, id: w });
      return row;
    }
    if (t === "input") {
      var inp = document.createElement("input");
      inp.className = "vf-w-input";
      applyWidgetLayoutClasses(inp, spec);
      inp.type = "text";
      if (spec.placeholder) {
        inp.placeholder = String(spec.placeholder);
      }
      inp.value = spec.text != null ? String(spec.text) : "";
      var emitInputChanged = makeDebouncedEmitter(spec.debounce_ms);
      var lastT = inp.value;
      inp.addEventListener("input", function () {
        var v = inp.value;
        if (v !== lastT) {
          lastT = v;
          emitInputChanged({
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
      setWidgetVisibility(inp, spec.visible !== false);
      storeWidget(frameId, w, { type: "input", el: inp, root: inp, id: w });
      return inp;
    }
    if (t === "textarea") {
      var ta = document.createElement("textarea");
      ta.className = "vf-w-textarea";
      applyWidgetLayoutClasses(ta, spec);
      var rows = spec.rows != null ? parseInt(String(spec.rows), 10) : 4;
      ta.rows = Number.isFinite(rows) && rows > 0 ? rows : 4;
      ta.readOnly = !!spec.readonly;
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
      setWidgetVisibility(ta, spec.visible !== false);
      storeWidget(frameId, w, { type: "textarea", el: ta, root: ta, id: w });
      return ta;
    }
    if (t === "dropdown") {
      var sel = document.createElement("select");
      sel.className = "vf-w-select";
      applyWidgetLayoutClasses(sel, spec);
      var opts = spec.options;
      var vi = spec.value != null ? parseInt(String(spec.value), 10) : 0;
      replaceSelectOptions(sel, opts, vi);
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
      setWidgetVisibility(sel, spec.visible !== false);
      storeWidget(frameId, w, { type: "dropdown", el: sel, root: sel, id: w });
      return sel;
    }
    if (t === "combobox") {
      var wrap = document.createElement("div");
      wrap.className = "vf-w-combobox";
      applyWidgetLayoutClasses(wrap, spec);
      var combo = document.createElement("input");
      combo.className = "vf-w-input";
      combo.type = "text";
      var listId = "vf_w_list_" + String(frameId) + "_" + String(w);
      combo.setAttribute("list", listId);
      if (spec.placeholder) {
        combo.placeholder = String(spec.placeholder);
      }
      var listEl = document.createElement("datalist");
      listEl.id = listId;
      var comboOptions = Array.isArray(spec.options) ? spec.options.slice() : [];
      replaceDatalistOptions(listEl, comboOptions);
      if (spec.text != null) {
        combo.value = String(spec.text);
      } else {
        var comboVi = spec.value != null ? parseInt(String(spec.value), 10) : 0;
        if (Number.isFinite(comboVi) && comboVi >= 0 && comboVi < comboOptions.length) {
          combo.value = String(comboOptions[comboVi]);
        }
      }
      var lastComboText = combo.value;
      var emitComboChanged = makeDebouncedEmitter(spec.debounce_ms);
      combo.addEventListener("input", function () {
        var val = combo.value;
        if (val !== lastComboText) {
          lastComboText = val;
          emitComboChanged({
            frameId: String(frameId),
            widgetId: w,
            event: "combobox.text_changed",
            data: { text: val },
          });
        }
      });
      combo.addEventListener("change", function () {
        var val = String(combo.value);
        var ix = comboOptions.indexOf(val);
        enqueueEvent({
          frameId: String(frameId),
          widgetId: w,
          event: "combobox.item_changed",
          data: { index: ix, text: val },
        });
      });
      combo.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          enqueueEvent({
            frameId: String(frameId),
            widgetId: w,
            event: "combobox.text_entered",
            data: { text: String(combo.value) },
          });
        }
      });
      wrap.appendChild(combo);
      wrap.appendChild(listEl);
      setWidgetVisibility(wrap, spec.visible !== false);
      storeWidget(frameId, w, { type: "combobox", el: combo, listEl: listEl, listValues: comboOptions, root: wrap, id: w });
      return wrap;
    }
    if (t === "color_picker") {
      var color = document.createElement("input");
      color.className = "vf-w-input";
      applyWidgetLayoutClasses(color, spec);
      color.type = "color";
      color.value = spec.value != null ? String(spec.value) : "#34db8f";
      color.addEventListener("input", function () {
        enqueueEvent({
          frameId: String(frameId),
          widgetId: w,
          event: "color_picker.value_changed",
          data: { value: String(color.value) },
        });
      });
      setWidgetVisibility(color, spec.visible !== false);
      storeWidget(frameId, w, { type: "color_picker", el: color, root: color, id: w });
      return color;
    }
    var d = document.createElement("div");
    d.className = "vf-w-unknown";
    d.textContent = "?" + t;
    return d;
  }

  function setStackFrameActive(record, active) {
    if (!record || !record.childNodes) return;
    var next = String(active || "");
    if (!next && Array.isArray(record.childKeys) && record.childKeys.length > 0) {
      next = String(record.childKeys[0]);
    }
    record.active = next;
    for (var key in record.childNodes) {
      if (!Object.prototype.hasOwnProperty.call(record.childNodes, key)) continue;
      record.childNodes[key].style.display = key === next ? "" : "none";
    }
    if (typeof global.requestAnimationFrame === "function") {
      global.requestAnimationFrame(function () {
        try { global.dispatchEvent(new Event("resize")); } catch (_) {}
      });
    }
  }

  function setButtonGroupActive(record, active, emit) {
    if (!record || !record.root) return;
    var next = String(active || "");
    if (!next && Array.isArray(record.options) && record.options.length) {
      next = String(record.options[0].value || "");
    }
    var same = record.active === next;
    record.active = next;
    buttonGroupState[buttonGroupStateKey(record.frameId, record.id)] = next;
    var targets = [];
    for (var i = 0; Array.isArray(record.options) && i < record.options.length; i++) {
      var opt = record.options[i] || {};
      var value = String(opt.value || "");
      var btn = record.buttons ? record.buttons[value] : null;
      var selected = value === next;
      if (btn) {
        btn.classList.toggle("vf-w-button-group__btn--active", selected);
        btn.setAttribute("aria-pressed", selected ? "true" : "false");
      }
      if (opt.targetFrame) {
        targets.push({ frameId: String(opt.targetFrame), selected: selected });
      }
    }
    function applyTargetVisibility() {
      if (typeof document === "undefined") return;
      var changed = false;
      for (var ti = 0; ti < targets.length; ti++) {
        var fid = targets[ti].frameId;
        var el = document.querySelector && document.querySelector(".vf-frame[data-vf-frame-id=\"" + fid.replace(/["\\]/g, "") + "\"]");
        if (!el) continue;
        var nextDisplay = targets[ti].selected ? "" : "none";
        if (el.style.display !== nextDisplay) { changed = true; }
        el.style.display = nextDisplay;
        el.classList.toggle("vf-frame--button-group-active", targets[ti].selected);
      }
      if (changed && global.VfDisplay && typeof global.VfDisplay.redrawVisibleGeomFrames === "function") {
        try { global.VfDisplay.redrawVisibleGeomFrames(); } catch (_) {}
      }
      if (changed && typeof global.requestAnimationFrame === "function") {
        global.requestAnimationFrame(function () {
          try {
            if (global.VfDisplay && typeof global.VfDisplay.redrawVisibleGeomFrames === "function") {
              global.VfDisplay.redrawVisibleGeomFrames();
            }
          } catch (_) {}
          try { global.dispatchEvent(new Event("resize")); } catch (_) {}
        });
      }
    }
    applyTargetVisibility();
    if (emit === true && !same) {
      enqueueEvent({
        frameId: String(record.frameId || ""),
        widgetId: String(record.id || ""),
        event: "button_group.changed",
        data: { value: next, text: next }
      });
    }
  }

  function refreshButtonGroups() {
    for (var i = 0; i < buttonGroups.length; i++) {
      var r = buttonGroups[i];
      if (r && r.root && r.root.isConnected !== false) {
        setButtonGroupActive(r, r.active, false);
      }
    }
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
      if (bodyLayout.columns != null) {
        body.style.setProperty("--vf-grid-template-columns", String(bodyLayout.columns));
      } else {
        body.style.removeProperty("--vf-grid-template-columns");
      }
      if (bodyLayout.row_heights != null) {
        body.style.setProperty("--vf-grid-template-rows", String(bodyLayout.row_heights));
      } else {
        body.style.removeProperty("--vf-grid-template-rows");
      }
    } else {
      body.classList.add("vf-w-stack");
      body.style.removeProperty("--vf-grid-rows");
      body.style.removeProperty("--vf-grid-cols");
      body.style.removeProperty("--vf-grid-template-columns");
      body.style.removeProperty("--vf-grid-template-rows");
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
    stopStatePoll: stopStatePoll,
    applyStateObject: applyStateObject,
    applyRuntimePacket: applyRuntimePacket,
    clearFrame: clearFrameWidgets,
    widgetRecord: widgetRecord,
    refreshButtonGroups: refreshButtonGroups,
  };
})(typeof window !== "undefined" ? window : this);
