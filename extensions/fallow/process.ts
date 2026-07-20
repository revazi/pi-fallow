import { spawn } from "node:child_process";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

// Fallow needs process-group ownership so npx descendants cannot survive cancellation.
// ExtensionAPI.exec returns only the final result, so it cannot provide the PID needed for verified escalation.
const PROCESS_KILL_GRACE_MS = 1_000;
type SpawnedProcess = ReturnType<typeof spawn>;
type ProcessSignal = "SIGTERM" | "SIGKILL";

export interface FallowProcessResult extends ExecResult {
	launchError?: {
		code?: string;
		message: string;
	};
}

function signalWindowsTree(proc: SpawnedProcess, force: boolean): void {
	const taskkillArgs = ["/PID", String(proc.pid), "/T", ...(force ? ["/F"] : [])];
	const taskkill = spawn("taskkill", taskkillArgs, { stdio: "ignore", windowsHide: true });
	taskkill.on("error", () => {});
	taskkill.unref();
}

function signalChild(proc: SpawnedProcess, signal: ProcessSignal): void {
	try {
		proc.kill(signal);
	} catch {
		// The process exited between the liveness check and signal delivery.
	}
}

function signalUnixTree(proc: SpawnedProcess, signal: ProcessSignal): void {
	try {
		process.kill(-proc.pid!, signal);
	} catch {
		signalChild(proc, signal);
	}
}

function signalProcessTree(proc: SpawnedProcess, force: boolean): void {
	if (!proc.pid) return;
	if (process.platform === "win32") return signalWindowsTree(proc, force);
	signalUnixTree(proc, force ? "SIGKILL" : "SIGTERM");
}

function isWindowsProcessRunning(proc: SpawnedProcess): boolean {
	return proc.exitCode === null && proc.signalCode === null;
}

function isUnixProcessTreeRunning(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isProcessTreeRunning(proc: SpawnedProcess): boolean {
	if (!proc.pid) return false;
	if (process.platform === "win32") return isWindowsProcessRunning(proc);
	return isUnixProcessTreeRunning(proc.pid);
}

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
	if (timer) clearTimeout(timer);
}

function forceRemainingProcessTree(proc: SpawnedProcess, killed: boolean): void {
	if (!killed) return;
	if (isProcessTreeRunning(proc)) signalProcessTree(proc, true);
}

function resolveExitCode(code: number | null, killed: boolean): number {
	if (code !== null) return code;
	return killed ? 130 : 1;
}

export async function execFallowProcess(
	command: string,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutSecs: number,
): Promise<FallowProcessResult> {
	if (signal?.aborted) return { stdout: "", stderr: "", code: 130, killed: true };
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			detached: process.platform !== "win32",
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let killed = false;
		let launched = false;
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		let forceKillId: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			clearTimer(timeoutId);
			clearTimer(forceKillId);
			signal?.removeEventListener("abort", killProcess);
		};
		const finish = (result: ExecResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};
		const forceKill = () => {
			if (!settled) signalProcessTree(proc, true);
		};
		const killProcess = () => {
			if (killed || settled) return;
			killed = true;
			signalProcessTree(proc, false);
			forceKillId = setTimeout(forceKill, PROCESS_KILL_GRACE_MS);
		};

		proc.stdout?.on("data", (data) => { stdout += data.toString(); });
		proc.stderr?.on("data", (data) => { stderr += data.toString(); });
		proc.on("spawn", () => { launched = true; });
		proc.on("error", (error: NodeJS.ErrnoException) => {
			finish({
				stdout,
				stderr: stderr || error.message,
				code: error.code === "ENOENT" ? 127 : 1,
				killed,
				launchError: launched ? undefined : { code: error.code, message: error.message },
			});
		});
		proc.on("close", (code) => {
			forceRemainingProcessTree(proc, killed);
			finish({ stdout, stderr, code: resolveExitCode(code, killed), killed });
		});

		signal?.addEventListener("abort", killProcess, { once: true });
		if (timeoutSecs > 0) timeoutId = setTimeout(killProcess, timeoutSecs * 1000);
	});
}
