import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	Harness,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
	ContractError,
	MAX_PRESENTED_FINDINGS,
	MAX_SELECTIONS,
	POLICY_VERSION,
	TASK_DEFINITION_VERSION,
	type AdmissionPayload,
	type AttemptRecord,
	type EvidenceRecord,
	type InvestigationCheckpoint,
	type InvestigationRecord,
	type InvestigationReport,
	type InvestigationRequest,
	type InvestigationTaskInput,
	type InvestigationTaskResult,
	type LedgerState,
	type OperationKind,
	type OperationRecord,
} from "./contracts.ts";
import { publishAndValidateArtifact, validatePublishedArtifact } from "./artifacts.ts";
import { inspectAnalyzer, materializeSnapshot, verifyAnalyzer, verifySnapshot } from "./snapshot.ts";
import { digestJson, execArgv, pathExists, randomToken } from "./util.ts";

export const context = BACKGROUND_CONTEXT;

export const LedgerDoc = defineDoc<LedgerState>({
	kind: "pi-fallow.spike.ledger",
	version: 1,
	scope: "session",
	checkpointWhen: () => true,
	initial: () => ({
		nextInvestigation: 1,
		nextOperation: 1,
		nextAttempt: 1,
		requests: {},
		investigations: {},
		operations: {},
		attempts: {},
		evidence: {},
	}),
});

export interface TaskHost {
	ownedRoot: string;
	analyzerEnv?: Record<string, string>;
	barrier?(name: string, ids: { investigationId: string; operationId?: string; attemptId?: string }): Promise<void>;
}

class ScriptedFakeSelector {
	select(evidence: EvidenceRecord, limit: number): Array<{ kind: "inspect" | "trace"; targetFindingId: string }> {
		const selected = evidence.findings.slice(0, Math.min(limit, MAX_SELECTIONS));
		return selected.flatMap((finding, index) => index === 0
			? [{ kind: "inspect" as const, targetFindingId: finding.id }, { kind: "trace" as const, targetFindingId: finding.id }]
			: [{ kind: "inspect" as const, targetFindingId: finding.id }]);
	}
}

