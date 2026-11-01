import { nextColor, nextSessionDefaults } from "./lib/session-model.js";
import { normalizeDomain, siteOrigins } from "./lib/site-model.js";

const sessionsNode = document.querySelector("#sessions");
const statusNode = document.querySelector("#status");
const tabCountNode = document.querySelector("#tab-count");
const siteForm = document.querySelector("#site-form");
let currentProfiles = [];

void render();

siteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#site-domain");
  void addSite(input.value, input);
});

// The prompt needs this click, so it starts before anything awaits. The popup
// can close behind it; the background picks up the grant either way.
async function addSite(value, input) {
  let domain;
  try {
    domain = normalizeDomain(value);
  } catch (error) {
    showStatus(error.message);
    return;
  }
  const granted = chrome.permissions.request({ origins: siteOrigins(domain) });
  try {
    await request({ type: "ADD_SITE", domain });
    input.value = "";
    await granted;
  } catch (error) {
    showStatus(error.message);
    return;
  }
  await render();
}

document.querySelector("#diagnostics").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("diagnostics.html") });
});

sessionsNode.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id, name, domain, color } = button.dataset;

  if (action === "add-session") {
    const defaults = nextSessionDefaults(currentProfiles, id);
    await run(() => request({ type: "CREATE_PROFILE", siteId: id, ...defaults }));
    return;
  }

  if (action === "color") {
    await run(() => request({ type: "UPDATE_PROFILE", id, patch: { color: nextColor(color) } }));
    return;
  }

  if (action === "allow") {
    await chrome.permissions.request({ origins: siteOrigins(domain) });
    await render();
    return;
  }

  if (action === "remove-site") {
    await run(() => request({ type: "REMOVE_SITE", id }));
    return;
  }

  if (action === "open") {
    await request({ type: "OPEN_PROFILE", id });
    window.close();
    return;
  }

  if (action === "rename") {
    const nextName = prompt("Session name", name);
    if (nextName === null) return;
    await request({ type: "UPDATE_PROFILE", id, patch: { name: nextName } });
    await render();
    return;
  }

  if (action === "forget") {
    const accepted = confirm(`Forget “${name}”? Its tabs will close and its saved login and local data will be deleted.`);
    if (!accepted) return;
    showStatus("Clearing session…");
    await run(() => request({ type: "FORGET_PROFILE", id }));
  }
});

async function run(task) {
  try {
    await task();
    await render();
  } catch (error) {
    showStatus(error.message);
  }
}

async function render() {
  try {
    const state = await request({ type: "LIST_STATE" });
    const counts = new Map();
    for (const tab of state.tabs) {
      if (tab.sessionId) counts.set(tab.sessionId, (counts.get(tab.sessionId) || 0) + 1);
    }

    sessionsNode.replaceChildren(...state.sites.map((site) => siteSection(
      site,
      state.profiles.filter((profile) => profile.siteId === site.id),
      counts
    )));
    currentProfiles = state.profiles;
    tabCountNode.textContent = `${state.tabs.length} controlled tab${state.tabs.length === 1 ? "" : "s"}`;
    statusNode.hidden = true;
  } catch (error) {
    showStatus(error.message);
  }
}

function siteSection(site, profiles, counts) {
  const section = document.createElement("section");
  section.className = "site";

  const heading = document.createElement("div");
  heading.className = "site-heading";
  const title = document.createElement("h2");
  title.textContent = site.domain;
  heading.append(title);

  const actions = document.createElement("div");
  actions.className = "site-actions";
  if (!site.granted) {
    const allow = siteButton("Allow access", "allow", site);
    allow.className = "open";
    actions.append(allow);
  } else {
    if (site.isolatesCookies && !profiles.length) {
      const remove = siteButton("Remove site", "remove-site", site);
      remove.className = "link-button";
      actions.append(remove);
    }
    const add = siteButton("Add session", "add-session", site);
    add.className = "secondary add-session";
    actions.append(add);
  }
  heading.append(actions);

  section.append(heading, ...profiles.map((profile) => sessionCard(profile, counts.get(profile.id) || 0, site)));
  return section;
}

function siteButton(label, action, site) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.id = site.id;
  button.dataset.domain = site.domain;
  return button;
}

function sessionCard(profile, count, site) {
  const card = document.createElement("article");
  card.className = "session";

  const swatch = actionButton("", "color", profile);
  swatch.className = "swatch";
  swatch.dataset.color = profile.color;
  swatch.style.backgroundColor = profile.color;
  swatch.title = `Change color of ${profile.name}`;
  swatch.setAttribute("aria-label", `Change color of ${profile.name}`);

  const copy = document.createElement("div");
  copy.className = "session-copy";
  const name = document.createElement("strong");
  name.textContent = profile.name;
  const metadata = document.createElement("span");
  metadata.textContent = `${count} open tab${count === 1 ? "" : "s"}`;
  copy.append(name, metadata);

  const actions = document.createElement("div");
  actions.className = "actions";
  const open = actionButton("Open", "open", profile);
  open.className = "open";
  open.disabled = !site.granted;
  const rename = actionButton("✎", "rename", profile);
  rename.className = "icon-button";
  rename.title = `Rename ${profile.name}`;
  rename.setAttribute("aria-label", `Rename ${profile.name}`);
  const forget = actionButton("×", "forget", profile);
  forget.className = "icon-button";
  forget.title = `Forget ${profile.name}`;
  forget.setAttribute("aria-label", `Forget ${profile.name}`);
  actions.append(open, rename, forget);
  card.append(swatch, copy, actions);
  return card;
}

function actionButton(label, action, profile) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.id = profile.id;
  button.dataset.name = profile.name;
  return button;
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "Extension request failed");
  return response;
}

function showStatus(message) {
  statusNode.textContent = message;
  statusNode.hidden = false;
}
