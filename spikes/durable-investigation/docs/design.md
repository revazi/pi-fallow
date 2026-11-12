# Optional Durable companion: local contract/recovery spike

Status: experimental spike, not production-ready.

## Pinned upstream baseline

Verified on 2025-11-12 against:

- `@earendil-works/pi-durable@1.4.0`
- official repository: <https://github.com/earendil-works/pi>
- exact release commit: [`4a080252f06caf63a525d7873c5d94d3c23887e0`](https://github.com/earendil-works/pi/tree/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable)
- npm tarball integrity: `sha512-EtIyXH1MBSXdJSkodmy+CYXuwfve3gPrD4GNCZ0XmuRWLPupwRlNQ7fdaXjRcLoKb6SWkT/yEzK+sMmrqvYK+Q==`

Primary upstream references:

- [Durable README at the pinned commit](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/README.md)
- [`defineExtension` / `defineTool`](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/harness/define.ts)
- [`defineTask`](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/tasks.ts)
- [task runtime and tool contracts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/harness/types.ts)
- [document definitions and version checks](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/documents.ts)
- [Node SQLite adapter](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/storage/sqlite/node.ts)
- [tool recovery tests](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/harness-tools-recovery.test.ts)
- [recovery example](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/13-recovery.ts)

Durable is explicitly experimental. This spike does not silently substitute another release.

## Verified Durable semantics versus spike interfaces

The following are verified upstream behavior, not interfaces invented here:

- `defineExtension`, `defineTool`, `defineTask`, and document definitions are Durable APIs. They are not coding-agent `ExtensionAPI` registrations.
- A Durable tool executes as `execute(args, api, context)`.
- Tool replay defaults to `unsafe`; recovery reruns only when the stored and currently registered policies are both `safe`.
- A tool call's final arguments and replay intent are committed before execution. Recovery after that point does not rerun `beforeTool`.
- Submission `requestId` is conversation-scoped submission deduplication, not a general external-effect idempotency key.
- External processes and artifact files are outside Durable transaction atomicity.
- Task-scoped documents retire when the task settles. Long-lived evidence therefore needs session/conversation storage or separate owned storage.
- Reopen requires compatible registered task definitions and deliberate scheduling (`resume`, `wait`, or another progress request).
- `ExecutionEnv.exec` accepts direct argv arrays.
- One process owns a Durable storage instance; Durable 1.4.0 supplies no cross-process ownership lock.
- Watches are bounded/coalescing views, not audit journals.
- Node SQLite uses WAL with `synchronous=NORMAL`; process-crash recovery is expected, but the newest acknowledged commit is not promised across power/host failure.

The interfaces in `src/contracts.ts` are **proposed spike contracts**. In particular, host request identity, snapshot identity, operation/attempt IDs, artifact references, and the investigation report are not upstream Durable APIs.

## Installed-Fallow adapter experiment

**Verified locally:** the default Durable path admits a host-supplied absolute executable only, pins Fallow 3.36.0, its digest and resolved path, policy and schema IDs, and revalidates them along with the snapshot and persisted typed argv. `src/fallow-schema.ts` normalizes a bounded subset of dead-code schema version 10: unused files and exports, plus target-checked inspect/trace reachability. The Durable path checks the owning retained scan artifact against the selected ledger finding before details launch or reconciliation. Fake executable tests cover malformed/oversized output, replacement, and hard-death before launch and after publication. A synthetic project exercises the installed native executable through Durable when available; absence skips, incompatible output fails. This is not general wire certification.

**Proposed contract:** `src/fallow-policy.ts` is a pure allowlist builder, not an independent authentication boundary. Durable supplies its retained findings and verifies provenance. The controlled analyzer is explicitly selected only as a fixture for the original recovery matrix; opening without a mode requires an absolute installed-Fallow path. Unknown in-flight processes are blocked, never automatically relaunched. The process helper kills a live process group on overflow or cancellation; it does not prove ownership after host death.

**Production blockers:** the explicitly admitted binary is trusted, not sandboxed; hashing cannot close check-to-execution races. Configuration and plugins need a verified no-acquisition/no-external-effect safety policy, and dependency-resolution completeness and native hard-death ownership remain unresolved. No production extension integration is provided.

## Boundary demonstrated

The host-independent workflow is:

```text
explicit host request
  -> fixed clean snapshot and pinned analyzer identity
  -> durable admission (request -> investigation -> task)
  -> explicitly admitted installed-Fallow scan (controlled fixture only in recovery tests)
  -> deterministic fake selection from retained scan findings
  -> finding-bound inspect/trace
  -> bounded evidence plus verified artifact references
  -> report about the original snapshot
```

There is no arbitrary command string. Approved argv is built from the discriminated operation kind and persisted before launch. The allowed operation kinds are exactly `scan`, `inspect`, and `trace`. Mutation, shell passthrough, setup, cloud, Similar Code, Runtime Coverage, and installation are rejected.

## Identity contracts

### Host request

`hostRequestId` is stable and application-owned. Admission atomically stores:

- request ID;
- canonical payload digest;
- investigation ID;
- Durable task ID.

An identical repeat returns the existing investigation. Reuse with a different canonical payload rejects. This is separate from Durable conversation submission `requestId`.

### Snapshot

Admission accepts only the requested Git worktree root when it is clean. It rejects:

- dirty or untracked input;
- tracked symlinks;
- submodules;
- unsupported file modes or non-regular tracked entries;
- a requested path that is not the worktree root.

The materialized snapshot records:

- content digest over sorted tracked path/digest/size tuples;
- config digest;
- base commit and tree;
- tracked file count;
- owned materialized path.

The report omits the internal materialized path. A later workspace commit does not change the historical report identity. Production dependency-resolution completeness remains an explicit unresolved gate.

### Analyzer and policy

Admission records the executable's absolute path, SHA-256, reported version, and policy version; installed Fallow additionally records the requested path binding, adapter policy and schema identity. Each attempt persists exact approved argv. Both paths reconstruct and compare argv and operation ownership and revalidate snapshot and executable before launch and reconciliation. Installed Fallow is also revalidated after execution before publication. A killed-host test verifies controlled snapshot and executable drift block reconciliation; an argv-tampering test verifies blocking before launch. A live-process deadline test verifies termination and blocked evidence; subprocess completion waits for the asynchronous launch receipt commit. Neither path guarantees against a check-to-execution race. Recovery never installs, discovers, downloads, or upgrades an analyzer.

### Operation and attempt

An investigation owns operations; an operation owns attempts. IDs are distinct and persisted. An operation has at most one active attempt. A duplicate semantic operation returns the existing operation rather than starting another attempt.

Inspect/trace targets must be finding IDs retained by this investigation's scan evidence. A free-form path or CLI suffix is not accepted.

## State and reconciliation contracts

The Durable task checkpoint is orchestration state. The session-scoped ledger is long-lived application evidence/identity state. Artifact files are owned outside Durable storage.

Before external launch, the task commits a durable launch memo and marks the attempt `launch-uncertain`. This deliberately models the crash window between committed intent and confirmed process creation.

Recovery rules:

1. **Evidence already committed:** continue to selection/report; do not rerun.
2. **Published/staged artifact present, evidence absent:** validate shape, bounds, operation/target identity, size, and digest; publish/re-publish idempotently; then commit evidence.
3. **Process receipt present, artifact absent after hard host death:** block with `hard-death-process-ownership-unproven`; do not launch a duplicate. PID is recorded only as diagnostic data and is not accepted as ownership proof.
4. **No receipt after committed launch intent:** block with `launch-uncertain-no-process-receipt`; absence cannot prove that launch did not occur.
5. **Absolute deadline elapsed:** block with `deadline-exceeded-after-restart`; restart does not grant a new timeout budget.
6. **Missing/incompatible task definition:** Durable exposes a blocked task (`missing_task`, `task_too_old`, or `migration_failed`). The spike does not hide or auto-substitute it.
7. **Storage commit error:** the Harness fails. The caller must close/reopen and retry admission using the same host request ID.

This is at-least-once reconciliation of committed state, not exactly-once external execution.

## Artifact/evidence contracts

Each attempt writes an attempt-specific staging file. Publication goes only into the spike-owned `artifacts/` directory. Before evidence commit the spike validates:

- regular file and owned path;
- maximum 64 KiB artifact size;
- parseable plain JSON;
- operation and target identity;
- explicit completeness and nonnegative counts;
- bounded finding array and bounded scalar fields.

Durable evidence stores only bounded plain JSON and a reference `{relativePath, sha256, bytes, kind, attemptId}`. It does not store temporary absolute paths, subprocess objects, or Pi Fallow's packed in-memory normalized report objects.

The following remain separate:

- analyzer `findingCount` (reported total);
- `retainedCount` (bounded durable findings);
- `selectionLimit` (maximum fake-selector input);
- `presentationLimit` and `presentationTruncated` (report rendering).

A missing, malformed, oversized, or digest-drifted artifact is unavailable/incomplete evidence, never a clean result.

## Cancellation and process boundaries

Both execution paths use direct argv, bounded capture, a minimal environment, a persisted deadline, and process-group cancellation on Unix. The controlled fixture additionally uses a launch token and its own process receipt. Specifically the controlled analyzer runs with:

- direct argv (`shell: false`);
- an explicit minimal environment supplied by the spike;
- bounded captured output;
- a persisted absolute deadline;
- a per-attempt launch token and process receipt;
- a process group on Unix for orderly cancellation cleanup.

The three termination cases are intentionally distinct:

- **Orderly close:** Durable signals active invocations; no task outcome is fabricated merely because the host is closing.
- **Durable cancellation:** abort intent is committed, the active process group is killed where supported by this local test implementation, attempts/operations become cancelled, and later files cannot become committed evidence.
- **Hard host death:** no cleanup guarantee is claimed. If a receipt exists without a committed result, recovery blocks. The tests prove this behavior on the current local platform only; they do not claim cross-platform orphan cleanup.

## Report contract

The report includes the admitted snapshot identity, operation sections, completeness, counts, bounded findings, and verified artifact references. It states that evidence describes the original snapshot. It never relabels a changed workspace as investigated.

Long-lived evidence is in the session-scoped ledger and owned artifact directory, not task-scoped documents that retire with the task.

## Fault-injection evidence

`npm test` uses file-backed Durable SQLite for recovery tests. Coordination uses explicit barrier/release files or in-process promises; sleeps are not the primary synchronization mechanism.

Actual process-kill cases:

- host SIGKILL after launch intent but before analyzer launch;
- host SIGKILL while the analyzer is active (receipt exists, no artifact);
- host SIGKILL after artifact publication but before evidence commit;
- host SIGKILL after evidence commits but before report completion;
- deadline reconciliation after a killed/reopened host.

Simulated/in-process failures:

- acknowledgement lost after admission commit;
- post-commit storage acknowledgement failure through a wrapped real SQLite storage;
- malformed/oversized/missing/corrupt artifacts;
- snapshot/config/executable drift;
- cancellation and a late staged file;
- missing/incompatible definitions;
- attempted second owner;
- forbidden operation requests.

The controlled analyzer itself is real subprocess evidence. The deterministic selector is a scripted fake; no provider/model is called.

## Storage ownership

Because Durable 1.4.0 has no cross-process lock, the spike adds a host-level `owner.lock` using exclusive creation. A second owner rejects. After hard death, takeover requires explicit `recoverOwnership: true`, and the previous lock is retained as a stale record. This is a spike policy, not an upstream Durable guarantee and not yet sufficient for distributed or hostile hosts.

## Packaging isolation

The root `pi-fallow` package has an explicit `files` allowlist containing documentation/assets plus `extensions/**/*.ts`. `spikes/` is outside that allowlist. The spike has its own `package.json`, exact dependencies, `package-lock.json`, and `node_modules`; it does not alter root peers, externals, dependencies, extension registration, or install behavior.

## Remaining production blockers

1. Define a real companion package/process lifecycle and explicit host API; do not place this task engine inside the existing TUI extension.
2. Develop and review a production Fallow adapter from the isolated installed-only experiment while preserving the narrow typed policy. Generic `fallow_run` must remain replay-unsafe.
3. Prove complete production snapshot/dependency/config identity, including package-manager and resolver inputs, or keep blocking unsupported repositories.
4. Design robust process ownership/lease reconciliation. Current hard-death behavior intentionally blocks rather than proving cleanup.
5. Decide artifact retention, garbage collection, permissions, disk quotas, backup expectations, and operator repair UX.
6. Add platform-specific process-tree tests (Windows and Linux at minimum). This spike's local tests do not establish cross-platform cleanup.
7. Specify schema/task/document migrations and a supported definition compatibility window before any durable records are user-facing.
8. Add operational observability independent of coalescing watches: audit/event records, blocked-work surfaces, and repair commands.
9. Threat-model repository content, analyzer output, artifact paths, and local multi-user access.
10. Validate real Fallow schema/version compatibility and conservative completeness mapping without persisting packed live objects.
11. Decide SQLite durability settings and communicate that `synchronous=NORMAL` does not promise every latest acknowledged commit across power/host failure.
12. Independently review recovery behavior and production packaging before any optional integration is enabled.

## Recommendation

The installed-Fallow path is the default for this isolated experiment, not an approval for production. Continue expanding snapshot safety and process ownership evidence before considering integration.

**No-go** for production integration, TUI durability, or a shared-core refactor now. The spike demonstrates useful admission, artifact, and reconciliation contracts, but deliberately blocks unresolved hard-death ownership and does not prove production snapshot completeness or cross-platform process cleanup.
