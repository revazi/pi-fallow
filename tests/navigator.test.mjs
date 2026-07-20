import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { FallowIssueNavigator } = await jiti.import("../extensions/fallow/ui/navigator.ts");
const { buildFallowOverview } = await jiti.import("../extensions/fallow/overview.ts");

const theme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

function createOverview() {
	return {
		title: "Fallow dead-code",
		status: "warning",
		stats: [{ label: "issues", value: 2 }],
		notes: [],
		sections: [{
			title: "Unused exports",
			count: 2,
			items: [
				{
					label: "unused helper",
					path: "src/a.ts",
					line: 7,
					meta: "export helper",
					action: "Remove the export or add a real use.",
					raw: { type: "unused_export", exportName: "helper" },
				},
				{
					label: "dead file",
					path: "src/dead.ts",
					action: "Delete src/dead.ts if it is intentionally unused.",
					raw: { type: "unused_file", path: "src/dead.ts" },
				},
			],
		}],
	};
}

function createFilterOverview() {
	return {
		title: "Fallow audit",
		status: "warning",
		stats: [{ label: "issues", value: 3 }],
		notes: [],
		sections: [
			{
				title: "Complexity",
				count: 1,
				items: [{ label: "complex function", path: "src/complex.ts", line: 4, severity: "high", action: "Refactor it." }],
			},
			{
				title: "Dead code",
				count: 2,
				items: [
					{ label: "dead helper", path: "src/dead.ts", line: 8, severity: "medium", action: "Remove it." },
					{ label: "unused export", path: "src/api.ts", line: 12, severity: "low", action: "Use or remove it." },
				],
			},
		],
	};
}

function createContextOverview(includeFinding = true) {
	return {
		title: "Fallow health",
		status: includeFinding ? "warning" : "success",
		stats: [{ label: "score", value: "85 A" }],
		notes: [],
		sections: [
			...(includeFinding ? [{ title: "Complexity findings", count: 1, role: "finding", items: [{ label: "complex function", path: "src/complex.ts", severity: "high" }] }] : []),
			{ title: "Worst file scores", count: 2, role: "context", items: [
				{ label: "score 95", path: "src/healthy.ts" },
				{ label: "score 55", path: "src/risky.ts" },
			] },
		],
	};
}

function loadEndFindingPrompt(overview, fullOutputPath, includeFullDetails) {
	return new Promise((resolve) => {
		const navigator = new FallowIssueNavigator(overview, theme, resolve, () => {}, { fullOutputPath });
		navigator.handleInput("\u001b[F");
		if (includeFullDetails) navigator.handleInput("d");
		navigator.handleInput("e");
	});
}

