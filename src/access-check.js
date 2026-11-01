// Asks the site directly which signed-in session can see a page, so nothing has
// to open. The tab showing the page sends the requests, because a request needs
// a tab for its network rule to apply. Each rule adds one session's cookies to a
// single request, found by a random marker the page cannot guess, and only the
// status comes back.

import { cookieHeaderForScope } from "./lib/cookie-jar.js";
import { buildAccessRule, MAX_ACCESS_RULE_ID } from "./lib/cookie-rules.js";
import { accessRequest, ACCESS_MARKER } from "./lib/access-checks.js";

let lastRuleId = 0;

function nextRuleId() {
  lastRuleId = lastRuleId % MAX_ACCESS_RULE_ID + 1;
  return lastRuleId;
}

async function buildChecks(pageUrl, sessionIds, readJar) {
  const checks = [];
  for (const sessionId of sessionIds) {
    const jar = await readJar(sessionId);
    const request = accessRequest(pageUrl, jar);
    if (!request) continue;
    const url = new URL(request.url);
    url.searchParams.set(ACCESS_MARKER, crypto.randomUUID());
    const cookie = cookieHeaderForScope(jar, { host: url.hostname, wildcard: false });
    checks.push({ sessionId, url: url.href, headers: request.headers, cookie, ruleId: nextRuleId() });
  }
  return checks;
}

// Resolves with a session the site says can see the page, or null when none did
// or the question could not be asked.
export async function findSessionWithAccess({ tabId, pageUrl, sessionIds, readJar }) {
  const checks = await buildChecks(pageUrl, sessionIds, readJar);
  if (!checks.length) return null;

  const removeRuleIds = checks.map((check) => check.ruleId);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds,
      addRules: checks.map(({ ruleId: id, url, cookie }) => buildAccessRule({ id, tabId, url, cookie }))
    });
    const statuses = await chrome.tabs.sendMessage(
      tabId,
      { type: "CHECK_ACCESS", requests: checks.map(({ url, headers }) => ({ url, headers })) },
      { frameId: 0 }
    );
    return checks.find((_, index) => statuses?.[index] === 200)?.sessionId ?? null;
  } catch {
    return null;
  } finally {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds }).catch(() => undefined);
  }
}
