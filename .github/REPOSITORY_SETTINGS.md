# Recommended repository settings

These controls cannot be enforced entirely from files in the repository and should be configured in GitHub and npm after the workflows merge.

## GitHub ruleset for `main`

- Require pull requests before merging.
- Require at least one approving review from a code owner.
- Dismiss stale approvals when new commits are pushed.
- Require conversation resolution.
- Require linear history.
- Block force pushes and branch deletion.
- Require branches to be up to date before merging.
- Require signed commits if all maintainers can support them.

Require these status checks:

- `Tests (Node 22.19)`
- `Tests (Node 24)`
- `Dependency audit`
- `Dependency review`
- `Fallow`
- `Coverage`
- `Package (Node 22.19)`
- `Package (Node 24)`
- `Analyze JavaScript and TypeScript`

Enable the dependency graph, GitHub's secret scanning, push protection, private vulnerability reporting, and Dependabot security updates.

## npm trusted publishing

In the npm package settings for `pi-fallow`, add a GitHub Actions trusted publisher with:

- Organization/user: `revazi`
- Repository: `pi-fallow`
- Workflow: `release.yml`
- Environment: `npm`

Create the `npm` GitHub environment and restrict deployments to protected release tags. Add required reviewers if releases should require manual approval.

The release workflow intentionally uses OIDC and does not require a long-lived `NPM_TOKEN`. Remove legacy publish tokens after trusted publishing has been verified.

## Dependabot

Create the `dependencies` and `github-actions` labels used by `.github/dependabot.yml`. Optionally enable auto-merge for patch-only Dependabot PRs after every required check succeeds; do not auto-merge major updates.

## CodeQL

Do not enable GitHub's default CodeQL setup at the same time as the repository's advanced `codeql.yml` workflow. Use one configuration to avoid duplicate scans.
