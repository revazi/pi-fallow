# Standalone supervisor milestone audit (#155)

Status: **blocked, not approved as the requested supervisor prototype**. Related to [#155](https://github.com/revazi/pi-fallow/issues/155). This audit preserves partial experiments; it does not authorize recovery, signalling, integration, or production use.

## Audited scope

The stopped orchestration left four committed milestones, not only the two described in its earlier reports:

- `97561c8`: private-pipe bootstrap probe;
- `91a84dc`: gate bootstrap observation on actual host exit;
- `f2bc0d7`: canonical encoding, MAC, framing and sequence primitives;
- `ec17982`: reject further input after truncated-reader closure.

The worktree was clean. All seven changed files were within the isolated spike; existing Durable/Fallow runtime paths and root dependencies were unchanged. Preserve these commits as partial evidence, not completion of the assignment.

## Findings

1. **High — requested authority is absent.** There is no persisted pre-spawn intent/capability, authenticated reconnect, live supervisor state machine, completed-output recovery or cross-connection launch deduplication. The bootstrap consumes random bytes but does not validate or use their value. It proves pipe delivery and survival only.
2. **Medium — fixture lifetime is not guaranteed through final output.** `standalone-bootstrap/supervisor-fixture.mjs` clears its expiry immediately after initiating the `ALIVE` write. A stalled write can keep the fixture alive beyond the intended expiry. The current passing test does not exercise blocked output. Keep a finite expiry through confirmed completion/exit and add a deterministic stalled-output test before treating fixture lifecycle as safe. No such repair is included in this audit.
3. **Medium — peer policy is unresolved.** The merged design calls native peer checks supplementary where available, yet also requires blocking if they cannot be established. Pure Node capability authentication has not been approved as an alternative. Missing a Node accessor is not proof that Darwin lacks native APIs. No handshake should silently weaken this gate.
4. **Incomplete — protocol helpers are not authentication.** MAC verification and sequence checking exist independently; callers must still implement and verify fresh challenges, instance/attempt/binding equality, handshake transitions, request semantics, transport timeouts and service lifetimes. Payload semantics and live authority are absent. Unit tests do not establish replay protection across sessions or completion provenance.
5. **Low — framing documentation needs correction.** The protocol README describes a length range of 1–65536, while the implementation correctly rejects lengths at or below the 32-byte tag size. A future revision should specify the exact accepted framing grammar rather than the wider illustrative range.

## Independent checks

The parent reran both milestone suites together: **5 tests passed, 0 failed**. Root `npm test` passed (**434 tests**), `npm run check:bundle` passed, and `npm pack --dry-run --json --ignore-scripts` excluded all spike files. `git diff --check 23854d6` passed. A process-list check immediately after stopping the orchestration found no command-line matches for `standalone-bootstrap` or `standalone-protocol`; that bounded observation is not a complete leak/containment proof. No analyzer was executed by this audit, and the analyzer-backed spike suite was not rerun.

## Required decision before resuming

Choose and independently review one explicit policy:

- **Capability-only synthetic experiment:** allow inherited secret bootstrap plus mutual capability authentication under the documented trusted-same-user assumption; native peer credentials are an optional observation and must never be reported as verified when absent. This requires an explicit design amendment and operator approval, not an inferred fallback.
- **Native peer credentials required:** keep the prototype blocked until a supported helper/API investigation and its build/deployment scope are separately authorized. Do not install or compile a helper under the present assignment.

Neither option solves same-UID adversaries, race-safe signalling or descendant containment. Both remain no-go for Durable integration and production.

Before any renewed run, repair the self-expiry gap, approve a precise small protocol/lifecycle slice, and use operator-selected finite repair/provider-call ceilings if desired. An unchanged blocker should end with attention rather than an implementation report that triggers another automatic repair round. Do not start a replacement run merely because this audit exists.
