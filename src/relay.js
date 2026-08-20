(() => {
  "use strict";
  let currentReport = null;
  let labelRoot = null;
  let titleObserver = null;

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === "WTI_READY") void receiveReport(event.data.report);
    if (event.data?.type === "WTI_CLEANUP_COMPLETE") void relayCleanup(event.data.result);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_TAB_DIAGNOSTICS") sendResponse({ ok: true, report: currentReport });
  });

  window.postMessage({ type: "WTI_RELAY_READY" }, location.origin);

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
    const apply = () => {
      if (document.title && !document.title.startsWith(prefix)) document.title = prefix + document.title;
    };
    titleObserver?.disconnect();
    titleObserver = new MutationObserver(apply);
    const start = () => {
      const title = document.querySelector("title");
      if (title) {
        apply();
        titleObserver.observe(title, { childList: true, subtree: true, characterData: true });
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
