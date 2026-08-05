import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { validateAuditExecution } from "../scripts/audit-accepted-development.mjs";

const baseline = JSON.parse(await readFile(new URL("../.github/npm-audit-accepted-development.json", import.meta.url), "utf8"));
const validNow = new Date("2026-08-05T12:00:00.000Z");

describe("temporary accepted-development audit baseline", () => {
	it("accepts the exact known Pi development-tree audit result", () => {
		const result = validate(auditReport());
		assert.deepEqual(result, {
			expiresAt: baseline.expiresAt,
			findingCount: 3,
			advisoryCount: 7,
		});
	});

	it("rejects an unexpected advisory", () => {
		const report = auditReport();
		report.vulnerabilities.undici.via.push(advisory("undici", {
			source: 9999999,
			url: "https://github.com/advisories/GHSA-test-test-test",
			severity: "high",
			range: ">=8.0.0 <9.0.0",
		}));
		assert.throws(() => validate(report), /changed advisory count/);
	});

	it("rejects an unexpected vulnerability package", () => {
		const report = auditReport();
		report.vulnerabilities["synthetic-package"] = structuredClone(report.vulnerabilities.undici);
		report.vulnerabilities["synthetic-package"].name = "synthetic-package";
		assert.throws(() => validate(report), /vulnerability package set changed/);
	});

	it("rejects an unexpected node path", () => {
		const report = auditReport();
		report.vulnerabilities.undici.nodes = ["node_modules/undici"];
		assert.throws(() => validate(report), /nodes for undici changed/);
	});

	it("rejects missing and fully fixed findings", () => {
		const missing = auditReport();
		delete missing.vulnerabilities["brace-expansion"];
		assert.throws(() => validate(missing), /vulnerability package set changed/);

		const fixed = auditReport();
		fixed.vulnerabilities = {};
		fixed.metadata.vulnerabilities = zeroCounts();
		assert.throws(
			() => validateAuditExecution(execution(fixed, 0), options()),
			/no blocking vulnerabilities; the accepted-risk baseline must now be removed/,
		);
	});

	it("rejects lockfile digest and vulnerable-node drift", () => {
		assert.throws(
			() => validate(auditReport(), { lockfileSha256: "0".repeat(64) }),
			/package-lock\.json changed outside the accepted development-audit boundary/,
		);

		const lockfile = lockfileForBaseline();
		lockfile.packages["node_modules/@earendil-works/pi-coding-agent/node_modules/undici"].version = "8.9.0";
		assert.throws(() => validate(auditReport(), { lockfile }), /Locked version or node changed for undici/);
	});

	it("rejects use outside the accepted v0.4.0 package scope", () => {
		assert.throws(
			() => validate(auditReport(), { manifest: { name: "pi-fallow", version: "0.4.1" } }),
			/limited to pi-fallow@0\.4\.0/,
		);
		assert.throws(
			() => validate(auditReport(), { manifest: { name: "another-package", version: "0.4.0" } }),
			/limited to pi-fallow/,
		);
	});

	it("rejects malformed audit JSON and malformed report shapes", () => {
		assert.throws(
			() => validateAuditExecution({ status: 1, signal: null, error: undefined, stdout: "not json" }, options()),
			/malformed JSON/,
		);
		const report = auditReport();
		report.extra = true;
		assert.throws(() => validate(report), /audit report changed shape/);
	});

	it("rejects audit command failures without inspecting partial output", () => {
		assert.throws(
			() => validateAuditExecution({ status: 2, signal: null, error: undefined, stdout: "{}" }, options()),
			/execution status instead of a vulnerability result/,
		);
		assert.throws(
			() => validateAuditExecution({ status: null, signal: "SIGTERM", error: undefined, stdout: "" }, options()),
			/did not complete normally/,
		);
	});

	it("rejects the baseline at expiry and prevents deadline extension", () => {
		assert.throws(
			() => validateAuditExecution(execution(auditReport()), options({ now: new Date(baseline.expiresAt) })),
			/Temporary audit baseline expired.*published release containing upstream fix/s,
		);

		const extended = structuredClone(baseline);
		extended.expiresAt = "2026-08-20T00:00:00.000Z";
		assert.throws(
			() => validateAuditExecution(execution(auditReport()), options({ baseline: extended })),
			/expiry exceeds the reviewed deadline/,
		);
	});

	it("rejects finding, advisory, and aggregate severity drift", () => {
		const findingSeverity = auditReport();
		findingSeverity.vulnerabilities.undici.severity = "critical";
		assert.throws(() => validate(findingSeverity), /undici changed severity/);

		const advisorySeverity = auditReport();
		advisorySeverity.vulnerabilities.undici.via[0].severity = "high";
		assert.throws(() => validate(advisorySeverity), /changed severity/);

		const advisoryScore = auditReport();
		advisoryScore.vulnerabilities.undici.via[0].cvss.score = 9;
		assert.throws(() => validate(advisoryScore), /changed cvss/);

		const aggregateSeverity = auditReport();
		aggregateSeverity.metadata.vulnerabilities.high = 3;
		aggregateSeverity.metadata.vulnerabilities.total = 4;
		assert.throws(() => validate(aggregateSeverity), /severity counts changed/);
	});
});

function validate(report, overrides = {}) {
	return validateAuditExecution(execution(report), options(overrides));
}

function options(overrides = {}) {
	return {
		baseline: structuredClone(baseline),
		lockfile: lockfileForBaseline(),
		lockfileSha256: baseline.lockfileSha256,
		manifest: { name: "pi-fallow", version: "0.4.0" },
		now: validNow,
		...overrides,
	};
}

function execution(report, status = 1) {
	return { status, signal: null, error: undefined, stdout: JSON.stringify(report) };
}

function lockfileForBaseline() {
	return {
		lockfileVersion: 3,
		packages: Object.fromEntries(
			baseline.findings.flatMap((finding) => finding.nodes.map((node) => [node, { version: finding.version }])),
		),
	};
}

function auditReport() {
	return {
		auditReportVersion: 2,
		vulnerabilities: Object.fromEntries(baseline.findings.map((finding) => [finding.name, auditFinding(finding)])),
		metadata: {
			vulnerabilities: structuredClone(baseline.vulnerabilityCounts),
			dependencies: { prod: 1, dev: 351, optional: 67, peer: 4, peerOptional: 0, total: 351 },
		},
	};
}

function auditFinding(finding) {
	return {
		name: finding.name,
		severity: finding.severity,
		isDirect: finding.isDirect,
		via: [...finding.via, ...finding.advisories.map((item) => advisory(finding.name, item))],
		effects: [...finding.effects],
		range: finding.range,
		nodes: [...finding.nodes],
		fixAvailable: structuredClone(finding.fixAvailable),
	};
}

function advisory(packageName, item) {
	return {
		source: item.source,
		name: packageName,
		dependency: packageName,
		title: item.title ?? `Synthetic ${packageName} advisory fixture`,
		url: item.url,
		severity: item.severity,
		cwe: structuredClone(item.cwe ?? ["CWE-400"]),
		cvss: structuredClone(item.cvss ?? { score: 7.5, vectorString: "CVSS:3.1/AV:N" }),
		range: item.range,
	};
}

function zeroCounts() {
	return { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
}
