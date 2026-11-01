// Named sessions and the sites they belong to.

import {
  createDefaultProfiles,
  createProfile,
  createSiteProfiles,
  DEFAULT_SITE_ID,
  isSessionId,
  normalizeProfiles
} from "./lib/session-model.js";
import { WHATSAPP_SITE } from "./lib/site-model.js";
import { addSite, listSites, removeSite } from "./site-registry.js";

const PROFILES_KEY = "profiles";

export async function ensureProfiles() {
  const stored = await chrome.storage.local.get(PROFILES_KEY);
  const profiles = normalizeProfiles(stored[PROFILES_KEY]);
  if (profiles.length) return profiles;

  const defaults = createDefaultProfiles();
  await chrome.storage.local.set({ [PROFILES_KEY]: defaults });
  return defaults;
}

export async function saveProfiles(profiles) {
  await chrome.storage.local.set({ [PROFILES_KEY]: profiles });
  return profiles;
}

export async function addProfile(name, color, siteId = DEFAULT_SITE_ID) {
  if (!(await listSites()).some((site) => site.id === siteId)) throw new Error("Site not found");
  const profiles = await ensureProfiles();
  const profile = createProfile(name, color, siteId);
  await saveProfiles([...profiles, profile]);
  return profile;
}

export async function addSiteWithSessions(domain) {
  const site = await addSite(domain);
  const profiles = await ensureProfiles();
  await saveProfiles([...profiles, ...createSiteProfiles(site.id)]);
  return site;
}

export async function removeEmptySite(id) {
  if (id === WHATSAPP_SITE.id) throw new Error("WhatsApp stays in the list");
  const profiles = await ensureProfiles();
  if (profiles.some((profile) => profile.siteId === id)) throw new Error("Forget this site's sessions first");
  await removeSite(id);
  return listSites();
}

export async function siteForSession(sessionId) {
  const profile = await getProfile(sessionId);
  if (!profile) return null;
  return (await listSites()).find((site) => site.id === profile.siteId) ?? null;
}

export async function getProfile(id) {
  if (!isSessionId(id)) return null;
  return (await ensureProfiles()).find((profile) => profile.id === id) ?? null;
}
