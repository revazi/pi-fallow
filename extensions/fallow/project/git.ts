import { execFile } from "node:child_process";
import type { FallowGitState } from "../types";

const BASE_REF_CANDIDATES = ["origin/main", "main", "origin/master", "master"];

async function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: 2000 }, (error, stdout) => {
			if (error) return resolve(undefined);
			resolve(stdout.trim() || undefined);
		});
	});
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
