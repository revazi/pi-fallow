import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: registerPiFallow } = await jiti.import("../extensions/fallow.ts");
const {
	createFallowCompatibilityCheck,
	diagnoseFallowCapabilities,
	formatFallowCompatibility,
	sendFallowCompatibilityMessage,
} = await jiti.import("../extensions/fallow/compatibility.ts");
const { certifiedFallowCapabilities } = await jiti.import("../extensions/fallow/certified-capabilities.ts");
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const frozen = JSON.parse(await readFile(new URL("./fixtures/fallow/capabilities-3.22.0.json", import.meta.url), "utf8"));
const frozenReports = JSON.parse(await readFile(new URL("./fixtures/fallow/reports-3.22.0.json", import.meta.url), "utf8"));
const frozenSimilar = JSON.parse(await readFile(new URL("./fixtures/fallow/similar-code-report-3.22.0.json", import.meta.url), "utf8"));
const frozenCoverage = JSON.parse(await readFile(new URL("./fixtures/fallow/coverage-report-3.22.0.json", import.meta.url), "utf8"));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const processFixture = resolve(root, "tests/fixtures/process-fixture.mjs");

function changed(change) {
	const schema = structuredClone(frozen);
	change(schema);
	return schema;
}

function command(schema, name) {
	return schema.commands.find((entry) => entry.name === name);
}

function globalFlag(schema, name) {
	return schema.global_flags.find((entry) => entry.name === name);
}

function diagnosticText(report) {
	return report.incompatible.map((item) => `${item.capability}: ${item.detail} ${item.affectedCommands.join(" ")}`).join("\n");
}