export function createInvestigationTask(host: TaskHost, version = TASK_DEFINITION_VERSION) {
	const selector = new ScriptedFakeSelector();
	return defineTask<InvestigationTaskInput, InvestigationCheckpoint, InvestigationTaskResult>({
		name: "pi-fallow.spike.investigation",
		version,
		initial: () => ({ phase: "prepare" }),
		phases: {
			prepare: async (task, runtime, taskContext) => {
				assertDefinition(task.input);
				await runtime.commit(async (tx) => {
					const ledger = await tx.doc(LedgerDoc);
					const investigation = requireInvestigation(ledger, task.input.investigationId);
					investigation.status = "running";
					let operation = investigation.operationIds.map((id) => ledger.operations[id]!).find((item) => item.kind === "scan");
					if (!operation) operation = createOperation(ledger, investigation, "scan");
					return { status: "running", checkpoint: { phase: "intent", operationId: operation.id } };
				}, taskContext);
			},
			intent: async (task, runtime, taskContext) => {
				await runtime.commit(async (tx) => {
					const ledger = await tx.doc(LedgerDoc);
					const investigation = requireInvestigation(ledger, task.input.investigationId);
					const operation = requireOperation(ledger, task.state.checkpoint.operationId);
					if (operation.activeAttemptId) {
						return { status: "running", checkpoint: { phase: "launch", operationId: operation.id, attemptId: operation.activeAttemptId } };
					}
					const attempt = createAttempt(ledger, investigation, operation, host.ownedRoot);
					operation.status = "intent-committed";
					operation.activeAttemptId = attempt.id;
					operation.attemptIds.push(attempt.id);
					return { status: "running", checkpoint: { phase: "launch", operationId: operation.id, attemptId: attempt.id } };
				}, taskContext);
			},
			launch: async (task, runtime, taskContext) => {
				const { operationId, attemptId } = task.state.checkpoint;
				const launchMemo = `launch:${attemptId}`;
				const existingLaunch = await runtime.memo<string>(launchMemo, taskContext);
				if (existingLaunch !== undefined) {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "reconcile", operationId, attemptId } }), taskContext);
					return;
				}
				await runtime.memo(launchMemo, attemptId, taskContext);
				await runtime.commit(async (tx) => {
					const ledger = await tx.doc(LedgerDoc);
					const attempt = requireAttempt(ledger, attemptId);
					attempt.status = "launch-uncertain";
				}, taskContext);
				await host.barrier?.("after-launch-intent", { investigationId: task.input.investigationId, operationId, attemptId });
				const snapshot = await runtime.snapshot(LedgerDoc, taskContext);
				const investigation = requireInvestigation(snapshot!, task.input.investigationId);
				const operation = requireOperation(snapshot!, operationId);
				const attempt = requireAttempt(snapshot!, attemptId);
				try {
					await verifySnapshot(investigation.payload.snapshot);
					await verifyAnalyzer(investigation.payload.analyzer);
				} catch (error) {
					await blockAttempt(runtime, taskContext, attemptId, operationId, contractMessage(error));
					return;
				}
				if (runtime.now() >= attempt.deadlineAt) {
					await blockAttempt(runtime, taskContext, attemptId, operationId, "deadline-exceeded");
					return;
				}
				await mkdir(dirname(join(host.ownedRoot, attempt.stagingRelativePath)), { recursive: true });
				const result = await execArgv(attempt.approvedArgv, {
					env: { ...host.analyzerEnv },
					maxBytes: 16 * 1024,
					signal: runtime.signal,
					onSpawn: async (pid) => {
						await runtime.commit(async (tx) => {
							const ledger = await tx.doc(LedgerDoc);
							const current = requireAttempt(ledger, attemptId);
							current.pid = pid;
							current.status = "running";
							requireOperation(ledger, operationId).status = "running";
						}, taskContext);
					},
				});
				if (runtime.signal.aborted) return;
				if (result.code !== 0) {
					await failAttempt(runtime, taskContext, attemptId, operationId, `analyzer-exit-${result.code}: ${result.stderr.slice(0, 300)}`);
					return;
				}
				const evidence = await publishAndValidateArtifact(host.ownedRoot, attempt, operation, investigation.payload.selectionLimit);
				await host.barrier?.("after-artifact-publication", { investigationId: task.input.investigationId, operationId, attemptId });
				await commitEvidence(runtime, taskContext, task.input.investigationId, operation, attempt, evidence);
			},
			reconcile: async (task, runtime, taskContext) => {
				const { operationId, attemptId } = task.state.checkpoint;
				const ledger = await runtime.snapshot(LedgerDoc, taskContext);
				const investigation = requireInvestigation(ledger!, task.input.investigationId);
				const operation = requireOperation(ledger!, operationId);
				const attempt = requireAttempt(ledger!, attemptId);
				const committed = ledger!.evidence[operationId];
				if (committed) {
					await runtime.commit(() => ({ status: "running", checkpoint: nextCheckpoint(ledger!, investigation) }), taskContext);
					return;
				}
				if (await pathExists(join(host.ownedRoot, attempt.artifactRelativePath)) || await pathExists(join(host.ownedRoot, attempt.stagingRelativePath))) {
					try {
						const evidence = await publishAndValidateArtifact(host.ownedRoot, attempt, operation, investigation.payload.selectionLimit);
						await commitEvidence(runtime, taskContext, investigation.id, operation, attempt, evidence);
						return;
					} catch (error) {
						await blockAttempt(runtime, taskContext, attemptId, operationId, contractMessage(error));
						return;
					}
				}
				if (runtime.now() >= attempt.deadlineAt) {
					await blockAttempt(runtime, taskContext, attemptId, operationId, "deadline-exceeded-after-restart");
					return;
				}
				const receiptExists = await pathExists(join(host.ownedRoot, attempt.processReceiptRelativePath));
				await blockAttempt(runtime, taskContext, attemptId, operationId, receiptExists ? "hard-death-process-ownership-unproven" : "launch-uncertain-no-process-receipt");
			},
			select: async (task, runtime, taskContext) => {
				await runtime.commit(async (tx) => {
					const ledger = await tx.doc(LedgerDoc);
					const investigation = requireInvestigation(ledger, task.input.investigationId);
					const scan = investigation.operationIds.map((id) => ledger.operations[id]!).find((item) => item.kind === "scan");
					if (!scan) throw new ContractError("scan-missing", "scan operation is missing");
					const scanEvidence = ledger.evidence[scan.id];
					if (!scanEvidence) return { status: "running", checkpoint: { phase: "report" } };
					for (const selected of selector.select(scanEvidence, investigation.payload.selectionLimit)) {
						const duplicate = investigation.operationIds.map((id) => ledger.operations[id]!).find((item) => item.kind === selected.kind && item.targetFindingId === selected.targetFindingId);
						if (!duplicate) createOperation(ledger, investigation, selected.kind, selected.targetFindingId);
					}
					const planned = investigation.operationIds.map((id) => ledger.operations[id]!).find((item) => item.status === "planned");
					return { status: "running", checkpoint: planned ? { phase: "intent", operationId: planned.id } : { phase: "report" } };
				}, taskContext);
			},
			report: async (task, runtime, taskContext) => {
				await host.barrier?.("before-report-commit", { investigationId: task.input.investigationId });
				await runtime.commit(async (tx) => {
					const ledger = await tx.doc(LedgerDoc);
					const investigation = requireInvestigation(ledger, task.input.investigationId);
					investigation.report = await buildReport(host.ownedRoot, ledger, investigation);
					investigation.status = reportStatus(investigation.report);
					return { status: "terminal", outcome: { status: "completed", result: { investigationId: investigation.id, status: investigation.status } } };
				}, taskContext);
			},
		},
		abort: async (task, runtime, taskContext) => {
			await runtime.commit(async (tx) => {
				const ledger = await tx.doc(LedgerDoc);
				const investigation = requireInvestigation(ledger, task.input.investigationId);
				investigation.status = "cancelled";
				investigation.message = "durable cancellation intent committed; late results fenced";
				for (const operationId of investigation.operationIds) {
					const operation = ledger.operations[operationId]!;
					if (["completed", "failed", "blocked"].includes(operation.status)) continue;
					operation.status = "cancelled";
					if (operation.activeAttemptId) {
						const attempt = ledger.attempts[operation.activeAttemptId]!;
						attempt.status = "cancelled";
						attempt.cancelRequestedAt = runtime.now();
					}
				}
				return { status: "terminal", outcome: { status: "aborted" } };
			}, taskContext);
		},
	});
}

