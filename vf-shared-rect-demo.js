(function(root, factory) {
  if (typeof module === "object" && module.exports) {
    var api = factory(
      root || globalThis,
      require("./vf-shared-runtime.js"),
      require("./vf-gpu-runtime.js"),
      require("./vf-wasm-demo-contract.js")
    );
    module.exports = api;
    (root || globalThis).VfSharedRectDemo = api;
    return;
  }
  root.VfSharedRectDemo = factory(root || globalThis, root.VfSharedRuntime, root.VfGpuRuntime, root.VfWasmDemoContract);
})(typeof globalThis !== "undefined" ? globalThis : this, function(global, shared, gpu, wasmDemo) {
  "use strict";

  var demoApi = null;

  function rgba(color) {
    var r = Math.round((color[0] || 0) * 255);
    var g = Math.round((color[1] || 0) * 255);
    var b = Math.round((color[2] || 0) * 255);
    var a = color.length > 3 ? color[3] : 1;
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }

  function edgeDash(style, unitLength) {
    var unit = unitLength || 6;
    if (style === ".  ") {
      return { dash: [0, unit * 2], cap: "round" };
    }
    if (style === "---  ") {
      return { dash: [unit * 3, unit * 2], cap: "butt" };
    }
    return { dash: [], cap: "butt" };
  }

  function drawVertex(ctx, point, radius, style, color) {
    if (!(radius > 0)) { return; }
    ctx.fillStyle = rgba(color);
    if (style === "square") {
      ctx.rect(point[0] - radius, point[1] - radius, radius * 2, radius * 2);
      ctx.fill();
      return;
    }
    if (style === "triangle") {
      ctx.beginPath();
      ctx.moveTo(point[0], point[1] - radius);
      ctx.lineTo(point[0] + radius, point[1] + radius);
      ctx.lineTo(point[0] - radius, point[1] + radius);
      ctx.closePath();
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.arc(point[0], point[1], radius, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawMesh(ctx, mesh) {
    var faces = mesh.faces || [];
    var edges = mesh.edges || [];
    var vertices = mesh.vertices || [];
    var edgeWidth = mesh.edge_width || 1;
    var edgeStyle = edgeDash(mesh.edge_style || "", mesh.edge_unit_length || 6);
    var faceColor = mesh.face_color || [0, 0, 0, 0];
    var edgeColor = mesh.edge_color || [1, 1, 1, 1];
    var vertexColor = mesh.vertex_color || [1, 1, 1, 1];
    var vertexRadius = mesh.vertex_radius || 0;
    var vertexStyle = mesh.vertex_style || "disc";

    for (var f = 0; f < faces.length; f += 1) {
      var face = faces[f];
      if (!face || !face.length) { continue; }
      ctx.beginPath();
      var first = mesh.world_point(face[0]);
      ctx.moveTo(first[0], first[1]);
      for (var fi = 1; fi < face.length; fi += 1) {
        var fp = mesh.world_point(face[fi]);
        ctx.lineTo(fp[0], fp[1]);
      }
      ctx.closePath();
      ctx.fillStyle = rgba(faceColor);
      ctx.fill();
    }

    ctx.save();
    ctx.strokeStyle = rgba(edgeColor);
    ctx.lineWidth = edgeWidth;
    ctx.setLineDash(edgeStyle.dash);
    ctx.lineCap = edgeStyle.cap;
    for (var e = 0; e < edges.length; e += 1) {
      var edge = edges[e];
      var a = mesh.world_point(edge[0]);
      var b = mesh.world_point(edge[1]);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    ctx.restore();

    for (var v = 0; v < vertices.length; v += 1) {
      drawVertex(ctx, mesh.world_point(vertices[v]), vertexRadius, vertexStyle, vertexColor);
    }
  }

  function createBrowserDemo() {
    var transformArena = shared.createTransformArena(12);
    var eventArena = shared.createEventArena(8);
    var writeLog = [];
    var transformRenderer = gpu.createTransformRenderer({
      arena: transformArena,
      adapter: {
        writeBuffer: function(offset, floatView) {
          writeLog.push({
            offset: offset,
            bytes: Array.from(new Float32Array(floatView.buffer.slice(floatView.byteOffset, floatView.byteOffset + floatView.byteLength)))
          });
        }
      }
    });

    var meshRects = [
      { x: 80, y: 70, w: 220, h: 200, face: [0.14, 0.51, 0.93, 0.24], edge: [0.14, 0.51, 0.93, 1], vertex: [0.85, 0.95, 1, 1] },
      { x: 120, y: 120, w: 90, h: 70, face: [0.1, 0.8, 0.5, 0.2], edge: [0.1, 0.8, 0.5, 1], vertex: [0.8, 1, 0.9, 1] },
      { x: 210, y: 190, w: 70, h: 50, face: [0.95, 0.7, 0.2, 0.2], edge: [0.95, 0.7, 0.2, 1], vertex: [1, 0.95, 0.8, 1] }
    ];
    while (meshRects.length < 12) {
      meshRects.push({ x: 0, y: 0, w: 0, h: 0, face: [0, 0, 0, 0], edge: [0, 0, 0, 0], vertex: [0, 0, 0, 0] });
    }

    meshRects.forEach(function(rect, slot) {
      transformArena.setTranslate2D(slot, rect.x, rect.y);
    });
    transformRenderer.flushDirtyTransforms();

    var decorativeRects = [
      { x: 88, y: 72, w: 260, h: 172 },
      { x: 134, y: 110, w: 142, h: 94 },
      { x: 168, y: 134, w: 54, h: 38 }
    ];

    function makeRectMesh(slot, rect) {
      return {
        slot: slot,
        face_color: rect.face,
        edge_color: rect.edge,
        vertex_color: rect.vertex,
        edge_width: 2,
        edge_style: slot === 0 ? "---  " : "",
        edge_unit_length: 6,
        vertex_radius: slot === 0 ? 4 : 0,
        vertex_style: "disc",
        vertices: slot === 0 ? [0, 1, 2, 3] : [],
        edges: [[0, 1], [1, 2], [2, 3], [3, 0]],
        faces: rect.w > 0 && rect.h > 0 ? [[0, 1, 2, 3]] : [],
        world_point: function(index) {
          var tx = transformArena.mat4[slot * shared.MAT4_F32 + 12];
          var ty = transformArena.mat4[slot * shared.MAT4_F32 + 13];
          if (index === 0) { return [tx, ty + rect.h, 0]; }
          if (index === 1) { return [tx + rect.w, ty + rect.h, 0]; }
          if (index === 2) { return [tx + rect.w, ty, 0]; }
          return [tx, ty, 0];
        }
      };
    }

    var meshes = meshRects.map(function(rect, slot) {
      return makeRectMesh(slot, rect);
    });

    var demo = {
      exports: {
        init: function() { return 0; },
        update: function(input, api) {
          api.transforms.setAnchoredTranslate2D(0, input.pointerX, input.pointerY, input.pointerAnchorX, input.pointerAnchorY);
          return input.sequence;
        }
      }
    };

    var contract = wasmDemo.createWasmDemoContract({
      demo: demo,
      arena: transformArena,
      eventArena: eventArena
    });
    contract.init();

    var canvas = null;
    var ctx = null;
    var latestInput = wasmDemo.createInputSnapshot({});
    var latestSample = eventArena.readerView().latestSample();
    var pointerActive = false;
    var pointerAnchor = [0, 0];
    var sequence = 0;

    function postLayout() {
      if (!global.chrome || !global.chrome.webview || typeof global.chrome.webview.postMessage !== "function") {
        return;
      }
      var rect = meshRects[0];
      global.chrome.webview.postMessage({
        type: "layout",
        stageAlpha: 0,
        hitRegions: [{
          left: rect.x,
          top: rect.y,
          right: rect.x + rect.w,
          bottom: rect.y + rect.h
        }]
      });
    }

    function render() {
      if (!ctx || !canvas) { return; }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      meshes.forEach(function(mesh) {
        if (!mesh.faces.length && !mesh.edges.length) { return; }
        drawMesh(ctx, mesh);
      });
    }

    function updateFromPointer(sample) {
      sequence += 1;
      eventArena.writeInputSample({
        sequence: sequence,
        timeMs: Date.now(),
        cursorPx: [sample.x, sample.y],
        pointerAnchorPx: pointerAnchor.slice(),
        pointerDown: !!sample.down,
        buttons: sample.down ? 1 : 0,
        hover: { object: 0 }
      });
      latestSample = eventArena.readerView().latestSample();
      latestInput = wasmDemo.createInputSnapshot({
        sequence: sequence,
        timeMs: Date.now(),
        pointerX: sample.x,
        pointerY: sample.y,
        pointerAnchorX: pointerAnchor[0],
        pointerAnchorY: pointerAnchor[1],
        pointerDown: !!sample.down,
        buttons: sample.down ? 1 : 0
      });
      contract.update();
      transformRenderer.flushDirtyTransforms();
      render();
      postLayout();
    }

    function bindCanvas(nextCanvas) {
      canvas = nextCanvas;
      ctx = canvas.getContext("2d");
      function pointerPos(ev) {
        var box = canvas.getBoundingClientRect();
        return [ev.clientX - box.left, ev.clientY - box.top];
      }
      canvas.addEventListener("pointerdown", function(ev) {
        var pos = pointerPos(ev);
        var rect = meshRects[0];
        if (pos[0] < rect.x || pos[0] > rect.x + rect.w || pos[1] < rect.y || pos[1] > rect.y + rect.h) {
          return;
        }
        pointerActive = true;
        pointerAnchor = [pos[0] - rect.x, pos[1] - rect.y];
        updateFromPointer({ x: pos[0], y: pos[1], down: true });
      });
      canvas.addEventListener("pointermove", function(ev) {
        if (!pointerActive) { return; }
        var pos = pointerPos(ev);
        updateFromPointer({ x: pos[0], y: pos[1], down: true });
      });
      canvas.addEventListener("pointerup", function(ev) {
        if (!pointerActive) { return; }
        pointerActive = false;
        var pos = pointerPos(ev);
        updateFromPointer({ x: pos[0], y: pos[1], down: false });
      });
      render();
      postLayout();
    }

    return {
      bindCanvas: bindCanvas,
      getMeshes: function() {
        return meshes.map(function(mesh) {
          return {
            points: [mesh.world_point(0), mesh.world_point(1), mesh.world_point(2), mesh.world_point(3)]
          };
        });
      },
      getRects: function() {
        return decorativeRects.map(function(rect) { return { x: rect.x, y: rect.y, w: rect.w, h: rect.h }; });
      },
      getWrites: function() { return writeLog.slice(); },
      getLatestInput: function() { return latestSample; },
      getLatestSnapshot: function() { return latestInput; }
    };
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("DOMContentLoaded", function() {
      var canvas = document.querySelector(".vf-shared-demo-canvas");
      if (!canvas) { return; }
      canvas.width = canvas.clientWidth || 960;
      canvas.height = canvas.clientHeight || 540;
      demoApi = createBrowserDemo();
      demoApi.bindCanvas(canvas);
      global.__vfSharedRectDemo = demoApi;
    }, { once: true });
  }

  return {
    drawMesh: drawMesh,
    createBrowserDemo: createBrowserDemo
  };
});
