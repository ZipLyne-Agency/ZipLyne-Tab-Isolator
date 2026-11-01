import test from "node:test";
import assert from "node:assert/strict";
import { applySetCookie } from "../src/lib/cookie-jar.js";
import { buildSessionRules, hostRegex, RULES_PER_SESSION } from "../src/lib/cookie-rules.js";

const sessionId = crypto.randomUUID();
const build = (jar = [], extra = {}) => buildSessionRules({
  slot: 0, sessionId, proof: "proof-1", tabIds: [7], siteDomain: "claude.ai", jar, now: 1000, ...extra
});
const jarWith = (...headers) => headers.reduce(
  (jar, header) => applySetCookie(jar, header, "https://claude.ai/", { siteDomain: "claude.ai", now: 1000 }).jar,
  []
);
const allow = (rule, url) => new RegExp(rule.condition.regexFilter).test(url);

test("no tabs means no rules", () => {
  assert.deepEqual(build([], { tabIds: [] }), []);
});

test("every rule stays inside its slot and on its tabs", () => {
  const rules = build(jarWith("a=1; Domain=claude.ai", "b=2"), { slot: 3 });
  const low = 4 * RULES_PER_SESSION;
  assert.ok(rules.every((rule) => rule.id > low && rule.id <= low + RULES_PER_SESSION));
  assert.ok(rules.every((rule) => rule.condition.tabIds.join() === "7"));
  assert.equal(new Set(rules.map((rule) => rule.id)).size, rules.length);
});

test("an empty jar still blocks shared cookies and marks the tab", () => {
  const [floor, marker] = build();
  assert.deepEqual(floor.action.requestHeaders, [{ header: "cookie", operation: "remove" }]);
  assert.deepEqual(floor.action.responseHeaders, [{ header: "set-cookie", operation: "remove" }]);
  assert.ok(floor.condition.resourceTypes.includes("websocket"));
  assert.match(marker.action.responseHeaders[0].value, new RegExp(`wti;desc="${sessionId}"`));
  assert.match(marker.action.responseHeaders[1].value, /wtik;desc="proof-1"/);
});

test("cookie rules outrank the floor, exact hosts outrank wildcards", () => {
  const rules = build(jarWith("a=1; Domain=claude.ai", "b=2"));
  const setters = rules.filter((rule) => rule.action.requestHeaders?.some((header) => header.header === "cookie" && header.operation === "set"));
  const exact = setters.find((rule) => !rule.condition.regexFilter.includes("[^/]"));
  const wildcard = setters.find((rule) => rule.condition.regexFilter.includes("[^/]"));
  assert.ok(exact.priority > wildcard.priority);
  assert.ok(wildcard.priority > 1);
  assert.equal(exact.action.requestHeaders[0].value, "a=1; b=2");
  assert.equal(wildcard.action.requestHeaders[0].value, "a=1");
});

test("only top-level navigation sends cookies from another site", () => {
  const rules = build(jarWith("a=1; Domain=claude.ai")).filter((rule) => rule.action.requestHeaders?.[0]?.value === "a=1");
  const topLevel = rules.find((rule) => rule.condition.requestMethods);
  assert.deepEqual(topLevel.condition.resourceTypes, ["main_frame"]);
  assert.deepEqual(topLevel.condition.requestMethods, ["get", "head"]);
  assert.equal(topLevel.condition.initiatorDomains, undefined);
  const others = rules.filter((rule) => rule !== topLevel);
  assert.ok(others.length > 0);
  assert.ok(others.every((rule) => rule.condition.initiatorDomains.join() === "claude.ai"));
});

test("a form posted from another site carries no cookies", () => {
  const rules = build(jarWith("a=1; Domain=claude.ai")).filter((rule) => rule.action.requestHeaders?.[0]?.value === "a=1");
  const posts = rules.filter((rule) => rule.condition.resourceTypes.includes("main_frame") && rule.condition.excludedRequestMethods);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].condition.excludedRequestMethods, ["get", "head"]);
  assert.deepEqual(posts[0].condition.initiatorDomains, ["claude.ai"]);
});

test("everything cacheable from the site skips the shared cache", () => {
  const cache = build().find((rule) => rule.action.requestHeaders?.some((header) => header.header === "cache-control"));
  for (const type of ["main_frame", "script", "stylesheet", "font", "image", "xmlhttprequest"]) {
    assert.ok(cache.condition.resourceTypes.includes(type), type);
  }
});

test("a jar with cookies on hundreds of hosts stays inside its rule range", () => {
  const jar = Array.from({ length: 300 }, (_, index) => ({
    name: `c${index}`, value: "1", domain: `h${index}.claude.ai`, hostOnly: true, path: "/", secure: true, httpOnly: false, expires: null, createdAt: 1
  }));
  const ids = build(jar).map((rule) => rule.id);
  assert.ok(Math.max(...ids) <= 2 * RULES_PER_SESSION);
  assert.equal(new Set(ids).size, ids.length);
});

test("readable cookies seed the page, HttpOnly ones never do", () => {
  const rules = build(jarWith("sessionKey=secret; HttpOnly; Domain=claude.ai", "lastActiveOrg=org; Domain=claude.ai"));
  const seeds = rules.flatMap((rule) => rule.action.responseHeaders ?? [])
    .filter((header) => header.value?.startsWith("wtic;"))
    .map((header) => atob(header.value.match(/desc="(.+)"/)[1].replace(/-/g, "+").replace(/_/g, "/")));
  assert.ok(seeds.length > 0);
  assert.ok(seeds.every((seed) => seed === "lastActiveOrg=org"));
});

test("host patterns match the right hosts and refuse look-alikes", () => {
  const wildcard = { condition: { regexFilter: hostRegex({ host: "claude.ai", wildcard: true }) } };
  assert.ok(allow(wildcard, "https://claude.ai/new"));
  assert.ok(allow(wildcard, "https://a.claude.ai/x"));
  assert.ok(allow(wildcard, "wss://claude.ai/api/ws"));
  assert.ok(allow(wildcard, "https://claude.ai:8443/"));
  assert.equal(allow(wildcard, "http://claude.ai/"), false);
  assert.equal(allow(wildcard, "https://evilclaude.ai/"), false);
  assert.equal(allow(wildcard, "https://claude.ai.evil.com/"), false);

  const exact = { condition: { regexFilter: hostRegex({ host: "claude.ai", wildcard: false }) } };
  assert.ok(allow(exact, "https://claude.ai/new"));
  assert.equal(allow(exact, "https://a.claude.ai/"), false);
});
