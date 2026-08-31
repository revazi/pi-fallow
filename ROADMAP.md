# Pi Fallow roadmap

This roadmap describes the current baseline and likely next work. It is planning documentation, not a changelog, release promise, or authorization to publish.

## Release status and boundaries

- **Current boundary:** `0.5.1` refreshes the certified Pi, Fallow, TypeBox, and CodeQL tooling on top of the issue-focused `0.5.0` release, as recorded in the [`0.5.1` changelog](./CHANGELOG.md#051---2026-08-29).
- **Release records:** the npm registry and GitHub releases are authoritative for whether a version has completed publication; a version in source remains a candidate until the protected tag workflow succeeds.
- **Publication gate:** every boundary remains blocked until all release gates pass, an independent release-readiness review is recorded, and a maintainer gives explicit authorization.
- **Later work:** the priorities below are directional and carry no date or version commitment.

## Measured current baseline

Unless noted otherwise, these are repository-specific measurements from the `0.5.0` release candidate, not universal expectations for other machines, hosts, Fallow installations, or providers.

- **Tests and coverage:** 169 tests. The `0.5.0` release-candidate snapshot recorded **88.50% statements/lines**, **86.35% branches**, and **85.44% functions**; current subprocess-sensitive reruns can vary slightly by run and Node line while CI continues to enforce the coverage thresholds.
- **Fallow quality:** Fallow 3.21 reports health **85.0 (A)**, average maintainability **91.9**, and zero threshold findings, dead-code issues, or clone groups.
- **Dependency audits:** strict production and complete-tree npm audits report zero vulnerabilities. These audit results are separate from Fallow's modeled security-candidate analysis.
- **Host compatibility:** packaged, provider-free Pi **0.84.3** behavior is certified on Node **22.19** and **24**. Pi host libraries intentionally remain external wildcard peers; this is a tested compatibility matrix, not a restrictive peer range or provider-backed/PTY/tmux certification. See the [README compatibility section](./README.md#tested-compatibility).
- **Token baseline:** the current `fallow_run` tool contract is **439 tokens under both pinned tokenizers**. Across the frozen corpus, bounded tool results total **8,046 `o200k_base` / 7,935 `cl100k_base` tokens**. The output-detail work leaves the benchmarked slash-command and editor-prompt surfaces unchanged and reduces aggregate `o200k_base` tool-result tokens by **82.16%** from the immediate pre-output-detail baseline. These are deterministic corpus measurements, not provider billing claims; see [`benchmarks/README.md`](./benchmarks/README.md).
- **Retained memory:** current steady-state retained-heap evidence is approximately **1.80×** fixture size for the default large report, **1.70×** for normalized findings, and **0.66×** for schema output. Heap measurements are machine-, process-, and Node-sensitive; methodology and the historical baseline are in [`benchmarks/PERFORMANCE.md`](./benchmarks/PERFORMANCE.md).

## Foundations now in place

The long measurement history belongs in the benchmark documentation rather than this roadmap. Current foundations are:

- deterministic token and performance baselines, pinned tokenizers, fixture hashes, retention checks, coverage thresholds, packaging checks, and strict audits;
- cancellation and process-tree lifecycle handling, including timeout escalation, plus TUI, RPC, print, and JSON mode paths;
- asynchronous cached Git completion/base detection and cached, invalidation-aware Fallow runner resolution;
- bounded summary/findings/raw model output with readable complete-output references whenever data is omitted;
- compact-by-default and explicit full-detail prompts, all-finding navigation, search/filter/multi-selection, and responsive navigator scaling;
- package-boundary certification against Pi 0.84.3 and Fallow 3.21 on the tested Node lines;
- measured model guidance for deletion evidence, fix previews, advisory type-aware results, and routine bounded detail;
- a typed command registry shared by tool, slash, autocomplete, and smoke-test surfaces, including architecture-to-`guard` support;
- authoritative normalized-report selection shared across output and prompts, with complete-report hydration and drift protection; and
- an issue-focused default that combines actionable dead-code, duplication, health, and security candidates without flooding the navigator with informational file scores or hotspots.

See [`benchmarks/README.md`](./benchmarks/README.md), [`benchmarks/PERFORMANCE.md`](./benchmarks/PERFORMANCE.md), [`CHANGELOG.md`](./CHANGELOG.md), and the [README compatibility section](./README.md#tested-compatibility) for authoritative detail.

## Remaining priorities

1. **Keep command and report compatibility honest.** Expand representative command/schema fixtures and add useful command-registry-versus-`fallow schema` drift checks while preserving graceful behavior with separately installed Fallow versions.
2. **Decide whether user-owned customization is still desired.** If demand remains, design Pi Fallow-specific global/project configuration, prompt templates, and a safe prompt/config preview without taking ownership of Fallow's configuration file.
3. **Complete navigator workflows.** Add command-aware actions and trace/report history, then make any remaining UI density improvements based on real large-report use rather than decorative churn.
4. **Improve quality where evidence points.** Raise coverage and maintainability gradually around real execution, command-flow, rendering, project-state, and PR-summary hotspots. Do not split files cosmetically merely to improve a metric.
5. **Maintain compatibility and supply-chain gates.** Keep Pi, Fallow, Node, and dependency compatibility current with strict production/complete-tree audits and repeatable package-boundary certification.

## Invariants

Future work must preserve these boundaries:

- Never bundle Pi host packages. Keep them host-provided, external wildcard peers; a tested host matrix must not become an unnecessarily restrictive peer range.
- Preserve `/fallow`, direct/raw slash access, the TUI navigator, and RPC, print, and JSON behavior.
- Retain readable complete output whenever bounded model output or normalized navigator data omits report data.
- Token reductions must not sacrifice actionable fields, finding-retention accounting, completeness/advisory state, or other quality metadata.
- Do not create tags, publish packages, or declare releases without completed gates, independent review, and explicit authorization.

## Suggested delivery order

1. Add fixture/schema compatibility and registry-drift checks needed to keep release evidence reproducible.
2. Confirm demand and scope before implementing user-owned configuration or prompt customization/preview.
3. Iterate on command-aware navigator history/actions, hotspot coverage, maintainability, and dependency compatibility in small independently reviewed changes.
