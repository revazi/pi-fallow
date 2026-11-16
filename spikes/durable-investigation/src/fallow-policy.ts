// Pure argv policy. The Durable caller authenticates retained evidence and
// revalidates snapshot/executable identities; this is not an admission boundary.
import { isAbsolute, posix } from "node:path";
import { ContractError, MAX_FINDINGS } from "./contracts.ts";
import type { FallowFinding } from "./fallow-schema.ts";

export const FALLOW_ADAPTER_POLICY = "installed-fallow-3.36.0/v1";
export const FALLOW_OUTPUT_SCHEMA = "fallow-3.36.0/dead-code-10+inspect-trace/v1";

export type FallowOperation =
	| { kind: "scan" }
	| { kind: "inspect" | "trace"; targetFindingId: string };

export interface RetainedFallowScan {
	snapshotSha256: string;
	findings: FallowFinding[];
}

/** Construct only the allowlisted argv; never accepts a raw CLI argument. */
export function buildFallowArgv(input: {
	executablePath: string;
	snapshotPath: string;
	snapshotSha256: string;
	operation: FallowOperation;
	retainedScan?: RetainedFallowScan;
}): string[] {
	const fail = (message: string): never => { throw new ContractError("fallow-policy", message); };
	if (!isAbsolute(input.executablePath) || !isAbsolute(input.snapshotPath)) return fail("absolute executable and snapshot paths required");
	if (!/^[a-f0-9]{64}$/u.test(input.snapshotSha256)) return fail("invalid snapshot digest");
	const common = [input.executablePath, "--root", input.snapshotPath, "--format", "json", "--quiet", "--no-cache"];
	const operation = input.operation;
	if (!operation || typeof operation !== "object") return fail("operation required");
	if (operation.kind === "scan") {
		if ("targetFindingId" in operation) return fail("scan cannot have a target");
		return [...common, "dead-code"];
	}
	if (operation.kind !== "inspect" && operation.kind !== "trace") return fail("unsupported operation");
	if (typeof operation.targetFindingId !== "string" || !operation.targetFindingId) return fail("target finding ID required");
	if (!input.retainedScan || input.retainedScan.snapshotSha256 !== input.snapshotSha256 || !Array.isArray(input.retainedScan.findings) || input.retainedScan.findings.length > MAX_FINDINGS) return fail("retained scan for the same snapshot required");
	const matches = input.retainedScan.findings.filter((finding) => finding && typeof finding === "object" && finding.id === operation.targetFindingId);
	if (matches.length !== 1) return fail("target must identify exactly one retained finding");
	const finding = matches[0]!;
	if (finding.kind !== "unused-file" && finding.kind !== "unused-export") return fail("unsupported finding kind");
	const path = finding.path;
	if (typeof path !== "string" || path.length === 0 || path.length > 500 || path.startsWith("-") || isAbsolute(path) || path.includes("\\") || path.includes(":") || /[\u0000-\u001f\u007f]/u.test(path) || path.split("/").some((part) => !part || part === "." || part === "..") || posix.normalize(path) !== path) return fail("invalid finding path");
	let target = path;
	if (finding.kind === "unused-export") {
		if (typeof finding.exportName !== "string" || !finding.exportName || finding.exportName.length > 200 || /[:\u0000-\u001f\u007f]/u.test(finding.exportName)) return fail("invalid export name");
		target += `:${finding.exportName}`;
	}
	if (operation.kind === "inspect") return [...common, "inspect", finding.kind === "unused-file" ? "--file" : "--symbol", target];
	return [...common, "dead-code", finding.kind === "unused-file" ? "--trace-file" : "--trace", target];
}
