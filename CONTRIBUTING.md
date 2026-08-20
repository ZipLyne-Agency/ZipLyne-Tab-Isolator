# Contributing

Thanks for helping improve WhatsApp Tab Isolator.

## Before you start

- Search existing issues before opening a new one.
- Keep changes focused and avoid adding dependencies unless they are essential.
- Never include WhatsApp account data, screenshots containing personal messages, browser profiles, cookies, tokens, exported databases, or other credentials in an issue or pull request.
- For a suspected vulnerability, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development

The project uses plain JavaScript and Node's built-in APIs. No dependency installation is required.

```sh
npm run verify
```

This rebuilds `dist/`, runs the focused tests, and checks the extension's manifest and remote-code constraints. To create the local ZIP as well:

```sh
npm run package
```

## Pull requests

1. Explain the compatibility or isolation problem being solved.
2. Add or update a focused test when behavior changes.
3. Update the documented security boundary when a browser surface is added, removed, or left unsupported.
4. Confirm `npm run verify` passes.
5. Do not commit `dist/`, `artifacts/`, account data, or browser-generated files.

Changes affecting storage, workers, service workers, cleanup, URL markers, or permissions should describe both the intended behavior and how the change fails closed.
