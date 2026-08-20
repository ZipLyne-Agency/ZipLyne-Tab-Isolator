import test from "node:test";
import assert from "node:assert/strict";
import {
  createProfile,
  isSessionId,
  normalizeProfiles,
  sanitizeName,
  sessionIdFromUrl,
  sessionUrl
} from "../src/lib/session-model.js";

test("creates valid local session profiles", () => {
  const profile = createProfile("  Personal   account  ", "#25D366");
  assert.equal(isSessionId(profile.id), true);
  assert.equal(profile.name, "Personal account");
  assert.equal(profile.color, "#25d366");
});

test("builds and parses controlled WhatsApp URLs", () => {
  const id = crypto.randomUUID();
  const url = sessionUrl(id);
  assert.equal(sessionIdFromUrl(url), id);
  assert.equal(sessionIdFromUrl("https://example.com/?wti_session=" + id), null);
  assert.equal(sessionIdFromUrl("https://web.whatsapp.com/"), null);
});

test("cleanup URLs retain the validated session", () => {
  const id = crypto.randomUUID();
  const cleanupToken = crypto.randomUUID();
  const url = new URL(sessionUrl(id, { cleanup: true, cleanupToken }));
  assert.equal(url.searchParams.get("wti_cleanup"), "1");
  assert.equal(url.searchParams.get("wti_cleanup_token"), cleanupToken);
  assert.equal(sessionIdFromUrl(url.href), id);
});

test("cleanup URLs require a nonce", () => {
  assert.throws(() => sessionUrl(crypto.randomUUID(), { cleanup: true }), /valid token/);
});

test("normalization rejects duplicates and malformed records", () => {
  const profile = createProfile("First");
  const normalized = normalizeProfiles([profile, { ...profile, name: "Duplicate" }, { id: "bad" }, null]);
  assert.deepEqual(normalized, [profile]);
});

test("names are bounded and never empty", () => {
  assert.equal(sanitizeName("   "), "WhatsApp");
  assert.equal(sanitizeName("x".repeat(80)).length, 32);
});
