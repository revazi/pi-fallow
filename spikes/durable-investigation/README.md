# Durable investigation contract/recovery spike

This directory is an isolated, local-only experiment for a possible optional Pi Fallow companion. It is **not** production integration code and is not loaded by `pi-fallow`.

## Run

```bash
cd spikes/durable-investigation
npm test
npm run demo -- /absolute/path/to/already-installed-native-fallow
```

The recovery suite uses temporary local Git repositories, a controlled analyzer executable, a scripted deterministic selector, and file-backed Durable SQLite. Installed-adapter tests use a fake executable and a synthetic Git project with the pinned native Fallow binary if it is already present under the root `node_modules`; the native tests skip when absent and fail on incompatible output. They never install an executable. Tests make no provider calls and read no credentials.

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

The default installed-only path requires an absolute `analyzerPath` pointing to an already-installed, trusted native Fallow 3.36.0 executable; it never discovers or acquires one. `analyzerMode: "installed-fallow"` may also be specified explicitly. Admission pins version, bytes, path binding, adapter policy and output schema. Attempts persist direct typed argv; launch and reconciliation revalidate identity, snapshot, argv and the retained scan artifact. Only unused-file and unused-export findings are retained. The deterministic selector drives detail operations from those findings, not free-form paths. Scan exit code 1 is accepted only with compatible JSON. Stdout is bounded and normalized before publication. The earlier fault suite explicitly selects `analyzerMode: "controlled"` as a **test fixture**; it is not the default or a production adapter selection API. Recovery blocks if the open host's mode differs from the admitted mode, so default recovery cannot silently run a controlled fixture.

**Evidence and limitations:** fake-executable tests exercise Durable scan/details, malformed/oversized output, replacement and two hard-death windows; the local native test exercises the same Durable path on a synthetic project. These do not establish broad production compatibility or native hard-death process ownership. Unknown in-flight launches remain blocked. Hashing does not sandbox an executable or eliminate check-to-execution races. Safe handling of project configuration/plugins and dependency-resolution completeness remain production blockers; use only trusted synthetic inputs. Output describes the narrow supported subset, not all Fallow findings.

The workflow does not use or wrap `fallow_run`, fabricate a coding-agent `ExtensionAPI`, modify the Pi Fallow TUI, acquire analyzers during execution or recovery, or execute model workloads.

See [`docs/design.md`](docs/design.md) for the contracts, verified upstream references, fault matrix, and production blockers. The investigation-only [Darwin API evidence](docs/darwin-api-evidence.md) and [supervisor design](docs/darwin-supervisor-design.md) assess #155 without changing recovery behavior or completing its prototype/security gates.
