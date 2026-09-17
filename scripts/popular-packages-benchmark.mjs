import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import {
	readGitSha,
	requireValue,
	roundBenchmarkValue as round,
	writeJsonArtifact,
} from "./benchmark-utils.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_PATH = join(ROOT, "benchmarks", "popular-packages.json");
const FALLOW_BINARY = join(ROOT, "node_modules", ".bin", "fallow");
const DEFAULT_TIMEOUT_SECS = 180;
const jiti = createJiti(import.meta.url);
const { fallowProjectIssues } = await jiti.import("../extensions/fallow/command/issues.ts");
const { execFallowProcess } = await jiti.import("../extensions/fallow/process.ts");
const { buildFallowOverview } = await jiti.import("../extensions/fallow/overview.ts");
const { getNormalizedFallowReport } = await jiti.import("../extensions/fallow/normalized-report.ts");

const cli = parseCli(process.argv.slice(2));
const corpus = JSON.parse(await readFile(CORPUS_PATH, "utf8"));
const selected = selectPackages(corpus.packages, cli.only);
const cacheDir = cli.cacheDir ?? join(ROOT, "benchmarks", ".cache", "popular-packages");
await mkdir(cacheDir, { recursive: true });

const measurements = [];
for (const pkg of selected) {
	measurements.push(await measurePackage(pkg, cacheDir, cli));
}

const artifact = {
	benchmarkVersion: corpus.benchmarkVersion,
	label: cli.label,
	generatedAt: new Date().toISOString(),
	config: {
		timeoutSecs: cli.timeoutSecs,
		shallowClone: true,
		schedule: "concurrent",
		defaultFallowConfig: true,
	},
	environment: buildEnvironment(),
	corpus: {
		path: "benchmarks/popular-packages.json",
		packageCount: selected.length,
	},
	measurements,
};
await writeJsonArtifact(artifact, cli.output);
printSummary(artifact, cli.output);

function parseCli(args) {
	const options = {
		label: "working-tree",
		output: undefined,
		cacheDir: undefined,
		only: undefined,
		refresh: false,
		timeoutSecs: DEFAULT_TIMEOUT_SECS,
	};
	for (let index = 0; index < args.length; index++) {
		const flag = args[index];
		if (flag === "--refresh") {
			options.refresh = true;
			continue;
		}
		const setter = {
			"--label": (value) => { options.label = value; },
			"--output": (value) => { options.output = value; },
			"--cache-dir": (value) => { options.cacheDir = value; },
			"--only": (value) => { options.only = value.split(",").map((item) => item.trim()).filter(Boolean); },
			"--timeout-secs": (value) => { options.timeoutSecs = Number(value); },
		}[flag];
		if (!setter) throw new Error(`Unknown argument: ${flag}`);
		setter(requireValue(args, index + 1, flag));
		index++;
	}
	if (!Number.isInteger(options.timeoutSecs) || options.timeoutSecs < 1) {
		throw new Error("--timeout-secs must be an integer >= 1.");
	}
	return options;
}

function selectPackages(packages, only) {
	if (!only?.length) return packages;
	const selected = packages.filter((pkg) => only.includes(pkg.id));
	const missing = only.filter((id) => !selected.some((pkg) => pkg.id === id));
	if (missing.length) throw new Error(`Unknown package id(s): ${missing.join(", ")}`);
	return selected;
}

