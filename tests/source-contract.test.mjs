import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("manifest requires only WhatsApp and asks for every other site at runtime", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "src/manifest.json"), "utf8"));
  assert.deepEqual(manifest.permissions, [
    "storage",
    "scripting",
    "webRequest",
    "webNavigation",
    "declarativeNetRequestWithHostAccess"
  ]);
  assert.deepEqual(manifest.host_permissions, ["https://web.whatsapp.com/*"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*", "wss://*/*"]);
  assert.equal(manifest.content_scripts[0].world, "MAIN");
  assert.equal(manifest.content_scripts[0].run_at, "document_start");
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.equal(manifest.content_scripts[0].match_origin_as_fallback, true);
});

test("critical shims are ordered before readiness", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "src/manifest.json"), "utf8"));
  assert.deepEqual(manifest.content_scripts[0].js, [
    "main/session.js",
    "main/storage.js",
    "main/channels.js",
    "main/workers.js",
    "main/service-worker.js",
    "main/ready.js"
  ]);
});

test("runtime sites load the cookie shim right after the session marker", async () => {
  const source = await readFile(resolve(root, "src/site-registry.js"), "utf8");
  assert.match(source, /"main\/session\.js",\s+"main\/cookies\.js",\s+"main\/storage\.js"/);
  assert.match(source, /world: "MAIN"/);
  assert.match(source, /runAt: "document_start"/);
});

test("WhatsApp keeps its URL marker and never enters cookie mode", async () => {
  const source = await readFile(resolve(root, "src/main/session.js"), "utf8");
  assert.match(source, /usesUrlMarker = location\.hostname === "web\.whatsapp\.com"/);
  assert.match(source, /tabMarker = usesUrlMarker \? null : readTabMarker\(\)/);
});

test("any malformed cleanup metadata fails closed", async () => {
  const source = await readFile(resolve(root, "src/main/session.js"), "utf8");
  assert.match(source, /cleanupMetadataPresent[\s\S]*searchParams\.has\(CLEANUP_KEY\)[\s\S]*searchParams\.has\(CLEANUP_TOKEN_KEY\)/);
  assert.match(source, /active:\s*validSession\s*&&\s*!cleanupMetadataPresent/);
  assert.match(source, /blocked:\s*!validSession\s*\|\|\s*\(cleanupMetadataPresent\s*&&\s*\(!cleanupRequested\s*\|\|\s*!validCleanupToken\)\)/);
});

test("worker policy keeps dedicated workers explicit and blocks shared workers", async () => {
  const source = await readFile(resolve(root, "src/main/workers.js"), "utf8");
  assert.match(source, /dedicatedWorkerStorage = false/);
  assert.match(source, /SharedWorker disabled for tab isolation/);
});

test("extension contains no remote executable scripts", async () => {
  for (const file of ["src/popup.html", "src/diagnostics.html"]) {
    const source = await readFile(resolve(root, file), "utf8");
    assert.doesNotMatch(source, /<script[^>]+src=["']https?:/i);
  }
});
