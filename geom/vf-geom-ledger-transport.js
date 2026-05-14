/**
 * vf-geom-ledger-transport.js — transport seam for geometry ledger ownership.
 *
 * Current adapters:
 * - inline transport over JS-owned state/snapshot builders
 * - shared-buffer transport over SharedArrayBuffer + Atomics metadata
 *
 * This is the seam future native/WASM ownership should satisfy.
 */
(function (global) {
  "use strict";

  if (global.VfGeomLedgerTransport) { return; }

  function fail(msg) {
    throw new Error("[vf-geom-ledger-transport] " + String(msg));
  }

  var HEADER_SLOT_REVISION = 0;
  var HEADER_SLOT_PRESENTED_REVISION = 1;
  var HEADER_SLOT_STATE_BYTE_LENGTH = 2;
  var HEADER_SLOT_STATE_FORMAT = 3;
  var HEADER_SLOT_FLAGS = 4;
  var HEADER_SLOT_ERROR_CODE = 5;
  var HEADER_SLOT_COUNT = 6;

  function createInlineTransport(options) {
    options = options || {};
    if (!Object.prototype.hasOwnProperty.call(options, "state")) {
      fail("createInlineTransport requires options.state");
    }
    if (typeof options.buildSnapshot !== "function") {
      fail("createInlineTransport requires options.buildSnapshot(state)");
    }
    var state = options.state;
    var buildSnapshot = options.buildSnapshot;
    var source = String(options.source || "inline");
    var error = String(options.error || "");
    var revision = 0;
    var presentedRevision = -1;

    return {
      kind: function () { return "inline"; },
      readHeader: function () {
        return {
          kind: "inline",
          revision: revision,
          presentedRevision: presentedRevision,
          source: source,
          error: error,
        };
      },
      readStateView: function () {
        return state;
      },
      readSnapshot: function () {
        return buildSnapshot(state);
      },
      mutate: function (mutator) {
        if (typeof mutator !== "function") {
          fail("inline transport mutate requires a function");
        }
        mutator(state);
        revision += 1;
        return revision;
      },
      touch: function () {
        revision += 1;
        return revision;
      },
      ackPresented: function (nextRevision) {
        presentedRevision = Number(nextRevision) || 0;
      },
    };
  }

  function createSharedBufferTransport(options) {
    options = options || {};
    var headerBuffer = options.headerBuffer;
    var stateBuffer = options.stateBuffer;
    var hasSharedArrayBuffer = typeof SharedArrayBuffer === "function";
    function isPlainArrayBuffer(value) {
      return value && Object.prototype.toString.call(value) === "[object ArrayBuffer]";
    }
    function isSharedArrayBuffer(value) {
      return hasSharedArrayBuffer && value && Object.prototype.toString.call(value) === "[object SharedArrayBuffer]";
    }
    var headerIsShared = isSharedArrayBuffer(headerBuffer);
    var stateIsShared = isSharedArrayBuffer(stateBuffer);
    if (!isPlainArrayBuffer(headerBuffer) && !headerIsShared) {
      fail("createSharedBufferTransport requires options.headerBuffer ArrayBuffer or SharedArrayBuffer");
    }
    if (!isPlainArrayBuffer(stateBuffer) && !stateIsShared) {
      fail("createSharedBufferTransport requires options.stateBuffer ArrayBuffer or SharedArrayBuffer");
    }
    var header = new Int32Array(headerBuffer);
    if (header.length < HEADER_SLOT_COUNT) {
      fail("shared ledger header must expose at least " + String(HEADER_SLOT_COUNT) + " int32 slots");
    }
    var useAtomics = headerIsShared && typeof Atomics === "object";

    function loadHeader(slot) {
      return useAtomics ? Atomics.load(header, slot) : header[slot];
    }

    function storeHeader(slot, value) {
      if (useAtomics) {
        Atomics.store(header, slot, value);
      } else {
        header[slot] = value;
      }
    }

    return {
      kind: function () { return "shared-buffer"; },
      readHeader: function () {
        return {
          kind: "shared-buffer",
          revision: loadHeader(HEADER_SLOT_REVISION),
          presentedRevision: loadHeader(HEADER_SLOT_PRESENTED_REVISION),
          stateByteLength: loadHeader(HEADER_SLOT_STATE_BYTE_LENGTH),
          stateFormat: loadHeader(HEADER_SLOT_STATE_FORMAT),
          flags: loadHeader(HEADER_SLOT_FLAGS),
          errorCode: loadHeader(HEADER_SLOT_ERROR_CODE),
        };
      },
      readStateView: function () {
        return new Uint8Array(stateBuffer);
      },
      ackPresented: function (nextRevision) {
        storeHeader(HEADER_SLOT_PRESENTED_REVISION, Number(nextRevision) || 0);
      },
      writeRevision: function (nextRevision) {
        storeHeader(HEADER_SLOT_REVISION, Number(nextRevision) || 0);
      },
    };
  }

  global.VfGeomLedgerTransport = {
    HEADER_SLOT_REVISION: HEADER_SLOT_REVISION,
    HEADER_SLOT_PRESENTED_REVISION: HEADER_SLOT_PRESENTED_REVISION,
    HEADER_SLOT_STATE_BYTE_LENGTH: HEADER_SLOT_STATE_BYTE_LENGTH,
    HEADER_SLOT_STATE_FORMAT: HEADER_SLOT_STATE_FORMAT,
    HEADER_SLOT_FLAGS: HEADER_SLOT_FLAGS,
    HEADER_SLOT_ERROR_CODE: HEADER_SLOT_ERROR_CODE,
    HEADER_SLOT_COUNT: HEADER_SLOT_COUNT,
    createInlineTransport: createInlineTransport,
    createSharedBufferTransport: createSharedBufferTransport,
  };
})(typeof window !== "undefined" ? window : globalThis);
