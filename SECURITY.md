# Security Policy

## Supported versions

Security fixes are released in the latest published version of `pi-fallow` on npm.

| Version | Supported |
| ------- | --------- |
| latest  | Yes       |
| older versions | No |

## Reporting a vulnerability

Please do **not** open a public issue for sensitive security reports.

Use one of these options instead:

1. Open a private GitHub Security Advisory for this repository, if available.
2. Contact the maintainer privately through the email listed on the npm package owner profile.

Include as much detail as possible:

- affected version
- operating system and Node.js version
- steps to reproduce
- expected and actual behavior
- any logs or screenshots that help explain the issue

## Scope

Pi Fallow is a Pi extension that shells out to the Fallow CLI. Reports are especially useful for issues involving:

- command argument handling
- unsafe process execution
- unexpected file access
- leaking sensitive output into the transcript
- package installation or update behavior

For vulnerabilities in Pi or Fallow themselves, please report them to those upstream projects directly.

## Temporary development-audit risk acceptance

Normal repository CI has a narrow, temporary exception for vulnerabilities pinned inside the published development-only `@earendil-works/pi-coding-agent@0.83.0` tree. The exception expires at **2026-08-19 00:00 UTC** and does not apply to production dependencies or releases.

The accepted `npm audit --json` result is exactly:

- the direct `@earendil-works/pi-coding-agent@0.83.0` moderate meta finding caused by nested `undici`;
- `node_modules/@earendil-works/pi-coding-agent/node_modules/undici@8.5.0`, with only:
  - <https://github.com/advisories/GHSA-8xcm-r25x-g524>
  - <https://github.com/advisories/GHSA-4cwx-7wf7-3272>
  - <https://github.com/advisories/GHSA-m8rv-5g2x-5cg5>
  - <https://github.com/advisories/GHSA-jr45-8vmc-qm54>
  - <https://github.com/advisories/GHSA-v3r7-h72x-cjcm>
- `node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion@5.0.7`, with only:
  - <https://github.com/advisories/GHSA-mh99-v99m-4gvg>
  - <https://github.com/advisories/GHSA-rgw5-rvv9-x895>

`.github/npm-audit-ci-baseline.json` records the exact packages, paths, versions, advisory identities/ranges/severities, finding severities, and aggregate counts. `npm run audit:ci` runs a fresh complete-development audit and fails closed unless the nonzero result and lockfile match that boundary. It also fails on audit execution errors, malformed output, a fixed tree, or expiry; it is not a package/range ignore mechanism.

This exception is confined to the normal CI complete-development audit step. `npm run audit:production` remains strict. `npm run audit:all`, `npm run check:publish`, and `.github/workflows/release.yml` remain strict, so releases stay blocked while these findings exist.

The nested versions come from the Pi package's published shrinkwrap and cannot be replaced by this repository's root dependency resolution. Upstream Pi commit [`221a842c`](https://github.com/earendil-works/pi/commit/221a842c136ab3af23aef9e70034af86061d27c1) updates them, but it is not present in a published Pi release as of this acceptance. GitHub Dependabot update job `1508340585` consequently reports `security_update_not_possible`: `undici@8.5.0` is the latest resolvable version because `@earendil-works/pi-coding-agent@0.83.0` requires it, while `8.9.0` is the lowest non-vulnerable version. Dependabot security updates remain enabled; this external failed update attempt is not suppressed.

As soon as an upstream release containing the fix is published:

1. upgrade the Pi development packages and regenerate `package-lock.json`;
2. verify both strict audits are clean;
3. change normal CI back to `npm run audit:all` and remove the baseline, validator, tests, and this section; and
4. update/rebase draft release PR #43 so its unchanged strict release gate can pass.
