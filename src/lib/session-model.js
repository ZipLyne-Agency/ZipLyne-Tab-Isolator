export const SESSION_QUERY_KEY = "wti_session";
export const CLEANUP_QUERY_KEY = "wti_cleanup";
export const CLEANUP_TOKEN_QUERY_KEY = "wti_cleanup_token";
export const WHATSAPP_ORIGIN = "https://web.whatsapp.com";
export const DEFAULT_SITE_ID = "whatsapp";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export const SESSION_COLORS = [
  "#7c3aed", "#e8590c", "#0891b2", "#db2777", "#65a30d", "#ca8a04", "#4f46e5", "#0d9488"
];

export function nextColor(color) {
  return SESSION_COLORS[(SESSION_COLORS.indexOf(color) + 1) % SESSION_COLORS.length];
}

// The first unused "Account N" on a site, so people can add as many as they want
// and rename them later.
export function nextSessionDefaults(profiles, siteId) {
  const onSite = profiles.filter((profile) => profile.siteId === siteId);
  const names = new Set(onSite.map((profile) => profile.name));
  let number = onSite.length + 1;
  while (names.has(`Account ${number}`)) number += 1;
  return { name: `Account ${number}`, color: SESSION_COLORS[onSite.length % SESSION_COLORS.length] };
}

export function isSessionId(value) {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function createProfile(name, color = "#25d366", siteId = DEFAULT_SITE_ID) {
  return {
    id: crypto.randomUUID(),
    siteId,
    name: sanitizeName(name, siteId === DEFAULT_SITE_ID ? "WhatsApp" : "Account"),
    color: sanitizeColor(color),
    createdAt: new Date().toISOString()
  };
}

export function createDefaultProfiles() {
  return [
    createProfile("Personal", "#25d366"),
    createProfile("Business", "#3478f6")
  ];
}

export function createSiteProfiles(siteId) {
  return [
    createProfile("Account 1", SESSION_COLORS[0], siteId),
    createProfile("Account 2", SESSION_COLORS[1], siteId)
  ];
}

export function normalizeProfiles(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  return value.flatMap((candidate) => {
    if (!candidate || !isSessionId(candidate.id) || seen.has(candidate.id)) return [];
    seen.add(candidate.id);
    // Sessions saved before sites existed are all WhatsApp.
    const siteId = typeof candidate.siteId === "string" ? candidate.siteId : DEFAULT_SITE_ID;
    return [{
      id: candidate.id,
      siteId,
      name: sanitizeName(candidate.name, siteId === DEFAULT_SITE_ID ? "WhatsApp" : "Account"),
      color: sanitizeColor(candidate.color),
      createdAt: typeof candidate.createdAt === "string"
        ? candidate.createdAt
        : new Date(0).toISOString()
    }];
  });
}

export function sanitizeName(value, fallback = "WhatsApp") {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 32);
  return normalized || fallback;
}

export function sanitizeColor(value) {
  return COLOR_PATTERN.test(String(value)) ? String(value).toLowerCase() : "#25d366";
}

export function sessionUrl(sessionId, options = {}) {
  if (!isSessionId(sessionId)) throw new TypeError("Invalid session ID");
  const url = new URL("/", options.origin ?? WHATSAPP_ORIGIN);
  url.searchParams.set(SESSION_QUERY_KEY, sessionId);
  if (options.cleanup) {
    if (!isSessionId(options.cleanupToken)) throw new TypeError("Cleanup requires a valid token");
    url.searchParams.set(CLEANUP_QUERY_KEY, "1");
    url.searchParams.set(CLEANUP_TOKEN_QUERY_KEY, options.cleanupToken);
  }
  return url.href;
}

export function sessionIdFromUrl(urlValue, origin = WHATSAPP_ORIGIN) {
  try {
    const url = new URL(urlValue);
    if (url.origin !== origin) return null;
    const sessionId = url.searchParams.get(SESSION_QUERY_KEY);
    return isSessionId(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}
