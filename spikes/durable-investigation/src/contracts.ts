export const POLICY_VERSION = "durable-investigation-spike/v1";
export const TASK_DEFINITION_VERSION = 1;
export const MAX_ARTIFACT_BYTES = 64 * 1024;
export const MAX_FINDINGS = 40;
export const MAX_SELECTIONS = 4;
export const MAX_PRESENTED_FINDINGS = 12;
export const MAX_OUTPUT_BYTES = 96 * 1024;

export type OperationKind = "scan" | "inspect" | "trace";
export type OperationStatus =
	| "planned"
	| "intent-committed"
	| "running"
	| "completed"
	| "cancelled"
	| "blocked"
	| "failed";
export type AttemptStatus =
	| "intent-committed"
	| "launch-uncertain"
	| "running"
	| "artifact-published"
	| "evidence-committed"
	| "cancelled"
	| "blocked"
	| "failed";

export interface SnapshotIdentity {
	contentSha256: string;
	configSha256: string;
	baseCommit: string;
	baseTree: string;
	files: number;
	materializedPath: string;
}

export interface AnalyzerIdentity {
	executablePath: string;
	sha256: string;
	version: string;
}

export interface InvestigationRequest {
	hostRequestId: string;
	sourceRepository: string;
	deadlineAt: number;
	selectionLimit?: number;
}

export interface AdmissionPayload {
	sourceRepository: string;
	deadlineAt: number;
	selectionLimit: number;
	snapshot: SnapshotIdentity;
	analyzer: AnalyzerIdentity;
	policyVersion: string;
}

export interface FindingEvidence {
	id: string;
	kind: string;
	path: string;
	line: number;
	summary: string;
}

export interface ArtifactReference {
	relativePath: string;
	sha256: string;
	bytes: number;
	kind: OperationKind;
	attemptId: string;
}

export interface EvidenceRecord {
	operationId: string;
	attemptId: string;
	kind: OperationKind;
	targetFindingId?: string;
	artifact: ArtifactReference;
	complete: boolean;
	completenessReason?: string;
	findingCount: number;
	retainedCount: number;
	selectionLimit: number;
	presentationLimit: number;
	findings: FindingEvidence[];
}

export interface AttemptRecord {
	id: string;
	operationId: string;
	status: AttemptStatus;
	createdAt: number;
	deadlineAt: number;
	approvedArgv: string[];
	stagingRelativePath: string;
	artifactRelativePath: string;
	launchToken: string;
	processReceiptRelativePath: string;
	pid?: number;
	cancelRequestedAt?: number;
	message?: string;
}

export interface OperationRecord {
	id: string;
	investigationId: string;
	kind: OperationKind;
	targetFindingId?: string;
	status: OperationStatus;
	attemptIds: string[];
	activeAttemptId?: string;
	message?: string;
}

export interface InvestigationRecord {
	id: string;
	hostRequestId: string;
	payloadDigest: string;
	payload: AdmissionPayload;
	taskId: number;
	status: "admitted" | "running" | "completed" | "cancelled" | "blocked" | "failed";
	operationIds: string[];
	evidenceOperationIds: string[];
	report?: InvestigationReport;
	message?: string;
}

export interface InvestigationReport {
	investigationId: string;
	snapshot: Omit<SnapshotIdentity, "materializedPath">;
	status: "complete" | "incomplete" | "blocked" | "cancelled";
	findingsFound: number;
	findingsRetained: number;
	selectedOperations: number;
	presentationTruncated: boolean;
	artifactReferences: ArtifactReference[];
	sections: Array<{
		operationId: string;
		kind: OperationKind;
		targetFindingId?: string;
		complete: boolean;
		message: string;
		findings: FindingEvidence[];
	}>;
	notes: string[];
}

export interface LedgerState {
	nextInvestigation: number;
	nextOperation: number;
	nextAttempt: number;
	requests: Record<string, { payloadDigest: string; investigationId: string }>;
	investigations: Record<string, InvestigationRecord>;
	operations: Record<string, OperationRecord>;
	attempts: Record<string, AttemptRecord>;
	evidence: Record<string, EvidenceRecord>;
}

export type InvestigationCheckpoint =
	| { phase: "prepare" }
	| { phase: "intent"; operationId: string }
	| { phase: "launch"; operationId: string; attemptId: string }
	| { phase: "reconcile"; operationId: string; attemptId: string }
	| { phase: "select" }
	| { phase: "report" };

export interface InvestigationTaskInput {
	investigationId: string;
	definitionContract: string;
}

export interface InvestigationTaskResult {
	investigationId: string;
	status: InvestigationRecord["status"];
}

export class ContractError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "ContractError";
		this.code = code;
	}
}
