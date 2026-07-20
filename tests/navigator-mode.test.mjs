import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	isInformationalNavigatorCommand,
	resolveFallowNavigatorVisibleRows,
} = await jiti.import("../extensions/fallow/command/navigator.ts");

describe("navigator command mode", () => {
	it("distinguishes informational-only health and flags commands", () => {
		assert.equal(isInformationalNavigatorCommand(["flags", "--format", "json"]), true);
		assert.equal(isInformationalNavigatorCommand(["health", "--file-scores", "--score"]), true);
		assert.equal(isInformationalNavigatorCommand(["health", "--hotspots", "--ownership"]), true);
		assert.equal(isInformationalNavigatorCommand(["health"]), false);
		assert.equal(isInformationalNavigatorCommand(["health", "--file-scores", "--targets"]), false);
		assert.equal(isInformationalNavigatorCommand(["dead-code"]), false);
	});

	it("uses more terminal height for large result sets", () => {
		assert.equal(resolveFallowNavigatorVisibleRows(Number.NaN, false), 20);
		assert.equal(resolveFallowNavigatorVisibleRows(24, false), 4);
		assert.equal(resolveFallowNavigatorVisibleRows(24, true), 12);
		assert.equal(resolveFallowNavigatorVisibleRows(50, false), 20);
		assert.equal(resolveFallowNavigatorVisibleRows(50, true), 20);
	});
});
