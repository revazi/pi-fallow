# Changelog

All notable changes to Pi Fallow are documented here.

## [Unreleased]

### Added
- Added Node.js compatibility matrices, dependency audits, dependency review, CodeQL, package-install smoke checks, coverage thresholds, Dependabot, and OIDC-based npm release automation.

### Changed
- Raised the minimum Node.js version to 22.19 to match the current Pi peer packages.
- Pinned Fallow, esbuild, and coverage tooling for reproducible development and CI checks.

## [0.2.0] - 2026-07-01

### Added
- Added `/fallow about` with installed/latest npm versions, update status, update command, and project links.
- Added `/fallow version` and `/fallow update` aliases for the about/update view.
- Added a non-blocking, cached startup update notice when a newer `pi-fallow` npm version is available.
- Added `PI_FALLOW_DISABLE_UPDATE_NOTICE=1` to disable startup update notices.
- Added support for current Fallow CLI surfaces: `inspect`, `trace-symbol`, `security`, `workspaces`, `config`, `schema`, `decision-surface`, and `impact`.
- Added CI, regression tests, native Node coverage reporting, and Codecov badge support.

### Changed
- Made the Fallow issue navigator overlay fluid: it sizes to content, stays centered, and caps at the available terminal width.
- Kept Pi peer dependencies flexible while adding current Pi packages as dev dependencies for local and CI installs.
- Split CI into clearer checks for tests, Fallow, coverage, and package validation.

### Fixed
- Fixed `/fallow check-changed` by mapping it to Fallow's root changed-file analysis with `--changed-since`.
- Removed the persistent footer status line (`fallow ready · branch ... · base ...`) while keeping the transient `fallow running…` status during commands.
- Improved output parsing, overview summaries, and navigator prompt coverage with regression tests.

[0.2.0]: https://github.com/revazi/pi-fallow/compare/v0.1.3...v0.2.0
