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

- **Agent tool:** `fallow_run` gives Pi structured JSON summaries from Fallow.
- **Slash command:** `/fallow ...` runs the Fallow CLI from inside Pi.
- **PR shortcut:** `/fallow pr` maps to `audit --base <detected-base> --gate new-only`.
- **Rerun shortcut:** `/fallow rerun` repeats the last `/fallow` command.
- **Autocomplete:** subcommands, flags, enum values, and branch refs are suggested in the editor.
- **Interactive navigator:** findings open in a bordered TUI view where you can inspect, select, trace, or load issues into the editor.
- **Run-mode support:** `/fallow` executes in TUI, RPC, JSON, and print modes; terminal loaders and navigator overlays are TUI-only, while non-TUI modes retain full transcript output.
- **Safe defaults:** JSON and quiet output are added when appropriate; large output is truncated for the transcript and saved to a temp file.
- **Flexible CLI lookup:** uses `FALLOW_BIN` first, then `fallow` from `PATH`, then falls back to `npx -y fallow`.

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
- “Run Fallow security candidates for the changed files and explain what needs verification.”
- “Run Fallow health and tell me the safest maintainability improvement.”
- “Preview Fallow auto-fixes before applying anything.”

Manual slash command examples:

```text
/fallow pr
/fallow rerun
/fallow about
/fallow audit --base origin/main --gate new-only
/fallow check-changed --changed-since main
/fallow dead-code --changed-since main
/fallow dupes --changed-since main
/fallow health --file-scores --targets --score
/fallow inspect --file extensions/fallow/cli.ts
/fallow inspect --symbol extensions/fallow/cli.ts:fallowCli
/fallow trace extensions/fallow/cli.ts:fallowCli
/fallow trace-file extensions/fallow/ui.ts
/fallow trace-export extensions/fallow/ui.ts FallowIssueNavigator
/fallow security --changed-since main --gate new
/fallow decision-surface --changed-since main
/fallow workspaces
/fallow schema
/fallow coverage analyze
```

`/fallow check-changed` is a Pi Fallow convenience alias for Fallow's combined root analysis with `--changed-since`.

`/fallow about` shows the installed Pi Fallow version, latest npm version, update command, and project links. Pi Fallow also checks npm once per TUI session and shows a non-blocking update notice when a newer version is available. Set `PI_FALLOW_DISABLE_UPDATE_NOTICE=1` to disable startup update notices.

In the interactive navigator:

- `↑↓` or `j/k` — move
- `Enter` / `Space` — expand the selected finding
- `s` — select/unselect
- `e` or `a` — load selected findings into the editor
- `t` — run a trace for the selected finding when possible
- `q` / `Esc` — close

## Requirements

- Node.js 22.19+
- Pi coding agent
- Fallow available through one of:
  - `FALLOW_BIN=/path/to/fallow`
  - `fallow` on `PATH`
  - `npx -y fallow` fallback

The Pi package declares Pi libraries as peer dependencies, as recommended for Pi extensions.

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
