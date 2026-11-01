import {
  CLEANUP_QUERY_KEY,
  CLEANUP_TOKEN_QUERY_KEY,
  isSessionId,
  sanitizeColor,
  sanitizeName,
  sessionIdFromUrl,
  sessionUrl
} from "./lib/session-model.js";
import { domainMatches } from "./lib/cookie-jar.js";
import { listSitesWithAccess, syncSiteScripts } from "./site-registry.js";
import { isWhatsAppUrl } from "./lib/site-model.js";
import { createSessionEngine, navigateNewTab } from "./session-engine.js";
import { createAccountFinder } from "./account-finder.js";
import { sanitizeDiagnostics } from "./diagnostics-report.js";
import {
  addProfile,
  addSiteWithSessions,
  ensureProfiles,
  getProfile,
  removeEmptySite,
  saveProfiles,
  siteForSession
} from "./profile-store.js";

const DIAGNOSTICS = new Map();
let cleanupQueue = Promise.resolve();

const engine = createSessionEngine({
  getSiteDomain: async (sessionId) => {
    const site = await siteForSession(sessionId);
    return site?.isolatesCookies ? site.domain : null;
  },
  onBindingChanged: (tabId) => refreshBadge(tabId)
});

const finder = createAccountFinder({
  engine,
  listCookieSites: async () => (await listSitesWithAccess()).filter((site) => site.isolatesCookies && site.granted),
  sessionsForSite: async (siteId) => (await ensureProfiles()).filter((profile) => profile.siteId === siteId).map((profile) => profile.id)
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureProfiles();
  void syncSiteScripts();
});

chrome.runtime.onStartup.addListener(() => {
  void refreshAllBadges();
  void syncSiteScripts();
});

chrome.permissions.onAdded.addListener(() => {
  void syncSiteScripts();
});

chrome.permissions.onRemoved.addListener(() => {
  void syncSiteScripts();
});

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    void engine.onHeadersReceived(details);
  },
  { urls: ["https://*/*", "wss://*/*"] },
  ["responseHeaders", "extraHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    void engine.onMainFrameCompleted(details);
  },
  { urls: ["https://*/*"], types: ["main_frame"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => engine.onMainFrameFailed(details),
  { urls: ["https://*/*"], types: ["main_frame"] }
);

// Links with target=_blank carry no opener, so bind the new tab here. It also
// keeps sign-in popups in the session that opened them.
chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId }) => {
  void engine.sessionForTab(sourceTabId).then((sessionId) => sessionId && engine.bindTab(tabId, sessionId));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.title) void finder.onTitleChanged(tabId, changeInfo.title, tab.url);
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  void refreshBadge(tabId, tab.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  DIAGNOSTICS.delete(tabId);
  finder.forgetTab(tabId);
  void engine.unbindTab(tabId);
  void withCleanupLock(() => abandonCleanupForTab(tabId));
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  const report = DIAGNOSTICS.get(removedTabId);
  DIAGNOSTICS.delete(removedTabId);
  if (report) DIAGNOSTICS.set(addedTabId, report);
  void engine.replaceTab(addedTabId, removedTabId).then(() => refreshBadge(addedTabId));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: safeError(error) }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "LIST_STATE":
      return { ok: true, ...(await listState()) };
    case "ADD_SITE":
      return { ok: true, site: await addSiteWithSessions(message.domain) };
    case "REMOVE_SITE":
      return { ok: true, sites: await removeEmptySite(message.id) };
    case "CREATE_PROFILE":
      return { ok: true, profile: await addProfile(message.name, message.color, message.siteId) };
    case "UPDATE_PROFILE":
      return { ok: true, profile: await updateProfile(message.id, message.patch) };
    case "OPEN_PROFILE":
      return { ok: true, tab: await openProfile(message.id, message.url) };
    case "FORGET_PROFILE":
      return withCleanupLock(async () => ({ ok: true, cleanupTab: await forgetProfile(message.id) }));
    case "GET_PROFILE":
      return { ok: true, profile: await getProfile(message.id) };
    case "SESSION_READY":
      if (sender.tab?.id) {
        DIAGNOSTICS.set(sender.tab.id, sanitizeDiagnostics(message.report));
        await refreshBadge(sender.tab.id, sender.tab.url);
      }
      return { ok: true };
    case "TAB_HELLO":
      return { ok: true, sessionId: sender.tab?.id ? await engine.sessionForTab(sender.tab.id) : null };
    case "BIND_STORED_SESSION":
      return bindStoredSession(message.sessionId, message.proof, sender);
    case "COOKIE_WRITE":
      if (sender.tab?.id && sender.url) await engine.writeFromPage(sender.tab.id, String(message.header).slice(0, 8192), sender.url);
      return { ok: true };
    case "FLUSH_COOKIES":
      if (sender.tab?.id) await engine.flush(sender.tab.id);
      return { ok: true };
    case "GET_VISIBLE_COOKIES":
      return { ok: true, cookies: sender.tab?.id && sender.url ? await engine.visibleCookies(sender.tab.id, sender.url) : "" };
    case "CLEANUP_COMPLETE":
      return withCleanupLock(() => handleCleanupComplete(message, sender));
    case "GET_DIAGNOSTICS":
      return { ok: true, reports: await collectDiagnostics() };
    default:
      throw new Error("Unknown request");
  }
}

