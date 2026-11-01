// End-to-end check of the built extension in a disposable Chromium profile,
// against a local fake site. It never touches a real account or Chrome profile.
//
//   WTI_PLAYWRIGHT=<folder holding node_modules/playwright>
//   WTI_CHROMIUM=<path to a Chromium binary>
//   npm run test:browser
//
// Binds port 443, because a site's origin has no port.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { accessRequests, ARTIFACT_SHORT_ID, startFakeSite } from "./fake-site.mjs";

const { WTI_PLAYWRIGHT, WTI_CHROMIUM } = process.env;
if (!WTI_PLAYWRIGHT || !WTI_CHROMIUM) throw new Error("Set WTI_PLAYWRIGHT and WTI_CHROMIUM");
const { chromium } = createRequire(`${WTI_PLAYWRIGHT}/`)("playwright");

const root = resolve(import.meta.dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "wti-browser-"));
const base = "https://localhost";
const socketUrl = "wss://localhost/ws";

execFileSync("node", ["scripts/build.mjs"], { cwd: root, env: { ...process.env, WTI_OUT_DIR: join(work, "dist") }, stdio: "ignore" });
const extension = join(work, "extension");
cpSync(join(work, "dist"), extension, { recursive: true });
const manifestPath = join(extension, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
// A browser test cannot click Chrome's permission prompt, so grant the fake site up front.
manifest.host_permissions.push("https://*.localhost/*", "wss://*.localhost/*");
writeFileSync(manifestPath, JSON.stringify(manifest));
// Point Claude's access check at the fake site, which answers it the same way.
const accessChecksPath = join(extension, "lib/access-checks.js");
writeFileSync(accessChecksPath, readFileSync(accessChecksPath, "utf8").replace('"claude.ai"', '"localhost"'));

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(work, "key.pem"), "-out", join(work, "cert.pem"), "-days", "2", "-subj", "/CN=localhost"], { stdio: "ignore" });
const { server, sockets } = await startFakeSite({ key: readFileSync(join(work, "key.pem")), cert: readFileSync(join(work, "cert.pem")), port: 443 });

const results = [];
let describeTabs = null;
async function check(name, task) {
  try {
    await task();
    results.push([true, name]);
    console.log(`ok   ${name}`);
  } catch (error) {
    results.push([false, name]);
    console.log(`FAIL ${name}\n     ${String(error.message).split("\n").slice(0, 4).join("\n     ")}`);
    await describeTabs?.().catch(() => undefined);
  }
}

const launch = () => chromium.launchPersistentContext(join(work, "profile"), {
  executablePath: WTI_CHROMIUM,
  headless: true,
  ignoreHTTPSErrors: true,
  args: ["--ignore-certificate-errors", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(read, description, timeout = 4000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await wait(40);
  }
  throw new Error(`Timed out: ${description} (last: ${JSON.stringify(last)})`);
}

async function connect(context) {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const control = await context.newPage();
  await control.goto(`${worker.url().replace("background.js", "popup.html")}`);
  const send = (message) => control.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
  return { worker, control, send };
}

const bodyJson = async (page) => JSON.parse(await page.locator("body").innerText());
const whoami = async (page) => {
  await page.goto(`${base}/whoami`);
  return (await bodyJson(page)).cookie;
};
// Closes through Chrome, as the tab's X does. Playwright's own close can stall on
// a popup session tab even though the tab is healthy.
const closeTabsAt = (worker, ending) => worker.evaluate(async (suffix) => {
  const tabs = (await chrome.tabs.query({})).filter((tab) => tab.url?.endsWith(suffix));
  await chrome.tabs.remove(tabs.map((tab) => tab.id));
}, ending);
const fetchWhoami = (page) => page.evaluate(async () => (await (await fetch("/whoami")).json()).cookie);
const hasUser = (cookie, user) => cookie?.includes(`sessionKey=${user}`) && cookie?.includes(`__Host-sessionBinding=${user}-binding`);
const openSocket = (page) => page.evaluate((url) => new Promise((done) => {
  const socket = new WebSocket(url);
  socket.onopen = () => done("open");
  socket.onerror = () => done("failed");
}), socketUrl);

async function openSession(context, send, worker, id, url = `${base}/`) {
  const opened = context.waitForEvent("page");
  const response = await send({ type: "OPEN_PROFILE", id, url });
  assert.equal(response.ok, true, response.error);
  const page = await opened;
  // Playwright can attach after the tab has navigated, so ask Chrome instead.
  await until(() => worker.evaluate(async (id) => {
    const tab = await chrome.tabs.get(id);
    return tab.status === "complete" && tab.url.startsWith("https://localhost");
  }, response.tab.id), `session opens at ${url}`);
  return page;
}

// A crash inside Playwright must not leave a browser running.
process.on("uncaughtException", async (error) => {
  console.log(`CRASH ${error.message}`);
  await Promise.race([context.close(), wait(3000)]).catch(() => undefined);
  server.close();
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
});

let context = await launch();
context.on("close", () => console.log("note: browser context closed"));
let { worker, control, send } = await connect(context);

describeTabs = async () => {
  const tabs = await worker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => `${tab.id} ${tab.status} ${tab.active ? "active" : ""} ${(tab.url ?? "").replace("https://localhost", "")} | ${tab.title ?? ""}`));
  console.log(tabs.map((line) => `     tab ${line}`).join("\n"));
};

