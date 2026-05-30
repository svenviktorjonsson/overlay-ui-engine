(function(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(root || globalThis, require("./vf-shared-runtime.js"));
    return;
  }
  var api = factory(root || globalThis, root.VfSharedRuntime);
  root.VfWasmDemoContract = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(global, shared) {
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

  function normalizeInput(sample) {
    sample = sample || {};
    return {
      sequence: sample.sequence == null ? 0 : sample.sequence | 0,
      timeMs: sample.timeMs == null ? 0 : Number(sample.timeMs) || 0,
      pointerX: sample.pointerX == null ? 0 : Number(sample.pointerX) || 0,
      pointerY: sample.pointerY == null ? 0 : Number(sample.pointerY) || 0,
      pointerAnchorX: sample.pointerAnchorX == null ? 0 : Number(sample.pointerAnchorX) || 0,
      pointerAnchorY: sample.pointerAnchorY == null ? 0 : Number(sample.pointerAnchorY) || 0,
      pointerDown: sample.pointerDown ? 1 : 0,
      buttons: sample.buttons == null ? 0 : sample.buttons | 0,
      keyMask: sample.keyMask == null ? 0 : sample.keyMask | 0
    };
  }

  function createInputSnapshot(sample) {
    return normalizeInput(sample);
  }

  function createTransformApi(arena) {
    return {
      capacity: arena.capacity(),
      setTranslate2D: arena.setTranslate2D,
      setAnchoredTranslate2D: arena.setAnchoredTranslate2D
    };
  }

  function createWasmDemoContract(options) {
    options = options || {};
    var demo = options.demo || {};
    var exportsObj = demo.exports || demo;
    if (typeof exportsObj.update !== "function") {
      throw new Error("demo contract requires update");
    }
    var arena = options.arena;
    var eventArena = options.eventArena || null;
    var uiRuntime = options.uiRuntime || null;
    var cachedEventReader = null;
    var transformApi = createTransformApi(arena);

    function getEventReader() {
      if (!eventArena) { return null; }
      if (!cachedEventReader) {
        cachedEventReader = eventArena.readerView();
      }
      return cachedEventReader;
    }

    function createApi(forUpdate) {
      var api = {
        transforms: transformApi
      };
      var eventReader = getEventReader();
      if (eventReader) {
        api.events = eventReader;
      }
      if (uiRuntime && uiRuntime.ui) {
        api.ui = uiRuntime.ui;
      }
      return api;
    }

    function deriveInput(input) {
      if (input) {
        return normalizeInput(input);
      }
      var eventReader = getEventReader();
      if (!eventReader) {
        return createInputSnapshot({});
      }
      var latest = eventReader.latestSample();
      return createInputSnapshot({
        sequence: latest.sequence,
        timeMs: latest.timeMs,
        pointerX: latest.cursorPx[0],
        pointerY: latest.cursorPx[1],
        pointerAnchorX: latest.pointerAnchorPx[0],
        pointerAnchorY: latest.pointerAnchorPx[1],
        pointerDown: latest.pointerDown,
        buttons: latest.buttons,
        keyMask: latest.keyMask
      });
    }

    return {
      init: function() {
        if (typeof exportsObj.init !== "function") {
          return 0;
        }
        return exportsObj.init(createApi(false));
      },
      update: function(input) {
        return exportsObj.update(deriveInput(input), createApi(true));
      }
    };
  }

  return {
    INPUT_SNAPSHOT_FIELDS: INPUT_SNAPSHOT_FIELDS,
    createInputSnapshot: createInputSnapshot,
    createWasmDemoContract: createWasmDemoContract
  };
});
