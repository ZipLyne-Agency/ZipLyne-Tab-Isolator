import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("manifest stays WhatsApp-only with minimal permissions", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "src/manifest.json"), "utf8"));
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://web.whatsapp.com/*"]);
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
