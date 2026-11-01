// When a page says "not found", the link may belong to another account: private
// pages look missing to everyone else. This finds the signed-in session that can
// see it, then moves the tab there. Sites with an access check answer at once.
// Anywhere else, or when that check gives no clear yes, each session loads the
// page in a background tab.

import { findSessionWithAccess } from "./access-check.js";
import { domainMatches } from "./lib/cookie-jar.js";
import { isChallengeTitle, looksNotFound } from "./lib/site-model.js";
import { navigateNewTab } from "./session-engine.js";

const SETTLE_MS = 4000;
const GIVE_UP_MS = 15000;
const POLL_MS = 250;
const BATCH_SIZE = 6;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samePage = (first, second) => new URL(first).pathname === new URL(second).pathname;

export function createAccountFinder({ engine, listCookieSites, sessionsForSite }) {
  const probes = new Set();
  const searched = new Map();

  // Resolves true once the page has stayed loaded, on the same URL, without
  // saying "not found". Sites that fill the page in by script need that wait.
  async function canSee(tabId, url, isOver) {
    const deadline = Date.now() + GIVE_UP_MS;
    let quietSince = null;
    while (Date.now() < deadline && !isOver()) {
      await sleep(POLL_MS);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return false;
      if (tab.status !== "complete" || !tab.url?.startsWith("https:") || isChallengeTitle(tab.title)) {
        quietSince = null;
        continue;
      }
      if (looksNotFound(tab.title) || !samePage(tab.url, url)) return false;
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= SETTLE_MS) return true;
    }
    return false;
  }

  async function check(sessionId, url, original, isOver) {
    const tab = await chrome.tabs.create({
      url: "about:blank",
      active: false,
      windowId: original.windowId,
      index: original.index + 1
    });
    probes.add(tab.id);
    await engine.bindTab(tab.id, sessionId);
    await navigateNewTab(tab.id, url);
    return { tabId: tab.id, sessionId, found: await canSee(tab.id, url, isOver) };
  }

  async function checkBatch(sessionIds, url, original) {
    let owner = null;
    const results = await Promise.all(sessionIds.map(async (sessionId) => {
      const result = await check(sessionId, url, original, () => owner !== null);
      if (result.found) owner ??= sessionId;
      return result;
    }));
    const tabIds = results.map((result) => result.tabId);
    await chrome.tabs.remove(tabIds).catch(() => undefined);
    for (const tabId of tabIds) probes.delete(tabId);
    return owner;
  }

  async function searchInTabs(tabId, sessionIds, url) {
    const original = await chrome.tabs.get(tabId);
    for (let start = 0; start < sessionIds.length; start += BATCH_SIZE) {
      const owner = await checkBatch(sessionIds.slice(start, start + BATCH_SIZE), url, original);
      if (owner !== null) return owner;
    }
    return null;
  }

  async function search(tabId, url, site) {
    const currentSession = await engine.sessionForTab(tabId);
    const candidates = [];
    for (const sessionId of await sessionsForSite(site.id)) {
      if (sessionId !== currentSession && await engine.hasCookies(sessionId)) candidates.push(sessionId);
    }
    if (!candidates.length) return;

    // Nothing replies to these, so nothing may wait on them.
    const notify = (state) => void chrome.tabs.sendMessage(tabId, { type: "ACCOUNT_SEARCH", state }).catch(() => undefined);
    notify("searching");

    const owner = await findSessionWithAccess({ tabId, pageUrl: url, sessionIds: candidates, readJar: engine.readJar })
      ?? await searchInTabs(tabId, candidates, url);
    if (owner === null) {
      notify("none");
      return;
    }
    // The tab the link opened in stays and becomes the owner's page.
    await engine.bindTab(tabId, owner);
    await chrome.tabs.reload(tabId);
  }

  async function onTitleChanged(tabId, title, url) {
    if (!looksNotFound(title) || !url || probes.has(tabId) || searched.get(tabId) === url) return;
    // Claimed before any await: a labelled tab reports two not-found titles in a row.
    searched.set(tabId, url);
    const host = new URL(url).hostname;
    const site = (await listCookieSites()).find((candidate) => domainMatches(host, candidate.domain));
    if (site) await search(tabId, url, site);
    else searched.delete(tabId);
  }

  function forgetTab(tabId) {
    searched.delete(tabId);
  }

  return { forgetTab, onTitleChanged };
}
