import assert from "node:assert/strict";
import { test } from "node:test";
import { accessRequest, isAccessCheck, uuidFromShortId } from "../src/lib/access-checks.js";
import { applySetCookie } from "../src/lib/cookie-jar.js";
import { buildAccessRule, MAX_ACCESS_RULE_ID, RULES_PER_SESSION } from "../src/lib/cookie-rules.js";

const UUID = "12345678-1234-4234-8234-123456789abc";
const SHORT_ID = "3FP9SaFPAY5Y2N8r97jYWX";
const signedIn = applySetCookie([], "lastActiveOrg=org-one; Path=/; Secure", "https://claude.ai/").jar;

test("a short link decodes to its UUID", () => {
  assert.equal(uuidFromShortId(SHORT_ID), UUID);
  assert.equal(uuidFromShortId("4bZ6BZRUqUqZep"), "00000000-0000-4000-8000-000000000001");
});

test("a short id that cannot be a UUID is refused", () => {
  assert.equal(uuidFromShortId("not-base58-0OIl"), null);
  assert.equal(uuidFromShortId("z".repeat(40)), null);
  assert.equal(uuidFromShortId(""), null);
});

test("a Claude artifact link asks about that artifact for the session's organization", () => {
  const request = accessRequest(`https://claude.ai/artifact/${SHORT_ID}?via=auto_preview`, signedIn);
  assert.equal(request.url, `https://claude.ai/api/frame/${UUID}?org=org-one`);
  assert.deepEqual(request.headers, { "x-frame-cp": "go" });
  assert.equal(accessRequest(`https://claude.ai/artifact/${UUID}`, signedIn).url, request.url);
});

test("pages without an access check fall back to loading the page", () => {
  assert.equal(accessRequest("https://claude.ai/new", signedIn), null);
  assert.equal(accessRequest(`https://claude.ai/artifact/${SHORT_ID}/extra`, signedIn), null);
  assert.equal(accessRequest(`https://example.com/artifact/${SHORT_ID}`, signedIn), null);
  assert.equal(accessRequest(`https://claude.ai/artifact/${SHORT_ID}`, []), null);
});

test("an access rule sends one session's cookies to one exact URL in one tab", () => {
  const url = `https://claude.ai/api/frame/${UUID}?org=org-one&wtip=abc`;
  const rule = buildAccessRule({ id: 7, tabId: 3, url, cookie: "sessionKey=one" });
  assert.deepEqual(rule.condition.tabIds, [3]);
  assert.deepEqual(rule.condition.resourceTypes, ["xmlhttprequest"]);
  assert.ok(new RegExp(rule.condition.regexFilter).test(url));
  assert.ok(!new RegExp(rule.condition.regexFilter).test(`${url}x`));
  assert.ok(!new RegExp(rule.condition.regexFilter).test(url.replace("?", "x")));
  assert.deepEqual(rule.action.responseHeaders, [{ header: "set-cookie", operation: "remove" }]);
});

test("access rule ids stay below every session's rules", () => {
  assert.ok(MAX_ACCESS_RULE_ID < RULES_PER_SESSION);
});

test("an access check is recognized by its marker", () => {
  assert.equal(isAccessCheck("https://claude.ai/api/frame/1?org=a&wtip=abc"), true);
  assert.equal(isAccessCheck("https://claude.ai/api/frame/1?org=a"), false);
});
