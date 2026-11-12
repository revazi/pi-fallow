import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
	ContractError,
	MAX_ARTIFACT_BYTES,
	MAX_FINDINGS,
	MAX_PRESENTED_FINDINGS,
	type ArtifactReference,
	type AttemptRecord,
	type EvidenceRecord,
	type FindingEvidence,
	type OperationRecord,
} from "./contracts.ts";
import { sha256Text } from "./util.ts";

function ownedPath(ownedRoot: string, relativePath: string): string {
	const absolute = resolve(ownedRoot, relativePath);
	if (!absolute.startsWith(`${resolve(ownedRoot)}${sep}`)) throw new ContractError("artifact-path", "artifact path escapes owned storage");
	return absolute;
}

export async function publishAndValidateArtifact(
	ownedRoot: string,
	attempt: AttemptRecord,
	operation: OperationRecord,
	selectionLimit: number,
): Promise<EvidenceRecord> {
	const staging = ownedPath(ownedRoot, attempt.stagingRelativePath);
	const source = await readBoundedRegularFile(staging, MAX_ARTIFACT_BYTES);
	let parsed: any;
	try { parsed = JSON.parse(source.toString("utf8")); }
	catch { throw new ContractError("artifact-malformed", "analyzer artifact is not valid JSON"); }
	validateArtifactShape(parsed, operation);
	const destination = ownedPath(ownedRoot, attempt.artifactRelativePath);
	await mkdir(dirname(destination), { recursive: true });
	await writeFile(destination, source, { mode: 0o600 });
	const artifact: ArtifactReference = {
		relativePath: attempt.artifactRelativePath,
		sha256: sha256Text(source),
		bytes: source.byteLength,
		kind: operation.kind,
		attemptId: attempt.id,
	};
	const findings = (parsed.findings as FindingEvidence[]).slice(0, MAX_FINDINGS).map(boundedFinding);
	return {
		operationId: operation.id,
		attemptId: attempt.id,
		kind: operation.kind,
		...(operation.targetFindingId ? { targetFindingId: operation.targetFindingId } : {}),
		artifact,
		complete: parsed.complete === true,
		...(typeof parsed.completenessReason === "string" ? { completenessReason: parsed.completenessReason.slice(0, 200) } : {}),
		findingCount: parsed.findingCount,
		retainedCount: findings.length,
		selectionLimit,
		presentationLimit: MAX_PRESENTED_FINDINGS,
		findings,
	};
}

function validateArtifactShape(value: any, operation: OperationRecord): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContractError("artifact-shape", "artifact root must be an object");
	if (value.operation !== operation.kind) throw new ContractError("artifact-operation", "artifact operation does not match intent");
	if (operation.kind !== "scan" && value.target !== operation.targetFindingId) throw new ContractError("artifact-target", "artifact target does not match intent");
	if (typeof value.complete !== "boolean") throw new ContractError("artifact-complete", "artifact completeness is missing");
	if (!Number.isSafeInteger(value.findingCount) || value.findingCount < 0) throw new ContractError("artifact-count", "artifact finding count is invalid");
	if (!Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS * 4) throw new ContractError("artifact-findings", "artifact findings are invalid or unbounded");
	for (const finding of value.findings) validateFinding(finding);
}

function validateFinding(value: any): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContractError("finding-shape", "finding must be an object");
	for (const key of ["id", "kind", "path", "summary"] as const) {
		if (typeof value[key] !== "string" || value[key].length === 0 || value[key].length > 500) throw new ContractError("finding-field", `invalid finding ${key}`);
	}
	if (value.exportName !== undefined && (typeof value.exportName !== "string" || !value.exportName || value.exportName.length > 200)) throw new ContractError("finding-field", "invalid export name");
	if (!Number.isSafeInteger(value.line) || value.line < 1) throw new ContractError("finding-line", "invalid finding line");
	if (value.path.startsWith("/") || value.path.includes("..")) throw new ContractError("finding-path", "finding path is not snapshot-relative");
}

function boundedFinding(value: FindingEvidence): FindingEvidence {
	return {
		id: value.id.slice(0, 100),
		kind: value.kind.slice(0, 100),
		path: value.path.slice(0, 500),
		line: value.line,
		summary: value.summary.slice(0, 500),
		...(value.exportName === undefined ? {} : { exportName: value.exportName }),
	};
}

// Verify that a target in the ledger still corresponds to the retained scan bytes.
// Digest validation alone does not authenticate independently mutable ledger fields.
export async function validateRetainedTargetArtifact(ownedRoot: string, evidence: EvidenceRecord, operation: OperationRecord, targetId: string): Promise<void> {
	if (operation.kind !== "scan" || evidence.kind !== "scan" || evidence.operationId !== operation.id
		|| evidence.artifact.kind !== "scan" || evidence.artifact.attemptId !== evidence.attemptId
		|| !operation.attemptIds.includes(evidence.attemptId)
		|| evidence.artifact.relativePath !== join("artifacts", `${evidence.attemptId}.json`)) {
		throw new ContractError("retained-scan-binding", "retained scan identity does not match its operation");
	}
	const content = await readBoundedRegularFile(ownedPath(ownedRoot, evidence.artifact.relativePath), MAX_ARTIFACT_BYTES);
	if (content.byteLength !== evidence.artifact.bytes || sha256Text(content) !== evidence.artifact.sha256) {
		throw new ContractError("artifact-corrupt", "retained scan artifact drifted");
	}
	let parsed: any;
	try { parsed = JSON.parse(content.toString("utf8")); }
	catch { throw new ContractError("artifact-malformed", "retained scan is not valid JSON"); }
	validateArtifactShape(parsed, operation);
	const retained = (parsed.findings as FindingEvidence[]).slice(0, MAX_FINDINGS).map(boundedFinding);
	const fromArtifact = retained.filter((finding) => finding.id === targetId);
	const fromLedger = evidence.findings.filter((finding) => finding.id === targetId);
	if (fromArtifact.length !== 1 || fromLedger.length !== 1 || JSON.stringify(fromArtifact[0]) !== JSON.stringify(fromLedger[0])) {
		throw new ContractError("retained-target-binding", "target does not match exactly one retained scan finding");
	}
}

export async function validatePublishedArtifact(ownedRoot: string, evidence: EvidenceRecord): Promise<void> {
	const path = ownedPath(ownedRoot, evidence.artifact.relativePath);
	const content = await readBoundedRegularFile(path, MAX_ARTIFACT_BYTES);
	if (content.byteLength !== evidence.artifact.bytes) throw new ContractError("artifact-size-drift", "published artifact size drifted");
	if (sha256Text(content) !== evidence.artifact.sha256) throw new ContractError("artifact-corrupt", "published artifact digest drifted");
}

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<Buffer> {
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch {
		throw new ContractError("artifact-missing", "artifact is missing or cannot be opened safely");
	}
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile()) throw new ContractError("artifact-type", "artifact is not a regular file");
		if (metadata.size > maxBytes) throw new ContractError("artifact-oversized", `artifact exceeds ${maxBytes} bytes`);
		const buffer = Buffer.alloc(maxBytes + 1);
		let offset = 0;
		while (offset <= maxBytes) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > maxBytes) throw new ContractError("artifact-oversized", `artifact exceeds ${maxBytes} bytes`);
		return buffer.subarray(0, offset);
	} finally {
		await handle.close();
	}
}

export function artifactAbsolutePath(ownedRoot: string, relativePath: string): string {
	return join(ownedRoot, relativePath);
}
