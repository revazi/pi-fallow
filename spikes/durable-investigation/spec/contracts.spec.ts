import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Storage } from "@earendil-works/pi-durable";
import { ContractError, MAX_ARTIFACT_BYTES, type AttemptRecord, type OperationRecord } from "../src/contracts.ts";
import { publishAndValidateArtifact } from "../src/artifacts.ts";
import { context, DurableInvestigationSpike, LedgerDoc } from "../src/durable.ts";
import { execArgv } from "../src/util.ts";
import { fixture, killAndWait, spawnWorker, waitForPath } from "./helpers.ts";

const future = () => Date.now() + 120_000;

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
	await assert.rejects(promise, (error: unknown) => error instanceof ContractError && error.code === code);
}

async function happy(): Promise<{ fx: Awaited<ReturnType<typeof fixture>>; spike: DurableInvestigationSpike; id: string }> {
	const fx = await fixture();
	const spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer });
	const admitted = await spike.admit({ hostRequestId: "happy", sourceRepository: fx.repo, deadlineAt: future() });
	const complete = await spike.wait(admitted.id);
	assert.equal(complete.status, "completed");
	assert.equal(complete.report?.status, "complete");
	return { fx, spike, id: admitted.id };
}

test("explicit admission deduplicates identical requests, rejects conflicting payloads, and survives lost acknowledgement", async () => {
	const fx = await fixture();
	let spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer });
	const request = { hostRequestId: "host-1", sourceRepository: fx.repo, deadlineAt: future(), selectionLimit: 2 };
	await expectCode(spike.admit(request, { acknowledgementFailpoint: true }), "acknowledgement-lost");
	const repeated = await spike.admit(request);
	const again = await spike.admit(request);
	assert.equal(repeated.id, again.id);
	await expectCode(spike.admit({ ...request, deadlineAt: request.deadlineAt + 1 }), "request-conflict");
	await spike.close();
	spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer });
	assert.equal((await spike.admit(request)).id, repeated.id);
	await spike.close();
});

test("the vertical slice records separate operation/attempt identities and idempotent duplicate operations", async () => {
	const { spike, id } = await happy();
	const ledger = await spike.ledger();
	const investigation = ledger.investigations[id]!;
	assert.ok(investigation.operationIds.length >= 3);
	assert.equal(new Set(investigation.operationIds).size, investigation.operationIds.length);
	for (const operationId of investigation.operationIds) {
		const operation = ledger.operations[operationId]!;
		assert.equal(operation.attemptIds.length, 1);
		assert.notEqual(operation.attemptIds[0], operation.id);
	}
	const scanEvidence = ledger.evidence[investigation.operationIds[0]!]!;
	const target = scanEvidence.findings[0]!.id;
	const first = await spike.requestOperation(id, "inspect", target);
	const duplicate = await spike.requestOperation(id, "inspect", target);
	assert.equal(first.id, duplicate.id);
	await expectCode(spike.requestOperation(id, "fix-apply", target), "operation-forbidden");
	await expectCode(spike.requestOperation(id, "shell", target), "operation-forbidden");
	await expectCode(spike.requestOperation(id, "setup", target), "operation-forbidden");
	await expectCode(spike.requestOperation(id, "cloud", target), "operation-forbidden");
	await spike.close();
});

test("retained targets are scoped to their own investigation when a ledger contains multiple scans", async () => {
	const first = await fixture("first-scan-");
	const second = await fixture("second-scan-");
	await writeFile(join(second.repo, "a.ts"), "// TODO distinct second snapshot\n");
	await execArgv(["git", "-C", second.repo, "add", "."]);
	await execArgv(["git", "-C", second.repo, "commit", "-qm", "distinct snapshot"]);
	const spike = await DurableInvestigationSpike.open({ root: first.state, analyzerMode: "controlled", analyzerPath: first.analyzer });
	try {
		const a = await spike.admit({ hostRequestId: "first", sourceRepository: first.repo, deadlineAt: future() });
		assert.equal((await spike.wait(a.id)).status, "completed");
		const aLedger = await spike.ledger();
		const target = aLedger.evidence[aLedger.investigations[a.id]!.operationIds[0]!]!.findings[0]!.id;
		const b = await spike.admit({ hostRequestId: "second", sourceRepository: second.repo, deadlineAt: future() });
		const completed = await spike.wait(b.id);
		assert.equal(completed.status, "completed");
		await expectCode(spike.requestOperation(b.id, "inspect", target), "target-not-retained");
		await expectCode(spike.requestOperation(b.id, "trace", target), "target-not-retained");
	} finally {
		await spike.close();
	}
});

