# Pi Fallow roadmap

This roadmap describes the current baseline and likely next work. It is planning documentation, not a changelog, release promise, or authorization to publish.

## Release status and boundaries

- **Current boundary:** `0.5.1` refreshes the certified Pi, Fallow, TypeBox, and CodeQL tooling on top of the issue-focused `0.5.0` release, as recorded in the [`0.5.1` changelog](./CHANGELOG.md#051---2026-08-29).
- **Release records:** the npm registry and GitHub releases are authoritative for whether a version has completed publication; a version in source remains a candidate until the protected tag workflow succeeds.
- **Publication gate:** every boundary remains blocked until all release gates pass, an independent release-readiness review is recorded, and a maintainer gives explicit authorization.
- **Later work:** the priorities below are directional and carry no date or version commitment.

## Measured current baseline

Unless noted otherwise, these are repository-specific measurements from the `0.5.0` release candidate, not universal expectations for other machines, hosts, Fallow installations, or providers.

- **Tests and coverage:** 419 tests; current coverage is **91.94% statements/lines**, **87.37% branches**, and **91.16% functions**. The `0.5.0` release-candidate snapshot recorded **88.50% statements/lines**, **86.35% branches**, and **85.44% functions**; subprocess-sensitive reruns can vary slightly by run and Node line while CI continues to enforce the coverage thresholds.
- **Fallow quality:** Fallow 3.22 reports health **83.9 (B)**, average maintainability **90.3**, and zero threshold findings, dead-code issues, or clone groups.
- **Dependency audits:** strict production and complete-tree npm audits report zero vulnerabilities. These audit results are separate from Fallow's modeled security-candidate analysis.
- **Host compatibility:** packaged, provider-free Pi **0.84.4** behavior is certified on Node **22.19** and **24**. Pi host libraries intentionally remain external wildcard peers; this is a tested compatibility matrix, not a restrictive peer range or provider-backed/PTY/tmux certification. See the [README compatibility section](./README.md#tested-compatibility).
- **Token baseline:** the current `fallow_run` tool contract is **421 tokens under both pinned tokenizers**. Across the frozen corpus, bounded tool results total **8,036 `o200k_base` / 7,925 `cl100k_base` tokens**. The output-detail work leaves the benchmarked slash-command and editor-prompt surfaces unchanged and reduces aggregate `o200k_base` tool-result tokens by **82.16%** from the immediate pre-output-detail baseline. These are deterministic corpus measurements, not provider billing claims; see [`benchmarks/README.md`](./benchmarks/README.md).
- **Retained memory:** current steady-state retained-heap evidence is approximately **1.80×** fixture size for the default large report, **1.70×** for normalized findings, and **0.66×** for schema output. A dedicated warmed-process regression check requires released large-report history metadata to remain below **0.50×** fixture size. Heap measurements are machine-, process-, and Node-sensitive; methodology and the historical baseline are in [`benchmarks/PERFORMANCE.md`](./benchmarks/PERFORMANCE.md).

## Foundations now in place

The long measurement history belongs in the benchmark documentation rather than this roadmap. Current foundations are:

- deterministic token and performance baselines, pinned tokenizers, fixture hashes, retention checks, coverage thresholds, packaging checks, and strict audits;
- cancellation and process-tree lifecycle handling, including timeout escalation, plus TUI, RPC, print, and JSON mode paths;
- asynchronous cached Git completion/base detection and cached, invalidation-aware Fallow runner resolution;
- bounded summary/findings/raw model output with readable complete-output references whenever data is omitted;
- compact-by-default and explicit full-detail prompts, all-finding navigation, search/filter/multi-selection, responsive navigator scaling, and command-aware read-only action palettes with stateful return;
- package-boundary certification against Pi 0.84.4 and Fallow 3.22 on the tested Node lines;
- measured model guidance for deletion evidence, fix previews, advisory type-aware results, and routine bounded detail;
- a typed command registry shared by tool, slash, autocomplete, and smoke-test surfaces, including architecture-to-`guard` support;
- explicit, read-only `/fallow compatibility` diagnostics over the installed capability manifest, with bounded additive guidance, affected-command incompatibilities, frozen drift mutations, and no startup probe or runtime gate;
- a bounded `/fallow config-assist` workflow for read-only ownership/count inspection and schema-checked rule-severity previews, with TUI-only confirmation, drift refusal, exact backups, atomic project-local writes, inherited-config isolation, and no secret-bearing resolved values in transcripts;
- authoritative normalized-report selection shared across output and prompts, with complete-report hydration and drift protection;
- bounded, project-isolated session history with digest-validated report reopening and conservative compatible-run comparison;
- explicit opt-in semantic similar-code status, discovery, inspect, and review flows with local-model provenance and advisory completion, plus TUI-only previewed and confirmed model setup and reproducible, no-cache model-backed certification over a frozen tiny project;
- visible Optional Analysis Status / Setup / Run controls for Similar Code and selected local runtime-coverage artifacts, with verified user-global sidecars and no project or cloud mutation; and
- an issue-focused default that combines actionable dead-code, duplication, health, and security candidates without flooding the navigator with informational file scores or hotspots.

See [`benchmarks/README.md`](./benchmarks/README.md), [`benchmarks/PERFORMANCE.md`](./benchmarks/PERFORMANCE.md), [`CHANGELOG.md`](./CHANGELOG.md), and the [README compatibility section](./README.md#tested-compatibility) for authoritative detail.

## Remaining priorities

1. **Keep command and report compatibility honest.** Frozen capability-schema, installed-capability diagnostics, and live registry-prefix checks cover managed output, positional targets, selected type-aware flags, issue registries, and bounded additive/removal guidance (see [`fixture scope`](./tests/fixtures/fallow/README.md)). Real dead-code, duplication, health, security, combined, unavailable/partial type-aware, signed runtime-coverage, and complete model-backed Similar Code discovery/inspect/review evidence supplement those checks. Continue refreshing this evidence deliberately as Fallow evolves while preserving graceful behavior with separately installed versions.
2. **Refine navigator workflows from evidence.** Make any remaining history, comparison, or UI density improvements only when real large-report use identifies a concrete need.
3. **Improve quality where evidence points.** Raise coverage and maintainability gradually around real execution, command-flow, rendering, project-state, configuration assistance, and PR-summary hotspots. Do not split files cosmetically merely to improve a metric.
4. **Maintain compatibility and supply-chain gates.** Keep Pi, Fallow, Node, and dependency compatibility current with strict production/complete-tree audits and repeatable package-boundary certification.

## Invariants

Future work must preserve these boundaries:

- Never bundle Pi host packages. Keep them host-provided, external wildcard peers; a tested host matrix must not become an unnecessarily restrictive peer range.
- Preserve `/fallow`, direct/raw slash access, the TUI navigator, and RPC, print, and JSON behavior.
- Retain readable complete output whenever bounded model output or normalized navigator data omits report data.
- Token reductions must not sacrifice actionable fields, finding-retention accounting, completeness/advisory state, or other quality metadata.
- Do not create tags, publish packages, or declare releases without completed gates, independent review, and explicit authorization.

## Suggested delivery order

1. Iterate on navigator density and project-issues performance evidence where measured use identifies a concrete problem.
2. Improve hotspot coverage, maintainability, and dependency compatibility in small independently reviewed changes.
