const reportsNode = document.querySelector("#reports");
const summaryNode = document.querySelector("#summary");
document.querySelector("#refresh").addEventListener("click", () => void render());
void render();

async function render() {
  summaryNode.textContent = "Checking controlled tabs…";
  const response = await chrome.runtime.sendMessage({ type: "GET_DIAGNOSTICS" });
  if (!response?.ok) {
    summaryNode.textContent = response?.error || "Diagnostics failed";
    return;
  }

  reportsNode.replaceChildren();
  summaryNode.textContent = `${response.reports.length} controlled tab${response.reports.length === 1 ? "" : "s"}`;
  if (!response.reports.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No controlled tabs";
    reportsNode.append(empty);
    return;
  }

  for (const entry of response.reports) reportsNode.append(reportCard(entry));
}

function reportCard(entry) {
  const card = document.createElement("article");
  card.className = "report";
  const heading = document.createElement("h2");
  heading.textContent = entry.profile || "Unrecognized session";
  const state = document.createElement("div");
  state.className = "state";
  state.textContent = entry.report
    ? `Tab ${entry.tabId} · ${entry.report.state}`
    : `Tab ${entry.tabId} · awaiting page report`;
  card.append(heading, state);

  if (!entry.report) return card;
  const capabilities = document.createElement("div");
  capabilities.className = "capabilities";
  for (const [name, enabled] of Object.entries(entry.report.capabilities || {})) {
    const item = document.createElement("div");
    item.className = `capability ${enabled ? "ok" : "bad"}`;
    item.textContent = readableName(name);
    capabilities.append(item);
  }
  card.append(capabilities);

  const warnings = [...(entry.report.warnings || [])];
  if (entry.report.serviceWorkerControlled) warnings.push("A service worker still controls this tab.");
  if (warnings.length) {
    const list = document.createElement("ul");
    list.className = "warnings";
    for (const warning of warnings) {
      const item = document.createElement("li");
      item.textContent = warning;
      list.append(item);
    }
    card.append(list);
  }
  return card;
}

function readableName(value) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase());
}
