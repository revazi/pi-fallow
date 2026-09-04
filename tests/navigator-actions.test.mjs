import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildFallowNavigatorActions } = await jiti.import("../extensions/fallow/navigator-actions.ts");

function finding(overrides = {}) {
	return {
		role: "finding",
		section: "Findings",
		type: "future-finding",
		path: "src/example.ts",
		line: 7,
		subject: "example",
		source: { reportIndex: 0, sectionIndex: 0, itemIndex: 0, sectionTitle: "Findings" },
		...overrides,
	};
}

function byId(entry) {
	return new Map(buildFallowNavigatorActions(entry).map((action) => [action.id, action]));
}

describe("Fallow navigator actions", () => {
	it("derives inspect, trace, impact, explanation, and guard actions for exports", () => {
		const actions = byId(finding({
			type: "unused-export",
			subject: "renderWidget",
			raw: { kind: "unused-export", export_name: "renderWidget", path: "src/widget.ts" },
		}));

		assert.deepEqual([...actions.keys()], [
			"inspect-file", "inspect-symbol", "trace-export", "symbol-impact", "explain", "architecture",
		]);
		assert.deepEqual(actions.get("inspect-symbol").commandArgs, ["inspect", "--symbol", "src/example.ts:renderWidget"]);
		assert.deepEqual(actions.get("trace-export").commandArgs, ["dead-code", "--trace", "src/example.ts:renderWidget"]);
		assert.deepEqual(actions.get("symbol-impact").commandArgs, [
			"dead-code", "--type-aware", "--symbol-impact", "src/example.ts:renderWidget",
		]);
	});

	it("offers the specialized file, dependency, and clone traces", () => {
		const fileActions = byId(finding({ type: "unused-file", path: "src/dead.ts", subject: "unused-file" }));
		assert.deepEqual(fileActions.get("trace-file").commandArgs, ["dead-code", "--trace-file", "src/dead.ts"]);

		const dependencyActions = byId(finding({
			type: "unused-dependency",
			path: undefined,
			subject: "@scope/package",
			raw: { kind: "unused-dependency", package_name: "@scope/package" },
		}));
		assert.deepEqual(dependencyActions.get("trace-dependency").commandArgs, [
			"dead-code", "--trace-dependency", "@scope/package",
		]);

		const cloneActions = byId(finding({
			section: "Clone groups",
			type: "Clone groups",
			path: "src/clone.ts",
			line: 42,
			raw: { instances: [{ file: "src/clone.ts", start_line: 42 }] },
		}));
		assert.deepEqual(cloneActions.get("trace-clone").commandArgs, ["dupes", "--trace", "src/clone.ts:42"]);
	});

	it("keeps security and unknown future findings conservative", () => {
		const security = byId(finding({
			type: "security",
			path: "src/run.ts",
			raw: { kind: "security", rule_id: "security/sink", actions: [{ auto_fixable: false }] },
		}));
		assert.deepEqual([...security.keys()], ["inspect-file", "architecture"]);

		const future = byId(finding({ type: "future-rule", raw: undefined }));
		assert.deepEqual([...future.keys()], ["inspect-file", "explain", "architecture"]);
		assert.equal([...future.values()].some((action) => action.commandArgs.includes("--yes")), false);
	});

	it("offers only a project-wide dry-run for explicitly previewable fixes", () => {
		const previewable = byId(finding({
			type: "unused-export",
			subject: "helper",
			raw: { kind: "unused-export", export_name: "helper", actions: [{ type: "remove-export", auto_fixable: true }] },
		}));
		assert.deepEqual(previewable.get("fix-preview"), {
			id: "fix-preview",
			label: "Preview safe fixes",
			description: "Run Fallow's project-wide dry-run only; no fix is applied and config creation is disabled.",
			commandArgs: ["fix", "--dry-run", "--no-create-config"],
			kind: "preview",
		});
		assert.equal([...previewable.values()].some((action) => action.commandArgs.includes("--yes")), false);

		const unverified = byId(finding({ raw: { actions: [{ type: "remove-export", auto_fixable: false }] } }));
		assert.equal(unverified.has("fix-preview"), false);
	});

	it("rejects unsafe report-derived targets and informational entries", () => {
		assert.deepEqual(buildFallowNavigatorActions(finding({
			path: "../../outside.ts",
			type: "unused-export",
			subject: "--help",
			raw: { export_name: "--help", actions: [{ auto_fixable: false }] },
		})).map((action) => action.id), ["explain"]);
		assert.deepEqual(buildFallowNavigatorActions(finding({ role: "context" })), []);
	});
});
