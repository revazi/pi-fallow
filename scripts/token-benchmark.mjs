import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getEncoding } from "js-tiktoken";
import { createJiti } from "jiti";
import { createFallowBenchmarkProject, runFixtureEngine, writeJsonArtifact } from "./benchmark-utils.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const CORPUS_PATH = join(ROOT, "benchmarks", "corpus.json");
const FULL_OUTPUT_PLACEHOLDER = "<FULL_OUTPUT_PATH>";
const PRIMARY_ENCODING = "o200k_base";
const ENCODING_NAMES = [PRIMARY_ENCODING, "cl100k_base"];
const encoders = new Map(ENCODING_NAMES.map((name) => [name, getEncoding(name)]));
const plainTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};
const jiti = createJiti(import.meta.url);

const { default: registerPiFallow } = await jiti.import("../extensions/fallow.ts");
const { fallowEngine } = await jiti.import("../extensions/fallow/engine.ts");
const { formatFallowProjectStateText } = await jiti.import("../extensions/fallow/project/text.ts");
const { formatFallowPrSummaryText } = await jiti.import("../extensions/fallow/pr-summary/text.ts");
const { buildFallowTranscriptContent } = await jiti.import("../extensions/fallow/command/transcript.ts");
const { FallowIssueNavigator } = await jiti.import("../extensions/fallow/ui/navigator.ts");

const cli = parseCli(process.argv.slice(2));
const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const tokenizerPackageJson = JSON.parse(await readFile(
	join(dirname(require.resolve("js-tiktoken")), "..", "package.json"),
	"utf8",
));
const corpusText = await readFile(CORPUS_PATH, "utf8");
const corpus = JSON.parse(corpusText);
const corpusHash = await hashCorpus(corpus, corpusText);
const contractText = captureToolContract(registerPiFallow);
const contractMeasurement = measureText("tool-contract", "active", contractText, []);
const projectDir = await createFallowBenchmarkProject("pi-fallow-token-project-");
const measurements = [contractMeasurement];

try {
	for (const scenario of corpus.scenarios) {
		measurements.push(...await measureScenario(scenario, projectDir, contractMeasurement));
	}
} finally {
	await rm(projectDir, { recursive: true, force: true });
}

const artifact = {
	benchmarkVersion: corpus.benchmarkVersion,
	label: cli.label,
	generatedAt: new Date().toISOString(),
	corpusHash,
	primaryEncoding: PRIMARY_ENCODING,
	tokenizers: ENCODING_NAMES.map((encoding) => ({
		encoding,
		implementation: "js-tiktoken",
		version: tokenizerPackageJson.version,
	})),
	environment: {
		piFallowVersion: packageJson.version,
		gitSha: readGitSha(),
		node: process.version,
		platform: process.platform,
		arch: process.arch,
	},
	measurements,
	aggregates: buildAggregates(measurements),
};

await writeJsonArtifact(artifact, cli.output);
printSummary(artifact, cli.output);

