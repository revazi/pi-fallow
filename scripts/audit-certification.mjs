import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertEvidenceSubset } from "./report-certification.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const fixture = new URL("../tests/fixtures/fallow/audit-projection-3.42.0.json", import.meta.url);

function execute(command, args, cwd, env) {
	const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
	assert.equal(result.error, undefined, "synthetic audit command could not start");
	return result;
}

function project(report) {
	const { kind, schema_version, version, command, verdict, changed_files_count, base_ref, attribution } = report;
	return {
		kind, schema_version, version, command, verdict, changed_files_count, base_ref, attribution,
		dead_code: { unused_exports: report.dead_code.unused_exports.map(({ path, export_name, introduced, effective_severity }) => ({ path, export_name, introduced, effective_severity })) },
	};
}

export async function verifyAuditEvidence() {
	const container = await mkdtemp(join(tmpdir(), "pi-fallow-audit-cert-"));
	const root = join(container, "project");
	const env = {
		PATH: [join(repository, "node_modules/.bin"), dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
		HOME: join(container, "home"), XDG_CACHE_HOME: join(container, "cache"), XDG_CONFIG_HOME: join(container, "config"),
		FALLOW_TELEMETRY: "0", NO_COLOR: "1", GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Synthetic", GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
		GIT_COMMITTER_NAME: "Synthetic", GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
	};
	try {
		await mkdir(root);
		await writeFile(join(root, "package.json"), '{"name":"synthetic","type":"module"}\n');
		await writeFile(join(root, ".fallowrc.json"), '{"entry":["index.js"]}\n');
		await writeFile(join(root, "index.js"), 'import { used } from "./lib.js"; console.log(used);\n');
		const source = "export const used = 1;\nexport const unused = 2;\n";
		await writeFile(join(root, "lib.js"), source);
		for (const args of [["init", "-q"], ["add", "."], ["commit", "-qm", "base"]]) {
			assert.equal(execute("git", args, root, env).status, 0, "synthetic Git setup failed");
		}
		const args = ["audit", "--base", "HEAD", "--gate", "new-only", "--only", "dead-code", "--format", "json", "--quiet", "--no-cache"];
		const fallow = join(repository, "node_modules/.bin/fallow");
		const run = (extra = []) => execute(fallow, [...args, ...extra], root, env);
		await writeFile(join(root, "lib.js"), `${source}// changed\n`);
		const inherited = run();
		await writeFile(join(root, "lib.js"), `${source}// changed\nexport const addedUnused = 3;\n`);
		const introduced = run();
		const brief = run(["--brief"]);
		assert.deepEqual([inherited.status, introduced.status, brief.status], [0, 1, 0]);
		const evidence = { inherited: project(JSON.parse(inherited.stdout)), new: project(JSON.parse(introduced.stdout)), brief: project(JSON.parse(brief.stdout)) };
		assertEvidenceSubset(evidence, JSON.parse(await readFile(fixture, "utf8")), "audit certification");
	} finally {
		await rm(container, { recursive: true, force: true });
	}
}