function assertDefinition(input: InvestigationTaskInput): void {
	if (input.definitionContract !== `${POLICY_VERSION}:task-v${TASK_DEFINITION_VERSION}`) {
		throw new ContractError("definition-incompatible", "task definition contract is incompatible");
	}
}

function createOperation(ledger: LedgerState, investigation: InvestigationRecord, kind: OperationKind, targetFindingId?: string): OperationRecord {
	if (!["scan", "inspect", "trace"].includes(kind)) throw new ContractError("operation-forbidden", `operation is forbidden: ${kind}`);
	if (kind === "scan" && targetFindingId) throw new ContractError("operation-target", "scan cannot have a target");
	if (kind !== "scan" && !targetFindingId) throw new ContractError("operation-target", `${kind} requires a retained finding target`);
	const id = `op-${ledger.nextOperation++}`;
	const operation: OperationRecord = { id, investigationId: investigation.id, kind, ...(targetFindingId ? { targetFindingId } : {}), status: "planned", attemptIds: [] };
	ledger.operations[id] = operation;
	investigation.operationIds.push(id);
	return operation;
}

function createAttempt(ledger: LedgerState, investigation: InvestigationRecord, operation: OperationRecord, ownedRoot: string): AttemptRecord {
	if (operation.activeAttemptId) throw new ContractError("duplicate-operation", `operation ${operation.id} already has an active attempt`);
	if (operation.kind !== "scan") {
		const scanEvidence = Object.values(ledger.evidence).find((item) => item.kind === "scan" && item.operationId !== operation.id);
		if (!scanEvidence?.findings.some((finding) => finding.id === operation.targetFindingId)) throw new ContractError("target-not-retained", "operation target is not a retained finding from this investigation");
	}
	const id = `attempt-${ledger.nextAttempt++}`;
	const launchToken = randomToken();
	const stagingRelativePath = join("staging", id, "result.json");
	const artifactRelativePath = join("artifacts", `${id}.json`);
	const processReceiptRelativePath = join("process-receipts", `${id}.json`);
	const approvedArgv = [
		process.execPath,
		investigation.payload.analyzer.executablePath,
		operation.kind,
		"--root", investigation.payload.snapshot.materializedPath,
		"--output", join(ownedRoot, stagingRelativePath),
		"--receipt", join(ownedRoot, processReceiptRelativePath),
		"--token", launchToken,
		...(operation.targetFindingId ? ["--target", operation.targetFindingId] : []),
	];
	const attempt: AttemptRecord = {
		id,
		operationId: operation.id,
		status: "intent-committed",
		createdAt: Date.now(),
		deadlineAt: investigation.payload.deadlineAt,
		approvedArgv,
		stagingRelativePath,
		artifactRelativePath,
		launchToken,
		processReceiptRelativePath,
	};
	ledger.attempts[id] = attempt;
	return attempt;
}

