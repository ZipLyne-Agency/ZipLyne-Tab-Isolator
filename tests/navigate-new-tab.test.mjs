import assert from "node:assert/strict";
import { test } from "node:test";
import { navigateNewTab } from "../src/session-engine.js";

const URL_TO_OPEN = "https://claude.ai/";
const settled = { status: "complete" };
const arrived = { status: "loading", url: URL_TO_OPEN };
const repeat = (state, count) => Array.from({ length: count }, () => state);

// Plays back one tab state per poll, then holds the last one.
function fakeChrome(states) {
  const updates = [];
  let poll = 0;
  const stateAt = (index) => states[Math.min(index, states.length - 1)];
  globalThis.chrome = {
    tabs: {
      update: async (tabId, { url }) => {
        updates.push({ url, statusBefore: stateAt(poll - 1).status });
        return { id: tabId };
      },
      get: async (tabId) => {
        const state = stateAt(poll);
        poll += 1;
        return { id: tabId, ...state };
      }
    }
  };
  return updates;
}

test("a tab that reaches the site is asked only once", async () => {
  const updates = fakeChrome([settled, { status: "loading", pendingUrl: URL_TO_OPEN }, arrived]);
  assert.equal((await navigateNewTab(1, URL_TO_OPEN)).url, URL_TO_OPEN);
  assert.equal(updates.length, 1);
});

test("nothing is sent until the blank page has finished loading", async () => {
  const updates = fakeChrome([{ status: "unloaded" }, { status: "loading" }, settled, arrived]);
  await navigateNewTab(1, URL_TO_OPEN);
  assert.equal(updates[0].statusBefore, "complete");
});

test("a navigation that drops after showing a pending URL is asked for again", async () => {
  const updates = fakeChrome([
    settled,
    { status: "loading", pendingUrl: URL_TO_OPEN },
    ...repeat({ status: "unloaded" }, 6),
    arrived
  ]);
  assert.equal((await navigateNewTab(1, URL_TO_OPEN)).url, URL_TO_OPEN);
  assert.equal(updates.length, 2);
});

test("a tab that is still loading is never asked again", async () => {
  const updates = fakeChrome([settled, ...repeat({ status: "loading" }, 30), arrived]);
  await navigateNewTab(1, URL_TO_OPEN);
  assert.equal(updates.length, 1);
});

test("a tab that never leaves the blank page stops being asked", async () => {
  const updates = fakeChrome([settled]);
  assert.equal((await navigateNewTab(1, URL_TO_OPEN)).url, undefined);
  assert.equal(updates.length, 4);
});
