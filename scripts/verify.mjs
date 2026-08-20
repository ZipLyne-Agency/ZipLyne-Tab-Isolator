import { readdir, readFile, stat } from "node:fs/promises";
import { extname, resolve, relative } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist");
const manifest = JSON.parse(await readFile(resolve(output, "manifest.json"), "utf8"));
const failures = [];

if (manifest.manifest_version !== 3) failures.push("manifest_version must be 3");
if (JSON.stringify(manifest.permissions) !== JSON.stringify(["storage"])) failures.push("permissions are broader than storage");
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(["https://web.whatsapp.com/*"])) failures.push("host permission is not WhatsApp-only");

for (const path of await walk(output)) {
  const extension = extname(path);
  if (![".js", ".json", ".html", ".css"].includes(extension)) continue;
  const content = await readFile(path, "utf8");
  const lines = content.split("\n").length;
  if (lines > 400) failures.push(`${relative(root, path)} exceeds 400 lines (${lines})`);
  if (/<script[^>]+src=["']https?:/i.test(content)) failures.push(`${relative(root, path)} loads remote code`);
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(content)) failures.push(`${relative(root, path)} uses dynamic code evaluation`);
  if (content.includes("<all_urls>")) failures.push(`${relative(root, path)} requests all URLs`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Verified manifest scope, source size, and remote-code constraints.");
}

async function walk(directory) {
  const paths = [];
  for (const entry of await readdir(directory)) {
    const path = resolve(directory, entry);
    if ((await stat(path)).isDirectory()) paths.push(...await walk(path));
    else paths.push(path);
  }
  return paths;
}
