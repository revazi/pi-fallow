import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFallowProcess, type FallowProcessResult } from "./process";

const DEFAULT_FALLBACK_CACHE_TTL_MS = 30_000;
const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");
const RECOVERABLE_LAUNCH_ERRORS = new Set(["ENOENT", "EACCES"]);
const NPX_PACKAGE_LOCATOR_ARGS = [
	"-y",
	"--package=fallow",
	process.execPath,
	"-e",
	"process.stdout.write(process.env.PATH || '')",
];

type RunnerSource = "configured" | "path" | "package" | "npx-package" | "npx";
type ProcessExecutor = (
	command: string,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutSecs: number,
) => Promise<FallowProcessResult>;
type ExecutableFinder = (name: string, pathValue: string, cwd: string) => Promise<string | undefined>;

interface RunnerRoute {
	command: string;
	displayBinary: string;
	argsPrefix: string[];
	source: RunnerSource;
	expiresAt?: number;
}

interface RunnerEnvironment {
	configuredBin?: string;
	pathValue: string;
}

interface RunnerRequest {
	cwd: string;
	signal: AbortSignal | undefined;
	timeoutSecs: number;
}

interface RunnerCacheEntry {
	key: string;
	environment: RunnerEnvironment;
	route?: RunnerRoute;
	resolving?: Promise<RunnerRoute>;
}

interface RunnerOptions {
	executeProcess?: ProcessExecutor;
	findExecutable?: ExecutableFinder;
	fallbackCacheTtlMs?: number;
	now?: () => number;
	packageRoot?: string | null;
	resolveNpxPackage?: boolean;
}

interface FallowRunnerExecution {
	binary: string;
	args: string[];
	result: ExecResult;
}