async function commitEvidence(runtime: any, taskContext: any, investigationId: string, operation: OperationRecord, attempt: AttemptRecord, evidence: EvidenceRecord): Promise<void> {
	await runtime.commit(async (tx: any) => {
		const ledger = await tx.doc(LedgerDoc);
		const investigation = requireInvestigation(ledger, investigationId);
		const currentOperation = requireOperation(ledger, operation.id);
		const currentAttempt = requireAttempt(ledger, attempt.id);
		if (investigation.status === "cancelled" || currentAttempt.cancelRequestedAt !== undefined) {
			currentAttempt.status = "cancelled";
			currentOperation.status = "cancelled";
			return { status: "terminal", outcome: { status: "aborted" } };
		}
		ledger.evidence[currentOperation.id] = evidence;
		currentAttempt.status = "evidence-committed";
		currentOperation.status = "completed";
		delete currentOperation.activeAttemptId;
		if (!investigation.evidenceOperationIds.includes(currentOperation.id)) investigation.evidenceOperationIds.push(currentOperation.id);
		return { status: "running", checkpoint: nextCheckpoint(ledger, investigation) };
	}, taskContext);
}

function nextCheckpoint(ledger: LedgerState, investigation: InvestigationRecord): InvestigationCheckpoint {
	const planned = investigation.operationIds.map((id) => ledger.operations[id]!).find((operation) => operation.status === "planned");
	if (planned) return { phase: "intent", operationId: planned.id };
	const scan = investigation.operationIds.map((id) => ledger.operations[id]!).find((operation) => operation.kind === "scan");
	const hasDetails = investigation.operationIds.some((id) => ledger.operations[id]!.kind !== "scan");
	if (scan?.status === "completed" && !hasDetails) return { phase: "select" };
	return { phase: "report" };
}

async function blockAttempt(runtime: any, taskContext: any, attemptId: string, operationId: string, message: string): Promise<void> {
	await runtime.commit(async (tx: any) => {
		const ledger = await tx.doc(LedgerDoc);
		const attempt = requireAttempt(ledger, attemptId);
		const operation = requireOperation(ledger, operationId);
		const investigation = requireInvestigation(ledger, operation.investigationId);
		attempt.status = "blocked";
		attempt.message = message;
		operation.status = "blocked";
		operation.message = message;
		investigation.status = "blocked";
		investigation.message = message;
		return { status: "running", checkpoint: { phase: "report" } };
	}, taskContext);
}

async function failAttempt(runtime: any, taskContext: any, attemptId: string, operationId: string, message: string): Promise<void> {
	await runtime.commit(async (tx: any) => {
		const ledger = await tx.doc(LedgerDoc);
		requireAttempt(ledger, attemptId).status = "failed";
		const operation = requireOperation(ledger, operationId);
		operation.status = "failed";
		operation.message = message;
		const investigation = requireInvestigation(ledger, operation.investigationId);
		investigation.status = "failed";
		investigation.message = message;
		return { status: "running", checkpoint: { phase: "report" } };
	}, taskContext);
}

