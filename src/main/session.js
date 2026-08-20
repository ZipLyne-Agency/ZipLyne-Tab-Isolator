(() => {
  "use strict";

  const SESSION_KEY = "wti_session";
  const CLEANUP_KEY = "wti_cleanup";
  const CLEANUP_TOKEN_KEY = "wti_cleanup_token";
  const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const url = new URL(location.href);
  let markerUrl = url;
  if (window.top !== window) {
    try {
      markerUrl = new URL(window.top.location.href);
    } catch {
      markerUrl = url;
    }
  }
  const sessionId = markerUrl.searchParams.get(SESSION_KEY);
  const cleanupMetadataPresent = window.top === window
    && (url.searchParams.has(CLEANUP_KEY) || url.searchParams.has(CLEANUP_TOKEN_KEY));
  const cleanupRequested = cleanupMetadataPresent && url.searchParams.get(CLEANUP_KEY) === "1";
  const cleanupToken = url.searchParams.get(CLEANUP_TOKEN_KEY);
  const validSession = ID_PATTERN.test(sessionId || "");
  const validCleanupToken = ID_PATTERN.test(cleanupToken || "");
  const rawLocalStorage = window.localStorage;
  const rawSessionStorage = window.sessionStorage;

  const context = {
    active: validSession && !cleanupMetadataPresent,
    blocked: !validSession || (cleanupMetadataPresent && (!cleanupRequested || !validCleanupToken)),
    cleanup: validSession && cleanupRequested && validCleanupToken,
    sessionId: validSession ? sessionId : null,
    cleanupToken: validCleanupToken ? cleanupToken : null,
    prefix: validSession ? `__wti__${sessionId}::` : null,
    rawLocalStorage,
    rawSessionStorage,
    capabilities: {},
    warnings: ["HTTP cookies remain shared across this Chrome profile."],
    workerBlobUrls: new Set()
  };

  Object.defineProperty(window, "__WTI_CONTEXT", {
    value: context,
    configurable: false,
    enumerable: false,
    writable: false
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === "WTI_RELAY_READY") {
      if (context.report) window.postMessage({ type: "WTI_READY", report: context.report }, location.origin);
      if (context.cleanupResult) {
        window.postMessage({ type: "WTI_CLEANUP_COMPLETE", result: context.cleanupResult }, location.origin);
      }
    }
    if (event.data?.type === "WTI_CLEANUP_FAILED" && context.cleanup) {
      renderStatus("Cleanup incomplete", "Some isolated data could not be removed. Close apps using this session, then reload this tab to retry.");
    }
  });

  if (context.blocked) {
    window.stop();
    context.state = "blocked";
    renderStatus(
      "WhatsApp Tab Isolator",
      "This WhatsApp tab has no valid session marker. Open Personal or Business from the extension popup."
    );
    return;
  }

  if (context.cleanup) {
    window.stop();
    context.state = "cleaning";
    let cleanupResult = null;
    Object.defineProperty(window, "__WTI_CLEANUP_RESULT", {
      configurable: false,
      enumerable: false,
      get: () => cleanupResult
    });
    void cleanupNamespace(context).catch(() => ({
      sessionId: context.sessionId,
      cleanupToken: context.cleanupToken,
      errors: ["Cleanup could not complete"]
    })).then((result) => {
      cleanupResult = result;
      context.cleanupResult = result;
      window.postMessage({ type: "WTI_CLEANUP_COMPLETE", result }, location.origin);
      renderStatus("Finalizing cleanup", "Checking that all isolated WhatsApp data was removed…");
    });
    return;
  }

  context.state = "initializing";
  preserveSessionMarker(context.sessionId);

  function preserveSessionMarker(id) {
    const nativePush = history.pushState.bind(history);
    const nativeReplace = history.replaceState.bind(history);

    const markedUrl = (candidate) => {
      if (candidate === undefined || candidate === null || candidate === "") return candidate;
      try {
        const next = new URL(candidate, location.href);
        if (next.origin !== location.origin) return candidate;
        next.searchParams.set(SESSION_KEY, id);
        return `${next.pathname}${next.search}${next.hash}`;
      } catch {
        return candidate;
      }
    };

    history.pushState = (state, unused, candidate) => nativePush(state, unused, markedUrl(candidate));
    history.replaceState = (state, unused, candidate) => nativeReplace(state, unused, markedUrl(candidate));
  }

  async function cleanupNamespace(ctx) {
    const errors = [];
    let localKeys = 0;
    let sessionKeys = 0;

    for (const key of storageKeys(ctx.rawLocalStorage)) {
      if (key.startsWith(ctx.prefix)) {
        ctx.rawLocalStorage.removeItem(key);
        localKeys += 1;
      }
    }
    for (const key of storageKeys(ctx.rawSessionStorage)) {
      if (key.startsWith(ctx.prefix)) {
        ctx.rawSessionStorage.removeItem(key);
        sessionKeys += 1;
      }
    }

    const databaseNames = typeof indexedDB.databases === "function"
      ? (await indexedDB.databases()).map((entry) => entry.name).filter(Boolean)
      : [];
    const databases = await deleteNamedResources(
      databaseNames.filter((name) => name.startsWith(ctx.prefix)),
      (name) => indexedDB.deleteDatabase(name),
      errors
    );

    const cacheNames = "caches" in window ? await caches.keys() : [];
    const cacheResults = await Promise.all(
      cacheNames.filter((name) => name.startsWith(ctx.prefix)).map((name) => caches.delete(name))
    );

    let opfs = false;
    try {
      if (navigator.storage?.getDirectory) {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(`wti-${ctx.sessionId}`, { recursive: true });
        opfs = true;
      }
    } catch (error) {
      if (error?.name !== "NotFoundError") errors.push("OPFS cleanup failed");
    }

    return {
      sessionId: ctx.sessionId,
      cleanupToken: ctx.cleanupToken,
      localKeys,
      sessionKeys,
      databases,
      caches: cacheResults.filter(Boolean).length,
      opfs,
      errors
    };
  }

  function storageKeys(storage) {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) keys.push(key);
    }
    return keys;
  }

  async function deleteNamedResources(names, deleteResource, errors) {
    let deleted = 0;
    for (const name of names) {
      const success = await new Promise((resolve) => {
        const request = deleteResource(name);
        const timer = setTimeout(() => resolve(false), 1500);
        request.onsuccess = () => { clearTimeout(timer); resolve(true); };
        request.onerror = () => { clearTimeout(timer); resolve(false); };
        request.onblocked = () => { clearTimeout(timer); resolve(false); };
      });
      if (success) deleted += 1;
      else errors.push(`Could not delete database ${name.slice(0, 80)}`);
    }
    return deleted;
  }

  function renderStatus(title, message) {
    const render = () => {
      if (!document.documentElement) {
        setTimeout(render, 0);
        return;
      }
      document.documentElement.innerHTML = "";
      const head = document.createElement("head");
      const style = document.createElement("style");
      style.textContent = "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b141a;color:#e9edef;font:16px system-ui,sans-serif}.card{max-width:520px;margin:24px;padding:28px;border:1px solid #2a3942;border-radius:18px;background:#111b21;box-shadow:0 18px 60px #0008}h1{margin:0 0 10px;font-size:24px}p{margin:0;color:#aebac1;line-height:1.5}";
      head.append(style);
      const body = document.createElement("body");
      const card = document.createElement("main");
      card.className = "card";
      const heading = document.createElement("h1");
      heading.textContent = title;
      const copy = document.createElement("p");
      copy.textContent = message;
      card.append(heading, copy);
      body.append(card);
      document.documentElement.append(head, body);
    };
    render();
  }
})();
