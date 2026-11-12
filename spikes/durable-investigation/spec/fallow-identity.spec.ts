import assert from "node:assert/strict";
import { access, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ContractError } from "../src/contracts.ts";
import { inspectFallowExecutable, verifyFallowExecutable } from "../src/fallow-identity.ts";

const expectCode = async (value: Promise<unknown>, code: string) => assert.rejects(value, (error: unknown) => error instanceof ContractError && error.code === code);
const script = (version: string, comment = "") => `#!${process.execPath}\n// ${comment}\nconsole.log(${JSON.stringify(version)});\n`;

test("standalone executable admission pins version, bytes, path binding, policy and schema", async () => {
	const root = await mkdtemp(join(tmpdir(), "fallow-identity-"));
	try {
		const executable = join(root, "fake");
		const other = join(root, "other");
		const link = join(root, "link");
		await writeFile(executable, script("fallow 3.36.0"), { mode: 0o700 });
		await writeFile(other, script("fallow 3.36.0"), { mode: 0o700 });
		await symlink(executable, link);
		await expectCode(inspectFallowExecutable("fallow"), "fallow-executable");
		await expectCode(inspectFallowExecutable(join(root, "missing")), "fallow-executable");
		const identity = await inspectFallowExecutable(link);
		await verifyFallowExecutable(identity);
		await expectCode(verifyFallowExecutable({ ...identity, adapterPolicy: "other" }), "fallow-identity");
		await expectCode(verifyFallowExecutable({ ...identity, outputSchema: "other" }), "fallow-identity");
		await writeFile(executable, script("fallow 3.36.0", "replacement"));
		await expectCode(verifyFallowExecutable(identity), "fallow-executable-drift");
		await writeFile(executable, script("fallow 3.36.0"));
		await rm(link);
		await symlink(other, link);
		await expectCode(verifyFallowExecutable(identity), "fallow-executable-drift");
		await writeFile(other, script("fallow 9.0.0"));
		await expectCode(inspectFallowExecutable(other), "fallow-version");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("standalone revalidation rejects version drift even when executable bytes are unchanged", async () => {
	const root = await mkdtemp(join(tmpdir(), "fallow-version-drift-"));
	try {
		const executable = join(root, "fake");
		const versionFile = join(root, "version");
		await writeFile(versionFile, "fallow 3.36.0");
		await writeFile(executable, `#!${process.execPath}\nconst fs = require('node:fs');\nconsole.log(fs.readFileSync(${JSON.stringify(versionFile)}, 'utf8'));\n`, { mode: 0o700 });
		const identity = await inspectFallowExecutable(executable);
		await writeFile(versionFile, "fallow 3.35.0");
		await expectCode(verifyFallowExecutable(identity), "fallow-version");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("standalone admission checks the pinned native Fallow if already installed", async (t) => {
	const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
	const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
	if (!platform || !arch) return t.skip("no native binary path defined for this platform");
	const executable = fileURLToPath(new URL(`../../../node_modules/@fallow-cli/${platform}-${arch}/fallow`, import.meta.url));
	try { await access(executable); } catch (error: any) { if (error.code === "ENOENT") return t.skip("pinned native Fallow is not already installed"); throw error; }
	const identity = await inspectFallowExecutable(executable);
	assert.equal(identity.version, "3.36.0");
	await verifyFallowExecutable(identity);
});