describe("installed Fallow capability drift", () => {
	it("accepts the frozen certified schema and binds both projections to the pinned target", () => {
		assert.equal(frozen.version, manifest.devDependencies.fallow);
		assert.equal(certifiedFallowCapabilities.certifiedVersion, manifest.devDependencies.fallow);
		assert.deepEqual(Object.keys(certifiedFallowCapabilities.commands), frozen.commands.map((entry) => entry.name));
		assert.deepEqual(certifiedFallowCapabilities.globalFlags, frozen.global_flags.map((entry) => entry.name));
		for (const entry of frozen.commands) assert.deepEqual(certifiedFallowCapabilities.commands[entry.name], entry.flags.map((flag) => flag.name));
		assert.deepEqual(certifiedFallowCapabilities.issueTypes, frozen.issue_types.map((entry) => [entry.id, entry.command, entry.result_key ?? null]));
		assert.deepEqual(certifiedFallowCapabilities.outputFormats, frozen.output_formats);
		assert.deepEqual(certifiedFallowCapabilities.resourceUris, frozen.mcp_resources.resources.map((entry) => entry.uri));
		assert.deepEqual(certifiedFallowCapabilities.relatedSchemaCommands, Object.entries(frozen.related_schemas).filter(([key]) => key.endsWith("_command")).map(([, value]) => value));
		assert.deepEqual(certifiedFallowCapabilities.reportSchemas, {
			combined: String(frozenReports.reports.combined.report.schema_version),
			"dead-code": String(frozenReports.reports["dead-code"].report.schema_version),
			dupes: String(frozenReports.reports.dupes.report.schema_version),
			health: String(frozenReports.reports.health.report.schema_version),
			security: String(frozenReports.reports.security.report.schema_version),
			"similar-code": String(frozenSimilar.reports.discovery.schema_version),
			"runtime-coverage": String(frozenCoverage.report.schema_version),
		});
		const report = diagnoseFallowCapabilities(frozen);
		assert.equal(report.status, "compatible");
		assert.deepEqual(report.additions, []);
		assert.deepEqual(report.incompatible, []);
		assert.deepEqual(report.counts, { commands: 40, issueTypes: 117, outputFormats: 16 });
		assert.match(formatFallowCompatibility(report), /Certification is tested evidence, not an installation or runtime version constraint/);
	});

	it("treats newer optional capabilities as bounded guidance rather than incompatibility", () => {
		const report = diagnoseFallowCapabilities(changed((schema) => {
			schema.version = "99.0.0";
			schema.commands.push({ name: "future-command", flags: Array.from({ length: 20 }, (_, index) => ({ name: `--future-${index}`, type: "bool", required: false })) });
			schema.global_flags.push({ name: "--future-global", type: "bool", required: false });
			command(schema, "health").flags.push({ name: "--future-health", type: "string", required: false });
			schema.issue_types.push({ id: "future-issue", command: "health", result_key: "future_issues" });
			schema.output_formats.push("future-format");
			schema.mcp_resources.resources.push({ uri: "fallow://future" });
			schema.related_schemas.future_schema_command = "fallow future-schema";
		}));
		assert.equal(report.status, "compatible");
		assert.match(report.summary, /additive capabilities/);
		assert.deepEqual(report.additions.map((item) => item.kind), [
			"commands", "global flags", "command flags", "issue types", "output formats", "resources", "related schemas",
		]);
		assert.ok(report.additions.every((item) => item.names.length <= 8));
		assert.equal(report.incompatible.length, 0);
		assert.match(formatFallowCompatibility(report), /use the Fallow CLI directly/);
	});

	it("identifies affected Pi Fallow commands for removed and incompatible modeled capabilities", () => {
		const report = diagnoseFallowCapabilities(changed((schema) => {
			schema.commands = schema.commands.filter((entry) => entry.name !== "health");
			globalFlag(schema, "--format").possible_values = ["human"];
			globalFlag(schema, "--type-aware-project").type = "bool";
			command(schema, "fix").flags.find((flag) => flag.name === "--yes").type = "string";
			command(schema, "security").flags.push({ name: "--new-required", type: "string", required: true });
			schema.issue_types = schema.issue_types.filter((entry) => entry.id !== "unused-export");
		}));
		assert.equal(report.status, "incompatible");
		const text = diagnosticText(report);
		assert.match(text, /command health.*fallow_run health/);
		assert.match(text, /JSON output.*fallow_run dead-code/);
		assert.match(text, /type-aware-project.*fallow_run dead-code/);
		assert.match(text, /fix-preview fixed prefix --dry-run|fix-apply fixed prefix --yes/);
		assert.match(text, /security required input --new-required.*fallow_run security/);
		assert.match(text, /dead-code issue types.*unused-export.*\/fallow issues/);
	});

	it("distinguishes unmodeled certification removals and bounds every transcript-facing field", () => {
		const report = diagnoseFallowCapabilities(changed((schema) => {
			schema.version = "v".repeat(2_000);
			schema.global_flags.push({ name: `--${"future".repeat(500)}`, type: "bool", required: false });
			schema.commands = schema.commands.filter((entry) => entry.name !== "watch");
			schema.output_formats = schema.output_formats.filter((entry) => entry !== "sarif");
			schema.mcp_resources.resources = [];
			schema.related_schemas = {};
			for (const flag of schema.global_flags) flag.required = true;
		}));
		assert.equal(report.status, "incompatible");
		assert.ok(report.incompatible.length <= 12);
		assert.ok(report.incompatibleOmitted > 0);
		assert.ok(report.incompatible.every((item) => item.affectedCommands.length <= 8 && item.detail.length <= 500));
		assert.ok(report.additions.flatMap((item) => item.names).every((name) => name.length <= 120));
		assert.equal(report.installedVersion.length, 120);
		assert.ok(formatFallowCompatibility(report).length < 20_000);
		assert.match(report.advisories.join("\n"), /unmodeled commands absent.*watch/);
		assert.match(report.advisories.join("\n"), /non-JSON formats absent.*sarif/);
		assert.match(report.advisories.join("\n"), /reference resources absent/);
	});

	it("runs only the explicit read-only schema probe and sends no raw schema into context", async () => {
		const calls = [];
		let clears = 0;
		const runner = {
			clear() { clears++; },
			async execute(_pi, args, cwd, signal, timeout) {
				calls.push({ args, cwd, signal, timeout });
				return { result: { code: 0, killed: false, stdout: JSON.stringify(changed((schema) => schema.commands.push({ name: "private-future-command", flags: [] }))), stderr: "" } };
			},
		};
		const controller = new AbortController();
		const check = createFallowCompatibilityCheck({}, runner);
		const report = await check("/project", controller.signal);
		assert.equal(clears, 1);
		assert.deepEqual(calls, [{ args: ["schema", "--format", "json", "--quiet"], cwd: "/project", signal: controller.signal, timeout: 30 }]);
		assert.equal(report.status, "compatible");

		const messages = [];
		await sendFallowCompatibilityMessage({ sendMessage(message) { messages.push(message); } }, { cwd: "/project", hasUI: false }, async () => report);
		assert.equal(messages[0].customType, "fallow-compatibility");
		assert.doesNotMatch(messages[0].content, /"commands"\s*:/);
		assert.ok(messages[0].content.length < 5_000);
		assert.ok(JSON.stringify(messages[0].details).length < 10_000);
	});

	it("routes the dedicated slash command without entering normal analysis", async () => {
		const previousBin = process.env.FALLOW_BIN;
		const previousMode = process.env.PI_FALLOW_PROCESS_FIXTURE_MODE;
		let command;
		const messages = [];
		const pi = {
			registerTool() {},
			registerCommand(name, value) { if (name === "fallow") command = value; },
			registerMessageRenderer() {},
			on() {},
			sendMessage(message) { messages.push(message); },
		};
		try {
			process.env.FALLOW_BIN = processFixture;
			process.env.PI_FALLOW_PROCESS_FIXTURE_MODE = "success";
			registerPiFallow(pi);
			assert.deepEqual(messages, [], "extension loading must not probe Fallow");
			await command.handler("compatibility", { cwd: root, mode: "rpc", hasUI: false, ui: {} });
			assert.equal(messages.length, 1);
			assert.equal(messages[0].customType, "fallow-compatibility");
			assert.match(messages[0].content, /Installed Fallow: fixture/);
		} finally {
			if (previousBin === undefined) delete process.env.FALLOW_BIN; else process.env.FALLOW_BIN = previousBin;
			if (previousMode === undefined) delete process.env.PI_FALLOW_PROCESS_FIXTURE_MODE; else process.env.PI_FALLOW_PROCESS_FIXTURE_MODE = previousMode;
		}
	});

	it("reports unavailable, malformed, failed, and cancelled probes without throwing", async () => {
		assert.equal(diagnoseFallowCapabilities(null).status, "unavailable");
		for (const result of [
			{ code: 0, killed: false, stdout: "not json", stderr: "" },
			{ code: 2, killed: false, stdout: "", stderr: "x".repeat(2_000) },
			{ code: 130, killed: true, terminationReason: "cancelled", stdout: "", stderr: "" },
		]) {
			const check = createFallowCompatibilityCheck({}, { clear() {}, execute: async () => ({ result }) });
			const report = await check("/project");
			assert.equal(report.status, "unavailable");
			assert.ok(report.summary.length <= 500);
		}
	});
});
