import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = resolve(import.meta.dirname, "..");
const BASELINE_PATH = resolve(ROOT, ".github", "npm-audit-accepted-development.json");
const LOCKFILE_PATH = resolve(ROOT, "package-lock.json");
const MANIFEST_PATH = resolve(ROOT, "package.json");
const FINDING_KEYS = ["effects", "fixAvailable", "isDirect", "name", "nodes", "range", "severity", "via"];
const ADVISORY_KEYS = ["cwe", "cvss", "dependency", "name", "range", "severity", "source", "title", "url"];
const DEPENDENCY_COUNT_KEYS = ["dev", "optional", "peer", "peerOptional", "prod", "total"];
const EXPIRY_CEILING = Date.parse("2026-08-19T00:00:00.000Z");
const UPSTREAM_FIX = "https://github.com/earendil-works/pi/commit/221a842c136ab3af23aef9e70034af86061d27c1";
const ACCEPTED_RELEASE_VERSION = "0.4.0";
const REMEDIATION = "Upgrade @earendil-works/pi-coding-agent to a published release containing upstream fix 221a842c136ab3af23aef9e70034af86061d27c1, regenerate package-lock.json, restore CI and release validation to audit:all, and remove the temporary accepted-development baseline.";

export class AuditBaselineError extends Error {
	constructor(message) {
		super(message);
		this.name = "AuditBaselineError";
	}
}

export function validateAuditExecution(execution, { baseline, lockfile, lockfileSha256, manifest, now = new Date() }) {
	validateBaselineDefinition(baseline);
	validateReleaseScope(baseline, manifest);
	validateLockfileBoundary(baseline, lockfileSha256);
	validateExpiry(baseline.expiresAt, now);
	validateExecutionOutcome(execution);
	const report = parseAuditJson(execution.stdout);
	validateAuditReport(report, baseline, lockfile);
	return {
		expiresAt: baseline.expiresAt,
		findingCount: baseline.findings.length,
		advisoryCount: baseline.findings.reduce((total, finding) => total + finding.advisories.length, 0),
	};
}

export function validateAuditReport(report, baseline, lockfile) {
	requirePlainObject(report, "audit report");
	requireExactKeys(report, ["auditReportVersion", "metadata", "vulnerabilities"], "audit report");
	requireEqual(report.auditReportVersion, 2, "npm audit report version changed.");

	requirePlainObject(report.vulnerabilities, "audit vulnerabilities");
	const expectedByName = new Map(baseline.findings.map((finding) => [finding.name, finding]));
	requireExactKeys(report.vulnerabilities, [...expectedByName.keys()], "vulnerability package set");
	for (const [name, expected] of expectedByName) validateFinding(report.vulnerabilities[name], expected, lockfile);
	validateMetadata(report.metadata, baseline.vulnerabilityCounts);
}

function validateExecutionOutcome(execution) {
	requirePlainObject(execution, "npm audit execution");
	requireFalsy(execution.error, `npm audit did not complete normally. ${REMEDIATION}`);
	requireFalsy(execution.signal, `npm audit did not complete normally. ${REMEDIATION}`);
	requireInteger(execution.status, `npm audit did not complete normally. ${REMEDIATION}`);
	requireAuditStatus(execution.status);
	requireString(execution.stdout, "npm audit returned malformed output.");
}

function requireAuditStatus(status) {
	if (status === 0) fail(`npm audit found no blocking vulnerabilities; the accepted-risk baseline must now be removed. ${REMEDIATION}`);
	if (status !== 1) fail(`npm audit failed with an execution status instead of a vulnerability result. ${REMEDIATION}`);
}

function parseAuditJson(stdout) {
	try {
		return JSON.parse(stdout);
	} catch {
		fail("npm audit returned malformed JSON.");
	}
}

function validateBaselineDefinition(baseline) {
	requirePlainObject(baseline, "baseline");
	requireExactKeys(
		baseline,
		["expiresAt", "findings", "lockfileSha256", "releaseVersion", "schemaVersion", "upstreamFix", "vulnerabilityCounts"],
		"baseline",
	);
	requireEqual(baseline.schemaVersion, 2, "Unsupported audit baseline schema.");
	requireString(baseline.lockfileSha256, "Audit baseline lockfile digest is malformed.");
	requireValue(/^[a-f0-9]{64}$/.test(baseline.lockfileSha256), "Audit baseline lockfile digest is malformed.");
	requireEqual(baseline.releaseVersion, ACCEPTED_RELEASE_VERSION, "Audit baseline release scope changed.");
	validateUpstreamFix(baseline.upstreamFix);
	validateCountObject(baseline.vulnerabilityCounts, "baseline vulnerability counts");
	requireArray(baseline.findings, "Audit baseline findings are malformed.");
	requireNonEmpty(baseline.findings, "Audit baseline has no findings.");
	validateBaselineFindings(baseline.findings);
}