async function measurePackage(pkg, cacheDir, options) {
	process.stderr.write(`Analyzing ${pkg.name}@${pkg.ref}…\n`);
	try {
		const cwd = await ensureClone(pkg, cacheDir, options.refresh);
		const health = await runHealth(cwd, options.timeoutSecs);
		const issues = await runIssues(cwd, options.timeoutSecs);
		return {
			key: `popular-packages/${pkg.id}`,
			id: pkg.id,
			name: pkg.name,
			category: pkg.category,
			repo: pkg.repo,
			ref: pkg.ref,
			gitSha: readGitSha(cwd),
			filesAnalyzed: health.filesAnalyzed,
			functionsAnalyzed: health.functionsAnalyzed,
			loc: health.loc,
			healthScore: health.score,
			healthGrade: health.grade,
			maintainability: health.maintainability,
			deadCodeIssues: issues.deadCodeIssues,
			cloneGroups: issues.cloneGroups,
			healthFindings: issues.healthFindings,
			securityCandidates: issues.securityCandidates,
			navigatorFindingCount: issues.navigatorFindingCount,
			wallMs: issues.wallMs,
			outputBytes: issues.outputBytes,
			exitCode: issues.exitCode,
		};
	} catch (error) {
		return {
			key: `popular-packages/${pkg.id}`,
			id: pkg.id,
			name: pkg.name,
			category: pkg.category,
			repo: pkg.repo,
			ref: pkg.ref,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function ensureClone(pkg, cacheDir, refresh) {
	const dest = join(cacheDir, `${pkg.id}-${pkg.ref.replace(/[^A-Za-z0-9._-]+/g, "-")}`);
	if (refresh || !existsSync(join(dest, ".git"))) {
		await rm(dest, { recursive: true, force: true });
		execFileSync("git", ["clone", "--depth", "1", "--branch", pkg.ref, pkg.repo, dest], {
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 180_000,
		});
	}
	return dest;
}

async function runHealth(cwd, timeoutSecs) {
	const result = await execFallowProcess(
		FALLOW_BINARY,
		["health", "--format", "json", "--quiet"],
		cwd,
		undefined,
		timeoutSecs,
	);
	const report = parseJsonOutput(result, "health");
	const score = asRecord(report.health_score);
	const summary = asRecord(report.summary);
	const counts = asRecord(asRecord(report.vital_signs).counts);
	return {
		score: roundNumber(score.score),
		grade: typeof score.grade === "string" ? score.grade : undefined,
		filesAnalyzed: integerValue(summary.files_analyzed),
		functionsAnalyzed: integerValue(summary.functions_analyzed),
		maintainability: roundNumber(summary.average_maintainability),
		loc: integerValue(counts.total_lines, summary.total_lines),
	};
}

async function runIssues(cwd, timeoutSecs) {
	const tracker = createChildTracker();
	const wallStart = performance.now();
	const execution = await fallowProjectIssues.runCommands(
		{}, [], cwd, undefined, timeoutSecs, tracker.execute, "concurrent",
	);
	const wallMs = performance.now() - wallStart;
	const report = parseJsonOutput(execution.result, "issues");
	const overview = buildFallowOverview(report);
	const normalized = getNormalizedFallowReport(overview);
	return {
		wallMs: round(wallMs),
		outputBytes: Buffer.byteLength(execution.result.stdout),
		navigatorFindingCount: normalized.findingCount,
		deadCodeIssues: integerValue(asRecord(report.check).total_issues),
		cloneGroups: arrayLength(asRecord(report.dupes).clone_groups),
		healthFindings: arrayLength(asRecord(report.health).findings),
		securityCandidates: arrayLength(report.security_findings),
		exitCode: execution.result.code,
	};
}

function createChildTracker() {
	const tracker = { execute: undefined };
	tracker.execute = async (_pi, args, cwd, signal, timeoutSecs) => {
		const result = await execFallowProcess(FALLOW_BINARY, args, cwd, signal, timeoutSecs);
		return { binary: FALLOW_BINARY, args, result };
	};
	return tracker;
}

function parseJsonOutput(result, label) {
	if (result.killed) throw new Error(`${label} analysis was cancelled or timed out`);
	if (result.code >= 2) throw new Error(`${label} analysis exited ${result.code}`);
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new Error(`${label} analysis did not return structured JSON`);
	}
}

function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayLength(value) {
	return Array.isArray(value) ? value.length : 0;
}

function integerValue(...values) {
	for (const value of values) {
		if (Number.isFinite(value)) return Math.round(value);
	}
	return 0;
}

function roundNumber(value) {
	return Number.isFinite(value) ? round(value) : undefined;
}

function buildEnvironment() {
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
		tmpDir: tmpdir(),
	};
}

function printSummary(artifact, outputPath) {
	console.log(`Pi Fallow popular-packages benchmark: ${artifact.label}`);
	console.table(artifact.measurements.map((item) => ({
		package: item.name,
		ref: item.ref,
		files: item.filesAnalyzed ?? "error",
		timeMs: item.wallMs ?? "error",
		findings: item.navigatorFindingCount ?? "error",
		health: item.healthGrade && item.healthScore != null ? `${item.healthGrade} ${item.healthScore}` : item.error ?? "",
	})));
	if (outputPath) console.log(`Wrote ${resolve(outputPath)}`);
}