export function createFallowRunner({
	executeProcess = execFallowProcess,
	findExecutable = findExecutableOnPath,
	fallbackCacheTtlMs = DEFAULT_FALLBACK_CACHE_TTL_MS,
	now = Date.now,
	packageRoot = PACKAGE_ROOT,
	resolveNpxPackage = true,
}: RunnerOptions = {}) {
	const sessionCaches = new WeakMap<ExtensionAPI, Map<string, RunnerCacheEntry>>();

	async function execute(
		pi: ExtensionAPI,
		args: string[],
		cwd: string,
		signal: AbortSignal | undefined,
		timeoutSecs: number,
	): Promise<FallowRunnerExecution> {
		if (signal?.aborted) return unresolvedCancellation(args);
		const request = { cwd: resolve(cwd), signal, timeoutSecs };
		const route = await resolveCachedRoute(pi, request);
		return executeResolvedRoute(pi, args, request, route);
	}

	async function executeResolvedRoute(
		pi: ExtensionAPI,
		args: string[],
		request: RunnerRequest,
		route: RunnerRoute,
	): Promise<FallowRunnerExecution> {
		if (request.signal?.aborted) return routeCancellation(route, args);
		const execution = await executeRoute(route, args, request.cwd, request.signal, request.timeoutSecs);
		return handleExecution(pi, args, request, route, execution);
	}

	function handleExecution(
		pi: ExtensionAPI,
		args: string[],
		request: RunnerRequest,
		route: RunnerRoute,
		execution: FallowRunnerExecution & { result: FallowProcessResult },
	): Promise<FallowRunnerExecution> | FallowRunnerExecution {
		if (shouldRetryExecution(route, execution.result)) {
			return retryExecution(pi, args, request, route, execution);
		}
		return completeExecution(pi, request.cwd, route, execution);
	}

	function completeExecution(
		pi: ExtensionAPI,
		cwd: string,
		route: RunnerRoute,
		execution: FallowRunnerExecution & { result: FallowProcessResult },
	): FallowRunnerExecution {
		if (execution.result.launchError) removeCachedRoute(pi, cwd, route);
		return finalizeExecution(execution, route.source === "configured");
	}

	async function retryExecution(
		pi: ExtensionAPI,
		args: string[],
		request: RunnerRequest,
		failedRoute: RunnerRoute,
		failedExecution: FallowRunnerExecution & { result: FallowProcessResult },
	): Promise<FallowRunnerExecution> {
		removeCachedRoute(pi, request.cwd, failedRoute);
		const retryRoute = await resolveRetryRoute(pi, request, failedRoute);
		if (!retryRoute) return finalizeExecution(failedExecution, false);
		const retry = await executeRoute(retryRoute, args, request.cwd, request.signal, request.timeoutSecs);
		if (retry.result.launchError) removeCachedRoute(pi, request.cwd, retryRoute);
		return finalizeExecution(retry, retryRoute.source === "configured");
	}

	function clear(pi: ExtensionAPI): void {
		sessionCaches.delete(pi);
	}

	async function resolveCachedRoute(pi: ExtensionAPI, request: RunnerRequest): Promise<RunnerRoute> {
		const entry = cacheEntry(pi, request.cwd);
		const cached = usableCachedRoute(entry.route, now());
		if (cached) return cached;
		if (entry.resolving) return entry.resolving;
		const pending = discoverRoute(entry.environment, request, new Set(), true)
			.then((route) => resolvedRouteOrFallback(route, now(), fallbackCacheTtlMs));
		entry.resolving = pending;
		try {
			const route = await pending;
			cacheResolvedRoute(entry, route, request.signal);
			return route;
		} finally {
			entry.resolving = undefined;
		}
	}

	async function resolveRetryRoute(pi: ExtensionAPI, request: RunnerRequest, failed: RunnerRoute): Promise<RunnerRoute | undefined> {
		const entry = cacheEntry(pi, request.cwd);
		const route = await discoverRoute(entry.environment, request, new Set([failed.command]), failed.source !== "npx");
		if (route) entry.route = route;
		return route;
	}

	async function discoverRoute(
		environment: RunnerEnvironment,
		request: RunnerRequest,
		skippedCommands: Set<string>,
		allowNpx: boolean,
	): Promise<RunnerRoute | undefined> {
		if (environment.configuredBin) return configuredRoute(environment.configuredBin);
		return discoverAutomaticRoute(environment.pathValue, request, skippedCommands, allowNpx);
	}

	async function discoverAutomaticRoute(
		pathValue: string,
		request: RunnerRequest,
		skipped: Set<string>,
		allowNpx: boolean,
	): Promise<RunnerRoute | undefined> {
		const pathCandidate = await discoverPathRoute(pathValue, request.cwd, skipped);
		if (pathCandidate) return pathCandidate;
		const packageCandidate = await discoverPackageRoute(skipped);
		if (packageCandidate) return packageCandidate;
		return discoverFallbackRoute(pathValue, request, skipped, allowNpx);
	}

	async function discoverFallbackRoute(
		pathValue: string,
		request: RunnerRequest,
		skipped: Set<string>,
		allowNpx: boolean,
	): Promise<RunnerRoute | undefined> {
		if (!allowNpx) return undefined;
		return discoverNpxRoute(pathValue, request, skipped);
	}

	async function discoverPathRoute(pathValue: string, cwd: string, skipped: Set<string>): Promise<RunnerRoute | undefined> {
		const command = await findExecutable("fallow", pathValue, cwd);
		return availableRoute(command, skipped, pathRoute);
	}

	async function discoverPackageRoute(skipped: Set<string>): Promise<RunnerRoute | undefined> {
		if (!packageRoot) return undefined;
		const command = await findExecutable("fallow", packageBinPath(packageRoot), packageRoot);
		return availableRoute(command, skipped, packageRoute);
	}

	async function discoverNpxRoute(
		pathValue: string,
		request: RunnerRequest,
		skipped: Set<string>,
	): Promise<RunnerRoute | undefined> {
		const pathNpx = await findExecutable("npx", pathValue, request.cwd);
		if (!pathNpx) return unresolvedNpxRoute(skipped, now(), fallbackCacheTtlMs);
		return discoverAvailableNpxRoute(pathNpx, request, skipped);
	}

	async function discoverAvailableNpxRoute(
		pathNpx: string,
		request: RunnerRequest,
		skipped: Set<string>,
	): Promise<RunnerRoute | undefined> {
		if (skipped.has(pathNpx)) return undefined;
		const fallback = npxRoute(pathNpx, now(), fallbackCacheTtlMs);
		if (!resolveNpxPackage) return fallback;
		return discoverNpxPackageRoute(pathNpx, request, skipped, fallback);
	}

	async function discoverNpxPackageRoute(
		npxCommand: string,
		request: RunnerRequest,
		skipped: Set<string>,
		fallback: RunnerRoute,
	): Promise<RunnerRoute> {
		const command = await locateNpxPackage(npxCommand, request);
		return availableRoute(command, skipped, npxPackageRoute) ?? fallback;
	}

	async function locateNpxPackage(npxCommand: string, request: RunnerRequest): Promise<string | undefined> {
		const result = await executeProcess(
			npxCommand,
			NPX_PACKAGE_LOCATOR_ARGS,
			request.cwd,
			request.signal,
			locatorTimeout(request.timeoutSecs),
		);
		if (result.code !== 0 || result.killed) return undefined;
		return findExecutable("fallow", result.stdout, request.cwd);
	}

	function cacheEntry(pi: ExtensionAPI, cwd: string): RunnerCacheEntry {
		let projectCaches = sessionCaches.get(pi);
		if (!projectCaches) {
			projectCaches = new Map();
			sessionCaches.set(pi, projectCaches);
		}
		const environment = currentEnvironment();
		const key = environmentKey(environment);
		const existing = projectCaches.get(cwd);
		if (existing?.key === key) return existing;
		const created = { key, environment };
		projectCaches.set(cwd, created);
		return created;
	}

	function removeCachedRoute(pi: ExtensionAPI, cwd: string, route: RunnerRoute): void {
		const entry = sessionCaches.get(pi)?.get(cwd);
		if (entry?.route === route) entry.route = undefined;
	}

	async function executeRoute(
		route: RunnerRoute,
		args: string[],
		cwd: string,
		signal: AbortSignal | undefined,
		timeoutSecs: number,
	): Promise<FallowRunnerExecution & { result: FallowProcessResult }> {
		const executedArgs = [...route.argsPrefix, ...args];
		const result = await executeProcess(route.command, executedArgs, cwd, signal, timeoutSecs);
		return { binary: route.displayBinary, args: executedArgs, result };
	}

	return { execute, clear };
}

