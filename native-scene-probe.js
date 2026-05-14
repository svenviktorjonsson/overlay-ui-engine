(function (global) {
  "use strict";

  function hostLog(level, message) {
    try {
      console.log(message);
    } catch (_) {}
    try {
      if (global.chrome && global.chrome.webview && global.chrome.webview.postMessage) {
        global.chrome.webview.postMessage({
          type: "vf_log",
          level: level,
          message: message
        });
      }
    } catch (_) {}
  }

  function boot() {
    hostLog("info", "[native-scene-probe] boot");

    var frames = Array.prototype.slice.call(document.querySelectorAll(".vf-frame"));
    var textarea = document.querySelector("textarea");
    if (frames.length < 2 || !textarea) {
      return false;
    }

    frames.sort(function (a, b) {
      return a.getBoundingClientRect().left - b.getBoundingClientRect().left;
    });

    var leftBody = frames[0].querySelector(".vf-frame__body");
    if (!leftBody) {
      hostLog("warn", "[native-scene-probe] left body missing");
      return false;
    }

    var seq = 0;
    function append(line) {
      seq += 1;
      textarea.value += "[" + seq + "] " + line + "\n";
      textarea.scrollTop = textarea.scrollHeight;
    }
    function fmt(n) {
      return Number(n).toFixed(3);
    }
    function pos(ev) {
      var r = leftBody.getBoundingClientRect();
      return {
        x: Math.round(ev.clientX - r.left),
        y: Math.round(ev.clientY - r.top)
      };
    }
    function logPointer(kind, ev) {
      var p = pos(ev);
      append(
        fmt(performance.now()) +
        " " + kind +
        " x=" + p.x +
        " y=" + p.y +
        " button=" + Number(ev.button || 0) +
        " buttons=" + Number(ev.buttons || 0) +
        " pointerId=" + Number(ev.pointerId || 0)
      );
    }
    function logKey(kind, ev) {
      append(
        fmt(performance.now()) +
        " " + kind +
        " key=" + String(ev.key || "") +
        " code=" + String(ev.code || "") +
        " ctrl=" + (ev.ctrlKey ? 1 : 0) +
        " shift=" + (ev.shiftKey ? 1 : 0) +
        " alt=" + (ev.altKey ? 1 : 0)
      );
    }

    leftBody.tabIndex = 0;
    leftBody.addEventListener("pointerenter", function (ev) { logPointer("pointerenter", ev); });
    leftBody.addEventListener("pointermove", function (ev) { logPointer("pointermove", ev); });
    leftBody.addEventListener("pointerdown", function (ev) {
      try { leftBody.setPointerCapture(ev.pointerId); } catch (_) {}
      logPointer("pointerdown", ev);
    });
    leftBody.addEventListener("pointerup", function (ev) {
      logPointer("pointerup", ev);
      try { leftBody.releasePointerCapture(ev.pointerId); } catch (_) {}
    });
    leftBody.addEventListener("pointercancel", function (ev) {
      logPointer("pointercancel", ev);
      try { leftBody.releasePointerCapture(ev.pointerId); } catch (_) {}
    });
    leftBody.addEventListener("pointerleave", function (ev) { logPointer("pointerleave", ev); });
    leftBody.addEventListener("keydown", function (ev) { logKey("keydown", ev); });
    leftBody.addEventListener("keyup", function (ev) { logKey("keyup", ev); });
    leftBody.addEventListener("wheel", function (ev) {
      var p = pos(ev);
      append(
        fmt(performance.now()) +
        " wheel x=" + p.x +
        " y=" + p.y +
        " dx=" + Math.round(ev.deltaX || 0) +
        " dy=" + Math.round(ev.deltaY || 0)
      );
    }, { passive: true });

    hostLog("info", "[native-scene-probe] ready");
    leftBody.focus();
    return true;
  }

  var attempts = 0;
  function waitForFrames() {
    attempts += 1;
    try {
      if (boot()) {
        return;
      }
    } catch (err) {
      hostLog("error", "[native-scene-probe] crash " + (err && err.message ? err.message : String(err)));
      throw err;
    }
    if (attempts < 240) {
      global.setTimeout(waitForFrames, 16);
    } else {
      hostLog("error", "[native-scene-probe] timed out waiting for frames");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", waitForFrames, { once: true });
  } else {
    waitForFrames();
  }
})(typeof window !== "undefined" ? window : this);
