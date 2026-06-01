// fallow-ignore-file unused-export
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { FallowGitState, FallowProjectState, FallowSummaryLines } from "./types";

const CONFIG_FILES = [".fallowrc", ".fallowrc.json", ".fallowrc.jsonc", "fallow.toml"];
const BASE_REF_CANDIDATES = ["origin/main", "main", "origin/master", "master"];

async function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: 2000 }, (error, stdout) => {
			if (error) return resolve(undefined);
			resolve(stdout.trim() || undefined);
		});
	});
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function stripAt(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function relativePath(cwd: string, path: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") ? rel : path;
}

function readFlagValue(args: string[], flag: string): string | undefined {
	const index = args.findIndex((entry) => entry === flag);
	if (index >= 0 && index + 1 < args.length) return args[index + 1];
	const withAssignment = args.find((entry) => entry.startsWith(`${flag}=`));
	return withAssignment?.slice(flag.length + 1);
}

export async function detectFallowProjectState(cwd: string, args: string[] = []): Promise<FallowProjectState> {
	const { configPath: configuredPath, configSource } = await resolveProjectConfig(cwd, args);
	const cacheEnabled = !args.some((arg) => arg === "--no-cache");
	const cacheFiles = await collectCacheFiles(cwd, cacheEnabled);
	return {
		configPath: configuredPath ? relativePath(cwd, resolve(cwd, configuredPath)) : undefined,
		configSource,
		cacheEnabled,
		cacheFiles,
	};
}

async function resolveProjectConfig(cwd: string, args: string[]): Promise<{ configPath?: string; configSource: FallowProjectState["configSource"] }> {
	const configOverride = readFlagValue(args, "--config");
	if (configOverride) return { configPath: stripAt(configOverride), configSource: "flag" };
	for (const candidate of CONFIG_FILES) {
		const absolute = resolve(cwd, candidate);
		if (await exists(absolute)) return { configPath: candidate, configSource: "file" };
	}
	return { configPath: undefined, configSource: "none" };
}

async function collectCacheFiles(cwd: string, cacheEnabled: boolean): Promise<string[]> {
	if (!cacheEnabled) return [];
	const cacheDir = join(cwd, ".fallow");
	if (!(await exists(cacheDir))) return [];
	try {
		const entries = await readdir(cacheDir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".bin"))
			.map((entry) => `.fallow/${entry.name}`)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}
export function formatFallowProjectState(state: FallowProjectState | undefined): FallowSummaryLines | undefined {
	if (!state) return undefined;
	return {
		lines: [
			{ text: `Config: ${formatProjectConfig(state)}` },
			{ text: `Cache: ${formatProjectCache(state)}` },
		],
	};
}

function formatProjectConfig(state: FallowProjectState): string {
	return state.configPath ? `${state.configPath}${state.configSource === "flag" ? " (--config)" : ""}` : "none";
}

function formatProjectCache(state: FallowProjectState): string {
	if (!state.cacheEnabled) return "disabled (--no-cache)";
	return state.cacheFiles.length ? state.cacheFiles.join(", ") : "none";
}

export async function detectFallowGitState(cwd: string): Promise<FallowGitState> {
	const isGitRepo = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (isGitRepo !== "true") return { isGitRepo: false };
	const branchName = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const detached = isDetachedBranch(branchName);
	const baseRef = await resolveBaseRef(cwd);
	return {
		isGitRepo: true,
		detached,
		branch: detached ? undefined : branchName,
		baseRef,
	};
}

function isDetachedBranch(branchName: string | undefined): boolean {
	return !branchName || branchName === "HEAD";
}

async function resolveBaseRef(cwd: string): Promise<string | undefined> {
	for (const candidate of BASE_REF_CANDIDATES) {
		const resolved = await git(cwd, ["rev-parse", "--verify", candidate]);
		if (resolved) return candidate;
	}
	return undefined;
}

export function formatFallowStatus(state: FallowGitState | undefined): string {
	if (!state?.isGitRepo) return "fallow ready";
	const location = describeLocation(state);
	return `fallow ready · ${location}${state.baseRef ? ` · base ${state.baseRef}` : ""}`;
}

function describeLocation(state: FallowGitState): string {
	if (state.detached) return "detached";
	return state.branch ? `branch ${state.branch}` : "git";
}