function packageBinPath(packageRoot: string): string {
	return [
		join(packageRoot, "node_modules", ".bin"),
		join(dirname(packageRoot), ".bin"),
	].join(delimiter);
}

function unresolvedCancellation(args: string[]): FallowRunnerExecution {
	const binary = process.env.FALLOW_BIN || "fallow";
	return { binary, args, result: cancellationResult() };
}

function routeCancellation(route: RunnerRoute, args: string[]): FallowRunnerExecution {
	return {
		binary: route.displayBinary,
		args: [...route.argsPrefix, ...args],
		result: cancellationResult(),
	};
}

function cancellationResult(): FallowProcessResult {
	return { stdout: "", stderr: "", code: 130, killed: true };
}

function usableCachedRoute(route: RunnerRoute | undefined, now: number): RunnerRoute | undefined {
	if (!route || isExpired(route, now)) return undefined;
	return route;
}

function resolvedRouteOrFallback(route: RunnerRoute | undefined, now: number, ttlMs: number): RunnerRoute {
	return route ?? npxRoute("npx", now, ttlMs);
}

function cacheResolvedRoute(entry: RunnerCacheEntry, route: RunnerRoute, signal: AbortSignal | undefined): void {
	if (signal?.aborted) return;
	entry.route = route;
}

function unresolvedNpxRoute(skipped: Set<string>, now: number, ttlMs: number): RunnerRoute | undefined {
	if (skipped.has("npx")) return undefined;
	return npxRoute("npx", now, ttlMs);
}

