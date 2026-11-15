// Experimental bounded wire schema. Durable establishes target provenance
// separately from these pure normalization functions.
import { isAbsolute, posix } from "node:path";
import { ContractError, MAX_FINDINGS, MAX_OUTPUT_BYTES } from "./contracts.ts";

export const FALLOW_VERSION = "3.36.0";
export const FALLOW_SCAN_SCHEMA = 10;

export type FallowFinding =
	| { id: string; kind: "unused-file"; path: string; line: 1 }
	| { id: string; kind: "unused-export"; path: string; line: number; exportName: string };

function invalid(message: string): never {
	throw new ContractError("fallow-schema", message);
}
function object(value: unknown): Record<string, any> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("expected an object");
	return value as Record<string, any>;
}
function text(value: unknown, max = 500): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) return invalid("invalid string");
	return value;
}
function filePath(value: unknown): string {
	const path = text(value);
	if (isAbsolute(path) || path.includes("\\") || path.includes(":") || path.split("/").some((part) => part === ".." || part === "." || part === "") || posix.normalize(path) !== path) return invalid("invalid snapshot-relative path");
	return path;
}
function parse(source: string): Record<string, any> {
	if (Buffer.byteLength(source, "utf8") > MAX_OUTPUT_BYTES) throw new ContractError("fallow-output-oversized", "Fallow output exceeds the bound");
	let value: unknown;
	try { value = JSON.parse(source); } catch { return invalid("invalid JSON"); }
	return object(value);
}

/** Normalize only unused-file and unused-export records from the pinned wire schema. */
export function normalizeFallowScan(source: string): { findings: FallowFinding[]; found: number; truncated: boolean } {
	const value = parse(source);
	if (value.kind !== "dead-code" || value.version !== FALLOW_VERSION || value.schema_version !== FALLOW_SCAN_SCHEMA) return invalid("incompatible dead-code schema");
	if (!Array.isArray(value.unused_files) || !Array.isArray(value.unused_exports)) return invalid("missing finding arrays");
	const summary = object(value.summary);
	if (summary.unused_files !== value.unused_files.length || summary.unused_exports !== value.unused_exports.length) return invalid("finding count mismatch");
	const findings: FallowFinding[] = [];
	const ids = new Set<string>();
	for (const [kind, entries] of [["unused-file", value.unused_files], ["unused-export", value.unused_exports]] as const) {
		for (const entry of entries) {
			const item = object(entry);
			const id = text(item.finding_id, 100);
			if (ids.has(id)) return invalid("duplicate finding ID");
			ids.add(id);
			const path = filePath(item.path);
			if (kind === "unused-file") findings.push({ id, kind, path, line: 1 });
			else {
				if (!Number.isSafeInteger(item.line) || item.line < 1) return invalid("invalid line");
				const exportName = text(item.export_name, 200);
				if (exportName.includes(":")) return invalid("ambiguous export name");
				findings.push({ id, kind, path, line: item.line, exportName });
			}
		}
	}
	return { findings: findings.slice(0, MAX_FINDINGS), found: findings.length, truncated: findings.length > MAX_FINDINGS };
}

/** Validate the response target and retain only bounded, non-provider evidence. */
export function normalizeFallowDetail(source: string, operation: "inspect" | "trace", finding: FallowFinding): { kind: "inspect" | "trace"; targetId: string; reachable: boolean } {
	const value = parse(source);
	let reachable: unknown;
	if (operation === "inspect") {
		if (value.kind !== "inspect_target") return invalid("incompatible inspect schema");
		const target = object(value.target);
		const identity = object(value.identity);
		if (target.file !== finding.path || identity.file !== finding.path || target.type !== (finding.kind === "unused-file" ? "file" : "symbol")) return invalid("inspect target mismatch");
		if (finding.kind === "unused-export" && (target.export_name !== finding.exportName || identity.export_name !== finding.exportName)) return invalid("inspect symbol mismatch");
		reachable = finding.kind === "unused-file" ? identity.is_reachable : identity.file_reachable;
	} else if (operation === "trace") {
		if (value.kind !== "trace" || value.file !== finding.path) return invalid("trace target mismatch");
		if (finding.kind === "unused-export" && value.export_name !== finding.exportName) return invalid("trace symbol mismatch");
		if (finding.kind === "unused-file" && value.export_name !== undefined) return invalid("trace file mismatch");
		reachable = finding.kind === "unused-file" ? value.is_reachable : value.file_reachable;
	} else return invalid("unsupported detail operation");
	if (typeof reachable !== "boolean") return invalid("missing reachability");
	return { kind: operation, targetId: finding.id, reachable };
}