test("detail launch blocks if its retained scan artifact changes after evidence commit", async () => {
	const fx = await fixture("retained-drift-");
	let spike!: DurableInvestigationSpike;
	let altered = false;
	spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer, taskHost: {
		barrier: async (name, ids) => {
			if (name !== "after-launch-intent" || altered) return;
			const ledger = await spike.ledger();
			const operation = ledger.operations[ids.operationId!]!;
			if (operation.kind === "scan") return;
			const investigation = ledger.investigations[ids.investigationId]!;
			const scanId = investigation.evidenceOperationIds.find((id) => ledger.operations[id]!.kind === "scan")!;
			await writeFile(join(spike.ownedRoot, ledger.evidence[scanId]!.artifact.relativePath), "{}\n");
			altered = true;
		},
	} });
	try {
		const admitted = await spike.admit({ hostRequestId: "retained-drift", sourceRepository: fx.repo, deadlineAt: future() });
		const result = await spike.wait(admitted.id);
		assert.ok(altered);
		assert.equal(result.status, "blocked");
		assert.match(result.message ?? "", /artifact-corrupt/);
		const ledger = await spike.ledger();
		const detail = result.operationIds.map((id) => ledger.operations[id]!).find((op) => op.kind !== "scan")!;
		assert.equal(ledger.attempts[detail.attemptIds[0]!]!.pid, undefined);
	} finally { await spike.close(); }
});

test("detail launch blocks when ledger finding data no longer matches retained artifact", async () => {
	const fx = await fixture("retained-ledger-drift-");
	let spike!: DurableInvestigationSpike;
	let altered = false;
	spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer, taskHost: {
		barrier: async (name, ids) => {
			if (name !== "after-launch-intent" || altered) return;
			const ledger = await spike.ledger();
			const operation = ledger.operations[ids.operationId!]!;
			if (operation.kind === "scan") return;
			await spike.rootConversation.commit(async (tx) => {
				const state = await tx.doc(LedgerDoc);
				const scanId = state.investigations[ids.investigationId]!.evidenceOperationIds[0]!;
				state.evidence[scanId]!.findings.find((finding) => finding.id === operation.targetFindingId)!.path = "forged.ts";
			}, context);
			altered = true;
		},
	} });
	try {
		const admitted = await spike.admit({ hostRequestId: "retained-ledger-drift", sourceRepository: fx.repo, deadlineAt: future() });
		const result = await spike.wait(admitted.id);
		assert.ok(altered);
		assert.equal(result.status, "blocked");
		assert.match(result.message ?? "", /retained-target-binding/);
		const ledger = await spike.ledger();
		const detail = result.operationIds.map((id) => ledger.operations[id]!).find((op) => op.kind !== "scan")!;
		assert.equal(ledger.attempts[detail.attemptIds[0]!]!.pid, undefined);
	} finally { await spike.close(); }
});

test("intent committed but launch uncertain blocks after an actual host SIGKILL without launching a duplicate", async () => {
	const fx = await fixture();
	const reached = join(fx.root, "launch.reached");
	const release = join(fx.root, "launch.release");
	const ready = join(fx.root, "worker.ready");
	const { child } = await spawnWorker({ analyzerMode: "controlled",
		root: fx.state,
		ready,
		request: { hostRequestId: "kill-before-launch", sourceRepository: fx.repo, deadlineAt: future() },
		barrier: { name: "after-launch-intent", reached, release },
	});
	await waitForPath(reached);
	await killAndWait(child);
	const spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer, recoverOwnership: true });
	const id = (await readFile(ready, "utf8")).trim();
	const recovered = await spike.wait(id);
	assert.equal(recovered.status, "blocked");
	assert.match(recovered.message ?? "", /launch-uncertain-no-process-receipt/);
	const attempts = Object.values((await spike.ledger()).attempts);
	assert.equal(attempts.length, 1);
	await spike.close();
});