function validateUpstreamFix(upstreamFix) {
	requireString(upstreamFix, "Audit baseline is missing the reviewed upstream fix.");
	requireEqual(upstreamFix, UPSTREAM_FIX, "Audit baseline is missing the reviewed upstream fix.");
}

function validateReleaseScope(baseline, manifest) {
	requirePlainObject(manifest, "package manifest");
	requireEqual(manifest.name, "pi-fallow", "Accepted development audit is limited to pi-fallow.");
	requireEqual(manifest.version, baseline.releaseVersion, `Accepted development audit is limited to pi-fallow@${baseline.releaseVersion}.`);
}

function validateLockfileBoundary(baseline, lockfileSha256) {
	requireString(lockfileSha256, "Package lock digest is malformed.");
	requireEqual(lockfileSha256, baseline.lockfileSha256, "package-lock.json changed outside the accepted development-audit boundary.");
}

function validateBaselineFindings(findings) {
	const names = new Set();
	for (const finding of findings) validateBaselineFinding(finding, names);
}

function validateBaselineFinding(finding, names) {
	requirePlainObject(finding, "baseline finding");
	requireExactKeys(
		finding,
		["advisories", "effects", "fixAvailable", "isDirect", "name", "nodes", "range", "severity", "version", "via"],
		"baseline finding",
	);
	requireString(finding.name, "Audit baseline finding names must be unique strings.");
	requireUniqueEntry(names, finding.name, "Audit baseline finding names must be unique strings.");
	requireString(finding.version, `Audit baseline finding ${finding.name} is malformed.`);
	requireString(finding.severity, `Audit baseline finding ${finding.name} is malformed.`);
	requireString(finding.range, `Audit baseline finding ${finding.name} is malformed.`);
	requireBoolean(finding.isDirect, `Audit baseline finding ${finding.name} has invalid directness.`);
	validateBaselineFindingArrays(finding);
	validateBaselineAdvisories(finding.advisories, finding.name);
}

function validateBaselineFindingArrays(finding) {
	for (const field of ["via", "effects", "nodes", "advisories"]) {
		requireArray(finding[field], `Audit baseline finding ${finding.name} has invalid ${field}.`);
	}
}

function validateBaselineAdvisories(advisories, packageName) {
	for (const advisory of advisories) validateBaselineAdvisory(advisory, packageName);
}

function validateBaselineAdvisory(advisory, packageName) {
	requirePlainObject(advisory, `baseline advisory for ${packageName}`);
	requireExactKeys(
		advisory,
		["cwe", "cvss", "range", "severity", "source", "title", "url"],
		`baseline advisory for ${packageName}`,
	);
	requireInteger(advisory.source, `Audit baseline advisory for ${packageName} is malformed.`);
	requireString(advisory.url, `Audit baseline advisory for ${packageName} is malformed.`);
	requireString(advisory.severity, `Audit baseline advisory for ${packageName} is malformed.`);
	requireString(advisory.range, `Audit baseline advisory for ${packageName} is malformed.`);
	validateAdvisoryDetails(advisory, advisory.url);
}

function validateExpiry(expiresAt, now) {
	const expiration = parseDate(expiresAt, "Audit baseline expiry is malformed.");
	const current = parseDate(now, "Audit baseline expiry is malformed.");
	requireMaximum(expiration.getTime(), EXPIRY_CEILING, "Audit baseline expiry exceeds the reviewed deadline.");
	requireBefore(current, expiration, `Temporary audit baseline expired at ${expiresAt}. ${REMEDIATION}`);
}

function parseDate(value, message) {
	const parsed = new Date(value);
	requireFinite(parsed.getTime(), message);
	return parsed;
}

