# Changelog

All notable changes to Pi Fallow are documented here.

## [Unreleased]

### Added
- Added explicit opt-in semantic similar-code analysis across `/fallow` and `fallow_run`, with read-only status/discovery/inspect/review flows, advisory source-grounded rendering, partial-completion diagnostics, a cold-run timeout allowance, and hard guards against model downloads or cache mutation.

### Changed
- Updated the pinned Fallow compatibility target to 3.21.0 and re-certified the current command/schema, MCP-resource, type-aware, quality, and packaged host surfaces, including the 3.20 strict-exit and project-reference resolution changes plus the 3.21 runtime-coverage and hidden-source diagnostic fixes.

## [0.5.1] - 2026-08-29

### Changed
- Updated the coordinated Pi development lock and package-boundary certification to 0.84.3, including the manifest-declared bundled CLI entrypoint, while retaining host-provided wildcard Pi peer dependencies.
- Updated the pinned build and analysis tooling to esbuild 0.28.2 and Fallow 3.18.0, including CLI-derived capability and issue-registry coverage, type-aware wire protocol 7 and semantic schema 3 checks, unchanged 3.17 versioned output roots, and packaged host compatibility coverage.
- Updated the direct TypeBox development lock to 1.3.16 and the fully SHA-pinned CodeQL Action to 4.37.8.

## [0.5.0] - 2026-08-19

### Added
- Added `/fallow issues`, an issue-focused aggregate that combines project-wide dead-code, duplication, health, and security candidates in one navigator while omitting informational per-file health rows.
- Added isolated installed-tarball, provider-free certification against the lockfile-resolved Pi 0.84.1 host for extension loading and `/fallow health` behavior over RPC, print, and JSON modes.
- Froze the immediate pre-output-detail benchmark and measured aggregate `o200k_base` tool results at 8,046 versus 45,104 tokens (an 82.16% reduction). Benchmarked slash transcripts remained unchanged, `detail` does not change slash/TUI rendering, and omitted inline findings remain counted with complete-output references.
- Documented tested Pi 0.84.1 compatibility while retaining host-provided wildcard Pi peer dependencies.
- Added measured model guidance to inspect or trace before deletion, treat incomplete type-aware evidence as advisory, preview fixes, and prefer bounded detail for routine calls.
- Added `architecture` support to `fallow_run` and `/fallow`, backed by Fallow 3.14's stable `guard <file>...` command with required, `@`-normalized path targets.

### Changed
- Made `/fallow` and `/fallow run` default to the aggregate project-issues report instead of plain health; explicit Fallow subcommands and `PI_FALLOW_DEFAULT_COMMAND` overrides remain available.
- Expanded dead-code navigator coverage to every current Fallow issue array, with a summary-backed fallback for future issue categories.
- Centralized tool commands, compact CLI prefixes, target behavior, overlapping slash metadata, autocomplete, and the `/fallow` argument hint in one typed registry.
- Made normalized-report handling authoritative across bounded output, compact prompts, and navigator filtering/hydration; compact late-finding prompts no longer depend on complete-report hydration, while full prompts hydrate stable entries or warn on report drift.
- Updated the coordinated Pi development lock to resolved 0.84.1 packages and the direct TypeBox development lock to 1.3.11.
- Removed the temporary development-audit acceptance after the upstream fix; CI and release validation again strictly audit the complete dependency tree.

### Fixed
- Made `fallow_run.detail` effective: `summary` returns bounded status/counts, the default `findings` returns bounded normalized findings, and `raw` preserves bounded raw JSON/output. Summary and findings include complete-output references, as does raw output whenever truncation omits content.

## [0.4.0] - 2026-08-05

### Added
- Exposed Fallow 3.14's stable type-aware symbol-impact and advisory type-coupling report flags through `fallow_run`, `/fallow`, and autocomplete, including project/completeness controls, syntactic opt-out, and health baseline identity mode.
- Added focused semantic-evidence rendering that keeps incomplete symbol-impact results and type-coupling conclusions explicitly advisory.

### Changed
- Validated Pi Fallow against Fallow 3.14.0 using its signed executable, command help, capability schema, and real JSON outputs. Companion status, saved-report conversion, and browser/file-oriented `viz` remain direct Fallow CLI features rather than Pi Fallow report commands.
- Refreshed the coordinated Pi development packages to 0.83.0, the direct TypeBox lock to 1.3.10, safe transitive dependency fixes, and the checkout and CodeQL workflow actions.
- Kept the v0.4.0 production and package audits strict while accepting only the exact, expiring development-tree findings pinned by Pi 0.83.0; any package-version, lockfile, advisory, severity, path, count, or expiry drift still fails closed.

## [0.3.1] - 2026-07-22

### Fixed
- Updated the coordinated Pi development packages to 0.81.1, replacing the vulnerable shrinkwrapped `brace-expansion` 5.0.6 with 5.0.7.
- Replaced the autocomplete token regex with a linear scanner to prevent pathological quoted input from blocking the TUI.

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

[Unreleased]: https://github.com/revazi/pi-fallow/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/revazi/pi-fallow/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/revazi/pi-fallow/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/revazi/pi-fallow/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/revazi/pi-fallow/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/revazi/pi-fallow/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/revazi/pi-fallow/compare/v0.1.3...v0.2.0
