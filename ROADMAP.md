# Pi Fallow optimization roadmap

This roadmap prioritizes reliability and measurable user-facing improvements over refactoring for its own sake. It is a planning document, not a release commitment.

## Current baseline

Measured on the current `0.2.0` checkout:

- 30 tests pass.
- Reported coverage for loaded source files is 58.71% lines, 80.19% branches, and 67.58% functions. Unloaded production modules are not currently included, so true repository coverage is lower.
- Fallow health score is 88.4 (A), average maintainability is 90.5, and there are no complexity-threshold, duplication, circular-dependency, or dead-export findings.
- The remaining dead-code report is a test-classification finding for `jiti`, which is used by tests and should not be moved into runtime dependencies without another reason.
- The frozen Apple M1 Pro performance baseline measures the same Fallow 3.6.0 installation at 124.72 ms warm median when invoked directly and 819.42 ms through cached npx fallback. Git ref autocomplete blocks for a 12.88 ms cold median, base detection takes 34.46 ms warm median through three Git processes, and large/schema reports retain roughly 2.43–2.45× their fixture size on the heap. These values are machine-specific and must be compared in a matching environment.
- `fallow schema` currently produces roughly 180 KB of JSON, demonstrating why output and prompt budgets need to be independent of Fallow's report size.
- The frozen canonical `fallow_run` contract contains 9,820 characters and 2,237 `o200k_base` tokens before provider-specific serialization. This is a fixed context cost whenever the tool is active and must be included in token optimization work.

## Goals

1. Keep the editor and navigator responsive; never block typing on subprocess work.
2. Make cancellation, timeouts, and non-TUI modes reliable.
3. Keep normal Fallow feedback concise while preserving access to complete output.
4. Let users customize the prompt generated from selected findings.
5. Make the navigator useful for reviewing larger reports, not only the first few findings.
6. Raise meaningful production coverage to at least 80%, with higher coverage for execution, parsing, prompt, and configuration code.
7. Measure wall time, extension overhead, memory, and context size so future changes cannot silently regress them.
8. Report token savings together with retained finding quality so reducing output to an unhelpful summary cannot count as an optimization.

## Phase 0 — Establish token baselines before changing output

Token measurement must land before token-oriented refactors. Otherwise the project will only have estimates reconstructed after behavior has changed.

### Measure Pi Fallow's contribution, not an entire conversation

Record the extension-controlled text at four boundaries:

1. **Fixed tool contract:** serialized `fallow_run` schema, description, snippet, and prompt guidelines. This is paid in context on model calls where the tool is active, even when Fallow is not run.
2. **Tool result content:** text returned by `fallow_run` to the next model call.
3. **Slash-command transcript content:** model-visible custom-message content added by `/fallow`.
4. **Generated navigator prompt:** text loaded into the editor from selected findings.

Also record the full raw Fallow report as a reference, but do not treat TUI-only details or temp-file contents as model tokens.

Report two forms of cost separately:

- **Context occupancy:** tokens taking space in the model's context window.
- **Provider billing:** uncached input, cache-write, and cache-read tokens from an optional real-provider replay. Prompt caching may reduce cost but does not reduce context occupancy.

### Use a frozen fixture corpus

Check representative, sanitized reports into `benchmarks/fixtures/`:

- no findings
- one finding
- small report (5 findings)
- medium report (25–50 findings)
- large report (hundreds of findings)
- health report with file scores/hotspots/targets
- audit/PR report
- duplication report with several instances per clone
- inspect/trace report
- security and decision-surface reports
- large schema/config output
- long paths, long evidence, Unicode text, and malformed/noisy output

For generated prompts, measure selections of 1, 5, 20, and all available findings, both with and without raw finding data.

Fixtures must be immutable within a benchmark version. Store a corpus hash in every result so numbers from different fixture sets cannot be compared accidentally.

### Metrics to record

For every surface and scenario, record:

