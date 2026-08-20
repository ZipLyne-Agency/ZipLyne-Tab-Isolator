(() => {
  "use strict";
  const ctx = window.__WTI_CONTEXT;
  if (!ctx?.active) return;

  isolateBroadcastChannel();
  isolateLocks();
  isolateCacheStorage();

  function isolateBroadcastChannel() {
    if (!("BroadcastChannel" in window)) {
      ctx.capabilities.broadcastChannel = false;
      return;
    }
    const NativeBroadcastChannel = window.BroadcastChannel;
    class IsolatedBroadcastChannel extends NativeBroadcastChannel {
      constructor(name) {
        const logicalName = String(name);
        super(ctx.prefix + logicalName);
        Object.defineProperty(this, "name", { configurable: true, enumerable: true, value: logicalName });
      }
    }
    Object.defineProperty(window, "BroadcastChannel", { configurable: false, value: IsolatedBroadcastChannel });
    ctx.capabilities.broadcastChannel = true;
  }

  function isolateLocks() {
    const locks = navigator.locks;
    if (!locks?.request || !locks?.query) {
      ctx.capabilities.webLocks = false;
      return;
    }
    const nativeRequest = locks.request.bind(locks);
    const nativeQuery = locks.query.bind(locks);
    Object.defineProperty(locks, "request", {
      configurable: true,
      value(name, ...args) {
        return nativeRequest(ctx.prefix + String(name), ...args);
      }
    });
    Object.defineProperty(locks, "query", {
      configurable: true,
      async value() {
        const state = await nativeQuery();
        const map = (entry) => ({ ...entry, name: entry.name.slice(ctx.prefix.length) });
        return {
          held: (state.held || []).filter((entry) => entry.name.startsWith(ctx.prefix)).map(map),
          pending: (state.pending || []).filter((entry) => entry.name.startsWith(ctx.prefix)).map(map)
        };
      }
    });
    ctx.capabilities.webLocks = true;
  }

  function isolateCacheStorage() {
    if (!("caches" in window)) {
      ctx.capabilities.cacheStorage = false;
      return;
    }
    const native = window.caches;
    const isolated = {
      open: (name) => native.open(ctx.prefix + String(name)),
      has: (name) => native.has(ctx.prefix + String(name)),
      delete: (name) => native.delete(ctx.prefix + String(name)),
      async keys() {
        return (await native.keys())
          .filter((name) => name.startsWith(ctx.prefix))
          .map((name) => name.slice(ctx.prefix.length));
      },
      async match(request, options = {}) {
        if (options.cacheName !== undefined) {
          return native.match(request, { ...options, cacheName: ctx.prefix + String(options.cacheName) });
        }
        for (const logicalName of await this.keys()) {
          const match = await (await this.open(logicalName)).match(request, options);
          if (match) return match;
        }
        return undefined;
      }
    };
    Object.setPrototypeOf(isolated, CacheStorage.prototype);
    Object.defineProperty(window, "caches", { configurable: false, value: isolated });
    ctx.capabilities.cacheStorage = true;
  }
})();
