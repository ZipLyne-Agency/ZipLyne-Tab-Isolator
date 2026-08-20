const sessionsNode = document.querySelector("#sessions");
const statusNode = document.querySelector("#status");
const tabCountNode = document.querySelector("#tab-count");
const form = document.querySelector("#create-form");

void render();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const nameInput = document.querySelector("#session-name");
  const colorInput = document.querySelector("#session-color");
  await request({ type: "CREATE_PROFILE", name: nameInput.value, color: colorInput.value });
  nameInput.value = "";
  await render();
});

document.querySelector("#diagnostics").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("diagnostics.html") });
});

sessionsNode.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id, name } = button.dataset;

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
    const accepted = confirm(`Forget “${name}”? Its controlled tabs will close and its local WhatsApp storage will be deleted.`);
    if (!accepted) return;
    showStatus("Closing the session and clearing its local namespace…");
    await request({ type: "FORGET_PROFILE", id });
    await render();
  }
});

async function render() {
  try {
    const state = await request({ type: "LIST_STATE" });
    const counts = new Map();
    for (const tab of state.tabs) {
      if (tab.sessionId) counts.set(tab.sessionId, (counts.get(tab.sessionId) || 0) + 1);
    }

    sessionsNode.replaceChildren(...state.profiles.map((profile) => sessionCard(profile, counts.get(profile.id) || 0)));
    tabCountNode.textContent = `${state.tabs.length} controlled tab${state.tabs.length === 1 ? "" : "s"}`;
    statusNode.hidden = true;
  } catch (error) {
    showStatus(error.message);
  }
}

function sessionCard(profile, count) {
  const card = document.createElement("article");
  card.className = "session";

  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.style.backgroundColor = profile.color;

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
