(() => {
  "use strict";
  const ctx = window.__WTI_CONTEXT;
  if (!ctx?.active || !ctx.cookieMode) return;

  // Page code must see this session's readable cookies, never Chrome's shared
  // ones. The background worker holds the real jar; this is its readable part.
  const bridge = ctx.cookieBridge;

  const isExpired = (attributes) => attributes.some((part) => {
    const [key, value = ""] = part.split("=").map((item) => item.trim());
    if (key.toLowerCase() === "max-age") return Number(value) <= 0;
    if (key.toLowerCase() === "expires") return Date.parse(value) <= Date.now();
    return false;
  });

  function applyLocally(header) {
    const [pair, ...attributes] = header.split(";");
    const separator = pair.indexOf("=");
    if (separator <= 0) return;
    const name = pair.slice(0, separator).trim();
    const entries = bridge.text
      ? bridge.text.split("; ").filter((entry) => entry.slice(0, entry.indexOf("=")) !== name)
      : [];
    if (!isExpired(attributes)) entries.push(pair.trim());
    bridge.text = entries.join("; ");
  }

  Object.defineProperty(Document.prototype, "cookie", {
    configurable: true,
    enumerable: true,
    get: () => bridge.text,
    set(value) {
      const header = String(value);
      applyLocally(header);
      bridge.write(header);
      needsFlush = true;
    }
  });

  // Chrome hands a response to the page before the extension has processed its
  // Set-Cookie, so a login followed at once by another request would go out
  // signed out. Requests wait until the cookies they depend on are live.
  let needsFlush = false;
  const settle = () => {
    needsFlush = false;
    return bridge.flush();
  };

  const nativeFetch = window.fetch;
  window.fetch = function fetch(...args) {
    const send = () => nativeFetch.apply(window, args);
    const response = needsFlush ? settle().then(send) : send();
    return response.then(async (result) => {
      await bridge.flush();
      return result;
    });
  };

  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function send(body) {
    this.addEventListener("readystatechange", () => {
      if (this.readyState >= XMLHttpRequest.HEADERS_RECEIVED) needsFlush = true;
    });
    if (!needsFlush) return nativeSend.call(this, body);
    void settle().then(() => {
      try {
        nativeSend.call(this, body);
      } catch {
        // The page aborted the request while it waited.
      }
    });
    return undefined;
  };

  // cookieStore reaches Chrome's shared jar directly. Pages detect its absence
  // and fall back to document.cookie.
  if ("cookieStore" in window) {
    Object.defineProperty(window, "cookieStore", { configurable: true, value: undefined });
  }

  ctx.capabilities.cookieJar = true;
})();
