import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "pi-fallow-package-"));
const packDir = join(workspace, "pack");
const installDir = join(workspace, "install");

try {
	const packResult = packPackage(packDir);
	validateContents(packResult.files.map((file) => file.path));
	installTarball(join(packDir, packResult.filename), installDir);
	validateInstalledPackage(installDir);
	console.log(`Package smoke check passed (${packResult.filename}, ${packResult.files.length} files).`);
} finally {
	rmSync(workspace, { recursive: true, force: true });
}

function packPackage(destination) {
	mkdirSync(destination, { recursive: true });
	const raw = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], {
		cwd: root,
		encoding: "utf8",
	});
	const [result] = JSON.parse(raw);
	assert.ok(result?.filename, "npm pack did not return a tarball filename.");
	return result;
}

function validateContents(paths) {
	for (const required of ["package.json", "README.md", "LICENSE", "extensions/index.ts", "extensions/fallow.ts"]) {
		assert.ok(paths.includes(required), `Published package is missing ${required}.`);
	}
	for (const forbidden of ["benchmarks/", "coverage/", "node_modules/", "scripts/", "tests/"]) {
		assert.ok(paths.every((path) => !path.startsWith(forbidden)), `Published package unexpectedly contains ${forbidden}.`);
	}
}

function installTarball(tarball, cwd) {
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "package.json"), "{\"private\":true}\n", { flag: "wx" });
	execFileSync("npm", ["install", "--package-lock=false", "--ignore-scripts", "--legacy-peer-deps", tarball], {
		cwd,
		stdio: "pipe",
	});
}

function validateInstalledPackage(cwd) {
	const packageRoot = join(cwd, "node_modules", "pi-fallow");
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	assert.equal(manifest.name, "pi-fallow");
	assert.deepEqual(manifest.pi?.extensions, ["./extensions/index.ts"]);
	assert.ok(readFileSync(join(packageRoot, "extensions", "index.ts"), "utf8").length > 0);
}
