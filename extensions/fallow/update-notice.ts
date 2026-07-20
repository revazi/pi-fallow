import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const PI_FALLOW_PACKAGE_NAME = "pi-fallow";
const PI_FALLOW_NPM_URL = "https://www.npmjs.com/package/pi-fallow";
const PI_FALLOW_REPO_URL = "https://github.com/revazi/pi-fallow";
const PI_FALLOW_RELEASES_URL = "https://github.com/revazi/pi-fallow/releases";
const PI_FALLOW_ISSUES_URL = "https://github.com/revazi/pi-fallow/issues";
const PI_REPO_URL = "https://github.com/earendil-works/pi";
const FALLOW_DOCS_URL = "https://fallow.tools/docs/";
const PI_FALLOW_UPDATE_COMMAND = "pi update npm:pi-fallow";
const PI_FALLOW_DISABLE_UPDATE_ENV = "PI_FALLOW_DISABLE_UPDATE_NOTICE";

const NPM_LATEST_URL = `https://registry.npmjs.org/${PI_FALLOW_PACKAGE_NAME}/latest`;
const UPDATE_CHECK_TIMEOUT_MS = 1_500;
const LATEST_VERSION_CACHE_MS = 6 * 60 * 60 * 1_000;

interface PiFallowVersionInfo {
	packageName: string;
	currentVersion: string;
	latestVersion?: string;
	updateAvailable: boolean;
	npmUrl: string;
	repoUrl: string;
	releasesUrl: string;
	issuesUrl: string;
	piRepoUrl: string;
	fallowDocsUrl: string;
	updateCommand: string;
	disableEnv: string;
	checkedAt: string;
	error?: string;
}

let currentVersionPromise: Promise<string> | undefined;
let latestVersionCache: { value: string; expiresAt: number } | undefined;
let latestVersionPromise: Promise<string | undefined> | undefined;
let updateNoticeShown = false;

export async function sendFallowAboutMessage(pi: ExtensionAPI, ctx: { hasUI: boolean; ui?: { notify(message: string, level: "info" | "warning" | "error"): void } }): Promise<void> {
	const info = await getPiFallowVersionInfo({ forceRefresh: true });
	pi.sendMessage({
		customType: "fallow-about",
		content: formatPiFallowAbout(info),
		display: true,
		details: info,
	});
	if (ctx.hasUI) ctx.ui?.notify("Pi Fallow details added to the transcript.", "info");
}

export function scheduleFallowUpdateNotice(
	_pi: ExtensionAPI,
	ctx: { hasUI: boolean; ui?: { notify(message: string, level: "info" | "warning" | "error"): void } },
): void {
	if (!ctx.hasUI || updateNoticeShown || isUpdateNoticeDisabled()) return;
	updateNoticeShown = true;
	void getPiFallowVersionInfo()
		.then((info) => {
			if (!info.updateAvailable || !info.latestVersion) return;
			ctx.ui?.notify(buildShortUpdateNotice(info), "warning");
		})
		.catch(() => {
			// Update checks are best-effort and must never affect Pi startup.
		});
}