test("the absolute deadline terminates a live analyzer and blocks its attempt", { timeout: 10000 }, async () => {
	const fx = await fixture("live-deadline-");
	const reached = join(fx.root, "analyzer.reached");
	const release = join(fx.root, "analyzer.release");
	const spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer, taskHost: { analyzerEnv: { SPIKE_BARRIER_PATH: reached, SPIKE_RELEASE_PATH: release } } });
	try {
		const admitted = await spike.admit({ hostRequestId: "live-deadline", sourceRepository: fx.repo, deadlineAt: Date.now() + 2000 });
		spike.resume();
		await waitForPath(reached);
		const result = await spike.wait(admitted.id);
		assert.equal(result.status, "blocked");
		assert.match(result.message ?? "", /deadline-exceeded/);
		const ledger = await spike.ledger();
		const attempt = Object.values(ledger.attempts)[0]!;
		assert.equal(attempt.status, "blocked");
		assert.equal(Object.keys(ledger.evidence).length, 0);
	} finally { await spike.close(); }
});

test("hard host death while the analyzer is active blocks because process ownership is unproven", async () => {
	const fx = await fixture();
	const analyzerReached = join(fx.root, "hard-death-analyzer.reached");
	const analyzerRelease = join(fx.root, "hard-death-analyzer.release");
	const ready = join(fx.root, "worker.ready");
	const { child } = await spawnWorker({ analyzerMode: "controlled",
		root: fx.state,
		ready,
		request: { hostRequestId: "hard-death-active", sourceRepository: fx.repo, deadlineAt: future() },
		analyzerEnv: { SPIKE_BARRIER_PATH: analyzerReached, SPIKE_RELEASE_PATH: analyzerRelease },
	});
	await waitForPath(analyzerReached);
	await killAndWait(child);
	const spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer, recoverOwnership: true });
	const id = (await readFile(ready, "utf8")).trim();
	const recovered = await spike.wait(id);
	assert.equal(recovered.status, "blocked");
	assert.match(recovered.message ?? "", /hard-death-process-ownership-unproven/);
	assert.equal(Object.keys((await spike.ledger()).attempts).length, 1);
	await writeFile(analyzerRelease, "release\n");
	const attempt = Object.values((await spike.ledger()).attempts)[0]!;
	await waitForPath(join(spike.ownedRoot, attempt.stagingRelativePath));
	await spike.close();
});

test("artifact publication is reconciled after an actual SIGKILL before evidence commit", async () => {
	const fx = await fixture();
	const reached = join(fx.root, "artifact.reached");
	const release = join(fx.root, "artifact.release");
	const ready = join(fx.root, "worker.ready");
	const { child } = await spawnWorker({ analyzerMode: "controlled",
		root: fx.state,
		ready,
		request: { hostRequestId: "kill-after-artifact", sourceRepository: fx.repo, deadlineAt: future() },
		barrier: { name: "after-artifact-publication", reached, release },
	});
	await waitForPath(reached);
	await killAndWait(child);
	const spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer, recoverOwnership: true });
	const recovered = await spike.wait((await readFile(ready, "utf8")).trim());
	assert.equal(recovered.status, "completed");
	assert.equal(recovered.report?.status, "complete");
	assert.ok(recovered.evidenceOperationIds.length >= 1);
	await spike.close();
});

