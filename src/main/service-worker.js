(() => {
  "use strict";
  const ctx = window.__WTI_CONTEXT;
  if (!ctx?.active) return;

  const container = navigator.serviceWorker;
  if (!container) {
    ctx.capabilities.serviceWorkerBlocked = true;
    return;
  }

  const rejectRegistration = () => Promise.reject(new DOMException("Disabled for tab isolation", "SecurityError"));
  const blockRegistration = () => {
    Object.defineProperties(container, {
      register: { configurable: true, value: rejectRegistration },
      getRegistration: { configurable: true, value: async () => undefined },
      getRegistrations: { configurable: true, value: async () => [] }
    });
    ctx.capabilities.serviceWorkerBlocked = true;
  };

  if (window.top !== window) {
    blockRegistration();
    return;
  }

  const preflightKey = `${ctx.prefix}service-worker-preflight`;
  const preflightState = ctx.rawSessionStorage.getItem(preflightKey);

  // A registration may exist even when this document has no controller. Stop
  // the first load of every controlled tab, unregister origin registrations,
  // and reload once before WhatsApp code can execute.
  if (preflightState !== "complete") {
    ctx.state = "removing-service-worker";
    ctx.active = false;
    ctx.rawSessionStorage.setItem(preflightKey, "pending");
    window.stop();
    void container.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .then(() => {
        ctx.rawSessionStorage.setItem(preflightKey, "complete");
        location.reload();
      })
      .catch((error) => {
        ctx.state = "blocked-service-worker";
        ctx.warnings.push(`Service-worker cleanup failed: ${error?.name || "Error"}`);
        if (ctx.report) {
          ctx.report.state = ctx.state;
          ctx.report.warnings = [...ctx.warnings];
          window.postMessage({ type: "WTI_READY", report: ctx.report }, location.origin);
        }
      });
    return;
  }

  if (container.controller) {
    window.stop();
    ctx.active = false;
    ctx.state = "blocked-service-worker";
    ctx.warnings.push("A WhatsApp service worker still controls this tab after cleanup.");
    return;
  }

  blockRegistration();
})();
