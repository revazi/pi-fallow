import { execFile } from "node:child_process";

const BASE_REF_CANDIDATES = ["origin/main", "main", "origin/master", "master"];
const BASE_REF_NAMES = BASE_REF_CANDIDATES.map((candidate) => candidate.startsWith("origin/")
	? `refs/remotes/${candidate}`
	: `refs/heads/${candidate}`);

async function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: 2000 }, (error, stdout) => {
			if (error) return resolve(undefined);
			resolve(stdout.trim() || undefined);
		});
	});
}

export async function detectFallowBaseRef(cwd: string): Promise<string | undefined> {
	const output = await git(cwd, ["for-each-ref", "--format=%(refname:short)", ...BASE_REF_NAMES]);
	if (!output) return undefined;
	const available = new Set(output.split(/\r?\n/));
	return BASE_REF_CANDIDATES.find((candidate) => available.has(candidate));
}