function parseCli(args) {
	const options = { label: "working-tree", output: undefined };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--label") options.label = requireValue(args, ++index, arg);
		else if (arg === "--output") options.output = requireValue(args, ++index, arg);
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

function requireValue(args, index, flag) {
	const value = args[index];
	if (!value) throw new Error(`${flag} requires a value.`);
	return value;
}

async function hashCorpus(corpusValue, manifestText) {
	const hash = createHash("sha256");
	hash.update("corpus.json\0");
	hash.update(manifestText);
	for (const scenario of [...corpusValue.scenarios].sort((left, right) => left.fixture.localeCompare(right.fixture))) {
		hash.update(`\0${scenario.fixture}\0`);
		hash.update(await readFile(join(ROOT, "benchmarks", scenario.fixture)));
	}
	return `sha256:${hash.digest("hex")}`;
}

function captureToolContract(registerExtension) {
	let tool;
	registerExtension({
		registerTool(definition) { tool = definition; },
		registerCommand() {},
		registerMessageRenderer() {},
		on() {},
	});
	if (!tool) throw new Error("Pi Fallow did not register fallow_run.");
	return JSON.stringify({
		name: tool.name,
		label: tool.label,
		description: tool.description,
		promptSnippet: tool.promptSnippet,
		promptGuidelines: tool.promptGuidelines,
		parameters: tool.parameters,
	}, null, 2);
}

async function measureScenario(scenario, cwd, contract) {
	const fixturePath = join(ROOT, "benchmarks", scenario.fixture);
	const fixtureText = await readFile(fixturePath, "utf8");
	const fixtureData = JSON.parse(fixtureText);
	const findings = collectBenchmarkFindings(fixtureData);
	const commandResult = await runFixtureEngine(fallowEngine, { scenario, fixtureText, cwd });

	const fullOutputPath = commandResult.formatted.fullOutputPath;
	const normalize = (text) => normalizeFullOutputPath(text, fullOutputPath);
	const rawReport = JSON.stringify(fixtureData, null, 2);
	const toolContent = normalize(commandResult.content);
	const resultPrefix = [
		formatFallowPrSummaryText(commandResult.prSummary),
		formatFallowProjectStateText(commandResult.projectState),
	].filter(Boolean).join("\n");
	const hasNavigator = !!commandResult.formatted.overview?.sections.some((section) => section.items.length > 0);
	const slashContent = normalize(buildFallowTranscriptContent(
		resultPrefix,
		commandResult.formatted.summary,
		commandResult.content,
		hasNavigator,
	));
	const output = [
		measureText("raw-report", scenario.id, rawReport, findings, { reportFindings: findings.length }),
		withContextExposure(measureText("tool-result", scenario.id, toolContent, findings, {
			reportFindings: findings.length,
			truncated: !!commandResult.formatted.truncated,
		}), contract),
		withContextExposure(measureText("slash-transcript", scenario.id, slashContent, findings, {
			reportFindings: findings.length,
			hasNavigator,
			truncated: !!commandResult.formatted.truncated,
		}), contract),
	];

	if (commandResult.formatted.overview) {
		output.push(...measurePrompts(
			scenario,
			commandResult.formatted.overview,
			commandResult.formatted.fullOutputPath ? FULL_OUTPUT_PLACEHOLDER : undefined,
			contract,
		));
	}

	if (fullOutputPath) await rm(dirname(fullOutputPath), { recursive: true, force: true });
	return output;
}

function normalizeFullOutputPath(text, fullOutputPath) {
	return fullOutputPath ? text.replaceAll(fullOutputPath, FULL_OUTPUT_PLACEHOLDER) : text;
}

function measurePrompts(scenario, overview, fullOutputPath, contract) {
	const entries = overview.sections.flatMap((section) => section.items);
	if (!entries.length) return [];
	const reportFindings = countEntryFindings(entries);
	return (scenario.promptSelections ?? [])
		.map((selection) => measurePromptSelection(scenario, overview, entries, selection, fullOutputPath, reportFindings, contract))
		.filter(Boolean);
}

function countEntryFindings(entries) {
	return collectUniqueFindings(entries.flatMap((entry) => collectBenchmarkFindings(entry.raw))).length;
}

function measurePromptSelection(scenario, overview, entries, selection, fullOutputPath, reportFindings, contract) {
	const selectionCount = resolveSelectionCount(selection, entries.length);
	if (selectionCount < 1) return undefined;
	const result = buildNavigatorPrompt(scenario, overview, selectionCount, fullOutputPath);
	if (!result || result.type !== "prompt") throw new Error(`Failed to build prompt for ${scenario.id}/${selection}.`);
	const selectedFindings = collectEntryFindings(entries.slice(0, selectionCount));
	return withContextExposure(measureText(
		"editor-prompt",
		`${scenario.id}:${selection}`,
		result.prompt,
		selectedFindings,
		{ reportFindings, selectedRows: selectionCount, availableRows: entries.length },
	), contract);
}

function resolveSelectionCount(selection, availableRows) {
	return selection === "all" ? availableRows : Math.min(selection, availableRows);
}

function buildNavigatorPrompt(scenario, overview, selectionCount, fullOutputPath) {
	let result;
	const navigator = new FallowIssueNavigator(
		overview,
		plainTheme,
		(value) => { result = value; },
		() => {},
		{
			command: `fallow ${scenario.args.join(" ")}`,
			fullOutputPath,
			truncated: !!fullOutputPath,
		},
	);
	selectNavigatorRows(navigator, selectionCount);
	navigator.handleInput("e");
	return result;
}

function selectNavigatorRows(navigator, selectionCount) {
	for (let index = 0; index < selectionCount; index++) {
		navigator.handleInput("s");
		if (index + 1 < selectionCount) navigator.handleInput("j");
	}
}

function collectEntryFindings(entries) {
	return collectUniqueFindings(entries.flatMap((entry) => collectBenchmarkFindings(entry.raw)));
}

function collectBenchmarkFindings(root) {
	const findings = [];
	const seen = new Set();
	const stack = [root];
	while (stack.length) collectFindingValue(stack.pop(), stack, seen, findings);
	return collectUniqueFindings(findings);
}

function collectFindingValue(value, stack, seen, findings) {
	if (!isTraversableValue(value)) return;
	if (seen.has(value)) return;
	seen.add(value);
	appendBenchmarkFinding(value, findings);
	pushFindingChildren(value, stack);
}

function isTraversableValue(value) {
	return value !== null && typeof value === "object";
}

function appendBenchmarkFinding(value, findings) {
	if (Array.isArray(value)) return;
	if (typeof value.benchmark_id === "string") findings.push(value);
}

function pushFindingChildren(value, stack) {
	if (Array.isArray(value)) stack.push(...value);
	else stack.push(...Object.values(value));
}

function collectUniqueFindings(findings) {
	return [...new Map(findings.map((finding) => [finding.benchmark_id, finding])).values()]
		.sort((left, right) => left.benchmark_id.localeCompare(right.benchmark_id));
}

function measureText(surface, scenario, text, findings, extra = {}) {
	const quality = measureFindingRetention(text, findings);
	return {
		key: `${surface}/${scenario}`,
		surface,
		scenario,
		characters: [...text].length,
		utf8Bytes: Buffer.byteLength(text),
		lines: text ? text.split(/\r?\n/).length : 0,
		tokens: Object.fromEntries([...encoders].map(([name, encoder]) => [name, encoder.encode(text).length])),
		quality,
		...extra,
	};
}

function measureFindingRetention(text, findings) {
	const included = findings.filter((finding) => text.includes(finding.benchmark_id));
	const requiredValues = included.flatMap(requiredFindingValues);
	const retainedFields = requiredValues.filter((value) => text.includes(String(value))).length;
	return {
		expectedFindings: findings.length,
		includedFindings: included.length,
		omittedFindings: findings.length - included.length,
		requiredFields: requiredValues.length,
		retainedFields,
		requiredFieldRetentionPct: retentionPercentage(retainedFields, requiredValues.length),
		hasFullOutputReference: text.includes(FULL_OUTPUT_PLACEHOLDER),
	};
}

function retentionPercentage(retainedFields, requiredFields) {
	return requiredFields ? round(retainedFields / requiredFields * 100) : null;
}

function requiredFindingValues(finding) {
	const action = finding.actions?.[0]?.description ?? finding.recommendation;
	return [finding.kind, finding.path, finding.line, finding.severity, finding.evidence, action]
		.filter((value) => value !== undefined && value !== null && value !== "");
}

function withContextExposure(measurement, contract) {
	measurement.context = {};
	for (const encoding of ENCODING_NAMES) {
		const fixed = contract.tokens[encoding];
		const content = measurement.tokens[encoding];
		measurement.context[encoding] = {
			nextTurnTax: fixed + content,
			fiveTurnExposure: fixed * 5 + content * 5,
		};
	}
	return measurement;
}

function buildAggregates(items) {
	const grouped = new Map();
	for (const item of items) {
		const group = grouped.get(item.surface) ?? [];
		group.push(item);
		grouped.set(item.surface, group);
	}
	return Object.fromEntries([...grouped].map(([surface, group]) => [surface, {
		cases: group.length,
		characters: aggregateNumbers(group.map((item) => item.characters)),
		utf8Bytes: aggregateNumbers(group.map((item) => item.utf8Bytes)),
		tokens: Object.fromEntries(ENCODING_NAMES.map((encoding) => [
			encoding,
			aggregateNumbers(group.map((item) => item.tokens[encoding])),
		])),
	}]));
}

function aggregateNumbers(values) {
	const sorted = [...values].sort((left, right) => left - right);
	return {
		total: sorted.reduce((sum, value) => sum + value, 0),
		median: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		max: sorted.at(-1) ?? 0,
	};
}

function percentile(sorted, percentileValue) {
	if (!sorted.length) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

function round(value) {
	return Math.round(value * 100) / 100;
}

function readGitSha() {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

function printSummary(artifactValue, outputPath) {
	const rows = Object.entries(artifactValue.aggregates).map(([surface, aggregate]) => ({
		surface,
		cases: aggregate.cases,
		total: aggregate.tokens[PRIMARY_ENCODING].total,
		median: aggregate.tokens[PRIMARY_ENCODING].median,
		p95: aggregate.tokens[PRIMARY_ENCODING].p95,
		max: aggregate.tokens[PRIMARY_ENCODING].max,
	}));
	console.log(`Pi Fallow token benchmark: ${artifactValue.label}`);
	console.log(`Corpus: ${artifactValue.corpusHash}`);
	console.log(`Primary encoding: ${PRIMARY_ENCODING}`);
	console.table(rows);
	if (outputPath) console.log(`Wrote ${resolve(outputPath)}`);
}
