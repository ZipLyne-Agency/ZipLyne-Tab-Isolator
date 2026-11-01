import test from "node:test";
import assert from "node:assert/strict";
import { assertNoOverlap, createSite, isChallengeTitle, looksNotFound, normalizeDomain, normalizeSites, siteOrigins, WHATSAPP_SITE } from "../src/lib/site-model.js";

test("accepts what people paste", () => {
  assert.equal(normalizeDomain("claude.ai"), "claude.ai");
  assert.equal(normalizeDomain(" https://www.Claude.ai/new?x=1 "), "claude.ai");
  assert.equal(normalizeDomain("app.example.co.uk"), "app.example.co.uk");
});

test("refuses things that are not sites", () => {
  for (const value of ["", "   ", "com", "not a site", "https://"]) {
    assert.throws(() => normalizeDomain(value), /Enter a site/);
  }
});

test("recognizes missing pages by title, with or without a session label", () => {
  assert.equal(looksNotFound("Page not found \u2013 Claude"), true);
  assert.equal(looksNotFound("[Main] Page not found \u2013 Claude"), true);
  assert.equal(looksNotFound("404 | Example"), true);
  assert.equal(looksNotFound("New session - Claude"), false);
  assert.equal(looksNotFound(undefined), false);
});

test("a security check is not treated as a loaded page", () => {
  assert.equal(isChallengeTitle("[Account 1] Just a moment..."), true);
  assert.equal(isChallengeTitle("New session - Claude"), false);
});

test("site permissions cover sockets as well as pages", () => {
  assert.deepEqual(siteOrigins("claude.ai"), ["https://*.claude.ai/*", "wss://*.claude.ai/*"]);
});

test("overlapping sites are refused in both directions", () => {
  assert.throws(() => assertNoOverlap("whatsapp.com", [WHATSAPP_SITE]), /overlaps/);
  assert.throws(() => assertNoOverlap("a.example.com", [createSite("example.com")]), /overlaps/);
  assert.doesNotThrow(() => assertNoOverlap("claude.ai", [WHATSAPP_SITE, createSite("example.com")]));
});

test("adding a site twice says where to add more sessions", () => {
  assert.throws(() => assertNoOverlap("claude.ai", [createSite("claude.ai")]), /already added\. Select Add session/);
});

test("stored sites are validated and deduplicated", () => {
  const sites = normalizeSites([{ domain: "claude.ai" }, { domain: "claude.ai" }, { domain: "bad value" }, null]);
  assert.deepEqual(sites.map((site) => site.domain), ["claude.ai"]);
});
