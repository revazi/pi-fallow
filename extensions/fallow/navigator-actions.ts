import { isAbsolute } from "node:path";
import { asRecord } from "./data";
import type { NormalizedFallowEntry } from "./normalized-report";

export type FallowNavigatorActionKind = "read-only" | "preview";

export interface FallowNavigatorAction {
	id: string;
	label: string;
	description: string;
	commandArgs: string[];
	kind: FallowNavigatorActionKind;
}

const EXPORT_TYPES = new Set(["unused-export", "unused-type", "duplicate-export", "invalid-client-export"]);
const DEPENDENCY_TYPES = new Set([
	"unused-dependency", "unused-dev-dependency", "unused-optional-dependency", "unlisted-dependency",
	"type-only-dependency", "test-only-dependency", "dev-dependency-in-production",
]);
const NON_EXPLAINABLE_TYPES = new Set(["complexity", "finding", "security", "target"]);
const SYMBOL_PATH = /\.[cm]?[jt]sx?$/iu;
const SYMBOL_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu;
const ISSUE_TYPE = /^(?:fallow\/)?[a-z][a-z0-9-]*$/u;

export function buildFallowNavigatorActions(entry: NormalizedFallowEntry): FallowNavigatorAction[] {
	if (entry.role !== "finding") return [];
	const raw = rawFinding(entry.raw);
	const path = safeReportPath(entry.path);
	const type = safeIssueType(entry.type);
	const symbol = symbolForType(type, raw, entry.subject);
	const packageName = packageForType(type, raw, entry.subject);
	return deduplicateActions([
		...inspectFileActions(path),
		...symbolActions(path, symbol),
		...symbolImpactActions(path, symbol),
		...fileTraceActions(path, type),
		...dependencyTraceActions(packageName),
		...cloneTraceActions(path, raw, entry),
		...explainActions(type),
		...architectureActions(path),
		...fixPreviewActions(raw),
	]);
}

function inspectFileActions(path: string | undefined): FallowNavigatorAction[] {
	if (!path) return [];
	return [action("inspect-file", "Inspect file", `Inspect ${path} as a bundled read-only evidence query.`, ["inspect", "--file", path])];
}

function symbolActions(path: string | undefined, symbol: string | undefined): FallowNavigatorAction[] {
	if (!path) return [];
	if (!symbol) return [];
	const target = `${path}:${symbol}`;
	return [
		action("inspect-symbol", "Inspect symbol", `Inspect exported symbol ${target}.`, ["inspect", "--symbol", target]),
		action("trace-export", "Trace export", `Trace why ${target} is considered used or unused.`, ["dead-code", "--trace", target]),
	];
}

function symbolImpactActions(path: string | undefined, symbol: string | undefined): FallowNavigatorAction[] {
	if (!path || !SYMBOL_PATH.test(path)) return [];
	if (!symbol) return [];
	const target = `${path}:${symbol}`;
	return [action("symbol-impact", "Analyze symbol impact", `Find exact TypeScript consumers and affected tests for ${target}.`, [
		"dead-code", "--type-aware", "--symbol-impact", target,
	])];
}

function fileTraceActions(path: string | undefined, type: string | undefined): FallowNavigatorAction[] {
	if (!path || type !== "unused-file") return [];
	return [action("trace-file", "Trace file", `Trace why ${path} is considered used or unused.`, ["dead-code", "--trace-file", path])];
}

function dependencyTraceActions(packageName: string | undefined): FallowNavigatorAction[] {
	if (!packageName) return [];
	return [action("trace-dependency", "Trace dependency", `Trace package evidence for ${packageName}.`, [
		"dead-code", "--trace-dependency", packageName,
	])];
}

function cloneTraceActions(
	path: string | undefined,
	raw: Record<string, any>,
	entry: NormalizedFallowEntry,
): FallowNavigatorAction[] {
	if (!path || !cloneCandidate(raw, entry)) return [];
	return [action("trace-clone", "Trace clone", `Trace the clone containing ${path}:${entry.line}.`, [
		"dupes", "--trace", `${path}:${entry.line}`,
	])];
}

function explainActions(type: string | undefined): FallowNavigatorAction[] {
	if (!type || NON_EXPLAINABLE_TYPES.has(type)) return [];
	return [action("explain", "Explain finding type", `Explain Fallow's ${type} rule and interpretation.`, ["explain", type])];
}