try {
  const added = await send({ type: "ADD_SITE", domain: "localhost" });
  assert.equal(added.ok, true, added.error);
  const state = await send({ type: "LIST_STATE" });
  const [one, two] = state.profiles.filter((profile) => profile.siteId === "localhost");
  await wait(200);

  const a = await openSession(context, send, worker, one.id);
  let b = await openSession(context, send, worker, two.id);
  await a.goto(`${base}/login?user=alice`);
  await b.goto(`${base}/login?user=bob`);
  await wait(150);

  await check("two accounts sign in on the same site at once", async () => {
    assert.ok(hasUser(await whoami(a), "alice"));
    assert.ok(hasUser(await whoami(b), "bob"));
  });

  await check("no session cookie reaches Chrome's shared jar", async () => {
    assert.deepEqual((await context.cookies(base)).map((cookie) => cookie.name), []);
  });

  await check("simultaneous requests keep their own account", async () => {
    const [first, second] = await Promise.all([fetchWhoami(a), fetchWhoami(b)]);
    assert.ok(hasUser(first, "alice"));
    assert.ok(hasUser(second, "bob"));
  });

  await check("WebSockets carry the tab's account", async () => {
    await openSocket(a);
    await openSocket(b);
    await wait(100);
    assert.ok(hasUser(sockets.at(-2), "alice"));
    assert.ok(hasUser(sockets.at(-1), "bob"));
  });

  await check("dedicated workers carry the tab's account", async () => {
    const read = (page) => page.evaluate(() => new Promise((done) => {
      const worker = new Worker("/worker.js");
      worker.onmessage = (event) => done(event.data.cookie);
      worker.postMessage(1);
    }));
    assert.ok(hasUser(await read(a), "alice"));
    assert.ok(hasUser(await read(b), "bob"));
  });

  await check("the session survives ordinary page navigation", async () => {
    await a.goto(`${base}/`);
    await a.locator("#next").click();
    await a.waitForURL(`${base}/second`);
    assert.equal(a.url().includes("wti_"), false);
    assert.ok(hasUser(await fetchWhoami(a), "alice"));
  });

  await check("document.cookie shows only this account's readable cookies", async () => {
    await a.goto(`${base}/`);
    await b.goto(`${base}/`);
    assert.equal(await a.evaluate(() => document.cookie), "lastActiveOrg=alice-org");
    assert.equal(await b.evaluate(() => document.cookie), "lastActiveOrg=bob-org");
  });

  await check("cookies written by page script reach the server and stay in the session", async () => {
    await a.evaluate(() => { document.cookie = "theme=dark; path=/"; });
    assert.ok(await a.evaluate(() => document.cookie.includes("theme=dark")));
    await until(async () => (await fetchWhoami(a))?.includes("theme=dark"), "written cookie reaches the server");
    await a.reload();
    assert.ok(await a.evaluate(() => document.cookie.includes("theme=dark")));
    assert.equal((await fetchWhoami(b))?.includes("theme=dark"), false);
    await a.evaluate(() => { document.cookie = "theme=; max-age=0; path=/"; });
    assert.equal(await a.evaluate(() => document.cookie.includes("theme")), false);
  });

  await check("a server cookie reaches a page that is already open", async () => {
    await a.goto(`${base}/`);
    await a.evaluate(() => fetch("/set-flag?value=one"));
    await until(() => a.evaluate(() => document.cookie.includes("flag=one")), "open page sees the cookie");
    assert.equal(await b.evaluate(() => document.cookie.includes("flag=one")), false);
  });

  await check("cookieStore cannot read the shared jar from a session tab", async () => {
    assert.equal(await a.evaluate(() => window.cookieStore), undefined);
  });

  await check("renaming a session updates a tab that is already open", async () => {
    await a.goto(`${base}/`);
    await until(async () => (await a.title()).startsWith("[Account 1] "), "tab starts with its session name");
    const renamed = await send({ type: "UPDATE_PROFILE", id: one.id, patch: { name: "Main" } });
    assert.equal(renamed.ok, true);
    await until(async () => (await a.title()) === "[Main] Fake site", "tab shows the new name");
    assert.equal(await a.evaluate(() => { document.title = "Changed by the page"; return document.title; }), "Changed by the page");
    await until(async () => (await a.title()) === "[Main] Changed by the page", "new name stays on later titles");
    await send({ type: "UPDATE_PROFILE", id: one.id, patch: { name: "Account 1" } });
  });

  await check("labeling a tab again never freezes it", async () => {
    const fresh = await send({ type: "CREATE_PROFILE", name: "Relabel", color: "#112233", siteId: "localhost" });
    const page = await openSession(context, send, worker, fresh.profile.id, `${base}/?relabel`);
    try {
      await until(async () => (await page.title()) === "[Relabel] Fake site", "tab shows its session name");
      // Both of these repeat the label with the name it already has.
      await page.evaluate(() => window.postMessage({ type: "WTI_READY", report: window.__WTI_REPORT }, location.origin));
      await send({ type: "UPDATE_PROFILE", id: fresh.profile.id, patch: { color: "#445566" } });
      await wait(100);
      // The page's next title change is what used to set off the freeze.
      await page.evaluate(() => { document.title = "Next title"; });
      await wait(300);
      const answer = await Promise.race([page.evaluate(() => document.title), wait(2000).then(() => "frozen")]);
      assert.equal(answer, "[Relabel] Next title");
    } finally {
      await closeTabsAt(worker, "/?relabel");
    }
  });

  await check("four accounts on one site stay separate at once", async () => {
    const pages = [];
    for (const user of ["u1", "u2", "u3", "u4"]) {
      const fresh = await send({ type: "CREATE_PROFILE", name: user, color: "#112233", siteId: "localhost" });
      const page = await openSession(context, send, worker, fresh.profile.id);
      await page.goto(`${base}/login?user=${user}`);
      pages.push([page, user]);
    }
    await wait(150);
    const seen = await Promise.all(pages.map(([page]) => fetchWhoami(page)));
    pages.forEach(([, user], index) => assert.ok(hasUser(seen[index], user), user));
    await Promise.all(pages.map(([page]) => page.close()));
  });

  await check("page storage stays separate", async () => {
    await a.evaluate(() => localStorage.setItem("k", "alice"));
    await b.evaluate(() => localStorage.setItem("k", "bob"));
    await a.reload();
    assert.equal(await a.evaluate(() => localStorage.getItem("k")), "alice");
    assert.equal(await b.evaluate(() => localStorage.getItem("k")), "bob");
  });

  await check("a login that sets cookies on a redirect lands signed in", async () => {
    for (let round = 0; round < 8; round += 1) {
      const fresh = await send({ type: "CREATE_PROFILE", name: `r${round}`, color: "#112233", siteId: "localhost" });
      const page = await openSession(context, send, worker, fresh.profile.id);
      await page.goto(`${base}/login-redirect?user=r${round}`);
      await until(async () => hasUser(await page.locator("body").innerText(), `r${round}`), `redirect round ${round}`);
      await page.close();
    }
  });

  const signsInEveryTime = async (signIn) => {
    let signedIn = 0;
    const rounds = 8;
    for (let round = 0; round < rounds; round += 1) {
      const fresh = await send({ type: "CREATE_PROFILE", name: `x${round}`, color: "#112233", siteId: "localhost" });
      const page = await openSession(context, send, worker, fresh.profile.id);
      if (hasUser(await page.evaluate(signIn, `x${round}`), `x${round}`)) signedIn += 1;
      await page.close();
    }
    assert.equal(signedIn, rounds);
  };

  await check("a login made by fetch applies to the very next request", () => signsInEveryTime(async (user) => {
    await fetch(`/login?user=${user}`);
    return (await (await fetch("/whoami")).json()).cookie;
  }));

  await check("a login made by XHR applies to the very next request", () => signsInEveryTime((user) => new Promise((done) => {
    const login = new XMLHttpRequest();
    login.open("GET", `/login?user=${user}`);
    login.onload = () => {
      const next = new XMLHttpRequest();
      next.open("GET", "/whoami");
      next.onload = () => done(JSON.parse(next.responseText).cookie);
      next.send();
    };
    login.send();
  })));

  await check("a cookie written by script applies to the very next request", async () => {
    await a.goto(`${base}/`);
    const cookie = await a.evaluate(async () => {
      document.cookie = "instant=yes; path=/";
      return (await (await fetch("/whoami")).json()).cookie;
    });
    assert.ok(cookie?.includes("instant=yes"));
    await a.evaluate(() => { document.cookie = "instant=; max-age=0; path=/"; });
  });

  await check("fetch still works when called with a Request and an abort signal", async () => {
    await a.goto(`${base}/`);
    const result = await a.evaluate(async () => {
      const ok = await (await fetch(new Request("/whoami"))).json();
      const controller = new AbortController();
      const aborted = fetch("/whoami", { signal: controller.signal }).catch((error) => error.name);
      controller.abort();
      return { signedIn: Boolean(ok.cookie), aborted: await aborted };
    });
    assert.deepEqual(result, { signedIn: true, aborted: "AbortError" });
  });

  await check("a cached response never crosses accounts", async () => {
    await a.goto(`${base}/cached`);
    assert.ok(hasUser((await bodyJson(a)).cookie, "alice"));
    await b.goto(`${base}/cached`);
    assert.ok(hasUser((await bodyJson(b)).cookie, "bob"));
  });

  await check("a revalidated response never crosses accounts", async () => {
    await a.goto(`${base}/etag`);
    assert.ok(hasUser((await bodyJson(a)).cookie, "alice"));
    await b.goto(`${base}/etag`);
    assert.ok(hasUser((await bodyJson(b)).cookie, "bob"));
  });

  await check("target=_blank links stay in the session", async () => {
    await a.goto(`${base}/`);
    const [child] = await Promise.all([context.waitForEvent("page"), a.evaluate(() => {
      const link = Object.assign(document.createElement("a"), { href: "/second", target: "_blank", rel: "noopener" });
      document.body.append(link);
      link.click();
    })]);
    await until(async () => hasUser(await fetchWhoami(child), "alice"), "new tab joins the session");
    await closeTabsAt(worker, "/second");
  });

  await check("window.open stays in the session", async () => {
    await a.goto(`${base}/`);
    const [child] = await Promise.all([context.waitForEvent("page"), a.evaluate(() => { window.open("/second"); })]);
    await until(async () => hasUser(await fetchWhoami(child), "alice"), "popup joins the session");
    await closeTabsAt(worker, "/second");
  });

  await check("a duplicated tab stays in the session", async () => {
    // Asked of Chrome directly: Playwright can lose a tab that reloads while it attaches.
    const tabs = await send({ type: "LIST_STATE" });
    const tab = tabs.tabs.find((candidate) => candidate.sessionId === one.id);
    const duplicate = await worker.evaluate((id) => chrome.tabs.duplicate(id).then((created) => created.id), tab.id);
    await until(async () => {
      const current = await send({ type: "LIST_STATE" });
      return current.tabs.some((candidate) => candidate.id === duplicate && candidate.sessionId === one.id && candidate.status === "complete");
    }, "duplicate joins the session");
    await worker.evaluate((id) => chrome.tabs.remove(id), duplicate);
  });

  const plain = await context.newPage();

  await check("a page cannot join a session by writing its ID into the tab", async () => {
    await plain.goto(`${base}/whoami`);
    await plain.evaluate((id) => {
      sessionStorage.setItem("__wti_tab_session", id);
      sessionStorage.setItem("__wti_tab_proof", "guessed");
    }, one.id);
    await plain.reload().catch(() => undefined);
    await until(async () => (await plain.evaluate(() => sessionStorage.getItem("__wti_tab_session"))) === null, "the forged marker is cleared");
    await until(async () => (await bodyJson(plain)) !== null, "the tab loads as an ordinary tab");
    assert.ok(!hasUser((await bodyJson(plain)).cookie, "alice"), "the page must not get the session's cookies");
    const bound = (await send({ type: "LIST_STATE" })).tabs.filter((tab) => tab.sessionId === one.id);
    assert.equal(bound.length, 1, "only the session's real tab stays bound");
  });

  await check("an ordinary tab is untouched and keeps its own login", async () => {
    assert.equal(await whoami(plain), null);
    await plain.goto(`${base}/login?user=shared`);
    await wait(100);
    assert.ok(hasUser(await whoami(plain), "shared"));
    assert.equal(await plain.evaluate(() => document.cookie), "lastActiveOrg=shared-org");
    assert.equal(await plain.evaluate(() => typeof window.cookieStore), "object");
  });

  await check("a login in an ordinary tab does not leak into sessions", async () => {
    assert.ok(hasUser(await whoami(a), "alice"));
    await openSocket(a);
    await wait(100);
    assert.ok(hasUser(sockets.at(-1), "alice"));
    assert.equal(sockets.at(-1).includes("shared"), false);
  });

  await check("another site in a session tab cannot send the session's cookies", async () => {
    await a.goto("https://127.0.0.1/second");
    const cookie = await a.evaluate(async () => (await (await fetch("https://localhost/whoami", { credentials: "include" })).json()).cookie);
    assert.equal(cookie, null);
    await a.goto(`${base}/`);
    assert.ok(hasUser(await fetchWhoami(a), "alice"));
  });

  await check("a narrow push worker stays registered and a page-wide worker is removed", async () => {
    await plain.goto(`${base}/`);
    await plain.evaluate(() => navigator.serviceWorker.register("/push/sw.js", { scope: "/push/" }));
    await plain.evaluate(() => navigator.serviceWorker.register("/sw.js"));
    await until(() => plain.evaluate(() => Boolean(navigator.serviceWorker.controller)), "worker controls the ordinary tab");
    await a.reload().catch(() => undefined);
    await until(async () => hasUser(await fetchWhoami(a), "alice"), "session recovers from the worker");
    assert.equal(await a.evaluate(() => Boolean(navigator.serviceWorker.controller)), false);
    const scopes = await plain.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((item) => item.scope));
    assert.deepEqual(scopes, [`${base}/push/`]);
  });

  await check("sessions survive the extension worker being stopped", async () => {
    const browserSession = await context.browser()?.newBrowserCDPSession?.();
    if (browserSession) await browserSession.send("Target.getTargets");
    const page = await context.newCDPSession(control);
    await page.send("ServiceWorker.enable");
    await page.send("ServiceWorker.stopAllWorkers");
    await wait(300);
    assert.ok(hasUser(await whoami(a), "alice"));
    await b.goto(`${base}/login?user=carol`);
    await until(async () => hasUser(await whoami(b), "carol"), "login after worker restart is captured");
    await b.goto(`${base}/login?user=bob`);
    await until(async () => hasUser(await whoami(b), "bob"), "second login after worker restart");
    ({ worker } = await until(async () => {
      const current = context.serviceWorkers()[0];
      return current ? { worker: current } : null;
    }, "extension worker is back"));
  });

  const openTabs = () => worker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => ({ id: tab.id, url: tab.url, title: tab.title })));

  const artifactUrl = `${base}/artifact/${ARTIFACT_SHORT_ID}`;
  const countNewTabs = () => worker.evaluate(() => {
    globalThis.newTabs = 0;
    if (globalThis.countingTabs) return;
    globalThis.countingTabs = true;
    chrome.tabs.onCreated.addListener(() => { globalThis.newTabs += 1; });
  });
  const newTabCount = () => worker.evaluate(() => globalThis.newTabs);
  const jarNames = (id) => worker.evaluate(async (key) => ((await chrome.storage.local.get(key))[key] ?? []).map((cookie) => cookie.name), `cookieJar:${id}`);

  await check("an artifact link becomes the owner's page in its own tab, with no other tabs", async () => {
    const opened = await context.newPage();
    await countNewTabs();
    accessRequests.length = 0;
    await opened.goto(artifactUrl).catch(() => undefined);
    await until(async () => (await opened.title()) === "[Account 1] Shared artifact", "the tab becomes the owner's page", 8000);
    assert.equal(await newTabCount(), 0);
    assert.ok(accessRequests.length >= 2, "every signed-in session is asked");
    assert.ok(accessRequests.every(({ gate }) => gate === "go"));
    assert.ok(accessRequests.some(({ cookie }) => hasUser(cookie, "alice")));
    assert.ok(accessRequests.some(({ cookie }) => hasUser(cookie, "bob")));
    assert.ok(accessRequests.every(({ cookie }) => !(cookie.includes("alice") && cookie.includes("bob"))), "one account's cookies per request");
    await plain.goto(`${base}/whoami`);
    assert.equal((await bodyJson(plain)).cookie?.includes("probed") ?? false, false);
    assert.equal(opened.isClosed(), false);
    await closeTabsAt(worker, artifactUrl);
  });

  await check("checking other accounts leaves nothing in the session doing the checking", async () => {
    const tab = (await send({ type: "LIST_STATE" })).tabs.find((candidate) => candidate.sessionId === two.id);
    assert.ok(tab, "session tab is open");
    await countNewTabs();
    await worker.evaluate(({ id, url }) => chrome.tabs.update(id, { url }), { id: tab.id, url: artifactUrl });
    await until(async () => (await openTabs()).some((candidate) => candidate.id === tab.id && candidate.title === "[Account 1] Shared artifact"), "the session tab becomes the owner's page", 8000);
    assert.equal(await newTabCount(), 0);
    assert.equal((await jarNames(two.id)).includes("probed"), false);
    assert.equal((await jarNames(one.id)).includes("probed"), false);
    const moved = (await send({ type: "LIST_STATE" })).tabs.find((candidate) => candidate.id === tab.id);
    assert.equal(moved.sessionId, one.id);
    await closeTabsAt(worker, artifactUrl);
  });

  await check("a link owned by another account moves there from an ordinary tab", async () => {
    const before = (await openTabs()).length;
    const opened = await context.newPage();
    await opened.goto(`${base}/owned?owner=alice`).catch(() => undefined);
    await until(async () => (await opened.title()) === "[Account 1] Shared doc", "the tab becomes the owner's page", 40000);
    await until(async () => (await openTabs()).length === before + 1, "checks are closed", 40000);
    assert.equal(opened.isClosed(), false);
    await closeTabsAt(worker, "/owned?owner=alice");
  });

  await check("a link owned by another account moves there from a session tab", async () => {
    b = await openSession(context, send, worker, two.id);
    await whoami(b);
    const tab = (await send({ type: "LIST_STATE" })).tabs.find((candidate) => candidate.sessionId === two.id);
    assert.ok(tab, "session tab is open");
    await worker.evaluate(({ id, url }) => chrome.tabs.update(id, { url }), { id: tab.id, url: `${base}/owned?owner=alice` });
    await until(async () => (await openTabs()).some((candidate) => candidate.id === tab.id && candidate.title === "[Account 1] Shared doc"), "the session tab becomes the owner's page", 40000);
    await until(async () => (await openTabs()).filter((candidate) => candidate.url?.includes("/owned")).length === 1, "checks are closed", 20000);
    // The moved tab must carry the owner's cookies and no longer the old session's.
    const cookie = await b.evaluate(async () => (await (await fetch("/whoami")).json()).cookie);
    assert.ok(hasUser(cookie, "alice"));
    assert.equal(cookie.includes("bob"), false);
    await closeTabsAt(worker, "/owned?owner=alice");
  });

  await check("a link no account can see stays put and leaves no extra tabs", async () => {
    const opened = await context.newPage();
    await opened.goto(`${base}/owned?owner=nobody`).catch(() => undefined);
    const ownedTabs = async () => (await openTabs()).filter((tab) => tab.url?.includes("/owned")).length;
    await until(async () => (await ownedTabs()) > 1, "checks start", 20000);
    // Checks run in batches, so one quiet moment does not mean they are done.
    let quiet = 0;
    await until(async () => {
      quiet = (await ownedTabs()) === 1 ? quiet + 1 : 0;
      return quiet >= 40;
    }, "checks finish", 90000);
    assert.equal(opened.isClosed(), false);
    await opened.close();
  });

  await check("logging out one account leaves the other signed in", async () => {
    b = await openSession(context, send, worker, two.id);
    await b.goto(`${base}/logout`);
    await until(async () => !(await whoami(b))?.includes("sessionKey"), "logout clears the session");
    assert.ok(hasUser(await whoami(a), "alice"));
    await b.goto(`${base}/login?user=bob`);
    await wait(100);
  });

  await check("forgetting a session clears only that session", async () => {
    const forgotten = await send({ type: "FORGET_PROFILE", id: two.id });
    assert.equal(forgotten.ok, true, forgotten.error);
    await until(async () => !(await send({ type: "LIST_STATE" })).profiles.some((profile) => profile.id === two.id), "session removed");
    assert.equal(b.isClosed(), true);
    assert.equal(await worker.evaluate(async (id) => (await chrome.storage.local.get(`cookieJar:${id}`))[`cookieJar:${id}`] ?? null, two.id), null);
    assert.ok(hasUser(await whoami(a), "alice"));
    await a.goto(`${base}/`);
    assert.equal(await a.evaluate(() => localStorage.getItem("k")), "alice");
    assert.equal(await plain.evaluate((id) => Object.keys(localStorage).some((key) => key.includes(id)), two.id), false);
    assert.equal(await plain.evaluate((id) => Object.keys(localStorage).some((key) => key.includes(id)), one.id), true);
  });

  await context.close();
  context = await launch();
  ({ worker, control, send } = await connect(context));
  await wait(300);

  await check("a saved login survives a browser restart", async () => {
    const page = await openSession(context, send, worker, one.id);
    assert.ok(hasUser(await fetchWhoami(page), "alice"));
    assert.ok(await page.evaluate(() => document.cookie.includes("lastActiveOrg=alice-org")));
  });
} finally {
  await context.close().catch(() => undefined);
  server.close();
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter(([passed]) => !passed);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
