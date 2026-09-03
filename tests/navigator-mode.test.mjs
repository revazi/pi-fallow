import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	FALLOW_NAVIGATOR_OVERLAY_OPTIONS,
	resolveFallowNavigatorMode,
	resolveFallowNavigatorVisibleRows,
} = await jiti.import("../extensions/fallow/command/navigator.ts");
const { hasFallowNavigator } = await jiti.import("../extensions/fallow/command/mode.ts");
const { buildFallowOverview } = await jiti.import("../extensions/fallow/overview.ts");

describe("navigator command mode", () => {
	it("does not open a finding navigator for type-aware status", () => {
		const status = buildFallowOverview({
			kind: "type-aware-status",
			available: true,
			package_version: "3.14.0",
			protocol_version: 6,
		});

		assert.equal(resolveFallowNavigatorMode(status), "none");
		assert.equal(hasFallowNavigator("tui", status), false);
	});

	it("opens advisory similar-code candidates but not readiness status", () => {
		const readiness = buildFallowOverview({ kind: "similar-code-status", model_ready: false });
		assert.equal(resolveFallowNavigatorMode(readiness), "none");
		assert.equal(hasFallowNavigator("tui", readiness), false);

		const candidates = buildFallowOverview({
			kind: "similar-code",
			generation: {},
			candidates: [{
				candidate_id: "sc_example",
				left: { path: "src/a.ts", name: "a", start_line: 1 },
				right: { path: "src/b.ts", name: "b", start_line: 2 },
				verification_status: "unverified",
			}],
			completion: { status: "complete", cache: {} },
			diagnostics: [],
		});
		assert.equal(resolveFallowNavigatorMode(candidates), "actionable");
		assert.equal(hasFallowNavigator("tui", candidates), true);
	});

	it("uses informational mode when a semantic result contains only context", () => {
		const couplingOnly = buildFallowOverview({
			kind: "health",
			findings: [],
			_meta: { type_aware: { type_coupling: { status: "complete", files: [{ path: "src/api.ts" }] } } },
		});

		assert.equal(resolveFallowNavigatorMode(couplingOnly), "informational");
		assert.equal(hasFallowNavigator("tui", couplingOnly), true);
	});

	it("keeps mixed health findings actionable alongside type-coupling context", () => {
		const mixedHealth = buildFallowOverview({
			kind: "health",
			findings: [{ path: "src/complex.ts", name: "complex", severity: "high" }],
			_meta: { type_aware: { type_coupling: { status: "complete", files: [{ path: "src/api.ts" }] } } },
		});

		assert.deepEqual(mixedHealth.sections.map((section) => section.role), ["finding", "context"]);
		assert.equal(resolveFallowNavigatorMode(mixedHealth), "actionable");
		assert.equal(hasFallowNavigator("tui", mixedHealth), true);
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
