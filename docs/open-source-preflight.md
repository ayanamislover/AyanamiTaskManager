# Open-source preflight

This document records the repository hygiene review completed before AyanamiTaskManager's first public release. It is evidence for the published source and distribution policy, not a substitute for the per-release test reports shipped with each stable version.

## Go / no-go review

| Gate                      | Result     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License                   | Pass       | The repository contains the unmodified GNU AGPL v3 text; `package.json` and README declare `AGPL-3.0-only`.                                                                                                                                                                                                                                                                                                   |
| Reachable Git history     | Pass       | Gitleaks 8.30.1 scanned all 247 reachable commits, branches and tags with no real secret finding. Sensitive-filename and maintainer-path results were separately reviewed.                                                                                                                                                                                                                                    |
| GitHub Actions evidence   | Pass       | All 51 retained workflow logs and all 5 unexpired downloadable artifacts were scanned. Matches were synthetic test tokens, fixture identifiers or generic field names, not credentials.                                                                                                                                                                                                                       |
| Historical release assets | Remediated | 23 assets from versions 1.0.17, 1.0.18, 1.0.20 and 1.0.21 were digest-verified, unpacked and scanned across 63,619 extracted files. No credential, user database, runtime token or signing key was present. The packages did include unnecessary repository sources and maintainer-path build metadata, so those release records are not retained as public downloads; their Git tags remain history markers. |
| Visual assets             | Pass       | The tracked logo and Windows icon are original project artwork supplied by the maintainer. The public PNG is a compact 256 px derivative; its earlier higher-resolution blob was removed from every published branch and tag before cutover. See [`asset-provenance.md`](./asset-provenance.md).                                                                                                              |
| Dependency advisories     | Pass       | `pnpm audit` reports zero known vulnerabilities for both production dependencies and the complete development/build graph. Vulnerable transitive archive utilities are pinned to patched releases.                                                                                                                                                                                                            |

## Distribution hardening

Each version directory (`app-<version>`) is assembled from an explicit layout: the native host, launcher and installer, the bundled Node runtime with the two esbuild bundles, the runtime part of `better-sqlite3` (package metadata, `lib/`, the win32-x64 prebuild and its license), the renderer build, migrations, the Agent Guide and docs, and the project license. Repository sources, tests, scripts, source maps, native debug and link intermediates, other `node_modules` packages and any database file are rejected by the entry policy. Executable and installer icons are embedded from `logo.ico` at build time; the package guard rejects any published brand PNG above 256 px or 256 KiB.

Every package is checked before its manifest is written:

1. an entry policy verifies required runtime anchors and rejects forbidden repository content;
2. a byte scan of every file rejects the build machine's home directory, Cargo home and repository root (UTF-8 and UTF-16LE, original and lower case). Release Cargo builds remap those prefixes with `--remap-path-prefix`; without it, dependency source paths embed the builder's Windows user name in every executable;
3. every native executable must carry this version's version resource and the expected internal name, and the production host and installer must not contain smoke or drill hooks.

The resulting production binaries are started from both the portable ZIP and a clean install and exercised against SQLite before release. Final stable releases additionally run the clean-install distribution smoke, portable smoke, installed runtime check and release fingerprint verification described in [`release-checklist.md`](./release-checklist.md).

## Public repository safeguards

- local environment files, certificates, runtime discovery files and databases are ignored by default;
- security reports use GitHub private vulnerability reporting or the private fallback in [`SECURITY.md`](../SECURITY.md);
- `main` requires the `verify` status check and rejects force pushes and deletion;
- Dependabot alerts and updates, secret scanning and push protection are enabled when available for the public repository;
- the source commit, lockfile, packaged artifacts and installed receipt are bound by the release fingerprint.

Any later asset, integration or packaging change must pass the same policy before it can replace the stable release.
