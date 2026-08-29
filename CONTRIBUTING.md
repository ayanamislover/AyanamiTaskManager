# Contributing to AyanamiTaskManager

Thank you for helping improve ATM. Contributions are most useful when they preserve its local-first security boundary, shared application-service architecture and auditable release evidence.

## Before you start

- Search existing Issues and pull requests before opening a duplicate.
- Use an Issue for behavior changes or larger design work so scope and acceptance can be agreed first.
- Never include bearer tokens, runtime discovery files, personal project databases, private ATM records or developer-machine paths in a commit, fixture, screenshot or log.
- Security reports follow [`SECURITY.md`](./SECURITY.md), not the public Issue tracker.

## Development setup

ATM requires Windows, Node.js `>=22.13.0` and pnpm `11.16.0`.

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Use `ATM_DATA_DIR` with a disposable directory for development and tests. Do not point a development build at production data unless the task explicitly concerns migration or compatibility and a verified backup exists.

## Change guidelines

1. Keep domain and application behavior out of Electron/HTTP/MCP adapters; all entry points should reuse the same application services.
2. Add focused tests that fail for the original defect. For UI changes, also inspect the rendered result and preserve the existing design system, keyboard access and reduced-motion behavior.
3. Keep migrations additive and transactional. Existing project databases and idempotency receipts are compatibility surfaces.
4. Update public docs and generated contracts when behavior or Agent-facing schemas change.
5. Keep commits scoped. Do not reformat or rewrite unrelated files.

## Quality gates

Run the focused tests first, then the relevant repository gates:

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Changes to the desktop shell, installer, daemon lifecycle or Agent integration should also run `pnpm test:e2e` and the applicable packaged smoke. Maintainer releases follow [`docs/release-checklist.md`](./docs/release-checklist.md).

## Pull requests

Describe the user-visible outcome, risk surface, verification commands and any intentionally untested edge. A green test suite is evidence, not a substitute for explaining why the assertions cover the requested behavior.

By contributing, you agree that your contribution is licensed under the repository's [AGPL-3.0-only license](./LICENSE) and that you will follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
