<div align="center">
  <img src=".github/assets/logo.svg" width="96" height="96" alt="ZipLyne Tab Isolator logo">
  <h1>ZipLyne Tab Isolator</h1>
  <p>Run multiple accounts of any website side by side in one Chrome profile. Each tab keeps its own login.</p>

  [![CI](https://github.com/ZipLyne-Agency/ZipLyne-Tab-Isolator/actions/workflows/ci.yml/badge.svg)](https://github.com/ZipLyne-Agency/ZipLyne-Tab-Isolator/actions/workflows/ci.yml)
  [![MIT License](https://img.shields.io/badge/license-MIT-25d366.svg)](LICENSE)
  [![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-128c4b.svg)](src/manifest.json)
</div>

Chrome shares one login per site across every tab in a profile, so using a second account means signing out of the first, keeping a second Chrome profile, or living in Incognito. Firefox and Brave have containers for this. Chrome does not.

ZipLyne Tab Isolator adds them. Keep four Claude accounts open at once, run two WhatsApp numbers next to each other, or add any other site you sign in to. Your ordinary tabs keep working exactly as they did.

It runs entirely on your computer. There is no backend, account, analytics, telemetry, remote code, or cloud sync.

> [!IMPORTANT]
> This extension is experimental, and it works around Chrome rather than using a built-in container feature. Sites and Chrome can change without warning, and it is not a security boundary between accounts. Read [Privacy and security](#privacy-and-security) before using it with accounts that matter.

## Contents

- [Install](#install)
- [Add your first site](#add-your-first-site)
- [Everyday use](#everyday-use)
- [Links that belong to another account](#links-that-belong-to-another-account)
- [Which sites work](#which-sites-work)
- [What it isolates](#what-it-isolates)
- [Privacy and security](#privacy-and-security)
- [Troubleshooting](#troubleshooting)
- [Update or uninstall](#update-or-uninstall)
- [How it works](#how-it-works)
- [Development](#development)

## Install

The extension is not in the Chrome Web Store, so you load it yourself. It needs Chrome 120 or newer. Other Chromium browsers have not been tested.

**From a release, no tools needed:**

1. Download `ziplyne-tab-isolator.zip` from the [latest release](https://github.com/ZipLyne-Agency/ZipLyne-Tab-Isolator/releases/latest).
2. Unzip it into a folder you will keep. Chrome reads the extension from this folder every time it starts.
3. Open `chrome://extensions` and turn on **Developer mode**.
4. Select **Load unpacked** and choose the `dist` folder from the ZIP.
5. Pin **ZipLyne Tab Isolator** to the toolbar.

**From source, with Node.js 20 or newer:**

```sh
git clone https://github.com/ZipLyne-Agency/ZipLyne-Tab-Isolator.git
cd ZipLyne-Tab-Isolator
npm run verify
```

There are no dependencies to install. Load the generated `dist` folder as in steps 3 to 5.

Keep the folder where it is. Chrome derives the extension's identity from the folder's path, so loading it from a new location creates a separate extension with no sessions.

## Add your first site

1. Close any tabs you already have open on the site.
2. Open the extension, type the site under **New site** (for example `claude.ai`), and select **Add site**.
3. Select **Allow access** if Chrome asks. The grant covers that one site and its subdomains, including WebSockets.
4. Open **Account 1** and sign in. Open **Account 2** and sign in to your second account.
5. Select **Add session** under the site for as many more accounts as you need. There is no limit.

Sessions do not need names first. Rename one whenever you like and its open tabs update at once.

### WhatsApp Web

WhatsApp is set up already, with **Personal** and **Business** sessions.

1. Close every open WhatsApp Web tab, since a running tab has captured unmodified browser APIs.
2. Open **Personal** from the extension and scan the first account's QR code.
3. Open **Business** and scan the second account's QR code.

Always open WhatsApp from the extension. A plain `https://web.whatsapp.com/` tab stops itself on purpose, so it can never mix up accounts.

## Everyday use

**Tell accounts apart.** Each session tab shows its name in the tab title, such as `[Work] Inbox`, in a small label at the bottom left of the page, and on the toolbar badge.

**Stay in a session.** Links, new tabs, and duplicated tabs opened from a session tab stay in that session. Sign-in popups stay in it too.

**Keep ordinary tabs ordinary.** Only tabs opened from the extension, and tabs opened from those, are isolated. Everything else on the site keeps using Chrome's normal login.

**Manage sessions.** From the extension you can open, rename, and add sessions. Select a session's color bar to change its color. **Forget** closes a session's tabs and deletes its saved login and stored data. **Diagnostics** shows which isolation layers are active without reading any stored values.

**Sign in by email.** An email sign-in link opens in an ordinary tab. Copy the link and paste it into the session tab's address bar, or use the site's verification code instead.

## Links that belong to another account

Links open wherever you click them, which is a problem for private pages. A page owned by one account usually says "not found" to every other account.

When a page says "not found" or "404" in its title, the extension looks through your other signed-in sessions. The tab shows **Checking your other accounts**, then turns into the real page under the account that can see it. If none can, it shows **Not on your other accounts**.

- **Claude artifact links** are checked with one small request per session, so nothing else opens.
- **Other pages** load in background tabs for a moment, one per session, which close when the check finishes. The same happens for a Claude link if no session gets a clear yes.

Three limits apply. Only accounts already signed in to a session can be checked. A site whose missing page uses different wording will not start a check. A Claude account in several organizations is first checked in its last active organization.

## Which sites work

Any site that signs you in with cookies should work, but every site is different.

| Site | Status |
| --- | --- |
| Claude | In daily use with four accounts at once |
| WhatsApp Web | In use with two accounts |
| GitHub | Passed a basic two-account check |
| Anything else | Untested. Add it and try the checklist below |

Sites are most likely to fail if they tie a login to a device, depend on a site-wide service worker, or need a SharedWorker. Using several accounts may also be against a site's terms, so check before you rely on it.

<details>
<summary><strong>Checklist for a new site</strong></summary>

Automated tests cannot prove compatibility with a real site. Before relying on one:

1. Sign in to two accounts in two sessions and confirm both show the right identity at once.
2. Use both side by side, reload each, and open a link from each in a new tab.
3. Restart Chrome. Confirm restored tabs rejoin their sessions and come back signed in. No automated test covers tab restore.
4. Stay signed in well past the first half hour, in case the site refreshes its login in the background.
5. Log out of one and confirm the other stays signed in.
6. Forget the logged-out session and confirm only that session is gone.
7. Confirm an ordinary tab on the site still shows Chrome's normal login.

</details>

<details>
<summary><strong>Checklist for WhatsApp Web</strong></summary>

1. Link two different accounts in Personal and Business.
2. Confirm both identities are visible at once.
3. Reload and duplicate each tab, and confirm every duplicate stays in the same session.
4. Close and reopen each session from the extension.
5. Restart Chrome and confirm both sessions keep the right identity.
6. Receive updates in both accounts.
7. Test media upload, media download, and notifications if you use them.
8. Log out of one account and confirm the other stays linked after a reload.
9. Forget the logged-out session and confirm only that session returns to the QR code.
10. Confirm Diagnostics reports no service-worker controller and no missing required layer.

</details>

No automated test in this project uses a real account, sends messages, scans QR codes, or reads account data.

## What it isolates

| Surface | Behavior |
| --- | --- |
| HTTP cookies, including HttpOnly (added sites) | Each session has its own jar, sent by network rules. Chrome's shared cookies are neither sent nor changed |
| WebSockets (added sites) | Carry the session's cookies |
| `document.cookie` (added sites) | Shows the session's readable cookies. `cookieStore` is removed so pages fall back to it |
| HTTP cache (added sites) | Everything from the site skips the cache, so one account's response never reaches another |
| `localStorage` and `sessionStorage` | Keys are prefixed, and reads, enumeration, deletion, and storage events are virtualized |
| IndexedDB | Database names are prefixed, and pages see their original names |
| Cache Storage | Cache names are prefixed, and discovery and matching are filtered |
| BroadcastChannel | Channel names are prefixed per session |
| Web Locks | Lock names are prefixed, and lock queries are filtered |
| OPFS | Each session gets a separate root directory |
| SharedWorker | Blocked |
| Service worker | Workers that control the page are removed, and new registration is blocked in session tabs |

Several tabs in the same session share that session on purpose.

### What stays shared

On every site, Chrome still shares storage quota, notification permission, and profile-level state. Dedicated Workers keep the tab's cookies, but an ordinary Manifest V3 extension cannot separate their storage.

WhatsApp sessions share HTTP cookies and the HTTP cache. Service-worker registration covers the whole site, so opening a WhatsApp session turns off its offline worker for every `web.whatsapp.com` tab in the profile. If WhatsApp moves linked-device identity into cookies or worker-only storage, separate Chrome profiles are the reliable fallback.

Added sites have these limits:

- A site-wide service worker is removed when a session tab meets it, because its requests belong to no tab and would use Chrome's shared cookies. An ordinary tab registers it again on its next load. Workers on a narrow path, such as push notification workers, stay.
- A cookie is sent to every path on its host, so a site that sets the same name on two paths may misbehave. Every cookie is treated as SameSite=Lax: a form posted from another site carries none, and SameSite=Strict is not enforced beyond that.
- A new tab opened from a session, and a tab Chrome restores after a restart, can send their first request before the extension binds them. That request can use Chrome's normal login for the site, and the tab then reloads into its session.
- A site-wide service worker can answer a page before the extension removes it, so that first response may come from Chrome's normal login.
- A login made by XHR that navigates away immediately can land signed out once. Reload the page. Logins made by `fetch` or by redirect do not have this gap.
- Forget clears storage on the site's main domain. Storage on subdomains stays until you clear site data in Chrome.
- A new session has no Cloudflare clearance, so a protected site may show its verification step once per session.

## Privacy and security

Nothing leaves your computer except the normal traffic between your browser and the sites you use.

**Your saved logins are not encrypted.** For added sites, the extension saves each session's cookies, including login tokens, in `chrome.storage.local`. Chrome encrypts its own cookies with your operating system's keychain, and this file has no such protection. Anyone who can read your Chrome profile can read those sessions, so do not use this on a computer you do not trust.

**It is not a security boundary.** All sessions live in one Chrome profile. Another privileged extension, local malware, DevTools, or a profile backup can reach every session.

Isolation also runs inside the page, so it separates accounts rather than defending against the site itself. Hostile code running on a site you added, such as a cross-site scripting bug, can read other sessions' browser storage on that site, including what Dedicated Workers store. It cannot read another session's HttpOnly cookies, and a tab cannot join a session without a secret only that session's tabs receive.

**What it stores:** session names, colors, and random IDs, your site list, and any pending cleanup, plus the saved cookies above. WhatsApp account data stays in namespaced `web.whatsapp.com` browser storage.

**Diagnostics** reports capability names and warnings only, never messages, contacts, cookies, or database values.

### Permissions

| Permission | Why it is needed |
| --- | --- |
| `storage` | Saves your sessions, site list, and each session's cookies |
| `scripting` | Runs the isolation code on sites you add |
| `declarativeNetRequestWithHostAccess` | Sends each session's cookies from its own tabs |
| `webRequest` | Reads the cookies a site sets, so they stay in that session |
| `webNavigation` | Keeps new tabs and popups in the session that opened them |
| `https://web.whatsapp.com/*` | Runs on WhatsApp Web |
| `https://*/*` and `wss://*/*` (optional) | Requested one site at a time when you add it. The extension never holds these for all sites |

Report suspected vulnerabilities privately through the repository's [Security tab](https://github.com/ZipLyne-Agency/ZipLyne-Tab-Isolator/security). See [SECURITY.md](SECURITY.md).

## Troubleshooting

| What you see | What to do |
| --- | --- |
| A session tab stays blank or will not respond | Close the tab and open the session again. If that does not help, select **Reload** in `chrome://extensions` |
| The popup shows errors after updating | Select **Reload** in `chrome://extensions`. Chrome keeps running the old version until you do |
| **Session could not start** | Close the tab and open the session from the extension |
| A plain WhatsApp tab says it has no session marker | Open WhatsApp from the extension |
| "Just a moment" on a new session | Complete the site's check once. It belongs to the site, and each session passes it separately |
| A session signed itself out | Sign in again. If it keeps happening, the site may tie logins to a device, and a separate Chrome profile is the reliable fallback |
| A link says "not found" and nothing happens | Sign that account in to a session first. The check only covers sessions with a saved login |
| **Errors** appears on the extension's card | Select it to see what was logged, then **Clear all**. Open an issue if it returns, and remove any personal data first |

## Update or uninstall

To update, replace the files in the same folder, or run `git pull` and `npm run verify`. Then close your session tabs, select **Reload** on the extension in `chrome://extensions`, and open your sessions again. Always use **Reload**. Removing and re-adding the extension deletes your sessions and saved logins.

To uninstall, select **Forget** on each session, then **Remove** in `chrome://extensions`. Removing the extension deletes its saved cookies and session list. Data the sites stored in your browser under a session stays until you clear it, which is why Forget comes first.

## How it works

The extension is plain JavaScript on Manifest V3, with no dependencies:

```text
popup / diagnostics
        │
        ▼
background service worker ── sessions, sites, cookie jars, tab bindings, cleanup
        │
        ├── declarativeNetRequest session rules ── per-tab Cookie header and session marker
        ▼
document_start MAIN-world shims ── storage, cookies, channels, workers, service worker
        │
        ▼
isolated relay ── capability and cookie messages to the extension
```

**Two kinds of site.** WhatsApp Web keeps its login in browser storage, so sessions rename that storage before page code runs. Most other sites keep their login in HttpOnly cookies, which page code cannot touch, so each session there also gets a cookie jar applied to that tab's network traffic.

**Sessions.** Each session gets a random UUID, stored with its name and color in `chrome.storage.local`. WhatsApp URLs carry that marker, which survives reload, duplication, crash restore, and restart. A missing or malformed marker stops the page rather than falling back to shared storage.

**Cookies.** Added sites navigate freely, so their marker cannot live in the URL. Network rules bind a tab to its session and add a `Server-Timing` entry to every page, which the shims read before page code runs. The tab also remembers its session in `sessionStorage`, which Chrome copies on duplication, so such a tab holds its page until it is bound again. Restored tabs are designed to use the same path.

Chrome hands a response to the page before the extension has processed its `Set-Cookie`, so `fetch` and XHR in session tabs wait until those cookies are live. A login that sets cookies on a redirect has already followed it, so the extension loads the landing page once more.

**Tab identity.** The tab's memory of its session is readable by the page, so it comes with a secret that only that session's tabs receive through their network rules. Without that secret a tab cannot rebind to a session, even if page code knows the session's ID.

**Finding the right account.** A Claude artifact's short link is its UUID in base58. For each signed-in session, the tab showing the link asks Claude's own artifact endpoint whether that session can see it. A network rule tied to a random marker adds that session's cookies to that one request. Only the status is read, any cookies in the answer are dropped, and the rule is removed afterwards. These are private endpoints that can change, so only a clear yes is trusted and anything else falls back to background tabs.

**Cleanup.** Forget is serialized and bound to the exact session ID, cleanup tab, cleanup URL, and a one-time random nonce. A partial cleanup keeps the session and its retry record rather than claiming success.

## Development

```sh
npm run build         # create dist/
npm test              # run the unit tests
npm run verify        # build, test, and check manifest and source constraints
npm run package       # also create artifacts/ziplyne-tab-isolator.zip
npm run test:browser  # run the built extension against a local fake site
```

`test:browser` needs a Playwright install and a Chromium binary, set through `WTI_PLAYWRIGHT` and `WTI_CHROMIUM`, and it binds port 443. Set `WTI_OUT_DIR` to build somewhere other than `dist/`, which is useful while Chrome is running the extension from `dist/`.

Generated `dist/` and `artifacts/` folders are not committed. CI runs the same verification and publishes the unpacked extension and ZIP as a workflow artifact.

| Path | Purpose |
| --- | --- |
| `src/background.js` | Message handling and tab lifecycle |
| `src/session-engine.js` | Cookie jars, tab bindings, and network rules |
| `src/account-finder.js`, `src/access-check.js` | Finding the session that can see a link |
| `src/site-registry.js`, `src/profile-store.js` | Sites and sessions |
| `src/relay.js` | Isolated-world bridge, page labels, and banners |
| `src/main/` | Shims that run in the page before its own code |
| `src/lib/` | Pure logic covered by Node tests |
| `tests/browser/` | End-to-end test and fake site |

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [changelog](CHANGELOG.md).

## License and trademarks

Released under the [MIT License](LICENSE).

WhatsApp is a trademark of Meta Platforms, Inc. Claude is a trademark of Anthropic, PBC. This project is independent, is not affiliated with or endorsed by either company, and does not redistribute their software.
