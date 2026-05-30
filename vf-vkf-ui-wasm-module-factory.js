(function(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.VfVkfUiWasmModuleFactory = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  "use strict";

  var BUILTIN_WASM_FACTORY_IDS = Object.freeze({
    interactionDemo: "interaction-demo",
    fullDemo: "full-demo",
    transformDemo: "transform-demo"
  });

  var EXPORT_NAMES = Object.freeze({
    pickVertexIndex: "vf_vkf_ui_pick_vertex_index",
    pickEdgeIndex: "vf_vkf_ui_pick_edge_index",
    moveVertexToLocalCursor: "vf_vkf_ui_move_vertex_to_local_cursor",
    translateEdgeVertices: "vf_vkf_ui_translate_edge_vertices",
    pickFaceIndex: "vf_vkf_ui_pick_face_index",
    rotateScaleTransform: "vf_vkf_ui_rotate_scale_transform",
    scaleEdgeTransform: "vf_vkf_ui_scale_edge_transform"
  });

  function encodeU32(value, bytes) {
    value >>>= 0;
    do {
      var byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) {
        byte |= 0x80;
      }
      bytes.push(byte);
    } while (value !== 0);
  }

  function encodeString(text, bytes) {
    var utf8 = new TextEncoder().encode(text);
    encodeU32(utf8.length, bytes);
    for (var i = 0; i < utf8.length; i += 1) {
      bytes.push(utf8[i]);
    }
  }

  function makeSection(id, content, bytes) {
    bytes.push(id);
    encodeU32(content.length, bytes);
    for (var i = 0; i < content.length; i += 1) {
      bytes.push(content[i]);
    }
  }

  function buildKernelModuleBytes(definitions) {
    var bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

    var typeSection = [];
    encodeU32(1, typeSection);
    typeSection.push(0x60);
    encodeU32(1, typeSection);
    typeSection.push(0x7f);
    encodeU32(0, typeSection);
    makeSection(1, typeSection, bytes);

    var functionSection = [];
    encodeU32(definitions.length, functionSection);
    for (var i = 0; i < definitions.length; i += 1) {
      encodeU32(0, functionSection);
    }
    makeSection(3, functionSection, bytes);

    var memorySection = [];
    encodeU32(1, memorySection);
    memorySection.push(0x00);
    encodeU32(1, memorySection);
    makeSection(5, memorySection, bytes);

    var exportSection = [];
    encodeU32(definitions.length + 1, exportSection);
    encodeString("memory", exportSection);
    exportSection.push(0x02);
    encodeU32(0, exportSection);
    for (i = 0; i < definitions.length; i += 1) {
      encodeString(definitions[i].name, exportSection);
      exportSection.push(0x00);
      encodeU32(i, exportSection);
    }
    makeSection(7, exportSection, bytes);

    var codeSection = [];
    encodeU32(definitions.length, codeSection);
    for (i = 0; i < definitions.length; i += 1) {
      var body = definitions[i].bodyBytes.slice();
      encodeU32(body.length, codeSection);
      for (var j = 0; j < body.length; j += 1) {
        codeSection.push(body[j]);
      }
    }
    makeSection(10, codeSection, bytes);

    return new Uint8Array(bytes);
  }

  function buildImportedKernelModuleBytes(options) {
    options = options || {};
    var imports = options.imports || [];
    var definitions = options.definitions || [];
    var types = options.types || [
      { params: [0x7c], results: [0x7c] },
      { params: [0x7f], results: [] }
    ];
    var bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

    var typeSection = [];
    encodeU32(types.length, typeSection);
    for (var t = 0; t < types.length; t += 1) {
      typeSection.push(0x60);
      encodeU32(types[t].params.length, typeSection);
      for (var tp = 0; tp < types[t].params.length; tp += 1) {
        typeSection.push(types[t].params[tp]);
      }
      encodeU32(types[t].results.length, typeSection);
      for (var tr = 0; tr < types[t].results.length; tr += 1) {
        typeSection.push(types[t].results[tr]);
      }
    }
    makeSection(1, typeSection, bytes);

    var importSection = [];
    encodeU32(imports.length, importSection);
    for (var i = 0; i < imports.length; i += 1) {
      encodeString(imports[i].module, importSection);
      encodeString(imports[i].name, importSection);
      importSection.push(0x00);
      encodeU32(imports[i].typeIndex, importSection);
    }
    makeSection(2, importSection, bytes);

    var functionSection = [];
    encodeU32(definitions.length, functionSection);
    for (i = 0; i < definitions.length; i += 1) {
      encodeU32(definitions[i].typeIndex == null ? 1 : definitions[i].typeIndex, functionSection);
    }
    makeSection(3, functionSection, bytes);

    var memorySection = [];
    encodeU32(1, memorySection);
    memorySection.push(0x00);
    encodeU32(1, memorySection);
    makeSection(5, memorySection, bytes);

    var exportSection = [];
    encodeU32(definitions.length + 1, exportSection);
    encodeString("memory", exportSection);
    exportSection.push(0x02);
    encodeU32(0, exportSection);
    for (i = 0; i < definitions.length; i += 1) {
      encodeString(definitions[i].name, exportSection);
      exportSection.push(0x00);
      encodeU32(imports.length + i, exportSection);
    }
    makeSection(7, exportSection, bytes);

    var codeSection = [];
    encodeU32(definitions.length, codeSection);
    for (i = 0; i < definitions.length; i += 1) {
      var body = definitions[i].bodyBytes.slice();
      encodeU32(body.length, codeSection);
      for (var j = 0; j < body.length; j += 1) {
        codeSection.push(body[j]);
      }
    }
    makeSection(10, codeSection, bytes);

    return new Uint8Array(bytes);
  }

  function pushLocalGet(index, bytes) {
    bytes.push(0x20);
    encodeU32(index, bytes);
  }

  function pushLocalSet(index, bytes) {
    bytes.push(0x21);
    encodeU32(index, bytes);
  }

  function pushCall(index, bytes) {
    bytes.push(0x10);
    encodeU32(index, bytes);
  }

  function pushF64Load(offset, bytes) {
    bytes.push(0x2b);
    bytes.push(0x03);
    encodeU32(offset, bytes);
  }

  function pushF64Store(offset, bytes) {
    bytes.push(0x39);
    bytes.push(0x03);
    encodeU32(offset, bytes);
  }

  function pushF64Const(value, bytes) {
    bytes.push(0x44);
    var scratch = new ArrayBuffer(8);
    var view = new DataView(scratch);
    view.setFloat64(0, Number(value), true);
    for (var i = 0; i < 8; i += 1) {
      bytes.push(view.getUint8(i));
    }
  }

  function pickKernelBodyBytes(resultBaseOffset, strideBytes, resultF64Bytes) {
    var body = [];
    encodeU32(1, body);
    encodeU32(2, body);
    body.push(0x7f);
    body.push(0x20, 0x00);
    body.push(0x41, 0x10);
    body.push(0x6a);
    body.push(0x2b, 0x03, 0x00);
    body.push(0xaa);
    body.push(0x21, 0x01);
    body.push(0x20, 0x00);
    body.push(0x41, resultBaseOffset);
    body.push(0x6a);
    body.push(0x20, 0x01);
    body.push(0x41, strideBytes);
    body.push(0x6c);
    body.push(0x6a);
    body.push(0x21, 0x02);
    body.push(0x20, 0x02);
    body.push(0x44);
    body.push.apply(body, resultF64Bytes);
    body.push(0x39, 0x03, 0x00);
    body.push(0x0b);
    return body;
  }

  function buildPickKernelModuleBytes(definitions) {
    return buildKernelModuleBytes(definitions.map(function(definition) {
      return {
        name: definition.name,
        bodyBytes: pickKernelBodyBytes(definition.resultBaseOffset, definition.strideBytes, definition.resultF64Bytes)
      };
    }));
  }

  function moveVertexBodyBytes() {
    var body = [];
    encodeU32(0, body);
    body.push(0x20, 0x00);
    body.push(0x41, 0x20);
    body.push(0x6a);
    body.push(0x20, 0x00);
    body.push(0x41, 0x10);
    body.push(0x6a);
    body.push(0x2b, 0x03, 0x00);
    body.push(0x39, 0x03, 0x00);
    body.push(0x20, 0x00);
    body.push(0x41, 0x28);
    body.push(0x6a);
    body.push(0x20, 0x00);
    body.push(0x41, 0x18);
    body.push(0x6a);
    body.push(0x2b, 0x03, 0x00);
    body.push(0x39, 0x03, 0x00);
    body.push(0x0b);
    return body;
  }

  function translateEdgeBodyBytes() {
    var body = [];
    encodeU32(0, body);
    body.push(0x20, 0x00);
    body.push(0x20, 0x00);
    body.push(0x2b, 0x03, 0x30);
    body.push(0x20, 0x00);
    body.push(0x2b, 0x03, 0x10);
    body.push(0xa0);
    body.push(0x39, 0x03, 0x30);
    body.push(0x20, 0x00);
    body.push(0x20, 0x00);
    body.push(0x2b, 0x03, 0x38);
    body.push(0x20, 0x00);
    body.push(0x2b, 0x03, 0x10);
    body.push(0xa0);
    body.push(0x39, 0x03, 0x38);
    body.push(0x20, 0x00);
    body.push(0x20, 0x00);
    body.push(0x2b, 0x03, 0x40);
    body.push(0x20, 0x00);
    body.push(0x2b, 0x03, 0x18);
    body.push(0xa0);
    body.push(0x39, 0x03, 0x40);
    body.push(0x20, 0x00);
    body.push(0x20, 0x00);
    body.push(0x2b, 0x03, 0x48);
    body.push(0x20, 0x00);
    body.push(0x2b, 0x03, 0x18);
    body.push(0xa0);
    body.push(0x39, 0x03, 0x48);
    body.push(0x0b);
    return body;
  }

  function rotateScaleBodyBytes() {
    var body = [];
    encodeU32(1, body);
    encodeU32(2, body);
    body.push(0x7c);

    pushLocalGet(0, body);
    pushF64Load(48, body);
    pushCall(0, body);
    pushLocalGet(0, body);
    pushF64Load(56, body);
    body.push(0xa2);
    pushLocalSet(1, body);

    pushLocalGet(0, body);
    pushF64Load(48, body);
    pushCall(1, body);
    pushLocalGet(0, body);
    pushF64Load(56, body);
    body.push(0xa2);
    pushLocalSet(2, body);

    pushLocalGet(0, body);
    pushLocalGet(1, body);
    pushLocalGet(0, body);
    pushF64Load(0, body);
    body.push(0xa2);
    pushLocalGet(2, body);
    pushLocalGet(0, body);
    pushF64Load(16, body);
    body.push(0xa2);
    body.push(0xa1);
    pushF64Store(80, body);

    pushLocalGet(0, body);
    pushLocalGet(1, body);
    pushLocalGet(0, body);
    pushF64Load(8, body);
    body.push(0xa2);
    pushLocalGet(2, body);
    pushLocalGet(0, body);
    pushF64Load(24, body);
    body.push(0xa2);
    body.push(0xa1);
    pushF64Store(88, body);

    pushLocalGet(0, body);
    pushLocalGet(2, body);
    pushLocalGet(0, body);
    pushF64Load(0, body);
    body.push(0xa2);
    pushLocalGet(1, body);
    pushLocalGet(0, body);
    pushF64Load(16, body);
    body.push(0xa2);
    body.push(0xa0);
    pushF64Store(96, body);

    pushLocalGet(0, body);
    pushLocalGet(2, body);
    pushLocalGet(0, body);
    pushF64Load(8, body);
    body.push(0xa2);
    pushLocalGet(1, body);
    pushLocalGet(0, body);
    pushF64Load(24, body);
    body.push(0xa2);
    body.push(0xa0);
    pushF64Store(104, body);

    pushLocalGet(0, body);
    pushLocalGet(0, body);
    pushF64Load(64, body);
    pushLocalGet(1, body);
    pushLocalGet(0, body);
    pushF64Load(32, body);
    pushLocalGet(0, body);
    pushF64Load(64, body);
    body.push(0xa1);
    body.push(0xa2);
    body.push(0xa0);
    pushLocalGet(2, body);
    pushLocalGet(0, body);
    pushF64Load(40, body);
    pushLocalGet(0, body);
    pushF64Load(72, body);
    body.push(0xa1);
    body.push(0xa2);
    body.push(0xa1);
    pushF64Store(112, body);

    pushLocalGet(0, body);
    pushLocalGet(0, body);
    pushF64Load(72, body);
    pushLocalGet(2, body);
    pushLocalGet(0, body);
    pushF64Load(32, body);
    pushLocalGet(0, body);
    pushF64Load(64, body);
    body.push(0xa1);
    body.push(0xa2);
    body.push(0xa0);
    pushLocalGet(1, body);
    pushLocalGet(0, body);
    pushF64Load(40, body);
    pushLocalGet(0, body);
    pushF64Load(72, body);
    body.push(0xa1);
    body.push(0xa2);
    body.push(0xa0);
    pushF64Store(120, body);

    body.push(0x0b);
    return body;
  }

  function scaleEdgeBodyBytes() {
    var body = [];
    encodeU32(1, body);
    encodeU32(9, body);
    body.push(0x7c);

    pushLocalGet(0, body);
    pushF64Load(64, body);
    pushLocalGet(0, body);
    pushF64Load(48, body);
    body.push(0xa1);
    pushLocalSet(1, body);

    pushLocalGet(0, body);
    pushF64Load(72, body);
    pushLocalGet(0, body);
    pushF64Load(56, body);
    body.push(0xa1);
    pushLocalSet(2, body);

    pushLocalGet(1, body);
    pushLocalGet(1, body);
    body.push(0xa2);
    pushLocalGet(2, body);
    pushLocalGet(2, body);
    body.push(0xa2);
    body.push(0xa0);
    pushLocalSet(3, body);

    pushLocalGet(0, body);
    pushF64Load(80, body);
    pushF64Const(1, body);
    body.push(0xa1);
    pushLocalSet(4, body);

    pushF64Const(1, body);
    pushLocalGet(4, body);
    pushLocalGet(2, body);
    pushLocalGet(2, body);
    body.push(0xa2);
    body.push(0xa2);
    pushLocalGet(3, body);
    body.push(0xa3);
    body.push(0xa0);
    pushLocalSet(5, body);

    pushLocalGet(4, body);
    pushF64Const(-1, body);
    body.push(0xa2);
    pushLocalGet(1, body);
    body.push(0xa2);
    pushLocalGet(2, body);
    body.push(0xa2);
    pushLocalGet(3, body);
    body.push(0xa3);
    pushLocalSet(6, body);

    pushF64Const(1, body);
    pushLocalGet(4, body);
    pushLocalGet(1, body);
    pushLocalGet(1, body);
    body.push(0xa2);
    body.push(0xa2);
    pushLocalGet(3, body);
    body.push(0xa3);
    body.push(0xa0);
    pushLocalSet(7, body);

    pushLocalGet(0, body);
    pushLocalGet(5, body);
    pushLocalGet(0, body);
    pushF64Load(0, body);
    body.push(0xa2);
    pushLocalGet(6, body);
    pushLocalGet(0, body);
    pushF64Load(16, body);
    body.push(0xa2);
    body.push(0xa0);
    pushF64Store(104, body);

    pushLocalGet(0, body);
    pushLocalGet(5, body);
    pushLocalGet(0, body);
    pushF64Load(8, body);
    body.push(0xa2);
    pushLocalGet(6, body);
    pushLocalGet(0, body);
    pushF64Load(24, body);
    body.push(0xa2);
    body.push(0xa0);
    pushF64Store(112, body);

    pushLocalGet(0, body);
    pushLocalGet(6, body);
    pushLocalGet(0, body);
    pushF64Load(0, body);
    body.push(0xa2);
    pushLocalGet(7, body);
    pushLocalGet(0, body);
    pushF64Load(16, body);
    body.push(0xa2);
    body.push(0xa0);
    pushF64Store(120, body);

    pushLocalGet(0, body);
    pushLocalGet(6, body);
    pushLocalGet(0, body);
    pushF64Load(8, body);
    body.push(0xa2);
    pushLocalGet(7, body);
    pushLocalGet(0, body);
    pushF64Load(24, body);
    body.push(0xa2);
    body.push(0xa0);
    pushF64Store(128, body);

    pushLocalGet(0, body);
    pushF64Load(32, body);
    pushLocalGet(0, body);
    pushF64Load(88, body);
    body.push(0xa1);
    pushLocalSet(8, body);

    pushLocalGet(0, body);
    pushF64Load(40, body);
    pushLocalGet(0, body);
    pushF64Load(96, body);
    body.push(0xa1);
    pushLocalSet(9, body);

    pushLocalGet(0, body);
    pushLocalGet(0, body);
    pushF64Load(88, body);
    pushLocalGet(5, body);
    pushLocalGet(8, body);
    body.push(0xa2);
    pushLocalGet(6, body);
    pushLocalGet(9, body);
    body.push(0xa2);
    body.push(0xa0);
    body.push(0xa0);
    pushF64Store(136, body);

    pushLocalGet(0, body);
    pushLocalGet(0, body);
    pushF64Load(96, body);
    pushLocalGet(6, body);
    pushLocalGet(8, body);
    body.push(0xa2);
    pushLocalGet(7, body);
    pushLocalGet(9, body);
    body.push(0xa2);
    body.push(0xa0);
    body.push(0xa0);
    pushF64Store(144, body);

    body.push(0x0b);
    return body;
  }

  function createPickVertexModuleBytes() {
    return buildPickKernelModuleBytes([{
      name: EXPORT_NAMES.pickVertexIndex,
      resultBaseOffset: 0x18,
      strideBytes: 0x18,
      resultF64Bytes: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f]
    }]);
  }

  function createPickVertexEdgeModuleBytes() {
    return buildPickKernelModuleBytes([
      {
        name: EXPORT_NAMES.pickVertexIndex,
        resultBaseOffset: 0x18,
        strideBytes: 0x18,
        resultF64Bytes: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f]
      },
      {
        name: EXPORT_NAMES.pickEdgeIndex,
        resultBaseOffset: 0x18,
        strideBytes: 0x28,
        resultF64Bytes: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40]
      }
    ]);
  }

  function instantiateModule(wasmBytes) {
    var module = new WebAssembly.Module(wasmBytes);
    var instance = new WebAssembly.Instance(module, {});
    return {
      module: module,
      instance: instance,
      memory: instance.exports.memory
    };
  }

  function instantiatePickVertexModule() {
    return instantiateModule(createPickVertexModuleBytes());
  }

  function instantiatePickVertexEdgeModule() {
    return instantiateModule(createPickVertexEdgeModuleBytes());
  }

  function createMoveVertexModuleBytes() {
    return buildKernelModuleBytes([{
      name: EXPORT_NAMES.moveVertexToLocalCursor,
      bodyBytes: moveVertexBodyBytes()
    }]);
  }

  function instantiateMoveVertexModule() {
    return instantiateModule(createMoveVertexModuleBytes());
  }

  function createTranslateEdgeModuleBytes() {
    return buildKernelModuleBytes([{
      name: EXPORT_NAMES.translateEdgeVertices,
      bodyBytes: translateEdgeBodyBytes()
    }]);
  }

  function instantiateTranslateEdgeModule() {
    return instantiateModule(createTranslateEdgeModuleBytes());
  }

  function createRotateScaleModuleBytes() {
    return buildImportedKernelModuleBytes({
      imports: [
        { module: "env", name: "cos", typeIndex: 0 },
        { module: "env", name: "sin", typeIndex: 0 }
      ],
      definitions: [{
        name: EXPORT_NAMES.rotateScaleTransform,
        bodyBytes: rotateScaleBodyBytes()
      }]
    });
  }

  function instantiateRotateScaleModule() {
    var wasmBytes = createRotateScaleModuleBytes();
    var module = new WebAssembly.Module(wasmBytes);
    var instance = new WebAssembly.Instance(module, {
      env: {
        cos: Math.cos,
        sin: Math.sin
      }
    });
    return {
      module: module,
      instance: instance,
      memory: instance.exports.memory
    };
  }

  function createScaleEdgeModuleBytes() {
    return buildKernelModuleBytes([{
      name: EXPORT_NAMES.scaleEdgeTransform,
      bodyBytes: scaleEdgeBodyBytes()
    }]);
  }

  function instantiateScaleEdgeModule() {
    return instantiateModule(createScaleEdgeModuleBytes());
  }

  function createFullDemoModuleBytes() {
    return buildImportedKernelModuleBytes({
      imports: [
        { module: "env", name: "cos", typeIndex: 0 },
        { module: "env", name: "sin", typeIndex: 0 }
      ],
      definitions: [
        {
          name: EXPORT_NAMES.pickVertexIndex,
          typeIndex: 2,
          bodyBytes: pickKernelBodyBytes(0x18, 0x18, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f])
        },
        {
          name: EXPORT_NAMES.pickEdgeIndex,
          typeIndex: 2,
          bodyBytes: pickKernelBodyBytes(0x18, 0x28, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40])
        },
        {
          name: EXPORT_NAMES.moveVertexToLocalCursor,
          typeIndex: 2,
          bodyBytes: moveVertexBodyBytes()
        },
        {
          name: EXPORT_NAMES.translateEdgeVertices,
          typeIndex: 2,
          bodyBytes: translateEdgeBodyBytes()
        },
        {
          name: EXPORT_NAMES.rotateScaleTransform,
          typeIndex: 2,
          bodyBytes: rotateScaleBodyBytes()
        },
        {
          name: EXPORT_NAMES.scaleEdgeTransform,
          typeIndex: 2,
          bodyBytes: scaleEdgeBodyBytes()
        }
      ],
      types: [
        { params: [0x7c], results: [0x7c] },
        { params: [0x7f], results: [] },
        { params: [0x7f], results: [] }
      ]
    });
  }

  function instantiateFullDemoModule() {
    var wasmBytes = createFullDemoModuleBytes();
    var module = new WebAssembly.Module(wasmBytes);
    var instance = new WebAssembly.Instance(module, {
      env: {
        cos: Math.cos,
        sin: Math.sin
      }
    });
    return {
      module: module,
      instance: instance,
      memory: instance.exports.memory
    };
  }

  function createTransformModuleBytes() {
    return buildImportedKernelModuleBytes({
      imports: [
        { module: "env", name: "cos", typeIndex: 0 },
        { module: "env", name: "sin", typeIndex: 0 }
      ],
      definitions: [
        {
          name: EXPORT_NAMES.rotateScaleTransform,
          bodyBytes: rotateScaleBodyBytes()
        },
        {
          name: EXPORT_NAMES.scaleEdgeTransform,
          bodyBytes: scaleEdgeBodyBytes()
        }
      ]
    });
  }

  function instantiateTransformModule() {
    var wasmBytes = createTransformModuleBytes();
    var module = new WebAssembly.Module(wasmBytes);
    var instance = new WebAssembly.Instance(module, {
      env: {
        cos: Math.cos,
        sin: Math.sin
      }
    });
    return {
      module: module,
      instance: instance,
      memory: instance.exports.memory
    };
  }

  function createInteractionModuleBytes() {
    return buildKernelModuleBytes([
      {
        name: EXPORT_NAMES.pickVertexIndex,
        bodyBytes: pickKernelBodyBytes(0x18, 0x18, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f])
      },
      {
        name: EXPORT_NAMES.pickEdgeIndex,
        bodyBytes: pickKernelBodyBytes(0x18, 0x28, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40])
      },
      {
        name: EXPORT_NAMES.moveVertexToLocalCursor,
        bodyBytes: moveVertexBodyBytes()
      },
      {
        name: EXPORT_NAMES.translateEdgeVertices,
        bodyBytes: translateEdgeBodyBytes()
      }
    ]);
  }

  function instantiateInteractionModule() {
    return instantiateModule(createInteractionModuleBytes());
  }

  return {
    BUILTIN_WASM_FACTORY_IDS: BUILTIN_WASM_FACTORY_IDS,
    EXPORT_NAMES: EXPORT_NAMES,
    createPickVertexModuleBytes: createPickVertexModuleBytes,
    createPickVertexEdgeModuleBytes: createPickVertexEdgeModuleBytes,
    createMoveVertexModuleBytes: createMoveVertexModuleBytes,
    createRotateScaleModuleBytes: createRotateScaleModuleBytes,
    createScaleEdgeModuleBytes: createScaleEdgeModuleBytes,
    createFullDemoModuleBytes: createFullDemoModuleBytes,
    createTransformModuleBytes: createTransformModuleBytes,
    createTranslateEdgeModuleBytes: createTranslateEdgeModuleBytes,
    createInteractionModuleBytes: createInteractionModuleBytes,
    instantiatePickVertexModule: instantiatePickVertexModule,
    instantiatePickVertexEdgeModule: instantiatePickVertexEdgeModule,
    instantiateMoveVertexModule: instantiateMoveVertexModule,
    instantiateRotateScaleModule: instantiateRotateScaleModule,
    instantiateScaleEdgeModule: instantiateScaleEdgeModule,
    instantiateFullDemoModule: instantiateFullDemoModule,
    instantiateTransformModule: instantiateTransformModule,
    instantiateTranslateEdgeModule: instantiateTranslateEdgeModule,
    instantiateInteractionModule: instantiateInteractionModule
  };
});