- UTF-8 bytes, characters, and lines
- exact tokens for one or more pinned tokenizer encodings
- clearly labelled model-neutral estimate when no exact tokenizer exists
- fixed overhead tokens and tokens per included finding
- total/included/omitted finding counts
- required-field retention for type, path, line, severity, evidence, and action
- whether a full-output path is present when findings/data are omitted
- configured budget and budget overrun

Aggregate with totals, median, p95, and maximum. Do not report only an average, because a single large Fallow result can cause the context problem being optimized.

Useful derived metrics:

- `token_reduction_pct = (before_tokens - after_tokens) / before_tokens`
- `compression_ratio = output_tokens / raw_report_tokens`
- `findings_per_1k_tokens = included_findings / output_tokens * 1000`
- `required_field_retention_pct`
- `next_turn_context_tax = tool_contract_tokens + result_or_message_tokens`
- `cumulative_context_exposure`, which counts a persisted result again for every subsequent model request where it remains in context

A candidate only improves token efficiency when token counts fall without violating the finding-retention and full-output-path checks.

### Deterministic benchmark artifacts

Add commands along these lines:

```text
npm run bench:tokens -- --label v0.2.0 --output benchmarks/baselines/v0.2.0.json
npm run bench:tokens -- --label candidate --output /tmp/pi-fallow-token-candidate.json
npm run bench:tokens:compare -- benchmarks/baselines/v0.2.0.json /tmp/pi-fallow-token-candidate.json
```

Each artifact should include:

- benchmark schema version
- corpus hash
- tokenizer package/encoding/version
- Node version and platform
- Pi Fallow version and Git SHA
- per-scenario metrics and aggregate metrics

Commit the `0.2.0` baseline before changing output generation. If the benchmark, tokenizer, or fixtures change, bump the benchmark version and regenerate both sides from their Git refs; never compare incompatible artifacts.

The comparison output should include a table such as:

```text
surface          scenario       before   after   reduction   findings kept   fields kept
contract         active tool      ...      ...       ...          n/a            n/a
tool result      medium audit     ...      ...       ...         30/30          100%
slash transcript schema           ...      ...       ...          n/a            n/a
editor prompt    20 selected      ...      ...       ...         20/20          100%
```

### Optional end-to-end validation

Offline tokenization is the stable CI metric. Before releases, optionally replay identical scripted sessions against selected real providers and capture reported input, cache-read, and cache-write usage. Use a fresh session and identical prompts, and report provider/model/date because provider serialization and token accounting can change.

Translate measured deltas into context percentage and estimated cost for 1, 10, and 100 Fallow-assisted turns, but keep those projections separate from deterministic token counts.

Acceptance criteria:

- A committed `0.2.0` baseline exists before digest/prompt changes.
- CI rejects incompatible benchmark/corpus/tokenizer versions.
- CI reports before/after tokens for all four extension-controlled surfaces.
- CI fails if required-field retention drops, omitted data lacks a full-output path, or a hard token budget is exceeded.
- Token regressions over an agreed tolerance require an explicit baseline update and explanation.

## Phase 1 — Correctness and performance foundations

### 1. Use Pi's execution API and the tool's abort signal

Replace the custom child-process lifecycle with `pi.exec()` where possible. Pass the `signal` received by `fallow_run.execute()` through the complete execution path rather than relying on `ctx.signal`.

The current process escalation checks `proc.killed` before sending `SIGKILL`; Node sets that flag when a signal is sent, not when the process has exited. A process that ignores `SIGTERM` can therefore avoid escalation. It is also safer to delegate process-tree termination for the `npx` wrapper to Pi.

Acceptance criteria:

- Escape/tool cancellation stops Fallow and any wrapper child process.
- Timeout tests cover a process that ignores `SIGTERM`.
- Exit code 1 remains a findings result; exit code 2+ remains an execution error.
- Cancellation is tested for both the tool and slash-command paths.

### 2. Respect Pi run modes

Use `ctx.mode === "tui"` for `BorderedLoader`, overlays, and terminal input. Keep `ctx.hasUI` for notifications that also work in RPC mode.

Acceptance criteria:

