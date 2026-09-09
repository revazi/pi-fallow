import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseJson } from "./json";
import { parseSimilarCodeCapability, similarCodeStatusLines } from "./optional-analysis";
import { readinessNext, type ReadinessCheck, type ReadinessReport } from "./readiness-report";
import { createFallowRunner } from "./runner";
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

/** No loader/dialog, setup plan, model setup, analysis, or installing runner fallback. */
export function createReadinessCheck(
	pi: ExtensionAPI, cwd: string, runner = createFallowRunner({ allowNpxFallback: false }),
): ReadinessCheck {
	return async (view, signal) => {
		if (view === "runtime-coverage") return inspectRuntimeReadiness(cwd, signal);
		runner.clear(pi); // Explicit refresh must notice an installation changed outside Pi.
		const { result } = await runner.execute(pi, ["similar-code", "status", "--format", "json", "--quiet"], cwd, signal, 30);
		if (result.code !== 0 || result.killed) throw new Error(`Similar Code status failed (exit ${result.code}): ${result.stderr}`);
		return similarReadiness(result.stdout, result.stderr);
	};
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
