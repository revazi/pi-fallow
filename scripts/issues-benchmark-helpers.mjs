import { execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { createJiti } from "jiti";
import { readGitSha } from "./benchmark-utils.mjs";

export async function loadIssuesBenchmarkModules() {
	const jiti = createJiti(import.meta.url);
	const { fallowProjectIssues } = await jiti.import("../extensions/fallow/command/issues.ts");
	const { execFallowProcess } = await jiti.import("../extensions/fallow/process.ts");
	const { buildFallowOverview } = await jiti.import("../extensions/fallow/overview.ts");
	const { getNormalizedFallowReport } = await jiti.import("../extensions/fallow/normalized-report.ts");
	return { fallowProjectIssues, execFallowProcess, buildFallowOverview, getNormalizedFallowReport };
}

export function buildEnvironment(ROOT, FALLOW_BINARY) {
	const versionLine = execFileSync(FALLOW_BINARY, ["--version", "--format", "json"], { encoding: "utf8" }).split(/\r?\n/)[0];
	const version = JSON.parse(versionLine).message;
	return {
		gitSha: readGitSha(ROOT),
		node: process.version,
		fallow: version,
		platform: process.platform,
		arch: process.arch,
		cpuModel: cpus()[0]?.model ?? "unknown",
		logicalCpuCount: cpus().length,
		totalMemoryBytes: totalmem(),
	};
}
