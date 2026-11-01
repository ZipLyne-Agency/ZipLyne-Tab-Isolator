import test from "node:test";
import assert from "node:assert/strict";

test("background binds cleanup to an exact nonce-bearing tab", async () => {
  const harness = await loadHarness("binding");

  const initial = await harness.message({ type: "LIST_STATE" });
  assert.equal(initial.ok, true);
  assert.equal(initial.profiles.length, 2);

  const business = initial.profiles[1];
  const opened = await harness.message({ type: "OPEN_PROFILE", id: business.id });
  assert.equal(opened.ok, true);

  const forgetting = await harness.message({ type: "FORGET_PROFILE", id: business.id });
  assert.equal(forgetting.ok, true);
  const pending = harness.storage.pendingCleanups[business.id];
  const cleanupTab = harness.tabs.find((tab) => tab.id === pending.tabId);
  assert.match(cleanupTab.url, /wti_cleanup=1/);

  const forged = await harness.message({
    type: "CLEANUP_COMPLETE",
    sessionId: business.id,
    cleanupToken: pending.cleanupToken,
    errors: []
  }, { tab: { id: 999, url: cleanupTab.url } });
  assert.equal(forged.ok, false);

  const completed = await harness.message({
    type: "CLEANUP_COMPLETE",
    sessionId: business.id,
    cleanupToken: pending.cleanupToken,
    errors: []
  }, { tab: { id: cleanupTab.id, url: cleanupTab.url } });
  assert.equal(completed.ok, true);

  const final = await harness.message({ type: "LIST_STATE" });
  assert.equal(final.profiles.some((profile) => profile.id === business.id), false);
  assert.equal(harness.tabs.some((tab) => tab.id === cleanupTab.id), false);
});

test("failed cleanup keeps the profile, tab, and pending retry record", async () => {
  const harness = await loadHarness("failure");
  const initial = await harness.message({ type: "LIST_STATE" });
  const target = initial.profiles[1];
  await harness.message({ type: "FORGET_PROFILE", id: target.id });
  const pending = structuredClone(harness.storage.pendingCleanups[target.id]);
  const cleanupTab = harness.tabs.find((tab) => tab.id === pending.tabId);

  const failed = await harness.message({
    type: "CLEANUP_COMPLETE",
    sessionId: target.id,
    cleanupToken: pending.cleanupToken,
    errors: ["IndexedDB cleanup failed"]
  }, { tab: { id: cleanupTab.id, url: cleanupTab.url } });

  assert.equal(failed.ok, false);
  assert.deepEqual(harness.storage.pendingCleanups[target.id], pending);
  assert.equal(harness.tabs.some((tab) => tab.id === cleanupTab.id), true);
  const final = await harness.message({ type: "LIST_STATE" });
  assert.equal(final.profiles.some((profile) => profile.id === target.id), true);
});

test("concurrent profile cleanup retains a separate nonce-bound record per session", async () => {
  const harness = await loadHarness("concurrent");
  const initial = await harness.message({ type: "LIST_STATE" });
  const created = await harness.message({ type: "CREATE_PROFILE", name: "Third", color: "#445566" });
  const targets = [initial.profiles[1], created.profile];

  const results = await Promise.all(targets.map((profile) =>
    harness.message({ type: "FORGET_PROFILE", id: profile.id })
  ));

  assert.equal(results.every((result) => result.ok), true);
  const records = targets.map((profile) => harness.storage.pendingCleanups[profile.id]);
  assert.equal(records.every(Boolean), true);
  assert.notEqual(records[0].tabId, records[1].tabId);
  assert.notEqual(records[0].cleanupToken, records[1].cleanupToken);
});

test("adding a site registers scripts only once access is granted", async () => {
  const harness = await loadHarness("site-access");
  const added = await harness.message({ type: "ADD_SITE", domain: "https://www.Claude.ai/new" });
  assert.equal(added.site.domain, "claude.ai");
  assert.equal(harness.registeredScripts.length, 0);

  harness.granted.add("https://*.claude.ai/*").add("wss://*.claude.ai/*");
  await harness.emit("permissionsAdded", {});
  await flush();
  assert.equal(harness.registeredScripts.length, 2);
  assert.deepEqual(harness.registeredScripts[0].matches, ["https://*.claude.ai/*"]);

  const state = await harness.message({ type: "LIST_STATE" });
  assert.deepEqual(state.sites.map((site) => site.domain), ["web.whatsapp.com", "claude.ai"]);
  assert.equal(state.profiles.filter((profile) => profile.siteId === "claude.ai").length, 2);
});