function validateFinding(actual, expected, lockfile) {
	requirePlainObject(actual, `finding ${expected.name}`);
	requireExactKeys(actual, FINDING_KEYS, `finding ${expected.name}`);
	validateFindingFields(actual, expected);
	compareStringSet(actual.nodes, expected.nodes, `nodes for ${expected.name}`);
	compareStringSet(actual.effects, expected.effects, `effects for ${expected.name}`);
	validateFindingVia(actual.via, expected, expected.name);
	validateLockedVersions(lockfile, expected);
}

function validateFindingFields(actual, expected) {
	for (const field of ["name", "severity", "isDirect", "range", "fixAvailable"]) {
		requireDeepEqual(actual[field], expected[field], `Audit finding ${expected.name} changed ${field}.`);
	}
}

function validateFindingVia(actualVia, expected, packageName) {
	requireArray(actualVia, `Audit finding ${packageName} has malformed advisory data.`);
	const viaPackages = actualVia.filter((item) => typeof item === "string");
	const advisories = actualVia.filter((item) => isPlainObject(item));
	requireEqual(viaPackages.length + advisories.length, actualVia.length, `Audit finding ${packageName} has malformed advisory data.`);
	compareStringSet(viaPackages, expected.via, `via packages for ${packageName}`);
	validateAdvisories(advisories, expected.advisories, packageName);
}

function validateAdvisories(actual, expected, packageName) {
	requireEqual(actual.length, expected.length, `Audit finding ${packageName} changed advisory count.`);
	const expectedBySource = new Map(expected.map((advisory) => [advisory.source, advisory]));
	requireEqual(expectedBySource.size, expected.length, `Audit baseline for ${packageName} has duplicate advisory sources.`);
	requireUniqueValues(actual.map((advisory) => advisory.source), `Audit finding ${packageName} contains duplicate advisories.`);
	for (const advisory of actual) validateAdvisory(advisory, expectedBySource, packageName);
}

function validateAdvisory(advisory, expectedBySource, packageName) {
	requireExactKeys(advisory, ADVISORY_KEYS, `advisory for ${packageName}`);
	const expected = expectedBySource.get(advisory.source);
	requireTruthy(expected, `Audit finding ${packageName} contains an unexpected advisory.`);
	requireEqual(advisory.name, packageName, `Audit finding ${packageName} changed advisory package identity.`);
	requireEqual(advisory.dependency, packageName, `Audit finding ${packageName} changed advisory package identity.`);
	validateAdvisoryFields(advisory, expected);
	validateAdvisoryDetails(advisory, expected.url);
}

function validateAdvisoryFields(actual, expected) {
	for (const field of ["title", "url", "severity", "cwe", "cvss", "range"]) {
		requireDeepEqual(actual[field], expected[field], `Audit advisory ${expected.url} changed ${field}.`);
	}
}

function validateAdvisoryDetails(advisory, url) {
	requireString(advisory.title, `Audit advisory ${url} is malformed.`);
	validateStringArray(advisory.cwe, `Audit advisory ${url} is malformed.`);
	requirePlainObject(advisory.cvss, `CVSS data for ${url}`);
	requireExactKeys(advisory.cvss, ["score", "vectorString"], `CVSS data for ${url}`);
	requireNumber(advisory.cvss.score, `Audit advisory ${url} has malformed CVSS data.`);
	requireString(advisory.cvss.vectorString, `Audit advisory ${url} has malformed CVSS data.`);
}

function validateLockedVersions(lockfile, expected) {
	requirePlainObject(lockfile, "package lock");
	requireEqual(lockfile.lockfileVersion, 3, "package-lock.json format changed.");
	requirePlainObject(lockfile.packages, "package lock packages");
	for (const node of expected.nodes) validateLockedNode(lockfile.packages[node], expected, node);
}

function validateLockedNode(lockedPackage, expected, node) {
	requirePlainObject(lockedPackage, `locked package at ${node}`);
	requireEqual(lockedPackage.version, expected.version, `Locked version or node changed for ${expected.name}.`);
}

function validateMetadata(metadata, expectedCounts) {
	requirePlainObject(metadata, "audit metadata");
	requireExactKeys(metadata, ["dependencies", "vulnerabilities"], "audit metadata");
	validateCountObject(metadata.vulnerabilities, "audit vulnerability counts");
	requireDeepEqual(metadata.vulnerabilities, expectedCounts, "Audit vulnerability severity counts changed.");
	validateDependencyCounts(metadata.dependencies);
}

