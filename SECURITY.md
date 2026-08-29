# Security Policy

## Supported versions

Security fixes are provided for the latest stable release. Please reproduce against the current [Latest Release](https://github.com/ayanamislover/AyanamiTaskManager/releases/latest) before reporting when practical.

## Reporting a vulnerability

Please do **not** open a public Issue or Discussion for a suspected vulnerability.

Use GitHub's **Report a vulnerability** action in this repository's Security tab. It opens a private advisory shared only with the repository maintainers. Include:

- affected ATM version and Windows version;
- the smallest reliable reproduction;
- expected and observed security boundaries;
- impact and any known prerequisites;
- logs or screenshots after removing tokens, personal paths and project data.

If private vulnerability reporting is temporarily unavailable, contact the maintainer at [ay@nami.ltd](mailto:ay@nami.ltd) with the subject `AyanamiTaskManager security report`.

The maintainer will acknowledge a complete report, validate it privately, and coordinate disclosure after a fix is available. Please do not access data that is not your own or disrupt other systems while testing.

## Security boundary

ATM is a local single-user desktop application. Its daemon listens only on loopback and rotates its bearer token on each production start, but it does not claim to isolate mutually hostile processes running as the same Windows user. Read the exact guarantees and non-goals in [`docs/security-model.md`](./docs/security-model.md).