test("persisted controlled argv drift blocks before process launch", async () => {
	const fx = await fixture("argv-drift-");
	let reached!: () => void;
	const barrierReached = new Promise<void>((resolve) => { reached = resolve; });
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	const spike = await DurableInvestigationSpike.open({
		root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer,
		taskHost: { barrier: async (name) => { if (name === "after-launch-intent") { reached(); await held; } } },
	});
	try {
		const investigation = await spike.admit({ hostRequestId: "argv-drift", sourceRepository: fx.repo, deadlineAt: future() });
		spike.resume();
		await barrierReached;
		await spike.rootConversation.commit(async (tx) => {
			const ledger = await tx.doc(LedgerDoc);
			const operation = ledger.operations[ledger.investigations[investigation.id]!.operationIds[0]!]!;
			ledger.attempts[operation.activeAttemptId!]!.approvedArgv.push("--unexpected");
		}, context);
		release();
		const result = await spike.wait(investigation.id);
		assert.equal(result.status, "blocked");
		assert.match(result.message ?? "", /attempt-contract/);
		assert.equal(result.evidenceOperationIds.length, 0);
	} finally { release(); await spike.close(); }
});

test("recovery blocks published evidence when snapshot or controlled executable has drifted", async (t) => {
	for (const kind of ["snapshot", "executable"] as const) {
		await t.test(kind, async () => {
			const fx = await fixture(`recovery-drift-${kind}-`);
			const reached = join(fx.root, "artifact.reached");
			const ready = join(fx.root, "worker.ready");
			const { child } = await spawnWorker({ analyzerMode: "controlled",
				root: fx.state, analyzerPath: fx.analyzer, ready,
				request: { hostRequestId: `recovery-drift-${kind}`, sourceRepository: fx.repo, deadlineAt: future() },
				barrier: { name: "after-artifact-publication", reached, release: join(fx.root, "artifact.release") },
			});
			await waitForPath(reached);
			await killAndWait(child);
			if (kind === "snapshot") {
				const [snapshot] = await readdir(join(fx.state, "snapshots"));
				await writeFile(join(fx.state, "snapshots", snapshot!, "a.ts"), "changed\n");
			} else {
				await writeFile(fx.analyzer, `${await readFile(fx.analyzer, "utf8")}\n// replaced\n`);
			}
			const spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer, recoverOwnership: true });
			try {
				const result = await spike.wait((await readFile(ready, "utf8")).trim());
				assert.equal(result.status, "blocked");
				assert.match(result.message ?? "", /drift/);
				assert.equal(result.evidenceOperationIds.length, 0);
				assert.equal(Object.keys((await spike.ledger()).attempts).length, 1);
			} finally { await spike.close(); }
		});
	}
});

test("committed evidence is recovered into a report after an actual SIGKILL before report completion", async () => {
	const fx = await fixture();
	const reached = join(fx.root, "report.reached");
	const release = join(fx.root, "report.release");
	const ready = join(fx.root, "worker.ready");
	const { child } = await spawnWorker({ analyzerMode: "controlled",
		root: fx.state,
		ready,
		request: { hostRequestId: "kill-before-report", sourceRepository: fx.repo, deadlineAt: future() },
		barrier: { name: "before-report-commit", reached, release },
	});
	await waitForPath(reached);
	await killAndWait(child);
	const spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer, recoverOwnership: true });
	const recovered = await spike.wait((await readFile(ready, "utf8")).trim());
	assert.equal(recovered.status, "completed");
	assert.ok(recovered.report?.artifactReferences.length);
	await spike.close();
});