- `/fallow` executes in TUI, RPC, JSON, and print modes.
- RPC mode does not return a false “cancelled” result because `ctx.ui.custom()` is unavailable.
- Navigator tests continue to enforce terminal-width limits.

### 3. Remove synchronous Git work from completion

`autocomplete.ts` currently calls `execFileSync()` from a completion value provider, with a timeout of 1.2 seconds and a three-second cache. Preload refs asynchronously on `session_start`, keyed by `ctx.cwd`, and return static/cached values immediately while refresh is in flight.

Also detect a base ref only for `/fallow pr` when the user did not supply `--base`. Other commands do not need the current multi-process Git probe. Cache the resolved base per project/session.

Acceptance criteria:

- No synchronous subprocess calls are reachable from editor completion.
- `/fallow dead-code`, `health`, `dupes`, and `rerun` perform no base-ref Git lookup.
- Completion uses `ctx.cwd`, not `process.cwd()`.
- Cold completion immediately returns static refs and later includes asynchronously discovered refs.

### 4. Add a benchmark harness

Add a small reproducible benchmark using fixture executors so results do not depend on network access.

Track:

- cold and warm runner overhead
- wall time minus Fallow's reported `elapsed_ms`
- autocomplete response latency
- peak memory for a large synthetic JSON report
- generated agent-output and prompt character counts

Initial budgets:

- no synchronous completion operation over 5 ms
- warm extension overhead under 100 ms, excluding Fallow analysis
- cancellation settles within six seconds even when graceful termination fails
- no more than two full-size in-memory copies of a large report after parsing

## Phase 2 — Faster execution and lower memory use

### 5. Resolve and cache the Fallow runner

Keep the lookup order explicit and cache the successful result for the session:

1. `FALLOW_BIN`
2. `fallow` on `PATH`
3. an optional/package-local Fallow installation, if the packaging trade-off is accepted
4. `npx -y fallow`

Do not retry a known-missing `fallow` binary before every command. Invalidate the cached choice if execution reports that the chosen binary disappeared.

Before adding Fallow as an optional dependency, compare install size, platform behavior, update policy, and startup performance. A bundled compatible version is faster and reproducible; PATH/npx keeps Fallow independently updateable.

### 6. Return a slim engine result

The command flow currently retains the full `ExecResult`, parsed object/raw text, pretty JSON, formatted output, and final content together. Most callers only need `code`, `killed`, overview data, and the bounded agent/UI output.

Refactor the engine to:

- consume stdout/stderr during parsing
- retain only execution metadata after formatting
- remove `parsed` from the returned command result
- avoid retaining full stdout/stderr while the navigator is open
- avoid pretty-printing an entire report only to truncate it
- run independent project-state/output work concurrently

Replace embedded-JSON trial parsing with a single balanced scanner that understands JSON strings. The fallback currently may retry `JSON.parse()` from many brace positions.

Acceptance criteria:

- A large-output test records bounded retained memory.
- No full stdout/stderr is stored in navigator state.
- Noisy, nested, and string-escaped JSON fixtures parse in linear time.
- Full raw output remains available whenever the bounded output omits data.

### 7. Manage temporary output lifecycle

Track temp files created by the extension and remove them on `session_shutdown`, with a conservative age-based cleanup for files left by crashed sessions. Keep files alive for the full session so the agent can still read them.

## Phase 3 — Token-budgeted agent feedback

### 8. Separate rich UI data from agent context

Create two explicit representations:

- **UI report:** rich overview, selection metadata, report path, and rendering state; not automatically sent in full to the model.
- **Agent digest:** normalized, bounded findings intended for model context.

A default digest should contain:

- command, verdict/exit status, and elapsed time
- important summary counts
- normalized findings with type, severity, path, line, evidence, and suggested action
- omitted finding/byte counts
- full-output path and rerun command when anything was omitted

Do not send `summary + pretty-printed raw JSON` by default. Add an explicit detail control for callers that need raw output, for example `outputDetail: "summary" | "findings" | "raw"`, while keeping a safe character ceiling in every mode.

