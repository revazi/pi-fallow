import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getNormalizedFallowReport } from "./normalized-report";
import type { FallowCommandResult } from "./command/loader";

export const FALLOW_HISTORY_LIMIT = 20;

export interface FallowHistoryEntry {
	id: string;
	root: string;
	command: string;
	comparisonKey: string;
	timestamp: string;
	gitHead?: string;
	kind?: string;
	fallowVersion?: string;
	schemaVersion?: string;
	complete: boolean;
	completenessReason?: string;
	exitCode: number;
	findingCount: number;
	contextCount: number;
	reportPath?: string;
	reportSha256?: string;
	reportBytes?: number;
}

export interface FallowHistoryState {
	nextId: number;
	entries: FallowHistoryEntry[];
}

export type FallowHistoryArtifactStatus = "available" | "missing" | "drifted" | "not-retained";

export function createFallowHistoryState(): FallowHistoryState {
	return { nextId: 1, entries: [] };
}

export function resetFallowHistory(state: FallowHistoryState): void {
	state.nextId = 1;
	state.entries.length = 0;
}

export async function recordFallowHistory(
	pi: Pick<ExtensionAPI, "exec">,
	state: FallowHistoryState,
	cwd: string,
	result: FallowCommandResult,
	protectedIds: readonly string[] = [],
	comparisonArgs: readonly string[] = result.args,
): Promise<FallowHistoryEntry> {
	const artifact = await inspectArtifact(result.formatted.fullOutputPath);
	const counts = historyCounts(result);
	const entry: FallowHistoryEntry = {
		id: `r${state.nextId++}`,
		root: resolve(cwd),
		command: boundedCommand(result.binary, result.args),
		comparisonKey: buildComparisonKey(comparisonArgs),
		timestamp: new Date().toISOString(),
		gitHead: await readGitHead(pi, cwd),
		kind: result.reportMetadata.kind,
		fallowVersion: result.reportMetadata.fallowVersion,
		schemaVersion: result.reportMetadata.schemaVersion,
		complete: result.reportMetadata.complete,
		completenessReason: result.reportMetadata.completenessReason,
		exitCode: result.execution.code,
		findingCount: counts.findings,
		contextCount: counts.context,
		reportPath: result.formatted.fullOutputPath,
		reportSha256: artifact.sha256,
		reportBytes: artifact.bytes,
	};
	appendBoundedHistory(state, entry, new Set(protectedIds));
	return entry;
}

function historyCounts(result: FallowCommandResult): { findings: number; context: number } {
	if (!result.formatted.overview) return { findings: 0, context: 0 };
	const report = getNormalizedFallowReport(result.formatted.overview);
	return { findings: report.findingCount, context: report.contextCount };
}

function appendBoundedHistory(
	state: FallowHistoryState,
	entry: FallowHistoryEntry,
	protectedIds: ReadonlySet<string>,
): void {
	state.entries.push(entry);
	while (state.entries.length > FALLOW_HISTORY_LIMIT) evictOldestUnprotectedEntry(state, protectedIds);
}

function evictOldestUnprotectedEntry(state: FallowHistoryState, protectedIds: ReadonlySet<string>): void {
	const index = state.entries.findIndex((entry) => !protectedIds.has(entry.id));
	state.entries.splice(index < 0 ? 0 : index, 1);
}

export function listFallowHistory(state: FallowHistoryState, cwd: string): FallowHistoryEntry[] {
	const root = resolve(cwd);
	return state.entries.filter((entry) => entry.root === root).toReversed();
}

export function findFallowHistoryEntry(
	state: FallowHistoryState,
	cwd: string,
	id: string,
): FallowHistoryEntry | undefined {
	const root = resolve(cwd);
	return state.entries.find((entry) => entry.root === root && entry.id === id);
}

export async function getFallowHistoryArtifactStatus(entry: FallowHistoryEntry): Promise<FallowHistoryArtifactStatus> {
	if (!entry.reportPath || !entry.reportSha256) return "not-retained";
	return existingArtifactStatus(entry.reportPath, entry.reportSha256);
}

async function existingArtifactStatus(path: string, expectedDigest: string): Promise<FallowHistoryArtifactStatus> {
	try {
		await access(path);
		return await hashFile(path) === expectedDigest ? "available" : "drifted";
	} catch {
		return "missing";
	}
}

export async function readFallowHistoryArtifact(entry: FallowHistoryEntry): Promise<string> {
	const source = requiredArtifactSource(entry);
	const text = await readArtifactText(source.path);
	assertArtifactDigest(text, source.digest);
	return text;
}

function requiredArtifactSource(entry: FallowHistoryEntry): { path: string; digest: string } {
	if (!entry.reportPath || !entry.reportSha256) throw new Error("complete report was not retained");
	return { path: entry.reportPath, digest: entry.reportSha256 };
}

async function readArtifactText(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch {
		throw new Error("complete report is missing or expired");
	}
}

function assertArtifactDigest(text: string, expected: string): void {
	const digest = createHash("sha256").update(text).digest("hex");
	if (digest !== expected) throw new Error("complete report drifted after it was recorded");
}

async function inspectArtifact(path: string | undefined): Promise<{ sha256?: string; bytes?: number }> {
	if (!path) return {};
	try {
		const [sha256, metadata] = await Promise.all([hashFile(path), stat(path)]);
		return { sha256, bytes: metadata.size };
	} catch {
		return {};
	}
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function readGitHead(pi: Pick<ExtensionAPI, "exec">, cwd: string): Promise<string | undefined> {
	try {
		const result = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd, timeout: 1_200 });
		const value = result.stdout.trim();
		return result.code === 0 && /^[0-9a-f]{40,64}$/i.test(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function boundedCommand(binary: string, args: readonly string[]): string {
	const tokens = [binary, ...args.slice(0, 30)].map((arg) => quoteCommandToken(arg.slice(0, 200)));
	if (args.length > 30) tokens.push("…");
	return tokens.join(" ").slice(0, 2_000);
}

function buildComparisonKey(args: readonly string[]): string {
	const scope = JSON.stringify(withoutPresentationArgs(args));
	return createHash("sha256").update(scope).digest("hex");
}

function withoutPresentationArgs(args: readonly string[]): string[] {
	const filtered: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		switch (presentationArgMode(arg)) {
			case "drop": continue;
			case "drop-with-value": index++; continue;
			default: filtered.push(arg);
		}
	}
	return filtered;
}

function presentationArgMode(arg: string): "drop" | "drop-with-value" | "keep" {
	if (["--quiet", "-q", "--pretty"].includes(arg)) return "drop";
	if (["--format", "-f"].includes(arg)) return "drop-with-value";
	return arg.startsWith("--format=") ? "drop" : "keep";
}

function quoteCommandToken(value: string): string {
	return /\s/.test(value) ? JSON.stringify(value) : value;
}
