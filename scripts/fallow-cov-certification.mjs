import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertEvidenceSubset } from "./report-certification.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(repository, "tests/fixtures/fallow");
const packageName = "@fallow-cli/fallow-cov";
const certifiedSidecarVersion = "0.4.1";

function executableOnPath(name) {
	const executable = process.platform === "win32" ? `${name}.cmd` : name;
	return (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, executable)).find(existsSync);
}

function resolveSidecar() {
	const launcher = executableOnPath("fallow-cov");
	assert.ok(launcher, `Install ${packageName}@${certifiedSidecarVersion} for optional certification`);
	const realLauncher = realpathSync(launcher);
	const packageRoot = dirname(dirname(realLauncher));
	const wrapper = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	assert.equal(wrapper.name, packageName, "unexpected fallow-cov launcher package");
	assert.equal(wrapper.version, certifiedSidecarVersion, "unexpected fallow-cov version");
	const scope = dirname(packageRoot);
	const binaryName = process.platform === "win32" ? "fallow-cov.exe" : "fallow-cov";
	const candidates = readdirSync(scope)
		.filter((name) => name.startsWith("fallow-cov-") && name !== "fallow-cov")
		.map((name) => join(scope, name, binaryName))
		.filter((path) => existsSync(path) && existsSync(`${path}.sig`));
	assert.equal(candidates.length, 1, "expected one signed platform fallow-cov binary");
	return { binary: candidates[0], package: wrapper };
}

function run(command, args, options) {
	const result = spawnSync(command, args, {
		encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options,
	});
	assert.ifError(result.error);
	assert.equal(result.signal, null, `${basename(command)} ${args.join(" ")}: terminated by a signal`);
	return result;
}

async function materialize(root, text) {
	await mkdir(join(root, "node_modules"));
	for (const [name, content] of Object.entries(JSON.parse(text))) {
		assert.equal(dirname(name), ".", "coverage fixture inputs must be flat project files");
		await writeFile(join(root, name), content);
	}
}

function normalize(report) {
	report.elapsed_ms = 0;
	if (report._meta?.telemetry?.analysis_run_id) report._meta.telemetry.analysis_run_id = "<RUN_ID>";
	return report;
}

export async function collectCoverageEvidence() {
	assert.equal(Number(process.versions.node.split(".")[0]), 24, "coverage certification is pinned to Node 24");
	const projectText = await readFile(join(fixtures, "coverage-project.json"), "utf8");
	const manifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
	const sidecar = resolveSidecar();
	const container = await mkdtemp(join(tmpdir(), "pi-fallow-cov-certification-"));
	const root = join(container, "project");
	const coverage = join(container, "v8");
	try {
		await mkdir(root);
		await mkdir(coverage);
		await materialize(root, projectText);
		const nodeResult = run(process.execPath, [join(root, "runner.js")], {
			cwd: root,
			env: { PATH: dirname(process.execPath), HOME: join(container, "home"), NODE_V8_COVERAGE: coverage, NO_COLOR: "1" },
		});
		assert.equal(nodeResult.status, 0, "fixture runtime capture failed");
		assert.equal(nodeResult.stdout.trim(), "CERTIFICATION");
		assert.ok(readdirSync(coverage).some((name) => extname(name) === ".json"), "Node did not emit V8 coverage");
		const args = ["coverage", "analyze", "--runtime-coverage", coverage, "--format", "json", "--quiet", "--no-cache"];
		const result = run(join(repository, "node_modules/.bin/fallow"), args, {
			cwd: root,
			env: {
				PATH: [join(repository, "node_modules/.bin"), dirname(process.execPath)].join(delimiter),
				HOME: join(container, "home"), XDG_CACHE_HOME: join(container, "cache"),
				XDG_CONFIG_HOME: join(container, "config"), FALLOW_TELEMETRY: "0", NO_COLOR: "1",
				FALLOW_COV_BIN: sidecar.binary,
			},
		});
		assert.equal(result.status, 0, result.stdout || result.stderr || "coverage analyze failed");
		return {
			fallowVersion: manifest.devDependencies.fallow,
			nodeMajor: 24,
			sidecar: { package: packageName, version: sidecar.package.version, license: sidecar.package.license },
			inputSha256: createHash("sha256").update(projectText).digest("hex"),
			args: ["coverage", "analyze", "--runtime-coverage", "<V8_COVERAGE_DIR>", "--format", "json", "--quiet", "--no-cache"],
			exitCode: result.status,
			report: normalize(JSON.parse(result.stdout)),
		};
	} finally {
		await rm(container, { recursive: true, force: true });
	}
}

async function main() {
	const evidence = await collectCoverageEvidence();
	const destination = join(fixtures, `coverage-report-${evidence.fallowVersion}.json`);
	if (process.argv[2] === "--write") {
		assert.equal(process.argv.length, 3, "Usage: fallow-cov-certification.mjs [--write]");
		await writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`);
		console.log(`Captured ${evidence.report.kind} with ${evidence.report.runtime_coverage.findings.length} finding(s).`);
		return;
	}
	assert.equal(process.argv.length, 2, "Usage: fallow-cov-certification.mjs [--write]");
	const frozen = JSON.parse(await readFile(destination, "utf8"));
	assertEvidenceSubset(evidence, frozen, "fallow-cov certification");
	console.log("Optional fallow-cov certification passed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