async function bindStoredSession(sessionId, proof, sender) {
  const site = await siteForSession(sessionId);
  const host = sender.url ? new URL(sender.url).hostname : "";
  if (!sender.tab?.id || !site?.isolatesCookies || !domainMatches(host, site.domain)
    || !await engine.proofMatches(sessionId, proof)) {
    return { ok: false, error: "Session not found" };
  }
  await engine.bindTab(sender.tab.id, sessionId);
  return { ok: true };
}

async function updateProfile(id, patch = {}) {
  if (!isSessionId(id)) throw new Error("Invalid session ID");
  const profiles = await ensureProfiles();
  const existing = profiles.find((profile) => profile.id === id);
  if (!existing) throw new Error("Session not found");

  const updated = {
    ...existing,
    name: patch.name === undefined ? existing.name : sanitizeName(patch.name),
    color: patch.color === undefined ? existing.color : sanitizeColor(patch.color)
  };
  await saveProfiles(profiles.map((profile) => profile.id === id ? updated : profile));
  await relabelOpenTabs(updated);
  return updated;
}

// A rename reaches tabs that are already open, on the page and in the toolbar.
async function relabelOpenTabs(profile) {
  const { tabs } = await listState();
  await Promise.all(tabs.filter((tab) => tab.sessionId === profile.id).map((tab) => {
    void chrome.tabs.sendMessage(tab.id, { type: "PROFILE_UPDATED", profile }).catch(() => undefined);
    return refreshBadge(tab.id).catch(() => undefined);
  }));
}

async function openProfile(id, url) {
  const profile = await getProfile(id);
  if (!profile) throw new Error("Session not found");
  const site = await siteForSession(id);
  if (!site?.isolatesCookies) return chrome.tabs.create({ url: sessionUrl(id), active: true });

  const target = url ? new URL(url) : new URL(site.origin);
  if (target.protocol !== "https:" || !domainMatches(target.hostname, site.domain)) {
    throw new Error(`That link is not on ${site.domain}`);
  }
  // Rules go in before the first request, so the page never sees shared cookies.
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  try {
    await engine.bindTab(tab.id, id);
    return await navigateNewTab(tab.id, target.href);
  } catch (error) {
    await chrome.tabs.remove(tab.id).catch(() => undefined);
    throw error;
  }
}

async function forgetProfile(id) {
  const profiles = await ensureProfiles();
  const profile = profiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error("Session not found");
  const site = (await listSitesWithAccess()).find((candidate) => candidate.id === profile.siteId);
  const siteProfiles = profiles.filter((candidate) => candidate.siteId === profile.siteId);
  if (!site?.isolatesCookies && siteProfiles.length <= 1) throw new Error("Keep at least one session");

  const stored = await chrome.storage.local.get("pendingCleanups");
  const pendingCleanups = stored.pendingCleanups && typeof stored.pendingCleanups === "object"
    ? stored.pendingCleanups
    : {};
  if (pendingCleanups[id]) {
    try {
      await chrome.tabs.get(pendingCleanups[id].tabId);
      throw new Error("This session is already being cleared");
    } catch (error) {
      if (error?.message === "This session is already being cleared") throw error;
      delete pendingCleanups[id];
      await chrome.storage.local.set({ pendingCleanups });
    }
  }

  const ownedTabIds = site?.isolatesCookies
    ? await engine.tabsForSession(id)
    : (await chrome.tabs.query({ url: "https://web.whatsapp.com/*" }))
      .filter((tab) => sessionIdFromUrl(tab.url) === id)
      .map((tab) => tab.id)
      .filter(Number.isInteger);
  if (ownedTabIds.length) await chrome.tabs.remove(ownedTabIds);

  // Without site access nothing can run on the page to clear its storage.
  if (site?.isolatesCookies && !site.granted) {
    await engine.dropSession(id);
    await saveProfiles(profiles.filter((candidate) => candidate.id !== id));
    return null;
  }

  const cleanupToken = crypto.randomUUID();
  const cleanupTab = await chrome.tabs.create({ url: "about:blank", active: false });
  if (!Number.isInteger(cleanupTab.id)) throw new Error("Could not create cleanup tab");
  pendingCleanups[id] = { cleanupToken, tabId: cleanupTab.id };
  await chrome.storage.local.set({ pendingCleanups });
  try {
    await navigateNewTab(cleanupTab.id, sessionUrl(id, { cleanup: true, cleanupToken, origin: site?.origin }));
  } catch (error) {
    delete pendingCleanups[id];
    await chrome.storage.local.set({ pendingCleanups });
    await chrome.tabs.remove(cleanupTab.id);
    throw error;
  }
  return cleanupTab;
}

