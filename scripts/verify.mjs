import { readdir, readFile, stat } from "node:fs/promises";
import { extname, resolve, relative } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(process.env.WTI_OUT_DIR || resolve(root, "dist"));
const manifest = JSON.parse(await readFile(resolve(output, "manifest.json"), "utf8"));
const failures = [];

if (manifest.manifest_version !== 3) failures.push("manifest_version must be 3");
const expectedPermissions = ["storage", "scripting", "webRequest", "webNavigation", "declarativeNetRequestWithHostAccess"];
if (JSON.stringify(manifest.permissions) !== JSON.stringify(expectedPermissions)) failures.push("permissions differ from the reviewed list");
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(["https://web.whatsapp.com/*"])) failures.push("only WhatsApp may be a required host; other sites must be granted one at a time");
if (JSON.stringify(manifest.optional_host_permissions) !== JSON.stringify(["https://*/*", "wss://*/*"])) failures.push("optional hosts differ from the reviewed list");

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
