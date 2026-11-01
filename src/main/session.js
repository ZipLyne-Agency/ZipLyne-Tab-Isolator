(() => {
  "use strict";

  const SESSION_KEY = "wti_session";
  const CLEANUP_KEY = "wti_cleanup";
  const CLEANUP_TOKEN_KEY = "wti_cleanup_token";
  const TAB_SESSION_KEY = "__wti_tab_session";
  const TAB_PROOF_KEY = "__wti_tab_proof";
  const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  // WhatsApp is one page, so its session lives in the URL. Other sites navigate
  // freely, so their session comes from the tab's network rules instead.
  const usesUrlMarker = location.hostname === "web.whatsapp.com";
  const url = new URL(location.href);
  let markerUrl = url;
  if (window.top !== window) {
    try {
      markerUrl = new URL(window.top.location.href);
    } catch {
      markerUrl = url;
    }
  }
  const cleanupMetadataPresent = window.top === window
    && (url.searchParams.has(CLEANUP_KEY) || url.searchParams.has(CLEANUP_TOKEN_KEY));
  const tabMarker = usesUrlMarker ? null : readTabMarker();

  if (!usesUrlMarker && !tabMarker && !cleanupMetadataPresent) {
    runPlainTab();
    return;
  }

  const sessionId = tabMarker?.sessionId ?? markerUrl.searchParams.get(SESSION_KEY);
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
    warnings: usesUrlMarker ? ["HTTP cookies remain shared across this Chrome profile."] : [],
    workerBlobUrls: new Set(),
    cookieMode: Boolean(tabMarker),
    cookieBridge: tabMarker?.bridge ?? null
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
    if (event.data?.type === "WTI_COOKIES" && context.cookieBridge) {
      context.cookieBridge.text = String(event.data.cookies ?? "");
    }
    if (event.data?.type === "WTI_CLEANUP_FAILED" && context.cleanup) {
      renderStatus("Cleanup incomplete", "Some isolated data could not be removed. Close apps using this session, then reload this tab to retry.");
    }
  });

  if (context.blocked) {
    window.stop();
    context.state = "blocked";
    renderStatus(
      "ZipLyne Tab Isolator",
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
      renderStatus("Finalizing cleanup", "Checking that all isolated data was removed…");
    });
    return;
  }

  context.state = "initializing";
  if (usesUrlMarker) preserveSessionMarker(context.sessionId);
  if (context.cookieMode && window.top === window) {
    rawSessionStorage.setItem(TAB_SESSION_KEY, context.sessionId);
    if (tabMarker.proof) rawSessionStorage.setItem(TAB_PROOF_KEY, tabMarker.proof);
  }

  function readTabMarker() {
    const timing = performance.getEntriesByType("navigation")[0]?.serverTiming ?? [];
    const id = timing.find((entry) => entry.name === "wti")?.description;
    if (ID_PATTERN.test(id || "")) {
      // Every matching scope appends its own list and the most specific one is
      // a superset of the rest, so the longest is the right one.
      const visible = timing
        .filter((entry) => entry.name === "wtic")
        .map((entry) => decodeCookies(entry.description))
        .sort((a, b) => b.length - a.length)[0] ?? "";
      const proof = timing.find((entry) => entry.name === "wtik")?.description;
      return { sessionId: id, proof, bridge: createCookieBridge(visible) };
    }
    if (window.top === window) return null;
    try {
      // about:blank and srcdoc frames have no response of their own.
      const parent = window.parent.__WTI_CONTEXT;
      return parent?.cookieMode ? { sessionId: parent.sessionId, bridge: parent.cookieBridge } : null;
    } catch {
      return null;
    }
  }

  function decodeCookies(encoded) {
    try {
      return atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    } catch {
      return "";
    }
  }

  function createCookieBridge(text) {
    const waiting = new Map();
    let nextFlush = 0;
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data?.type !== "WTI_FLUSHED") return;
      waiting.get(event.data.id)?.();
    });
    return {
      text,
      write: (header) => window.postMessage({ type: "WTI_COOKIE_WRITE", header }, location.origin),
      // Resolves once every cookie reported so far is live in the tab's rules.
      flush: () => new Promise((resolve) => {
        const id = (nextFlush += 1);
        const finish = () => {
          waiting.delete(id);
          resolve();
        };
        waiting.set(id, finish);
        // A page must not hang if the extension goes away mid-request.
        setTimeout(finish, 1500);
        window.postMessage({ type: "WTI_FLUSH", id }, location.origin);
      })
    };
  }

  // An ordinary tab on an isolated site runs untouched. If it remembers a
  // session (restored or duplicated tab), hold the page until the relay has
  // rebound the tab, so it never runs as the shared account.
  function runPlainTab() {
    Object.defineProperty(window, "__WTI_CONTEXT", {
      value: { active: false, blocked: false, plain: true, capabilities: {}, warnings: [] },
      configurable: false,
      enumerable: false,
      writable: false
    });
    if (window.top !== window) return;
    let remembered = null;
    try {
      remembered = window.sessionStorage.getItem(TAB_SESSION_KEY);
    } catch {
      return;
    }
    if (ID_PATTERN.test(remembered || "")) window.stop();
    window.addEventListener("message", (event) => {
      if (event.source === window && event.data?.type === "WTI_RELOAD_FAILED") {
        renderStatus("Session could not start", "Close this tab and open the session from the extension.");
      }
    });
  }

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
