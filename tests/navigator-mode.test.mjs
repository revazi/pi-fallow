import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	FALLOW_NAVIGATOR_OVERLAY_OPTIONS,
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
		assert.equal(resolveFallowNavigatorVisibleRows(Number.NaN, false), 30);
		assert.equal(resolveFallowNavigatorVisibleRows(24, false), 5);
		assert.equal(resolveFallowNavigatorVisibleRows(24, true), 13);
		assert.equal(resolveFallowNavigatorVisibleRows(50, false), 30);
		assert.equal(resolveFallowNavigatorVisibleRows(50, true), 30);
	});

	it("keeps the overlay centered and uses nearly the full terminal", () => {
		assert.deepEqual(FALLOW_NAVIGATOR_OVERLAY_OPTIONS, {
			width: "90%",
			minWidth: 50,
			maxHeight: "95%",
			anchor: "center",
		});
	});
});
