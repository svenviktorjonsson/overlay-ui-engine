/**
 * Forward JS errors to vf-overlay: appends to C:\temp\vektor-flow-log.txt (via postMessage type vf_log).
 * Loaded by vf-overlay after navigation (injected) or can be included with <script src="vf-log.js">.
 */
(function () {
  "use strict";
  if (window.__vfLogInstalled) {
    return;
  }
  window.__vfLogInstalled = true;

  function post(level, text) {
    var msg = String(text);
    if (msg.length > 12000) {
      msg = msg.slice(0, 12000) + "…(truncated)";
    }
    try {
      if (typeof window !== "undefined" && window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
        /* Object form — do not JSON.stringify. String posts double-encode and the host's vf_log
         * substring / JSON parse can miss the message. */
        window.chrome.webview.postMessage({ type: "vf_log", level: level, message: msg, t: Date.now() });
        return;
      }
    } catch (e) {}
    if (typeof console !== "undefined" && console.error) {
      console.error("[vf_log " + level + "]", msg);
    }
  }

  window.addEventListener(
    "error",
    function (ev) {
      var s =
        (ev && ev.message) || "error";
      if (ev && ev.filename) {
        s += " " + ev.filename + ":" + (ev.lineno || 0);
      }
      if (ev && ev.error && ev.error.stack) {
        s += "\n" + ev.error.stack;
      }
      post("error", s);
    },
    true
  );
  window.addEventListener("unhandledrejection", function (ev) {
    var r = ev && ev.reason;
    var s = (r && r.stack) || String(r);
    post("error", "unhandledrejection: " + s);
  });
  try {
    post("info", "vf-log.js loaded (error/rejection forwarders active)");
  } catch (e) {}
})();
