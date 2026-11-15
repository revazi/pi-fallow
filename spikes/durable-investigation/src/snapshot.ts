import { cp, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AnalyzerIdentity, SnapshotIdentity } from "./contracts.ts";
import { ContractError } from "./contracts.ts";
import { digestJson, execArgv, sha256File, sha256Text } from "./util.ts";

async function git(repository: string, args: string[]): Promise<string> {
	const result = await execArgv(["git", "-C", repository, ...args], { maxBytes: 2 * 1024 * 1024 });
	if (result.code !== 0) throw new ContractError("git-failed", result.stderr.trim() || `git ${args.join(" ")} failed`);
	return result.stdout;
}

export async function inspectRepository(repositoryInput: string): Promise<{
	repository: string;
	baseCommit: string;
	baseTree: string;
	files: string[];
	contentSha256: string;
	configSha256: string;
}> {
	const repository = await realpath(resolve(repositoryInput));
	const root = await realpath((await git(repository, ["rev-parse", "--show-toplevel"])).trim());
	if (root !== repository) throw new ContractError("external-root", "the requested path must be the Git worktree root");
	const status = await git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (status.length !== 0) throw new ContractError("dirty-worktree", "dirty or untracked input is not supported by the spike");
	const staged = await git(repository, ["ls-files", "--stage", "-z"]);
	const files: string[] = [];
	for (const row of staged.split("\0")) {
		if (!row) continue;
		const match = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/u.exec(row);
		if (!match) throw new ContractError("git-index", "unsupported Git index entry");
		if (match[1] === "120000") throw new ContractError("symlink", `symlink input is unsupported: ${match[2]}`);
		if (match[1] === "160000") throw new ContractError("submodule", `submodule input is unsupported: ${match[2]}`);
		if (match[1] !== "100644" && match[1] !== "100755") throw new ContractError("file-mode", `unsupported file mode ${match[1]}`);
		files.push(match[2]!);
	}
	files.sort();
	const entries: Array<{ path: string; sha256: string; bytes: number }> = [];
	for (const file of files) {
		const absolute = resolve(repository, file);
		if (!absolute.startsWith(`${repository}${sep}`)) throw new ContractError("path-escape", `tracked path escapes repository: ${file}`);
		const metadata = await lstat(absolute);
		if (!metadata.isFile()) throw new ContractError("non-file", `tracked input is not a regular file: ${file}`);
		entries.push({ path: file, sha256: await sha256File(absolute), bytes: metadata.size });
	}
	const configPath = join(repository, ".fallowrc.json");
	let configSha256 = sha256Text("");
	try { configSha256 = sha256Text(await readFile(configPath)); } catch {}
	return {
		repository,
		baseCommit: (await git(repository, ["rev-parse", "HEAD"])).trim(),
		baseTree: (await git(repository, ["rev-parse", "HEAD^{tree}"])).trim(),
		files,
		contentSha256: digestJson(entries),
		configSha256,
	};
}

export async function materializeSnapshot(repository: string, ownedRoot: string, snapshotName: string): Promise<SnapshotIdentity> {
	const inspected = await inspectRepository(repository);
	const destination = join(ownedRoot, "snapshots", snapshotName);
	await rm(destination, { recursive: true, force: true });
	for (const file of inspected.files) {
		const target = join(destination, file);
		await mkdir(dirname(target), { recursive: true });
		await cp(join(inspected.repository, file), target, { dereference: false, preserveTimestamps: false });
	}
	const fixed = await inspectMaterializedSnapshot(destination, inspected.files);
	if (fixed.contentSha256 !== inspected.contentSha256) throw new ContractError("snapshot-drift", "materialized snapshot digest mismatch");
	return {
		contentSha256: inspected.contentSha256,
		configSha256: inspected.configSha256,
		baseCommit: inspected.baseCommit,
		baseTree: inspected.baseTree,
		files: inspected.files.length,
		materializedPath: destination,
	};
}

async function inspectMaterializedSnapshot(root: string, files: string[]): Promise<{ contentSha256: string }> {
	const entries = [];
	for (const file of files) {
		const path = join(root, file);
		const metadata = await lstat(path);
		if (!metadata.isFile() || metadata.isSymbolicLink()) throw new ContractError("snapshot-entry", `invalid snapshot entry: ${file}`);
		entries.push({ path: file, sha256: await sha256File(path), bytes: metadata.size });
	}
	return { contentSha256: digestJson(entries) };
}

export async function verifySnapshot(identity: SnapshotIdentity): Promise<void> {
	const repositoryFiles = await listFiles(identity.materializedPath);
	const inspected = await inspectMaterializedSnapshot(identity.materializedPath, repositoryFiles);
	if (repositoryFiles.length !== identity.files || inspected.contentSha256 !== identity.contentSha256) {
		throw new ContractError("snapshot-drift", "fixed snapshot content drifted");
	}
	let configSha256 = sha256Text("");
	try { configSha256 = sha256Text(await readFile(join(identity.materializedPath, ".fallowrc.json"))); } catch {}
	if (configSha256 !== identity.configSha256) throw new ContractError("config-drift", "fixed snapshot config drifted");
}

async function listFiles(root: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	const output: string[] = [];
	async function walk(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const absolute = join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new ContractError("snapshot-symlink", "snapshot contains a symlink");
			if (entry.isDirectory()) await walk(absolute);
			else if (entry.isFile()) output.push(relative(root, absolute).split(sep).join("/"));
			else throw new ContractError("snapshot-entry", "snapshot contains an unsupported entry");
		}
	}
	await walk(root);
	return output.sort();
}

export async function inspectAnalyzer(executablePathInput: string): Promise<AnalyzerIdentity> {
	const executablePath = await realpath(resolve(executablePathInput));
	const version = await execArgv([process.execPath, executablePath, "--version"], { env: {}, maxBytes: 4096 });
	if (version.code !== 0) throw new ContractError("analyzer-version", "controlled analyzer version check failed");
	return { executablePath, sha256: await sha256File(executablePath), version: version.stdout.trim() };
}

export async function verifyAnalyzer(identity: AnalyzerIdentity): Promise<void> {
	if (await sha256File(identity.executablePath) !== identity.sha256) throw new ContractError("executable-drift", "analyzer executable digest drifted");
	const current = await inspectAnalyzer(identity.executablePath);
	if (current.version !== identity.version) throw new ContractError("executable-version-drift", "analyzer version drifted");
}