test("a site that overlaps WhatsApp is refused", async () => {
  const harness = await loadHarness("site-overlap");
  const result = await harness.message({ type: "ADD_SITE", domain: "whatsapp.com" });
  assert.equal(result.ok, false);
});

test("a cookie session opens with its rules in place before the site loads", async () => {
  const { harness, profile } = await harnessWithClaude("open-order");
  const order = [];
  const update = harness.chrome.tabs.update;
  harness.chrome.tabs.update = (...args) => {
    order.push(harness.sessionRules.length);
    return update(...args);
  };

  await harness.message({ type: "OPEN_PROFILE", id: profile.id });
  assert.equal(order.length, 1, "one navigation when Chrome takes the first");
  assert.ok(order[0] > 0, "rules exist before navigation");
  assert.equal(harness.tabs[0].url, "https://claude.ai/");
});

test("a session cannot be opened on a host outside its site", async () => {
  const { harness, profile } = await harnessWithClaude("open-outside");
  const result = await harness.message({ type: "OPEN_PROFILE", id: profile.id, url: "https://example.com/" });
  assert.equal(result.ok, false);
  assert.equal(harness.tabs.length, 0);
});

test("two sessions keep separate jars from the same Set-Cookie name", async () => {
  const { harness, profiles } = await harnessWithClaude("two-jars");
  await harness.message({ type: "OPEN_PROFILE", id: profiles[0].id });
  await harness.message({ type: "OPEN_PROFILE", id: profiles[1].id });
  const [first, second] = harness.tabs;

  await login(harness, first.id, "alice");
  await login(harness, second.id, "bob");

  const headersFor = (tabId) => harness.sessionRules
    .filter((rule) => rule.condition.tabIds.includes(tabId))
    .flatMap((rule) => rule.action.requestHeaders ?? [])
    .filter((header) => header.header === "cookie" && header.operation === "set")
    .map((header) => header.value);
  assert.ok(headersFor(first.id).every((value) => value === "sessionKey=alice"));
  assert.ok(headersFor(second.id).every((value) => value === "sessionKey=bob"));
  assert.ok(headersFor(first.id).length > 0);
});

test("renaming a session relabels its open tabs and no others", async () => {
  const { harness, profiles } = await harnessWithClaude("rename");
  await harness.message({ type: "OPEN_PROFILE", id: profiles[0].id });
  await harness.message({ type: "OPEN_PROFILE", id: profiles[1].id });
  const [first, second] = harness.tabs;
  const sent = [];
  harness.chrome.tabs.sendMessage = async (tabId, message) => { sent.push([tabId, message]); };

  const result = await harness.message({ type: "UPDATE_PROFILE", id: profiles[0].id, patch: { name: "Main" } });
  assert.equal(result.ok, true);
  assert.deepEqual(sent.map(([tabId]) => tabId), [first.id]);
  assert.equal(sent[0][1].type, "PROFILE_UPDATED");
  assert.equal(sent[0][1].profile.name, "Main");
  assert.equal(sent.some(([tabId]) => tabId === second.id), false);
});

test("a site can hold more than two sessions", async () => {
  const { harness } = await harnessWithClaude("many");
  for (const name of ["Third", "Fourth", "Fifth"]) {
    assert.equal((await harness.message({ type: "CREATE_PROFILE", name, color: "#112233", siteId: "claude.ai" })).ok, true);
  }
  const state = await harness.message({ type: "LIST_STATE" });
  assert.equal(state.profiles.filter((profile) => profile.siteId === "claude.ai").length, 5);
});

