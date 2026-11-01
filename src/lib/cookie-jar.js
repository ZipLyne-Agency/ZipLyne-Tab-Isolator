// A per-session cookie jar. Pure data and functions so it can run in the
// extension service worker and in Node tests. Paths are stored but not used to
// scope sending: a cookie goes to every path on its host, longest path first.

export const MAX_COOKIES = 300;
const MAX_COOKIE_BYTES = 4096;
const PRINTABLE = /^[\x20-\x7e]*$/;

export function domainMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function defaultPath(pathname) {
  const end = pathname.lastIndexOf("/");
  return end <= 0 ? "/" : pathname.slice(0, end);
}

function parseExpiry(attributes, now) {
  if (attributes.has("max-age")) {
    const seconds = Number(attributes.get("max-age"));
    if (Number.isFinite(seconds)) return seconds <= 0 ? 0 : now + seconds * 1000;
  }
  if (attributes.has("expires")) {
    const timestamp = Date.parse(attributes.get("expires"));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

// Returns a cookie record, or null when a browser would reject the header.
export function parseSetCookie(header, requestUrl, { siteDomain, now = Date.now(), fromScript = false } = {}) {
  const url = new URL(requestUrl);
  const host = url.hostname.toLowerCase();
  const secureScheme = url.protocol === "https:" || url.protocol === "wss:";

  const [pair, ...rest] = String(header).split(";");
  const separator = pair.indexOf("=");
  if (separator <= 0) return null;
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (!name || !PRINTABLE.test(name) || !PRINTABLE.test(value)) return null;
  if (name.length + value.length > MAX_COOKIE_BYTES) return null;

  const attributes = new Map();
  for (const part of rest) {
    const index = part.indexOf("=");
    const key = (index < 0 ? part : part.slice(0, index)).trim().toLowerCase();
    if (key) attributes.set(key, index < 0 ? "" : part.slice(index + 1).trim());
  }

  const secure = attributes.has("secure");
  const httpOnly = attributes.has("httponly");
  if ((secure && !secureScheme) || (fromScript && httpOnly)) return null;

  const requestedDomain = (attributes.get("domain") || "").replace(/^\./, "").toLowerCase();
  if (requestedDomain && !domainMatches(host, requestedDomain)) return null;
  const hostOnly = !requestedDomain;
  // A cookie wider than the isolated site is held at the site boundary, so the
  // session never sends it to a sibling domain that is not isolated.
  const domain = hostOnly
    ? host
    : siteDomain && !domainMatches(requestedDomain, siteDomain) ? siteDomain : requestedDomain;

  const requestedPath = attributes.get("path");
  const path = requestedPath?.startsWith("/") ? requestedPath : defaultPath(url.pathname);

  if (name.startsWith("__Secure-") && !secure) return null;
  if (name.startsWith("__Host-") && (!secure || !hostOnly || path !== "/")) return null;

  return {
    name,
    value,
    domain,
    hostOnly,
    path,
    secure,
    httpOnly,
    expires: parseExpiry(attributes, now),
    createdAt: now
  };
}

const sameCookie = (a, b) => a.name === b.name && a.domain === b.domain && a.path === b.path;

// Returns the next jar plus what changed. `significant` marks a change that a
// follow-up request must see: a new cookie or a new HttpOnly value.
export function storeCookie(jar, cookie, { now = Date.now(), fromScript = false } = {}) {
  const existing = jar.find((entry) => sameCookie(entry, cookie));
  if (fromScript && existing?.httpOnly) return { jar, changed: false, significant: false, visible: false };

  if (cookie.expires !== null && cookie.expires <= now) {
    if (!existing) return { jar, changed: false, significant: false, visible: false };
    return {
      jar: jar.filter((entry) => entry !== existing),
      changed: true,
      significant: true,
      visible: !existing.httpOnly
    };
  }

  if (existing?.value === cookie.value && existing.expires === cookie.expires && existing.httpOnly === cookie.httpOnly) {
    return { jar, changed: false, significant: false, visible: false };
  }

  const stored = { ...cookie, createdAt: existing?.createdAt ?? cookie.createdAt };
  let next = existing ? jar.map((entry) => entry === existing ? stored : entry) : [...jar, stored];
  if (next.length > MAX_COOKIES) {
    const oldest = [...next].sort((a, b) => a.createdAt - b.createdAt)[0];
    next = next.filter((entry) => entry !== oldest);
  }
  return {
    jar: next,
    changed: true,
    significant: !existing || cookie.httpOnly,
    visible: !cookie.httpOnly || Boolean(existing && !existing.httpOnly)
  };
}

export function applySetCookie(jar, header, requestUrl, options = {}) {
  const cookie = parseSetCookie(header, requestUrl, options);
  if (!cookie) return { jar, changed: false, significant: false, visible: false };
  return storeCookie(jar, cookie, options);
}

export function liveCookies(jar, now = Date.now()) {
  return jar.filter((cookie) => cookie.expires === null || cookie.expires > now);
}

export function normalizeJar(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((cookie) => cookie
    && typeof cookie.name === "string"
    && typeof cookie.value === "string"
    && typeof cookie.domain === "string"
    && typeof cookie.path === "string");
}

function appliesToScope(cookie, scope) {
  if (cookie.hostOnly) return !scope.wildcard && scope.host === cookie.domain;
  return domainMatches(scope.host, cookie.domain);
}

function serialize(cookies) {
  return [...cookies]
    .sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export function cookieHeaderForScope(jar, scope, { visibleOnly = false, now = Date.now() } = {}) {
  return serialize(liveCookies(jar, now).filter((cookie) => appliesToScope(cookie, scope)
    && !(visibleOnly && cookie.httpOnly)));
}

// What page script on `host` may read through document.cookie.
export function visibleCookiesForHost(jar, host, now = Date.now()) {
  return cookieHeaderForScope(jar, { host, wildcard: false }, { visibleOnly: true, now });
}

// One scope per distinct cookie host. Exact scopes outrank wildcard ones so a
// host-only cookie never reaches a subdomain.
export function cookieScopes(jar, siteDomain, now = Date.now()) {
  const scopes = new Map([[`*${siteDomain}`, { host: siteDomain, wildcard: true }]]);
  for (const cookie of liveCookies(jar, now)) {
    scopes.set(`${cookie.hostOnly ? "" : "*"}${cookie.domain}`, { host: cookie.domain, wildcard: !cookie.hostOnly });
  }
  return [...scopes.values()];
}
