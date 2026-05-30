# Pi Fallow extension

A Pi coding-agent extension that exposes [Fallow](https://fallow.tools/docs/) as an LLM-callable tool.

## Fallow docs analysis

Fetched Fallow's docs index plus the LLM bundle (`/llms.txt`, `/llms-full.txt`). Key points for a Pi integration:

- Fallow is codebase intelligence for TypeScript/JavaScript.
- The free static layer covers dead code, unused exports/files/dependencies/types, duplication, complexity/health, architecture boundaries, feature flags, and auto-fix.
- The optional runtime layer adds hot/cold path and runtime-backed deletion evidence.
- The docs explicitly recommend agents use `--format json` for structured output.
- The MCP tools are thin wrappers around CLI commands, so a Pi extension can get equivalent value by wrapping the CLI safely.
- Useful agent commands map to: `fallow`, `dead-code`, `dupes`, `health`, `audit`, `fix --dry-run`, `fix --yes`, `list`, traces, and `coverage analyze`.
- Fallow exit code `1` means issues/gate failure, not tool execution failure; only `2+` should be treated as command errors.

## What this extension adds

- LLM tool: `fallow_run`
- Slash command: `/fallow ...` with autocomplete for Fallow commands and common flags (type `/fallow` and press Tab to pick a subcommand)
- Automatic JSON + quiet output for modeled tool calls
- Uses `FALLOW_BIN` if set, otherwise `fallow` from `PATH`, falling back to `npx -y fallow`
- Truncates large output to Pi's default limits and saves full JSON to a temp file
- Compact TUI rendering with expandable command/summary details
- Interactive bordered issue navigator for `/fallow ...`: arrow keys or `j/k` move, Enter/Space expands the selected finding, `s` selects/unselects, `e` or `a` loads selected findings into the editor so you can add comments before submitting, `q`/Esc closes. The regular Pi transcript only gets a compact summary while details live in the navigator.

## File layout

- `extensions/fallow.ts` — extension entrypoint and Pi registration
- `extensions/fallow/schema.ts` — tool parameter schema
- `extensions/fallow/autocomplete.ts` — `/fallow` command and flag autocomplete
- `extensions/fallow/cli.ts` — CLI argument building and process execution
- `extensions/fallow/output.ts` — JSON parsing, summaries, truncation
- `extensions/fallow/overview.ts` — maps Fallow JSON to overview data
- `extensions/fallow/ui.ts` — pi-tui overview component
- `extensions/fallow/project.ts` — Fallow project/git status detection
- `extensions/fallow/pr-summary.ts` — PR gate summary extraction
- `extensions/fallow/types.ts` — shared types

## Install / test

Install this repository as a Pi package:

```bash
# Global install for your user
pi install .

# Or project-local install, written to .pi/settings.json
pi install -l .
```

Try it for one Pi run without installing:

```bash
pi -e .
```

Install from git:

```bash
pi install git:github.com/revazi/pi-fallow
```

After publishing to npm, install with:

```bash
pi install npm:pi-fallow-extension
```

`package.json` declares the Pi package entrypoint:

```json
{
  "pi": {
    "extensions": ["./extensions/fallow.ts"]
  }
}
```

## Examples

Ask Pi:

- "Run a Fallow audit for this PR and fix any introduced dead code."
- "Use Fallow to find duplicate code, then trace the largest clone group before refactoring."
- "Run Fallow health with file scores and targets; propose the safest low-effort refactor."
- "Preview Fallow auto-fixes, then apply the safe ones."

Or run manually in Pi:

```text
/fallow audit --base main --gate new-only
/fallow audit --base origin/main --gate new-only
/fallow check-changed --changed-since main
/fallow dead-code --changed-since main
/fallow dupes --changed-since main
/fallow health --changed-since main
/fallow trace-file extensions/fallow/ui.ts
/fallow health --file-scores --targets --score --format json --quiet
```
