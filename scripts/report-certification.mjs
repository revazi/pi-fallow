import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(repository, "tests/fixtures/fallow");
const reportCommands = {
	"dead-code": ["dead-code", "--no-cache"],
	"dupes": ["dupes", "--no-cache", "--min-tokens", "20", "--min-lines", "3"],
	"health": ["health", "--no-cache"],
	"security": ["security", "--no-cache", "--surface"],
	"combined": ["--no-cache", "--dupes-min-tokens", "20", "--dupes-min-lines", "3"],
	"type-aware-unavailable": ["health", "--no-cache", "--type-aware", "--type-aware-project", "missing-tsconfig.json", "--type-coupling"],
	"similar-status": ["similar-code", "status"],
	"similar-missing-model": ["similar-code", "--no-cache"],
	"coverage-missing-value": ["coverage", "analyze", "--runtime-coverage"],
	"inspect-missing-inputs": ["similar-code", "inspect"],
	"review-missing-inputs": ["similar-code", "review"],
};
const typeAwarePartialCommand = [
	"health", "--no-cache", "--type-aware",
	"--type-aware-project", "tsconfig.valid.json",
	"--type-aware-project", "tsconfig.broken.json",
	"--type-coupling",
];
const helpCommands = {
	"coverage-analyze": ["coverage", "analyze"],
	"similar-discovery": ["similar-code"],
	"similar-inspect": ["similar-code", "inspect"],
	"similar-review": ["similar-code", "review"],
};

function execute(args, root) {
	// Do not inherit cloud selection, credentials, model/cache overrides, or a
	// user's home/config. PATH only exposes the pinned package and this Node.
	const home = join(root, "home");
	const result = spawnSync(join(repository, "node_modules/.bin/fallow"), args, {
		cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
		env: {
			PATH: [join(repository, "node_modules/.bin"), dirname(process.execPath)].join(delimiter),
			HOME: home, XDG_CACHE_HOME: join(home, "cache"), XDG_CONFIG_HOME: join(home, "config"),
			FALLOW_TELEMETRY: "0", NO_COLOR: "1",
		},
	});
	assert.ifError(result.error);
	assert.equal(result.signal, null, `${args.join(" ")}: terminated by a signal`);
	return result;
}

function normalizeReport(report) {
	// Only measured nondeterminism is replaced. Preserve all actionable and
	// completeness fields, including unknown fields, in the frozen evidence.
	normalizeNumericProperty(report, "elapsed_ms");
	normalizeNumericProperty(report.check, "elapsed_ms");
	normalizeTypeAwareTimings(report._meta?.type_aware);
	normalizeRunIdentity(report._meta);
	if (report.kind === "similar-code-status") report.cache_dir = "<ISOLATED_MODEL_CACHE>";
	return report;
}

function normalizeNumericProperty(record, key) {
	if (record && key in record) record[key] = 0;
}

function normalizeTypeAwareTimings(typeAware) {
	normalizeNumericProperty(typeAware, "elapsed_ms");
	for (const key of Object.keys(typeAware?.phase_timings_ms ?? {})) typeAware.phase_timings_ms[key] = 0;
}

function normalizeRunIdentity(meta) {
	if (!meta?.telemetry) return;
	if ("analysis_run_id" in meta.telemetry) meta.telemetry.analysis_run_id = "<RUN_ID>";
}

export function projectHelp(text) {
	const usage = text.split("\n").find((line) => line.startsWith("Usage: "));
	assert.ok(usage, "nested help: missing Usage declaration");
	const options = {};
	for (const line of text.split("\n")) {
		const option = line.match(/^\s+(?:-\w, )?(--[\w-]+)(?:\s+(\[?<[^>]+>\]?))?/);
		if (option) options[option[1]] = option[2] ?? "boolean";
	}
	return { requiredUsage: usage.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim(), options };
}

export async function collectReportEvidence() {
	const projectText = await readFile(join(fixtures, "report-project.json"), "utf8");
	const partialProjectText = await readFile(join(fixtures, "report-partial-project.json"), "utf8");
	const manifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
	const container = await mkdtemp(join(tmpdir(), "pi-fallow-certification-"));
	const root = join(container, "base");
	const partialRoot = join(container, "type-aware-partial");
	try {
		await mkdir(root);
		await materializeProject(root, projectText);
		await mkdir(partialRoot);
		await materializeProject(partialRoot, partialProjectText);
		const versionResult = execute(["--version"], root);
		assert.equal(versionResult.status, 0, "pinned executable version check failed");
		const version = versionResult.stdout.split("\n")[0].trim();
		assert.equal(version, `fallow ${manifest.devDependencies.fallow}`, "capture requires the pinned Fallow target");
		return {
			version: manifest.devDependencies.fallow,
			inputSha256: {
				base: createHash("sha256").update(projectText).digest("hex"),
				typeAwarePartial: createHash("sha256").update(partialProjectText).digest("hex"),
			},
			reports: { ...captureReports(root), "type-aware-partial": captureReport(partialRoot, typeAwarePartialCommand) },
			help: captureHelp(root),
		};
	} finally {
		await rm(container, { recursive: true, force: true });
	}
}

async function materializeProject(root, projectText) {
	await mkdir(join(root, "node_modules"));
	for (const [name, content] of Object.entries(JSON.parse(projectText))) {
		assert.equal(dirname(name), ".", "capture inputs must be flat project files");
		await writeFile(join(root, name), content);
	}
}

function captureReports(root) {
	return Object.fromEntries(Object.entries(reportCommands).map(([id, command]) => [id, captureReport(root, command)]));
}

function captureReport(root, command) {
	const args = [...command, "--format", "json", "--quiet"];
	const result = execute(args, root);
	return { args, exitCode: result.status, report: normalizeReport(JSON.parse(result.stdout)) };
}

function captureHelp(root) {
	return Object.fromEntries(Object.entries(helpCommands).map(([id, command]) => {
		const args = [...command, "--help"];
		const result = execute(args, root);
		assert.equal(result.status, 0, `${id}: help failed`);
		return [id, { args, ...projectHelp(result.stdout) }];
	}));
}

// Known fields must remain compatible; additive object fields/options are fine.
// Arrays are exact for this fixed tiny input, not a general report comparator.
export function assertEvidenceSubset(actual, expected, context = "report certification") {
	if (Object(expected) !== expected) {
		assert.equal(actual, expected, context);
		return;
	}
	assert.equal(typeof actual, "object", `${context}: expected object`);
	assert.notEqual(actual, null, `${context}: expected non-null object`);
	assert.equal(Array.isArray(actual), Array.isArray(expected), `${context}: changed object/array shape`);
	if (Array.isArray(expected)) assert.equal(actual.length, expected.length, `${context}: changed array length`);
	for (const [key, value] of Object.entries(expected)) assertEvidenceSubset(actual[key], value, `${context}.${key}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	assert.deepEqual(process.argv.slice(2), ["--write"], "Usage: node scripts/report-certification.mjs --write");
	const evidence = await collectReportEvidence();
	await writeFile(join(fixtures, `reports-${evidence.version}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
	console.log(`Captured ${Object.keys(evidence.reports).length} reports and ${Object.keys(evidence.help).length} help contracts.`);
}