test("a stored session binds only on its own site, with its proof", async () => {
  const { harness, profile } = await harnessWithClaude("bind-stored");
  await harness.message({ type: "OPEN_PROFILE", id: profile.id });
  const key = `sessionProof:${profile.id}`;
  const proof = (await harness.chrome.storage.local.get(key))[key];
  assert.ok(proof);
  const claude = { tab: { id: 50 }, url: "https://claude.ai/chat/1" };

  const wrongSite = await harness.message(
    { type: "BIND_STORED_SESSION", sessionId: profile.id, proof },
    { tab: { id: 50 }, url: "https://example.com/" }
  );
  assert.equal(wrongSite.ok, false);

  for (const forged of [undefined, null, "", "not-the-proof"]) {
    assert.equal((await harness.message({ type: "BIND_STORED_SESSION", sessionId: profile.id, proof: forged }, claude)).ok, false);
  }
  assert.equal((await harness.message({ type: "TAB_HELLO" }, { tab: { id: 50 } })).sessionId, null);

  const rightSite = await harness.message({ type: "BIND_STORED_SESSION", sessionId: profile.id, proof }, claude);
  assert.equal(rightSite.ok, true);
  assert.equal((await harness.message({ type: "TAB_HELLO" }, { tab: { id: 50 } })).sessionId, profile.id);
});

test("a session Chrome cannot apply rules for leaves no tab behind", async () => {
  const { harness, profile } = await harnessWithClaude("rule-failure");
  harness.chrome.declarativeNetRequest.updateSessionRules = async () => { throw new Error("Rule limit reached"); };
  const before = harness.tabs.length;
  const result = await harness.message({ type: "OPEN_PROFILE", id: profile.id });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Rule limit reached");
  assert.equal(harness.tabs.length, before);
  assert.deepEqual((await harness.message({ type: "LIST_STATE" })).tabs, []);
});

test("page script cannot read or replace an HttpOnly cookie", async () => {
  const { harness, profile } = await harnessWithClaude("http-only");
  await harness.message({ type: "OPEN_PROFILE", id: profile.id });
  const [tab] = harness.tabs;
  await login(harness, tab.id, "alice");

  const sender = { tab: { id: tab.id }, url: "https://claude.ai/" };
  await harness.message({ type: "COOKIE_WRITE", header: "sessionKey=forged" }, sender);
  await harness.message({ type: "COOKIE_WRITE", header: "theme=dark" }, sender);

  const visible = await harness.message({ type: "GET_VISIBLE_COOKIES" }, sender);
  assert.equal(visible.cookies, "theme=dark");
  const jar = harness.storage[`cookieJar:${profile.id}`];
  assert.equal(jar.find((cookie) => cookie.name === "sessionKey").value, "alice");
});

test("a new tab from a session link joins that session", async () => {
  const { harness, profile } = await harnessWithClaude("inherit");
  await harness.message({ type: "OPEN_PROFILE", id: profile.id });
  const [tab] = harness.tabs;
  await harness.emit("createdNavigationTarget", { sourceTabId: tab.id, tabId: 77 });
  await flush();
  assert.equal((await harness.message({ type: "TAB_HELLO" }, { tab: { id: 77 } })).sessionId, profile.id);
});

test("forgetting a cookie session deletes its jar and rules", async () => {
  const { harness, profile } = await harnessWithClaude("forget-jar");
  await harness.message({ type: "OPEN_PROFILE", id: profile.id });
  const [tab] = harness.tabs;
  await login(harness, tab.id, "alice");

  await harness.message({ type: "FORGET_PROFILE", id: profile.id });
  const pending = harness.storage.pendingCleanups[profile.id];
  const cleanupTab = harness.tabs.find((candidate) => candidate.id === pending.tabId);
  assert.equal(new URL(cleanupTab.url).origin, "https://claude.ai");

  const completed = await harness.message(
    { type: "CLEANUP_COMPLETE", sessionId: profile.id, cleanupToken: pending.cleanupToken, errors: [] },
    { tab: { id: cleanupTab.id, url: cleanupTab.url } }
  );
  assert.equal(completed.ok, true);
  assert.equal(harness.storage[`cookieJar:${profile.id}`], undefined);
  assert.equal(harness.sessionRules.length, 0);
});

async function harnessWithClaude(label) {
  const harness = await loadHarness(label);
  harness.granted.add("https://*.claude.ai/*").add("wss://*.claude.ai/*");
  await harness.message({ type: "ADD_SITE", domain: "claude.ai" });
  const state = await harness.message({ type: "LIST_STATE" });
  const profiles = state.profiles.filter((profile) => profile.siteId === "claude.ai");
  return { harness, profiles, profile: profiles[0] };
}

