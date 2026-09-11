# Pi Fallow

[![npm version](https://img.shields.io/npm/v/pi-fallow.svg)](https://www.npmjs.com/package/pi-fallow)
[![npm downloads](https://img.shields.io/npm/dm/pi-fallow.svg)](https://www.npmjs.com/package/pi-fallow)
[![CI](https://github.com/revazi/pi-fallow/actions/workflows/ci.yml/badge.svg)](https://github.com/revazi/pi-fallow/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/revazi/pi-fallow/branch/main/graph/badge.svg)](https://codecov.io/gh/revazi/pi-fallow)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Pi Fallow connects [Fallow](https://fallow.tools/docs/) to the [Pi coding agent](https://github.com/earendil-works/pi): you get a `fallow_run` tool for agent workflows and a `/fallow` slash command for interactive checks.

Use it when you want Pi to verify changes, review a PR, find dead code, inspect duplication, check maintainability, or trace whether something is safe to remove.

![Pi Fallow running on the pi-fallow codebase](./pi-fallow.png)

*Pi Fallow checking the pi-fallow package itself.*

## Highlights

- **Compact agent tool:** `fallow_run` uses a small command-plus-args contract while preserving internal validation and older-session compatibility.
- **Synchronized command contract:** one typed registry drives tool commands, compact CLI prefixes, slash aliases, autocomplete, and the `/fallow` argument hint.
- **Useful default:** `/fallow`, `/fallow run`, and `/fallow issues` aggregate project-wide dead-code, duplication, health, and security findings into one issue-focused report; per-file health context is omitted.
- **Slash command:** `/fallow ...` runs Fallow from inside Pi, with direct subcommands retained and a configurable default command.
- **PR shortcut:** `/fallow pr` maps to `audit --base <detected-base> --gate new-only`.
- **Rerun shortcut:** `/fallow rerun` repeats the last `/fallow` command.
- **Non-blocking autocomplete:** subcommands, flags, enum values, static refs, and asynchronously discovered project branch refs are suggested without running Git while you type.
- **Interactive navigator:** every actionable finding remains navigable with search, section/severity filters, multi-selection, command-aware read-only actions, tracing, and editor loading; informational file scores/hotspots are classified separately.
- **Run-mode support:** `/fallow` executes in TUI, RPC, JSON, and print modes; terminal loaders and navigator overlays are TUI-only, while non-TUI modes retain full transcript output.
- **Robust output parsing:** direct or noisy embedded JSON is scanned once with nesting, strings, and escapes handled correctly.
- **Safe defaults:** JSON and quiet output are added when appropriate; complete output is saved to a temp file whenever transcript or navigator data omits fields, and released from retained engine state after formatting. Pi Fallow never automatically deletes saved reports.
- **Cached CLI lookup:** resolves `FALLOW_BIN`, `fallow` from `PATH`, or a package-local installation once per project/session before falling back to `npx -y fallow`.
- **Stable type-aware reports:** Fallow semantic symbol impact and advisory public-signature coupling can be requested through both Pi surfaces, with completeness and advisory status kept visible.
- **Opt-in semantic similarity:** `/fallow similar-code` and `fallow_run(command: "similar-code")` expose Fallow's pinned local-model workflow without adding candidates to default checks; TUI setup remains a separate previewed and explicitly confirmed action.

## Installation

Install from npm after publishing:

```bash
pi install npm:pi-fallow
```

Install directly from GitHub:

```bash
pi install git:github.com/revazi/pi-fallow
```

Try it locally without installing:

```bash
pi -e .
```

Or install the local checkout:

```bash
pi install .
# project-local install
pi install -l .
```

## Usage

Ask Pi things like:

- “Run a Fallow audit for this PR and fix introduced dead code.”
- “Find duplicate code, trace the largest clone group, then suggest a refactor.”
- “Inspect this file with Fallow before editing it.”
- “Show which architecture rules apply to these files before changing them.”
- “Run Fallow security candidates for the changed files and explain what needs verification.”
- “Run Fallow health and tell me the safest maintainability improvement.”
- “Preview Fallow auto-fixes before applying anything.”

Manual slash command examples:

```text
/fallow
/fallow issues
/fallow run
/fallow run --score
/fallow pr
/fallow rerun
/fallow about
/fallow audit --base origin/main --gate new-only
/fallow check-changed --changed-since main
/fallow dead-code --changed-since main
/fallow dead-code --type-aware --symbol-impact extensions/fallow/cli.ts:fallowCli
/fallow dupes --changed-since main
/fallow health --file-scores --targets --score
/fallow health --type-aware --type-coupling
/fallow inspect --file extensions/fallow/cli.ts
/fallow inspect --symbol extensions/fallow/cli.ts:fallowCli
/fallow explain unused-export
/fallow trace extensions/fallow/cli.ts:fallowCli
/fallow trace-file extensions/fallow/ui.ts
/fallow trace-export extensions/fallow/ui.ts FallowIssueNavigator
/fallow security --changed-since main --gate new
/fallow architecture extensions/fallow/cli.ts extensions/fallow/registry.ts
/fallow decision-surface --changed-since main
/fallow similar-code status
/fallow similar-code --file extensions/fallow/cli.ts --top 10
/fallow similar-code inspect sc_example --candidates similar-code.json
/fallow similar-code review --candidates similar-code.json --verdicts verdicts.json
/fallow workspaces
/fallow schema
/fallow coverage analyze
```

`/fallow`, `/fallow run`, and `/fallow issues` run Pi Fallow's project-issue aggregation by default. It executes Fallow's combined dead-code, duplication, and health analysis followed by the opt-in security-candidate analysis, then opens one navigator containing only actionable findings. Informational health file scores and hotspots are intentionally omitted so a clean project does not produce a browser full of files. Security entries remain candidates that require agent verification, not confirmed vulnerabilities.

The aggregate accepts curated options that can be applied safely to one or both analyses, including `--changed-since`, `--workspace`, `--production`, `--score`, type-aware controls, runtime coverage, and `--surface`. Use an explicit command such as `/fallow health --file-scores` for command-specific informational output. `/fallow all` remains direct access to Fallow's native combined root report and does not add the separate security scan.

Set `PI_FALLOW_DEFAULT_COMMAND` to a shell-free command string to replace the aggregate default, for example:

```bash
export PI_FALLOW_DEFAULT_COMMAND='health --complexity --targets --score'
```

Arguments after `/fallow run` are appended to the configured default. Explicit commands such as `/fallow dupes` are never replaced. Recursive or extension-only defaults such as `run`, `rerun`, `history`, or `about` are rejected.

`/fallow check-changed` is a Pi Fallow convenience alias for Fallow's combined root analysis with `--changed-since`.

`/fallow architecture <file>...` maps to Fallow's stable `guard <file>...` command. The first file is required, multiple files and flags are preserved, and Pi's optional leading `@` is removed only from positional path targets (not flag values). Direct raw `/fallow guard ...` access remains available.

The agent-facing `fallow_run` tool passes command-specific flags as separate `args` tokens. For example, a PR audit uses `{ "command": "audit", "args": ["--base", "main", "--gate", "new-only"] }`, while an architecture query uses `{ "command": "architecture", "args": ["src/api.ts", "src/domain.ts"] }`. Type-aware reports use the existing structured commands, for example `{ "command": "dead-code", "args": ["--type-aware", "--symbol-impact", "src/api.ts:Client"] }` or `{ "command": "health", "args": ["--type-aware", "--type-coupling"] }`. Other manual `/fallow` command syntax is unchanged.

`fallow_run.detail` controls model-facing output and defaults to `findings`. Use `summary` for bounded status and counts, `findings` for bounded normalized findings with locations, evidence, and suggested actions, or `raw` for bounded raw Fallow JSON/output. Summary and findings responses always link to a complete report in the operating system's temporary directory; raw responses do so when truncation omits content. This setting does not change `/fallow` slash-command or navigator rendering.

When `fallow_run` is active, its compact Pi prompt guidance tells the model to inspect or trace before deletion, treat incomplete type-aware evidence as advisory, preview fixes before applying them, avoid unrequested changes, and reserve raw detail for necessary diagnostics.

`--type-aware-project` selects a TypeScript project and `--type-aware-require best-effort|complete` controls required completeness. Always inspect the returned type-aware completeness, omissions, and abstentions: incomplete evidence remains advisory and must not be treated as exact delete-safety proof. Fallow also supports `--baseline-mode count|identity` for health baselines and `--no-type-aware` to override config for a syntactic-only run.

### Optional analysis controls

TUI reports now use one consistent bordered-panel visual across Findings, Similar Code, Runtime Coverage, Setup, running progress, and retained results. The persistent view header contains **1 Findings**, **2 Similar Code**, and **3 Runtime Coverage**, including empty reports; the active view is highlighted, fields use compact aligned shortcut/value rows, readiness and execution states use semantic status colors, and section/footer dividers remain visible at narrow widths. Switching views keeps the findings selection, filters, expansion, scroll, and prompt detail intact. Entering either optional view checks readiness in place. **r** refreshes; **i** expands/collapses identity, integrity, and installation-location details. Checks show loading, ready, missing, incompatible, corrupt/unverified, or check-failed states and time out after 30 seconds. You can switch views or close during a check; stale results cannot overwrite a newer refresh or a closed overlay. Opening or refreshing these views performs no installation, model download, analysis, or setup-state mutation. Similar Code configuration, Runtime Coverage artifact selection, optional-component setup, analysis execution, and results all stay in the mounted overlay.

Use `1`/`2`/`3` to switch views. Search editing and action palettes keep keyboard priority (digits still enter search text); Tab still marks findings. In optional views, arrows/Page Up/Page Down scroll, Escape or Backspace returns to Findings, and `q` closes. Each view retains its own scroll position while the overlay is open. In Findings, Page Up/Page Down scrolls the full viewport without changing selection; normal navigation keeps the selected finding visible. Resizing preserves drafts, cursor focus, results, and selection. Below 40 content columns or 12 terminal rows, a resize notice replaces the UI: editing and confirmation pause; Escape/q can still cancel or close. In Findings, Escape first dismisses search/actions, otherwise closes. Input focus follows the active view; no state is saved to configuration files.

In **Similar Code**, press **s** to edit project-file scope, **t** for threshold, or **l** for result limit. Blank scope means the whole project; blank numeric fields omit overrides and use Fallow defaults. Threshold accepts decimal values from 0 to 1; result limit accepts decimal integers from 1 to 100000 (not hex or exponent notation). A nonblank scope must name an existing project-relative file, including after symlink resolution. Values remain session-local across view switches, validation failures, and return from results; no Fallow configuration files are written.

Press **c** outside editing to toggle **Reuse local embeddings**. It defaults **off**: Run passes `--no-cache`. When explicitly enabled, Run may read and write Fallow's user-local, project-namespaced vector cache, allowing unchanged embeddings to be reused on later runs. Cold runs and cache misses can still take minutes; this is not a completion guarantee. Toggling does not start analysis, download anything, or write configuration. The choice stays with the form draft and retained result request; retrying that result uses the same choice. Runtime Coverage caching remains disabled.

While editing, digits and shortcut letters are text; Tab/Shift+Tab changes fields. Enter finishes editing and validates **without running**; Escape finishes editing while retaining the draft. Then `1`/`2`/`3` switches views as usual. Press **v** to validate only, or a separate **Enter** outside editing to validate and request Run. Invalid inputs and non-ready model status block the request. This opt-in, advisory analysis rechecks readiness and canonical scope/options before execution in the same overlay, with installing fallbacks disabled and embedding caching controlled by the explicit toggle. Returning from results restores the Similar Code view and entered values. The `o` shortcut opens Similar Code inside this same overlay, never a separate dialog.

In **Runtime Coverage**, press **a** to enter a local V8/Istanbul file or directory (absolute, relative to the report's project root, or `~/`). URLs, cloud/UNC sources, control characters, and non-file/non-directory objects are rejected. Enter while editing finishes and previews **without running**; Escape retains the draft. **v** validates/previews the path, resolved location, file/directory type, project source scope, and currently verified sidecar. A separate **Enter** requests Run only after preview and ready sidecar status. The path and cached validation feedback survive view switches and return from results.

Run rechecks artifact path/identity/type/metadata and the signed sidecar both in the form and at the existing executor boundary. Drift, unavailable readiness, cancellation, and timeouts block execution; refresh readiness and preview again before retrying. Requests use argv (not a shell), pin the previewed sidecar only in the child environment, remove coverage cloud-source/API credential overrides, and disable analysis caching with `--no-cache`. There is no capture, upload, or project/configuration mutation. Runtime evidence covers only the selected capture; production representativeness is unknown, and cold code is not proof of safe deletion. Path validation does not certify JSON/capture contents or licenses: Fallow checks format at Run. Directory contents are not recursively snapshotted, so use a completed capture if stable evidence is required. Execution and results stay in the same overlay.

Readiness uses Fallow's read-only model status command with installing `npx` fallbacks disabled. Sidecar discovery checks explicit `FALLOW_COV_BIN` / `FALLOW_COV_BINARY_PATH`, project/ancestor platform packages (including `.pnpm`/`.bun` stores), project `.bin`, `~/.fallow/bin`, `PATH`, then Pi's managed cache. It does not run package managers or scan arbitrary user directories. For Yarn PnP or ambiguous store versions, point an explicit override at the existing signed platform binary. Invalid explicit overrides fail visibly instead of silently selecting another installation.

Sidecar readiness verifies the binary's Ed25519 signature using Fallow 3.22.0's certified signing key and checks adjacent platform-package metadata against 0.4.1. The version is package-declared, not independently attested by a handshake; standalone signed binaries without recognized version metadata remain explicitly unverified, not missing. Readiness does not certify licenses, artifacts, or successful analysis. Inline Runtime Coverage Run supports these verified installations and pins/rechecks the selected binary.

Press **S** (uppercase; lowercase **s** still edits Similar Code scope) in either optional view to prepare an in-overlay setup preview. It discloses source, pinned identity, license, size, destination, exact command, and side effects. Only **y** at that preview confirms installation; Enter, opening Setup, and switching views never confirm. **n** declines. Plans and discovered installations are rechecked after confirmation; changed/incompatible plans are refused, and ready components are not reinstalled.

Setup owns input until it settles: **Esc**, **Backspace**, **q**, or **Ctrl+C** cancels and waits for process cleanup rather than closing or switching views. Progress, a sanitized output tail (last 12,000 characters), failures/cancellation, and the refreshed readiness result stay in the same overlay. Complete install output is saved under the OS temporary directory when available. Afterward **Esc/Backspace/q** returns to the preserved form; normal view/close keys work again. Cancellation can leave partial cache files; nothing is automatically removed or retried. Runtime readiness still verifies the detached Ed25519 signature, not just package metadata. No analysis is started by setup.

During an inline analysis, **Esc/Backspace/b/q/Ctrl+C** requests cancellation and waits for process cleanup. View switching, setup, and additional runs are locked until settlement; no retry or install is automatic. A live elapsed-time indicator continues updating even when the child emits no output, and Similar Code cold-run guidance is shown rather than suppressed. Fresh preflight checks have a 30-second budget. Execution defaults to 15 minutes for Similar Code and 120 seconds for Runtime Coverage; a positive `FALLOW_TIMEOUT_SECS` overrides that budget.

Results use the existing normalized findings navigator, including empty and partial reports. The result header shows wall-clock runtime and, when reported by Similar Code, cache status plus hit/miss and newly written embedding counts. Completion status and advisory limits remain visible. **I** (uppercase) toggles wrapped provenance, diagnostics, complete-output references, and the sanitized output tail; **Page Up/Page Down** scrolls the result viewport. **Esc/Backspace/b** returns to the preserved form; **R** in a form reopens its last result. **r** in results explicitly retries with fresh checks, **1/2/3** switches views, and **q** closes once settled. Each optional view retains its latest result while this overlay remains mounted. Search/action palettes keep input priority. Explicit prompt or navigator actions may still leave the overlay; returning from an action targets the original report, never silently reruns optional analysis. Full reports are saved in the OS temporary directory; no result is automatically sent to the model.

Standalone optional-analysis select/input/confirm chains have been removed. The `o` shortcut stays in the persistent overlay. Bracketed clipboard paste—including fragmented paste—cannot activate view, setup, Run, close, or confirmation shortcuts; inline fields still accept pasted text. RPC, print, JSON, and `fallow_run` remain non-interactive and cannot install optional components.

See [overlay UX validation](https://github.com/revazi/pi-fallow/blob/main/docs/overlay-ux-validation.md) for the deterministic matrix, native Pi TUI PTY probe, and pending human review checklist. These checks do not certify real model inference (#83) or replace user UX approval (#103/#96).

Runtime Coverage setup installs the exact `@fallow-cli/fallow-cov@0.4.1` with scripts disabled into Pi Fallow's user-global managed tools directory, not the project manifest or lockfile. The panel first reads `fallow coverage setup --json` and discloses—but does not execute—the plan's beacon, credential, project-file, or cloud steps. Run accepts only an explicitly selected local V8/Istanbul artifact, previews its resolved path, rechecks sidecar readiness before execution, passes the verified discovered sidecar only to that child analysis process, and removes cloud-source/API credential variables from that child's environment. Continuous/cloud coverage and credentials remain excluded.

### Opt-in similar-code analysis

`/fallow similar-code` and `fallow_run` with `command: "similar-code"` expose Fallow's semantic similar-code workflow explicitly. It is never part of `/fallow`, `/fallow issues`, audits, security checks, or automatic fixes. Raw candidates are unverified advisory leads—not deterministic clone findings or proof that a consolidation is safe. Check `completion.status`, phase skips, diagnostics, model provenance, both source locations, and enrichment availability before drawing conclusions. Only `completion.status: "complete"` makes an empty result conclusive for the admitted scope.

Start with `/fallow similar-code status`, or open the TUI Similar Code view (`2`) and refresh with `r`. This reads no project source and reports the exact companion, pinned model identifier/revision, license, integrity state, download size, cache directory, and readiness. Slash arguments and tools cannot run setup or cache mutation. Only the TUI Setup action may delegate to `fallow similar-code setup --local --yes`, after showing the exact pinned preview and receiving direct user confirmation.

Inference uses Fallow's version-pinned local companion and reports whether source left the machine; the current contract requires local-only source processing. Model vectors live in Fallow's user-local, project-namespaced cache, while saved candidate reports remain independent JSON documents for reproducible inspect/review steps. Cold inference can take minutes and currently requires roughly the download size reported by `similar-code status` (about 310 MiB for Fallow 3.22); warm cached runs should be faster but remain project- and hardware-dependent. Pi Fallow allows up to 15 minutes by default for this explicit command, while cancellation and `FALLOW_TIMEOUT_SECS` or tool `timeoutSecs` overrides remain available.

Use discovery once and preserve its complete JSON report. `similar-code inspect` validates one candidate against that saved report and current source hashes; `similar-code review` joins the unchanged candidates with a separate verdict document. Missing setup, partial/provider failures, stale inspection evidence, verdict-join failures, cancellation, and timeout remain distinct result states. A separate review verdict should abstain whenever source-grounded evidence is incomplete.

Some Fallow surfaces deliberately remain direct CLI features rather than Pi Fallow report commands:

- `fallow type-aware status --format json --quiet` probes companion availability but is not an analysis report.
- `fallow report --from report.json --format sarif` re-renders a saved file instead of analyzing the current project.
- `fallow viz --no-open --viz-format html` writes browser/file output rather than a structured finding report.

Pi Fallow therefore does not add these status/file/browser operations to `fallow_run` or its report navigator.

`/fallow about` shows the installed Pi Fallow version, latest npm version, update command, and project links. Pi Fallow also checks npm once per TUI session and shows a non-blocking warning when a newer version is available. Update an npm installation with `pi update npm:pi-fallow`. Set `PI_FALLOW_DISABLE_UPDATE_NOTICE=1` to disable startup update notices.

### Session run history and comparison

Every completed `/fallow` analysis and trace is added to bounded in-memory session history. `/fallow history` (or `history list`) shows the current project's runs; `/fallow history open r1` reopens an unchanged retained report in the existing navigator; `/fallow history compare r1 r2` treats the first run as prior and the second as current; and `/fallow history clear` removes only the current project's history metadata. History commands never replace `/fallow rerun`, which continues to execute the last analysis command.

History retains at most the 20 most recent completed slash-command results across the Pi session, partitioned by resolved project root. Entries record a bounded command-scope digest, completion timestamp, Fallow/schema versions, report kind, counts, exit/completeness state, complete-report path and digest, and Git `HEAD` when available. Raw reports and overviews are not retained in the history object. There is no cloud storage or cross-session persistence, and run IDs from another root cannot be opened or discovered.

Comparison is deliberately conservative. Both reports must still exist unchanged and have complete results with the same command scope, report kind, schema version, and Fallow version. Stable finding IDs take priority. Otherwise, identity uses type, path, and subject while ignoring line numbers, so ordinary line shifts match; path changes are shown as new plus resolved unless a stable ID proves continuity. Missing identities, duplicate identities, incomplete reports, drifted files, and incompatible versions/scopes are reported as unavailable rather than guessed. New and unchanged findings remain current actionable findings; resolved and unavailable entries are context only and can never be selected as current work.

TUI history opens and comparisons use the existing navigator and action flow. RPC and print modes emit bounded text without opening custom UI; JSON mode emits structured history/open/comparison payloads without opening custom UI. Session restart, the 20-entry bound, explicit `history clear`, or operating-system temporary-file cleanup can expire an entry. Clear and eviction never delete report files.

Saved full reports remain in the operating system's temporary directory. Pi Fallow never deletes them automatically; the operating system's own temporary-file retention policy still applies.

In the interactive navigator:

- `↑↓` or `j/k` — move
- `Enter` / `Space` — expand the selected finding
- `s` — select/unselect
- `A` — select/unselect all findings visible under the active filters
- `/` — search section, label, path, severity, details, and suggested action
- `f` / `v` — cycle section/severity filters
- `x` — clear filters; `c` — clear explicit selections
- `i` — show/hide informational file scores and hotspots; they are hidden by default and never counted as findings
- `d` — toggle full raw finding JSON in the agent prompt; it is deselected by default
- `p` — open the current finding's command-aware action palette
- `e` or `a` — load selected findings into the editor
- `t` — run the first valid trace action for the selected finding
- `q` / `Esc` — close (`Esc` first cancels an active search or closes the action palette)

The action palette derives only shell-free argument arrays supported by the current finding evidence: file/symbol inspection, rule explanation, export/file/dependency/clone tracing, type-aware symbol impact, and architecture-rule lookup. Unknown findings retain only generic actions that have sufficient safe inputs. A fix option appears only when Fallow explicitly marks a retained finding action `auto_fixable: true`, and it always runs project-wide `fix --dry-run --no-create-config`; applying a fix is never available from the palette. Closing or cancelling an action result restores its source navigator state; ordinary live reports are rerun, while history views reopen the exact digest-validated artifact.

The navigator defaults to compact prompts. Compact mode includes every selected finding with type, severity, location, subject, concise evidence/details, and suggested action, plus the complete-report path. Selecting the full-details checkbox additionally embeds complete raw JSON for every selected finding; the overlay warns that this can use substantially more model context.

Plain `fallow health` can return actionable findings alongside informational per-file scores and hotspots. Pi Fallow hides those informational records by default and reports their count separately. Explicit informational commands such as `health --file-scores` and `flags` show their records directly without finding-selection or agent-prompt controls. The overlay stays centered at 90% terminal width, can use up to 95% of terminal height, and expands large virtualized result sets to as many as 30 visible rows.

## Tested compatibility

The current `0.5.x` development line is certified with this host matrix:

| Pi coding agent | Matching Pi AI/TUI packages | Node.js | Fallow |
|---|---|---|---|
| 0.84.4 | 0.84.4 | 22.19 and 24 | 3.22.0 |

Certification installs the generated Pi Fallow tarball in isolation and uses the exact Pi version and manifest-declared CLI entrypoint locked by this repository. It verifies offline extension loading, `/fallow` discovery, the default aggregate plus explicit `/fallow health` and session history over RPC, default `/fallow` in print and JSON modes, empty Pi stderr, and the absence of extension/provider-turn errors. Package checks run on both supported Node lines.

This matrix records tested compatibility; it is not an installation constraint or a claim about untested Pi versions. Pi packages intentionally remain host-provided wildcard peer dependencies, following Pi's package guidance. Other Pi versions may work, but are not certified until they pass the same package smoke checks.

## Requirements

- Node.js 22.19+
- Pi coding agent
- Fallow 3.22.0 is the validated development/compatibility target; runtime resolution remains tolerant of separately installed versions.
- Fallow available through one of:
  - `FALLOW_BIN=/path/to/fallow`
  - `fallow` on `PATH`
  - a package-local Fallow installation
  - `npx -y fallow` fallback

Runner resolution is refreshed when `FALLOW_BIN` or `PATH` changes. The npx fallback locates the installed package once and invokes its executable directly for later commands. If an automatically resolved executable disappears, Pi Fallow invalidates it and retries the next route once. An invalid explicit `FALLOW_BIN`, cancellation, timeout, or a command that already started never falls through to another installation.

The Pi package declares Pi libraries as wildcard peer dependencies, as recommended for Pi extensions; see the tested matrix above for the currently certified host version.

## Package manifest

`package.json` exposes the extension through the Pi package manifest:

```json
{
  "keywords": ["pi-package", "pi-extension"],
  "pi": {
    "extensions": ["./extensions/index.ts"],
    "image": "https://raw.githubusercontent.com/revazi/pi-fallow/main/pi-fallow.png"
  }
}
```

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines and [SECURITY.md](./SECURITY.md) for vulnerability reporting.

Useful checks:

```bash
npm run check:bundle
npm run health
npm run dupes
npm run coverage
npm run audit:production
npm run audit:all
npm run package:smoke
npm run pack:check
npm run bench:tokens -- --label candidate --output /tmp/pi-fallow-token-candidate.json
npm run bench:tokens:compare -- benchmarks/baselines/v0.2.0.json /tmp/pi-fallow-token-candidate.json
npm run bench:performance -- --label candidate --output /tmp/pi-fallow-performance-candidate.json
npm run bench:performance:compare -- benchmarks/baselines/performance-v0.2.0.json /tmp/pi-fallow-performance-candidate.json
```

See the [token benchmark documentation](https://github.com/revazi/pi-fallow/blob/main/benchmarks/README.md) and [performance benchmark documentation](https://github.com/revazi/pi-fallow/blob/main/benchmarks/PERFORMANCE.md) for the frozen before states and comparison methodology.

This repo includes `.fallowrc.json` so Fallow knows the Pi entrypoint is `extensions/index.ts` and treats TUI component callbacks such as `handleInput` and `invalidate` as framework-used.

## License

MIT © Revaz Zakalashvili
