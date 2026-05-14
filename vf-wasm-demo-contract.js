(function (global) {
  "use strict";

  var INPUT_SNAPSHOT_FIELDS = [
    "sequence",
    "timeMs",
    "pointerX",
    "pointerY",
    "pointerAnchorX",
    "pointerAnchorY",
    "pointerDown",
    "buttons",
    "keyMask"
  ];

  function numberOrZero(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function integerOrZero(value) {
    return numberOrZero(value) | 0;
  }

  function createInputSnapshot(input) {
    var src = input || {};
    return Object.freeze({
      sequence: integerOrZero(src.sequence),
      timeMs: numberOrZero(src.timeMs),
      pointerX: numberOrZero(src.pointerX != null ? src.pointerX : src.cursorPx && src.cursorPx[0]),
      pointerY: numberOrZero(src.pointerY != null ? src.pointerY : src.cursorPx && src.cursorPx[1]),
      pointerAnchorX: numberOrZero(
        src.pointerAnchorX != null ? src.pointerAnchorX : src.pointerAnchorPx && src.pointerAnchorPx[0]
      ),
      pointerAnchorY: numberOrZero(
        src.pointerAnchorY != null ? src.pointerAnchorY : src.pointerAnchorPx && src.pointerAnchorPx[1]
      ),
      pointerDown: src.pointerDown ? 1 : 0,
      buttons: integerOrZero(src.buttons),
      keyMask: integerOrZero(src.keyMask)
    });
  }

  function createEventReader(eventArena) {
    if (!eventArena) {
      return null;
    }
    if (typeof eventArena.readerView === "function") {
      return eventArena.readerView();
    }
    return eventArena;
  }

  function latestInputFromEvents(events) {
    if (events && typeof events.latestSample === "function") {
      return events.latestSample();
    }
    return null;
  }

  function resolveDemoExports(demo) {
    if (!demo) {
      throw new TypeError("createWasmDemoContract requires a demo module or exports object");
    }
    return demo.exports || demo;
  }

  function requireFunction(exports, name) {
    if (typeof exports[name] !== "function") {
      throw new TypeError("WASM demo contract requires exported " + name + " function");
    }
    return exports[name];
  }

  function createWasmDemoContract(options) {
    var opts = options || {};
    var exports = resolveDemoExports(opts.demo || opts.module || opts.exports);
    var init = requireFunction(exports, "init");
    var update = requireFunction(exports, "update");
    var arena = opts.arena;
    var events = createEventReader(opts.eventArena || opts.events);

    if (!arena || typeof arena.rendererView !== "function") {
      throw new TypeError("createWasmDemoContract requires a shared runtime transform arena");
    }

    var transforms = Object.freeze({
      buffer: arena.buffer,
      mat4: arena.mat4,
      capacity: arena.capacity(),
      setMat4: function (slot, values) {
        return arena.setMat4(slot, values);
      },
      setTranslate2D: function (slot, x, y) {
        return arena.setTranslate2D(slot, x, y);
      },
      setAnchoredTranslate2D: function (slot, cursorX, cursorY, anchorX, anchorY) {
        return arena.setAnchoredTranslate2D(slot, cursorX, cursorY, anchorX, anchorY);
      },
      rendererView: function () {
        return arena.rendererView();
      }
    });

    var apiShape = {
      transforms: transforms
    };
    if (events) {
      apiShape.events = events;
    }
    if (opts.uiRuntime && opts.uiRuntime.ui) {
      apiShape.ui = opts.uiRuntime.ui;
    }
    var api = Object.freeze(apiShape);

    return {
      api: api,
      init: function () {
        return init(api);
      },
      update: function (input) {
        return update(createInputSnapshot(input || latestInputFromEvents(events)), api);
      }
    };
  }

  global.VfWasmDemoContract = {
    INPUT_SNAPSHOT_FIELDS: INPUT_SNAPSHOT_FIELDS,
    createInputSnapshot: createInputSnapshot,
    createWasmDemoContract: createWasmDemoContract
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.VfWasmDemoContract;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