For slash commands, persist a compact summary in model-visible history. Rich decorative/navigation data can use a TUI-only custom entry. Selected findings become model-visible when the user loads/submits the generated prompt.

Acceptance criteria:

- Common fixture outputs use at least 60% fewer exact benchmark tokens than the `0.2.0` baseline; bytes and characters are reported alongside tokens.
- Every included finding preserves location, evidence, and action.
- Omitted data always has a readable full-output path.
- Project cache/config details are UI metadata unless they indicate a problem.
- Prompt and tool outputs have separate configurable budgets.

### 9. Normalize findings once

Introduce a typed internal `NormalizedFallowReport`/`NormalizedFinding` adapter. Build summaries, PR data, navigator rows, trace actions, and agent digests from it instead of traversing loosely typed JSON several times.

Keep a graceful unknown-schema fallback. Record the Fallow `schema_version` in details and test supported fixture versions.

## Phase 4 — User-configurable prompts

### 10. Add Pi Fallow configuration

Do not overload `.fallowrc`, which belongs to Fallow itself. Use:

- global: `${getAgentDir()}/pi-fallow.json`
- project: `${ctx.cwd}/${CONFIG_DIR_NAME}/pi-fallow.json`
- optional override: `PI_FALLOW_CONFIG`

Precedence should be defaults < global < trusted project < explicit environment override. Project configuration must only be loaded when `ctx.isProjectTrusted()` is true.

Proposed initial shape:

```json
{
  "$schema": "https://raw.githubusercontent.com/revazi/pi-fallow/main/schema.json",
  "prompt": {
    "templateFile": "PI_FALLOW_PROMPT.md",
    "includeRaw": "never",
    "maxChars": 20000
  },
  "agentOutput": {
    "detail": "findings",
    "maxFindings": 20,
    "maxChars": 24000
  },
  "ui": {
    "openNavigator": "findings-only",
    "visibleRows": 10
  }
}
```

Support an inline template later if there is demand; a Markdown file is easier to edit. Resolve `templateFile` relative to the config containing it.

Suggested placeholders:

- `{{findings}}`
- `{{findingCount}}`
- `{{command}}`
- `{{rerunCommand}}`
- `{{cwd}}`
- `{{fullOutputPath}}`
- `{{userInstructions}}`

Require `{{findings}}`, or safely append the findings block, so a malformed template cannot silently discard the selected work. Validate sizes and unknown keys; configuration errors should notify and fall back rather than break startup.

Add commands such as:

- `/fallow prompt show`
- `/fallow prompt preview`
- `/fallow config-reload`

`prompt preview` should show the resolved config source, exact generated prompt, included/omitted findings, and estimated token count without submitting anything.

### 11. Make prompt generation a pure module

Extract the hardcoded navigator prompt into a pure, independently tested prompt builder. Use normalized findings and a global budget rather than a fixed 3,000-character allowance for every selected raw finding.

Default to normalized evidence instead of raw JSON. Allow `includeRaw: "never" | "when-needed" | "always"`, but always enforce `maxChars`.

## Phase 5 — Navigator and UI improvements

### 12. Improve information density first

- Do not open an empty navigator when there are no actionable rows.
- Move the permanent contribution URL, command, config, and cache details into an `i` information panel.
- Use `?` for full help and keep the normal help line short.
- Show selected count, visible/total findings, active filters, and omitted findings in the header/footer.
- Make visible row count responsive to available terminal height.
- Show wrapped evidence and action details, not only the first action string.

### 13. Support larger reports

- Keep more than the current first 5–8 items per section, with an overall safety cap.
- Add search by label/path/type.
- Add severity/type filters and sort by severity, path, or report order.
- Add select all visible, select section, and clear selection.
- Preserve selection/filter state when opening details.
- Add a prompt-budget indicator before loading selected findings.

The list should remain virtualized: only visible rows and an expanded row need rendering.

### 14. Make actions command-aware

The current `t` action generally maps to `dead-code --trace-file`. Derive actions from normalized finding type:

