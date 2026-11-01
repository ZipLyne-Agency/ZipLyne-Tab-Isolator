import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, "artifacts");
const archive = resolve(artifacts, "ziplyne-tab-isolator.zip");
await mkdir(artifacts, { recursive: true });
await rm(archive, { force: true });

const result = spawnSync("/usr/bin/zip", ["-X", "-q", "-r", archive, "dist"], {
  cwd: root,
  stdio: "inherit"
});
if (result.status !== 0) process.exit(result.status || 1);
console.log(`Packaged ${archive}`);