function architectureActions(path: string | undefined): FallowNavigatorAction[] {
	if (!path) return [];
	return [action("architecture", "Check architecture rules", `Show architecture rules that apply to ${path}.`, ["guard", path])];
}

function fixPreviewActions(raw: Record<string, any>): FallowNavigatorAction[] {
	if (!hasPreviewableFix(raw)) return [];
	return [action(
		"fix-preview",
		"Preview safe fixes",
		"Run Fallow's project-wide dry-run only; no fix is applied and config creation is disabled.",
		["fix", "--dry-run", "--no-create-config"],
		"preview",
	)];
}

function action(
	id: string,
	label: string,
	description: string,
	commandArgs: string[],
	kind: FallowNavigatorActionKind = "read-only",
): FallowNavigatorAction {
	return { id, label, description, commandArgs, kind };
}

function rawFinding(value: unknown): Record<string, any> {
	const raw = asRecord(value) ?? {};
	return asRecord(raw.candidate) ?? raw;
}

function symbolForType(type: string | undefined, raw: Record<string, any>, subject: string): string | undefined {
	if (!type || !EXPORT_TYPES.has(type)) return undefined;
	return safeSymbol(symbolName(raw, subject));
}

function packageForType(type: string | undefined, raw: Record<string, any>, subject: string): string | undefined {
	if (!type || !DEPENDENCY_TYPES.has(type)) return undefined;
	return safePackageName(raw.package_name ?? subject);
}

function symbolName(raw: Record<string, any>, subject: string): unknown {
	const className = safeScalar(raw.class_name);
	const memberName = safeScalar(raw.member_name);
	if (className && memberName) return `${className}.${memberName}`;
	return firstScalar([raw.export_name, raw.name, subject]);
}

function firstScalar(values: unknown[]): string | undefined {
	for (const value of values) {
		const scalar = safeScalar(value);
		if (scalar) return scalar;
	}
	return undefined;
}

function safeReportPath(value: unknown): string | undefined {
	const path = safeScalar(value);
	if (!path) return undefined;
	return isUnsafePath(path) ? undefined : path;
}

function isUnsafePath(path: string): boolean {
	if (isAbsolute(path) || /^[A-Za-z]:[\\/]/u.test(path)) return true;
	return path.split(/[\\/]/u).includes("..");
}

function safeIssueType(value: unknown): string | undefined {
	const type = safeScalar(value)?.toLocaleLowerCase().replaceAll("_", "-");
	return type && ISSUE_TYPE.test(type) ? type : undefined;
}

function safeSymbol(value: unknown): string | undefined {
	const symbol = safeScalar(value);
	return symbol && SYMBOL_NAME.test(symbol) ? symbol : undefined;
}

function safePackageName(value: unknown): string | undefined {
	const packageName = safeScalar(value);
	return packageName && PACKAGE_NAME.test(packageName) ? packageName : undefined;
}

function safeScalar(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return validScalar(value.trim());
}

function validScalar(value: string): string | undefined {
	if (!value || value.startsWith("-")) return undefined;
	return /[\0\r\n]/u.test(value) ? undefined : value;
}

function cloneCandidate(raw: Record<string, any>, entry: NormalizedFallowEntry): boolean {
	if (!validSourceLine(entry.line)) return false;
	return hasCloneIdentity(raw, entry);
}

function validSourceLine(line: number | undefined): boolean {
	return Number.isInteger(line) && (line ?? 0) > 0;
}

function hasCloneIdentity(raw: Record<string, any>, entry: NormalizedFallowEntry): boolean {
	return Array.isArray(raw.instances) || entry.section === "Clone groups" || entry.type === "clone-group";
}

function hasPreviewableFix(raw: Record<string, any>): boolean {
	const actions = Array.isArray(raw.actions) ? raw.actions : [];
	return actions.some((entry) => asRecord(entry)?.auto_fixable === true);
}

function deduplicateActions(actions: FallowNavigatorAction[]): FallowNavigatorAction[] {
	const seen = new Set<string>();
	return actions.filter((entry) => retainNewAction(entry, seen));
}

function retainNewAction(action: FallowNavigatorAction, seen: Set<string>): boolean {
	const key = action.commandArgs.join("\0");
	if (seen.has(key)) return false;
	seen.add(key);
	return true;
}
