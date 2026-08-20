<div align="center">
  <img src=".github/assets/logo.svg" width="96" height="96" alt="WhatsApp Tab Isolator logo">
  <h1>WhatsApp Tab Isolator</h1>
  <p>Run named WhatsApp Web sessions side by side in ordinary tabs of one Chrome profile.</p>

  [![CI](https://github.com/ZipLyne-Agency/whatsapp-tab-isolator/actions/workflows/ci.yml/badge.svg)](https://github.com/ZipLyne-Agency/whatsapp-tab-isolator/actions/workflows/ci.yml)
  [![MIT License](https://img.shields.io/badge/license-MIT-25d366.svg)](LICENSE)
  [![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-128c4b.svg)](src/manifest.json)
</div>

WhatsApp Tab Isolator is a local-only, open-source Chrome extension. It creates named storage namespaces such as **Personal** and **Business**, keeps all account material on your computer, and asks for access only to `web.whatsapp.com` plus extension-local storage.

> [!IMPORTANT]
> This is an experimental compatibility isolator—not a native Chrome container or a hardened security boundary. WhatsApp Web and Chrome can change independently. Complete the real-account acceptance checklist before relying on it.

## Why this exists

Chrome normally shares one origin's browser storage across every tab in a profile. That means two ordinary `web.whatsapp.com` tabs see the same login state. This extension opens marked tabs and namespaces the browser APIs WhatsApp uses for persistent state before page code runs.

There is no backend, analytics, telemetry, remote code, cloud synchronization, or Chrome Web Store dependency.

## Quick start

Requirements: Chrome 120 or newer and Node.js 20 or newer.

```sh
git clone https://github.com/ZipLyne-Agency/whatsapp-tab-isolator.git
cd whatsapp-tab-isolator
npm run verify
```

No dependency installation is required.

1. Close every open WhatsApp Web tab. Already-running tabs have captured unmodified browser APIs.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the generated `dist` directory.
5. Pin **WhatsApp Tab Isolator** to the Chrome toolbar.
6. Open **Personal** from the popup and scan the first account's QR code yourself.
7. Open **Business** and scan the second account's QR code.

Always open controlled sessions from the extension popup. A plain, unmarked `https://web.whatsapp.com/` tab fails closed.

## What it isolates

| Surface | Behavior |
| --- | --- |
| `localStorage` and `sessionStorage` | Prefixes keys and virtualizes reads, enumeration, deletion, and storage events |
| IndexedDB | Prefixes database names and exposes logical names back to the page |
| Cache Storage | Prefixes cache names and filters cache discovery and matching |
| BroadcastChannel | Prefixes channel names per session |
| Web Locks | Prefixes lock names and filters lock queries |
| OPFS | Gives each session a separate root directory |
| SharedWorker | Blocks the cross-tab worker surface |
| Service worker | Unregisters WhatsApp registrations and blocks new registration |

Multiple tabs opened for the same named session intentionally share that session. Different named sessions receive different namespaces.

### Known shared surfaces

Chrome still shares HTTP cookies, normal HTTP cache, origin quota, notification permission, and profile-level state. Dedicated Workers remain functional, but their storage cannot be safely namespaced by an ordinary Manifest V3 extension under WhatsApp's current worker Content Security Policy.

Service-worker registration is origin-wide. Opening a controlled session disables WhatsApp's offline/PWA worker for every `web.whatsapp.com` tab in that Chrome profile, including an unmarked tab. This tradeoff prevents a shared worker from bypassing the page-level namespaces.

If WhatsApp moves linked-device identity into HTTP cookies or dedicated-worker-only storage, the two-account acceptance test must fail. Separate Chrome profiles are then the reliable fallback.

## Everyday use

- Open, rename, color-code, and add sessions from the toolbar popup.
- Use the page label, title prefix, and toolbar badge to identify the active account.
- Duplicate a controlled tab to open another tab in the same named session.
- Open **Diagnostics** for capability and warning status without reading WhatsApp values.
- Use **Forget** to close one session's tabs and delete only its prefixed Web Storage, IndexedDB, Cache Storage, and OPFS data.

Close all WhatsApp tabs before disabling, reloading, or updating the extension. Removing the shim while a controlled tab is running removes the isolation layer from its next navigation.

## Manual acceptance checklist

Automated checks cannot prove compatibility with every WhatsApp release. Before relying on the extension:

1. Link two different accounts in Personal and Business.
2. Confirm both identities are visible simultaneously.
3. Reload and duplicate each tab; confirm every duplicate stays in the same named session.
4. Close and reopen each named session from the popup.
5. Restart Chrome and confirm both sessions retain the correct identity.
6. Receive updates in both accounts.
7. Manually test media download/upload and notifications if you use them.
8. Log out of one account and confirm the other remains linked after reload.
9. Forget the logged-out session and confirm only that session returns to QR onboarding.
10. Confirm Diagnostics reports no service-worker controller and no missing required layer.

No automated test in this project sends messages, scans QR codes, logs out accounts, or reads account data.

## Architecture

The extension uses plain JavaScript and Manifest V3:

```text
popup / diagnostics
        │
        ▼
background service worker ── session profiles, tabs, badges, exact cleanup
        │
        ▼
document_start MAIN-world shims ── storage, channels, workers, service worker
        │
        ▼
isolated relay ── capability-only messages to the extension
```

Each session receives a random UUID stored with its local label and color in `chrome.storage.local`. Controlled WhatsApp URLs retain that marker across reload, duplication, crash restore, and Chrome restart. Missing, partial, or malformed session and cleanup markers stop the page instead of falling back to shared storage.

Cleanup is serialized and bound to the exact session ID, cleanup-tab ID, cleanup URL, and one-time random nonce. A partial cleanup keeps the profile and retry record instead of claiming success.

## Development

```sh
npm run build     # create dist/
npm test          # run focused Node tests
npm run verify    # build, test, and check manifest/source constraints
npm run package   # also create artifacts/whatsapp-tab-isolator.zip
```

Generated `dist/` and `artifacts/` directories are intentionally not committed. CI runs the same verification and publishes the unpacked extension plus ZIP as a workflow artifact.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CHANGELOG.md](CHANGELOG.md).

## Security boundary

- WhatsApp account material remains inside namespaced `web.whatsapp.com` browser storage.
- The extension stores only profile labels, colors, random session IDs, and pending cleanup state.
- Diagnostics reports capability names and warnings only—never messages, contacts, cookies, or database values.
- Another privileged extension, local malware, DevTools, Chrome profile backup, or deliberately adversarial same-origin code may still access multiple namespaces.
- Page and worker API wrapping is compatibility-sensitive. Repeat the acceptance checklist after major Chrome or WhatsApp changes.

Please report suspected vulnerabilities privately through the repository's Security tab. Never attach real account data, cookies, QR codes, browser profiles, or exported databases.

## License and trademark

Released under the [MIT License](LICENSE).

WhatsApp is a trademark of Meta Platforms, Inc. This project is independent, is not affiliated with or endorsed by WhatsApp or Meta, and does not redistribute WhatsApp software.
