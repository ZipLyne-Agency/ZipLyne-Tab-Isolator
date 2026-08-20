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

async function loadHarness(label) {
  const harness = createChromeHarness();
  globalThis.chrome = harness.chrome;
  await import(`../src/background.js?test=${label}-${Date.now()}-${Math.random()}`);
  return harness;
}

function createChromeHarness() {
  const storage = {};
  const tabs = [];
  let nextTabId = 1;
  const events = {
    installed: [], startup: [], message: [], updated: [], removed: [], replaced: []
  };
  const event = (name) => ({ addListener: (listener) => events[name].push(listener) });

  const chrome = {
    runtime: {
      onInstalled: event("installed"),
      onStartup: event("startup"),
      onMessage: event("message")
    },
    storage: {
      local: {
        async get(key) {
          if (key === null) return structuredClone(storage);
          if (typeof key === "string") return { [key]: structuredClone(storage[key]) };
          return Object.fromEntries(key.map((item) => [item, structuredClone(storage[item])]));
        },
        async set(values) { Object.assign(storage, structuredClone(values)); },
        async remove(key) {
          for (const item of Array.isArray(key) ? key : [key]) delete storage[item];
        }
      }
    },
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
    async message(payload, sender = {}) {
      const listener = events.message[0];
      assert.ok(listener, "background message listener is registered");
      return new Promise((resolve) => listener(payload, sender, resolve));
    }
  };
}
