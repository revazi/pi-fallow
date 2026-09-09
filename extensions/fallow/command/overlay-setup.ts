import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOptionalAnalysisState, inspectRuntimeCoverageCapability, resolveLocalArtifact, saveOptionalSetupOutput } from "../optional-analysis";
import { execFallowProcess } from "../process";
import { createFallowRunner } from "../runner";
import type { ReadinessCheck } from "../readiness-report";
import type { OverlaySetupRun } from "../ui/overlay-setup";
import { runOptionalSetup } from "./optional-analysis";

/** No dialogs, npx fallback, analysis, or project-plan execution. */
export function createOverlaySetupRun(pi: ExtensionAPI, mode: string, root: string, check: ReadinessCheck): OverlaySetupRun {
	return async (view, signal, confirm, progress) => {
		if (mode !== "tui") throw new Error("Optional setup requires an interactive TUI command.");
		progress("Checking existing installations…");
		const before = await check(view, signal);
		if (before.phase !== "missing") return `Setup did not run: ${before.summary}\n${before.next}`;
		const state = createOptionalAnalysisState();
		const processRun = async (command: string, args: string[], cwd: string, abort: AbortSignal | undefined, timeout: number) => {
			signal.throwIfAborted();
			return execFallowProcess(command, args, cwd, abort, timeout, undefined, (text) => progress(undefined, text));
		};
		const runner = createFallowRunner({ allowNpxFallback: false, executeProcess: processRun });
		await runOptionalSetup(view, mode, { cwd: root, ui: { confirm: async (title, preview) => {
			if (!await confirm(title, preview)) return false;
			signal.throwIfAborted();
			progress("Rechecking confirmed plan and existing installations…");
			const current = await check(view, signal);
			if (JSON.stringify(before) !== JSON.stringify(current)) throw new Error("Readiness changed after preview; setup stopped. Preview again.");
			return true;
		} } }, state, {
			runFallow: async (args, label, timeout = 120) => {
				signal.throwIfAborted();
				progress(label);
				return runner.execute(pi, args, root, signal, timeout);
			},
			runProcess: async (command, args, label, timeout = 120) => {
				progress(label);
				return processRun(command, args, root, signal, timeout);
			},
			inspectRuntime: (plan) => inspectRuntimeCoverageCapability(plan),
			resolveArtifact: resolveLocalArtifact,
			saveSetupOutput: async (stdout, stderr) => {
				const path = await saveOptionalSetupOutput(stdout, stderr);
				progress(undefined, `\nComplete setup output: ${path}\n`);
				return path;
			},
		});
		return [state.notice, state.completeSetupOutputPath ? `Complete setup output: ${state.completeSetupOutputPath}` : ""].filter(Boolean).join("\n");
	};
}
