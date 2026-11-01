import { domainMatches } from "./cookie-jar.js";
import { WHATSAPP_ORIGIN } from "./session-model.js";

export const WHATSAPP_SITE_ID = "whatsapp";
export const WHATSAPP_SITE = Object.freeze({
  id: WHATSAPP_SITE_ID,
  domain: "web.whatsapp.com",
  origin: WHATSAPP_ORIGIN,
  isolatesCookies: false
});

export function isWhatsAppUrl(value) {
  try {
    return new URL(value).origin === WHATSAPP_ORIGIN;
  } catch {
    return false;
  }
}

const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

// Accepts what people paste: claude.ai, www.example.com, or a full URL.
export function normalizeDomain(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) throw new Error("Enter a site, like claude.ai");

  let host;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    throw new Error("Enter a site, like claude.ai");
  }
  host = host.replace(/^www\./, "");
  if (!HOST_PATTERN.test(host) || (!host.includes(".") && host !== "localhost")) {
    throw new Error("Enter a site, like claude.ai");
  }
  return host;
}

// Sites that render by script answer 200 for a missing page, so the title is
// the only signal that works everywhere.
export function looksNotFound(title) {
  return /\bnot found\b|\b404\b/i.test(title ?? "");
}

export function isChallengeTitle(title) {
  return /\bjust a moment\b/i.test(title ?? "");
}

export function createSite(domain) {
  return { id: domain, domain, origin: `https://${domain}`, isolatesCookies: true };
}

export function assertNoOverlap(domain, sites) {
  for (const site of sites) {
    if (domain === site.domain) throw new Error(`${domain} is already added. Select Add session under it.`);
    if (domainMatches(domain, site.domain) || domainMatches(site.domain, domain)) {
      throw new Error(`${domain} overlaps ${site.domain}`);
    }
  }
}

export function normalizeSites(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap((candidate) => {
    try {
      const domain = normalizeDomain(candidate?.domain);
      if (seen.has(domain)) return [];
      seen.add(domain);
      return [createSite(domain)];
    } catch {
      return [];
    }
  });
}

// Sockets use their own scheme, so a site needs both or its WebSockets fall
// back to Chrome's shared cookies.
export function siteOrigins(domain) {
  return [`https://*.${domain}/*`, `wss://*.${domain}/*`];
}
