// Keeps each cookie-isolated session's jar, the tabs bound to it, and the
// declarativeNetRequest rules that apply it. Manifest V3 stops this worker when
// idle, so everything lives in chrome.storage and this module only caches it.

import {
  applySetCookie,
  domainMatches,
  normalizeJar,
  visibleCookiesForHost
} from "./lib/cookie-jar.js";
import { buildSessionRules, RULES_PER_SESSION } from "./lib/cookie-rules.js";
import { isAccessCheck } from "./lib/access-checks.js";

const BINDINGS_KEY = "tabBindings";
const SLOTS_KEY = "ruleSlots";
const jarKey = (sessionId) => `cookieJar:${sessionId}`;
const proofKey = (sessionId) => `sessionProof:${sessionId}`;

const NAVIGATION_ATTEMPTS = 4;
const NAVIGATION_POLL_MS = 50;
const IDLE_POLLS_BEFORE_RETRY = 6;
const MAX_POLLS_PER_ATTEMPT = 200;
const SETTLE_POLLS = 40;

const pause = () => new Promise((resolve) => setTimeout(resolve, NAVIGATION_POLL_MS));

// A new tab has no live page process for its first moments, and a navigation
// sent then can be dropped.
async function blankPageSettles(tabId) {
  for (let poll = 0; poll < SETTLE_POLLS; poll += 1) {
    if ((await chrome.tabs.get(tabId)).status === "complete") return;
    await pause();
  }
}

// Resolves with the tab once the site's page has replaced the blank one, or
// null if the tab went idle without it. Neither "loading" nor a pending URL
// proves arrival: a navigation can still drop after showing both.
async function leavesBlankPage(tabId) {
  let idlePolls = 0;
  let tab = null;
  for (let poll = 0; poll < MAX_POLLS_PER_ATTEMPT; poll += 1) {
    await pause();
    tab = await chrome.tabs.get(tabId);
    if (tab.url?.startsWith("https:")) return tab;
    idlePolls = tab.pendingUrl || tab.status === "loading" ? 0 : idlePolls + 1;
    if (idlePolls >= IDLE_POLLS_BEFORE_RETRY) return null;
  }
  // Still under way: a slow site is not a dropped navigation.
  return tab;
}

// Asks again only while the tab sits idle: repeating a navigation that is under
// way can crash the tab's renderer.
export async function navigateNewTab(tabId, url) {
  await blankPageSettles(tabId);
  for (let attempt = 0; attempt < NAVIGATION_ATTEMPTS; attempt += 1) {
    await chrome.tabs.update(tabId, { url });
    const tab = await leavesBlankPage(tabId);
    if (tab) return tab;
  }
  return chrome.tabs.get(tabId);
}