async function buildReport(ownedRoot: string, ledger: LedgerState, investigation: InvestigationRecord): Promise<InvestigationReport> {
	const sections: InvestigationReport["sections"] = [];
	const references = [];
	const notes = [
		"Evidence describes the fixed admitted snapshot, not the caller's current workspace.",
		"Dependency-resolution completeness remains an unresolved production gate.",
	];
	let findingsFound = 0;
	let findingsRetained = 0;
	let incomplete = false;
	for (const operationId of investigation.operationIds) {
		const operation = ledger.operations[operationId]!;
		const evidence = ledger.evidence[operationId];
		if (!evidence) {
			incomplete = true;
			sections.push({ operationId, kind: operation.kind, ...(operation.targetFindingId ? { targetFindingId: operation.targetFindingId } : {}), complete: false, message: operation.message ?? `evidence unavailable (${operation.status})`, findings: [] });
			continue;
		}
		try { await validatePublishedArtifact(ownedRoot, evidence); }
		catch (error) {
			incomplete = true;
			sections.push({ operationId, kind: operation.kind, ...(operation.targetFindingId ? { targetFindingId: operation.targetFindingId } : {}), complete: false, message: contractMessage(error), findings: [] });
			continue;
		}
		references.push(evidence.artifact);
		findingsFound += operation.kind === "scan" ? evidence.findingCount : 0;
		findingsRetained += operation.kind === "scan" ? evidence.retainedCount : 0;
		if (!evidence.complete) incomplete = true;
		sections.push({
			operationId,
			kind: operation.kind,
			...(operation.targetFindingId ? { targetFindingId: operation.targetFindingId } : {}),
			complete: evidence.complete,
			message: evidence.complete ? "verified artifact evidence" : `incomplete: ${evidence.completenessReason ?? "unspecified"}`,
			findings: evidence.findings.slice(0, MAX_PRESENTED_FINDINGS),
		});
	}
	const blocked = investigation.status === "blocked";
	const cancelled = investigation.status === "cancelled";
	return {
		investigationId: investigation.id,
		snapshot: {
			contentSha256: investigation.payload.snapshot.contentSha256,
			configSha256: investigation.payload.snapshot.configSha256,
			baseCommit: investigation.payload.snapshot.baseCommit,
			baseTree: investigation.payload.snapshot.baseTree,
			files: investigation.payload.snapshot.files,
		},
		status: cancelled ? "cancelled" : blocked ? "blocked" : incomplete ? "incomplete" : "complete",
		findingsFound,
		findingsRetained,
		selectedOperations: investigation.operationIds.filter((id) => ledger.operations[id]!.kind !== "scan").length,
		presentationTruncated: sections.some((section) => {
			const evidence = ledger.evidence[section.operationId];
			return evidence ? evidence.retainedCount > MAX_PRESENTED_FINDINGS : false;
		}),
		artifactReferences: references,
		sections,
		notes,
	};
}

function reportStatus(report: InvestigationReport): InvestigationRecord["status"] {
	if (report.status === "complete") return "completed";
	if (report.status === "cancelled") return "cancelled";
	if (report.status === "blocked") return "blocked";
	return "failed";
}

function requireInvestigation(ledger: LedgerState, id: string): InvestigationRecord {
	const value = ledger.investigations[id];
	if (!value) throw new ContractError("investigation-missing", `investigation not found: ${id}`);
	return value;
}
function requireOperation(ledger: LedgerState, id: string): OperationRecord {
	const value = ledger.operations[id];
	if (!value) throw new ContractError("operation-missing", `operation not found: ${id}`);
	return value;
}
function requireAttempt(ledger: LedgerState, id: string): AttemptRecord {
	const value = ledger.attempts[id];
	if (!value) throw new ContractError("attempt-missing", `attempt not found: ${id}`);
	return value;
}
function contractMessage(error: unknown): string {
	return error instanceof ContractError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
}

export interface OpenSpikeOptions {
	root: string;
	analyzerPath?: string;
	recoverOwnership?: boolean;
	registerTask?: boolean;
	taskVersion?: number;
	now?: () => number;
	taskHost?: Partial<Omit<TaskHost, "ownedRoot">>;
	storage?: Storage;
}

export class DurableInvestigationSpike {
	readonly ownedRoot: string;
	readonly databasePath: string;
	readonly lockPath: string;
	readonly analyzerPath: string;
	readonly harness: Harness;
	readonly task: ReturnType<typeof createInvestigationTask>;
	readonly rootConversation: Awaited<ReturnType<Harness["root"]>>;
	#lockNonce: string;
	#closed = false;

