# Contributing

Thanks for your interest in improving Pi Fallow.

Pi Fallow is a small Pi package that connects Fallow codebase intelligence to the Pi coding agent. Contributions that improve reliability, packaging, documentation, or the `/fallow` user experience are welcome.

## Before you start

- Open an issue for larger changes so we can agree on direction first.
- Keep behavior compatible with existing `/fallow` commands and the `fallow_run` tool.
- Prefer small, focused changes over broad rewrites.
- Avoid suppressing Fallow findings when a straightforward refactor can fix them.

## Local setup

```bash
npm install
```

Try the package locally with Pi:

```bash
pi -e .
```

Or install the checkout as a local Pi package:

```bash
pi install .
```

## Checks

Run the full local check suite before opening a PR:

```bash
npm run check
npm run dupes
npm run dead-code
npm run smoke:fallow
npm run coverage
npm run audit:production
npm run audit:all
npm run package:smoke
npm run bench:tokens -- --label candidate --output /tmp/pi-fallow-token-candidate.json
npm run bench:tokens:compare -- benchmarks/baselines/v0.2.0.json /tmp/pi-fallow-token-candidate.json
npm run bench:performance -- --label candidate --output /tmp/pi-fallow-performance-candidate.json
npm run bench:performance:compare -- benchmarks/baselines/performance-v0.2.0.json /tmp/pi-fallow-performance-candidate.json
npm run pack:check
```

What these cover:

- `npm run check` runs unit tests, bundle checks, and Fallow health checks.
- `npm test` runs fast Node-based regression tests for argument mapping and overview parsing.
- `npm run check:bundle` bundles the extension entrypoints with external Pi peer dependencies.
- `npm run health` runs Fallow health checks.
- `npm run dupes` checks for duplicate code.
- `npm run dead-code` checks for unused files/exports and stale suppressions.
- `npm run smoke:fallow` smoke-tests modeled Fallow CLI surfaces.
- `npm run coverage` generates text/lcov reports and enforces gradual all-file thresholds.
- `npm run audit:production` and `npm run audit:all` check the shipped and complete dependency trees.
- `npm run package:smoke` packs, installs, and validates the npm tarball in an isolated project.
- `npm run bench:tokens` and `npm run bench:tokens:compare` measure model-visible output against the frozen `0.2.0` baseline.
- `npm run bench:performance` and `npm run bench:performance:compare` measure runner, processing, Git, memory, and cold/warm behavior against the performance baseline.
- `npm run pack:check` verifies the npm package contents.

## Pull requests

A good PR should include:

- a short explanation of the change
- screenshots or terminal output for visible UI changes when useful
- confirmation that the checks above pass
- notes about any behavior changes to `/fallow`, the navigator, or `fallow_run`

## Releases

Releases use npm trusted publishing and GitHub OIDC; maintainers should not need a long-lived npm token.

1. Run `npm version patch|minor|major --no-git-tag-version`.
2. Update `CHANGELOG.md` and run `npm run check:publish`.
3. Commit the release changes and create the matching `vX.Y.Z` tag.
4. Push `main` and the tag with `git push --follow-tags`.

The tag triggers `.github/workflows/release.yml`, which validates the package, publishes it with provenance, and creates the GitHub release. See `.github/REPOSITORY_SETTINGS.md` for the one-time trusted-publisher setup.