async function handleCleanupComplete(message, sender) {
  if (!isSessionId(message.sessionId) || !isSessionId(message.cleanupToken) || !sender.tab?.id) {
    throw new Error("Invalid cleanup result");
  }
  const stored = await chrome.storage.local.get("pendingCleanups");
  const pendingCleanups = stored.pendingCleanups && typeof stored.pendingCleanups === "object"
    ? stored.pendingCleanups
    : {};
  const pending = pendingCleanups[message.sessionId];
  const senderUrl = new URL(sender.tab.url || "about:blank");
  const site = await siteForSession(message.sessionId);
  const validSender = pending
    && pending.tabId === sender.tab.id
    && pending.cleanupToken === message.cleanupToken
    && sessionIdFromUrl(senderUrl.href, site?.origin) === message.sessionId
    && senderUrl.searchParams.get(CLEANUP_QUERY_KEY) === "1"
    && senderUrl.searchParams.get(CLEANUP_TOKEN_QUERY_KEY) === message.cleanupToken;
  if (!validSender) throw new Error("Unexpected cleanup result");

  if (Array.isArray(message.errors) && message.errors.length) {
    throw new Error("Session cleanup was incomplete; the profile was kept");
  }

  await engine.dropSession(message.sessionId);
  const profiles = await ensureProfiles();
  await saveProfiles(profiles.filter((profile) => profile.id !== message.sessionId));
  delete pendingCleanups[message.sessionId];
  await chrome.storage.local.set({ pendingCleanups });
  await chrome.tabs.remove(sender.tab.id);
  return { ok: true };
}

async function listState() {
  const profiles = await ensureProfiles();
  const urlTabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  const boundTabs = await Promise.all((await engine.boundTabs()).map(async ({ tabId, sessionId }) => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    return tab ? { id: tab.id, title: tab.title || "Tab", sessionId, status: tab.status || "unknown" } : null;
  }));
  return {
    sites: await listSitesWithAccess(),
    profiles,
    tabs: [
      ...urlTabs.map((tab) => ({
        id: tab.id,
        title: tab.title || "WhatsApp Web",
        sessionId: sessionIdFromUrl(tab.url),
        status: tab.status || "unknown"
      })),
      ...boundTabs.filter(Boolean)
    ]
  };
}

async function collectDiagnostics() {
  const { profiles, tabs } = await listState();
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  return Promise.all(tabs.map(async (tab) => {
    let report = DIAGNOSTICS.get(tab.id) ?? null;
    if (Number.isInteger(tab.id)) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_TAB_DIAGNOSTICS" });
        if (response?.ok && response.report) report = sanitizeDiagnostics(response.report);
      } catch {
        // The page may still be navigating or blocked before the relay starts.
      }
    }
    return {
      tabId: tab.id,
      title: tab.title,
      profile: profileById.get(tab.sessionId)?.name ?? null,
      report
    };
  }));
}

async function refreshAllBadges() {
  const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  await Promise.all(tabs.map((tab) => refreshBadge(tab.id, tab.url)));
}

async function refreshBadge(tabId, urlValue) {
  if (!Number.isInteger(tabId)) return;
  const boundSession = await engine.sessionForTab(tabId);
  const url = boundSession ? null : urlValue || (await chrome.tabs.get(tabId)).url;
  if (!boundSession && !isWhatsAppUrl(url)) {
    await chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  const sessionId = boundSession ?? sessionIdFromUrl(url);
  if (!sessionId) {
    await chrome.action.setBadgeText({ tabId, text: "!" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#b42318" });
    return;
  }

  const profile = await getProfile(sessionId);
  const label = profile?.name?.slice(0, 2).toUpperCase() || "?";
  await chrome.action.setBadgeText({ tabId, text: label });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: profile?.color || "#6b7280" });
}

function withCleanupLock(task) {
  const result = cleanupQueue.then(task, task);
  cleanupQueue = result.catch(() => undefined);
  return result;
}

async function abandonCleanupForTab(tabId) {
  const stored = await chrome.storage.local.get("pendingCleanups");
  const pendingCleanups = stored.pendingCleanups && typeof stored.pendingCleanups === "object"
    ? stored.pendingCleanups
    : {};
  const abandoned = Object.entries(pendingCleanups)
    .filter(([, pending]) => pending?.tabId === tabId)
    .map(([sessionId]) => sessionId);
  if (!abandoned.length) return;
  for (const sessionId of abandoned) delete pendingCleanups[sessionId];
  await chrome.storage.local.set({ pendingCleanups });
}

function safeError(error) {
  return error instanceof Error ? error.message : "Unexpected error";
}
