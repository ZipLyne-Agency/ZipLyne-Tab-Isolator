(() => {
  "use strict";
  const ctx = window.__WTI_CONTEXT;
  if (!ctx?.active) return;

  // Current WhatsApp CSP permits only its own worker URLs, not Blob workers.
  // A MAIN-world extension cannot prepend storage shims inside a dedicated
  // Worker without changing its origin or violating that CSP. Keep dedicated
  // Workers functional and surface the unsupported boundary explicitly.
  ctx.capabilities.dedicatedWorkerStorage = false;
  ctx.warnings.push("Dedicated Worker storage is not isolated.");

  // SharedWorkers are cross-tab by design. Blocking them is safer than letting
  // two named sessions coordinate through one origin-wide worker instance.
  if (typeof window.SharedWorker === "function") {
    const BlockedSharedWorker = function SharedWorker() {
      throw new DOMException("SharedWorker disabled for tab isolation", "SecurityError");
    };
    Object.defineProperty(window, "SharedWorker", {
      configurable: false,
      enumerable: true,
      value: BlockedSharedWorker
    });
    ctx.capabilities.sharedWorkerBlocked = true;
  } else {
    ctx.capabilities.sharedWorkerBlocked = true;
  }
})();
