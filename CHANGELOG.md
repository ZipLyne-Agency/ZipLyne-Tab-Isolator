# Changelog

All notable changes to this project will be documented here.

## 0.2.0 - 2026-11-01

### Added

- Any site can be added from the popup, with Chrome asking for access to that site alone.
- A per-session cookie jar for added sites, covering HttpOnly cookies, WebSockets, `document.cookie`, and the HTTP cache.
- Sessions on added sites follow the tab through navigation, new tabs, duplication, and restore.
- **Add session** under each site, with no limit on sessions. Select a session's color bar to change its color.
- Renaming a session updates its open tabs at once.
- A link that opens as "not found" becomes the page in whichever signed-in session can see it, in the same tab. Claude artifact links need no extra tabs.
- A browser test that runs the built extension against a local fake site.

### Changed

- Renamed from WhatsApp Tab Isolator to ZipLyne Tab Isolator, because it now works on any site.
- Sessions are grouped by site in the popup. WhatsApp sessions keep their URL marker and behave as before.
- The extension now requires `scripting`, `webRequest`, `webNavigation`, and `declarativeNetRequestWithHostAccess`.

## 0.1.0 - 2026-08-20

### Added

- Named, local-only WhatsApp Web sessions opened from a Chrome extension popup.
- Namespacing for Web Storage, IndexedDB, Cache Storage, BroadcastChannel, Web Locks, OPFS, and storage events.
- SharedWorker blocking and service-worker removal to reduce cross-session state paths.
- Fail-closed handling for missing or malformed session and cleanup markers.
- Nonce-bound, exact-tab cleanup with concurrent-session and retry-safe behavior.
- Capability-only diagnostics, focused tests, reproducible build tooling, and a local ZIP package command.