- unused export → dead-code export trace
- dead file → file trace
- clone → duplication trace at file/line
- symbol/call-chain item → symbol trace
- security/decision item → inspect the relevant file/symbol

Maintain a small navigator history so closing a trace can return to the original report and selection.

Potential later actions:

- `p` preview generated prompt
- `e` load prompt into editor
- `r` rerun current report
- `o` load a focused inspect request for the selected location

## Phase 6 — Coverage, CI, and maintainability

### 15. Measure all production files

Configure Node coverage with `--test-coverage-include=extensions/**/*.ts` so unimported modules count as uncovered. Add thresholds gradually:

- first milestone: 75% lines/functions overall
- second milestone: 80% overall
- critical modules: 90% branches for runner, engine, config, prompt builder, and output budgeting

Current priority gaps include `engine.ts`, CLI execution/fallback, PR-summary adapters, project state, update checks, and command mode flows.

### 16. Add focused test layers

1. **Pure unit tests:** argument registry, normalized report adapters, digest budgeting, prompt templates, config precedence, and trace-action mapping.
2. **Executor tests:** fake Pi executor plus small fixture processes for timeout, cancellation, fallback, and exit codes.
3. **Mode-flow tests:** TUI, RPC, JSON, and print contexts.
4. **UI tests:** narrow/wide widths, responsive rows, search/filter/selection, prompt preview, and command-aware trace.
5. **Fixture compatibility tests:** representative JSON for every supported Fallow command and schema version.
6. **Property/fuzz tests:** quoted argument splitting and noisy embedded JSON parsing.

### 17. Make development checks reproducible

- Pin Fallow and esbuild development versions instead of relying on unpinned `npx -y` in CI.
- Test the declared minimum Node.js version as well as the current Node release.
- Add coverage thresholds only after all production files are included.
- Classify `jiti` as test-only in Fallow configuration rather than moving it to production dependencies.
- Consider generating a static command capability manifest from `fallow schema` at development/release time.

## Phase 7 — Reduce command-surface drift

Command names and flags are currently represented in the tool schema, CLI builders, autocomplete tables, smoke tests, and documentation. Create one typed command registry for aliases, positional arguments, flags, enum values, descriptions, and trace behavior.

Use the registry to generate:

- tool argument builders
- slash completions
- help/argument hints
- smoke-test cases
- supported-command documentation

A release-time comparison against `fallow schema` should fail with a useful diff when Fallow adds, removes, or changes a capability. Runtime behavior should still degrade gracefully when a user's installed Fallow version differs.

## Suggested delivery order

1. **Baseline tooling:** freeze the token fixture corpus, pin tokenizers, and commit the `0.2.0` benchmark artifact before output changes.
2. **Patch release:** Pi mode guards, actual abort signal, process lifecycle, lazy Git lookup, and regression tests.
3. **Performance release:** cached runner resolution, async ref preload, slim engine result, temp cleanup, and benchmark budgets.
4. **Token/config release:** normalized reports, bounded agent digest, Pi Fallow config, custom prompt files, and prompt preview.
5. **UI release:** compact navigator, all-findings/search/filter support, responsive height, command-aware actions, and trace history.
6. **Hardening release:** 80% all-file coverage, schema fixture suite, generated command registry, pinned CI tooling, and Node version matrix.

Coverage and benchmarks should improve in every phase rather than being deferred entirely to the final release.

## Recommended first issues

1. Add the frozen token corpus, benchmark/compare scripts, and committed `0.2.0` baseline.
2. Guard custom UI with `ctx.mode === "tui"` and add RPC/print tests.
3. Route execution through `pi.exec()` and test timeout/cancellation.
4. Make base-ref detection lazy; asynchronously preload completion refs.
5. Add all-file coverage reporting and establish the real baseline.
6. Define `NormalizedFallowReport` and a token-budgeted agent digest.
7. Add config loading and the pure prompt-template builder.
8. Add `/fallow prompt preview` with exact token and retention reporting.
9. Compact the navigator; add search/filter/select-all and command-aware traces.
10. Consolidate command metadata and compare it with `fallow schema` in CI.