	private constructor(options: {
		ownedRoot: string;
		databasePath: string;
		lockPath: string;
		lockNonce: string;
		analyzerPath: string;
		harness: Harness;
		task: ReturnType<typeof createInvestigationTask>;
		rootConversation: Awaited<ReturnType<Harness["root"]>>;
	}) {
		Object.assign(this, options);
		this.ownedRoot = options.ownedRoot;
		this.databasePath = options.databasePath;
		this.lockPath = options.lockPath;
		this.#lockNonce = options.lockNonce;
		this.analyzerPath = options.analyzerPath;
		this.harness = options.harness;
		this.task = options.task;
		this.rootConversation = options.rootConversation;
	}

	static async open(options: OpenSpikeOptions): Promise<DurableInvestigationSpike> {
		const ownedRoot = resolve(options.root);
		await mkdir(ownedRoot, { recursive: true });
		const lockPath = join(ownedRoot, "owner.lock");
		const lockNonce = await acquireOwnerLock(lockPath, options.recoverOwnership === true);
		try {
			const analyzerPath = resolve(options.analyzerPath ?? new URL("./analyzer.mjs", import.meta.url).pathname);
			const task = createInvestigationTask({ ownedRoot, ...options.taskHost }, options.taskVersion ?? TASK_DEFINITION_VERSION);
			const registry = createRegistry();
			if (options.registerTask !== false) registry.install(defineExtension({ name: "pi-fallow-spike", tasks: [task] }));
			const storage = options.storage ?? await openNodeSqliteStorage(join(ownedRoot, "durable.sqlite"));
			const harness = await Harness.open(storage, { models: createModels(), registry, ...(options.now ? { now: options.now } : {}) }, context);
			const rootConversation = await harness.root(context);
			return new DurableInvestigationSpike({ ownedRoot, databasePath: join(ownedRoot, "durable.sqlite"), lockPath, lockNonce, analyzerPath, harness, task, rootConversation });
		} catch (error) {
			await releaseOwnerLock(lockPath, lockNonce);
			throw error;
		}
	}

	async admit(request: InvestigationRequest, options: { acknowledgementFailpoint?: boolean } = {}): Promise<InvestigationRecord> {
		validateRequest(request);
		const existing = await this.ledger();
		const previous = existing.requests[request.hostRequestId];
		if (previous) {
			const investigation = requireInvestigation(existing, previous.investigationId);
			const currentPayload = await this.preparePayload(request, `duplicate-${randomToken()}`);
			const currentDigest = payloadDigest(currentPayload);
			await rm(currentPayload.snapshot.materializedPath, { recursive: true, force: true });
			if (currentDigest !== previous.payloadDigest) throw new ContractError("request-conflict", "host request ID was reused with a different payload");
			return investigation;
		}
		const payload = await this.preparePayload(request, `candidate-${randomToken()}`);
		const digest = payloadDigest(payload);
		const admitted = await this.rootConversation.commit(async (tx) => {
			const ledger = await tx.doc(LedgerDoc);
			const raced = ledger.requests[request.hostRequestId];
			if (raced) {
				if (raced.payloadDigest !== digest) throw new ContractError("request-conflict", "host request ID was reused with a different payload");
				return requireInvestigation(ledger, raced.investigationId);
			}
			const id = `investigation-${ledger.nextInvestigation++}`;
			const taskId = await tx.createTask(this.task, { investigationId: id, definitionContract: `${POLICY_VERSION}:task-v${TASK_DEFINITION_VERSION}` }, { ownership: { kind: "conversation" } });
			const investigation: InvestigationRecord = {
				id,
				hostRequestId: request.hostRequestId,
				payloadDigest: digest,
				payload,
				taskId: taskId as number,
				status: "admitted",
				operationIds: [],
				evidenceOperationIds: [],
			};
			ledger.requests[request.hostRequestId] = { payloadDigest: digest, investigationId: id };
			ledger.investigations[id] = investigation;
			return investigation;
		}, context);
		if (options.acknowledgementFailpoint) throw new ContractError("acknowledgement-lost", "simulated acknowledgement loss after durable admission");
		return admitted;
	}

	async wait(investigationId: string): Promise<InvestigationRecord> {
		const record = requireInvestigation(await this.ledger(), investigationId);
		await this.harness.waitForTask(record.taskId as TaskId<InvestigationTaskResult>, context);
		return requireInvestigation(await this.ledger(), investigationId);
	}

