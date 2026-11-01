// The list of isolated sites and the content scripts registered for them.
// WhatsApp stays in the manifest; every other site is added at runtime after
// Chrome grants that one site's host permission.

import {
  assertNoOverlap,
  createSite,
  normalizeDomain,
  normalizeSites,
  siteOrigins,
  WHATSAPP_SITE
} from "./lib/site-model.js";

const SITES_KEY = "sites";
const SCRIPT_PREFIX = "site";

const MAIN_WORLD_SCRIPTS = [
  "main/session.js",
  "main/cookies.js",
  "main/storage.js",
  "main/channels.js",
  "main/workers.js",
  "main/service-worker.js",
  "main/ready.js"
];

async function readCustomSites() {
  const stored = await chrome.storage.local.get(SITES_KEY);
  return normalizeSites(stored[SITES_KEY]);
}

export async function listSites() {
  return [WHATSAPP_SITE, ...await readCustomSites()];
}

export async function listSitesWithAccess() {
  return Promise.all((await listSites()).map(async (site) => ({
    ...site,
    granted: site.isolatesCookies
      ? await chrome.permissions.contains({ origins: siteOrigins(site.domain) })
      : true
  })));
}

export async function addSite(value) {
  const domain = normalizeDomain(value);
  const sites = await listSites();
  assertNoOverlap(domain, sites);
  const site = createSite(domain);
  await chrome.storage.local.set({ [SITES_KEY]: [...sites.slice(1), site] });
  await syncSiteScripts();
  return site;
}

export async function removeSite(id) {
  const remaining = (await readCustomSites()).filter((site) => site.id !== id);
  await chrome.storage.local.set({ [SITES_KEY]: remaining });
  await syncSiteScripts();
  await chrome.permissions.remove({ origins: siteOrigins(id) }).catch(() => undefined);
}

function scriptsFor(site) {
  const matches = [`https://*.${site.domain}/*`];
  return [
    {
      id: `${SCRIPT_PREFIX}-main-${site.domain}`,
      matches,
      js: MAIN_WORLD_SCRIPTS,
      runAt: "document_start",
      world: "MAIN",
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: true
    },
    {
      id: `${SCRIPT_PREFIX}-relay-${site.domain}`,
      matches,
      js: ["relay.js"],
      runAt: "document_start",
      allFrames: true,
      persistAcrossSessions: true
    }
  ];
}

// Brings Chrome's registered scripts in line with the sites that have access.
export async function syncSiteScripts() {
  const registered = (await chrome.scripting.getRegisteredContentScripts())
    .map((script) => script.id)
    .filter((id) => id.startsWith(`${SCRIPT_PREFIX}-`));

  const wanted = (await listSitesWithAccess())
    .filter((site) => site.isolatesCookies && site.granted)
    .flatMap(scriptsFor);
  const wantedIds = new Set(wanted.map((script) => script.id));

  const stale = registered.filter((id) => !wantedIds.has(id));
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  const missing = wanted.filter((script) => !registered.includes(script.id));
  if (missing.length) await chrome.scripting.registerContentScripts(missing);
}
