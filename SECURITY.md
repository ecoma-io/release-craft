# Security policy

## Reporting a vulnerability

Report privately through GitHub security advisories:
<https://github.com/ecoma-io/release-craft/security/advisories/new>.

Please do not open a public issue, pull request, or discussion for anything
you believe is a vulnerability. Include what you observed, how to reproduce
it, and what you infer from it — keep the three separate.

## Scope

In scope for this repository:

- The workflow security posture (`.github/workflows/`) — unpinned actions,
  permission escalations, credential persistence, injection through
  `${{ }}` interpolation into `run:`.
- The gate scripts (`scripts/check-*.mjs`) and their tests — a gate that can
  be made to pass on a non-conforming tree is a vulnerability in governance.
- The package source (`src/`) once the release engine exists — especially
  anywhere it would handle credentials, registries, or release artifacts.

Out of scope: vulnerabilities in dependencies — report those upstream, then
file a normal issue here linking the upstream advisory so the pin can move.
Social engineering of the maintainer is not a finding you can demo with a
reproduction; please just don't.

## Supported versions

Only the default branch (`main`) receives security fixes. There are no
releases yet, hence no supported release lines.

## What happens next

Acknowledgement within a few days, a private assessment, and a fix on `main`
before any public disclosure. Findings that shaped the design are documented
(without exploit detail) in
[`docs/bootstrap/ecosystem-analysis.md`](docs/bootstrap/ecosystem-analysis.md).