async function getPiFallowVersionInfo(options: { forceRefresh?: boolean } = {}): Promise<PiFallowVersionInfo> {
	const currentVersion = await getCurrentPiFallowVersion();
	const checkedAt = new Date().toISOString();
	try {
		const latestVersion = await getLatestPiFallowVersion(options);
		return buildVersionInfo({
			currentVersion,
			latestVersion,
			checkedAt,
			error: latestVersion ? undefined : "Latest npm version unavailable.",
		});
	} catch (error) {
		return buildVersionInfo({
			currentVersion,
			checkedAt,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function buildVersionInfo(input: {
	currentVersion: string;
	latestVersion?: string;
	checkedAt: string;
	error?: string;
}): PiFallowVersionInfo {
	return {
		packageName: PI_FALLOW_PACKAGE_NAME,
		currentVersion: input.currentVersion,
		latestVersion: input.latestVersion,
		updateAvailable: isUpdateAvailable(input.currentVersion, input.latestVersion),
		npmUrl: PI_FALLOW_NPM_URL,
		repoUrl: PI_FALLOW_REPO_URL,
		releasesUrl: PI_FALLOW_RELEASES_URL,
		issuesUrl: PI_FALLOW_ISSUES_URL,
		piRepoUrl: PI_REPO_URL,
		fallowDocsUrl: FALLOW_DOCS_URL,
		updateCommand: PI_FALLOW_UPDATE_COMMAND,
		disableEnv: PI_FALLOW_DISABLE_UPDATE_ENV,
		checkedAt: input.checkedAt,
		error: input.error,
	};
}

async function getCurrentPiFallowVersion(): Promise<string> {
	currentVersionPromise ??= readCurrentVersionFromPackageJson();
	return currentVersionPromise;
}

async function readCurrentVersionFromPackageJson(): Promise<string> {
	const version = await readPackageJsonVersion();
	return version ?? process.env.npm_package_version ?? "unknown";
}

async function readPackageJsonVersion(): Promise<string | undefined> {
	try {
		const packageJsonPath = new URL("../../package.json", import.meta.url);
		const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
		return parsePackageJsonVersion(packageJson);
	} catch {
		return undefined;
	}
}

function parsePackageJsonVersion(packageJson: { version?: unknown }): string | undefined {
	return typeof packageJson.version === "string" && packageJson.version ? packageJson.version : undefined;
}

async function getLatestPiFallowVersion(options: { forceRefresh?: boolean }): Promise<string | undefined> {
	const now = Date.now();
	const cached = options.forceRefresh ? undefined : readLatestVersionCache(now);
	return cached ?? resolveLatestVersion(now);
}

function readLatestVersionCache(now: number): string | undefined {
	if (!latestVersionCache) return undefined;
	return latestVersionCache.expiresAt > now ? latestVersionCache.value : undefined;
}

async function resolveLatestVersion(now: number): Promise<string | undefined> {
	const value = await getLatestVersionPromise();
	cacheLatestVersion(value, now);
	return value;
}

function getLatestVersionPromise(): Promise<string | undefined> {
	latestVersionPromise ??= fetchLatestPiFallowVersion();
	return latestVersionPromise.finally(() => {
		latestVersionPromise = undefined;
	});
}

function cacheLatestVersion(value: string | undefined, now: number): void {
	if (!value) return;
	latestVersionCache = { value, expiresAt: now + LATEST_VERSION_CACHE_MS };
}

async function fetchLatestPiFallowVersion(): Promise<string | undefined> {
	if (!hasFetch()) return undefined;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
	timeout.unref?.();
	try {
		const response = await fetchNpmLatest(controller);
		return parseLatestVersionResponse(response);
	} finally {
		clearTimeout(timeout);
	}
}

function hasFetch(): boolean {
	return typeof fetch === "function";
}

function fetchNpmLatest(controller: AbortController): Promise<Response> {
	return fetch(NPM_LATEST_URL, {
		signal: controller.signal,
		headers: { accept: "application/json" },
	});
}

async function parseLatestVersionResponse(response: Response): Promise<string | undefined> {
	if (!response.ok) return undefined;
	const data = await response.json() as { version?: unknown };
	return typeof data.version === "string" ? data.version : undefined;
}

function isUpdateNoticeDisabled(): boolean {
	const disableValue = process.env[PI_FALLOW_DISABLE_UPDATE_ENV];
	if (disableValue !== undefined) return !isFalseLike(disableValue);
	const updateCheckValue = process.env.PI_FALLOW_UPDATE_CHECK;
	return updateCheckValue !== undefined && isFalseLike(updateCheckValue);
}

function isFalseLike(value: string): boolean {
	return ["0", "false", "off", "no"].includes(value.toLowerCase());
}

function isUpdateAvailable(currentVersion: string, latestVersion: string | undefined): boolean {
	if (!latestVersion || currentVersion === "unknown") return false;
	return compareVersions(latestVersion, currentVersion) > 0;
}

function compareVersions(left: string, right: string): number {
	const diff = findVersionPartDiff(parseVersionParts(left), parseVersionParts(right));
	return diff === 0 ? comparePrerelease(left, right) : Math.sign(diff);
}

function findVersionPartDiff(leftParts: number[], rightParts: number[]): number {
	const length = Math.max(leftParts.length, rightParts.length);
	return Array.from({ length }, (_, index) => (leftParts[index] ?? 0) - (rightParts[index] ?? 0))
		.find((diff) => diff !== 0) ?? 0;
}

function parseVersionParts(version: string): number[] {
	return version
		.split("-", 1)[0]
		.split(".")
		.map((part) => Number.parseInt(part, 10))
		.map((value) => Number.isFinite(value) ? value : 0);
}

function comparePrerelease(left: string, right: string): number {
	const leftHasPrerelease = left.includes("-");
	const rightHasPrerelease = right.includes("-");
	if (leftHasPrerelease === rightHasPrerelease) return 0;
	return leftHasPrerelease ? -1 : 1;
}

function buildShortUpdateNotice(info: PiFallowVersionInfo): string {
	return `Pi Fallow ${info.latestVersion} is available (you have ${info.currentVersion}). Update: ${info.updateCommand}. Details: /fallow about`;
}

function formatPiFallowAbout(info: PiFallowVersionInfo): string {
	return [
		"Pi Fallow",
		"",
		`Installed version: ${info.currentVersion}`,
		`Latest npm version: ${info.latestVersion ?? "unavailable"}`,
		`Update available: ${info.updateAvailable ? "yes" : "no"}`,
		info.error ? `Update check: ${info.error}` : `Update check: ${info.checkedAt}`,
		"",
		`Update command: ${info.updateCommand}`,
		`npm: ${info.npmUrl}`,
		`Repository: ${info.repoUrl}`,
		`Releases: ${info.releasesUrl}`,
		`Issues: ${info.issuesUrl}`,
		`Pi: ${info.piRepoUrl}`,
		`Fallow docs: ${info.fallowDocsUrl}`,
		"",
		`Disable startup update notices with ${info.disableEnv}=1.`,
	].join("\n");
}

export function renderFallowAboutMessage(message: { content: string; details?: unknown }, _options: unknown, theme: any): Text {
	const info = message.details as PiFallowVersionInfo | undefined;
	const title = theme.fg("toolTitle", theme.bold("Pi Fallow"));
	return new Text(`${title} ${renderVersionStatus(info, theme)}\n${theme.fg("dim", message.content)}`, 0, 0);
}

function renderVersionStatus(info: PiFallowVersionInfo | undefined, theme: any): string {
	if (!info?.latestVersion) return theme.fg("warning", "latest unavailable");
	if (info.updateAvailable) return theme.fg("warning", `update available: ${info.latestVersion}`);
	return theme.fg("success", "up to date");
}
