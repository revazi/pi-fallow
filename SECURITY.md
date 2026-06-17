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
