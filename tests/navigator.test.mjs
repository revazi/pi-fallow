import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { FallowIssueNavigator } = await jiti.import("../extensions/fallow/ui/navigator.ts");

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
		assert.match(result.prompt, /## 1\. Unused exports: unused helper/);
		assert.match(result.prompt, /Location: src\/a\.ts:7/);
		assert.match(result.prompt, /Details: export helper/);
		assert.match(result.prompt, /Suggested action: Remove the export or add a real use\./);
		assert.match(result.prompt, /"type": "unused_export"/);
		assert.match(result.prompt, /## 2\. Unused exports: dead file/);
		assert.match(result.prompt, /Location: src\/dead\.ts/);
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
		assert.match(result.prompt, /## 1\. Unused exports: dead file/);
	});

	it("navigates to findings beyond the first visible page", () => {
		let result = null;
		const overview = createOverview();
		overview.sections[0].items = Array.from({ length: 35 }, (_, index) => ({
			label: `finding ${index + 1}`,
			path: `src/file-${index + 1}.ts`,
			line: index + 1,
			action: `Review finding ${index + 1}.`,
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
		}));
		overview.sections[0].count = 35;
		const navigator = new FallowIssueNavigator(overview, theme, (value) => {
			result = value;
		}, () => {});

		navigator.handleInput("A");
		navigator.handleInput("e");

		assert.equal(result?.issueCount, 35);
		assert.match(result.prompt, /## 35\. Unused exports: finding 35/);
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