	async requestOperation(investigationId: string, kind: string, targetFindingId?: string): Promise<OperationRecord> {
		if (kind !== "scan" && kind !== "inspect" && kind !== "trace") {
			throw new ContractError("operation-forbidden", `operation is forbidden: ${kind}`);
		}
		return this.rootConversation.commit(async (tx) => {
			const ledger = await tx.doc(LedgerDoc);
			const investigation = requireInvestigation(ledger, investigationId);
			const duplicate = investigation.operationIds
				.map((id) => ledger.operations[id]!)
				.find((operation) => operation.kind === kind && operation.targetFindingId === targetFindingId);
			if (duplicate) return JSON.parse(JSON.stringify(duplicate)) as OperationRecord;
			if (kind !== "scan") {
				const retained = investigation.evidenceOperationIds
					.map((id) => ledger.evidence[id])
					.some((evidence) => evidence?.kind === "scan" && evidence.findings.some((finding) => finding.id === targetFindingId));
				if (!retained) throw new ContractError("target-not-retained", "operation target is not retained scan evidence");
			}
			return JSON.parse(JSON.stringify(createOperation(ledger, investigation, kind, targetFindingId))) as OperationRecord;
		}, context);
	}

	resume(): void { this.harness.resume(); }

	async cancel(investigationId: string): Promise<string> {
		const ledger = await this.ledger();
		const investigation = requireInvestigation(ledger, investigationId);
		return this.harness.abortTask(investigation.taskId as TaskId, context);
	}

	async ledger(): Promise<LedgerState> {
		const value = (await this.harness.snapshot(LedgerDoc, context)) ?? LedgerDoc.definition.initial();
		return JSON.parse(JSON.stringify(value)) as LedgerState;
	}

	async investigation(id: string): Promise<InvestigationRecord> {
		return requireInvestigation(await this.ledger(), id);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.harness.close(context);
		await releaseOwnerLock(this.lockPath, this.#lockNonce);
	}

	async preparePayload(request: InvestigationRequest, snapshotName: string): Promise<AdmissionPayload> {
		return {
			sourceRepository: resolve(request.sourceRepository),
			deadlineAt: request.deadlineAt,
			selectionLimit: Math.min(request.selectionLimit ?? 2, MAX_SELECTIONS),
			snapshot: await materializeSnapshot(request.sourceRepository, this.ownedRoot, snapshotName),
			analyzer: await inspectAnalyzer(this.analyzerPath),
			policyVersion: POLICY_VERSION,
		};
	}
}

function validateRequest(request: InvestigationRequest): void {
	if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(request.hostRequestId)) throw new ContractError("request-id", "host request ID is invalid");
	if (!Number.isSafeInteger(request.deadlineAt) || request.deadlineAt <= 0) throw new ContractError("deadline", "deadlineAt must be an absolute epoch millisecond");
	if (request.selectionLimit !== undefined && (!Number.isSafeInteger(request.selectionLimit) || request.selectionLimit < 0 || request.selectionLimit > MAX_SELECTIONS)) throw new ContractError("selection-limit", "selection limit is out of range");
}

function payloadDigest(payload: AdmissionPayload): string {
	return digestJson({
		sourceRepository: payload.sourceRepository,
		deadlineAt: payload.deadlineAt,
		selectionLimit: payload.selectionLimit,
		snapshot: { ...payload.snapshot, materializedPath: undefined },
		analyzer: payload.analyzer,
		policyVersion: payload.policyVersion,
	});
}

async function acquireOwnerLock(path: string, recover: boolean): Promise<string> {
	const nonce = randomToken();
	try {
		const handle = await open(path, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now() })}\n`);
		await handle.close();
		return nonce;
	} catch (error: any) {
		if (error?.code !== "EEXIST") throw error;
		if (!recover) throw new ContractError("storage-owned", "storage already has an owner; Durable itself supplies no cross-process ownership lock");
		const stale = `${path}.stale-${Date.now()}-${randomToken()}`;
		await rename(path, stale);
		return acquireOwnerLock(path, false);
	}
}

async function releaseOwnerLock(path: string, nonce: string): Promise<void> {
	try {
		const value = JSON.parse(await readFile(path, "utf8"));
		if (value.nonce === nonce) await rm(path, { force: true });
	} catch {}
}
