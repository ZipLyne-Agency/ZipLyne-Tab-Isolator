(() => {
  "use strict";
  const TAB_SESSION_KEY = "__wti_tab_session";
  const TAB_PROOF_KEY = "__wti_tab_proof";
  const RELOADS_KEY = "__wti_tab_reloads";
  const MAX_RELOADS = 3;
  const RELOAD_WINDOW_MS = 20000;
  const ACCESS_TIMEOUT_MS = 5000;
  let currentReport = null;
  let labelRoot = null;
  let titleObserver = null;
  let titlePrefix = null;
  let searchRoot = null;

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === "WTI_READY") void receiveReport(event.data.report);
    if (event.data?.type === "WTI_CLEANUP_COMPLETE") void relayCleanup(event.data.result);
    if (event.data?.type === "WTI_COOKIE_WRITE") {
      void chrome.runtime.sendMessage({ type: "COOKIE_WRITE", header: String(event.data.header) });
    }
    if (event.data?.type === "WTI_FLUSH") void relayFlush(event.data.id);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_TAB_DIAGNOSTICS") sendResponse({ ok: true, report: currentReport });
    if (message?.type === "COOKIES_CHANGED") void pushVisibleCookies();
    if (message?.type === "PROFILE_UPDATED" && currentReport) installLabel(message.profile, currentReport);
    if (message?.type === "ACCOUNT_SEARCH" && window.top === window) showSearch(message.state);
    if (message?.type === "CHECK_ACCESS" && window.top === window) {
      void Promise.all(message.requests.map(requestStatus)).then(sendResponse);
      return true;
    }
    return undefined;
  });

  window.postMessage({ type: "WTI_RELAY_READY" }, location.origin);
  if (location.hostname !== "web.whatsapp.com" && window.top === window) void reconcileTab();

  async function relayFlush(id) {
    try {
      await chrome.runtime.sendMessage({ type: "FLUSH_COOKIES" });
    } catch {
      // The extension was reloaded under this page. Requests must not stall.
    }
    window.postMessage({ type: "WTI_FLUSHED", id }, location.origin);
  }

  // The extension's network rule adds the cookies. Runs out of the page's reach,
  // and the response body, which can hold tokens, is never read.
  async function requestStatus({ url, headers }) {
    try {
      const options = { credentials: "omit", cache: "no-store", headers, signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS) };
      return (await fetch(url, options)).status;
    } catch {
      return 0;
    }
  }

  async function pushVisibleCookies() {
    const response = await chrome.runtime.sendMessage({ type: "GET_VISIBLE_COOKIES" });
    if (response?.ok) window.postMessage({ type: "WTI_COOKIES", cookies: response.cookies }, location.origin);
  }

  // A page with no session marker may still belong to a session: a service
  // worker answered it, the tab was restored or duplicated, or a new tab loaded
  // before its rules were ready. Bind the tab, then load the page again.
  async function reconcileTab() {
    const timing = performance.getEntriesByType("navigation")[0]?.serverTiming ?? [];
    if (timing.some((entry) => entry.name === "wti")) return;

    const remembered = readStored(TAB_SESSION_KEY);
    const hello = await chrome.runtime.sendMessage({ type: "TAB_HELLO" });
    if (!hello?.sessionId && !remembered) return;

    if (!hello?.sessionId) {
      const bound = await chrome.runtime.sendMessage({
        type: "BIND_STORED_SESSION",
        sessionId: remembered,
        proof: readStored(TAB_PROOF_KEY)
      });
      if (!bound?.ok) {
        // The session was forgotten, or this tab never belonged to it. It becomes an ordinary tab.
        sessionStorage.removeItem(TAB_SESSION_KEY);
        sessionStorage.removeItem(TAB_PROOF_KEY);
        location.reload();
        return;
      }
    }

    if (!reloadAllowed()) {
      window.postMessage({ type: "WTI_RELOAD_FAILED" }, location.origin);
      return;
    }
    await unregisterControllingWorkers();
    location.reload();
  }

  function readStored(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function reloadAllowed() {
    const now = Date.now();
    const recent = JSON.parse(readStored(RELOADS_KEY) || "[]").filter((time) => now - time < RELOAD_WINDOW_MS);
    sessionStorage.setItem(RELOADS_KEY, JSON.stringify([...recent, now]));
    return recent.length < MAX_RELOADS;
  }

  async function unregisterControllingWorkers() {
    const registrations = await navigator.serviceWorker?.getRegistrations() ?? [];
    await Promise.all(registrations
      .filter((registration) => location.href.startsWith(registration.scope))
      .map((registration) => registration.unregister()));
  }

  async function receiveReport(report) {
    if (!validReport(report)) return;
    currentReport = report;
    await chrome.runtime.sendMessage({ type: "SESSION_READY", report });
    const response = await chrome.runtime.sendMessage({ type: "GET_PROFILE", id: report.sessionId });
    if (response?.ok && response.profile) installLabel(response.profile, report);
  }

  async function relayCleanup(result) {
    if (!result || typeof result.sessionId !== "string") return;
    const response = await chrome.runtime.sendMessage({
      type: "CLEANUP_COMPLETE",
      sessionId: result.sessionId,
      cleanupToken: result.cleanupToken,
      errors: Array.isArray(result.errors) ? result.errors : []
    });
    if (!response?.ok) {
      window.postMessage({
        type: "WTI_CLEANUP_FAILED",
        error: typeof response?.error === "string" ? response.error : "Session cleanup was incomplete"
      }, location.origin);
    }
  }

  function showSearch(state) {
    searchRoot?.remove();
    searchRoot = document.createElement("div");
    const shadow = searchRoot.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = ":host{all:initial;position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;pointer-events:none}.pill{padding:8px 13px;border-radius:999px;background:#0b141ae8;color:#f4f8f5;border:1px solid #ffffff2e;box-shadow:0 5px 18px #0006;font:600 12px/1.2 system-ui,sans-serif}";
    const pill = document.createElement("div");
    pill.className = "pill";
    pill.textContent = state === "searching" ? "Checking your other accounts" : "Not on your other accounts";
    shadow.append(style, pill);
    appendWhenReady(searchRoot);
  }

  function installLabel(profile, report) {
    if (labelRoot) labelRoot.remove();
    labelRoot = document.createElement("div");
    labelRoot.setAttribute("data-wti-label", "");
    const shadow = labelRoot.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = ":host{all:initial;position:fixed;left:10px;bottom:10px;z-index:2147483647;pointer-events:none}.pill{display:flex;align-items:center;gap:7px;padding:6px 9px;border-radius:999px;background:#0b141ae8;color:#f4f8f5;border:1px solid #ffffff2e;box-shadow:0 5px 18px #0006;font:600 11px/1.2 system-ui,sans-serif}.dot{width:8px;height:8px;border-radius:50%}.warn{color:#ffd166}";
    const pill = document.createElement("div");
    pill.className = `pill${report.warnings?.length > 1 ? " warn" : ""}`;
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.backgroundColor = profile.color;
    const text = document.createElement("span");
    text.textContent = profile.name;
    pill.append(dot, text);
    shadow.append(style, pill);
    appendWhenReady(labelRoot);
    keepTitleLabeled(profile.name);
  }

  function appendWhenReady(node) {
    if (document.documentElement) document.documentElement.append(node);
    else setTimeout(() => appendWhenReady(node), 0);
  }

  function keepTitleLabeled(name) {
    const prefix = `[${name}] `;
    // A tab can be labeled again with the same name: its ready report can arrive
    // twice, and a color change relabels it.
    if (prefix === titlePrefix) return;
    const previous = titlePrefix;
    titlePrefix = prefix;
    const apply = () => {
      const current = document.title;
      const title = previous && current.startsWith(previous) ? current.slice(previous.length) : current;
      if (!title) return;
      const labeled = title.startsWith(prefix) ? title : prefix + title;
      // Writing the title fires this observer, so an unchanged title is never written.
      if (labeled !== current) document.title = labeled;
    };
    titleObserver?.disconnect();
    // Observer callbacks run before the page can do anything else, so a write
    // made directly inside one can starve the tab if a page fights over its title.
    titleObserver = new MutationObserver(() => setTimeout(apply, 0));
    // Watch the whole head: page-swapping apps replace the title element.
    const start = () => {
      if (document.head) {
        apply();
        titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
      } else {
        setTimeout(start, 25);
      }
    };
    start();
  }

  function validReport(report) {
    return Boolean(report && typeof report === "object" && typeof report.sessionId === "string");
  }
})();
