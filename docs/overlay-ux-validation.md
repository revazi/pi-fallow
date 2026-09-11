# Persistent optional-analysis overlay: validation (#103)

## Evidence boundary

The automated matrix and native-terminal probe validate UI behavior with deterministic readiness/setup/analysis callbacks. They complement rather than replace direct review or real model-backed execution evidence. Maintainer-directed interactive review and follow-up visual polish completed in #110, closing #103 and parent #96. Separate real inference certification is recorded by #83's manual, existing-model-only lane.

No optional component was reinstalled for this validation. Existing installations can be reused for read-only readiness checks and the separately documented sidecar smoke test. A successful readiness check is not proof of successful inference or representative production coverage.

## Local validation record

On macOS, Node 24.12.0 and Pi TUI 0.84.4: **399 unit tests passed** at the final #110 review, including the focused UX matrix. Coverage passed; four existing memory tests intentionally skip under coverage. The native PTY probe passed 32 checkpoints with one mount, two fixture analysis requests, and one explicit fixture consent. Both Node CI lanes run this probe as well.

Bundle, health thresholds, duplication/dead-code checks, Fallow CLI smoke, the existing installed sidecar's certification script, dependency audits, isolated package smoke, package-content checks, and token/performance baseline comparisons passed locally. Package smoke exercised Pi RPC/print/JSON. No release/tag/publication was performed.

## Fixes found during validation

- Bound Findings, forms, setup, running/error views, and results to the actual overlay height; keep navigation/consent controls outside the scrollable body.
- Keep selected findings, active action-palette items, and editing cursors visible at compact sizes and after resize. Page Up/Down scrolls the entire Findings viewport without changing its selection.
- Pause hidden editing and confirmation below 40 content columns / 12 terminal rows. Escape/q still cancels or closes; resizing back restores state.
- Coalesce bounded fragmented bracketed paste before routing input, so pasted `S`, `y`, Enter, digits, or `q` cannot trigger setup, consent, Run, navigation, or close.
- Cancel outstanding form validation before reopening retained results, preventing a late run request from replacing the result being inspected.
- Preserve the cancellation status while late setup progress arrives.
- Remove standalone optional-analysis select/input/confirm chains and their private command dispatch. `o` now opens Similar Code in the same overlay. The shared pinned setup safety workflow remains, with confirmation supplied only by the overlay.

## Automated matrix

Run `npm test` (or `node --test tests/overlay-*.test.mjs`).

| Surface | Evidence |
| --- | --- |
| Discoverability | Empty, informational-only, and 1,000-finding reports expose all three views without closing the overlay |
| Readiness | Ready, missing, incompatible, corrupt, unverified, and error fixtures at 40×12, 64×24, and 120×48; existing tests cover loading, refresh, timeout, stale completion, and disposal |
| Keyboard/focus | View keys, arrows, Home/End, Page Up/Down, search, action palettes, selection/expansion/filter state, Tab/Shift+Tab, Enter, Back/Escape, close, Unicode and long drafts, focus loss/recovery |
| Compact/resize | Bounded width/height for all views, selected finding/action and input cursor visibility, long setup previews/errors/output, short-terminal pause and recovery |
| Setup | Preview versus explicit consent, decline, plan/identity drift, ready-component no-op, protected project destinations, failures, cancelled children and settled cleanup |
| Analysis | Fresh readiness/options/artifact/signed-sidecar checks, complete/empty/partial/error/cancelled/timed-out results, retry, per-view retained navigators, complete-output references, advisory provenance |
| Safety/regressions | No installing Run fallback, no cloud environment or project mutation, non-TUI/tool setup rejection, ordinary navigator actions, RPC/print/JSON output and existing command suites |

Fixture installers and processes test lifecycle, not actual downloads or inference. Metadata-only fixtures do not substitute for the existing detached-signature verification tests.

## Native Pi TUI PTY probe

On macOS/Linux with Python 3 and the project's existing development dependencies:

```bash
npm run probe:overlay
```

The probe launches the production `openFallowOverviewNavigator` factory inside Pi's native `TuiMainScreen` / `ProcessTerminal`, using a real POSIX pseudoterminal. It sends actual key bytes and terminal resize notifications, asserts every frame's width/height, and checks one mount through form editing, Unicode paste, narrow-terminal pause/recovery, results/Back/reopen, setup decline/explicit fixture confirmation/cancellation, analysis cancellation, and final close. Readiness, setup, and analysis are **fixture callbacks**; no installer or inference process is launched.

The printed temporary directory contains `report.json`, `frames.jsonl`, and `terminal.bin`. These are local diagnostic artifacts, not committed screenshots or a claim of visual approval. The driver drains PTY output during shutdown and terminates its process group on failure. It is a separate POSIX-only probe, not a replacement for cross-platform unit tests.

## Human review checklist — completed

Use the checkout with `pi -e .`, then `/fallow`. Do not reinstall already available components. Missing-component preview/decline behavior can be reviewed using the fixture probe; a real download still needs its distinct in-overlay confirmation.

- [x] Find all three views on a real report (also try an empty/informational report).
- [x] Mark, expand, filter and scroll Findings; switch views and confirm the original state returns unchanged.
- [x] Edit scope/threshold/limit and a local artifact path; try Tab/Shift+Tab, paste, Enter-to-validate, Escape, Back, and close.
- [x] Resize while editing, in a setup preview, during a run, and in results; judge readability, focus, scrolling and key hints, not just line bounds.
- [x] Inspect installed readiness and identity/signature details. Opening/refreshing must not install or run analysis.
- [x] With an explicitly chosen small local scope/capture, run each available analysis and inspect empty/partial/advisory metadata and complete-output references. Cancel a run and wait for cleanup; reopen retained results and return to the original report.
- [x] Confirm no standalone optional-workflow dialog remains and provide any awkward key/layout behavior before approving #103/#96.

The maintainer review used the local offline Pi overlay on macOS and iterated from the supplied Findings visual reference through narrow/wide layouts, cold and warm Similar Code runs, cache disclosure, and final styling. Automated coverage supplies the exact 40×12, 64×24, and 120×48 matrix and native ProcessTerminal checkpoints. Review evidence and closure comments are retained in #103 and #110; no blocking concerns remained.
