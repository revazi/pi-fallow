import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
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
import { sha256File } from "./util.ts";

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
	const metadata = await stat(staging).catch(() => undefined);
	if (!metadata) throw new ContractError("artifact-missing", "analyzer artifact is missing");
	if (!metadata.isFile()) throw new ContractError("artifact-type", "analyzer artifact is not a regular file");
	if (metadata.size > MAX_ARTIFACT_BYTES) throw new ContractError("artifact-oversized", `artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
	let parsed: any;
	try { parsed = JSON.parse(await readFile(staging, "utf8")); }
	catch { throw new ContractError("artifact-malformed", "analyzer artifact is not valid JSON"); }
	validateArtifactShape(parsed, operation);
	const destination = ownedPath(ownedRoot, attempt.artifactRelativePath);
	await mkdir(dirname(destination), { recursive: true });
	await copyFile(staging, destination);
	const artifact: ArtifactReference = {
		relativePath: attempt.artifactRelativePath,
		sha256: await sha256File(destination),
		bytes: metadata.size,
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
	};
}

export async function validatePublishedArtifact(ownedRoot: string, evidence: EvidenceRecord): Promise<void> {
	const path = ownedPath(ownedRoot, evidence.artifact.relativePath);
	const metadata = await stat(path).catch(() => undefined);
	if (!metadata?.isFile()) throw new ContractError("artifact-missing", "published artifact is missing");
	if (metadata.size !== evidence.artifact.bytes) throw new ContractError("artifact-size-drift", "published artifact size drifted");
	if (await sha256File(path) !== evidence.artifact.sha256) throw new ContractError("artifact-corrupt", "published artifact digest drifted");
}

export function artifactAbsolutePath(ownedRoot: string, relativePath: string): string {
	return join(ownedRoot, relativePath);
}
