// Some sites can say whether an account may see a page without loading it. These
// are private endpoints that can change, so only a clear yes is trusted: every
// other answer falls back to loading the page in background tabs.

import { liveCookies } from "./cookie-jar.js";

// Added to each check's URL so one account's cookies apply to that request alone.
export const ACCESS_MARKER = "wtip";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UUID = (1n << 128n) - 1n;

// Claude's short artifact links are the artifact's UUID in base58.
export function uuidFromShortId(id) {
  let value = 0n;
  for (const character of id) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  if (value === 0n || value > MAX_UUID) return null;
  const hex = value.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function claudeArtifact(url, jar) {
  const id = url.pathname.match(/^\/artifact\/([^/]+)\/?$/)?.[1];
  if (!id) return null;
  const uuid = UUID_PATTERN.test(id) ? id : uuidFromShortId(id);
  // The site answers for one organization at a time.
  const org = liveCookies(jar).find((cookie) => cookie.name === "lastActiveOrg")?.value;
  if (!uuid || !org) return null;
  const target = new URL(`/api/frame/${uuid}`, url.origin);
  target.searchParams.set("org", org);
  return { url: target.href, headers: { "x-frame-cp": "go" } };
}

const CHECKS = new Map([["claude.ai", claudeArtifact]]);

// The request that asks whether the owner of `jar` can see `pageUrl`, or null
// when this site or page has no such request.
export function accessRequest(pageUrl, jar) {
  const url = new URL(pageUrl);
  return CHECKS.get(url.hostname)?.(url, jar) ?? null;
}

export function isAccessCheck(requestUrl) {
  return new URL(requestUrl).searchParams.has(ACCESS_MARKER);
}
