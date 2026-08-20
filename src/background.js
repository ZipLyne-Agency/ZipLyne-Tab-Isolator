import {
  CLEANUP_QUERY_KEY,
  CLEANUP_TOKEN_QUERY_KEY,
  createDefaultProfiles,
  createProfile,
  isSessionId,
  normalizeProfiles,
  sanitizeColor,
  sanitizeName,
  sessionIdFromUrl,
  sessionUrl
} from "./lib/session-model.js";

const PROFILES_KEY = "profiles";
const DIAGNOSTICS = new Map();
let cleanupQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  void ensureProfiles();
});

chrome.runtime.onStartup.addListener(() => {
  void refreshAllBadges();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  void refreshBadge(tabId, tab.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  DIAGNOSTICS.delete(tabId);
  void withCleanupLock(() => abandonCleanupForTab(tabId));
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  const report = DIAGNOSTICS.get(removedTabId);
  DIAGNOSTICS.delete(removedTabId);
  if (report) DIAGNOSTICS.set(addedTabId, report);
  void refreshBadge(addedTabId);
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
    case "CREATE_PROFILE":
      return { ok: true, profile: await addProfile(message.name, message.color) };
    case "UPDATE_PROFILE":
      return { ok: true, profile: await updateProfile(message.id, message.patch) };
    case "OPEN_PROFILE":
      return { ok: true, tab: await openProfile(message.id) };
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
    case "CLEANUP_COMPLETE":
      return withCleanupLock(() => handleCleanupComplete(message, sender));
    case "GET_DIAGNOSTICS":
      return { ok: true, reports: await collectDiagnostics() };
    default:
      throw new Error("Unknown request");
  }
}

async function ensureProfiles() {
  const stored = await chrome.storage.local.get(PROFILES_KEY);
  const profiles = normalizeProfiles(stored[PROFILES_KEY]);
  if (profiles.length) return profiles;

  const defaults = createDefaultProfiles();
  await chrome.storage.local.set({ [PROFILES_KEY]: defaults });
  return defaults;
}

async function saveProfiles(profiles) {
  await chrome.storage.local.set({ [PROFILES_KEY]: profiles });
  return profiles;
}

async function addProfile(name, color) {
  const profiles = await ensureProfiles();
  const profile = createProfile(name, color);
  await saveProfiles([...profiles, profile]);
  return profile;
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
  await refreshAllBadges();
  return updated;
}

async function getProfile(id) {
  if (!isSessionId(id)) return null;
  return (await ensureProfiles()).find((profile) => profile.id === id) ?? null;
}

async function openProfile(id) {
  const profile = await getProfile(id);
  if (!profile) throw new Error("Session not found");
  return chrome.tabs.create({ url: sessionUrl(id), active: true });
}

async function forgetProfile(id) {
  const profiles = await ensureProfiles();
  if (profiles.length <= 1) throw new Error("Keep at least one session");
  if (!profiles.some((profile) => profile.id === id)) throw new Error("Session not found");

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

  const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  const ownedTabIds = tabs
    .filter((tab) => sessionIdFromUrl(tab.url) === id)
    .map((tab) => tab.id)
    .filter(Number.isInteger);
  if (ownedTabIds.length) await chrome.tabs.remove(ownedTabIds);

  const cleanupToken = crypto.randomUUID();
  const cleanupTab = await chrome.tabs.create({ url: "about:blank", active: false });
  if (!Number.isInteger(cleanupTab.id)) throw new Error("Could not create cleanup tab");
  pendingCleanups[id] = { cleanupToken, tabId: cleanupTab.id };
  await chrome.storage.local.set({ pendingCleanups });
  try {
    await chrome.tabs.update(cleanupTab.id, { url: sessionUrl(id, { cleanup: true, cleanupToken }) });
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
  const validSender = pending
    && pending.tabId === sender.tab.id
    && pending.cleanupToken === message.cleanupToken
    && sessionIdFromUrl(senderUrl.href) === message.sessionId
    && senderUrl.searchParams.get(CLEANUP_QUERY_KEY) === "1"
    && senderUrl.searchParams.get(CLEANUP_TOKEN_QUERY_KEY) === message.cleanupToken;
  if (!validSender) throw new Error("Unexpected cleanup result");

  if (Array.isArray(message.errors) && message.errors.length) {
    throw new Error("Session cleanup was incomplete; the profile was kept");
  }

  const profiles = await ensureProfiles();
  await saveProfiles(profiles.filter((profile) => profile.id !== message.sessionId));
  delete pendingCleanups[message.sessionId];
  await chrome.storage.local.set({ pendingCleanups });
  await chrome.tabs.remove(sender.tab.id);
  return { ok: true };
}

async function listState() {
  const profiles = await ensureProfiles();
  const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  return {
    profiles,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      title: tab.title || "WhatsApp Web",
      sessionId: sessionIdFromUrl(tab.url),
      status: tab.status || "unknown"
    }))
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
  const url = urlValue || (await chrome.tabs.get(tabId)).url;
  if (!isWhatsAppUrl(url)) {
    await chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  const sessionId = sessionIdFromUrl(url);
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

function isWhatsAppUrl(value) {
  try {
    return new URL(value).origin === "https://web.whatsapp.com";
  } catch {
    return false;
  }
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

function sanitizeDiagnostics(report) {
  if (!report || typeof report !== "object") return null;
  return {
    sessionId: isSessionId(report.sessionId) ? report.sessionId : null,
    state: String(report.state || "unknown").slice(0, 32),
    serviceWorkerControlled: Boolean(report.serviceWorkerControlled),
    capabilities: Object.fromEntries(
      Object.entries(report.capabilities || {}).map(([key, value]) => [String(key).slice(0, 32), Boolean(value)])
    ),
    warnings: Array.isArray(report.warnings)
      ? report.warnings.map((warning) => String(warning).slice(0, 160)).slice(0, 12)
      : []
  };
}

function safeError(error) {
  return error instanceof Error ? error.message : "Unexpected error";
}
