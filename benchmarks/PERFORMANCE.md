# Performance benchmarks

These benchmarks track Pi Fallow's execution, aggregation, and memory behavior before and after measured optimizations.

## The six measured areas

1. **Runner performance** — configured binary, PATH resolution, deterministic fallback, direct real Fallow, and real npx fallback.
2. **Extension processing** — engine parsing, summaries, overview construction, truncation, temp output using frozen reports, and adversarial noisy embedded-JSON extraction.
3. **Project-issues aggregation** — end-to-end combined/security execution, child contention, normalization-to-navigator readiness, process concurrency, and descendant RSS on generated small and large projects.
4. **Git and autocomplete** — cold/warm ref completion, event-loop blocking, base detection, and subprocess counts.
5. **Memory** — retained heap, released heap, RSS, external memory, and fixture-size amplification in isolated workers.
6. **Cold versus warm execution** — first invocation plus warm median, p95, maximum, mean, and parent-process CPU measurements.

The general performance run uses three warmups and 15 measured iterations. Real Fallow runner routes use one warmup and five iterations to keep the benchmark practical. Memory scenarios run in three isolated `node --expose-gc` workers. The focused project-issues run uses one warmup and five iterations for each schedule/project-size pair.

## Baseline environment

The committed `performance-v0.2.0.json` result was measured with:

- Apple M1 Pro, 10 logical CPUs, 16 GB RAM
- macOS arm64
- Node.js 24.12.0
- Fallow 3.7.0
- Pi Fallow runtime before execution optimizations

Timing comparisons are machine-sensitive. Compare on the same machine, Node version, power state, and Fallow version. The comparison command warns when recorded environments differ. Retained-memory measurements are generally more stable but should still be compared on the same Node version.

## Before findings

### Runner

| Route | Cold | Warm median | Warm p95 |
|---|---:|---:|---:|
| Direct real Fallow executable | 861.82 ms | 111.23 ms | 115.66 ms |
| Current system resolution through npx | 811.56 ms | 804.50 ms | 813.15 ms |

On this machine, cached npx fallback is **7.23× slower** than invoking the same Fallow installation directly and adds approximately **693 ms** per warm invocation. Cold values are informational and particularly sensitive to filesystem and executable caches.

The deterministic fixture routes show about 31–34 ms of process startup/collection overhead. Their first samples are informational because operating-system file and executable caches can make individual cold measurements noisy.

### Extension processing

| Fixture | Warm median | Warm p95 |
|---|---:|---:|
| No findings | 0.16 ms | 0.33 ms |
| 5 findings | 0.13 ms | 0.24 ms |
| 40 findings | 0.24 ms | 0.29 ms |
| 300 findings | 1.71 ms | 3.45 ms |
| Fallow schema | 3.16 ms | 3.88 ms |

At the frozen baseline, orchestration is inexpensive relative to npx startup, but the command result retains raw output, parsed objects, formatted JSON, and final content together.

Current candidate runs also emit `processing/noisy-json`, a deeply nested noisy-output scenario that exposes overlapping substring and parse retries. The frozen `0.2.0` artifact predates that scenario, so it appears in candidate output but is intentionally absent from baseline comparison tables until the next compatible baseline version.

### Git and autocomplete

| Operation | Cold/blocked median | Warm median | Git processes |
|---|---:|---:|---:|
| Ref autocomplete | 12.14 ms | 0.01 ms | 1 on a cold lookup |
| Base detection | 37.29 ms first run | 34.70 ms | 3 per invocation |

Cold autocomplete performs synchronous Git work and blocks the event loop. Base detection has no current cache and is performed for slash commands that do not need a PR base.

### Retained memory

| Fixture | Fixture size | Retained heap | Amplification | Worker max RSS |
|---|---:|---:|---:|---:|
| 5 findings | 3.63 KB | 87.59 KB | 24.12× | 189.59 MB |
| 40 findings | 25.47 KB | 153.51 KB | 6.03× | 188.78 MB |
| 300 findings | 141.03 KB | 342.18 KB | 2.43× | 189.34 MB |
| Fallow schema | 177.32 KB | 434.63 KB | 2.45× | 190.13 MB |

Max RSS includes Node, Jiti, Pi libraries, and the benchmark worker, so retained heap delta and amplification are the primary before/after signals.

## Project-issues scheduling baseline

[`project-issues-v0.6.1.json`](./baselines/project-issues-v0.6.1.json) compares the retained sequential schedule with bounded two-child concurrency on generated 10-file and 500-file TypeScript projects. Both schedules run through the real pinned Fallow executable and the production aggregation, parsing, overview, and normalization path.

| Project | Sequential warm median | Concurrent warm median | Reduction | Sequential peak descendant RSS | Concurrent peak descendant RSS |
|---|---:|---:|---:|---:|---:|
| 10 files | 287.65 ms | 183.94 ms | 36.05% | 115.78 MB | 215.47 MB |
| 500 files | 333.84 ms | 238.24 ms | 28.64% | 123.55 MB | 212.97 MB |

The concurrent large-project run increased the combined child median by 7.86% and the security child median by 12.88%, recording the CPU-contention effect rather than hiding it. Navigator preparation stayed at 0.09–0.15 ms, confirming that subprocess execution—not report aggregation or normalization—is the useful optimization target.

The accepted tradeoff is lower interactive latency for higher short-lived memory use. Concurrency is capped at exactly two analyses, output ordering remains combined then security, and a shared abort controller cancels the sibling on user cancellation, timeout, or an executor failure. Tests retain sequential post-first-child cancellation evidence as well as concurrent sibling cancellation, partial failures, deterministic ordering, and exit 130 behavior.

Process-tree RSS is sampled every 10 ms from `ps` descendants of the benchmark process and sums concurrently live descendants. It is machine- and sampling-sensitive, includes launch wrappers and native children, and is unavailable on Windows; compare it only on the same host. Generated projects isolate cold/warm caches per schedule. The 500-file case is a scale fixture, not a claim that file count alone predicts production latency.

## Commands

Generate a candidate result:

```bash
npm run bench:performance -- \
  --label candidate \
  --output /tmp/pi-fallow-performance-candidate.json
```

Compare it with the baseline:

```bash
npm run bench:performance:compare -- \
  benchmarks/baselines/performance-v0.2.0.json \
  /tmp/pi-fallow-performance-candidate.json
```

For a quicker exploratory run, lower the deterministic and memory iterations:

```bash
npm run bench:performance -- \
  --label quick \
  --iterations 3 \
  --warmups 1 \
  --memory-iterations 1 \
  --output /tmp/pi-fallow-performance-quick.json
```

Quick artifacts intentionally cannot be compared with the committed baseline because their benchmark configurations differ.

Run the focused project-issues benchmark:

```bash
npm run bench:issues -- \
  --label candidate \
  --output /tmp/pi-fallow-project-issues.json
```

Use fewer iterations or a smaller scale fixture for exploration:

```bash
npm run bench:issues -- \
  --label quick \
  --iterations 1 \
  --warmups 0 \
  --large-files 100 \
  --output /tmp/pi-fallow-project-issues-quick.json
```

Each focused artifact contains sequential and concurrent measurements from the same run and calculates the latency, contention, and RSS differences directly; it does not require a separate comparison command.
