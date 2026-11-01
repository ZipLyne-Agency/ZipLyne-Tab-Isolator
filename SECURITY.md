# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's **Report a vulnerability** flow in this repository's Security tab so maintainers can investigate privately.

Include the affected version or commit, the browser version, the isolation surface involved, reproduction steps using synthetic data, and the impact you observed. Do not attach real messages, cookies, browser profiles, authentication material, or exported account databases.

## Security boundary

ZipLyne Tab Isolator is a compatibility layer, not a browser security boundary. All named sessions still live inside one Chrome profile and one web origin. WhatsApp sessions share HTTP cookies and the normal HTTP cache; on every site, origin quota, permissions, and dedicated-worker storage remain shared. A privileged extension, local malware, DevTools, profile backup, or deliberately adversarial same-origin code may access multiple namespaces. Isolation runs inside the page, so hostile code on an added site can read other sessions' browser storage on that site. Reports of that behavior alone are expected; reports of one session reaching another's HttpOnly cookies are in scope.

For added sites the extension saves each session's cookies, including HttpOnly login tokens, in `chrome.storage.local`. Unlike Chrome's cookie store, that file is not encrypted with the operating system keychain, so anyone who can read the Chrome profile can read those tokens.

To find which account can see a Claude artifact link, the extension sends one request per signed-in session from the tab showing that link. Each request carries that session's cookies through a short-lived network rule tied to a random marker, only its status is read, and any cookies in the answer are dropped.

The project does not contain a backend, analytics, telemetry, remote code, or cloud synchronization. See the README's security boundary and manual acceptance checklist before relying on the extension with real accounts.

## Supported versions

Security fixes target the current default branch. Because sites and Chrome change independently, compatibility with older commits is not guaranteed.
