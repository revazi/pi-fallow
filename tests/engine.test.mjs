import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { fallowEngine } = await jiti.import("../extensions/fallow/engine.ts");

function runFixture(cwd, data, options = {}) {
	const stdout = typeof data === "string" ? data : JSON.stringify(data);
	return fallowEngine.runFallowWithExecutor({
		pi: {},
		cwd,
		args: options.args ?? ["dead-code", "--format", "json", "--quiet"],
		signal: undefined,
		timeoutSecs: 10,
		throwOnExecutionError: options.throwOnExecutionError ?? false,
		outputDetail: options.outputDetail,
		executor: async (_pi, args) => ({
			binary: "fixture-fallow",
			args,
			result: {
				stdout,
				stderr: options.stderr ?? "",
				code: options.code ?? 0,
				killed: options.killed ?? false,
				terminationReason: options.terminationReason,
			},
		}),
	});
}

function largeReport() {
	const unusedExports = Array.from({ length: 500 }, (_, index) => ({
		file: `src/generated/file-${index}.ts`,
		name: `unusedExport${index}`,
		line: index + 1,
		reason: `No reachable consumer was found for generated export ${index}.`,
		actions: [{ type: "remove-export", description: `Remove unusedExport${index}.` }],
	}));
	return {
		kind: "dead-code",
		schema_version: 7,
		version: "fixture",
		elapsed_ms: 1,
		total_issues: unusedExports.length,
		summary: { unused_exports: unusedExports.length },
		unused_files: [],
		unused_exports: unusedExports,
	};
}

describe("Fallow engine result retention", () => {
	it("returns bounded execution metadata without retaining the executor or parser result", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-fallow-engine-slim-"));
		try {
			await writeFile(join(cwd, ".fallowrc.json"), "{}\n", "utf8");
			const result = await runFixture(cwd, {
				kind: "dead-code",
				total_issues: 0,
				summary: { unused_files: 0 },
				unused_files: [],
				unused_exports: [],
			});

			assert.deepEqual(result.execution, { code: 0, killed: false });
			assert.deepEqual(result.reportMetadata, { kind: "dead-code", complete: true });
			assert.equal("result" in result, false);
			assert.equal("parsed" in result, false);
			assert.equal("text" in result.formatted, false);
			assert.equal(result.details.exitCode, 0);
			assert.match(result.content, /Raw JSON:/);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("records compact report identity and conservative completeness", async () => {
		const complete = await runFixture("/tmp", {
			kind: "similar-code",
			schema_version: 9,
			version: "3.21.0",
			completion: { status: "complete", phases: [{ large: "evidence" }] },
		});
		assert.deepEqual(complete.reportMetadata, {
			kind: "similar-code",
			fallowVersion: "3.21.0",
			schemaVersion: "9",
			complete: true,
		});

		const partial = await runFixture("/tmp", {
			kind: "similar-code",
			schema_version: 9,
			version: "3.21.0",
			completion: { status: "partial" },
		});
		assert.equal(partial.reportMetadata.complete, false);
		assert.equal(partial.reportMetadata.completenessReason, "completion-partial");

		const typeAwarePartial = await runFixture("/tmp", {
			kind: "health",
			schema_version: 9,
			version: "3.21.0",
			_meta: { type_aware: { identity: { completeness: "partial" } } },
		});
		assert.equal(typeAwarePartial.reportMetadata.complete, false);
		assert.equal(typeAwarePartial.reportMetadata.completenessReason, "type-aware-partial");

		const impactUnavailable = await runFixture("/tmp", {
			kind: "impact",
			schema_version: 9,
			version: "3.21.0",
			identity: { completeness: "unavailable" },
		});
		assert.equal(impactUnavailable.reportMetadata.completenessReason, "identity-unavailable");

		const unstructured = await runFixture("/tmp", "not json", { code: 2 });
		assert.equal(unstructured.reportMetadata.complete, false);
		assert.equal(unstructured.reportMetadata.completenessReason, "exit-2");
	});

	it("applies requested detail without retaining the raw presentation", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-fallow-engine-detail-"));
		let fullOutputPath;
		try {
			const result = await runFixture(cwd, largeReport(), { outputDetail: "findings", code: 1 });
			fullOutputPath = result.formatted.fullOutputPath;
			assert.match(result.content, /Fallow findings:/);
			assert.doesNotMatch(result.content, /Raw JSON:/);
			assert.ok(fullOutputPath);
			assert.equal("errorText" in result.formatted, false);
		} finally {
			await rm(cwd, { recursive: true, force: true });
			if (fullOutputPath) await rm(dirname(fullOutputPath), { recursive: true, force: true });
		}
	});

	it("keeps truncated full output readable without retaining it in the command result", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-fallow-engine-large-"));
		let fullOutputPath;
		try {
			const report = largeReport();
			const result = await runFixture(cwd, report);
			fullOutputPath = result.formatted.fullOutputPath;

			assert.equal(result.formatted.truncated, true);
			assert.ok(fullOutputPath);
			assert.match(result.content, /Output truncated/);
			assert.match(result.content, /unusedExport0/);
			assert.equal("text" in result.formatted, false);
			assert.equal(await readFile(fullOutputPath, "utf8"), JSON.stringify(report, null, 2));
		} finally {
			await rm(cwd, { recursive: true, force: true });
			if (fullOutputPath) await rm(dirname(fullOutputPath), { recursive: true, force: true });
		}
	});
});
