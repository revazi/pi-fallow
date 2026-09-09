import { fallowCli } from "../cli";
import { buildRuntimeCoverageRequest, localCoverageEnvironment, revalidateRuntimeCoverageRequest, type RuntimeCoverageRunRequest } from "../runtime-coverage-options";

/** Execution-time gate for inline requests. Ordinary commands keep their existing path. */
export function runtimeCoverageExecutor(
	request: RuntimeCoverageRunRequest | undefined,
	execute = fallowCli.execFallow,
	revalidate = revalidateRuntimeCoverageRequest,
	timeoutMs = 30_000,
): typeof fallowCli.execFallow {
	if (!request) return execute;
	return async (pi, args, cwd, signal, timeoutSecs) => {
		const expected = [...buildRuntimeCoverageRequest(request.artifact, request.sidecar).commandArgs, "--format", "json", "--quiet"];
		if (JSON.stringify(args) !== JSON.stringify(expected)) throw new Error("Runtime Coverage request arguments changed; preview again before Run.");
		await checkedWithinBudget((abort) => revalidate(request, abort), signal, timeoutMs);
		return execute(pi, args, cwd, signal, timeoutSecs, localCoverageEnvironment(request.sidecar.binaryPath));
	};
}

export async function checkedWithinBudget(
	check: (signal: AbortSignal) => Promise<void>, signal: AbortSignal | undefined, timeoutMs: number,
	message = "Runtime Coverage preflight timed out; no analysis started.",
): Promise<void> {
	const controller = new AbortController();
	const checkSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	let onAbort = () => {};
	const stopped = new Promise<never>((_resolve, reject) => { onAbort = () => reject(checkSignal.reason); });
	checkSignal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
	try {
		checkSignal.throwIfAborted();
		await Promise.race([Promise.resolve().then(() => check(checkSignal)), stopped]);
		checkSignal.throwIfAborted();
	} finally {
		clearTimeout(timer);
		checkSignal.removeEventListener("abort", onAbort);
	}
}
