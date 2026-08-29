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
| Dependency advisories     | Pass       | `pnpm audit` reports zero known vulnerabilities for both production dependencies and the complete development/build graph. Vulnerable transitive archive utilities are pinned to patched releases or Electron's maintained compatible fork.                                                                                                                                                                   |

## Distribution hardening

The packaged `app.asar` now uses an explicit runtime allowlist. It retains compiled desktop code, migrations, production dependencies, package metadata, the license and the runtime brand image; repository sources, tests, scripts, caches and native build intermediates are rejected. The 256 px brand PNG is sealed inside `app.asar` and is not installed as a loose file; the executable and installer icon resources are embedded by the Windows packager. The package guard rejects any published brand PNG above 256 px or 256 KiB.

Every Forge package is checked twice:

1. an entry policy verifies required runtime anchors and rejects forbidden repository content;
2. a streaming byte scan rejects known maintainer-machine path prefixes without loading the archive into memory.

The resulting package was opened through the real Electron runtime and exercised against SQLite before release. Final stable releases additionally run the clean-install distribution smoke, portable smoke, installed runtime check and release fingerprint verification described in [`release-checklist.md`](./release-checklist.md).

## Public repository safeguards

- local environment files, certificates, runtime discovery files and databases are ignored by default;
- security reports use GitHub private vulnerability reporting or the private fallback in [`SECURITY.md`](../SECURITY.md);
- `main` requires the `verify` status check and rejects force pushes and deletion;
- Dependabot alerts and updates, secret scanning and push protection are enabled when available for the public repository;
- the source commit, lockfile, packaged artifacts and installed receipt are bound by the release fingerprint.

Any later asset, integration or packaging change must pass the same policy before it can replace the stable release.