export function createSessionEngine({ getSiteDomain, onBindingChanged = () => {} }) {
  const redirectLogins = new Map();
  const inFlight = new Map();
  const queues = new Map();
  let loaded = null;
  let bindings = new Map();
  let slots = {};

  function ready() {
    loaded ??= (async () => {
      const stored = await chrome.storage.session.get([BINDINGS_KEY, SLOTS_KEY]);
      bindings = new Map(Object.entries(stored[BINDINGS_KEY] ?? {}).map(([tabId, id]) => [Number(tabId), id]));
      slots = stored[SLOTS_KEY] ?? {};
    })();
    return loaded;
  }

  // Set-Cookie responses and rule updates for one session must apply in order.
  function serialized(sessionId, task) {
    const result = (queues.get(sessionId) ?? Promise.resolve()).then(task, task);
    queues.set(sessionId, result.catch(() => undefined));
    return result;
  }

  async function saveBindings() {
    await chrome.storage.session.set({ [BINDINGS_KEY]: Object.fromEntries(bindings) });
  }

  async function slotFor(sessionId) {
    if (slots[sessionId] === undefined) {
      const used = new Set(Object.values(slots));
      let slot = 0;
      while (used.has(slot)) slot += 1;
      slots[sessionId] = slot;
      await chrome.storage.session.set({ [SLOTS_KEY]: slots });
    }
    return slots[sessionId];
  }

  async function readJar(sessionId) {
    const key = jarKey(sessionId);
    return normalizeJar((await chrome.storage.local.get(key))[key]);
  }

  // A session's ID can be read by any page on the site, since it prefixes stored
  // keys. This secret reaches only that session's own tabs.
  async function proofFor(sessionId) {
    const key = proofKey(sessionId);
    const stored = (await chrome.storage.local.get(key))[key];
    if (stored) return stored;
    const proof = crypto.randomUUID();
    await chrome.storage.local.set({ [key]: proof });
    return proof;
  }

  async function proofMatches(sessionId, proof) {
    const key = proofKey(sessionId);
    return Boolean(proof) && (await chrome.storage.local.get(key))[key] === proof;
  }

  const tabsOf = (sessionId) => [...bindings].filter(([, id]) => id === sessionId).map(([tabId]) => tabId);

  async function syncRules(sessionId, jar) {
    const slot = await slotFor(sessionId);
    const low = (slot + 1) * RULES_PER_SESSION;
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const removeRuleIds = existing.map((rule) => rule.id).filter((id) => id > low && id <= low + RULES_PER_SESSION);
    const siteDomain = await getSiteDomain(sessionId);
    const addRules = siteDomain
      ? buildSessionRules({
        slot,
        sessionId,
        proof: await proofFor(sessionId),
        tabIds: tabsOf(sessionId),
        siteDomain,
        jar: jar ?? await readJar(sessionId)
      })
      : [];
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
  }

  async function bindTab(tabId, sessionId) {
    await ready();
    const previous = bindings.get(tabId);
    bindings.set(tabId, sessionId);
    await saveBindings();
    try {
      // A tab moving between sessions must leave the old session's rules.
      if (previous && previous !== sessionId) await serialized(previous, () => syncRules(previous));
      await serialized(sessionId, () => syncRules(sessionId));
    } catch (error) {
      // Chrome refused the rules, so the tab must not count as isolated.
      if (previous) bindings.set(tabId, previous);
      else bindings.delete(tabId);
      await saveBindings();
      throw error;
    }
    await onBindingChanged(tabId);
  }

  async function unbindTab(tabId) {
    await ready();
    const sessionId = bindings.get(tabId);
    redirectLogins.delete(tabId);
    if (!sessionId) return;
    bindings.delete(tabId);
    await saveBindings();
    await serialized(sessionId, () => syncRules(sessionId));
  }

  async function replaceTab(addedTabId, removedTabId) {
    await ready();
    const sessionId = bindings.get(removedTabId);
    if (!sessionId) return;
    bindings.delete(removedTabId);
    bindings.set(addedTabId, sessionId);
    await saveBindings();
    await serialized(sessionId, () => syncRules(sessionId));
  }

  async function sessionForTab(tabId) {
    await ready();
    return bindings.get(tabId) ?? null;
  }

  async function boundTabs() {
    await ready();
    return [...bindings].map(([tabId, sessionId]) => ({ tabId, sessionId }));
  }

  async function tabsForSession(sessionId) {
    await ready();
    return tabsOf(sessionId);
  }

  async function hasCookies(sessionId) {
    return (await readJar(sessionId)).length > 0;
  }

  async function dropSession(sessionId) {
    await ready();
    for (const tabId of tabsOf(sessionId)) bindings.delete(tabId);
    await saveBindings();
    await serialized(sessionId, async () => {
      await syncRules(sessionId, []);
      await chrome.storage.local.remove([jarKey(sessionId), proofKey(sessionId)]);
    });
    delete slots[sessionId];
    await chrome.storage.session.set({ [SLOTS_KEY]: slots });
  }

  function notifyVisibleChange(sessionId) {
    for (const tabId of tabsOf(sessionId)) {
      chrome.tabs.sendMessage(tabId, { type: "COOKIES_CHANGED" }).catch(() => undefined);
    }
  }

  async function storeHeaders(sessionId, headers, url, options = {}) {
    const siteDomain = await getSiteDomain(sessionId);
    if (!siteDomain) return { changed: false, significant: false };

    return serialized(sessionId, async () => {
      let jar = await readJar(sessionId);
      const summary = { changed: false, significant: false, visible: false };
      for (const header of headers) {
        const result = applySetCookie(jar, header, url, { ...options, siteDomain });
        jar = result.jar;
        summary.changed ||= result.changed;
        summary.significant ||= result.significant;
        summary.visible ||= result.visible;
      }
      if (!summary.changed) return summary;
      await chrome.storage.local.set({ [jarKey(sessionId)]: jar });
      await syncRules(sessionId, jar);
      if (summary.visible) notifyVisibleChange(sessionId);
      return summary;
    });
  }

  // Started synchronously when the browser reports the cookie, so flush() sees
  // it even though storing it takes several awaits.
  function track(tabId, task) {
    const tasks = inFlight.get(tabId) ?? new Set();
    inFlight.set(tabId, tasks);
    tasks.add(task);
    const done = () => {
      tasks.delete(task);
      if (!tasks.size) inFlight.delete(tabId);
    };
    task.then(done, done);
    return task;
  }

  async function flush(tabId) {
    await Promise.allSettled([...(inFlight.get(tabId) ?? [])]);
  }

  async function captureCookies(details, headers) {
    await ready();
    const sessionId = bindings.get(details.tabId);
    if (!sessionId) return false;

    const siteDomain = await getSiteDomain(sessionId);
    if (!siteDomain || !domainMatches(new URL(details.url).hostname, siteDomain)) return false;
    if (details.type !== "main_frame" && details.initiator
      && !domainMatches(new URL(details.initiator).hostname, siteDomain)) return false;

    return (await storeHeaders(sessionId, headers, details.url)).significant;
  }

  // Registered synchronously: the redirect's landing page can finish before
  // the cookies are stored, and the completion handler must still find it.
  function onHeadersReceived(details) {
    // An access check speaks for another session, so its cookies stay out of this tab's jar.
    if (isAccessCheck(details.url)) return undefined;
    const headers = (details.responseHeaders ?? [])
      .filter((header) => header.name.toLowerCase() === "set-cookie" && header.value)
      .map((header) => header.value);
    if (!headers.length) return undefined;

    const captured = track(details.tabId, captureCookies(details, headers));
    const redirected = details.type === "main_frame" && details.statusCode >= 300 && details.statusCode < 400;
    if (redirected) redirectLogins.set(details.tabId, [...(redirectLogins.get(details.tabId) ?? []), captured]);
    return captured;
  }

  // A login that sets its cookie on a redirect has already followed it by the
  // time the rules update, so the landing page loaded signed out. Load it again.
  async function onMainFrameCompleted(details) {
    const captures = redirectLogins.get(details.tabId);
    if (!captures) return;
    redirectLogins.delete(details.tabId);
    if (!(await Promise.all(captures)).some(Boolean)) return;
    await chrome.tabs.update(details.tabId, { url: details.url });
  }

  function onMainFrameFailed(details) {
    redirectLogins.delete(details.tabId);
  }

  function writeFromPage(tabId, header, url) {
    return track(tabId, (async () => {
      await ready();
      const sessionId = bindings.get(tabId);
      if (sessionId) await storeHeaders(sessionId, [header], url, { fromScript: true });
    })());
  }

  async function visibleCookies(tabId, url) {
    await ready();
    const sessionId = bindings.get(tabId);
    if (!sessionId) return "";
    return visibleCookiesForHost(await readJar(sessionId), new URL(url).hostname);
  }

  return {
    bindTab,
    boundTabs,
    dropSession,
    flush,
    hasCookies,
    onHeadersReceived,
    onMainFrameCompleted,
    onMainFrameFailed,
    proofMatches,
    readJar,
    replaceTab,
    sessionForTab,
    tabsForSession,
    unbindTab,
    visibleCookies,
    writeFromPage
  };
}
