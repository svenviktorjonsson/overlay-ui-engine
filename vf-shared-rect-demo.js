(function (global) {
  "use strict";

  function assertRuntime(name) {
    if (!global[name]) {
      throw new Error(name + " must be loaded before vf-shared-rect-demo.js");
    }
    return global[name];
  }

  function makeTrackedAdapter() {
    return {
      writes: [],
      writeBuffer: function (offset, bytes) {
        this.writes.push({
          offset: offset,
          byteLength: bytes.byteLength
        });
      }
    };
  }

  function draw(ctx, canvas, rects, meshes) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (var i = 0; i < rects.length; i++) {
      var ref = rects[i];
      var rect = ref.world_rect();
      ctx.fillStyle = rgba(ref.color);
      ctx.fillRect(
        Math.round(rect.x),
        Math.round(rect.y),
        Math.round(rect.w),
        Math.round(rect.h)
      );
    }
    for (var m = 0; m < meshes.length; m++) {
      drawMesh(ctx, meshes[m]);
    }
  }

  function drawMesh(ctx, mesh) {
    var i;
    ctx.fillStyle = rgba(mesh.face_color);
    for (i = 0; i < mesh.faces.length; i++) {
      var face = mesh.faces[i];
      if (face.length < 3) {
        continue;
      }
      ctx.beginPath();
      var first = mesh.world_point(face[0]);
      ctx.moveTo(first[0], first[1]);
      for (var j = 1; j < face.length; j++) {
        var p = mesh.world_point(face[j]);
        ctx.lineTo(p[0], p[1]);
      }
      ctx.closePath();
      ctx.fill();
    }
    if (hasVisibleEdges(mesh)) {
      ctx.strokeStyle = rgba(mesh.edge_color);
      ctx.lineCap = edgeLineCap(mesh);
      if (typeof ctx.save === "function") {
        ctx.save();
      }
      if (typeof ctx.setLineDash === "function") {
        ctx.setLineDash(edgeDashPattern(mesh));
      }
      for (i = 0; i < mesh.edges.length; i++) {
        var edgeWidth = edgeWidthAt(mesh, i);
        if (edgeWidth <= 0) {
          continue;
        }
        var edge = mesh.edges[i];
        var a = mesh.world_point(edge[0]);
        var b = mesh.world_point(edge[1]);
        ctx.lineWidth = edgeWidth * 2;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
      if (typeof ctx.restore === "function") {
        ctx.restore();
      } else if (typeof ctx.setLineDash === "function") {
        ctx.setLineDash([]);
      }
    }
    if (hasVisibleVertices(mesh)) {
      ctx.fillStyle = rgba(mesh.vertex_color);
      for (i = 0; i < mesh.vertices.length; i++) {
        var vertexRadius = vertexRadiusAt(mesh, i);
        if (vertexRadius <= 0) {
          continue;
        }
        var v = mesh.world_point(mesh.vertices[i]);
        drawVertexShape(ctx, v[0], v[1], vertexRadius, mesh.vertex_style || mesh.vertex_shape);
      }
    }
  }

  function hasVisibleEdges(mesh) {
    for (var i = 0; mesh && i < mesh.edges.length; i++) {
      if (edgeWidthAt(mesh, i) > 0) {
        return true;
      }
    }
    return false;
  }

  function hasVisibleVertices(mesh) {
    for (var i = 0; mesh && i < mesh.vertices.length; i++) {
      if (vertexRadiusAt(mesh, i) > 0) {
        return true;
      }
    }
    return false;
  }

  function vertexRadiusAt(mesh, index) {
    if (mesh && typeof mesh.vertex_radius_at === "function") {
      return Number(mesh.vertex_radius_at(index)) || 0;
    }
    return Number(mesh && mesh.vertex_radius) || 0;
  }

  function edgeWidthAt(mesh, index) {
    if (mesh && typeof mesh.edge_width_at === "function") {
      return Number(mesh.edge_width_at(index)) || 0;
    }
    if (mesh && typeof mesh.edge_radius_at === "function") {
      return Number(mesh.edge_radius_at(index)) || 0;
    }
    return Number(mesh && (mesh.edge_width != null ? mesh.edge_width : mesh.edge_radius)) || 0;
  }

  function edgeDashPattern(mesh) {
    if (Array.isArray(mesh.edge_dash)) {
      return mesh.edge_dash.map(function (value) {
        return Math.max(0, Number(value) || 0);
      });
    }
    var style = mesh.edge_style != null ? mesh.edge_style : (mesh.edge_pattern || mesh.edgePattern || "-");
    var pattern = String(style).toLowerCase();
    if (pattern === "solid") {
      return [];
    }
    if (pattern === "dash" || pattern === "dashed") {
      pattern = "- ";
    }
    if (pattern === "dot" || pattern === "dotted") {
      pattern = ". ";
    }
    return edgeStyleToDash(pattern, Number(mesh.edge_unit_length) || 8);
  }

  function edgeStyleToDash(style, unit) {
    if (style.indexOf(" ") < 0) {
      return [];
    }
    var out = [];
    var visible = style[0] !== " ";
    var count = 0;
    for (var i = 0; i < style.length; i++) {
      var nextVisible = style[i] !== " ";
      if (nextVisible === visible) {
        count++;
        continue;
      }
      out.push(edgeStyleRunLength(style, i - count, count, visible, unit));
      visible = nextVisible;
      count = 1;
    }
    out.push(edgeStyleRunLength(style, style.length - count, count, visible, unit));
    if (out.length % 2 === 1) {
      out.push(0);
    }
    return out;
  }

  function edgeStyleRunLength(style, start, count, visible, unit) {
    if (!visible) {
      return count * unit;
    }
    if (count === 1 && style[start] === ".") {
      return 0;
    }
    return count * unit;
  }

  function edgeLineCap(mesh) {
    var pattern = String(mesh.edge_style != null ? mesh.edge_style : (mesh.edge_pattern || mesh.edgePattern || "-")).toLowerCase();
    if (pattern === "dot" || pattern === "dotted" || /^(\. +)+\.?$/.test(pattern)) {
      return "round";
    }
    if (pattern === "dash" || pattern === "dashed" || pattern.indexOf(" ") >= 0 || Array.isArray(mesh.edge_dash)) {
      return "butt";
    }
    return "round";
  }

  function drawVertexShape(ctx, x, y, radius, shape) {
    var r = Number(radius) || 0;
    var vertexShape = String(shape || "circle").toLowerCase();
    ctx.beginPath();
    if (vertexShape === "square") {
      if (typeof ctx.rect === "function") {
        ctx.rect(x - r, y - r, r * 2, r * 2);
      } else {
        ctx.moveTo(x - r, y - r);
        ctx.lineTo(x + r, y - r);
        ctx.lineTo(x + r, y + r);
        ctx.lineTo(x - r, y + r);
        ctx.closePath();
      }
    } else if (vertexShape === "triangle") {
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.lineTo(x - r, y + r);
      ctx.closePath();
    } else {
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  function rgba(color) {
    var c = color || [1, 1, 1, 1];
    return "rgba(" +
      Math.round((Number(c[0]) || 0) * 255) + "," +
      Math.round((Number(c[1]) || 0) * 255) + "," +
      Math.round((Number(c[2]) || 0) * 255) + "," +
      (Number.isFinite(Number(c[3])) ? Number(c[3]) : 1) +
      ")";
  }

  function resizeCanvasToPanel(canvas) {
    var r = canvas.getBoundingClientRect();
    var dpr = global.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(r.width * dpr));
    var h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { w: w, h: h, dpr: dpr };
  }

  function createDemo(canvas) {
    var shared = assertRuntime("VfSharedRuntime");
    var vkfUi = assertRuntime("VfVkfUiRuntime");
    var gpu = assertRuntime("VfGpuRuntime");
    var wasmContract = assertRuntime("VfWasmDemoContract");
    var ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D canvas context unavailable");
    }

    var initialSize = resizeCanvasToPanel(canvas);
    var arena = shared.createTransformArena(64);
    var geometryArena = shared.createGeometryArena(256);
    var eventArena = shared.createEventArena(32);
    var uiRuntime = vkfUi.createVkfUiRuntime({
      arena: arena,
      geometryArena: geometryArena,
      eventArena: eventArena,
      width: initialSize.w,
      height: initialSize.h
    });
    var adapter = makeTrackedAdapter();
    var renderer = gpu.createTransformRenderer({ arena: arena, adapter: adapter });
    var sequence = 0;
    var dragging = false;
    var activeObjectId = -1;
    var activeHover = null;
    var anchor = { x: 0, y: 0 };
    var keyMask = 0;

    var compiledCoreStandIn = assertRuntime("VfSharedRectProgram").create();
    var contract = wasmContract.createWasmDemoContract({
      demo: compiledCoreStandIn,
      arena: arena,
      eventArena: eventArena,
      uiRuntime: uiRuntime
    });

    function canvasPoint(event) {
      var r = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - r.left) * (canvas.width / r.width),
        y: (event.clientY - r.top) * (canvas.height / r.height)
      };
    }

    function pickElement(point) {
      var frame = uiRuntime.ui.display.last_frame;
      return frame ? frame.pick([point.x, point.y]) : null;
    }

    function hoverFromPick(picked) {
      if (!picked) {
        return null;
      }
      if (picked.hover) {
        return {
          object: picked.hover.object_id,
          vertex: picked.hover.vertex_id,
          edge: picked.hover.edge_id,
          face: picked.hover.face_id,
          mask: picked.hover.mask,
          kind: picked.hover.kind
        };
      }
      return { object: picked.id };
    }

    function idFromPick(picked) {
      if (!picked) {
        return -1;
      }
      return picked.hover ? picked.hover.object_id : picked.id;
    }

    function targetFromObjectId(objectId) {
      var frame = uiRuntime.ui.display.last_frame;
      if (!frame || objectId < 0) {
        return null;
      }
      return frame.get({ object_id: objectId });
    }

    function localPointForTarget(target, point) {
      var space = target && target.parent && typeof target.parent.inner_from_world === "function"
        ? target.parent
        : null;
      if (space) {
        return space.inner_from_world([point.x, point.y, 0]).slice(0, 2);
      }
      return [point.x, point.y];
    }

    function maskFromEvent(event) {
      var mask = 0;
      if (event && event.ctrlKey) { mask |= 1; }
      if (event && event.shiftKey) { mask |= 2; }
      if (event && event.altKey) { mask |= 4; }
      if (event && event.metaKey) { mask |= 8; }
      return mask;
    }

    function setKeyboardMask(mask) {
      keyMask = mask | 0;
      uiRuntime.ui.keyboard.set_mask(keyMask);
    }

    function updateFromPointer(point, down, event) {
      if (event) {
        setKeyboardMask(maskFromEvent(event));
      }
      var picked = pickElement(point);
      var hover = hoverFromPick(picked);
      var objectId = idFromPick(picked);
      if (dragging && activeHover) {
        hover = activeHover;
        objectId = activeObjectId;
      }
      var target = targetFromObjectId(objectId);
      var localCursor = localPointForTarget(target, point);
      var localAnchor = localPointForTarget(target, anchor);
      eventArena.writeInputSample({
        sequence: ++sequence,
        timeMs: performance.now(),
        cursorPx: [point.x, point.y],
        pointerAnchorPx: [anchor.x, anchor.y],
        localCursor: localCursor,
        localAnchor: localAnchor,
        pointerDown: down,
        buttons: down ? 1 : 0,
        keyMask: keyMask,
        hover: hover || (activeObjectId >= 0 ? { object: activeObjectId } : null)
      });
      contract.update();
      renderer.flushDirtyTransforms();
      anchor = point;
      if (objectId >= 0) {
        activeObjectId = objectId;
      }
      if (hover && !dragging) {
        activeHover = hover;
      }
    }

    canvas.addEventListener("pointerdown", function (event) {
      var point = canvasPoint(event);
      var picked = pickElement(point);
      if (!picked) {
        return;
      }
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      dragging = true;
      activeObjectId = idFromPick(picked);
      activeHover = hoverFromPick(picked);
      anchor = point;
      updateFromPointer(point, true, event);
    });

    canvas.addEventListener("pointermove", function (event) {
      if (!dragging) {
        return;
      }
      event.preventDefault();
      updateFromPointer(canvasPoint(event), true, event);
    });

    canvas.addEventListener("pointerup", function (event) {
      if (!dragging) {
        return;
      }
      dragging = false;
      updateFromPointer(canvasPoint(event), false, event);
      activeObjectId = -1;
      activeHover = null;
    });

    canvas.addEventListener("pointercancel", function () {
      dragging = false;
      activeObjectId = -1;
      activeHover = null;
    });

    global.addEventListener("keydown", function (event) {
      setKeyboardMask(maskFromEvent(event));
    });

    global.addEventListener("keyup", function (event) {
      setKeyboardMask(maskFromEvent(event));
    });

    contract.init();
    renderer.flushDirtyTransforms();
    global.addEventListener("resize", function () {
      var size = resizeCanvasToPanel(canvas);
      uiRuntime.ui.display.set_size({ width: size.w, height: size.h });
    });

    function frame() {
      var size = resizeCanvasToPanel(canvas);
      uiRuntime.ui.display.set_size({ width: size.w, height: size.h });
      draw(ctx, canvas, uiRuntime.rects, uiRuntime.meshes);
      global.requestAnimationFrame(frame);
    }
    global.requestAnimationFrame(frame);

    return {
      arena: arena,
      eventArena: eventArena,
      adapter: adapter,
      renderer: renderer,
      contract: contract,
      getRect: function () {
        return uiRuntime.rects[0] ? uiRuntime.rects[0].world_rect() : null;
      },
      getRects: function () {
        return uiRuntime.rects.map(function (ref) {
          return ref.world_rect();
        });
      },
      getMeshes: function () {
        return uiRuntime.meshes.map(function (mesh) {
          return {
            points: mesh.world_points(),
            vertexRadius: mesh.vertex_radius,
            edgeRadius: mesh.edge_radius
          };
        });
      },
      getWrites: function () {
        return adapter.writes.slice();
      },
      getLatestInput: function () {
        return eventArena.latestSample();
      },
      isDragging: function () {
        return dragging;
      }
    };
  }

  global.VfSharedRectDemo = {
    createDemo: createDemo,
    drawMesh: drawMesh
  };

  global.addEventListener("DOMContentLoaded", function () {
    var layer = document.getElementById("layer");
    if (!layer) {
      throw new Error("vf-shared-rect-demo requires #layer");
    }
    var frameApi = global.VfFrame.mount(layer, {
      id: "shared-runtime-demo",
      title: "Shared runtime demo",
      titleAlign: "left",
      draggable: true,
      dockable: true,
      resizable: true,
      closable: true,
      alpha: 0.96,
      master: true,
      dockLocation: "bl",
      exitWhenLastFrameClosed: true
    });
    frameApi.root.style.left = "80px";
    frameApi.root.style.top = "72px";
    frameApi.root.style.width = "1280px";
    frameApi.root.style.height = "760px";
    frameApi.root.classList.add("vf-frame--user-sized");

    var shell = document.createElement("div");
    shell.className = "vf-shared-demo-shell";
    var canvas = document.createElement("canvas");
    canvas.className = "vf-shared-demo-canvas";
    canvas.setAttribute("aria-label", "Shared runtime draggable rectangle demo");
    shell.appendChild(canvas);
    frameApi.body.replaceChildren(shell);

    global.__vfSharedFrame = frameApi;
    global.__vfSharedRectDemo = createDemo(canvas);

    if (global.VfFrame && typeof global.VfFrame.postNativeHostLayout === "function") {
      global.VfFrame.postNativeHostLayout(layer, { stageAlpha: 0 });
      global.requestAnimationFrame(function () {
        global.VfFrame.postNativeHostLayout(layer, { stageAlpha: 0 });
      });
    }
  });
})(typeof globalThis !== "undefined" ? globalThis : this);

