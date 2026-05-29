import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExecResult } from "@earendil-works/pi-coding-agent";
import { formatToolOutput, parseJson } from "./output";
import type { FallowRunParams } from "./schema";
import type { FallowDetails } from "./types";

function stripAt(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function addValue(args: string[], flag: string, value: unknown): void {
	if (value === undefined || value === null || value === "") return;
	args.push(flag, String(value));
}

function addBool(args: string[], flag: string, value: boolean | undefined): void {
	if (value) args.push(flag);
}

function addWorkspace(args: string[], workspace: FallowRunParams["workspace"]): void {
	if (!workspace) return;
	args.push("--workspace", Array.isArray(workspace) ? workspace.join(",") : workspace);
}

function rejectFormatOverride(extraArgs?: string[]): void {
	if (!extraArgs) return;
	if (extraArgs.some((arg) => arg === "--format" || arg.startsWith("--format=") || arg === "-f")) {
		throw new Error("extraArgs must not include --format/-f; the Pi extension always requests JSON output.");
	}
}

export function buildFallowArgs(params: FallowRunParams): string[] {
	rejectFormatOverride(params.extraArgs);

	const args: string[] = [];
	const common = () => {
		args.push("--format", "json", "--quiet");
		addValue(args, "--config", params.config);
		addWorkspace(args, params.workspace);
		addBool(args, "--production", params.production);
		addBool(args, "--no-cache", params.noCache);
		addValue(args, "--threads", params.threads);
	};

	switch (params.command) {
		case "all":
			common();
			addValue(args, "--changed-since", params.changedSince);
			addBool(args, "--score", params.score);
			break;

		case "dead-code":
			args.push("dead-code");
			common();
			addValue(args, "--changed-since", params.changedSince);
			addBool(args, "--include-entry-exports", params.includeEntryExports);
			addValue(args, "--group-by", params.groupBy);
			break;

		case "check-changed":
			args.push("check-changed");
			common();
			addValue(args, "--changed-since", params.changedSince ?? params.base);
			addBool(args, "--include-entry-exports", params.includeEntryExports);
			if (!params.changedSince && !params.base) throw new Error("check-changed requires changedSince or base.");
			break;

		case "dupes":
			args.push("dupes");
			common();
			addValue(args, "--changed-since", params.changedSince);
			addValue(args, "--top", params.top);
			addValue(args, "--min-tokens", params.minTokens);
			addValue(args, "--min-lines", params.minLines);
			addValue(args, "--threshold", params.threshold);
			addValue(args, "--min-occurrences", params.minOccurrences);
			addBool(args, "--skip-local", params.skipLocal);
			addBool(args, "--cross-language", params.crossLanguage);
			addBool(args, "--ignore-imports", params.ignoreImports);
			break;

		case "health":
			args.push("health");
			common();
			addValue(args, "--changed-since", params.changedSince);
			addValue(args, "--top", params.top);
			addValue(args, "--group-by", params.groupBy);
			addBool(args, "--file-scores", params.fileScores);
			addBool(args, "--hotspots", params.hotspots);
			addBool(args, "--targets", params.targets);
			addBool(args, "--score", params.score);
			addBool(args, "--trend", params.trend);
			addValue(args, "--coverage", params.coverage);
			addValue(args, "--coverage-root", params.coverageRoot);
			addValue(args, "--runtime-coverage", params.runtimeCoverage);
			addValue(args, "--max-crap", params.maxCrap);
			break;

		case "audit":
			args.push("audit");
			common();
			addValue(args, "--base", params.base ?? params.changedSince);
			addValue(args, "--gate", params.gate);
			addBool(args, "--explain", params.explain);
			addBool(args, "--include-entry-exports", params.includeEntryExports);
			addValue(args, "--coverage", params.coverage);
			addValue(args, "--coverage-root", params.coverageRoot);
			addValue(args, "--runtime-coverage", params.runtimeCoverage);
			addValue(args, "--max-crap", params.maxCrap);
			addValue(args, "--diff-file", params.diffFile);
			break;

		case "fix-preview":
			args.push("fix", "--dry-run");
			common();
			addBool(args, "--include-entry-exports", params.includeEntryExports);
			addBool(args, "--no-create-config", params.noCreateConfig);
			break;

		case "fix-apply":
			args.push("fix", "--yes");
			common();
			addBool(args, "--include-entry-exports", params.includeEntryExports);
			addBool(args, "--no-create-config", params.noCreateConfig);
			break;

		case "flags":
			args.push("flags");
			common();
			addValue(args, "--top", params.top);
			break;

		case "project-info":
			args.push("list");
			common();
			addBool(args, "--entry-points", params.entryPoints);
			addBool(args, "--files", params.files);
			addBool(args, "--plugins", params.plugins);
			addBool(args, "--boundaries", params.boundaries);
			break;

		case "list-boundaries":
			args.push("list", "--boundaries");
			common();
			break;

		case "explain":
			if (!params.issueType) throw new Error("explain requires issueType.");
			args.push("explain", params.issueType);
			common();
			break;

		case "trace-export":
			if (!params.file || !params.exportName) throw new Error("trace-export requires file and exportName.");
			args.push("dead-code", "--trace", `${stripAt(params.file)}:${params.exportName}`);
			common();
			break;

		case "trace-file":
			if (!params.file) throw new Error("trace-file requires file.");
			args.push("trace-file", stripAt(params.file));
			common();
			break;

		case "trace-dependency":
			if (!params.packageName) throw new Error("trace-dependency requires packageName.");
			args.push("dead-code", "--trace-dependency", params.packageName);
			common();
			break;

		case "trace-clone":
			if (!params.file || !params.line) throw new Error("trace-clone requires file and line.");
			args.push("dupes", "--trace", `${stripAt(params.file)}:${params.line}`);
			common();
			addValue(args, "--min-tokens", params.minTokens);
			addValue(args, "--min-lines", params.minLines);
			addValue(args, "--threshold", params.threshold);
			addValue(args, "--min-occurrences", params.minOccurrences);
			addBool(args, "--skip-local", params.skipLocal);
			addBool(args, "--cross-language", params.crossLanguage);
			addBool(args, "--ignore-imports", params.ignoreImports);
			break;

		case "coverage-analyze":
			args.push("coverage", "analyze");
			common();
			addValue(args, "--runtime-coverage", params.runtimeCoverage ?? params.coverage);
			addValue(args, "--top", params.top);
			addValue(args, "--group-by", params.groupBy);
			break;
	}

	args.push(...(params.extraArgs ?? []));
	return args;
}


export function commandDisplay(binary: string, args: string[]): string {
	return [binary, ...args].map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(" ");
}

export function fallowExitLabel(code: number, killed = false): string {
	if (killed) return "killed";
	if (code === 0) return "ok";
	if (code === 1) return "findings";
	return "error";
}

async function execCommand(command: string, args: string[], cwd: string, signal: AbortSignal | undefined, timeoutSecs: number): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: process.env });
		let stdout = "";
		let stderr = "";
		let killed = false;
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const finish = (result: ExecResult) => {
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			if (signal) signal.removeEventListener("abort", killProcess);
			resolve(result);
		};

		const killProcess = () => {
			if (killed) return;
			killed = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000).unref?.();
		};

		proc.stdout?.on("data", (data) => { stdout += data.toString(); });
		proc.stderr?.on("data", (data) => { stderr += data.toString(); });
		proc.on("error", (error: NodeJS.ErrnoException) => {
			finish({ stdout, stderr: stderr || error.message, code: error.code === "ENOENT" ? 127 : 1, killed });
		});
		proc.on("close", (code) => finish({ stdout, stderr, code: code ?? 0, killed }));

		if (signal?.aborted) killProcess();
		else signal?.addEventListener("abort", killProcess, { once: true });
		if (timeoutSecs > 0) timeoutId = setTimeout(killProcess, timeoutSecs * 1000);
	});
}

