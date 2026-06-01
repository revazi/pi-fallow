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
	const configOverride = readFlagValue(args, "--config");
	let configPath: string | undefined;
	let configSource: FallowProjectState["configSource"] = "none";

	if (configOverride) {
		configPath = stripAt(configOverride);
		configSource = "flag";
	} else {
		for (const candidate of CONFIG_FILES) {
			const absolute = resolve(cwd, candidate);
			if (await exists(absolute)) {
				configPath = candidate;
				configSource = "file";
				break;
			}
		}
	}

	const cacheEnabled = !args.some((arg) => arg === "--no-cache");
	const cacheDir = join(cwd, ".fallow");
	let cacheFiles: string[] = [];
	if (cacheEnabled && await exists(cacheDir)) {
		try {
			const entries = await readdir(cacheDir, { withFileTypes: true });
			cacheFiles = entries
				.filter((entry) => entry.isFile() && entry.name.endsWith(".bin"))
				.map((entry) => `.fallow/${entry.name}`)
				.sort((a, b) => a.localeCompare(b));
		} catch {
			cacheFiles = [];
		}
	}

	return {
		configPath: configPath ? relativePath(cwd, resolve(cwd, configPath)) : undefined,
		configSource,
		cacheEnabled,
		cacheFiles,
	};
}

export function formatFallowProjectState(state: FallowProjectState | undefined): FallowSummaryLines | undefined {
	if (!state) return undefined;
	const config = state.configPath
		? `${state.configPath}${state.configSource === "flag" ? " (--config)" : ""}`
		: "none";
	const cache = state.cacheEnabled
		? state.cacheFiles.length ? state.cacheFiles.join(", ") : "none"
		: "disabled (--no-cache)";
	return { lines: [{ text: `Config: ${config}` }, { text: `Cache: ${cache}` }] };
}

export async function detectFallowGitState(cwd: string): Promise<FallowGitState> {
	const isGitRepo = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (isGitRepo !== "true") return { isGitRepo: false };

	const branchName = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const detached = !branchName || branchName === "HEAD";
	let baseRef: string | undefined;
	for (const candidate of BASE_REF_CANDIDATES) {
		const resolved = await git(cwd, ["rev-parse", "--verify", candidate]);
		if (resolved) {
			baseRef = candidate;
			break;
		}
	}

	return {
		isGitRepo: true,
		detached,
		branch: detached ? undefined : branchName,
		baseRef,
	};
}

export function formatFallowStatus(state: FallowGitState | undefined): string {
	if (!state?.isGitRepo) return "fallow ready";
	const location = state.detached ? "detached" : state.branch ? `branch ${state.branch}` : "git";
	return `fallow ready · ${location}${state.baseRef ? ` · base ${state.baseRef}` : ""}`;
}