function availableRoute(
	command: string | undefined,
	skipped: Set<string>,
	build: (command: string) => RunnerRoute,
): RunnerRoute | undefined {
	if (!command || skipped.has(command)) return undefined;
	return build(command);
}

function shouldRetryExecution(route: RunnerRoute, result: FallowProcessResult): boolean {
	return route.source !== "configured" && isRecoverableLaunchFailure(result);
}

function currentEnvironment(): RunnerEnvironment {
	return {
		configuredBin: process.env.FALLOW_BIN || undefined,
		pathValue: process.env.PATH ?? "",
	};
}

function environmentKey(environment: RunnerEnvironment): string {
	return JSON.stringify([environment.configuredBin ?? null, environment.pathValue]);
}

function configuredRoute(command: string): RunnerRoute {
	return { command, displayBinary: command, argsPrefix: [], source: "configured" };
}

function pathRoute(command: string): RunnerRoute {
	return { command, displayBinary: "fallow", argsPrefix: [], source: "path" };
}

function packageRoute(command: string): RunnerRoute {
	return { command, displayBinary: command, argsPrefix: [], source: "package" };
}

function npxPackageRoute(command: string): RunnerRoute {
	return { command, displayBinary: command, argsPrefix: [], source: "npx-package" };
}

function npxRoute(command: string, now: number, ttlMs: number): RunnerRoute {
	return {
		command,
		displayBinary: "npx",
		argsPrefix: ["-y", "fallow"],
		source: "npx",
		expiresAt: now + ttlMs,
	};
}

function isExpired(route: RunnerRoute, now: number): boolean {
	return route.expiresAt !== undefined && route.expiresAt <= now;
}

function locatorTimeout(commandTimeoutSecs: number): number {
	if (commandTimeoutSecs <= 0) return 30;
	return Math.min(commandTimeoutSecs, 30);
}

function isRecoverableLaunchFailure(result: FallowProcessResult): boolean {
	return !!result.launchError?.code && RECOVERABLE_LAUNCH_ERRORS.has(result.launchError.code);
}

function finalizeExecution(
	execution: FallowRunnerExecution & { result: FallowProcessResult },
	configured: boolean,
): FallowRunnerExecution {
	if (!execution.result.launchError) return execution;
	const guidance = configured
		? "Unable to launch FALLOW_BIN. Verify that the configured executable exists and is runnable."
		: "Unable to launch Fallow. Install fallow on PATH or set FALLOW_BIN to a runnable executable.";
	return {
		...execution,
		result: {
			...execution.result,
			stderr: [execution.result.stderr.trim(), guidance].filter(Boolean).join("\n"),
		},
	};
}

async function findExecutableOnPath(name: string, pathValue: string, cwd: string): Promise<string | undefined> {
	for (const entry of pathValue.split(delimiter)) {
		const directory = resolvePathEntry(entry, cwd);
		for (const executableName of executableNames(name)) {
			const candidate = join(directory, executableName);
			if (await isExecutableFile(candidate)) return candidate;
		}
	}
	return undefined;
}

function resolvePathEntry(entry: string, cwd: string): string {
	const unquoted = entry.replace(/^"|"$/g, "");
	return resolve(cwd, unquoted || ".");
}

function executableNames(name: string): string[] {
	if (process.platform !== "win32" || extname(name)) return [name];
	const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";");
	return [name, ...extensions.map((extension) => `${name}${extension.toLowerCase()}`)];
}

async function isExecutableFile(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		if (!info.isFile()) return false;
		await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