export async function execFallow(_pi: ExtensionAPI, args: string[], cwd: string, signal: AbortSignal | undefined, timeoutSecs: number): Promise<{ binary: string; args: string[]; result: ExecResult }> {
	const configuredBin = process.env.FALLOW_BIN;
	const binary = configuredBin || "fallow";
	const result = await execCommand(binary, args, cwd, signal, timeoutSecs);
	if (!configuredBin && (result.code === 127 || (result.code === 1 && !result.stdout.trim() && !result.stderr.trim()))) {
		const npxArgs = ["-y", "fallow", ...args];
		return {
			binary: "npx",
			args: npxArgs,
			result: await execCommand("npx", npxArgs, cwd, signal, timeoutSecs),
		};
	}
	return { binary, args, result };
}

export async function runFallow(pi: ExtensionAPI, params: FallowRunParams, ctx: ExtensionContext) {
	const args = buildFallowArgs(params);
	const cwd = params.root ? resolve(ctx.cwd, stripAt(params.root)) : ctx.cwd;
	const timeoutSecs = params.timeoutSecs ?? Number(process.env.FALLOW_TIMEOUT_SECS || 120);
	const started = Date.now();
	const { binary, args: executedArgs, result } = await execFallow(pi, args, cwd, ctx.signal, timeoutSecs);
	const elapsedMs = Date.now() - started;
	const parsed = parseJson(result.stdout, result.stderr);
	const formatted = await formatToolOutput(parsed, cwd, result.code);

	// Fallow uses exit code 1 for "issues found" on gate/check commands. Treat only 2+ as execution errors.
	if (result.code >= 2 || result.killed) {
		throw new Error([
			`Fallow command failed (${commandDisplay(binary, executedArgs)})`,
			`exitCode=${result.code}${result.killed ? " killed=true" : ""}`,
			formatted.text,
		].join("\n"));
	}

	const details: FallowDetails = {
		command: binary,
		args: executedArgs,
		cwd,
		exitCode: result.code,
		elapsedMs,
		parsed: parsed.parsed,
		summary: formatted.summary,
		overview: formatted.overview,
		fullOutputPath: formatted.fullOutputPath,
		truncated: formatted.truncated,
	};

	return { content: [{ type: "text" as const, text: formatted.text }], details };
}

export function splitArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const ch of input) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (quote) throw new Error("Unclosed quote in arguments.");
	if (current) args.push(current);
	return args;
}

