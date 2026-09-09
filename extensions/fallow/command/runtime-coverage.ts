import { fallowCli } from "../cli";
import { buildRuntimeCoverageRequest, localCoverageEnvironment, revalidateRuntimeCoverageRequest, type RuntimeCoverageRunRequest } from "../runtime-coverage-options";

/** Execution-time gate for inline requests. Ordinary commands and the legacy workflow keep their existing path. */
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
		await checkedWithinBudget(request, signal, revalidate, timeoutMs);
		return execute(pi, args, cwd, signal, timeoutSecs, localCoverageEnvironment(request.sidecar.binaryPath));
	};
}

async function checkedWithinBudget(
	request: RuntimeCoverageRunRequest, signal: AbortSignal | undefined, revalidate: typeof revalidateRuntimeCoverageRequest, timeoutMs: number,
): Promise<void> {
	const controller = new AbortController();
	const checkSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	let onAbort = () => {};
	const stopped = new Promise<never>((_resolve, reject) => { onAbort = () => reject(checkSignal.reason); });
	checkSignal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(new Error("Runtime Coverage preflight timed out; no analysis started.")), timeoutMs);
	try {
		checkSignal.throwIfAborted();
		await Promise.race([Promise.resolve().then(() => revalidate(request, checkSignal)), stopped]);
		checkSignal.throwIfAborted();
	} finally {
		clearTimeout(timer);
		checkSignal.removeEventListener("abort", onAbort);
	}
}
