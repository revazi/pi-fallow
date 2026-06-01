import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { stripAtPrefix } from "../path";
import type { FallowProjectState } from "../types";

const CONFIG_FILES = [".fallowrc", ".fallowrc.json", ".fallowrc.jsonc", "fallow.toml"];

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
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
	if (configOverride) return { configPath: stripAtPrefix(configOverride), configSource: "flag" };
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
