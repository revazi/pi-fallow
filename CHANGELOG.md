# Changelog

All notable changes to Pi Fallow are documented here.

## [Unreleased]

## [0.3.0] - 2026-07-20

### Added
- Added frozen token and execution baselines with deterministic token, runner, Git, parser, memory, and cold/warm benchmark tooling.
- Added Node.js compatibility matrices, dependency audits, dependency review, CodeQL, package-install smoke checks, coverage thresholds, Dependabot, and OIDC-based npm release automation.

### Changed
- Raised the minimum Node.js version to 22.19 to match the current Pi peer packages.
- Pinned Fallow, esbuild, and coverage tooling for reproducible development and CI checks.
- Made Git ref autocomplete non-blocking and keyed it to Pi's project directory; base-ref detection now runs only for `/fallow pr` without an explicit base and is cached per project.
- Cached Fallow runner resolution per project/session, including direct reuse of the npx-installed executable, environment-aware refresh, and one safe retry when an automatically discovered executable disappears.
- Slimmed completed engine results to bounded execution and formatting metadata, releasing raw stdout, stderr, and parsed report roots before navigator or transcript retention.
- Replaced overlapping embedded-JSON parse retries with a balanced linear scanner that handles nesting, quoted delimiters, escapes, malformed candidates, and split stdout/stderr output.
- Reduced the `fallow_run` contract to command, CLI-token args, root, timeout, and output detail while translating wide-schema calls stored by older Pi sessions before validation.
- Kept every normalized finding available in the TUI navigator and added search, section/severity filters, select-all-visible, and persistent multi-selection across filters.
- Saved complete JSON whenever navigator normalization omits raw fields; generated report artifacts are never automatically deleted by Pi Fallow.
- Added a default-off full-details checkbox to the navigator: compact prompts preserve every selected finding's coding essentials, while full mode explicitly embeds complete raw JSON and displays its model-context implication.
- Stopped counting health file scores and hotspots as findings; mixed reports hide informational records behind a default-off toggle, informational-only commands omit finding controls, and large result sets can use more terminal height.
- Centered the Fallow overlay at 90% terminal width, allowed up to 95% terminal height, and expanded large virtualized result sets to 30 visible rows.
- Made `/fallow` and `/fallow run` default to health, configurable through the shell-free `PI_FALLOW_DEFAULT_COMMAND`; explicit commands remain unchanged.
- Validated `/fallow explain` issue types before execution and removed contradictory “No issues found” and project-config context from execution-error rendering.

### Fixed
- Corrected update notices to recommend `pi update npm:pi-fallow` and display outdated installations as warnings.
- Propagated the tool abort signal through Fallow execution and made cancellation terminate wrapper process trees, including force-killing commands that ignore graceful termination.
- Made `/fallow` execute directly in RPC, JSON, and print modes while reserving loaders and navigator overlays for TUI mode and retaining full non-TUI transcript output.

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

[Unreleased]: https://github.com/revazi/pi-fallow/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/revazi/pi-fallow/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/revazi/pi-fallow/compare/v0.1.3...v0.2.0
