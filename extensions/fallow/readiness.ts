import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseJson } from "./json";
import { parseSimilarCodeCapability, similarCodeStatusLines } from "./optional-analysis";
import { readinessNext, type ReadinessCheck, type ReadinessReport } from "./readiness-report";
import { createFallowRunner, sharedFallowRunner } from "./runner";
import { inspectRuntimeReadiness } from "./runtime-readiness";

export function resolveReadinessRoot(cwd: string, args: string[]): string {
	const index = args.findLastIndex((arg) => /^(?:--root(?:=|$)|-r)/u.test(arg));
	if (index < 0) return cwd;
	return resolve(cwd, rootArgument(args, index) || ".");
}

function rootArgument(args: string[], index: number): string | undefined {
	const flag = args[index]!;
	if (["--root", "-r"].includes(flag)) return args[index + 1];
	return flag.replace(/^(?:--root=|-r)/u, "");
}

type ReadinessRunner = Pick<ReturnType<typeof createFallowRunner>, "clear" | "execute"> &
	Partial<Pick<ReturnType<typeof createFallowRunner>, "refreshInstalled">>;

/** No loader/dialog, setup plan, model setup, analysis, or installing runner fallback. */
export function createReadinessCheck(
	pi: ExtensionAPI, cwd: string, runner: ReadinessRunner = sharedFallowRunner,
): ReadinessCheck {
	return async (view, signal) => {
		if (view === "runtime-coverage") return inspectRuntimeReadiness(cwd, signal);
		return checkSimilarReadiness(runner, pi, cwd, signal);
	};
}

async function checkSimilarReadiness(runner: ReadinessRunner, pi: ExtensionAPI, cwd: string, signal: AbortSignal): Promise<ReadinessReport> {
	const args = ["similar-code", "status", "--format", "json", "--quiet"];
	// Refresh ordinary discovery, but retain a direct executable already located by a completed npx-backed run.
	const execution = runner.refreshInstalled
		? await runner.refreshInstalled(pi, args, cwd, signal, 30)
		: await executeAfterClear(runner, pi, args, cwd, signal);
	const { result } = execution;
	if (result.code !== 0 || result.killed) throw new Error(`Similar Code status failed (exit ${result.code}): ${result.stderr}`);
	return similarReadiness(result.stdout, result.stderr);
}

async function executeAfterClear(
	runner: Pick<ReturnType<typeof createFallowRunner>, "clear" | "execute">,
	pi: ExtensionAPI, args: string[], cwd: string, signal: AbortSignal,
) {
	runner.clear(pi); // Injected legacy runners retain the original explicit-refresh contract.
	return runner.execute(pi, args, cwd, signal, 30);
}

function similarReadiness(stdout: string, stderr: string): ReadinessReport {
	const parsed = parseJson(stdout, stderr);
	const status = parseSimilarCodeCapability(parsed.parsed ? parsed.data : undefined);
	return {
		phase: status.phase,
		summary: status.problem ?? (status.phase === "ready" ? "Pinned model is installed and integrity-verified." : "Pinned model is not ready."),
		details: [...similarCodeStatusLines(status), `Pinned revision: ${status.modelRevision}`],
		next: readinessNext(status.phase),
	};
}