function validateDependencyCounts(counts) {
	requirePlainObject(counts, "audit dependency counts");
	requireExactKeys(counts, DEPENDENCY_COUNT_KEYS, "audit dependency counts");
	validateNonnegativeCounts(counts, "Audit dependency counts are malformed.");
}

function validateCountObject(counts, label) {
	requirePlainObject(counts, label);
	requireExactKeys(counts, ["critical", "high", "info", "low", "moderate", "total"], label);
	validateNonnegativeCounts(counts, `${label} are malformed.`);
}

function validateNonnegativeCounts(counts, message) {
	for (const count of Object.values(counts)) {
		requireInteger(count, message);
		requireMinimum(count, 0, message);
	}
}

function compareStringSet(actual, expected, label) {
	const left = sortedUniqueStrings(actual, `Audit ${label} are malformed.`);
	const right = sortedUniqueStrings(expected, `Audit ${label} are malformed.`);
	requireDeepEqual(left, right, `Audit ${label} changed.`);
}

function sortedUniqueStrings(values, message) {
	validateStringArray(values, message);
	requireUniqueValues(values, message);
	return [...values].sort();
}

function validateStringArray(values, message) {
	requireArray(values, message);
	for (const value of values) requireString(value, message);
}

function requirePlainObject(value, label) {
	requireValue(isPlainObject(value), `${label} is malformed.`);
}

function requireExactKeys(value, expectedKeys, label) {
	const actualKeys = Object.keys(value).sort();
	const sortedExpected = [...expectedKeys].sort();
	requireDeepEqual(actualKeys, sortedExpected, `${label} changed shape or membership.`);
}

function requireUniqueEntry(entries, value, message) {
	requireValue(!entries.has(value), message);
	entries.add(value);
}

function requireUniqueValues(values, message) {
	requireEqual(new Set(values).size, values.length, message);
}

function requireBefore(value, limit, message) {
	requireValue(value.getTime() < limit.getTime(), message);
}

function requireNonEmpty(value, message) {
	requireValue(value.length > 0, message);
}

function requireMinimum(value, minimum, message) {
	requireValue(value >= minimum, message);
}

function requireMaximum(value, maximum, message) {
	requireValue(value <= maximum, message);
}

function requireTruthy(value, message) {
	requireValue(Boolean(value), message);
}

function requireFalsy(value, message) {
	requireValue(!value, message);
}

function requireArray(value, message) {
	requireValue(Array.isArray(value), message);
}

function requireBoolean(value, message) {
	requireValue(typeof value === "boolean", message);
}

function requireString(value, message) {
	requireValue(typeof value === "string", message);
}

function requireNumber(value, message) {
	requireValue(typeof value === "number", message);
}

function requireInteger(value, message) {
	requireValue(Number.isInteger(value), message);
}

function requireFinite(value, message) {
	requireValue(Number.isFinite(value), message);
}

function requireEqual(actual, expected, message) {
	requireValue(actual === expected, message);
}

function requireDeepEqual(actual, expected, message) {
	requireValue(isDeepStrictEqual(actual, expected), message);
}

function requireValue(condition, message) {
	if (!condition) fail(message);
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
	throw new AuditBaselineError(message);
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path, label) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		fail(`Unable to read valid ${label}.`);
	}
}

export function main() {
	try {
		const baseline = readJson(BASELINE_PATH, "audit baseline");
		const lockfileBytes = readFileSync(LOCKFILE_PATH);
		const lockfile = readJson(LOCKFILE_PATH, "package lock");
		const manifest = readJson(MANIFEST_PATH, "package manifest");
		const execution = spawnSync("npm", ["audit", "--json", "--audit-level=high"], {
			cwd: ROOT,
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
			timeout: 120_000,
		});
		const result = validateAuditExecution(execution, {
			baseline,
			lockfile,
			lockfileSha256: sha256(lockfileBytes),
			manifest,
		});
		console.log(`Temporary accepted-development audit matched exactly for pi-fallow@${manifest.version}: ${result.findingCount} findings and ${result.advisoryCount} advisories; expires ${result.expiresAt}.`);
		console.log(REMEDIATION);
	} catch (error) {
		const message = error instanceof AuditBaselineError ? error.message : "Unexpected audit baseline validator failure.";
		console.error(`Accepted development audit rejected: ${message}`);
		process.exitCode = 1;
	}
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) main();
