# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's **Report a vulnerability** flow in this repository's Security tab so maintainers can investigate privately.

Include the affected version or commit, the browser version, the isolation surface involved, reproduction steps using synthetic data, and the impact you observed. Do not attach real WhatsApp messages, cookies, browser profiles, authentication material, or exported account databases.

## Security boundary

WhatsApp Tab Isolator is a compatibility layer, not a browser security boundary. All named sessions still live inside one Chrome profile and one web origin. HTTP cookies, normal HTTP cache, origin quota, permissions, and dedicated-worker storage remain shared. A privileged extension, local malware, DevTools, profile backup, or deliberately adversarial same-origin code may access multiple namespaces.

The project does not contain a backend, analytics, telemetry, remote code, or cloud synchronization. See the README's security boundary and manual acceptance checklist before relying on the extension with real accounts.

## Supported versions

Security fixes target the current default branch. Because WhatsApp Web and Chrome change independently, compatibility with older commits is not guaranteed.
