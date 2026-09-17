import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(await readFile(join(root, "benchmarks", "popular-packages.json"), "utf8"));
const baseline = JSON.parse(await readFile(join(root, "benchmarks", "baselines", "popular-packages-v0.6.2.json"), "utf8"));
const readme = await readFile(join(root, "README.md"), "utf8");
const categories = new Set(["http-framework", "ui-framework", "library"]);

describe("popular-packages benchmark", () => {
	it("pins a unique, complete corpus of popular JS/TS packages", () => {
		assert.equal(corpus.benchmarkVersion, 1);
		assert.ok(corpus.packages.length >= 12);
		const ids = corpus.packages.map((pkg) => pkg.id);
		assert.equal(new Set(ids).size, ids.length);
		for (const pkg of corpus.packages) {
			assert.equal(typeof pkg.id, "string");
			assert.equal(typeof pkg.name, "string");
			assert.equal(typeof pkg.repo, "string");
			assert.equal(typeof pkg.ref, "string");
			assert.match(pkg.repo, /^https:\/\/github\.com\//);
			assert.ok(pkg.ref.length > 0);
			assert.ok(categories.has(pkg.category), `${pkg.id} has unknown category ${pkg.category}`);
		}
	});

	it("records a successful /fallow issues snapshot for every corpus package", () => {
		assert.equal(baseline.benchmarkVersion, corpus.benchmarkVersion);
		assert.equal(baseline.config.schedule, "concurrent");
		assert.equal(baseline.config.shallowClone, true);
		assert.equal(baseline.config.defaultFallowConfig, true);
		assert.equal(baseline.measurements.length, corpus.packages.length);
		const byId = new Map(baseline.measurements.map((item) => [item.id, item]));
		for (const pkg of corpus.packages) {
			const measurement = byId.get(pkg.id);
			assert.ok(measurement, `Missing measurement for ${pkg.id}`);
			assert.equal(measurement.error, undefined, `${pkg.id} recorded ${measurement.error}`);
			assert.equal(measurement.ref, pkg.ref);
			assert.ok(measurement.filesAnalyzed > 0, `${pkg.id} analyzed no files`);
			assert.ok(measurement.wallMs > 0, `${pkg.id} recorded no wall time`);
			assert.ok(measurement.navigatorFindingCount >= 0);
			assert.equal(typeof measurement.healthScore, "number");
			assert.match(measurement.healthGrade, /^[A-F]$/);
			assert.match(measurement.gitSha, /^[a-f0-9]{40}$/);
		}
	});

	it("documents the popular-packages snapshot in the README benchmarks section", () => {
		assert.match(readme, /## 📊 Benchmarks/);
		assert.match(readme, /### 📦 Popular packages/);
		assert.match(readme, /npm run bench:packages/);
		assert.match(readme, /8,493/);
		assert.match(readme, /svelte@5\.57\.0/);
		assert.match(readme, /not "which package is healthier/);
		assert.match(readme, /benchmarks\/baselines\/popular-packages-v0\.6\.2\.json/);
		assert.match(readme, /## 🧩 More Pi packages by Revaz/);
		assert.match(readme, /pi-jscpd/);
		assert.match(readme, /pi-reads/);
	});
});
