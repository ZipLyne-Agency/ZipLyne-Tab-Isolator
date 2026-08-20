export const SESSION_QUERY_KEY = "wti_session";
export const CLEANUP_QUERY_KEY = "wti_cleanup";
export const CLEANUP_TOKEN_QUERY_KEY = "wti_cleanup_token";
export const WHATSAPP_ORIGIN = "https://web.whatsapp.com";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export function isSessionId(value) {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function createProfile(name, color = "#25d366") {
  return {
    id: crypto.randomUUID(),
    name: sanitizeName(name),
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

export function normalizeProfiles(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  return value.flatMap((candidate) => {
    if (!candidate || !isSessionId(candidate.id) || seen.has(candidate.id)) return [];
    seen.add(candidate.id);
    return [{
      id: candidate.id,
      name: sanitizeName(candidate.name),
      color: sanitizeColor(candidate.color),
      createdAt: typeof candidate.createdAt === "string"
        ? candidate.createdAt
        : new Date(0).toISOString()
    }];
  });
}

export function sanitizeName(value) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 32);
  return normalized || "WhatsApp";
}

export function sanitizeColor(value) {
  return COLOR_PATTERN.test(String(value)) ? String(value).toLowerCase() : "#25d366";
}

export function sessionUrl(sessionId, options = {}) {
  if (!isSessionId(sessionId)) throw new TypeError("Invalid session ID");
  const url = new URL("/", WHATSAPP_ORIGIN);
  url.searchParams.set(SESSION_QUERY_KEY, sessionId);
  if (options.cleanup) {
    if (!isSessionId(options.cleanupToken)) throw new TypeError("Cleanup requires a valid token");
    url.searchParams.set(CLEANUP_QUERY_KEY, "1");
    url.searchParams.set(CLEANUP_TOKEN_QUERY_KEY, options.cleanupToken);
  }
  return url.href;
}

export function sessionIdFromUrl(urlValue) {
  try {
    const url = new URL(urlValue);
    if (url.origin !== WHATSAPP_ORIGIN) return null;
    const sessionId = url.searchParams.get(SESSION_QUERY_KEY);
    return isSessionId(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}