async function login(harness, tabId, user) {
  await harness.emit("headersReceived", {
    tabId,
    type: "main_frame",
    statusCode: 200,
    url: "https://claude.ai/login",
    responseHeaders: [{ name: "Set-Cookie", value: `sessionKey=${user}; Path=/; Secure; HttpOnly; Domain=claude.ai` }]
  });
  await flush();
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

async function loadHarness(label) {
  const harness = createChromeHarness();
  globalThis.chrome = harness.chrome;
  await import(`../src/background.js?test=${label}-${Date.now()}-${Math.random()}`);
  return harness;
}

function createArea(values) {
  return {
    async get(key) {
      if (key === null) return structuredClone(values);
      if (typeof key === "string") return { [key]: structuredClone(values[key]) };
      return Object.fromEntries(key.map((item) => [item, structuredClone(values[item])]));
    },
    async set(next) { Object.assign(values, structuredClone(next)); },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) delete values[item];
    }
  };
}

function createChromeHarness() {
  const storage = {};
  const sessionStorage = {};
  const tabs = [];
  const granted = new Set();
  let sessionRules = [];
  let registeredScripts = [];
  let nextTabId = 1;
  const events = {
    installed: [], startup: [], message: [], updated: [], removed: [], replaced: []
  };
  const event = (name) => ({ addListener: (listener) => (events[name] ??= []).push(listener) });

  const chrome = {
    runtime: {
      onInstalled: event("installed"),
      onStartup: event("startup"),
      onMessage: event("message")
    },
    storage: {
      local: createArea(storage),
      session: createArea(sessionStorage)
    },
    permissions: {
      onAdded: event("permissionsAdded"),
      onRemoved: event("permissionsRemoved"),
      async contains({ origins }) { return origins.every((origin) => granted.has(origin)); },
      async remove({ origins }) { origins.forEach((origin) => granted.delete(origin)); }
    },
    scripting: {
      async getRegisteredContentScripts() { return registeredScripts.map((script) => ({ id: script.id })); },
      async registerContentScripts(scripts) { registeredScripts.push(...scripts); },
      async unregisterContentScripts({ ids }) {
        registeredScripts = registeredScripts.filter((script) => !ids.includes(script.id));
      }
    },
    declarativeNetRequest: {
      async getSessionRules() { return structuredClone(sessionRules); },
      async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
        sessionRules = [...sessionRules.filter((rule) => !removeRuleIds.includes(rule.id)), ...addRules];
      }
    },
    webRequest: {
      onHeadersReceived: event("headersReceived"),
      onCompleted: event("completed"),
      onErrorOccurred: event("errorOccurred")
    },
    webNavigation: { onCreatedNavigationTarget: event("createdNavigationTarget") },
    tabs: {
      onUpdated: event("updated"),
      onRemoved: event("removed"),
      onReplaced: event("replaced"),
      async create(properties) {
        const tab = { id: nextTabId++, status: "complete", title: "Tab", ...properties };
        tabs.push(tab);
        return structuredClone(tab);
      },
      async update(tabId, properties) {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("No tab");
        Object.assign(tab, properties);
        return structuredClone(tab);
      },
      async query() { return structuredClone(tabs.filter((tab) => tab.url?.startsWith("https://web.whatsapp.com/"))); },
      async get(tabId) {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("No tab");
        return structuredClone(tab);
      },
      async remove(ids) {
        for (const tabId of Array.isArray(ids) ? ids : [ids]) {
          const index = tabs.findIndex((tab) => tab.id === tabId);
          if (index >= 0) {
            tabs.splice(index, 1);
            for (const listener of events.removed) listener(tabId, { isWindowClosing: false });
          }
        }
      },
      async sendMessage() { throw new Error("No relay"); }
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {}
    }
  };

  return {
    chrome,
    storage,
    tabs,
    granted,
    get sessionRules() { return sessionRules; },
    get registeredScripts() { return registeredScripts; },
    emit: (name, ...args) => Promise.all((events[name] ?? []).map((listener) => listener(...args))),
    async message(payload, sender = {}) {
      const listener = events.message[0];
      assert.ok(listener, "background message listener is registered");
      return new Promise((resolve) => listener(payload, sender, resolve));
    }
  };
}
