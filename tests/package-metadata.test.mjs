import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const workflowNames = ["ci.yml", "codeql.yml", "release.yml"];
const workflows = await Promise.all(workflowNames.map((name) => readFile(join(root, ".github", "workflows", name), "utf8")));
const dependabot = await readFile(join(root, ".github", "dependabot.yml"), "utf8");

describe("package and automation metadata", () => {
	it("matches the minimum Node version required by current Pi peers", () => {
		assert.equal(manifest.engines.node, ">=22.19");
		assert.equal(manifest.packageManager, "npm@11.6.2");
	});

	it("pins analysis tooling and enables npm provenance", () => {
		assert.deepEqual(
			Object.fromEntries(["c8", "esbuild", "fallow"].map((name) => [name, manifest.devDependencies[name]])),
			{ c8: "12.0.0", esbuild: "0.28.1", fallow: "3.7.0" },
		);
		assert.equal(manifest.publishConfig.provenance, true);
		assert.match(manifest.scripts["publish:public"], /--provenance/);
		assert.doesNotMatch(JSON.stringify(manifest.scripts), /npx -y (?:esbuild|fallow)/);
	});

	it("pins every workflow action to a full commit SHA", () => {
		for (const workflow of workflows) {
			for (const reference of workflow.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/g)) {
				assert.match(reference[1], /^[a-f0-9]{40}$/);
			}
		}
	});

	it("configures npm and GitHub Actions dependency updates", () => {
		assert.match(dependabot, /package-ecosystem: npm/);
		assert.match(dependabot, /package-ecosystem: github-actions/);
	});
});