test("missing, malformed, oversized, and corrupt artifacts fail closed", async () => {
	const fx = await fixture();
	const owned = fx.state;
	await mkdir(join(owned, "staging", "a"), { recursive: true });
	const attempt: AttemptRecord = {
		id: "a", operationId: "o", status: "artifact-published", createdAt: 1, deadlineAt: future(), approvedArgv: [],
		stagingRelativePath: "staging/a/result.json", artifactRelativePath: "artifacts/a.json", launchToken: "t", processReceiptRelativePath: "receipts/a.json",
	};
	const operation: OperationRecord = { id: "o", investigationId: "i", kind: "scan", status: "running", attemptIds: ["a"] };
	await expectCode(publishAndValidateArtifact(owned, attempt, operation, 1), "artifact-missing");
	await writeFile(join(owned, attempt.stagingRelativePath), "not-json");
	await expectCode(publishAndValidateArtifact(owned, attempt, operation, 1), "artifact-malformed");
	await writeFile(join(owned, attempt.stagingRelativePath), Buffer.alloc(MAX_ARTIFACT_BYTES + 1));
	await expectCode(publishAndValidateArtifact(owned, attempt, operation, 1), "artifact-oversized");
	const { spike, id } = await happy();
	const complete = await spike.investigation(id);
	const artifact = complete.report!.artifactReferences[0]!;
	await truncate(join(spike.ownedRoot, artifact.relativePath), 1);
	const ledger = await spike.ledger();
	const evidence = ledger.evidence[ledger.investigations[id]!.evidenceOperationIds[0]!]!;
	await assert.rejects(import("../src/artifacts.ts").then(({ validatePublishedArtifact }) => validatePublishedArtifact(spike.ownedRoot, evidence)));
	await spike.close();
});

test("snapshot, config, base, and executable identity are fixed and drift blocks execution", async (t) => {
	for (const kind of ["source-history", "snapshot-config", "snapshot-content", "executable"] as const) {
		await t.test(kind, async () => {
			const fx = await fixture(`drift-${kind}-`);
			let releaseBarrier!: () => void;
			const reached = new Promise<void>((resolvePromise) => { releaseBarrier = resolvePromise; });
			let continueBarrier!: () => void;
			const hold = new Promise<void>((resolvePromise) => { continueBarrier = resolvePromise; });
			const spike = await DurableInvestigationSpike.open({
				root: fx.state,
				analyzerMode: "controlled", analyzerPath: fx.analyzer,
				taskHost: { barrier: async (name) => { if (name === "after-launch-intent") { releaseBarrier(); await hold; } } },
			});
			const admitted = await spike.admit({ hostRequestId: `drift-${kind}`, sourceRepository: fx.repo, deadlineAt: future() });
			spike.resume();
			await reached;
			const current = await spike.investigation(admitted.id);
			if (kind === "source-history") {
				await writeFile(join(fx.repo, "new.ts"), "export const changed = true;\n");
				await execArgv(["git", "-C", fx.repo, "add", "."]);
				await execArgv(["git", "-C", fx.repo, "commit", "-qm", "changed after admission"]);
				continueBarrier();
				const done = await spike.wait(admitted.id);
				assert.equal(done.status, "completed");
				assert.equal(done.report?.snapshot.baseCommit, current.payload.snapshot.baseCommit);
			} else {
				if (kind === "snapshot-config") await writeFile(join(current.payload.snapshot.materializedPath, ".fallowrc.json"), "{}\n");
				if (kind === "snapshot-content") await writeFile(join(current.payload.snapshot.materializedPath, "a.ts"), "changed\n");
				if (kind === "executable") await writeFile(fx.analyzer, `${await readFile(fx.analyzer, "utf8")}\n// drift\n`);
				continueBarrier();
				const done = await spike.wait(admitted.id);
				assert.equal(done.status, "blocked");
				assert.match(done.message ?? "", /drift/);
			}
			await spike.close();
		});
	}
});

test("cancellation kills the controlled process, persists intent, and fences a late staged result", async () => {
	const fx = await fixture();
	const analyzerReached = join(fx.root, "analyzer.reached");
	const analyzerRelease = join(fx.root, "analyzer.release");
	const spike = await DurableInvestigationSpike.open({
		root: fx.state,
		analyzerMode: "controlled", analyzerPath: fx.analyzer,
		taskHost: { analyzerEnv: { SPIKE_BARRIER_PATH: analyzerReached, SPIKE_RELEASE_PATH: analyzerRelease } },
	});
	const admitted = await spike.admit({ hostRequestId: "cancel", sourceRepository: fx.repo, deadlineAt: future() });
	spike.resume();
	await waitForPath(analyzerReached);
	assert.equal(await spike.cancel(admitted.id), "marked");
	const cancelled = await spike.wait(admitted.id);
	assert.equal(cancelled.status, "cancelled");
	const ledger = await spike.ledger();
	const attempt = Object.values(ledger.attempts)[0]!;
	await mkdir(join(spike.ownedRoot, "staging", attempt.id), { recursive: true });
	await writeFile(join(spike.ownedRoot, attempt.stagingRelativePath), JSON.stringify({ operation: "scan", complete: true, findingCount: 0, findings: [] }));
	assert.equal(Object.keys((await spike.ledger()).evidence).length, 0);
	await spike.close();
});

