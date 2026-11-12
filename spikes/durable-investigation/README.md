# Durable investigation contract/recovery spike

This directory is an isolated, local-only experiment for a possible optional Pi Fallow companion. It is **not** production integration code and is not loaded by `pi-fallow`.

## Run

```bash
cd spikes/durable-investigation
npm ci
npm test
npm run demo
```

The test suite uses only temporary local Git repositories, a controlled analyzer executable, a scripted deterministic selector, and file-backed Durable SQLite. It makes no provider calls and reads no credentials.

## Scope

The spike demonstrates:

- host request admission and payload conflict detection;
- fixed clean Git snapshots with pinned analyzer and policy identity;
- scan plus finding-bound `inspect`/`trace` operations only;
- separate investigation, operation, attempt, artifact, and evidence identities;
- intent-before-effect and conservative recovery;
- bounded JSON evidence and owned artifact publication;
- cancellation/deadline fencing;
- evidence-linked reporting against the admitted snapshot.

It intentionally does not use or wrap `fallow_run`, fabricate a coding-agent `ExtensionAPI`, modify the Pi Fallow TUI, acquire analyzers during recovery, or execute real Fallow/model workloads.

See [`docs/design.md`](docs/design.md) for the contracts, verified upstream references, fault matrix, and production blockers.
