(function(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./vf-vkf-ui-wasm-module-factory.js"));
    return;
  }
  root.VfCompiledUiModuleRegistry = factory(root.VfVkfUiWasmModuleFactory);
})(typeof globalThis !== "undefined" ? globalThis : this, function(wasmFactory) {
  "use strict";

  var FACTORY_IDS = wasmFactory && wasmFactory.BUILTIN_WASM_FACTORY_IDS
    ? wasmFactory.BUILTIN_WASM_FACTORY_IDS
    : Object.freeze({
        interactionDemo: "interaction-demo",
        fullDemo: "full-demo"
      });

  var BUILTIN_MODULE_IDS = Object.freeze({
    rectDemo: "rect-demo"
  });

  var BUILTIN_NATIVE_LIBRARIES = Object.freeze({
    rectDemo: "vf-compiled-ui-demo.dll"
  });

  var BUILTIN_MODULES = Object.freeze([
    Object.freeze({
      name: BUILTIN_MODULE_IDS.rectDemo,
      nativeLibrary: BUILTIN_NATIVE_LIBRARIES.rectDemo,
      wasmFactory: FACTORY_IDS.fullDemo
    })
  ]);

  function listBuiltinCompiledUiModules() {
    return BUILTIN_MODULES.map(function(module) {
      return {
        name: module.name,
        nativeLibrary: module.nativeLibrary,
        wasmFactory: module.wasmFactory
      };
    });
  }

  function getBuiltinCompiledUiModule(name) {
    for (var i = 0; i < BUILTIN_MODULES.length; i += 1) {
      if (BUILTIN_MODULES[i].name === name) {
        return {
          name: BUILTIN_MODULES[i].name,
          nativeLibrary: BUILTIN_MODULES[i].nativeLibrary,
          wasmFactory: BUILTIN_MODULES[i].wasmFactory
        };
      }
    }
    return null;
  }

  function instantiateBuiltinCompiledUiWasmModule(name) {
    var module = getBuiltinCompiledUiModule(name);
    if (!module || !wasmFactory) {
      return null;
    }
    var resolved = resolveBuiltinCompiledUiWasmFactory(name);
    if (!resolved) {
      return null;
    }
    return resolved.instantiate();
  }

  function resolveBuiltinCompiledUiWasmFactory(name) {
    var module = getBuiltinCompiledUiModule(name);
    if (!module || !wasmFactory) {
      return null;
    }
    if (module.wasmFactory === FACTORY_IDS.interactionDemo &&
        typeof wasmFactory.instantiateInteractionModule === "function") {
      return {
        name: module.name,
        wasmFactory: module.wasmFactory,
        instantiate: function() {
          return wasmFactory.instantiateInteractionModule();
        }
      };
    }
    if (module.wasmFactory === FACTORY_IDS.fullDemo &&
        typeof wasmFactory.instantiateFullDemoModule === "function") {
      return {
        name: module.name,
        wasmFactory: module.wasmFactory,
        instantiate: function() {
          return wasmFactory.instantiateFullDemoModule();
        }
      };
    }
    return null;
  }

  return {
    FACTORY_IDS: FACTORY_IDS,
    BUILTIN_MODULE_IDS: BUILTIN_MODULE_IDS,
    BUILTIN_NATIVE_LIBRARIES: BUILTIN_NATIVE_LIBRARIES,
    listBuiltinCompiledUiModules: listBuiltinCompiledUiModules,
    getBuiltinCompiledUiModule: getBuiltinCompiledUiModule,
    instantiateBuiltinCompiledUiWasmModule: instantiateBuiltinCompiledUiWasmModule,
    resolveBuiltinCompiledUiWasmFactory: resolveBuiltinCompiledUiWasmFactory
  };
});