test("an absolute deadline is not reset by restart", async () => {
	const fx = await fixture();
	const reached = join(fx.root, "deadline.reached");
	const release = join(fx.root, "deadline.release");
	const ready = join(fx.root, "worker.ready");
	const deadlineAt = Date.now() + 30_000;
	const { child } = await spawnWorker({ analyzerMode: "controlled", root: fx.state, ready, request: { hostRequestId: "deadline", sourceRepository: fx.repo, deadlineAt }, barrier: { name: "after-launch-intent", reached, release } });
	await waitForPath(reached);
	await killAndWait(child);
	const spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer, recoverOwnership: true, now: () => deadlineAt + 1 });
	const result = await spike.wait((await readFile(ready, "utf8")).trim());
	assert.equal(result.status, "blocked");
	assert.match(result.message ?? "", /deadline-exceeded-after-restart/);
	await spike.close();
});

test("a simulated post-commit storage failure has an uncertain outcome that is recovered by request ID", async () => {
	const fx = await fixture();
	await mkdir(fx.state, { recursive: true });
	const base = await openNodeSqliteStorage(join(fx.state, "durable.sqlite"));
	let armed = false;
	const storage = new Proxy(base as Storage, {
		get(target, property) {
			if (property !== "commit") {
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			}
			return async (...args: any[]) => {
				const result = await (target.commit as any)(...args);
				if (armed) { armed = false; throw new Error("simulated storage acknowledgement failure after commit"); }
				return result;
			};
		},
	});
	let spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer, storage });
	const request = { hostRequestId: "storage-uncertain", sourceRepository: fx.repo, deadlineAt: future() };
	armed = true;
	await assert.rejects(spike.admit(request), /simulated storage acknowledgement failure/);
	await spike.close();
	spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer });
	const recovered = await spike.admit(request);
	assert.equal(recovered.hostRequestId, request.hostRequestId);
	await spike.close();
});

test("missing and incompatible task definitions are visibly blocked", async (t) => {
	for (const mode of ["missing", "incompatible"] as const) {
		await t.test(mode, async () => {
			const fx = await fixture(`definition-${mode}-`);
			let spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer });
			const admitted = await spike.admit({ hostRequestId: mode, sourceRepository: fx.repo, deadlineAt: future() });
			await spike.close();
			spike = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer, registerTask: mode !== "missing", taskVersion: mode === "incompatible" ? 2 : 1 });
			const inspection = await spike.harness.inspect(context);
			const blocked = inspection.tasks.find((item) => item.record.id === admitted.taskId);
			assert.equal(blocked?.state.kind, "blocked");
			assert.ok(blocked?.state.kind === "blocked" && ["missing_task", "task_too_old", "migration_failed"].includes(blocked.state.reason));
			await spike.close();
		});
	}
});

test("a second storage owner is rejected; explicit stale-owner recovery is deliberate", async () => {
	const fx = await fixture();
	const first = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer });
	await expectCode(DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer }), "storage-owned");
	await first.close();
	await writeFile(join(fx.state, "owner.lock"), JSON.stringify({ pid: 999999, nonce: "stale" }));
	await expectCode(DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer }), "storage-owned");
	const recovered = await DurableInvestigationSpike.open({ root: fx.state, analyzerMode: "controlled", analyzerPath: fx.analyzer, recoverOwnership: true });
	await recovered.close();
});
