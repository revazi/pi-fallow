import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assertCredentialFreeControl, resolveLockedPiHost } from "../scripts/package-smoke.mjs";

const { packageRoot: piPackageRoot } = resolveLockedPiHost();
const errorLine = "No API key found for the selected model.";
const validStderr = [
	errorLine,
	"",
	"Use /login to log into a provider via OAuth or API key. See:",
	`  ${join(piPackageRoot, "docs", "providers.md")}`,
	`  ${join(piPackageRoot, "docs", "models.md")}`,
	"",
].join("\n");

function assertControl(stderr = validStderr, overrides = {}) {
	assertCredentialFreeControl({ status: 1, stdout: "", stderr, ...overrides }, piPackageRoot);
}

describe("package-smoke credential-free negative control", () => {
	it("accepts only the locked Pi 0.84.3 auth-guidance structure", () => {
		assert.doesNotThrow(() => assertControl());
	});

	for (const [name, mutate] of [
		["wrong first line", (stderr) => stderr.replace(errorLine, "Authentication failed.")],
		["duplicate error line", (stderr) => stderr.replace(`${errorLine}\n`, `${errorLine}\n${errorLine}\n`)],
		["extra text", (stderr) => `${stderr}Unexpected guidance.\n`],
		["reversed documentation order", (stderr) => stderr.replace(
			`  ${join(piPackageRoot, "docs", "providers.md")}\n  ${join(piPackageRoot, "docs", "models.md")}`,
			`  ${join(piPackageRoot, "docs", "models.md")}\n  ${join(piPackageRoot, "docs", "providers.md")}`,
		)],
		["wrong documentation path", (stderr) => stderr.replace("docs/providers.md", "docs/authentication.md")],
		["missing trailing newline", (stderr) => stderr.slice(0, -1)],
	]) {
		it(`rejects ${name}`, () => {
			assert.throws(() => assertControl(mutate(validStderr)), assert.AssertionError);
		});
	}

	it("rejects a different exit status or non-empty stdout", () => {
		assert.throws(() => assertControl(validStderr, { status: 0 }), assert.AssertionError);
		assert.throws(() => assertControl(validStderr, { stdout: "unexpected\n" }), assert.AssertionError);
	});
});
