// Compiles one session's cookie jar into declarativeNetRequest session rules.
// Pure, so the exact rule shape is covered by Node tests.

import { cookieHeaderForScope, cookieScopes } from "./cookie-jar.js";

export const RULES_PER_SESSION = 1000;
// Session rules start above RULES_PER_SESSION, which leaves the ids below it free.
export const MAX_ACCESS_RULE_ID = RULES_PER_SESSION - 1;
const ACCESS_RULE_PRIORITY = 10000;
// Three rules per session, then four per scope, must fit the session's id range.
const MAX_SCOPES = 240;
export const MARKER_METRIC = "wti";
export const PROOF_METRIC = "wtik";
export const VISIBLE_COOKIES_METRIC = "wtic";

const FRAME_TYPES = ["main_frame", "sub_frame"];
const UNCACHED_TYPES = [
  ...FRAME_TYPES, "xmlhttprequest", "image", "media", "script", "stylesheet", "font", "object", "webbundle", "other"
];
const SAFE_METHODS = ["get", "head"];
const SUBRESOURCE_TYPES = [
  "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping",
  "csp_report", "media", "websocket", "webtransport", "webbundle", "other"
];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function hostRegex({ host, wildcard }) {
  return `^(?:https|wss)://${wildcard ? "(?:[^/]*\\.)?" : ""}${escapeRegex(host)}(?::\\d+)?/`;
}

function encodeVisible(cookies) {
  return btoa(cookies).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function scopeRules(scope, jar, siteDomain, now, nextId) {
  const header = cookieHeaderForScope(jar, scope, { now });
  if (!header) return [];

  const visible = cookieHeaderForScope(jar, scope, { visibleOnly: true, now });
  const priority = 10 + scope.host.length + (scope.wildcard ? 0 : 500);
  const regexFilter = hostRegex(scope);
  const setCookie = { header: "cookie", operation: "set", value: header };
  const documentAction = {
    type: "modifyHeaders",
    requestHeaders: [setCookie],
    responseHeaders: visible
      ? [{ header: "server-timing", operation: "append", value: `${VISIBLE_COOKIES_METRIC};desc="${encodeVisible(visible)}"` }]
      : undefined
  };
  const rule = (action, condition) => ({
    id: nextId(),
    priority,
    action: JSON.parse(JSON.stringify(action)),
    condition: { regexFilter, isUrlFilterCaseSensitive: false, ...condition }
  });

  // Cookies follow SameSite=Lax: a safe top-level navigation from anywhere,
  // everything else only from the site itself. A page the tab wandered to cannot
  // make credentialed requests into the session, form posts included.
  return [
    rule(documentAction, { resourceTypes: ["main_frame"], requestMethods: SAFE_METHODS }),
    rule(documentAction, { resourceTypes: ["main_frame"], excludedRequestMethods: SAFE_METHODS, initiatorDomains: [siteDomain] }),
    rule(documentAction, { resourceTypes: ["sub_frame"], initiatorDomains: [siteDomain] }),
    rule(
      { type: "modifyHeaders", requestHeaders: [setCookie] },
      { resourceTypes: SUBRESOURCE_TYPES, initiatorDomains: [siteDomain] }
    )
  ];
}

// Outranks the tab's own rules for one exact URL. The answer's cookies are
// dropped: they belong to neither the tab's session nor Chrome's shared jar.
export function buildAccessRule({ id, tabId, url, cookie }) {
  return {
    id,
    priority: ACCESS_RULE_PRIORITY,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "cookie", operation: "set", value: cookie }],
      responseHeaders: [{ header: "set-cookie", operation: "remove" }]
    },
    condition: {
      tabIds: [tabId],
      regexFilter: `^${escapeRegex(url)}$`,
      isUrlFilterCaseSensitive: true,
      resourceTypes: ["xmlhttprequest"]
    }
  };
}

export function buildSessionRules({ slot, sessionId, proof, tabIds, siteDomain, jar, now = Date.now() }) {
  if (!tabIds.length) return [];

  let id = (slot + 1) * RULES_PER_SESSION;
  const nextId = () => {
    id += 1;
    return id;
  };
  const site = hostRegex({ host: siteDomain, wildcard: true });
  const condition = (resourceTypes) => ({ tabIds, regexFilter: site, isUrlFilterCaseSensitive: false, resourceTypes });

  const base = [
    {
      // The floor for every request: nothing from Chrome's shared cookies goes
      // out, and nothing the site sets reaches them.
      id: nextId(),
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "cookie", operation: "remove" }],
        responseHeaders: [{ header: "set-cookie", operation: "remove" }]
      },
      condition: condition([...FRAME_TYPES, ...SUBRESOURCE_TYPES])
    },
    {
      // Readable at document_start, before page code, on every page in the tab.
      id: nextId(),
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "server-timing", operation: "append", value: `${MARKER_METRIC};desc="${sessionId}"` },
          // Only this session's tabs see it, so it proves a tab belonged here.
          { header: "server-timing", operation: "append", value: `${PROOF_METRIC};desc="${proof}"` }
        ]
      },
      condition: condition(FRAME_TYPES)
    },
    {
      // The HTTP cache is shared across tabs and ignores cookies, so one
      // account's cached response could otherwise be served to another.
      id: nextId(),
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "cache-control", operation: "set", value: "no-cache" },
          { header: "pragma", operation: "set", value: "no-cache" }
        ]
      },
      condition: condition(UNCACHED_TYPES)
    }
  ];

  const scoped = cookieScopes(jar, siteDomain, now)
    .slice(0, MAX_SCOPES)
    .flatMap((scope) => scopeRules(scope, jar, siteDomain, now, nextId))
    .map((rule) => ({ ...rule, condition: { ...rule.condition, tabIds } }));

  return [...base, ...scoped];
}
