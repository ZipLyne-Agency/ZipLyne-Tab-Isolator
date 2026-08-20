(() => {
  "use strict";
  const ctx = window.__WTI_CONTEXT;
  if (!ctx) return;

  if (ctx.blocked || ctx.cleanup) return;
  if (window.top !== window) {
    ctx.state = ctx.active ? "ready-frame" : ctx.state;
    return;
  }

  const report = {
    sessionId: ctx.sessionId,
    state: ctx.active ? "ready" : ctx.state || "blocked",
    serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
    capabilities: { ...ctx.capabilities },
    warnings: [...ctx.warnings]
  };

  if (ctx.active) {
    const required = ["webStorage", "indexedDb", "broadcastChannel", "webLocks", "cacheStorage", "sharedWorkerBlocked", "serviceWorkerBlocked"];
    const missing = required.filter((name) => !report.capabilities[name]);
    if (missing.length) report.warnings.push(`Unavailable isolation layers: ${missing.join(", ")}`);
    ctx.state = "ready";
  }

  Object.defineProperty(window, "__WTI_REPORT", {
    configurable: false,
    enumerable: false,
    value: report,
    writable: false
  });
  ctx.report = report;
  window.postMessage({ type: "WTI_READY", report }, location.origin);
})();
