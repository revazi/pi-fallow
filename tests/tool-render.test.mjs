import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	renderFallowMessageRenderer,
	renderFallowToolCall,
	renderFallowToolResult,
} = await jiti.import("../extensions/fallow/tool-render.ts");

const theme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};
const overview = {
	title: "Fallow error",
	status: "error",
	stats: [],
	sections: [],
	notes: ["missing required issue type"],
};
const details = {
	command: "fallow",
	args: ["explain", "--format", "json", "--quiet"],
	cwd: process.cwd(),
	exitCode: 2,
	elapsedMs: 1,
	parsed: true,
	summary: "error: missing required issue type",
	overview,
	projectState: { configPath: ".fallowrc.json", configSource: "file", cacheEnabled: true, cacheFiles: [] },
};

describe("Fallow compact rendering", () => {
	it("renders call defaults, root and change reference precedence", () => {
		assert.equal(renderFallowToolCall({}, theme).render(100).join("\n").trimEnd(), "fallow run");
		assert.equal(renderFallowToolCall({ command: "health", root: "src", base: "main", changedSince: "HEAD" }, theme).render(100).join("\n").trimEnd(), "fallow health in src since HEAD");
		assert.equal(renderFallowToolCall({ base: "main" }, theme).render(100).join("\n").trimEnd(), "fallow run since main");
	});

	it("renders partial, absent and expanded details", () => {
		assert.match(renderFallowToolResult({}, { isPartial: true }, theme).render(100).join("\n"), /Running Fallow/);
		assert.match(renderFallowToolResult({}, {}, theme).render(100).join("\n"), /No Fallow details/);
		const compact = { ...details, overview: undefined, truncated: true, fullOutputPath: "/tmp/report", args: ["file with spaces"] };
		const text = renderFallowToolResult({ details: compact }, { expanded: true }, theme).render(100).join("\n");
		assert.match(text, /Fallow error \(exit 2\) \(truncated\)/);
		assert.match(text, /"file with spaces"/);
		assert.match(text, /Full output: \/tmp\/report/);
		assert.doesNotMatch(renderFallowToolResult({ details: compact }, {}, theme).render(100).join("\n"), /Full output/);
	});

	it("renders compact navigator messages and falls back to raw content", () => {
		const summary = renderFallowMessageRenderer({ details: { compact: true, overview: { ...overview, stats: [{ label: "Files", value: 2 }] } } }, {}, theme).render(100).join("\n");
		assert.match(summary, /Files: 2/);
		assert.match(summary, /navigator window/);
		assert.match(renderFallowMessageRenderer({ content: "raw report" }, {}, theme).render(100).join("\n"), /Fallow result\s+raw report/);
	});
});

describe("Fallow execution-error rendering", () => {
	it("hides unrelated project configuration from tool errors", () => {
		const rendered = renderFallowToolResult({ details }, { expanded: true }, theme).render(100).join("\n");

		assert.match(rendered, /Fallow error/);
		assert.match(rendered, /missing required issue type/);
		assert.doesNotMatch(rendered, /Config:/);
		assert.doesNotMatch(rendered, /No issues found/);
	});

	it("hides unrelated project configuration from slash-command errors", () => {
		const rendered = renderFallowMessageRenderer({ details, content: "error" }, { expanded: true }, theme).render(100).join("\n");

		assert.match(rendered, /Fallow error/);
		assert.match(rendered, /missing required issue type/);
		assert.doesNotMatch(rendered, /Config:/);
	});
});