describe("FallowIssueNavigator prompt generation", () => {
	it("builds an editable prompt for selected findings", () => {
		let result = null;
		let renderRequests = 0;
		const navigator = new FallowIssueNavigator(
			createOverview(),
			theme,
			(value) => {
				result = value;
			},
			() => {
				renderRequests += 1;
			},
			{ command: "dead-code --format json --quiet" },
		);

		navigator.handleInput("s");
		navigator.handleInput("j");
		navigator.handleInput("s");
		navigator.handleInput("e");

		assert.equal(renderRequests, 3);
		assert.equal(result?.type, "prompt");
		assert.equal(result?.issueCount, 2);
		assert.match(result.prompt, /Please work on the following selected Fallow findings\./);
		assert.match(result.prompt, /Additional instructions from user:/);
		assert.match(result.prompt, /Fallow command: dead-code --format json --quiet/);
		assert.equal(result?.detail, "compact");
		assert.match(result.prompt, /1 \| unused_export \| unknown \| src\/a\.ts:7 \| unused helper/);
		assert.match(result.prompt, /export helper/);
		assert.match(result.prompt, /Remove the export or add a real use\./);
		assert.match(result.prompt, /2 \| unused_file \| unknown \| src\/dead\.ts \| dead file/);
		assert.doesNotMatch(result.prompt, /Full raw finding JSON/);
	});

	it("builds a prompt for the current finding when none are marked", () => {
		let result = null;
		const navigator = new FallowIssueNavigator(createOverview(), theme, (value) => {
			result = value;
		}, () => {});

		navigator.handleInput("j");
		navigator.handleInput("a");

		assert.equal(result?.type, "prompt");
		assert.equal(result?.issueCount, 1);
		assert.doesNotMatch(result.prompt, /unused helper/);
		assert.match(result.prompt, /1 \| unused_file \| unknown \| src\/dead\.ts \| dead file/);
	});

	it("navigates to findings beyond the first visible page", () => {
		let result = null;
		const overview = createOverview();
		overview.sections[0].items = Array.from({ length: 35 }, (_, index) => ({
			label: `finding ${index + 1}`,
			path: `src/file-${index + 1}.ts`,
			line: index + 1,
			action: `Review finding ${index + 1}.`,
			raw: { kind: "test-finding", path: `src/file-${index + 1}.ts`, line: index + 1 },
		}));
		overview.sections[0].count = 35;
		const navigator = new FallowIssueNavigator(overview, theme, (value) => {
			result = value;
		}, () => {}, { fullOutputPath: "/tmp/pi-fallow-report.json" });

		navigator.handleInput("\u001b[F");
		navigator.handleInput("e");

		assert.equal(result?.issueCount, 1);
		assert.match(result.prompt, /finding 35/);
		assert.match(result.prompt, /src\/file-35\.ts:35/);
		assert.match(result.prompt, /Complete Fallow report: \/tmp\/pi-fallow-report\.json/);
	});

	it("selects every finding beyond the rendered page", () => {
		let result = null;
		const overview = createOverview();
		overview.sections[0].items = Array.from({ length: 35 }, (_, index) => ({
			label: `finding ${index + 1}`,
			path: `src/file-${index + 1}.ts`,
			line: index + 1,
			action: `Review finding ${index + 1}.`,
			raw: { kind: "test-finding", path: `src/file-${index + 1}.ts`, line: index + 1 },
		}));
		overview.sections[0].count = 35;
		const navigator = new FallowIssueNavigator(overview, theme, (value) => {
			result = value;
		}, () => {});

		navigator.handleInput("A");
		navigator.handleInput("e");

		assert.equal(result?.issueCount, 35);
		assert.match(result.prompt, /35 \| test-finding \| unknown \| src\/file-35\.ts:35 \| finding 35/);
	});

	it("searches without discarding hidden findings", () => {
		let result = null;
		const navigator = new FallowIssueNavigator(createFilterOverview(), theme, (value) => {
			result = value;
		}, () => {});

		navigator.handleInput("/");
		for (const character of "dead helper") navigator.handleInput(character);
		navigator.handleInput("\r");
		const filtered = navigator.render(90).join("\n");
		assert.match(filtered, /1\/3 findings/);
		assert.match(filtered, /dead helper/);
		assert.doesNotMatch(filtered, /complex function/);

		navigator.handleInput("A");
		navigator.handleInput("x");
		navigator.handleInput("e");
		assert.equal(result?.issueCount, 1);
		assert.match(result.prompt, /dead helper/);
	});

	it("filters by section and severity and selects all visible findings", () => {
		let result = null;
		const navigator = new FallowIssueNavigator(createFilterOverview(), theme, (value) => {
			result = value;
		}, () => {});

		navigator.handleInput("f");
		assert.match(navigator.render(90).join("\n"), /1\/3 findings/);
		navigator.handleInput("A");
		navigator.handleInput("f");
		assert.match(navigator.render(90).join("\n"), /2\/3 findings/);
		navigator.handleInput("A");
		navigator.handleInput("f");
		navigator.handleInput("v");
		const severityFiltered = navigator.render(90).join("\n");
		assert.match(severityFiltered, /1\/3 findings/);
		assert.match(severityFiltered, /severity: high/);
		navigator.handleInput("x");
		navigator.handleInput("e");

		assert.equal(result?.issueCount, 3);
		assert.match(result.prompt, /complex function/);
		assert.match(result.prompt, /dead helper/);
		assert.match(result.prompt, /unused export/);
	});

	it("edits and cancels search without closing the navigator", () => {
		let doneCalls = 0;
		const navigator = new FallowIssueNavigator(createFilterOverview(), theme, () => {
			doneCalls += 1;
		}, () => {});

		navigator.handleInput("/");
		for (const character of "missing") navigator.handleInput(character);
		assert.match(navigator.render(80).join("\n"), /No findings match/);
		navigator.handleInput("\u0015");
		assert.match(navigator.render(80).join("\n"), /3 findings/);
		navigator.handleInput("d");
		navigator.handleInput("\u007f");
		navigator.handleInput("\u001b");

		assert.equal(doneCalls, 0);
		assert.match(navigator.render(80).join("\n"), /3 findings/);
	});

	it("hides informational files by default and never counts them as findings", () => {
		const navigator = new FallowIssueNavigator(createContextOverview(), theme, () => {}, () => {});

		const defaultView = navigator.render(100).join("\n");
		assert.match(defaultView, /1 finding/);
		assert.match(defaultView, /2 informational hidden/);
		assert.match(defaultView, /Show informational files \(2\)/);
		assert.match(defaultView, /File scores and hotspots are context, not findings/);
		assert.doesNotMatch(defaultView, /src\/healthy\.ts/);

		navigator.handleInput("i");
		const informationVisible = navigator.render(100).join("\n");
		assert.match(informationVisible, /2 informational/);
		assert.match(informationVisible, /src\/healthy\.ts/);
		assert.match(informationVisible, /not counted as findings/);
	});

	it("renders explicit informational commands without finding controls", () => {
		let result = null;
		const navigator = new FallowIssueNavigator(createContextOverview(false), theme, (value) => {
			result = value;
		}, () => {}, { informationalMode: true, visibleRows: 20 });

		const rendered = navigator.render(100).join("\n");
		assert.match(rendered, /2 informational/);
		assert.match(rendered, /src\/healthy\.ts/);
		assert.match(rendered, /Informational command output/);
		assert.doesNotMatch(rendered, /0 findings/);
		assert.doesNotMatch(rendered, /Include full finding JSON/);
		navigator.handleInput("e");
		assert.equal(result, null);
	});

	it("defaults the full-details checkbox to deselected and explains both modes", () => {
		let result = null;
		const navigator = new FallowIssueNavigator(createOverview(), theme, (value) => {
			result = value;
		}, () => {});

		const compactOverlay = navigator.render(100).join("\n");
		assert.match(compactOverlay, /☐/);
		assert.match(compactOverlay, /Compact: sends 1 finding/);
		navigator.handleInput("d");
		const fullOverlay = navigator.render(100).join("\n");
		assert.match(fullOverlay, /☑/);
		assert.match(fullOverlay, /Full: embeds raw JSON for 1 finding/);
		navigator.handleInput("e");

		assert.equal(result?.detail, "full");
		assert.match(result.prompt, /Full raw finding JSON/);
	});

	it("hydrates compact and full prompts from the complete report", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-fallow-prompt-"));
		const fullOutputPath = join(directory, "fallow-output.json");
		const report = {
			kind: "dead-code",
			total_issues: 12,
			unused_exports: Array.from({ length: 12 }, (_, index) => ({
				benchmark_id: `finding-${index + 1}`,
				kind: "unused-export",
				export_name: `unused_${index + 1}`,
				path: `src/file-${index + 1}.ts`,
				line: index + 1,
				severity: "high",
				evidence: `No callers for finding ${index + 1}.`,
				actions: [{ description: `Review finding ${index + 1}.` }],
			})),
		};
		await writeFile(fullOutputPath, JSON.stringify(report, null, 2));

		try {
			const overview = buildFallowOverview(report);
			assert.equal(overview.sections[0].items[11].raw, undefined);
			const compactResult = await loadEndFindingPrompt(overview, fullOutputPath, false);
			assert.equal(compactResult.detail, "compact");
			assert.match(compactResult.prompt, /finding-12/);
			assert.match(compactResult.prompt, /No callers for finding 12\./);

			const fullResult = await loadEndFindingPrompt(overview, fullOutputPath, true);
			assert.equal(fullResult.detail, "full");
			assert.match(fullResult.prompt, /"benchmark_id": "finding-12"/);
			assert.match(fullResult.prompt, /"evidence": "No callers for finding 12\."/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("uses the responsive finding-row count supplied by the overlay", () => {
		const overview = createOverview();
		overview.sections[0].items = Array.from({ length: 12 }, (_, index) => ({ label: `finding ${index + 1}` }));
		overview.sections[0].count = 12;
		const navigator = new FallowIssueNavigator(overview, theme, () => {}, () => {}, { visibleRows: 3 });

		const rendered = navigator.render(80).join("\n");
		assert.match(rendered, /finding 3/);
		assert.doesNotMatch(rendered, /finding 4/);
		assert.match(rendered, /9 later items/);
		assert.match(rendered, /Include full finding JSON/);
	});

	it("chooses a fluid overlay width capped by the available maximum", () => {
		const navigator = new FallowIssueNavigator(createOverview(), theme, () => {}, () => {});

		assert.equal(navigator.preferredWidth(60), 60);
		assert.ok(navigator.preferredWidth(200) < 200);
	});

	it("renders within the width provided by the overlay", () => {
		const navigator = new FallowIssueNavigator(createOverview(), theme, () => {}, () => {});
		const width = 60;

		for (const line of navigator.render(width)) {
			assert.ok(visibleWidth(line) <= width, line);
		}
	});
});
