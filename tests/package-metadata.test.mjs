import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const workflowNames = ["ci.yml", "codeql.yml", "release.yml"];
const workflows = Object.fromEntries(await Promise.all(
	workflowNames.map(async (name) => [name, await readFile(join(root, ".github", "workflows", name), "utf8")]),
));
const dependabot = await readFile(join(root, ".github", "dependabot.yml"), "utf8");

describe("package and automation metadata", () => {
	it("matches the minimum Node version required by current Pi peers", () => {
		assert.equal(manifest.engines.node, ">=22.19");
		assert.equal(manifest.packageManager, "npm@11.6.2");
	});

	it("pins analysis tooling and enables npm provenance", () => {
		assert.deepEqual(
			Object.fromEntries(["c8", "esbuild", "fallow"].map((name) => [name, manifest.devDependencies[name]])),
			{ c8: "12.0.0", esbuild: "0.28.1", fallow: "3.14.0" },
		);
		assert.equal(manifest.publishConfig.provenance, true);
		assert.match(manifest.scripts["publish:public"], /--provenance/);
		assert.doesNotMatch(JSON.stringify(manifest.scripts), /npx -y (?:esbuild|fallow)/);
	});

	it("pins every workflow action to a full commit SHA", () => {
		for (const workflow of Object.values(workflows)) {
			for (const reference of workflow.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/g)) {
				assert.match(reference[1], /^[a-f0-9]{40}$/);
			}
		}
	});

	it("keeps production auditing strict and bounds the accepted development audit to CI and v0.4.0 release validation", () => {
		assert.equal(manifest.scripts["audit:production"], "npm audit --omit=dev --audit-level=high");
		assert.equal(manifest.scripts["audit:all"], "npm audit --audit-level=high");
		assert.equal(manifest.scripts["audit:accepted-development"], "node scripts/audit-accepted-development.mjs");
		assert.equal(manifest.scripts["audit:release"], "npm run audit:production && npm run audit:accepted-development");
		assert.match(workflows["ci.yml"], /Audit complete dependency tree against accepted-development baseline\n\s+run: npm run audit:accepted-development/);
		assert.match(workflows["release.yml"], /run: npm run check:publish/);
		assert.match(manifest.scripts["check:publish"], /npm run audit:release && npm run package:smoke/);
		assert.doesNotMatch(manifest.scripts["check:publish"], /audit:all/);
	});

	it("configures npm and GitHub Actions dependency updates", () => {
		assert.match(dependabot, /package-ecosystem: npm/);
		assert.match(dependabot, /package-ecosystem: github-actions/);
	});
});
