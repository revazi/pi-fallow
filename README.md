# Pi Fallow

[![npm version](https://img.shields.io/npm/v/pi-fallow.svg)](https://www.npmjs.com/package/pi-fallow)
[![npm downloads](https://img.shields.io/npm/dm/pi-fallow.svg)](https://www.npmjs.com/package/pi-fallow)
[![CI](https://github.com/revazi/pi-fallow/actions/workflows/ci.yml/badge.svg)](https://github.com/revazi/pi-fallow/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/revazi/pi-fallow/branch/main/graph/badge.svg)](https://codecov.io/gh/revazi/pi-fallow)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Pi Fallow connects [Fallow](https://fallow.tools/docs/) to the [Pi coding agent](https://github.com/earendil-works/pi). It adds:

- 🧰 `fallow_run` — a compact tool for agent workflows
- ⌨️ `/fallow` — a slash command for interactive analysis
- 🧭 a TUI navigator for reviewing, filtering, tracing, and selecting findings

Use it to verify changes, review a PR, find dead code or duplication, inspect maintainability, surface security candidates, and trace whether code is safe to remove.

![Pi Fallow project analysis](./pi-fallow.png)

![Similar Code review queue](./pi-fallow-similar-code.png)

## 📦 Install

```bash
pi install npm:pi-fallow
```

Other supported sources:

```bash
pi install git:github.com/revazi/pi-fallow
pi install .       # local checkout
pi install -l .    # project-local checkout
pi -e .            # try without installing
```

## 🚀 Quick start

Run the issue-focused default:

```text
/fallow
```

This combines dead-code, duplication, health, and security analysis into one actionable report. Informational file scores, hotspots, and advisory refactoring targets remain available through explicit health commands but do not inflate the default issue count.

| Command | What it does |
|---|---|
| `/fallow` | Issue-focused default report |
| `/fallow issues` | Same aggregate, explicit |
| `/fallow pr` | Audit against the detected base, new-only gate |
| `/fallow health --file-scores --targets --score` | Maintainability context |
| `/fallow dead-code --changed-since main` | Unused code on a branch |
| `/fallow dupes --changed-since main` | Duplication on a branch |
| `/fallow security --changed-since main --gate new` | Security candidates on a branch |
| `/fallow audit --base origin/main --gate new-only` | Full change audit |
| `/fallow inspect --file extensions/fallow/cli.ts` | Inspect one file |
| `/fallow trace extensions/fallow/cli.ts:fallowCli` | Trace a symbol |
| `/fallow architecture extensions/fallow/cli.ts extensions/fallow/registry.ts` | Architecture lookup |
| `/fallow decision-surface --changed-since main` | Structural decisions in a change |
| `/fallow history` | Reopen or compare session reports |
| `/fallow compatibility` | Compare installed Fallow with the certified surface |
| `/fallow config-assist` | Read-only config inspection |
| `/fallow similar-code status` | Local similar-code readiness |

`/fallow pr` is shorthand for an audit against the detected base with a new-only gate. `/fallow rerun` repeats the last analysis. `/fallow architecture <file>...` maps to Fallow's read-only `guard` command.

Set a shell-free custom default with `PI_FALLOW_DEFAULT_COMMAND`:

```bash
export PI_FALLOW_DEFAULT_COMMAND='health --complexity --targets --score'
```

Explicit subcommands are never replaced. Recursive and extension-only commands cannot be configured as the default.

## 🤖 Agent tool

`fallow_run` accepts a command, separate CLI-token arguments, an optional root and timeout, and an output detail level:

```json
{
  "command": "audit",
  "args": ["--base", "main", "--gate", "new-only"],
  "detail": "findings"
}
```

| Detail | What the model sees |
|---|---|
| `summary` | Status and counts |
| `findings` | Bounded normalized findings with locations and actions (**default**) |
| `raw` | Bounded raw Fallow output for diagnostics |

Bounded responses link to a complete report whenever data is omitted. Before deletion, inspect or trace the target; treat incomplete type-aware evidence as advisory; and preview fixes before applying them.

## 🧭 Interactive navigator

The TUI keeps every actionable finding navigable while defaulting to a compact model prompt.

| Key | Action |
|---|---|
| `↑`/`↓`, `j`/`k` | Move |
| `Enter`/`Space` | Expand finding |
| `/` | Search |
| `f` / `v` | Cycle section/severity filters |
| `s` / `A` | Select one/all visible findings |
| `p` | Open read-only action palette |
| `t` | Run the first valid trace action |
| `e` or `a` | Load selected findings into the editor |
| `y` | Copy selected findings |
| `d` | Toggle full raw detail |
| `i` | Toggle informational health context |
| `q` / `Esc` | Close or dismiss the current control |

The action palette supports safe inspection, explanation, tracing, symbol impact, and architecture lookup. Fixes are limited to explicit project-wide dry-run previews; the navigator never applies them.

### 🧩 Similar Code

Similar Code is explicit, local-model, and advisory. It never runs as part of the default report, audits, security analysis, or automatic fixes.

Open the persistent overlay with `2` or `o`. From its Similar Code view:

- `r` refreshes readiness
- `s`, `t`, and `l` edit scope, threshold, and result limit
- `c` opts into reuse of project-local embeddings (off by default)
- `v` validates without running
- `Enter` validates and requests a run when not editing
- uppercase `S` opens the setup preview, and only `y` confirms installation

Setup and analysis stay in the overlay, support cancellation, retain their latest result, and never run automatically. Cold inference may require the download size reported by `similar-code status` and can take minutes. Complete reports remain separate files for reproducible inspect/review steps.

The Runtime Coverage overlay tab is currently disabled because the interactive flow does not yet model the sidecar's single-capture versus licensed multi-capture boundary clearly enough. Direct Fallow runtime-coverage commands remain available.

### 🕘 History

Pi Fallow keeps up to 20 completed slash-command reports in branch-aware, project-isolated session metadata:

```text
/fallow history
/fallow history open r1
/fallow history compare r1 r2
/fallow history clear
```

Reports must still exist and match their recorded digest. Comparisons require compatible, complete scopes and never guess when identity evidence is missing. History is session-local and Pi Fallow never deletes saved reports automatically.

## ⚙️ Configuration and compatibility

`/fallow config-assist` performs a bounded read-only inspection of the discovered Fallow configuration. It can preview one schema-recognized rule severity without exposing resolved values or secrets.

Applying a preview is TUI-only. Apply requires a direct confirmation; repeated discovery, schema, and content checks ensure concurrent drift or cancellation refuses the write. Existing files receive byte-exact backups and atomic replacements; inherited or external configuration remains read-only.

`/fallow compatibility` compares the installed Fallow capability schema with the certified surface. It reports additive and incompatible capabilities, never installs software or runs during startup, and never gates ordinary execution.

## 🛡️ Run modes and safety

- TUI mode uses loaders and the interactive navigator.
- RPC, print, and JSON modes execute directly and retain complete transcript output without terminal UI.
- Arguments are passed as arrays without a shell.
- Cancellation terminates process trees and escalates when necessary.
- Large model-facing results are bounded and preserve complete-output references.
- Pi host packages remain external and are never bundled.
- Optional model setup requires an explicit TUI preview and confirmation.

## ✅ Tested compatibility

| Pi coding agent | Matching Pi AI/TUI packages | Node.js | Fallow |
|---|---|---|---|
| 0.85.1 | 0.85.1 | 22.19 and 24 | 3.24.1 |

**Certification** means this exact matrix passed frozen and live repository checks. **Compatibility** means the installed Fallow still advertises the capabilities Pi Fallow models. **Installation constraints** are only the requirements below. This is tested compatibility; it is not an installation constraint, and other versions may work.

Pi libraries are host-provided wildcard peer dependencies, following Pi package guidance; the tested matrix does not narrow those peer ranges.

## 📋 Requirements

- Node.js 22.19+
- Pi coding agent
- Fallow available through `FALLOW_BIN`, `PATH`, a package-local installation, or the `npx -y fallow` fallback

Fallow 3.24.1 is the current certification target. Runner discovery is cached per project/session and refreshed when relevant environment values change.

## 📊 Benchmarks

Pi Fallow is measured in three places: model-visible tokens, interactive latency, and `/fallow issues` on pinned popular JS/TS packages. These are host-specific snapshots, not provider billing or a quality ranking of the analyzed projects.

### 🧠 Model-visible tokens

Bounded `fallow_run` output keeps complete findings on disk and sends the model a compact, actionable slice.

| Surface (`o200k_base`) | Before output-detail | Current |
|---|---:|---:|
| Active `fallow_run` contract | 2,237 | **421** |
| All tool results | 45,104 | **7,590** (**83.17%** smaller) |

Slash-command transcripts are unchanged by `detail`. Omitted inline findings are counted, and bounded results keep a complete-output reference. These are deterministic corpus measurements; see [`benchmarks/README.md`](./benchmarks/README.md).

### ⚡ Interactive analysis

`/fallow issues` runs combined code-quality and security analyses concurrently, capped at two child processes.

| Generated project | Sequential | Concurrent | Faster | Peak descendant RSS |
|---|---:|---:|---:|---:|
| 10 files | 287.65 ms | **183.94 ms** | **36.05%** | 115.78 → 215.47 MB |
| 500 files | 333.84 ms | **238.24 ms** | **28.64%** | 123.55 → 212.97 MB |

Navigator preparation stays below 0.2 ms. Direct Fallow invocation is much cheaper than npx fallback on the same machine. Methodology and the Apple M1 Pro baseline live in [`benchmarks/PERFORMANCE.md`](./benchmarks/PERFORMANCE.md).

### 📦 Popular packages

The table below is `/fallow issues` on shallow clones of widely used JS/TS projects, using default Fallow discovery and Pi Fallow's production aggregator. It answers "does this finish on real code?" — not "which package is healthier."

Tests, examples, docs, and generated fixtures are included, so unused-file and duplication counts are often large. Health grades stay in the JSON artifact for that reason.

Measured on Apple M1 Pro, Node.js 24.12.0, Fallow 3.24.1:

#### HTTP frameworks

| Package | Pin | Files | Time | Navigator findings |
|---|---|---:|---:|---:|
| [express](https://github.com/expressjs/express) | v5.2.1 | 154 | 0.35s | 358 |
| [fastify](https://github.com/fastify/fastify) | v5.9.0 | 296 | 0.36s | 514 |
| [koa](https://github.com/koajs/koa) | v3.2.1 | 82 | 0.26s | 112 |
| [hono](https://github.com/honojs/hono) | v4.13.8 | 391 | 0.53s | 218 |

#### UI frameworks

| Package | Pin | Files | Time | Navigator findings |
|---|---|---:|---:|---:|
| [preact](https://github.com/preactjs/preact) | 10.29.8 | 255 | 0.47s | 126 |
| [vue](https://github.com/vuejs/core) | v3.5.43 | 565 | 0.62s | 569 |
| [svelte](https://github.com/sveltejs/svelte) | svelte@5.57.0 | 8,493 | 1.66s | 5,961 |

Svelte is measured as the published monorepo tag, not a single package path.

#### Libraries

| Package | Pin | Files | Time | Navigator findings |
|---|---|---:|---:|---:|
| [axios](https://github.com/axios/axios) | v1.20.0 | 252 | 0.41s | 176 |
| [zod](https://github.com/colinhacks/zod) | v4.6.5 | 549 | 0.63s | 863 |
| [commander](https://github.com/tj/commander.js) | v15.0.0 | 171 | 0.31s | 208 |
| [zustand](https://github.com/pmndrs/zustand) | v5.0.15 | 56 | 0.57s | 21 |
| [redux](https://github.com/reduxjs/redux) | v5.0.1 | 225 | 0.45s | 118 |
| [date-fns](https://github.com/date-fns/date-fns) | v4.4.0 | 1,632 | 1.38s | 909 |
| [debug](https://github.com/debug-js/debug) | 4.4.3 | 7 | 0.25s | 14 |
| [chalk](https://github.com/chalk/chalk) | v6.0.0 | 20 | 0.70s | 9 |
| [lodash](https://github.com/lodash/lodash) | 4.18.1 | 59 | 0.51s | 767 |

Reproduce or refresh the snapshot:

```bash
npm run bench:packages -- \
  --label candidate \
  --output /tmp/pi-fallow-popular-packages.json
```

Pinned refs live in [`benchmarks/popular-packages.json`](./benchmarks/popular-packages.json). The checked-in result is [`benchmarks/baselines/popular-packages-v0.6.2.json`](./benchmarks/baselines/popular-packages-v0.6.2.json). Wall times are one-shot and machine-sensitive; file counts and finding totals are from the pinned checkouts.

## 🧩 More Pi packages by Revaz

| Package | Purpose |
| --- | --- |
| [`pi-jscpd`](https://www.npmjs.com/package/pi-jscpd) | Quiet, read-only duplication guardrail for Pi |
| [`pi-reads`](https://www.npmjs.com/package/pi-reads) | Source capture, cited reading, Obsidian, EPUB, PDF, and Kindle workflows |
| [`pi-career`](https://www.npmjs.com/package/pi-career) | Deterministic resume and career workflows |
| [`pi-tmux-orchestrator`](https://www.npmjs.com/package/pi-tmux-orchestrator) | Multi-agent coordination in tmux |
| [`@tasklight/pi-tasklight`](https://www.npmjs.com/package/@tasklight/pi-tasklight) | Tasklight notifications for Pi |

## 🛠️ Development

```bash
npm test
npm run coverage
npm run check:bundle
npm run health
npm run dupes
npm run dead-code
npm run audit:all
npm run package:smoke
npm run bench:tokens -- --label candidate --output /tmp/pi-fallow-tokens.json
npm run bench:performance -- --label candidate --output /tmp/pi-fallow-performance.json
npm run bench:issues -- --label candidate --output /tmp/pi-fallow-project-issues.json
npm run bench:packages -- --label candidate --output /tmp/pi-fallow-popular-packages.json
```

See [CONTRIBUTING.md](./CONTRIBUTING.md), [ROADMAP.md](./ROADMAP.md), [benchmark documentation](./benchmarks/README.md), and [performance methodology](./benchmarks/PERFORMANCE.md).

The package manifest exposes `./extensions/index.ts`. Pi libraries and TypeBox are external wildcard peers, not bundled dependencies.

## 📄 License

MIT © Revaz Zakalashvili
