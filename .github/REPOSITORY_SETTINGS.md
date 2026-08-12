# Required repository settings

These controls cannot be enforced entirely by tracked files. This document defines the fail-closed GitHub and npm policy for the repository; maintainers must verify the live settings before creating a release tag and must not claim an unavailable control is enabled.

## Protected `main` branch

Create an active branch ruleset targeting `main` with no bypass actors and all of these settings:

- Require a pull request before merging.
- Allow squash merging only; disable merge commits and rebase merging.
- Require linear history and conversation resolution.
- Block branch deletion and force pushes/non-fast-forward updates.
- Require the branch to be up to date before merging.
- Require every status check listed below to succeed:
  - `Tests (Node 22.19)`
  - `Tests (Node 24)`
  - `Dependency audit`
  - `Dependency review`
  - `Fallow`
  - `Coverage`
  - `Package (Node 22.19)`
  - `Package (Node 24)`
  - `Analyze JavaScript and TypeScript`

Do not remove, rename, skip, or make any of these core checks advisory. Configure the repository merge options as well as the ruleset so squash is the only available merge method.

### Review policy for one maintainer

`@revazi` is currently the only code owner and eligible collaborator. GitHub does not allow a pull-request author to approve their own pull request, so while that remains true set the required GitHub approval count to zero and do not enable a code-owner-approval gate that would make every merge impossible. Pull requests, required checks, up-to-date branches, conversation resolution, and the no-bypass policy remain mandatory.

Every pull request, including each release candidate, must still have independent read-only agent review recorded as process evidence before merge. An agent report is not a GitHub user approval and must never be represented as one.

When an independent eligible GitHub reviewer and code owner exists, require one approving code-owner review and dismiss stale approvals after new commits. Do not enable that identity gate before the reviewer can actually approve.

## Protected release tags and `npm` environment

Create an active tag ruleset for `v*.*.*` that blocks tag updates, deletion, and force updates. Permit creation only through the maintainer's controlled release process, with no ruleset bypass actor if the repository plan supports that restriction.

Create the `npm` GitHub environment with these deployment protections:

- Select **Selected branches and tags**, allow only tags matching `v*.*.*`, and allow no branch pattern.
- Reject deployments from tags outside that protected pattern.
- Disallow administrator bypass of environment protection rules when GitHub exposes that control for the repository/account.
- While `@revazi` is the only eligible reviewer, configure no required human environment reviewer because GitHub self-review would make release impossible. Add one required reviewer only after an independent eligible human can approve deployments.

Before creating any release tag, the maintainer must perform and record a privileged pre-tag verification that the candidate commit came through protected `main`, every exact required check succeeded on an up-to-date commit, `npm run check:publish` and both supported Node package-smoke runs passed, the version and changelog match the proposed tag, and the inspected tarball is the intended package boundary. A failure or missing result blocks tag creation.

## npm trusted publishing

In the npm package settings for `pi-fallow`, configure this GitHub Actions trusted publisher identity exactly:

- Organization/user: `revazi`
- Repository: `pi-fallow`
- Workflow: `release.yml`
- Environment: `npm`

The release workflow intentionally uses GitHub OIDC and must not receive a long-lived `NPM_TOKEN`. Remove legacy publish tokens only after the trusted publisher identity and a controlled publication have been verified.

## Security features and support exceptions

Enable each of these controls wherever the repository/account exposes it:

- Dependency graph.
- Dependabot security updates.
- Private vulnerability reporting.
- Secret scanning.
- Secret-scanning push protection.

If GitHub does not support a control for the current repository visibility, plan, or account, record the control name, the GitHub limitation, and the verification date in this section rather than marking it complete or silently omitting it. No support exceptions are currently documented, so every control above remains required pending live verification.

## GitHub Actions policy

Restrict Actions to GitHub-owned actions plus verified or explicitly selected third-party actions needed by the repository. Keep every workflow `uses:` reference pinned to a full commit SHA, including allowlisted third-party actions; a verified publisher or allowlist entry does not replace SHA pinning.

## Dependabot

Create the `dependencies` and `github-actions` labels used by `.github/dependabot.yml`. Dependabot pull requests must pass the same review process and every required check; do not auto-merge around the protected-branch policy.

## CodeQL

Use the repository's advanced `.github/workflows/codeql.yml` configuration. Do not enable GitHub's default CodeQL setup at the same time, which would create duplicate scans.
