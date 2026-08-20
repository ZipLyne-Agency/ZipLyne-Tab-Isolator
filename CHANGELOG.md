# Changelog

All notable changes to this project will be documented here.

## 0.1.0 - 2026-08-20

### Added

- Named, local-only WhatsApp Web sessions opened from a Chrome extension popup.
- Namespacing for Web Storage, IndexedDB, Cache Storage, BroadcastChannel, Web Locks, OPFS, and storage events.
- SharedWorker blocking and service-worker removal to reduce cross-session state paths.
- Fail-closed handling for missing or malformed session and cleanup markers.
- Nonce-bound, exact-tab cleanup with concurrent-session and retry-safe behavior.
- Capability-only diagnostics, focused tests, reproducible build tooling, and a local ZIP package command.
