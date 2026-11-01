import test from "node:test";
import assert from "node:assert/strict";
import {
  createProfile,
  isSessionId,
  nextColor,
  nextSessionDefaults,
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

test("sessions saved before sites existed stay WhatsApp sessions", () => {
  const { siteId, ...legacy } = createProfile("Personal");
  assert.equal(siteId, "whatsapp");
  assert.equal(normalizeProfiles([legacy])[0].siteId, "whatsapp");
  assert.equal(normalizeProfiles([legacy])[0].id, legacy.id);
});

test("cleanup URLs and session lookup follow the site's origin", () => {
  const id = crypto.randomUUID();
  const url = sessionUrl(id, { cleanup: true, cleanupToken: crypto.randomUUID(), origin: "https://claude.ai" });
  assert.equal(new URL(url).origin, "https://claude.ai");
  assert.equal(sessionIdFromUrl(url, "https://claude.ai"), id);
  assert.equal(sessionIdFromUrl(url), null);
});

test("every new session gets the next free name, however many exist", () => {
  const profiles = [createProfile("Main", "#7c3aed", "claude.ai"), createProfile("ZipLyne", "#e8590c", "claude.ai")];
  assert.equal(nextSessionDefaults(profiles, "claude.ai").name, "Account 3");
  profiles.push(createProfile("Account 3", "#7c3aed", "claude.ai"));
  assert.equal(nextSessionDefaults(profiles, "claude.ai").name, "Account 4");
  assert.equal(nextSessionDefaults(profiles, "other.example").name, "Account 1");
  for (let index = 0; index < 40; index += 1) {
    const { name, color } = nextSessionDefaults(profiles, "claude.ai");
    assert.equal(profiles.some((profile) => profile.name === name), false);
    profiles.push(createProfile(name, color, "claude.ai"));
  }
});

test("the color button cycles through the palette from any color", () => {
  assert.notEqual(nextColor("#7c3aed"), "#7c3aed");
  assert.equal(nextColor("#25d366"), "#7c3aed");
});

test("names are bounded and never empty", () => {
  assert.equal(sanitizeName("   "), "WhatsApp");
  assert.equal(sanitizeName("x".repeat(80)).length, 32);
});
