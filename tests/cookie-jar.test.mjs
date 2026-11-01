import test from "node:test";
import assert from "node:assert/strict";
import {
  applySetCookie,
  cookieHeaderForScope,
  cookieScopes,
  MAX_COOKIES,
  parseSetCookie,
  visibleCookiesForHost
} from "../src/lib/cookie-jar.js";

const url = "https://claude.ai/login";
const options = { siteDomain: "claude.ai", now: 1000 };
const store = (jar, header, extra = {}) => applySetCookie(jar, header, url, { ...options, ...extra });

test("a header replaces the cookie with the same name, domain, and path", () => {
  let result = store([], "sessionKey=one; Path=/; HttpOnly; Secure");
  result = store(result.jar, "sessionKey=two; Path=/; HttpOnly; Secure");
  assert.equal(result.jar.length, 1);
  assert.equal(result.jar[0].value, "two");
});

test("logout headers delete the cookie", () => {
  const signedIn = store([], "sessionKey=one; Path=/").jar;
  assert.equal(store(signedIn, "sessionKey=; Max-Age=0; Path=/").jar.length, 0);
  assert.equal(store(signedIn, "sessionKey=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/").jar.length, 0);
});

test("expired cookies stop being sent", () => {
  const { jar } = store([], "short=1; Max-Age=10; Path=/");
  const scope = { host: "claude.ai", wildcard: false };
  assert.equal(cookieHeaderForScope(jar, scope, { now: 5000 }), "short=1");
  assert.equal(cookieHeaderForScope(jar, scope, { now: 20000 }), "");
});

test("host-only cookies never reach subdomains, domain cookies do", () => {
  let { jar } = store([], "hostOnly=1; Path=/");
  jar = store(jar, "shared=2; Domain=claude.ai; Path=/").jar;
  const scopes = cookieScopes(jar, "claude.ai", 1000);
  const wildcard = scopes.find((scope) => scope.wildcard);
  const exact = scopes.find((scope) => !scope.wildcard);
  assert.equal(cookieHeaderForScope(jar, wildcard, { now: 1000 }), "shared=2");
  assert.equal(cookieHeaderForScope(jar, exact, { now: 1000 }), "hostOnly=1; shared=2");
});

test("a cookie for another domain is rejected", () => {
  assert.equal(parseSetCookie("a=1; Domain=evil.example", url, options), null);
});

test("a cookie wider than the site is held at the site", () => {
  const cookie = parseSetCookie("a=1; Domain=example.com", "https://app.example.com/", { siteDomain: "app.example.com" });
  assert.equal(cookie.domain, "app.example.com");
});

test("prefixed cookies follow their rules", () => {
  assert.equal(parseSetCookie("__Host-a=1; Path=/", url, options), null);
  assert.equal(parseSetCookie("__Host-a=1; Secure; Path=/; Domain=claude.ai", url, options), null);
  assert.equal(parseSetCookie("__Host-a=1; Secure; Path=/x", url, options), null);
  assert.equal(parseSetCookie("__Secure-a=1; Path=/", url, options), null);
  assert.ok(parseSetCookie("__Host-sessionBinding=1; Secure; Path=/; HttpOnly", url, options));
});

test("script writes cannot set or replace HttpOnly cookies", () => {
  const { jar } = store([], "sessionKey=one; Path=/; HttpOnly");
  assert.equal(store(jar, "sessionKey=two; Path=/", { fromScript: true }).changed, false);
  assert.equal(store([], "other=1; HttpOnly", { fromScript: true }).changed, false);
});

test("page script sees only readable cookies", () => {
  let { jar } = store([], "sessionKey=secret; Path=/; HttpOnly");
  jar = store(jar, "lastActiveOrg=org; Path=/").jar;
  assert.equal(visibleCookiesForHost(jar, "claude.ai", 1000), "lastActiveOrg=org");
});

test("values the Cookie header cannot carry are dropped", () => {
  assert.equal(parseSetCookie("a=é", url, options), null);
  assert.equal(parseSetCookie("a=1\r\nX: y", url, options), null);
  assert.equal(parseSetCookie("=novalue", url, options), null);
  assert.equal(parseSetCookie(`a=${"x".repeat(5000)}`, url, options), null);
});

test("a jar cannot grow without bound", () => {
  let jar = [];
  for (let index = 0; index < MAX_COOKIES + 20; index += 1) {
    jar = applySetCookie(jar, `c${index}=1; Path=/`, url, { ...options, now: index }).jar;
  }
  assert.equal(jar.length, MAX_COOKIES);
  assert.equal(jar.some((cookie) => cookie.name === "c0"), false);
});

test("a redirect only needs reloading for a cookie that matters", () => {
  const first = store([], "__cf_bm=1; Path=/; HttpOnly");
  assert.equal(first.significant, true);
  const unchanged = store(first.jar, "__cf_bm=1; Path=/; HttpOnly");
  assert.equal(unchanged.significant, false);
  const analytics = store(store([], "ga=1; Path=/").jar, "ga=2; Path=/");
  assert.equal(analytics.significant, false);
});
