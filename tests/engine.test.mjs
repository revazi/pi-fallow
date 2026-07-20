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
		executor: async (_pi, args) => ({
			binary: "fixture-fallow",
			args,
			result: {
				stdout,
				stderr: options.stderr ?? "",
				code: options.code ?? 0,
				killed: options.killed ?? false,
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
			assert.equal("result" in result, false);
			assert.equal("parsed" in result, false);
			assert.equal("text" in result.formatted, false);
			assert.equal(result.details.exitCode, 0);
			assert.match(result.content, /Raw JSON:/);
		} finally {
			await rm(cwd, { recursive: true, force: true });
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
